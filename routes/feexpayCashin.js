"use strict";
// OMNIPAY — ENCAISSEMENT MOBILE MONEY (dépôt) via le prestataire, adresse neutre /api/cashin. Le nom du prestataire reste invisible côté client.
//   GET  /api/cashin/status         -> { enabled, providers, min, max }
//   POST /api/cashin                {amount, phone, provider:'mtn'|'moov'|'celtiis'} -> demande de paiement sur le téléphone du client
//   GET  /api/cashin/:ref           -> statut du dépôt : relu chez le prestataire avant tout crédit (le webhook ne sert que de déclencheur)
//   GET  /api/cashin/terminal/list  -> dernières ventes du terminal marchand
// Réglages Render : FEEXPAY_API_KEY (clé secrète, jamais dans le code), FEEXPAY_SHOP_ID, FEEXPAY_WEBHOOK_SECRET (déjà utilisé par le webhook).
// Optionnel : FEEXPAY_BASE (défaut https://api-v2.feexpay.me), FEEXPAY_MIN_XOF (100), FEEXPAY_MAX_XOF (2000000), FEEXPAY_DEPOSITS=off pour couper.
const express = require("express");
const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");
const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (n, d) => { const v = Number(process.env[n]); return Number.isFinite(v) && v > 0 ? v : d; };
const MIN = () => num("FEEXPAY_MIN_XOF", 100), MAX = () => num("FEEXPAY_MAX_XOF", 2000000);
const BASE = () => String(process.env.FEEXPAY_BASE || "https://api-v2.feexpay.me").replace(/\/+$/, "");
// Une clé de TEST (« testkey… ») ne déplace aucun argent réel : elle est refusée sauf essai volontaire (FEEXPAY_ALLOW_SANDBOX=on), pour ne jamais créditer de vrais soldes avec de faux paiements.
const isTestKey = () => /^testkey/i.test(String(process.env.FEEXPAY_API_KEY || "").trim());
const ready = () => Boolean(process.env.FEEXPAY_API_KEY && process.env.FEEXPAY_SHOP_ID) && (!isTestKey() || ["on", "true", "1", "yes"].includes(String(process.env.FEEXPAY_ALLOW_SANDBOX || "off").toLowerCase()));
const enabled = () => ready() && String(process.env.FEEXPAY_DEPOSITS || "on").toLowerCase() !== "off";
const OPS = ["mtn", "moov", "celtiis"];
// Format FeexPay (Bénin) : 229 + 10 chiffres commençant par 01 (ex. 2290166000000). Un ancien numéro à 8 chiffres reçoit le préfixe 01.
const digits = (p) => { let d = String(p || "").replace(/\D/g, ""); if (d.startsWith("00")) d = d.slice(2); if (d.startsWith("229")) d = d.slice(3); if (d.length === 8) d = "01" + d; return "229" + d; };

const OK = new Set(["SUCCESSFUL", "SUCCESS", "SUCCEEDED", "COMPLETED", "PAID"]);
const KO = new Set(["FAILED", "FAILURE", "CANCELLED", "CANCELED", "REJECTED", "EXPIRED", "DECLINED"]);
// Prévient le site du marchand (webhook signé OMNIPAY) quand un encaissement lancé par son API est réglé ou échoue.
async function notifyApi(txId, event) {
  const r = await sql()`SELECT t.provider_ref AS id, t.amount::float AS amount, t.status, t.metadata, w.user_id FROM transactions t JOIN wallets w ON w.id = t.wallet_id WHERE t.id = ${txId}`;
  if (!r.length || !r[0].metadata || !r[0].metadata.api) return;
  await require("./business").notifyCollect(r[0].user_id, event, { id: r[0].id, amount: r[0].amount, currency: "XOF", status: r[0].status === "completed" ? "paid" : r[0].status, reference: r[0].metadata.merchantRef || null, operator: r[0].metadata.provider });
}

