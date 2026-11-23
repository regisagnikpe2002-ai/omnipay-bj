"use strict";
// OMNIPAY — CODES CASH (dépôt / retrait en espèces entre un client et un commerçant OMNIPRO), sous séquestre. FICHIER AJOUTÉ.
//   POST /api/termcode/create {amount, note}  débite MON solde et crée un code à 6 chiffres (valable TERMCODE_MINUTES, défaut 15)
//   POST /api/termcode/redeem {code}          un AUTRE client saisit le code : le montant est crédité sur SON solde, une seule fois
//   GET  /api/termcode/mine                   mes codes (le code n'est visible que par son créateur) et mes encaissements
//   POST /api/termcode/:id/cancel             j'annule mon code ouvert : remboursé tout de suite
// Retrait cash : le client crée le code, le donne au commerçant, qui le saisit dans son terminal puis remet les espèces.
// Dépôt cash   : le commerçant reçoit les espèces, crée le code, le client le saisit dans son application.
// Chaque mouvement est une seule instruction SQL atomique ; un code expiré est remboursé automatiquement à son créateur.
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const numEnv = (n, d) => { const v = Number(process.env[n]); return Number.isFinite(v) && v > 0 ? v : d; };
const MIN = () => numEnv("TERMCODE_MIN_XOF", 500), MAX = () => numEnv("TERMCODE_MAX_XOF", 200000), MINUTES = () => numEnv("TERMCODE_MINUTES", 15);
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);

