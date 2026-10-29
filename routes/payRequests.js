"use strict";
// OMNIPAY — demandes de paiement par jeton (QR / lien) : à usage unique avec expiration, ou réutilisables (QR de commerçant).
// AJOUT SEUL : ne modifie aucun solde existant. Le paiement est UN SEUL ordre SQL (débit payeur + crédit receveur + écritures) ou rien.
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const COMMISSION = 50, MIN = 100;
const MAX = () => Number(process.env.PAY_MAX_XOF || 1000000);
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newToken = () => Array.from(crypto.randomBytes(10), (b) => ALPHA[b % ALPHA.length]).join("");
const TOKEN_RE = /^[A-HJ-NP-Z2-9]{10}$/;
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);
const maskName = (f, l) => [f ? String(f).slice(0, 1).toUpperCase() + "***" : "", l ? String(l).slice(0, 1).toUpperCase() + "." : ""].filter(Boolean).join(" ") || "Client OMNIPAY";
const refOf = (txId) => "OMP-R" + String(txId).replace(/-/g, "").slice(0, 10).toUpperCase();
let ready = null;
function ensure() {
  if (!ready) ready = sql()`CREATE TABLE IF NOT EXISTS pay_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token varchar(10) NOT NULL UNIQUE, owner_id uuid NOT NULL,
    amount integer, note varchar(60), status varchar(12) NOT NULL DEFAULT 'open', expires_at timestamptz,
    paid_by uuid, paid_at timestamptz, pay_count integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now())`
    .catch((e) => { ready = null; throw e; });
  return ready;
}

