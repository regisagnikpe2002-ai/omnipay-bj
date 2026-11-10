"use strict";
// OMNIPAY — BUSINESS : encaisser avec OMNIPAY (clés API, liens de paiement, page de paiement, webhooks signés, remboursements, export). FICHIER AJOUTÉ.
// Marchand (connecté) : /keys, /settings, /payments, /export.csv ; Marchand (clé API "Authorization: Bearer omp_live_…" ou "omp_test_…") : /v1/payments…
// Client : GET /checkout/:token (public), POST /checkout/:token/pay (connecté, paie depuis son solde OMNIPAY).
// Mode test : aucune somme ne bouge, tout le reste est identique (liens, page de paiement, webhooks). Mode réel : abonnement Pro requis.
// Frais d'encaissement (déduits du marchand) : BIZ_FEE_PCT (1,5 %), BIZ_FEE_PRO_PCT (1,0 % avec Pro), minimum BIZ_FEE_MIN (25 FCFA). Un remboursement rend 100 % au client.
// Webhooks : POST JSON vers l'URL https du marchand, en-tête OMNIPAY-Signature: t=<horodatage>,v1=HMAC_SHA256(secret, "<t>.<corps>") ; 3 tentatives.
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v >= 0 ? v : d; };
const base = () => (process.env.PUBLIC_BASE_URL || "https://www.omnipay-bj.com").replace(/\/$/, "");
const MIN = 100, MAX = () => num("BIZ_MAX_XOF", 1000000);
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newToken = () => Array.from(crypto.randomBytes(10), (b) => ALPHA[b % ALPHA.length]).join("");
const TOKEN_RE = /^[A-HJ-NP-Z2-9]{10}$/, UUID = /^[0-9a-f-]{36}$/i;
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

let ready = false;
async function ensure() {
  if (ready) return;
  const q = sql();
  await q`CREATE TABLE IF NOT EXISTS biz_profile (user_id uuid PRIMARY KEY, business_name varchar(40), webhook_url varchar(300), webhook_secret varchar(80), updated_at timestamptz NOT NULL DEFAULT now())`;
  await q`CREATE TABLE IF NOT EXISTS biz_keys (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, name varchar(40) NOT NULL, mode varchar(4) NOT NULL, prefix varchar(20) NOT NULL, secret_hash varchar(64) NOT NULL UNIQUE, revoked boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), last_used timestamptz)`;
  await q`CREATE TABLE IF NOT EXISTS biz_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL, key_id uuid, mode varchar(4) NOT NULL, token varchar(10) NOT NULL UNIQUE, amount integer NOT NULL, fee integer NOT NULL DEFAULT 0,
    description varchar(120), reference varchar(60), return_url varchar(300), status varchar(10) NOT NULL DEFAULT 'pending', customer_id uuid, webhook_status varchar(30),
    created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, paid_at timestamptz, refunded_at timestamptz)`;
  await q`CREATE UNIQUE INDEX IF NOT EXISTS biz_pay_ref ON biz_payments (merchant_id, mode, reference) WHERE reference IS NOT NULL`;
  await q`CREATE INDEX IF NOT EXISTS biz_pay_m ON biz_payments (merchant_id, created_at DESC)`;
  ready = true;
}
async function proActive(uid) { try { const r = await sql()`SELECT 1 FROM subs WHERE user_id = ${uid}::uuid AND plan = 'pro' AND status = 'active' AND expires_at > now()`; return r.length > 0; } catch (_) { return false; } }
const feeFor = (amount, pro) => Math.max(Math.round(num("BIZ_FEE_MIN", 25)), Math.ceil((amount * (pro ? num("BIZ_FEE_PRO_PCT", 1) : num("BIZ_FEE_PCT", 1.5))) / 100));
const pub = (p) => ({ id: p.id, mode: p.mode, amount: p.amount, currency: "XOF", description: p.description, reference: p.reference, status: p.status, fee: p.fee, net: p.status === "paid" || p.status === "refunded" ? p.amount - p.fee : null,
  checkoutUrl: base() + "/?bp=" + p.token, expiresAt: p.expires_at, createdAt: p.created_at, paidAt: p.paid_at, refundedAt: p.refunded_at, webhook: p.webhook_status });