let ready = null;
function ensure() {
  if (!ready) ready = (async () => {
    const q = sql();
    await q`CREATE TABLE IF NOT EXISTS termcodes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL, amount numeric NOT NULL, code varchar(6) NOT NULL, status varchar(10) NOT NULL DEFAULT 'open',
      redeemer_id uuid, note text, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, redeemed_at timestamptz)`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS termcodes_open_code ON termcodes (code) WHERE status = 'open'`;
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

// Remboursement atomique d'un code ouvert (annulation par le créateur ou expiration).
async function refund(id, status, ownerId) {
  const q = sql();
  const r = await q`WITH c AS (UPDATE termcodes SET status = ${status} WHERE id = ${id}::uuid AND status = 'open'
      AND (${status} = 'cancelled' OR expires_at <= now()) AND (${ownerId}::uuid IS NULL OR owner_id = ${ownerId}::uuid) RETURNING id, owner_id, amount),
    w AS (UPDATE wallets SET balance = balance + c.amount, updated_at = now() FROM c WHERE wallets.user_id = c.owner_id RETURNING wallets.id AS wid, wallets.balance AS bal, c.id AS cid, c.amount AS amt),
    t AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key, metadata)
      SELECT wid, 'refund', amt, bal, 'completed', 'termcode', cid::text, 'termcode-refund-' || cid::text, '{"termcode":"refund"}'::jsonb FROM w RETURNING id)
    SELECT cid FROM w`;
  return r.length > 0;
}
async function expireDue() {
  try {
    await ensure();
    const due = await sql()`SELECT id FROM termcodes WHERE status = 'open' AND expires_at <= now() LIMIT 50`;
    for (const d of due) await refund(d.id, "expired", null);
    return due.length;
  } catch (e) { console.error("TERMCODE_EXPIRE", e.message); return 0; }
}
const timer = setInterval(expireDue, 60000); if (timer.unref) timer.unref();

// Anti-devinette : 5 codes faux en 15 minutes = blocage de 15 minutes pour cet utilisateur.
const fails = new Map();
const locked = (uid) => { const f = fails.get(uid); if (!f) return false; if (Date.now() - f.t > 15 * 60000) { fails.delete(uid); return false; } return f.n >= 5; };
const fail = (uid) => { const f = fails.get(uid); if (!f || Date.now() - f.t > 15 * 60000) fails.set(uid, { n: 1, t: Date.now() }); else f.n++; };

router.post("/create", requireAuth, async (req, res) => {
  try {
    await ensure(); await expireDue();
    const uid = req.user.userId, amount = Math.floor(Number(req.body && req.body.amount));
    if (!Number.isFinite(amount) || amount < MIN() || amount > MAX()) return res.status(400).json({ error: `Montant entre ${MIN()} et ${MAX()} FCFA.` });
    const note = clean(req.body && req.body.note, 60), q = sql();
    const open = await q`SELECT count(*)::int AS n FROM termcodes WHERE owner_id = ${uid}::uuid AND status = 'open'`;
    if (open[0].n >= 3) return res.status(429).json({ error: "3 codes ouverts maximum. Annulez-en un ou attendez l'expiration." });
    for (let i = 0; i < 6; i++) {
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
      try {
        const r = await q`WITH w AS (UPDATE wallets SET balance = balance - ${amount}, updated_at = now() WHERE user_id = ${uid}::uuid AND balance >= ${amount} RETURNING id, balance),
          c AS (INSERT INTO termcodes (owner_id, amount, code, note, expires_at) SELECT ${uid}::uuid, ${amount}, ${code}, ${note}, now() + make_interval(mins => ${MINUTES()}) FROM w RETURNING id, expires_at),
          t AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key, metadata)
            SELECT w.id, 'transfer_out', ${amount}, w.balance, 'completed', 'termcode', c.id::text, 'termcode-out-' || c.id::text, '{"termcode":"hold"}'::jsonb FROM w, c RETURNING id)
          SELECT c.id, c.expires_at FROM c`;
        if (!r.length) return res.status(400).json({ error: "Solde insuffisant." });
        return res.status(201).json({ id: r[0].id, code, amount, expiresAt: r[0].expires_at, message: `Code créé : ${code}. Valable ${MINUTES()} minutes. Donnez-le uniquement à la personne qui vous remet ou reçoit les espèces.` });
      } catch (e) { if (!/unique|duplicate/i.test(String(e.message))) throw e; }
    }
    res.status(503).json({ error: "Réessayez dans un instant." });
  } catch (e) { console.error("TERMCODE_CREATE", e.message); res.status(500).json({ error: "Impossible de créer le code." }); }
});

router.post("/redeem", requireAuth, async (req, res) => {
  try {
    await ensure(); await expireDue();
    const uid = req.user.userId, code = String((req.body && req.body.code) || "").replace(/\D/g, "");
    if (locked(uid)) return res.status(429).json({ error: "Trop d'essais. Réessayez dans 15 minutes." });
    if (code.length !== 6) return res.status(400).json({ error: "Le code a 6 chiffres." });
    const r = await sql()`WITH c AS (UPDATE termcodes SET status = 'redeemed', redeemer_id = ${uid}::uuid, redeemed_at = now()
        WHERE code = ${code} AND status = 'open' AND expires_at > now() AND owner_id <> ${uid}::uuid AND EXISTS (SELECT 1 FROM wallets WHERE user_id = ${uid}::uuid) RETURNING id, amount),
      w AS (UPDATE wallets SET balance = balance + c.amount, updated_at = now() FROM c WHERE wallets.user_id = ${uid}::uuid RETURNING wallets.id AS wid, wallets.balance AS bal, c.id AS cid, c.amount AS amt),
      t AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key, metadata)
        SELECT wid, 'transfer_in', amt, bal, 'completed', 'termcode', cid::text, 'termcode-in-' || cid::text, '{"termcode":"redeem"}'::jsonb FROM w RETURNING id)
      SELECT cid, amt::float AS amount FROM w`;
    if (!r.length) { fail(uid); return res.status(400).json({ error: "Code invalide, expiré ou déjà utilisé." }); }
    res.json({ ok: true, amount: r[0].amount, message: `${r[0].amount} FCFA crédités sur votre solde.` });
  } catch (e) { console.error("TERMCODE_REDEEM", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.get("/mine", requireAuth, async (req, res) => {
  try {
    await ensure(); await expireDue();
    const uid = req.user.userId, q = sql();
    const mine = await q`SELECT id, amount::float AS amount, status, note, created_at, expires_at, CASE WHEN status = 'open' THEN code ELSE NULL END AS code FROM termcodes WHERE owner_id = ${uid}::uuid ORDER BY created_at DESC LIMIT 15`;
    const got = await q`SELECT amount::float AS amount, redeemed_at FROM termcodes WHERE redeemer_id = ${uid}::uuid ORDER BY redeemed_at DESC LIMIT 10`;
    res.json({ mine, redeemed: got, minutes: MINUTES() });
  } catch (e) { console.error("TERMCODE_MINE", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/:id/cancel", requireAuth, async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    await ensure();
    res.json((await refund(req.params.id, "cancelled", req.user.userId)) ? { ok: true, message: "Code annulé : montant remboursé." } : { ok: false, message: "Ce code n'est plus ouvert." });
  } catch (e) { console.error("TERMCODE_CANCEL", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;
module.exports._expireDue = expireDue;
