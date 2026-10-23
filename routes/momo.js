"use strict";
// OMNIPAY — adaptateur MTN MoMo (fichier AJOUTÉ, à placer dans routes/). Aucun intermédiaire : OMNIPAY parle directement à MTN.
//   • DÉPÔT automatique (API « Collection », requesttopay) : le client saisit son n° MTN, reçoit la demande de validation sur son téléphone,
//     et son solde est crédité (ou la trésorerie de l'agent OMNICASH, si target = "float") dès que MTN confirme SUCCESSFUL.
//   • RETRAIT automatique (API « Disbursement », déjà dans providers/payoutRouter.js) : ce fichier en suit le résultat toutes les minutes
//     et clôture le retrait (completed / failed). Remboursement automatique SEULEMENT si MOMO_AUTO_REFUND=on.
// Rien n'est jamais cru sur parole : le callback ne sert qu'à déclencher une vérification auprès de MTN, et le crédit est une seule requête SQL atomique.
// Variables Render (Collection et Disbursement sont deux produits MTN distincts, avec chacun leurs clés) :
//   MTN_MOMO_BASE (sandbox : https://sandbox.momodeveloper.mtn.com), MTN_MOMO_ENV (sandbox | mtnbenin …), MTN_MOMO_CURRENCY (XOF ; EUR en sandbox)
//   Collection  : MTN_MOMO_COLL_SUB_KEY, MTN_MOMO_COLL_API_USER, MTN_MOMO_COLL_API_KEY
//   Disbursement: MTN_MOMO_SUB_KEY, MTN_MOMO_API_USER, MTN_MOMO_API_KEY (+ PAYOUT_ROUTE_MTN=momo)
//   Facultatif  : MOMO_MIN_XOF (500), MOMO_MAX_XOF (500000), MOMO_AUTO_REFUND (off), PUBLIC_BASE_URL
const crypto = require("crypto");
const axios = require("axios");
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." }));
const num = (n, d) => { const v = Number(process.env[n]); return Number.isFinite(v) && v > 0 ? v : d; };
const MIN = () => num("MOMO_MIN_XOF", 500);
const MAX = () => num("MOMO_MAX_XOF", 500000);
const on = (n) => ["on", "true", "1", "yes"].includes(String(process.env[n] || "off").toLowerCase());
const baseUrl = () => (process.env.PUBLIC_BASE_URL || "https://www.omnipay-bj.com").replace(/\/$/, "");
const secret = () => process.env.OTP_SECRET || process.env.ADMIN_KEY || "";
const sig = (ref) => crypto.createHmac("sha256", secret()).update("momo:" + ref).digest("hex").slice(0, 32);
const intl = (p) => { let d = String(p || "").replace(/\D/g, ""); if (d.startsWith("00")) d = d.slice(2); return d.startsWith("229") ? d : "229" + d; };

const cfg = () => ({
  base: (process.env.MTN_MOMO_BASE || "").replace(/\/$/, ""), env: process.env.MTN_MOMO_ENV || "sandbox", currency: process.env.MTN_MOMO_CURRENCY || "XOF",
  sub: process.env.MTN_MOMO_COLL_SUB_KEY, user: process.env.MTN_MOMO_COLL_API_USER, key: process.env.MTN_MOMO_COLL_API_KEY,
});
const ready = (c) => Boolean(c.base && c.sub && c.user && c.key);

let tokenCache = { t: null, exp: 0 };
async function token(c) {
  if (tokenCache.t && Date.now() < tokenCache.exp) return tokenCache.t;
  const r = await axios.post(`${c.base}/collection/token/`, null, {
    headers: { Authorization: "Basic " + Buffer.from(`${c.user}:${c.key}`).toString("base64"), "Ocp-Apim-Subscription-Key": c.sub }, timeout: 20000 });
  tokenCache = { t: r.data.access_token, exp: Date.now() + Math.max(60, Number(r.data.expires_in || 3600) - 120) * 1000 };
  return tokenCache.t;
}
async function requestToPay(c, ref, amount, phone) {
  return axios.post(`${c.base}/collection/v1_0/requesttopay`, {
    amount: String(amount), currency: c.currency, externalId: ref.replace(/-/g, "").slice(0, 20),
    payer: { partyIdType: "MSISDN", partyId: intl(phone) }, payerMessage: "Depot OMNIPAY", payeeNote: "Depot OMNIPAY" },
  { headers: { Authorization: `Bearer ${await token(c)}`, "X-Reference-Id": ref, "X-Target-Environment": c.env, "X-Callback-Url": `${baseUrl()}/api/momo/callback?ref=${ref}&sig=${sig(ref)}`,
      "Ocp-Apim-Subscription-Key": c.sub, "Content-Type": "application/json" }, timeout: 20000, validateStatus: () => true });
}
async function collectionStatus(c, ref) {
  const r = await axios.get(`${c.base}/collection/v1_0/requesttopay/${ref}`, {
    headers: { Authorization: `Bearer ${await token(c)}`, "X-Target-Environment": c.env, "Ocp-Apim-Subscription-Key": c.sub }, timeout: 20000 });
  return r.data || {};
}