// ---------- Webhooks ----------
function privateIp(ip) {
  if (net.isIPv4(ip)) { const [a, b] = ip.split(".").map(Number); return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224 || (a === 100 && b >= 64 && b <= 127); }
  if (net.isIPv6(ip)) { const l = ip.toLowerCase(); return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("::ffff:"); }
  return true;
}
async function safeUrl(u) {
  let x; try { x = new URL(u); } catch (_) { return false; }
  if (x.protocol !== "https:" || x.username || x.password) return false;
  const h = x.hostname.toLowerCase(); if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (net.isIP(h)) return !privateIp(h);
  try { const a = await dns.lookup(h, { all: true }); return a.length > 0 && a.every((r) => !privateIp(r.address)); } catch (_) { return false; }
}
async function deliver(url, secret, event, payment) {
  const body = JSON.stringify({ event, createdAt: new Date().toISOString(), data: payment }), t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", secret).update(t + "." + body).digest("hex");
  if (!(await safeUrl(url))) return "refusé (URL non sûre)";
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 6000);
  try { const r = await fetch(url, { method: "POST", redirect: "manual", signal: ctl.signal, headers: { "content-type": "application/json", "OMNIPAY-Signature": `t=${t},v1=${sig}`, "user-agent": "OMNIPAY-Webhook/1" }, body }); return r.status >= 200 && r.status < 300 ? "ok" : "http " + r.status; }
  catch (e) { return "échec"; } finally { clearTimeout(to); }
}
async function fire(merchantId, event, p) {
  try {
    const [pr] = await sql()`SELECT webhook_url, webhook_secret FROM biz_profile WHERE user_id = ${merchantId}::uuid`;
    if (!pr || !pr.webhook_url || !pr.webhook_secret) return;
    const run = async (n) => { const st = await deliver(pr.webhook_url, pr.webhook_secret, event, pub(p)); await sql()`UPDATE biz_payments SET webhook_status = ${(event + ": " + st + (n > 1 ? " (essai " + n + ")" : "")).slice(0, 30)} WHERE id = ${p.id}::uuid`;
      if (st !== "ok" && !st.startsWith("refusé") && n < 3) { const t = setTimeout(() => run(n + 1).catch(() => {}), n === 1 ? 5000 : 30000); if (t.unref) t.unref(); } };
    await run(1);
  } catch (e) { console.error("BIZ_WEBHOOK", e.message); }
}

