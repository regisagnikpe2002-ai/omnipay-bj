"use strict";
// OMNIPAY — dépôts / retraits MANUELS validés par l'administrateur (fichier AJOUTÉ).
// Principe : le client voit les comptes de réception d'OMNIPAY + sa référence personnelle (OMP-XXXXXXXX),
// déclare son paiement ; l'administrateur vérifie la réception réelle, puis crédite / marque payé.
// Aucune clé privée n'est jamais stockée ici. Aucun crédit automatique.
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const COMMISSION = 50;
const MIN = 500;
const MAX = Number(process.env.MANUAL_MAX_XOF || 500000);
const MAX_OPEN = 3;
let ready = false;

async function ensureTables() {
  if (ready) return;
  const q = sql();
  await q`CREATE TABLE IF NOT EXISTS manual_deposits (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, reference varchar(20) NOT NULL,
    method varchar(30) NOT NULL, currency varchar(10) NOT NULL, declared_amount numeric(18,2) NOT NULL,
    tx_ref varchar(200), note varchar(500), status varchar(12) NOT NULL DEFAULT 'pending',
    credited_xof numeric(18,2), decided_note varchar(300),
    created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz)`;
  await q`CREATE TABLE IF NOT EXISTS manual_payouts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, reference varchar(20) NOT NULL,
    method varchar(30) NOT NULL, destination varchar(200) NOT NULL, amount_xof numeric(18,2) NOT NULL,
    status varchar(12) NOT NULL DEFAULT 'pending', decided_note varchar(300),
    payment_channel varchar(20), payment_ref varchar(160), paid_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz)`;
  await q`ALTER TABLE manual_payouts ADD COLUMN IF NOT EXISTS payment_channel varchar(20)`;
  await q`ALTER TABLE manual_payouts ADD COLUMN IF NOT EXISTS payment_ref varchar(160)`;
  await q`ALTER TABLE manual_payouts ADD COLUMN IF NOT EXISTS paid_at timestamptz`;
  await q`CREATE UNIQUE INDEX IF NOT EXISTS manual_payouts_payment_ref_uniq ON manual_payouts (lower(payment_ref)) WHERE payment_ref IS NOT NULL`;
  ready = true;
}

const refOf = (userId) => "OMP-" + String(userId).replace(/-/g, "").slice(0, 8).toUpperCase();
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." }));

function accountsFromEnv() {
  try {
    const list = JSON.parse(process.env.OMNIPAY_PAYIN_ACCOUNTS || "[]");
    return (Array.isArray(list) ? list : []).slice(0, 20).map((a) => ({
      label: clean(a.label, 80), type: clean(a.type, 20), network: clean(a.network, 40),
      detail: clean(a.detail || a.address, 200),
    })).filter((a) => a.label && a.detail);
  } catch { return []; }
}

// ---------- Client ----------
router.get("/instructions", requireAuth, async (req, res) => {
  let omId = null;
  try { const r = await sql()`SELECT code FROM account_ids WHERE user_id = ${req.user.userId}`; omId = r[0]?.code || null; } catch (_) { /* table absente : repli sur OMP- */ }
  res.json({
    reference: omId || refOf(req.user.userId),
    omId,
    accounts: accountsFromEnv(),
    limits: { min: MIN, max: MAX, openRequests: MAX_OPEN },
    notice: "Indiquez toujours votre référence. Le crédit est effectué après vérification de la réception par OMNIPAY.",
  });
});

router.post("/deposit", requireAuth, async (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    const currency = clean(req.body?.currency || "XOF", 10).toUpperCase();
    const method = clean(req.body?.method || "autre", 30);
    if (!["XOF", "USDT", "EUR", "USD"].includes(currency)) return res.status(400).json({ error: "Devise non acceptée." });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "Montant invalide." });
    if (currency === "XOF" && (amount < MIN || amount > MAX)) return res.status(400).json({ error: `Montant : entre ${MIN} et ${MAX} FCFA.` });
    await ensureTables();
    const q = sql();
    const [open] = await q`SELECT count(*)::int AS n FROM manual_deposits WHERE user_id = ${req.user.userId} AND status = 'pending'`;
    if (open.n >= MAX_OPEN) return res.status(429).json({ error: "Vous avez déjà des demandes en attente. Patientez leur validation." });
    const [row] = await q`INSERT INTO manual_deposits (user_id, reference, method, currency, declared_amount, tx_ref, note)
      VALUES (${req.user.userId}, ${refOf(req.user.userId)}, ${method}, ${currency}, ${amount.toFixed(2)}, ${clean(req.body?.txRef, 200) || null}, ${clean(req.body?.note, 500) || null})
      RETURNING id`;
    res.status(201).json({ id: row.id, message: "Demande enregistrée. Elle sera créditée après vérification." });
  } catch (e) { console.error("MANUAL_DEPOSIT", e.message); res.status(500).json({ error: "Impossible d'enregistrer la demande." }); }
});