// Lit un événement du prestataire quel que soit son habillage ({...} ou {data:{...}}). Un statut inconnu ne crédite jamais.
function interpret(body) {
  const b = body && typeof body === "object" ? body : {};
  const d = b.data && typeof b.data === "object" ? b.data : b;
  const st = String(d.status || b.status || "").toUpperCase();
  return {
    reference: d.reference ? String(d.reference) : null,
    mine: d.callback_info ? String(d.callback_info) : (d.callbackInfo ? String(d.callbackInfo) : null),
    amount: Number(d.amount), outcome: OK.has(st) ? "ok" : KO.has(st) ? "ko" : "pending", raw: st,
  };
}

router.get("/status", requireAuth, (req, res) => res.json({ enabled: enabled(), providers: OPS, min: MIN(), max: MAX() }));

// Règle un dépôt à partir d'un événement DÉJÀ vérifié (signature HMAC) : référence connue + montant au moins égal à celui demandé.
// Lecture du statut chez le prestataire : c'est LUI qui fait foi (le webhook n'est qu'un déclencheur, jamais une preuve).
async function remote(path) {
  try {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(BASE() + path, { headers: { Authorization: "Bearer " + process.env.FEEXPAY_API_KEY }, signal: ctl.signal });
    clearTimeout(to); if (!r.ok) return null; return interpret(await r.json());
  } catch (e) { return null; }
}
const readPayin = (ref) => remote("/api/transactions/public/single/status/" + encodeURIComponent(ref));
const readPayout = (ref) => remote("/api/payouts/status/public/" + encodeURIComponent(ref));

// Règle un dépôt en attente d'après le statut relu chez le prestataire : référence identique + montant au moins égal à celui demandé.
async function settleDeposit(row) {
  const q = sql(); const ref = row.feex_ref || row.hint;
  if (!ref) return { status: "pending" };
  const ev = await readPayin(ref); if (!ev) return { status: "pending" };
  if (ev.reference && row.feex_ref && ev.reference !== row.feex_ref) { console.error("CASHIN_REF_MISMATCH", row.provider_ref); return { status: "pending" }; }
  if (ev.outcome === "pending") return { status: "pending" };
  if (ev.outcome === "ko") { const u = await q`UPDATE transactions SET status = 'failed' WHERE id = ${row.id} AND status = 'pending' RETURNING id`; if (u.length) notifyApi(row.id, "collect.failed").catch(() => {}); return { status: "failed" }; }
  if (!Number.isFinite(ev.amount) || ev.amount + 0.0001 < row.amount) {
    await q`UPDATE transactions SET metadata = coalesce(metadata,'{}'::jsonb) || ${JSON.stringify({ amountMismatch: ev.amount })}::jsonb WHERE id = ${row.id}`;
    console.error("CASHIN_AMOUNT_MISMATCH", row.provider_ref, ev.amount); return { status: "pending" };
  }
  await q`WITH t AS (SELECT id, wallet_id, amount FROM transactions WHERE id = ${row.id} AND status = 'pending' FOR UPDATE),
    w AS (UPDATE wallets SET balance = balance + t.amount, updated_at = now() FROM t WHERE wallets.id = t.wallet_id RETURNING wallets.balance, t.id AS tx_id)
    UPDATE transactions SET status = 'completed', balance_after = w.balance FROM w WHERE transactions.id = w.tx_id AND transactions.status = 'pending'`;
  notifyApi(row.id, "collect.paid").catch(() => {});
  return { status: "completed" };
}