// Crédit atomique d'un dépôt MoMo en attente : un seul passage possible.
const creditPending = (ref) => sql()`
  WITH t AS (SELECT id, wallet_id, amount FROM transactions WHERE provider_ref = ${ref} AND provider = 'momo' AND type = 'deposit' AND status = 'pending' FOR UPDATE),
  w AS (UPDATE wallets SET balance = balance + t.amount, updated_at = now() FROM t WHERE wallets.id = t.wallet_id RETURNING wallets.balance, t.id AS tx_id),
  u AS (UPDATE transactions SET status = 'completed', balance_after = w.balance FROM w WHERE transactions.id = w.tx_id AND transactions.status = 'pending' RETURNING transactions.id)
  SELECT w.balance FROM w`;

// Interroge MTN pour UN dépôt et le règle. Retourne { status: completed | failed | pending | unknown }.
async function settle(ref) {
  const c = cfg(), q = sql();
  const t = await q`SELECT t.amount::float AS amount, t.status, t.metadata, w.user_id, (now() - t.created_at) > interval '30 minutes' AS old
    FROM transactions t JOIN wallets w ON w.id = t.wallet_id WHERE t.provider = 'momo' AND t.type = 'deposit' AND t.provider_ref = ${ref}`;
  if (!t.length) return { status: "unknown" };
  if (t[0].status !== "pending") return { status: t[0].status };
  if (!ready(c)) return { status: "pending" };
  let d;
  try { d = await collectionStatus(c, ref); }
  catch (e) {
    if (e.response && e.response.status === 404 && t[0].old) { // MTN ne connaît pas la demande depuis plus de 30 min : elle n'a jamais abouti
      await q`UPDATE transactions SET status = 'failed' WHERE provider_ref = ${ref} AND provider = 'momo' AND status = 'pending'`;
      return { status: "failed" };
    }
    return { status: "pending" };
  }
  const st = String(d.status || "").toUpperCase();
  if (st === "SUCCESSFUL") {
    if ((d.currency && String(d.currency) !== c.currency) || Number(d.amount) + 0.0001 < t[0].amount) {
      await q`UPDATE transactions SET metadata = coalesce(metadata,'{}'::jsonb) || ${JSON.stringify({ momoMismatch: { amount: d.amount, currency: d.currency } })}::jsonb WHERE provider_ref = ${ref} AND provider = 'momo'`;
      console.error("MOMO_MISMATCH", ref, d.amount, d.currency);
      return { status: "pending", alert: true };
    }
    const r = await creditPending(ref);
    if (r.length && t[0].metadata && t[0].metadata.target === "float") {
      let res = { ok: false };
      try { res = await require("./omnicash").floatLoad(t[0].user_id, t[0].amount); } catch (e) { console.error("MOMO_FLOAT", e.message); }
      await q`UPDATE transactions SET metadata = coalesce(metadata,'{}'::jsonb) || ${JSON.stringify({ floatLoad: res.ok ? "done" : "refused" })}::jsonb WHERE provider_ref = ${ref} AND provider = 'momo'`;
    }
    return { status: "completed" };
  }
  if (st === "FAILED") {
    await q`UPDATE transactions SET status = 'failed', metadata = coalesce(metadata,'{}'::jsonb) || ${JSON.stringify({ momoReason: String(d.reason || "").slice(0, 80) })}::jsonb WHERE provider_ref = ${ref} AND provider = 'momo' AND status = 'pending'`;
    return { status: "failed" };
  }
  return { status: "pending" };
}