router.post("/payout", requireAuth, async (req, res) => {
  try {
    const amount = Math.round(Number(req.body?.amount));
    const destination = clean(req.body?.destination, 200);
    const method = clean(req.body?.method || "autre", 30);
    if (!Number.isFinite(amount) || amount < MIN || amount > MAX) return res.status(400).json({ error: `Montant : entre ${MIN} et ${MAX} FCFA.` });
    if (destination.length < 5) return res.status(400).json({ error: "Indiquez la destination (numéro Mobile Money, adresse ou compte)." });
    await ensureTables();
    const q = sql();
    const [open] = await q`SELECT count(*)::int AS n FROM manual_payouts WHERE user_id = ${req.user.userId} AND status = 'pending'`;
    if (open.n >= MAX_OPEN) return res.status(429).json({ error: "Vous avez déjà des retraits en attente." });
    const total = amount + COMMISSION;
    const key = "mp-" + crypto.randomUUID();
    // Débit immédiat (réservation) + demande + ligne d'historique, en UNE seule instruction atomique.
    const rows = await q`
      WITH w AS (UPDATE wallets SET balance = balance - ${total} WHERE user_id = ${req.user.userId} AND balance >= ${total} RETURNING id, balance),
      p AS (INSERT INTO manual_payouts (user_id, reference, method, destination, amount_xof)
            SELECT ${req.user.userId}, ${refOf(req.user.userId)}, ${method}, ${destination}, ${amount} FROM w RETURNING id),
      t AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key)
            SELECT w.id, 'withdrawal', ${amount}, w.balance, 'pending', 'manual', p.id::text, ${key} FROM w, p RETURNING id)
      SELECT p.id, w.balance FROM p, w`;
    if (!rows.length) return res.status(400).json({ error: `Solde insuffisant (montant + ${COMMISSION} FCFA de commission).` });
    res.status(201).json({ id: rows[0].id, newBalance: Number(rows[0].balance), message: "Demande de retrait enregistrée. Elle sera exécutée après validation." });
  } catch (e) { console.error("MANUAL_PAYOUT", e.message); res.status(500).json({ error: "Impossible d'enregistrer le retrait." }); }
});

router.get("/mine", requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const q = sql();
    const deposits = await q`SELECT id, method, currency, declared_amount::float AS amount, status, credited_xof::float AS credited_xof, decided_note, created_at FROM manual_deposits WHERE user_id = ${req.user.userId} ORDER BY created_at DESC LIMIT 20`;
    const payouts = await q`SELECT id, method, destination, amount_xof::float AS amount, status, decided_note, created_at FROM manual_payouts WHERE user_id = ${req.user.userId} ORDER BY created_at DESC LIMIT 20`;
    res.json({ deposits, payouts });
  } catch (e) { console.error("MANUAL_MINE", e.message); res.status(500).json({ error: "Erreur." }); }
});

// ---------- Administrateur (en-tête x-admin-key) ----------
router.get("/admin/pending", adminOnly, async (req, res) => {
  try {
    await ensureTables();
    const q = sql();
    const deposits = await q`SELECT d.id, d.reference, d.method, d.currency, d.declared_amount::float AS amount, d.tx_ref, d.note, d.created_at, u.email, u.phone
      FROM manual_deposits d LEFT JOIN users u ON u.id = d.user_id WHERE d.status = 'pending' ORDER BY d.created_at ASC LIMIT 100`;
    const payouts = await q`SELECT p.id, p.reference, p.method, p.destination, p.amount_xof::float AS amount, p.created_at, u.email, u.phone
      FROM manual_payouts p LEFT JOIN users u ON u.id = p.user_id WHERE p.status = 'pending' ORDER BY p.created_at ASC LIMIT 100`;
    res.json({ deposits, payouts });
  } catch (e) { console.error("MANUAL_PENDING", e.message); res.status(500).json({ error: "Erreur." }); }
});

// Créditer : un seul crédit possible (la condition status='pending' est dans l'instruction elle-même)
router.post("/admin/deposit/:id/credit", adminOnly, async (req, res) => {
  try {
    const amountXof = Math.round(Number(req.body?.amountXof));
    if (!Number.isFinite(amountXof) || amountXof <= 0 || amountXof > 5000000) return res.status(400).json({ error: "Montant FCFA à créditer invalide." });
    await ensureTables();
    const key = "md-" + req.params.id;
    const rows = await sql()`
      WITH m AS (UPDATE manual_deposits SET status = 'credited', credited_xof = ${amountXof}, decided_at = now(), decided_note = ${clean(req.body?.note, 300) || null}
                 WHERE id = ${req.params.id} AND status = 'pending'
                   AND NOT EXISTS (SELECT 1 FROM manual_deposits d2 WHERE d2.status = 'credited' AND d2.id <> manual_deposits.id
                                   AND coalesce(manual_deposits.tx_ref, '') <> '' AND lower(d2.tx_ref) = lower(manual_deposits.tx_ref))
                 RETURNING user_id),
      w AS (UPDATE wallets SET balance = balance + ${amountXof} FROM m WHERE wallets.user_id = m.user_id RETURNING wallets.id, wallets.balance),
      t AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key)
            SELECT w.id, 'deposit', ${amountXof}, w.balance, 'completed', 'manual', ${req.params.id}, ${key} FROM w RETURNING id)
      SELECT w.balance FROM w`;
    if (!rows.length) return res.status(409).json({ error: "Demande introuvable, déjà traitée, ou ce tx hash a déjà été crédité (anti-doublon)." });
    res.json({ message: "Crédité.", newBalance: Number(rows[0].balance) });
  } catch (e) { console.error("MANUAL_CREDIT", e.message); res.status(500).json({ error: "Erreur lors du crédit." }); }
});