// Retrait Mobile Money : vérification du statut final obligatoire (SUCCESSFUL -> terminé ; FAILED -> échoué, remboursé si FEEXPAY_AUTO_REFUND=on).
async function settlePayout(id, hint) {
  const q = sql();
  const w = await q`SELECT id, status, metadata->'payout'->>'ref' AS pref FROM transactions WHERE id = ${id}::uuid AND type = 'withdrawal' AND metadata->'payout'->>'route' = 'feexpay'`;
  if (!w.length) return null;
  if (w[0].status !== "processing") return { status: w[0].status };
  const ref = w[0].pref && w[0].pref !== id ? w[0].pref : hint; if (!ref) return { status: "processing" };
  const ev = await readPayout(ref); if (!ev || ev.outcome === "pending") return { status: "processing" };
  if (ev.outcome === "ok") { await q`UPDATE transactions SET status = 'completed' WHERE id = ${id}::uuid AND type = 'withdrawal' AND status = 'processing'`; return { status: "completed" }; }
  const u = await q`UPDATE transactions SET status = 'failed' WHERE id = ${id}::uuid AND type = 'withdrawal' AND status = 'processing' RETURNING id`;
  if (u.length && ["on", "true", "1", "yes"].includes(String(process.env.FEEXPAY_AUTO_REFUND || "off").toLowerCase())) {
    try { await require("./walletOps").refundOne(id, true, "Mobile Money : transfert échoué (remboursement automatique)"); } catch (e) { console.error("FEEXPAY_AUTOREFUND", e.message); }
  }
  return { status: "failed" };
}

// Appelé par le webhook DÉJÀ vérifié (signature) : il ne sert qu'à savoir quelle opération relire.
async function settleFromWebhook(body) {
  const ev = interpret(body); const q = sql();
  if (ev.mine && UUID.test(ev.mine)) { const r = await settlePayout(ev.mine, ev.reference); if (r) return { done: r.status !== "processing", status: r.status, why: "retrait " + r.status }; }
  const rows = await q`SELECT id, provider_ref, amount::float AS amount, status, metadata->>'feexRef' AS feex_ref FROM transactions
    WHERE provider = 'feexpay' AND type = 'deposit' AND (provider_ref = ${ev.mine && UUID.test(ev.mine) ? ev.mine : "-"} OR metadata->>'feexRef' = ${ev.reference || "-"}) LIMIT 1`;
  if (!rows.length) return { done: false, why: "référence inconnue" };
  if (rows[0].status !== "pending") return { done: false, why: "déjà réglé" };
  const r = await settleDeposit({ ...rows[0], hint: ev.reference });
  return { done: r.status !== "pending", status: r.status, why: "dépôt " + r.status };
}

// Filet de sécurité toutes les 60 s : relit les dépôts et retraits restés en attente (webhook perdu ou en retard).
async function tick() {
  const out = { deposits: 0, payouts: 0 }; if (!ready() || !process.env.DATABASE_URL) return out;
  const q = sql();
  for (const d of await q`SELECT id, provider_ref, amount::float AS amount, metadata->>'feexRef' AS feex_ref FROM transactions WHERE provider = 'feexpay' AND type = 'deposit' AND status = 'pending' AND created_at > now() - interval '3 days' AND metadata->>'feexRef' IS NOT NULL ORDER BY created_at LIMIT 40`) { try { if ((await settleDeposit(d)).status === "completed") out.deposits++; } catch (e) { console.error("CASHIN_TICK", e.message); } }
  for (const w of await q`SELECT id FROM transactions WHERE type = 'withdrawal' AND status = 'processing' AND metadata->'payout'->>'route' = 'feexpay' AND metadata->'payout'->>'ref' IS NOT NULL ORDER BY created_at LIMIT 40`) { try { const r = await settlePayout(w.id); if (r && r.status !== "processing") out.payouts++; } catch (e) { console.error("CASHIN_TICK_PAY", e.message); } }
  return out;
}
if (ready() && process.env.DATABASE_URL && String(process.env.FEEXPAY_WATCH || "on").toLowerCase() !== "off" && process.env.NODE_ENV !== "test") setInterval(() => { tick().catch((e) => console.error("CASHIN_WATCH", e.message)); }, 60000).unref();
if (ready()) console.log("[CASHIN] encaissement et retraits actifs, suivi automatique toutes les 60 s"); else console.log("[CASHIN] en attente de FEEXPAY_API_KEY / FEEXPAY_SHOP_ID");