// ---------------- Client ----------------
router.get("/status", requireAuth, (req, res) => res.json({ enabled: ready(cfg()), min: MIN(), max: MAX() }));

router.post("/deposit", requireAuth, async (req, res) => {
  try {
    const c = cfg();
    if (!ready(c)) return res.status(503).json({ error: "Dépôt MTN MoMo indisponible pour le moment." });
    const amount = Math.floor(Number(req.body?.amount));
    if (!Number.isFinite(amount) || amount < MIN() || amount > MAX()) return res.status(400).json({ error: `Montant entre ${MIN()} et ${MAX()} FCFA.` });
    const digits = String(req.body?.phone || "").replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) return res.status(400).json({ error: "Numéro MTN invalide." });
    const target = req.body?.target === "float" ? "float" : "wallet";
    const q = sql();
    if (target === "float") {
      let a = [];
      try { a = await q`SELECT status FROM omnicash_agents WHERE user_id = ${req.user.userId}::uuid`; } catch (_) { a = []; }
      if (!a.length || a[0].status !== "active") return res.status(403).json({ error: "Compte agent OMNICASH non actif." });
    }
    const w = await q`SELECT id, balance FROM wallets WHERE user_id = ${req.user.userId}::uuid`;
    if (!w.length) return res.status(404).json({ error: "Wallet introuvable." });
    const recent = await q`SELECT count(*)::int AS n FROM transactions WHERE wallet_id = ${w[0].id} AND provider = 'momo' AND status = 'pending' AND created_at > now() - interval '15 minutes'`;
    if (recent[0].n >= 3) return res.status(429).json({ error: "Plusieurs demandes sont déjà en attente. Validez-les sur votre téléphone ou patientez quelques minutes." });
    const ref = crypto.randomUUID();
    await q`INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key, metadata)
            VALUES (${w[0].id}, 'deposit', ${amount}, ${w[0].balance}, 'pending', 'momo', ${ref}, ${"momo-" + ref}, ${JSON.stringify({ phone: intl(digits), target })}::jsonb)`;
    let r;
    try { r = await requestToPay(c, ref, amount, digits); }
    catch (e) { return res.status(202).json({ reference: ref, status: "pending", message: "Demande envoyée. Validez le paiement sur votre téléphone MTN." }); } // incertain : le suivi automatique tranchera
    if (r.status === 202) return res.status(201).json({ reference: ref, status: "pending", message: "Validez le paiement sur votre téléphone MTN (code secret MoMo)." });
    if (r.status >= 400 && r.status < 500) {
      await q`UPDATE transactions SET status = 'failed' WHERE provider_ref = ${ref} AND provider = 'momo' AND status = 'pending'`;
      console.error("MOMO_RTP", r.status, JSON.stringify(r.data).slice(0, 200));
      return res.status(400).json({ error: "MTN a refusé la demande (numéro MTN valide ? solde ?)." });
    }
    res.status(202).json({ reference: ref, status: "pending", message: "Demande en cours. Votre solde sera crédité dès la confirmation de MTN." });
  } catch (e) { console.error("MOMO_DEPOSIT", e.response?.data || e.message); res.status(500).json({ error: "Impossible de lancer le dépôt MTN." }); }
});