router.post("/admin/deposit/:id/reject", adminOnly, async (req, res) => {
  try {
    await ensureTables();
    const rows = await sql()`UPDATE manual_deposits SET status = 'rejected', decided_at = now(), decided_note = ${clean(req.body?.note, 300) || null}
      WHERE id = ${req.params.id} AND status = 'pending' RETURNING id`;
    if (!rows.length) return res.status(409).json({ error: "Demande introuvable ou déjà traitée." });
    res.json({ message: "Rejetée." });
  } catch (e) { console.error("MANUAL_DREJECT", e.message); res.status(500).json({ error: "Erreur." }); }
});

// Retrait payé : la commission est enregistrée ici
router.post("/admin/payout/:id/paid", adminOnly, async (req, res) => {
  try {
    await ensureTables();
    const paymentRef = clean(req.body?.paymentRef, 160);
    const paymentChannel = clean(req.body?.channel || "pispi", 20).toLowerCase();
    const note = clean(req.body?.note, 300) || null;

    if (paymentRef.length < 6) {
      return res.status(400).json({ error: "Reference reelle requise: txId ou end2endId PI-SPI." });
    }

    const rows = await sql()`
      WITH p AS (
        UPDATE manual_payouts
        SET status = 'paid', decided_at = now(), paid_at = now(),
            decided_note = ${note}, payment_channel = ${paymentChannel}, payment_ref = ${paymentRef}
        WHERE id = ${req.params.id}::uuid AND status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM manual_payouts x
            WHERE x.id <> manual_payouts.id
              AND x.payment_ref IS NOT NULL
              AND lower(x.payment_ref) = lower(${paymentRef})
          )
        RETURNING user_id
      ),
      t AS (
        UPDATE transactions
        SET status = 'completed',
            metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
              'settlement', jsonb_build_object(
                'channel', ${paymentChannel},
                'reference', ${paymentRef},
                'confirmedAt', now()::text,
                'confirmedBy', 'admin'
              )
            )
        WHERE provider = 'manual'
          AND provider_ref = ${req.params.id}
          AND type = 'withdrawal'
          AND EXISTS (SELECT 1 FROM p)
        RETURNING wallet_id, balance_after
      ),
      c AS (
        INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, idempotency_key)
        SELECT wallet_id, 'commission', ${COMMISSION}, balance_after, 'completed', 'internal', ${"mpc-" + req.params.id}
        FROM t RETURNING id
      )
      SELECT id FROM c
    `;

    if (!rows.length) {
      return res.status(409).json({ error: "Demande deja traitee ou reference de paiement deja utilisee." });
    }

    res.json({ message: "Paiement reel confirme.", paymentRef, channel: paymentChannel });
  } catch (e) {
    if (e && e.code === '23505') {
      return res.status(409).json({ error: "Cette reference de paiement est deja utilisee." });
    }
    console.error("MANUAL_PAID", e.message);
    res.status(500).json({ error: "Erreur." });
  }
});

// Retrait refusé : remboursement du montant + commission réservés
router.post("/admin/payout/:id/reject", adminOnly, async (req, res) => {
  try {
    await ensureTables();
    const rows = await sql()`
      WITH p AS (UPDATE manual_payouts SET status = 'rejected', decided_at = now(), decided_note = ${clean(req.body?.note, 300) || null}
                 WHERE id = ${req.params.id} AND status = 'pending' RETURNING user_id, amount_xof),
      w AS (UPDATE wallets SET balance = balance + (p.amount_xof + ${COMMISSION}) FROM p WHERE wallets.user_id = p.user_id RETURNING wallets.balance),
      t AS (UPDATE transactions SET status = 'failed' WHERE provider = 'manual' AND provider_ref = ${req.params.id} AND type = 'withdrawal' AND EXISTS (SELECT 1 FROM p) RETURNING id)
      SELECT balance FROM w`;
    if (!rows.length) return res.status(409).json({ error: "Demande introuvable ou déjà traitée." });
    res.json({ message: "Rejeté et remboursé." });
  } catch (e) { console.error("MANUAL_PREJECT", e.message); res.status(500).json({ error: "Erreur." }); }
});

module.exports = router;