// Créer une demande. amount absent = QR réutilisable (le payeur saisit le montant). hours : durée de validité (1 à 168, défaut 24 ; 0 = sans expiration pour un QR réutilisable).
router.post("/request", requireAuth, async (req, res) => {
  try {
    await ensure();
    const raw = req.body?.amount;
    const amount = raw == null || raw === "" ? null : Math.floor(Number(raw));
    if (amount !== null && (!Number.isFinite(amount) || amount < MIN || amount > MAX())) return res.status(400).json({ error: `Montant entre ${MIN} et ${MAX()} FCFA.` });
    const h = req.body?.hours === 0 && amount === null ? 0 : Math.min(168, Math.max(1, Math.floor(Number(req.body?.hours)) || 24));
    const note = clean(req.body?.note, 60) || null;
    const q = sql();
    const open = (await q`SELECT count(*)::int AS n FROM pay_requests WHERE owner_id = ${req.user.userId}::uuid AND status = 'open' AND (expires_at IS NULL OR expires_at > now())`)[0].n;
    if (open >= 30) return res.status(429).json({ error: "Trop de demandes ouvertes (30). Annulez-en avant d'en créer." });
    for (let i = 0; i < 5; i++) {
      const token = newToken();
      const r = await q`INSERT INTO pay_requests (token, owner_id, amount, note, expires_at)
        VALUES (${token}, ${req.user.userId}::uuid, ${amount}, ${note}, ${h ? new Date(Date.now() + h * 3600e3).toISOString() : null}::timestamptz)
        ON CONFLICT DO NOTHING RETURNING token, expires_at`;
      if (r.length) return res.json({ token: r[0].token, amount, note, expiresAt: r[0].expires_at, reusable: amount === null, link: `${(process.env.PUBLIC_BASE_URL || "https://www.omnipay-bj.com").replace(/\/$/, "")}/?pay=${r[0].token}` });
    }
    res.status(500).json({ error: "Erreur serveur." });
  } catch (e) { console.error("PAY_REQUEST", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.get("/mine", requireAuth, async (req, res) => {
  try {
    await ensure();
    const rows = await sql()`SELECT token, amount, note, status, expires_at, paid_at, pay_count,
      (status = 'open' AND expires_at IS NOT NULL AND expires_at <= now()) AS expired FROM pay_requests WHERE owner_id = ${req.user.userId}::uuid ORDER BY created_at DESC LIMIT 30`;
    res.json({ requests: rows });
  } catch (e) { console.error("PAY_MINE", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/:token/cancel", requireAuth, async (req, res) => {
  try {
    await ensure();
    const r = await sql()`UPDATE pay_requests SET status = 'cancelled' WHERE token = ${String(req.params.token).toUpperCase()} AND owner_id = ${req.user.userId}::uuid AND status = 'open' RETURNING token`;
    if (!r.length) return res.status(409).json({ error: "Demande introuvable ou déjà clôturée." });
    res.json({ message: "Demande annulée." });
  } catch (e) { console.error("PAY_CANCEL", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

// Aperçu public (sans connexion) : le payeur voit QUI il paie (nom masqué) et combien avant de se connecter.
router.get("/:token", async (req, res) => {
  try {
    await ensure();
    const t = String(req.params.token || "").toUpperCase();
    if (!TOKEN_RE.test(t)) return res.status(400).json({ error: "Lien de paiement invalide." });
    const r = await sql()`SELECT p.amount, p.note, p.status, p.expires_at, u.first_name, u.last_name FROM pay_requests p JOIN users u ON u.id = p.owner_id WHERE p.token = ${t}`;
    if (!r.length) return res.status(404).json({ error: "Lien de paiement introuvable." });
    const x = r[0], expired = x.expires_at && new Date(x.expires_at) <= new Date();
    const state = x.status !== "open" ? x.status : expired ? "expired" : "open";
    res.json({ to: maskName(x.first_name, x.last_name), amount: x.amount, note: x.note, state, fee: COMMISSION });
  } catch (e) { console.error("PAY_VIEW", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/:token/pay", requireAuth, async (req, res) => {
  try {
    await ensure();
    const t = String(req.params.token || "").toUpperCase();
    if (!TOKEN_RE.test(t)) return res.status(400).json({ error: "Lien de paiement invalide." });
    const q = sql(), me = req.user.userId;
    const pr = await q`SELECT amount, owner_id, status, expires_at FROM pay_requests WHERE token = ${t}`;
    if (!pr.length) return res.status(404).json({ error: "Lien de paiement introuvable." });
    const p = pr[0];
    if (p.status !== "open" || (p.expires_at && new Date(p.expires_at) <= new Date())) return res.status(409).json({ error: "Cette demande est expirée ou déjà réglée." });
    if (p.owner_id === me) return res.status(400).json({ error: "Vous ne pouvez pas payer votre propre demande." });
    const amount = p.amount != null ? p.amount : Math.floor(Number(req.body?.amount));
    if (!Number.isFinite(amount) || amount < MIN || amount > MAX()) return res.status(400).json({ error: `Montant entre ${MIN} et ${MAX()} FCFA.` });
    const total = amount + COMMISSION, key = crypto.randomUUID();
    const meta = JSON.stringify({ note: p.note || "", payRequest: t });
    const rows = await q`
      WITH r AS (UPDATE pay_requests SET status = CASE WHEN amount IS NULL THEN status ELSE 'paid' END, paid_by = ${me}::uuid, paid_at = now(), pay_count = pay_count + 1
                 WHERE token = ${t} AND status = 'open' AND (expires_at IS NULL OR expires_at > now()) AND owner_id <> ${me}::uuid
                   AND EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = pay_requests.owner_id)
                   AND EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = ${me}::uuid AND w.balance >= ${total}) RETURNING owner_id),
      s AS (UPDATE wallets SET balance = balance - ${total}, updated_at = now() WHERE user_id = ${me}::uuid AND balance >= ${total} AND EXISTS (SELECT 1 FROM r) RETURNING id, balance),
      d AS (UPDATE wallets SET balance = balance + ${amount}, updated_at = now() FROM r WHERE wallets.user_id = r.owner_id AND EXISTS (SELECT 1 FROM s) RETURNING wallets.id, wallets.balance, r.owner_id),
      o AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, idempotency_key, counterparty_user_id, metadata)
            SELECT s.id, 'transfer_out', ${amount}, s.balance, 'completed', 'internal', ${key + "-out"}, d.owner_id, ${meta}::jsonb FROM s, d RETURNING id),
      i AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, idempotency_key, counterparty_user_id, metadata)
            SELECT d.id, 'transfer_in', ${amount}, d.balance, 'completed', 'internal', ${key + "-in"}, ${me}::uuid, ${meta}::jsonb FROM d RETURNING id),
      c AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, idempotency_key)
            SELECT s.id, 'commission', ${COMMISSION}, s.balance, 'completed', 'internal', ${key + "-fee"} FROM s, d RETURNING id)
      SELECT s.balance, o.id AS tx_id FROM s, d, o`;
    if (!rows.length) {
      const w = await q`SELECT balance FROM wallets WHERE user_id = ${me}::uuid`;
      if (w.length && Number(w[0].balance) < total) return res.status(400).json({ error: `Solde insuffisant (montant + ${COMMISSION} FCFA de commission).` });
      return res.status(409).json({ error: "Cette demande vient d'être réglée ou n'est plus valable." });
    }
    res.json({ message: "Paiement effectué.", newBalance: Number(rows[0].balance).toFixed(2), receiptRef: refOf(rows[0].tx_id) });
  } catch (e) { console.error("PAY_PAY", e.message); res.status(500).json({ error: "Erreur serveur lors du paiement." }); }
});

module.exports = router;