// Lance un encaissement Mobile Money vers le portefeuille de userId (client connecté OU marchand par clé API). Renvoie {s: statut HTTP, body}.
async function startDeposit(userId, b, extraMeta) {
  if (!enabled()) return { s: 503, body: { error: "Dépôt Mobile Money indisponible pour le moment." } };
  const amount = Math.floor(Number(b && b.amount));
  if (!Number.isFinite(amount) || amount < MIN() || amount > MAX()) return { s: 400, body: { error: `Montant entre ${MIN()} et ${MAX()} FCFA.` } };
  const provider = String((b && b.provider) || "").toLowerCase();
  if (!OPS.includes(provider)) return { s: 400, body: { error: "Choisissez MTN, Moov ou Celtiis." } };
  const phone = digits(b && b.phone);
  if (!/^22901\d{8}$/.test(phone)) return { s: 400, body: { error: "Numéro invalide." } };
  const q = sql();
  const w = await q`SELECT id, balance FROM wallets WHERE user_id = ${userId}::uuid`;
  if (!w.length) return { s: 404, body: { error: "Wallet introuvable." } };
  const recent = await q`SELECT count(*)::int AS n FROM transactions WHERE wallet_id = ${w[0].id} AND provider = 'feexpay' AND status = 'pending' AND created_at > now() - interval '15 minutes'`;
  if (recent[0].n >= (extraMeta && extraMeta.api ? 20 : 3)) return { s: 429, body: { error: "Trop de demandes en attente. Patientez quelques minutes." } };
  let f = "Client", l = "OMNIPAY";
  try { const [u] = await q`SELECT first_name, last_name FROM users WHERE id = ${userId}::uuid`; if (u) { f = String(u.first_name || f).slice(0, 40) || f; l = String(u.last_name || l).slice(0, 40) || l; } } catch (e) {}
  const ref = crypto.randomUUID(), term = Boolean(b && b.terminal);
  const meta = { phone, provider, ...(term ? { terminal: true, note: String((b && b.note) || "").slice(0, 80) } : {}), ...(extraMeta || {}) };
  await q`INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key, metadata)
          VALUES (${w[0].id}, 'deposit', ${amount}, ${w[0].balance}, 'pending', 'feexpay', ${ref}, ${"feexpay-" + ref}, ${JSON.stringify(meta)}::jsonb)`;
  let r, body = null;
  try {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 20000);
    r = await fetch(`${BASE()}/api/transactions/public/requesttopay/${provider}`, { method: "POST", signal: ctl.signal,
      headers: { Authorization: "Bearer " + process.env.FEEXPAY_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ phoneNumber: phone, amount, shop: process.env.FEEXPAY_SHOP_ID, first_name: f, last_name: l, description: "Depot OMNIPAY", callback_info: ref }) });
    clearTimeout(to); body = await r.json().catch(() => null);
  } catch (e) { console.error("CASHIN_NET", e.message); }
  if (!r || !r.ok) {
    await q`UPDATE transactions SET status = 'failed' WHERE provider_ref = ${ref} AND provider = 'feexpay'`;
    console.error("CASHIN_REFUSED", provider, r && r.status, JSON.stringify(body || {}).slice(0, 160)); // jamais de clé ni de numéro
    return { s: 400, body: { error: "La demande a été refusée (numéro, montant ou service indisponible)." } };
  }
  if (body && body.reference) await q`UPDATE transactions SET metadata = coalesce(metadata,'{}'::jsonb) || ${JSON.stringify({ feexRef: String(body.reference) })}::jsonb WHERE provider_ref = ${ref} AND provider = 'feexpay'`;
  return { s: 201, body: { reference: ref, status: "pending", message: "Validez le paiement sur votre téléphone (code secret Mobile Money)." } };
}

router.post("/", requireAuth, async (req, res) => {
  try { const r = await startDeposit(req.user.userId, req.body, null); res.status(r.s).json(r.body); }
  catch (e) { console.error("CASHIN", e.message); res.status(500).json({ error: "Impossible de lancer le dépôt." }); }
});