router.get("/deposit/:ref", requireAuth, async (req, res) => {
  try {
    if (!UUID.test(req.params.ref)) return res.status(400).json({ error: "Référence invalide." });
    const own = await sql()`SELECT 1 FROM transactions t JOIN wallets w ON w.id = t.wallet_id WHERE t.provider = 'momo' AND t.provider_ref = ${req.params.ref} AND w.user_id = ${req.user.userId}::uuid`;
    if (!own.length) return res.status(404).json({ error: "Dépôt introuvable." });
    res.json(await settle(req.params.ref));
  } catch (e) { console.error("MOMO_POLL", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

// Callback MTN : sert uniquement à déclencher la vérification (le statut réel est relu chez MTN).
const callback = async (req, res) => {
  try {
    const ref = String(req.query.ref || "");
    if (!UUID.test(ref) || String(req.query.sig || "") !== sig(ref)) return res.status(403).json({ error: "Signature invalide." });
    await settle(ref);
    res.json({ message: "OK" });
  } catch (e) { console.error("MOMO_CB", e.message); res.status(500).json({ error: "Erreur serveur." }); }
};
router.put("/callback", callback);
router.post("/callback", callback);

// ---------------- Suivi automatique ----------------
async function tick() {
  const q = sql(), out = { deposits: 0, depositsCredited: 0, withdrawals: 0, withdrawalsClosed: 0, refunded: 0 };
  if (ready(cfg())) {
    const pend = await q`SELECT provider_ref FROM transactions WHERE provider = 'momo' AND type = 'deposit' AND status = 'pending' AND created_at > now() - interval '3 days' ORDER BY created_at LIMIT 40`;
    for (const p of pend) { out.deposits++; try { if ((await settle(p.provider_ref)).status === "completed") out.depositsCredited++; } catch (e) { console.error("MOMO_TICK_DEP", e.message); } }
  }
  const po = require("../providers/payoutRouter.js");
  const disbursementConfigured =
    typeof po.momoConfigured === "function" &&
    po.momoConfigured();

  if (disbursementConfigured) {
    const wd = await q`SELECT id FROM transactions WHERE type = 'withdrawal' AND status = 'processing' AND metadata->'payout'->>'route' = 'momo' AND metadata->'payout'->>'result' = 'sent' ORDER BY created_at LIMIT 40`;
    for (const w of wd) {
      out.withdrawals++;
      try {
        const st = await po.momoStatus(w.id);
        if (st === "pending") continue;
        const u = await q`UPDATE transactions SET status = ${st} WHERE id = ${w.id}::uuid AND type = 'withdrawal' AND status = 'processing' RETURNING id`;
        if (!u.length) continue;
        out.withdrawalsClosed++;
        if (st === "failed" && on("MOMO_AUTO_REFUND")) {
          try { const r = await require("./walletOps").refundOne(w.id, true, "MTN MoMo : transfert échoué (remboursement automatique)"); if (r.length) out.refunded++; } catch (e) { console.error("MOMO_AUTOREFUND", e.message); }
        }
      } catch (e) { /* MTN injoignable : on réessaie à la minute suivante */ }
    }
  }
  return out;
}
let timer = null;
function startScheduler() {
  if (timer) return;
  timer = setInterval(() => { tick().catch((e) => console.error("MOMO_TICK", e.message)); }, 60000);
  if (timer.unref) timer.unref();
  console.log("[MOMO] suivi automatique actif (toutes les 60 s)");
}

// ---------------- Admin (OMNICHECK) ----------------
router.get("/admin/status", adminOnly, async (req, res) => {
  try {
    const c = cfg(), po = require("../providers/payoutRouter.js"), q = sql();
    let coll = { configured: ready(c), ok: false };
    if (coll.configured) { try { await token(c); coll.ok = true; } catch (e) { coll.error = "HTTP " + (e.response?.status || e.message); } }
    const dis =
      typeof po.momoPing === "function"
        ? await po.momoPing()
        : { configured: false, ok: false, detail: "Contrôle MTN Disbursement indisponible." };
    const n = (await q`SELECT
      (SELECT count(*) FROM transactions WHERE provider = 'momo' AND type = 'deposit' AND status = 'pending')::int AS pending_deposits,
      (SELECT count(*) FROM transactions WHERE type = 'withdrawal' AND status = 'processing' AND metadata->'payout'->>'route' = 'momo')::int AS processing_withdrawals,
      coalesce((SELECT sum(amount) FROM transactions WHERE provider = 'momo' AND type = 'deposit' AND status = 'completed' AND created_at > now() - interval '24 hours'), 0)::float AS deposits24`)[0];
    res.json({ env: c.env, currency: c.currency, collection: coll, disbursement: dis, routeMtn: po.routeFor("mtn"), autoPayout: on("AUTO_PAYOUT"), autoRefund: on("MOMO_AUTO_REFUND"), ...n });
  } catch (e) { console.error("MOMO_ASTATUS", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});
router.post("/admin/run", adminOnly, async (req, res) => {
  try { res.json(await tick()); } catch (e) { console.error("MOMO_RUN", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.startScheduler = startScheduler;
router.tick = tick;
module.exports = router;
