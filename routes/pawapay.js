"use strict";
// OMNIPAY — PAWAPAY (Mobile Money Bénin : MTN_MOMO_BEN et MOOV_BEN, en XOF, montants entiers).
//   Client : POST /api/pawapay/deposit {amount, phone, provider:'mtn'|'moov'} -> demande de paiement sur le téléphone du client (PIN).
//            GET  /api/pawapay/deposit/:ref -> relit le statut chez PawaPay et règle le dépôt.
//   PawaPay -> nous : POST /api/pawapay/callback/{deposits|payouts|refunds|checkouts}. Un callback ne crédite JAMAIS à lui seul :
//            il sert à déclencher une relecture du statut directement chez PawaPay (appel authentifié), puis le règlement atomique.
//   Admin : GET /api/pawapay/admin/status (test du jeton, sans rien envoyer) · POST /api/pawapay/admin/run (suivi immédiat).
// Variables Render : PAWAPAY_API_TOKEN · PAWAPAY_ENV (sandbox | live, défaut sandbox) · facultatif : PAWAPAY_BASE_URL, PAWAPAY_MIN_XOF (100),
//   PAWAPAY_MAX_XOF (500000), PAWAPAY_AUTO_REFUND (off). Retraits : PAYOUT_ROUTE_MTN=pawapay / PAYOUT_ROUTE_MOOV=pawapay (voir providers/payoutRouter.js).
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");
const pw = require("../providers/pawapay.js");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." }));
const num = (n, d) => { const v = Number(process.env[n]); return Number.isFinite(v) && v > 0 ? v : d; };
const on = (n) => ["on", "true", "1", "yes"].includes(String(process.env[n] || "off").toLowerCase());
const MIN = () => num("PAWAPAY_MIN_XOF", 100);
const MAX = () => num("PAWAPAY_MAX_XOF", 500000);
const phoneOk = (d) => /^229\d{8,10}$/.test(d);

router.get("/status", requireAuth, (req, res) => res.json({ enabled: pw.ready(), env: pw.env(), providers: ["mtn", "moov"], min: MIN(), max: MAX() }));

// Crédit atomique d'un dépôt PawaPay en attente : un seul passage possible.
const creditPending = (ref) => sql()`
  WITH t AS (SELECT id, wallet_id, amount FROM transactions WHERE provider_ref = ${ref} AND provider = 'pawapay' AND type = 'deposit' AND status = 'pending' FOR UPDATE),
  w AS (UPDATE wallets SET balance = balance + t.amount, updated_at = now() FROM t WHERE wallets.id = t.wallet_id RETURNING wallets.balance, t.id AS tx_id),
  u AS (UPDATE transactions SET status = 'completed', balance_after = w.balance FROM w WHERE transactions.id = w.tx_id AND transactions.status = 'pending' RETURNING transactions.id)
  SELECT w.balance FROM w`;

// Règle UN dépôt : relit PawaPay (jamais le contenu d'un callback) puis crédite ou échoue. -> { status: completed | failed | pending | unknown }
async function settleDeposit(ref) {
  const q = sql();
  const t = await q`SELECT t.amount::float AS amount, t.status, t.metadata, (now() - t.created_at) > interval '30 minutes' AS old
    FROM transactions t WHERE t.provider = 'pawapay' AND t.type = 'deposit' AND t.provider_ref = ${ref}`;
  if (!t.length) return { status: "unknown" };
  if (t[0].status !== "pending") return { status: t[0].status };
  if (!pw.ready()) return { status: "pending" };
  let d;
  try { d = await pw.depositStatus(ref); } catch (e) { return { status: "pending" }; }
  if (d.found === false) {
    if (t[0].old) { await q`UPDATE transactions SET status = 'failed', metadata = coalesce(metadata,'{}'::jsonb) || ${JSON.stringify({ pawapayReason: "NOT_FOUND" })}::jsonb WHERE provider_ref = ${ref} AND provider = 'pawapay' AND status = 'pending'`; return { status: "failed" }; }
    return { status: "pending" };
  }
  if (d.status === "COMPLETED") {
    // Contrôle : montant et devise doivent correspondre à la demande (sinon on ne crédite pas et on alerte).
    const amt = Number(d.amount);
    if ((d.currency && String(d.currency).toUpperCase() !== "XOF") || !Number.isFinite(amt) || amt + 0.0001 < t[0].amount) {
      await q`UPDATE transactions SET metadata = coalesce(metadata,'{}'::jsonb) || ${JSON.stringify({ pawapayMismatch: { amount: d.amount, currency: d.currency } })}::jsonb WHERE provider_ref = ${ref} AND provider = 'pawapay'`;
      console.error("PAWAPAY_MISMATCH", ref, d.amount, d.currency);
      return { status: "pending", alert: true };
    }
    await creditPending(ref);
    return { status: "completed" };
  }
  if (d.status === "FAILED" || d.status === "REJECTED") {
    await q`UPDATE transactions SET status = 'failed', metadata = coalesce(metadata,'{}'::jsonb) || ${JSON.stringify({ pawapayReason: String(d.failureCode || "FAILED").slice(0, 60) })}::jsonb WHERE provider_ref = ${ref} AND provider = 'pawapay' AND status = 'pending'`;
    return { status: "failed" };
  }
  return { status: "pending" }; // PROCESSING, ACCEPTED, IN_RECONCILIATION… : on attend
}