router.get("/terminal/list", requireAuth, async (req, res) => {
  try {
    const rows = await sql()`SELECT t.provider_ref AS ref, t.amount::float AS amount, t.status, t.created_at, t.metadata->>'phone' AS phone, t.metadata->>'provider' AS op, t.metadata->>'note' AS note
      FROM transactions t JOIN wallets w ON w.id = t.wallet_id
      WHERE w.user_id = ${req.user.userId}::uuid AND t.provider IN ('feexpay','fedapay') AND t.type = 'deposit' AND t.metadata->>'terminal' = 'true' ORDER BY t.created_at DESC LIMIT 15`;
    res.json({ sales: rows.map((r) => ({ ...r, phone: "••••" + String(r.phone || "").slice(-4) })) });
  } catch (e) { console.error("CASHIN_TERMINAL", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

// Tableau par opérateur (24 h) : entrées (dépôts réussis) et sorties (retraits non échoués) du client connecté.
router.get("/summary", requireAuth, async (req, res) => {
  try {
    const rows = await sql()`SELECT op, sum(inn)::float AS inn, sum(out)::float AS out, sum(n)::int AS n FROM (
        SELECT t.metadata->>'provider' AS op, t.amount AS inn, 0 AS out, 1 AS n FROM transactions t JOIN wallets w ON w.id = t.wallet_id
          WHERE w.user_id = ${req.user.userId}::uuid AND t.type = 'deposit' AND t.status = 'completed' AND t.created_at > now() - interval '24 hours'
        UNION ALL
        SELECT t.provider AS op, 0, t.amount, 0 FROM transactions t JOIN wallets w ON w.id = t.wallet_id
          WHERE w.user_id = ${req.user.userId}::uuid AND t.type = 'withdrawal' AND t.status IN ('pending','processing','completed') AND t.created_at > now() - interval '24 hours') x
      WHERE op IN ('mtn','moov','celtiis') GROUP BY op`;
    const o = {}; for (const r of rows) o[r.op] = { in: r.inn || 0, out: r.out || 0, n: r.n || 0 };
    res.json({ operators: o });
  } catch (e) { console.error("CASHIN_SUMMARY", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

// Tableau de bord des fonds (administrateur, x-admin-key) : configuration du prestataire, engagements envers les clients, flux 24 h par opérateur, anomalies.
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
router.get("/admin/overview", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Accès refusé." });
  try {
    const q = sql(), env = process.env;
    const sec = String(env.FEEXPAY_WEBHOOK_SECRET || "").trim();
    const config = { keySet: Boolean(env.FEEXPAY_API_KEY), testKey: isTestKey(), shopSet: Boolean(env.FEEXPAY_SHOP_ID), active: ready(), depositsOn: enabled(),
      webhookSecret: !sec ? "absent" : /^fxp_whsec_/.test(sec) ? "ok" : "invalide (doit commencer par fxp_whsec_)", autoRefund: ["on", "true", "1", "yes"].includes(String(env.FEEXPAY_AUTO_REFUND || "off").toLowerCase()),
      routes: { mtn: env.PAYOUT_ROUTE_MTN || null, moov: env.PAYOUT_ROUTE_MOOV || null, celtiis: env.PAYOUT_ROUTE_CELTIIS || null }, payoutMax: num("FEEXPAY_PAYOUT_MAX_XOF", 50000) };
    const [liab] = await q`SELECT coalesce(sum(balance),0)::float AS total, count(*)::int AS wallets FROM wallets`;
    const ops = await q`SELECT op, sum(inn)::float AS inn, sum(inn_n)::int AS inn_n, sum(out)::float AS out, sum(out_n)::int AS out_n FROM (
        SELECT metadata->>'provider' AS op, amount AS inn, 1 AS inn_n, 0 AS out, 0 AS out_n FROM transactions WHERE type = 'deposit' AND provider = 'feexpay' AND status = 'completed' AND created_at > now() - interval '24 hours'
        UNION ALL SELECT provider, 0, 0, amount, 1 FROM transactions WHERE type = 'withdrawal' AND provider IN ('mtn','moov','celtiis') AND metadata->'payout'->>'route' = 'feexpay' AND status IN ('processing','completed') AND created_at > now() - interval '24 hours') x
      WHERE op IN ('mtn','moov','celtiis') GROUP BY op`;
    const [an] = await q`SELECT
      (SELECT count(*) FROM transactions WHERE type = 'deposit' AND provider = 'feexpay' AND status = 'pending' AND created_at < now() - interval '15 minutes' AND created_at > now() - interval '3 days')::int AS stuck_deposits,
      (SELECT count(*) FROM transactions WHERE type = 'withdrawal' AND status = 'processing' AND metadata->'payout'->>'route' = 'feexpay' AND created_at < now() - interval '30 minutes')::int AS stuck_payouts,
      (SELECT count(*) FROM transactions WHERE type = 'deposit' AND provider = 'feexpay' AND status = 'failed' AND created_at > now() - interval '24 hours')::int AS failed_deposits,
      (SELECT count(*) FROM transactions WHERE type = 'withdrawal' AND status = 'failed' AND created_at > now() - interval '24 hours')::int AS failed_payouts,
      (SELECT count(*) FROM transactions WHERE type = 'withdrawal' AND status IN ('pending') AND metadata->'payout'->>'route' IS NULL)::int AS manual_queue`;
    const o = {}; for (const r of ops) o[r.op] = { in: r.inn || 0, inCount: r.inn_n || 0, out: r.out || 0, outCount: r.out_n || 0 };
    const alerts = [];
    if (!config.active) alerts.push(config.testKey ? "Clé de TEST détectée : encaissements et retraits automatiques désactivés." : "Prestataire non configuré (clé ou identifiant boutique manquant).");
    if (config.webhookSecret !== "ok") alerts.push("FEEXPAY_WEBHOOK_SECRET : " + config.webhookSecret + ". Le filet de 60 s crédite quand même, avec retard.");
    for (const k of ["mtn", "moov", "celtiis"]) if (config.active && config.routes[k] !== "feexpay") alerts.push("PAYOUT_ROUTE_" + k.toUpperCase() + " n'est pas « feexpay » : retraits " + k.toUpperCase() + " non automatiques.");
    if (an.stuck_deposits) alerts.push(an.stuck_deposits + " dépôt(s) en attente depuis plus de 15 min.");
    if (an.stuck_payouts) alerts.push(an.stuck_payouts + " retrait(s) en cours depuis plus de 30 min.");
    res.json({ config, liabilities: liab, operators: o, anomalies: an, alerts, at: new Date().toISOString() });
  } catch (e) { console.error("CASHIN_ADMIN", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.get("/:ref", requireAuth, async (req, res) => {
  try {
    if (!UUID.test(req.params.ref)) return res.status(400).json({ error: "Référence invalide." });
    const r = await sql()`SELECT t.id, t.provider, t.status, t.provider_ref, t.amount::float AS amount, t.metadata->>'feexRef' AS feex_ref FROM transactions t JOIN wallets w ON w.id = t.wallet_id WHERE t.provider IN ('feexpay','fedapay') AND t.provider_ref = ${req.params.ref} AND w.user_id = ${req.user.userId}::uuid`;
    if (!r.length) return res.status(404).json({ error: "Dépôt introuvable." });
    if (r[0].provider === "feexpay" && r[0].status === "pending" && ready()) return res.json(await settleDeposit(r[0]));
    res.json({ status: r[0].status });
  } catch (e) { console.error("CASHIN_POLL", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router; module.exports.enabled = enabled; module.exports.settleFromWebhook = settleFromWebhook; module.exports._interpret = interpret; module.exports._tick = tick; module.exports.startDeposit = startDeposit;
