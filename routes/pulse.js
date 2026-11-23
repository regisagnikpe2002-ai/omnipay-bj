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
    const alerts = [];
    if (auto && auto.on && auto.parked > 0) alerts.push(`${auto.parked} retrait(s) automatique(s) abandonné(s) après plusieurs essais : à traiter à la main.`);
    channels.filter((c) => c.level === "bad").forEach((c) => alerts.push(`${c.channel} : ${c.note}`));
    if (!fp.ready()) alerts.push("FedaPay n'est pas configuré (clés absentes).");
    res.json({ generatedAt: new Date().toISOString(), status: alerts.length ? "ATTENTION" : "OK", alerts, channels, clients: money, auto, fedapay: { ready: fp.ready(), env: fp.env(), autoPayout: process.env.AUTO_PAYOUT === "on" } });
  } catch (e) { console.error("PULSE", e.message); res.status(500).json({ error: "Erreur." }); }
});
module.exports = router;