router.post("/deposit", requireAuth, async (req, res) => {
  try {
    if (!pw.ready()) return res.status(503).json({ error: "Dépôt Mobile Money indisponible pour le moment." });
    const amount = Math.floor(Number(req.body?.amount));
    if (!Number.isFinite(amount) || amount < MIN() || amount > MAX()) return res.status(400).json({ error: `Montant entre ${MIN()} et ${MAX()} FCFA.` });
    const provider = pw.providerCode(req.body?.provider);
    if (!provider) return res.status(400).json({ error: "Choisissez MTN ou Moov." });
    const phone = pw.msisdn(req.body?.phone);
    if (!phoneOk(phone)) return res.status(400).json({ error: "Numéro invalide." });
    const q = sql();
    const w = await q`SELECT id, balance FROM wallets WHERE user_id = ${req.user.userId}::uuid`;
    if (!w.length) return res.status(404).json({ error: "Wallet introuvable." });
    const recent = await q`SELECT count(*)::int AS n FROM transactions WHERE wallet_id = ${w[0].id} AND provider = 'pawapay' AND status = 'pending' AND created_at > now() - interval '15 minutes'`;
    if (recent[0].n >= 3) return res.status(429).json({ error: "Plusieurs demandes sont déjà en attente. Validez-les sur votre téléphone ou patientez quelques minutes." });
    const ref = crypto.randomUUID();
    // La ligne est écrite AVANT l'appel : si la réponse se perd, le suivi retrouve la demande par son identifiant.
    await q`INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key, metadata)
            VALUES (${w[0].id}, 'deposit', ${amount}, ${w[0].balance}, 'pending', 'pawapay', ${ref}, ${"pawapay-" + ref}, ${JSON.stringify({ phone, provider })}::jsonb)`;
    const r = await pw.initiateDeposit({ depositId: ref, amount, phone, provider });
    if (r.status === "REJECTED") {
      await q`UPDATE transactions SET status = 'failed', metadata = coalesce(metadata,'{}'::jsonb) || ${JSON.stringify({ pawapayReason: String(r.failureCode || "REJECTED").slice(0, 60) })}::jsonb WHERE provider_ref = ${ref} AND provider = 'pawapay' AND status = 'pending'`;
      return res.status(400).json({ error: "La demande a été refusée par l'opérateur (numéro, montant ou service indisponible)." });
    }
    if (r.status === "ACCEPTED") return res.status(201).json({ reference: ref, status: "pending", message: "Validez le paiement sur votre téléphone (code secret Mobile Money)." });
    res.status(202).json({ reference: ref, status: "pending", message: "Demande en cours. Votre solde sera crédité dès la confirmation." }); // incertain : le suivi tranchera
  } catch (e) { console.error("PAWAPAY_DEPOSIT", e.message); res.status(500).json({ error: "Impossible de lancer le dépôt." }); }
});

