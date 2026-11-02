"use strict";
// OMNIPAY — Recharges & forfaits (crédit d'appel, forfait internet, appel, autres) : FICHIER AJOUTÉ.
// Principe : le client commande, son solde est débité tout de suite (réservation), OMNIPAY exécute la recharge
// auprès de l'opérateur (manuellement ou via un fournisseur plus tard), puis marque « fait ». Refus = remboursement.
// Aucun crédit/débit sans ligne d'historique, tout est atomique. BUNDLES_ENABLED=off coupe le service.
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const MIN = 200;
const MAX = Number(process.env.BUNDLE_MAX_XOF || 50000);
const MAX_OPEN = 5;
const KINDS = { airtime: "Crédit d'appel", data: "Forfait internet", voice: "Forfait appel", combo: "Forfait internet + appel", other: "Autre" };
const OPS = ["mtn", "moov", "celtiis"];
let ready = false;

async function ensureTables() {
  if (ready) return;
  await sql()`CREATE TABLE IF NOT EXISTS bundle_orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, kind varchar(12) NOT NULL,
    operator varchar(12) NOT NULL, phone varchar(20) NOT NULL, amount_xof numeric(18,2) NOT NULL,
    note varchar(200), status varchar(12) NOT NULL DEFAULT 'pending', decided_note varchar(300), ref varchar(160),
    created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz)`;
  ready = true;
}
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);
const enabled = () => String(process.env.BUNDLES_ENABLED || "on").toLowerCase() !== "off";
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." }));

router.get("/info", requireAuth, (req, res) => res.json({ enabled: enabled(), min: MIN, max: MAX, kinds: KINDS, operators: OPS, openMax: MAX_OPEN }));

router.post("/order", requireAuth, async (req, res) => {
  try {
    if (!enabled()) return res.status(503).json({ error: "Service momentanément indisponible." });
    const kind = clean(req.body?.kind, 12), operator = clean(req.body?.operator, 12).toLowerCase();
    const phone = clean(req.body?.phone, 20).replace(/[\s.\-()]/g, "");
    const amount = Math.round(Number(req.body?.amount));
    const note = clean(req.body?.note, 200) || null;
    if (!KINDS[kind]) return res.status(400).json({ error: "Type de recharge invalide." });
    if (!OPS.includes(operator)) return res.status(400).json({ error: "Opérateur invalide (MTN, Moov ou Celtiis)." });
    if (!/^\+?\d{8,13}$/.test(phone)) return res.status(400).json({ error: "Numéro à recharger invalide." });
    if (!Number.isFinite(amount) || amount < MIN || amount > MAX) return res.status(400).json({ error: `Montant : entre ${MIN} et ${MAX} FCFA.` });
    await ensureTables();
    const q = sql();
    const [open] = await q`SELECT count(*)::int AS n FROM bundle_orders WHERE user_id = ${req.user.userId} AND status = 'pending'`;
    if (open.n >= MAX_OPEN) return res.status(429).json({ error: "Vous avez déjà des recharges en attente. Patientez leur exécution." });
    const key = "bn-" + crypto.randomUUID();
    const rows = await q`
      WITH w AS (UPDATE wallets SET balance = balance - ${amount} WHERE user_id = ${req.user.userId} AND balance >= ${amount} RETURNING id, balance),
      o AS (INSERT INTO bundle_orders (user_id, kind, operator, phone, amount_xof, note)
            SELECT ${req.user.userId}, ${kind}, ${operator}, ${phone}, ${amount}, ${note} FROM w RETURNING id),
      t AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key)
            SELECT w.id, 'withdrawal', ${amount}, w.balance, 'pending', 'bundle', o.id::text, ${key} FROM w, o RETURNING id)
      SELECT o.id, w.balance FROM o, w`;
    if (!rows.length) return res.status(400).json({ error: "Solde insuffisant." });
    res.status(201).json({ id: rows[0].id, newBalance: Number(rows[0].balance), message: "Commande enregistrée. Votre numéro sera rechargé après exécution par OMNIPAY." });
  } catch (e) { console.error("BUNDLE_ORDER", e.message); res.status(500).json({ error: "Impossible d'enregistrer la commande." }); }
});

router.get("/mine", requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const rows = await sql()`SELECT id, kind, operator, phone, amount_xof::float AS amount, note, status, decided_note, created_at FROM bundle_orders WHERE user_id = ${req.user.userId} ORDER BY created_at DESC LIMIT 20`;
    res.json({ orders: rows.map((r) => ({ ...r, kindLabel: KINDS[r.kind] || r.kind })) });
  } catch (e) { console.error("BUNDLE_MINE", e.message); res.status(500).json({ error: "Erreur." }); }
});

// ---------- Administrateur ----------
router.get("/admin/pending", adminOnly, async (req, res) => {
  try {
    await ensureTables();
    const rows = await sql()`SELECT b.id, b.kind, b.operator, b.phone, b.amount_xof::float AS amount, b.note, b.created_at, u.first_name, u.last_name
      FROM bundle_orders b LEFT JOIN users u ON u.id = b.user_id WHERE b.status = 'pending' ORDER BY b.created_at ASC LIMIT 100`;
    res.json({ orders: rows.map((r) => ({ ...r, kindLabel: KINDS[r.kind] || r.kind })) });
  } catch (e) { console.error("BUNDLE_PENDING", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.post("/admin/:id/done", adminOnly, async (req, res) => {
  try {
    await ensureTables();
    const ref = clean(req.body?.ref, 160) || null;
    const rows = await sql()`
      WITH o AS (UPDATE bundle_orders SET status = 'done', decided_at = now(), ref = ${ref}
                 WHERE id = ${req.params.id}::uuid AND status = 'pending' RETURNING id),
      t AS (UPDATE transactions SET status = 'completed' WHERE provider = 'bundle' AND provider_ref = ${req.params.id} AND EXISTS (SELECT 1 FROM o) RETURNING id)
      SELECT id FROM o`;
    if (!rows.length) return res.status(409).json({ error: "Commande introuvable ou déjà traitée." });
    res.json({ message: "Recharge marquée comme faite." });
  } catch (e) { console.error("BUNDLE_DONE", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.post("/admin/:id/reject", adminOnly, async (req, res) => {
  try {
    await ensureTables();
    const rows = await sql()`
      WITH o AS (UPDATE bundle_orders SET status = 'rejected', decided_at = now(), decided_note = ${clean(req.body?.note, 300) || null}
                 WHERE id = ${req.params.id}::uuid AND status = 'pending' RETURNING user_id, amount_xof),
      w AS (UPDATE wallets SET balance = balance + o.amount_xof FROM o WHERE wallets.user_id = o.user_id RETURNING wallets.balance),
      t AS (UPDATE transactions SET status = 'failed' WHERE provider = 'bundle' AND provider_ref = ${req.params.id} AND EXISTS (SELECT 1 FROM o) RETURNING id)
      SELECT balance FROM w`;
    if (!rows.length) return res.status(409).json({ error: "Commande introuvable ou déjà traitée." });
    res.json({ message: "Refusée et remboursée." });
  } catch (e) { console.error("BUNDLE_REJECT", e.message); res.status(500).json({ error: "Erreur." }); }
});

module.exports = router;
