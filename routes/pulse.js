"use strict";
// OMNIPAY — VÉRIFICATION AUTOMATIQUE : les dépôts et retraits fonctionnent-ils vraiment ? (lecture seule, clé x-admin-key)
//   GET /api/pulse   verdict par canal (dépôts / retraits par opérateur), opérations bloquées, dernières réussites, réserve vs soldes clients.
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
router.use((req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." })));
const safe = async (fn, fb) => { try { return await fn(); } catch (e) { return fb; } };

// Diagnostic d'encaissement : rejoue les 3 étapes FedaPay (création, jeton, envoi sur le téléphone) et dit LAQUELLE est refusée et pourquoi.
// Crée une transaction FedaPay de 100 F (non liée à un solde) ; aucune clé ni donnée secrète n'est renvoyée.
router.post("/diag-collect", express.json(), async (req, res) => {
  const fp = require("../providers/fedapay.js");
  const steps = []; const out = (ok, extra) => res.json({ ok, env: fp.env(), steps, ...extra });
  try {
    if (!fp.ready()) return out(false, { hint: "FedaPay n'est pas configuré (clé manquante sur Render)." });
    const op = ["mtn", "moov", "celtiis"].includes(String(req.body && req.body.operator).toLowerCase()) ? String(req.body.operator).toLowerCase() : "mtn";
    let d = String((req.body && req.body.phone) || "").replace(/\D/g, ""); if (d.startsWith("00")) d = d.slice(2); const num = d.startsWith("229") ? d.slice(3) : d.replace(/^0+(?=\d{8})/, "");
    if (num.length < 8) return out(false, { hint: "Numéro invalide." });
    const amount = Math.min(500, Math.max(100, Math.floor(Number(req.body && req.body.amount)) || 100));
    const brief = (r) => { const dd = r.data || {}; return String(dd.message || (dd.errors && JSON.stringify(dd.errors)) || dd.error || "").slice(0, 200); };
    const c = await fp.call("POST", "/transactions", { description: "Test OMNIPAY", amount, currency: { iso: "XOF" }, merchant_reference: "diag-" + Date.now(),
      customer: { firstname: "Test", lastname: "OMNIPAY", phone_number: { number: num, country: "bj" } } });
    steps.push({ step: "1. Création de la transaction", http: c.status, message: brief(c) });
    if (c.status >= 400) return out(false, { hint: c.status === 401 ? "Clé refusée par FedaPay (mauvaise clé ou mauvais mode live/test)." : c.status === 403 ? "FedaPay refuse ce compte ou cette adresse IP." : "FedaPay refuse la création (voir message)." });
    const dd = c.data || {}; const t = dd["v1/transaction"] || dd.transaction || (Array.isArray(dd["v1/transactions"]) ? dd["v1/transactions"][0] : null) || dd; const id = t && t.id != null ? String(t.id) : null;
    if (!id) return out(false, { hint: "Réponse FedaPay sans identifiant de transaction." });
    const k = await fp.call("POST", "/transactions/" + encodeURIComponent(id) + "/token");
    const token = k.data && (k.data.token || ((k.data["v1/token"] || {}).token));
    steps.push({ step: "2. Jeton de paiement", http: k.status, message: token ? "ok" : brief(k) });
    if (k.status >= 400 || !token) return out(false, { hint: "FedaPay a créé la transaction mais refuse le jeton." });
    const sn = await fp.sendNow(op, token, num), s2 = sn.res;
    steps.push({ step: "3. Envoi sur le téléphone", http: s2.status, message: "modes essayés : " + sn.tried.map((x) => x.mode + " → " + x.http).join(" ; ") + (brief(s2) ? " · " + brief(s2) : "") });
    if (s2.status >= 400) return out(false, { hint: s2.status === 404 ? "Aucun mode d'encaissement connu n'est accepté par FedaPay pour cet opérateur : donnez-moi la liste ci-dessus, ou lisez le bon mode dans la doc FedaPay et réglez FEDAPAY_COLLECT_MODE_" + op.toUpperCase() + " sur Render." : s2.status === 403 || s2.status === 401 ? "L'encaissement direct par API n'est pas autorisé sur ce compte : demandez son activation à FedaPay." : "FedaPay refuse l'envoi : vérifiez le numéro et l'opérateur choisi." });
    out(true, { hint: "Demande envoyée : validez sur le téléphone avec votre code secret (100 F)." });
  } catch (e) { steps.push({ step: "Erreur technique", http: 0, message: String(e.message).slice(0, 120) }); out(false, { hint: "FedaPay injoignable depuis le serveur." }); }
});

router.get("/", async (req, res) => {
  try {
    const q = sql();
    const rows = await safe(() => q`SELECT type, coalesce(provider,'') AS provider, status, count(*)::int AS n, coalesce(sum(amount),0)::float AS total,
        count(*) FILTER (WHERE created_at < now() - interval '30 minutes')::int AS old30,
        count(*) FILTER (WHERE created_at < now() - interval '24 hours')::int AS old24h,
        max(created_at) AS last_at
      FROM transactions WHERE type IN ('deposit','withdrawal') AND created_at > now() - interval '30 days' GROUP BY 1,2,3`, []);
    const ch = {};
    const get = (k) => (ch[k] = ch[k] || { channel: k, ok: 0, fail: 0, stuck: 0, lastOkAt: null, total: 0 });
    for (const r of rows) {
      const k = r.type === "deposit" ? `Dépôt · ${r.provider || "?"}` : `Retrait · ${r.provider || "?"}`;
      const c = get(k);
      if (r.status === "completed") { c.ok += r.n; c.total += r.total; if (!c.lastOkAt || r.last_at > c.lastOkAt) c.lastOkAt = r.last_at; }
      else if (["failed", "rejected"].includes(r.status)) c.fail += r.n;
      else if (["pending", "processing"].includes(r.status)) c.stuck += r.type === "deposit" ? r.old30 : (r.status === "processing" ? r.old30 : r.old24h);
    }
    const channels = Object.values(ch).map((c) => {
      const tot = c.ok + c.fail;
      const level = c.stuck > 0 ? "bad" : c.ok === 0 ? "warn" : tot >= 5 && c.fail / tot > 0.3 ? "warn" : "ok";
      const note = c.stuck > 0 ? `${c.stuck} opération(s) bloquée(s) : à vérifier` : c.ok === 0 ? "Aucune réussite en 30 jours : faites un test à 500 F" : tot >= 5 && c.fail / tot > 0.3 ? "Trop d'échecs récents" : "Fonctionne";
      return { ...c, level, note };
    }).sort((a, b) => a.channel.localeCompare(b.channel));
    const money = await safe(async () => (await q`SELECT count(*)::int AS clients, coalesce(sum(balance),0)::float AS soldes FROM wallets`)[0], { clients: 0, soldes: 0 });
    const fp = require("../providers/fedapay");
    const auto = await safe(async () => {
      const a = (await q`SELECT count(*) FILTER (WHERE status = 'pending')::int AS waiting,
          count(*) FILTER (WHERE status = 'pending' AND metadata->>'autoParked' = 'true')::int AS parked,
          count(*) FILTER (WHERE status = 'pending' AND metadata->'payout'->>'result' IN ('unavailable','refused') AND coalesce(metadata->>'autoParked','') <> 'true')::int AS retrying,
          coalesce(sum(amount) FILTER (WHERE metadata->'payout'->>'result' = 'sent' AND created_at > now() - interval '24 hours'), 0)::float AS sent24h
        FROM transactions WHERE type = 'withdrawal' AND created_at > now() - interval '3 days'`)[0];
      return { on: process.env.AUTO_PAYOUT === "on", approvalXof: Number(process.env.APPROVAL_XOF) || 200000, dayCapXof: Number(process.env.AUTO_PAYOUT_DAY_MAX_XOF) || 1000000, retryMax: Number(process.env.AUTO_RETRY_MAX) || 3, ...a };
    }, null);
    const refusals = await safe(() => q`SELECT created_at AS at, type, coalesce(provider,'') AS provider, amount::float AS amount,
        left(coalesce(metadata->>'fedapayReason', metadata->'payout'->>'detail', metadata->'payout'->>'result', ''), 160) AS reason
      FROM transactions WHERE created_at > now() - interval '3 days'
        AND ((type = 'deposit' AND provider = 'fedapay' AND status = 'failed') OR (type = 'withdrawal' AND metadata->'payout'->>'result' IN ('refused','unavailable')))
      ORDER BY created_at DESC LIMIT 8`, []);
    const alerts = [];
    if (auto && auto.on && auto.parked > 0) alerts.push(`${auto.parked} retrait(s) automatique(s) abandonné(s) après plusieurs essais : à traiter à la main.`);
    channels.filter((c) => c.level === "bad").forEach((c) => alerts.push(`${c.channel} : ${c.note}`));
    if (!fp.ready()) alerts.push("FedaPay n'est pas configuré (clés absentes).");
    res.json({ generatedAt: new Date().toISOString(), status: alerts.length ? "ATTENTION" : "OK", alerts, channels, clients: money, auto, refusals, fedapay: { ready: fp.ready(), env: fp.env(), autoPayout: process.env.AUTO_PAYOUT === "on" } });
  } catch (e) { console.error("PULSE", e.message); res.status(500).json({ error: "Erreur." }); }
});
module.exports = router;