// ---------- Création / lecture / remboursement (mêmes règles pour session et clé API) ----------
async function createPayment(uid, mode, keyId, b) {
  const amount = Math.round(Number(b.amount));
  if (!Number.isFinite(amount) || amount < MIN || amount > MAX()) return { s: 400, e: `Montant entre ${MIN} et ${MAX()} FCFA.` };
  if (mode === "live" && !(await proActive(uid))) return { s: 403, e: "L'abonnement Pro est requis pour encaisser en mode réel. Le mode test reste gratuit." };
  const ru = b.returnUrl ? clean(b.returnUrl, 300) : null; if (ru && !/^https:\/\//i.test(ru)) return { s: 400, e: "returnUrl doit commencer par https://." };
  const mins = Math.min(Math.max(Math.round(Number(b.expiresMinutes)) || 60, 5), 10080), ref = b.reference ? clean(b.reference, 60) : null;
  const q = sql();
  if (ref) { const ex = await q`SELECT * FROM biz_payments WHERE merchant_id = ${uid}::uuid AND mode = ${mode} AND reference = ${ref}`; if (ex.length) return { s: 200, p: ex[0] }; }
  const r = await q`INSERT INTO biz_payments (merchant_id, key_id, mode, token, amount, description, reference, return_url, expires_at)
    VALUES (${uid}::uuid, ${keyId || null}, ${mode}, ${newToken()}, ${amount}, ${clean(b.description, 120) || null}, ${ref}, ${ru}, now() + make_interval(mins => ${mins})) RETURNING *`;
  return { s: 201, p: r[0] };
}
async function refund(uid, id) {
  if (!UUID.test(String(id))) return { s: 400, e: "Paiement invalide." };
  const q = sql(), key = "bizr-" + id;
  const r = await q`
    WITH p AS (UPDATE biz_payments SET status = 'refunded', refunded_at = now() WHERE id = ${id}::uuid AND merchant_id = ${uid}::uuid AND status = 'paid'
               AND (mode = 'test' OR (customer_id IS NOT NULL AND EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = ${uid}::uuid AND w.balance >= biz_payments.amount - biz_payments.fee))) RETURNING *),
    m AS (UPDATE wallets SET balance = balance - (p.amount - p.fee), updated_at = now() FROM p WHERE wallets.user_id = p.merchant_id AND p.mode = 'live' RETURNING wallets.id, wallets.balance),
    c AS (UPDATE wallets SET balance = balance + p.amount, updated_at = now() FROM p WHERE wallets.user_id = p.customer_id AND p.mode = 'live' RETURNING wallets.id, wallets.balance),
    t1 AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key) SELECT m.id, 'transfer_out', p.amount - p.fee, m.balance, 'completed', 'business', p.id::text, ${key + "-m"} FROM m, p RETURNING id),
    t2 AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key) SELECT c.id, 'refund', p.amount, c.balance, 'completed', 'business', p.id::text, ${key + "-c"} FROM c, p RETURNING id)
    SELECT * FROM p`;
  if (!r.length) return { s: 409, e: "Remboursement impossible : paiement non réglé, déjà remboursé, ou solde marchand insuffisant." };
  fire(uid, "payment.refunded", r[0]);
  return { s: 200, p: r[0] };
}
const out = (res, r) => (r.e ? res.status(r.s).json({ error: r.e }) : res.status(r.s).json({ payment: pub(r.p) }));

// ---------- Authentification par clé API ----------
async function keyAuth(req, res, next) {
  try {
    await ensure(); const m = /^Bearer\s+(omp_(live|test)_[A-Za-z0-9]{32})$/.exec(String(req.headers.authorization || ""));
    if (!m) return res.status(401).json({ error: "Clé API manquante ou invalide." });
    const r = await sql()`UPDATE biz_keys SET last_used = now() WHERE secret_hash = ${sha(m[1])} AND revoked = false RETURNING id, user_id, mode`;
    if (!r.length) return res.status(401).json({ error: "Clé API invalide ou révoquée." });
    req.biz = { uid: r[0].user_id, keyId: r[0].id, mode: r[0].mode }; next();
  } catch (e) { console.error("BIZ_AUTH", e.message); res.status(500).json({ error: "Erreur." }); }
}
router.post("/v1/payments", keyAuth, async (req, res) => { try { out(res, await createPayment(req.biz.uid, req.biz.mode, req.biz.keyId, req.body || {})); } catch (e) { console.error("BIZ_V1", e.message); res.status(500).json({ error: "Erreur." }); } });
router.get("/v1/payments/:id", keyAuth, async (req, res) => {
  try { if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    const r = await sql()`SELECT * FROM biz_payments WHERE id = ${req.params.id}::uuid AND merchant_id = ${req.biz.uid}::uuid AND mode = ${req.biz.mode}`;
    r.length ? res.json({ payment: pub(r[0]) }) : res.status(404).json({ error: "Paiement introuvable." }); } catch (e) { console.error("BIZ_V1G", e.message); res.status(500).json({ error: "Erreur." }); }
});
router.get("/v1/payments", keyAuth, async (req, res) => {
  try { const r = await sql()`SELECT * FROM biz_payments WHERE merchant_id = ${req.biz.uid}::uuid AND mode = ${req.biz.mode} ORDER BY created_at DESC LIMIT 100`; res.json({ payments: r.map(pub) }); }
  catch (e) { console.error("BIZ_V1L", e.message); res.status(500).json({ error: "Erreur." }); }
});
router.post("/v1/payments/:id/refund", keyAuth, async (req, res) => { try { out(res, await refund(req.biz.uid, req.params.id)); } catch (e) { console.error("BIZ_V1R", e.message); res.status(500).json({ error: "Erreur." }); } });

// ---------- Espace marchand (session) ----------
router.get("/overview", requireAuth, async (req, res) => {
  try { await ensure(); const uid = req.user.userId, q = sql();
    const [p] = await q`SELECT business_name, webhook_url, webhook_secret FROM biz_profile WHERE user_id = ${uid}::uuid`;
    const keys = await q`SELECT id, name, mode, prefix, revoked, created_at, last_used FROM biz_keys WHERE user_id = ${uid}::uuid AND revoked = false ORDER BY created_at DESC`;
    const pay = await q`SELECT * FROM biz_payments WHERE merchant_id = ${uid}::uuid ORDER BY created_at DESC LIMIT 30`;
    const [s] = await q`SELECT count(*) FILTER (WHERE status = 'paid' AND mode = 'live')::int AS n, COALESCE(sum(amount - fee) FILTER (WHERE status = 'paid' AND mode = 'live'),0)::float AS net FROM biz_payments WHERE merchant_id = ${uid}::uuid`;
    res.json({ profile: { businessName: p ? p.business_name : null, webhookUrl: p ? p.webhook_url : null, webhookSecret: p ? p.webhook_secret : null }, keys, payments: pay.map(pub), stats: { paidCount: s.n, netXof: s.net },
      pro: await proActive(uid), fees: { standard: num("BIZ_FEE_PCT", 1.5), pro: num("BIZ_FEE_PRO_PCT", 1), min: num("BIZ_FEE_MIN", 25) }, api: base() + "/api/business/v1" }); }
  catch (e) { console.error("BIZ_OV", e.message); res.status(500).json({ error: "Erreur." }); }
});
router.post("/settings", requireAuth, async (req, res) => {
  try { await ensure(); const uid = req.user.userId, b = req.body || {}, name = clean(b.businessName, 40), url = clean(b.webhookUrl, 300);
    if (name && name.length < 3) return res.status(400).json({ error: "Nom commercial : 3 caractères minimum." });
    if (url && !(await safeUrl(url))) return res.status(400).json({ error: "URL de webhook invalide : https:// obligatoire, adresse publique uniquement." });
    const sec = "whsec_" + crypto.randomBytes(24).toString("hex");
    const r = await sql()`INSERT INTO biz_profile (user_id, business_name, webhook_url, webhook_secret) VALUES (${uid}::uuid, ${name || null}, ${url || null}, ${url ? sec : null})
      ON CONFLICT (user_id) DO UPDATE SET business_name = EXCLUDED.business_name, webhook_url = EXCLUDED.webhook_url, updated_at = now(),
        webhook_secret = CASE WHEN EXCLUDED.webhook_url IS NULL THEN NULL ELSE COALESCE(biz_profile.webhook_secret, EXCLUDED.webhook_secret) END RETURNING webhook_secret`;
    res.json({ ok: true, webhookSecret: r[0].webhook_secret }); } catch (e) { console.error("BIZ_SET", e.message); res.status(500).json({ error: "Erreur." }); }
});
router.post("/keys", requireAuth, async (req, res) => {
  try { await ensure(); const uid = req.user.userId, mode = (req.body || {}).mode === "live" ? "live" : "test", name = clean((req.body || {}).name, 40) || "Ma clé";
    if (mode === "live" && !(await proActive(uid))) return res.status(403).json({ error: "L'abonnement Pro est requis pour une clé en mode réel. Les clés de test sont gratuites." });
    const [n] = await sql()`SELECT count(*)::int AS n FROM biz_keys WHERE user_id = ${uid}::uuid AND revoked = false`; if (n.n >= 10) return res.status(400).json({ error: "10 clés maximum." });
    const secret = "omp_" + mode + "_" + crypto.randomBytes(16).toString("hex");
    await sql()`INSERT INTO biz_keys (user_id, name, mode, prefix, secret_hash) VALUES (${uid}::uuid, ${name}, ${mode}, ${secret.slice(0, 14) + "…"}, ${sha(secret)})`;
    res.status(201).json({ key: secret, notice: "Copiez cette clé maintenant : elle ne sera plus jamais affichée." }); }
  catch (e) { console.error("BIZ_KEY", e.message); res.status(500).json({ error: "Erreur." }); }
});
router.post("/keys/:id/revoke", requireAuth, async (req, res) => {
  try { await ensure(); if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Clé invalide." });
    const r = await sql()`UPDATE biz_keys SET revoked = true WHERE id = ${req.params.id}::uuid AND user_id = ${req.user.userId}::uuid RETURNING id`; res.json({ ok: r.length > 0 }); }
  catch (e) { console.error("BIZ_REV", e.message); res.status(500).json({ error: "Erreur." }); }
});
router.post("/payments", requireAuth, async (req, res) => { try { await ensure(); out(res, await createPayment(req.user.userId, (req.body || {}).mode === "live" ? "live" : "test", null, req.body || {})); } catch (e) { console.error("BIZ_PAY", e.message); res.status(500).json({ error: "Erreur." }); } });
router.post("/payments/:id/refund", requireAuth, async (req, res) => { try { await ensure(); out(res, await refund(req.user.userId, req.params.id)); } catch (e) { console.error("BIZ_REF", e.message); res.status(500).json({ error: "Erreur." }); } });
router.post("/payments/:id/cancel", requireAuth, async (req, res) => {
  try { await ensure(); if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Paiement invalide." });
    const r = await sql()`UPDATE biz_payments SET status = 'cancelled' WHERE id = ${req.params.id}::uuid AND merchant_id = ${req.user.userId}::uuid AND status = 'pending' RETURNING id`; res.json({ ok: r.length > 0 }); }
  catch (e) { console.error("BIZ_CAN", e.message); res.status(500).json({ error: "Erreur." }); }
});
router.get("/export.csv", requireAuth, async (req, res) => {
  try { await ensure(); const r = await sql()`SELECT * FROM biz_payments WHERE merchant_id = ${req.user.userId}::uuid ORDER BY created_at DESC LIMIT 5000`;
    const esc = (v) => { let s = String(v == null ? "" : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const rows = [["id", "date", "mode", "statut", "montant", "frais", "net", "reference", "description"].join(",")].concat(r.map((p) => [p.id, new Date(p.created_at).toISOString(), p.mode, p.status, p.amount, p.fee, p.amount - p.fee, esc(p.reference), esc(p.description)].join(",")));
    res.set("Content-Type", "text/csv; charset=utf-8"); res.set("Content-Disposition", 'attachment; filename="omnipay-encaissements.csv"'); res.send(rows.join("\n")); }
  catch (e) { console.error("BIZ_CSV", e.message); res.status(500).json({ error: "Erreur." }); }
});

// ---------- Page de paiement ----------
router.get("/checkout/:token", async (req, res) => {
  try { await ensure(); const t = String(req.params.token || "").toUpperCase(); if (!TOKEN_RE.test(t)) return res.status(400).json({ error: "Lien invalide." });
    const r = await sql()`SELECT p.*, b.business_name FROM biz_payments p LEFT JOIN biz_profile b ON b.user_id = p.merchant_id WHERE p.token = ${t}`;
    if (!r.length) return res.status(404).json({ error: "Lien de paiement introuvable." });
    const p = r[0], expired = p.status === "pending" && new Date(p.expires_at) <= new Date();
    res.json({ merchant: p.business_name || "Marchand OMNIPAY", amount: p.amount, description: p.description, mode: p.mode, status: expired ? "expired" : p.status, returnUrl: p.status === "paid" ? p.return_url : null }); }
  catch (e) { console.error("BIZ_CK", e.message); res.status(500).json({ error: "Erreur." }); }
});
router.post("/checkout/:token/pay", requireAuth, async (req, res) => {
  try { await ensure(); const t = String(req.params.token || "").toUpperCase(), me = req.user.userId; if (!TOKEN_RE.test(t)) return res.status(400).json({ error: "Lien invalide." });
    const q = sql(), [p] = await q`SELECT * FROM biz_payments WHERE token = ${t}`;
    if (!p) return res.status(404).json({ error: "Lien de paiement introuvable." });
    if (p.status !== "pending" || new Date(p.expires_at) <= new Date()) return res.status(409).json({ error: "Ce paiement est expiré ou déjà réglé." });
    if (p.merchant_id === me) return res.status(400).json({ error: "Vous ne pouvez pas payer votre propre lien." });
    const fee = feeFor(p.amount, await proActive(p.merchant_id));
    let row;
    if (p.mode === "test") { row = (await q`UPDATE biz_payments SET status = 'paid', paid_at = now(), customer_id = ${me}::uuid, fee = ${fee} WHERE id = ${p.id}::uuid AND status = 'pending' RETURNING *`)[0]; }
    else {
      const key = "biz-" + p.id, net = p.amount - fee;
      const r = await q`
        WITH u AS (UPDATE biz_payments SET status = 'paid', paid_at = now(), customer_id = ${me}::uuid, fee = ${fee} WHERE id = ${p.id}::uuid AND status = 'pending' AND expires_at > now() AND merchant_id <> ${me}::uuid
                   AND EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = ${me}::uuid AND w.balance >= ${p.amount}) AND EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = biz_payments.merchant_id) RETURNING *),
        s AS (UPDATE wallets SET balance = balance - ${p.amount}, updated_at = now() WHERE user_id = ${me}::uuid AND balance >= ${p.amount} AND EXISTS (SELECT 1 FROM u) RETURNING id, balance),
        d AS (UPDATE wallets SET balance = balance + ${net}, updated_at = now() FROM u WHERE wallets.user_id = u.merchant_id AND EXISTS (SELECT 1 FROM s) RETURNING wallets.id, wallets.balance),
        o AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key) SELECT s.id, 'transfer_out', ${p.amount}, s.balance, 'completed', 'business', ${p.id}::text, ${key + "-out"} FROM s, d RETURNING id),
        i AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key) SELECT d.id, 'transfer_in', ${net}, d.balance, 'completed', 'business', ${p.id}::text, ${key + "-in"} FROM d RETURNING id)
        SELECT u.*, s.balance AS payer_balance FROM u, s, d`;
      if (!r.length) { const w = await q`SELECT balance FROM wallets WHERE user_id = ${me}::uuid`; if (w.length && Number(w[0].balance) < p.amount) return res.status(400).json({ error: "Solde insuffisant : il faut " + p.amount + " FCFA." }); return res.status(409).json({ error: "Ce paiement vient d'être réglé ou n'est plus valable." }); }
      row = r[0]; row.newBalance = Number(r[0].payer_balance);
    }
    if (!row) return res.status(409).json({ error: "Ce paiement vient d'être réglé." });
    fire(p.merchant_id, "payment.paid", row);
    res.json({ ok: true, message: p.mode === "test" ? "Paiement test enregistré (aucune somme débitée)." : "Paiement effectué.", newBalance: row.newBalance, returnUrl: p.return_url || null });
  } catch (e) { console.error("BIZ_PAYX", e.message); res.status(500).json({ error: "Erreur serveur lors du paiement." }); }
});

module.exports = router;
module.exports._safeUrl = safeUrl;