router.get("/deposit/:ref", requireAuth, async (req, res) => {
  try {
    if (!UUID.test(req.params.ref)) return res.status(400).json({ error: "Référence invalide." });
    const own = await sql()`SELECT 1 FROM transactions t JOIN wallets w ON w.id = t.wallet_id WHERE t.provider = 'pawapay' AND t.provider_ref = ${req.params.ref} AND w.user_id = ${req.user.userId}::uuid`;
    if (!own.length) return res.status(404).json({ error: "Dépôt introuvable." });
    res.json(await settleDeposit(req.params.ref));
  } catch (e) { console.error("PAWAPAY_POLL", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

// ---- Callbacks : on répond toujours 200 vite ; le corps n'est qu'un déclencheur, le statut est relu chez PawaPay. ----
async function settlePayout(id) {
  const q = sql();
  const w = await q`SELECT id, status FROM transactions WHERE id = ${id}::uuid AND type = 'withdrawal' AND metadata->'payout'->>'route' = 'pawapay'`;
  if (!w.length || w[0].status !== "processing") return { status: w.length ? w[0].status : "unknown" };
  let d;
  try { d = await pw.payoutStatus(id); } catch (e) { return { status: "processing" }; }
  if (d.found === false) return { status: "processing" };
  if (d.status === "COMPLETED") {
    await q`UPDATE transactions SET status = 'completed' WHERE id = ${id}::uuid AND type = 'withdrawal' AND status = 'processing'`;
    return { status: "completed" };
  }
  if (d.status === "FAILED" || d.status === "REJECTED") {
    const u = await q`UPDATE transactions SET status = 'failed', metadata = coalesce(metadata,'{}'::jsonb) || ${JSON.stringify({ pawapayReason: String(d.failureCode || "FAILED").slice(0, 60) })}::jsonb WHERE id = ${id}::uuid AND type = 'withdrawal' AND status = 'processing' RETURNING id`;
    if (u.length && on("PAWAPAY_AUTO_REFUND")) { try { await require("./walletOps").refundOne(id, true, "Mobile Money : transfert échoué (remboursement automatique)"); } catch (e) { console.error("PAWAPAY_AUTOREFUND", e.message); } }
    return { status: "failed" };
  }
  return { status: "processing" };
}
router.post("/callback/:kind", async (req, res) => {
  res.status(200).json({ message: "OK" });
  try {
    const kind = String(req.params.kind || "");
    const id = String(req.body?.depositId || req.body?.payoutId || "");
    if (!UUID.test(id)) return;
    if (kind === "deposits") await settleDeposit(id);
    else if (kind === "payouts") await settlePayout(id);
  } catch (e) { console.error("PAWAPAY_CB", e.message); }
});

// ---- Suivi automatique (filet de sécurité si un callback est perdu) ----
async function tick() {
  const q = sql(), out = { deposits: 0, depositsCredited: 0, payouts: 0, payoutsClosed: 0 };
  if (!pw.ready()) return out;
  const dep = await q`SELECT provider_ref FROM transactions WHERE provider = 'pawapay' AND type = 'deposit' AND status = 'pending' AND created_at > now() - interval '3 days' ORDER BY created_at LIMIT 40`;
  for (const p of dep) { out.deposits++; try { if ((await settleDeposit(p.provider_ref)).status === "completed") out.depositsCredited++; } catch (e) { console.error("PAWAPAY_TICK_DEP", e.message); } }
  const wd = await q`SELECT id FROM transactions WHERE type = 'withdrawal' AND status = 'processing' AND metadata->'payout'->>'route' = 'pawapay' AND metadata->'payout'->>'result' = 'sent' ORDER BY created_at LIMIT 40`;
  for (const w of wd) { out.payouts++; try { const s = await settlePayout(w.id); if (s.status === "completed" || s.status === "failed") out.payoutsClosed++; } catch (e) { console.error("PAWAPAY_TICK_PAY", e.message); } }
  return out;
}
let timer = null;
function startScheduler() {
  if (timer || !pw.ready()) return;
  timer = setInterval(() => { tick().catch((e) => console.error("PAWAPAY_TICK", e.message)); }, 60000);
  if (timer.unref) timer.unref();
  console.log("[PAWAPAY] suivi automatique actif (toutes les 60 s)");
}
startScheduler();

router.get("/admin/status", adminOnly, async (req, res) => {
  try {
    const out = { configured: pw.ready(), env: pw.env(), tokenOk: false, benin: [] };
    if (out.configured) {
      try {
        const c = await pw.activeConf();
        out.tokenOk = true;
        const ben = (c.countries || []).find((x) => x.country === "BEN");
        out.benin = ((ben && ben.providers) || []).map((p) => ({ provider: p.provider, ops: Object.fromEntries(((p.currencies || [])[0] ? Object.entries((p.currencies[0].operationTypes) || {}) : []).map(([k, v]) => [k, v.status])) }));
      } catch (e) { out.error = "HTTP " + ((e.response && e.response.status) || e.message); }
    }
    const n = (await sql()`SELECT (SELECT count(*) FROM transactions WHERE provider = 'pawapay' AND type = 'deposit' AND status = 'pending')::int AS pending_deposits,
      (SELECT count(*) FROM transactions WHERE type = 'withdrawal' AND status = 'processing' AND metadata->'payout'->>'route' = 'pawapay')::int AS processing_withdrawals`)[0];
    res.json({ ...out, ...n });
  } catch (e) { console.error("PAWAPAY_ASTATUS", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});
router.post("/admin/run", adminOnly, async (req, res) => {
  try { res.json(await tick()); } catch (e) { console.error("PAWAPAY_RUN", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;
module.exports._settleDeposit = settleDeposit;
