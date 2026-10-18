"use strict";
// OMNIPAY — identifiant de compte (type IBAN interne) + transfert par identifiant + reçus (fichier AJOUTÉ).
// L'identifiant « OM… » n'est utilisable qu'entre clients OMNIPAY : ce n'est PAS un IBAN bancaire.
// Les reçus sont dérivés des transactions existantes : toute action (ancienne ou nouvelle) a une référence.
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const COMMISSION = 50;
const MIN = 100;
const CODE_RE = /^OM\d{11}$/;
let ready = false;

async function ensureTables() {
  if (ready) return;
  await sql()`CREATE TABLE IF NOT EXISTS account_ids (
    user_id uuid PRIMARY KEY, code varchar(13) NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now())`;
  ready = true;
}

// OM + 10 chiffres aléatoires + 1 chiffre de contrôle (Luhn) : une faute de frappe est détectée avant l'envoi.
function luhnDigit(d10) {
  let sum = 0;
  for (let i = 0; i < d10.length; i++) {
    let n = Number(d10[d10.length - 1 - i]);
    if (i % 2 === 0) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return String((10 - (sum % 10)) % 10);
}
function newCode() {
  const d10 = String(crypto.randomInt(0, 1e10)).padStart(10, "0");
  return "OM" + d10 + luhnDigit(d10);
}
const validCode = (c) => CODE_RE.test(c) && luhnDigit(c.slice(2, 12)) === c[12];

async function codeFor(userId) {
  await ensureTables();
  const q = sql();
  for (let i = 0; i < 8; i++) {
    const rows = await q`INSERT INTO account_ids (user_id, code) VALUES (${userId}, ${newCode()}) ON CONFLICT DO NOTHING RETURNING code`;
    if (rows.length) return rows[0].code;
    const ex = await q`SELECT code FROM account_ids WHERE user_id = ${userId}`;
    if (ex.length) return ex[0].code;
  }
  throw new Error("code generation failed");
}

const maskName = (f, l) => [f ? String(f).slice(0, 1).toUpperCase() + "***" : "", l ? String(l).slice(0, 1).toUpperCase() + "." : ""].filter(Boolean).join(" ") || "Client OMNIPAY";
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };

router.get("/id/me", requireAuth, async (req, res) => {
  try { res.json({ code: await codeFor(req.user.userId), note: "Utilisable uniquement entre clients OMNIPAY." }); }
  catch (e) { console.error("ID_ME", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.get("/id/lookup/:code", requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const code = String(req.params.code || "").toUpperCase().replace(/\s/g, "");
    if (!validCode(code)) return res.status(400).json({ error: "Identifiant invalide (vérifiez la saisie)." });
    const r = await sql()`SELECT u.first_name, u.last_name FROM account_ids a JOIN users u ON u.id = a.user_id WHERE a.code = ${code}`;
    if (!r.length) return res.status(404).json({ error: "Aucun client OMNIPAY avec cet identifiant." });
    res.json({ name: maskName(r[0].first_name, r[0].last_name) });
  } catch (e) { console.error("ID_LOOKUP", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

// Transfert par identifiant : un seul ordre SQL (débit + crédit + 3 écritures) ou rien.
router.post("/id/transfer", requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const code = String(req.body?.code || "").toUpperCase().replace(/\s/g, "");
    const amount = Math.floor(Number(req.body?.amount));
    const note = String(req.body?.note || "").replace(/[<>]/g, "").trim().slice(0, 60);
    if (!validCode(code)) return res.status(400).json({ error: "Identifiant invalide (vérifiez la saisie)." });
    if (!Number.isFinite(amount) || amount < MIN) return res.status(400).json({ error: `Montant minimum : ${MIN} FCFA.` });
    const total = amount + COMMISSION;
    const me = req.user.userId;
    const key = crypto.randomUUID();
    const meta = JSON.stringify({ note, toCode: code });
    const rows = await sql()`
      WITH r AS (SELECT user_id FROM account_ids WHERE code = ${code} AND user_id <> ${me}::uuid),
      s AS (UPDATE wallets SET balance = balance - ${total}, updated_at = now()
            WHERE user_id = ${me}::uuid AND balance >= ${total} AND EXISTS (SELECT 1 FROM r) RETURNING id, balance),
      d AS (UPDATE wallets SET balance = balance + ${amount}, updated_at = now()
            FROM r WHERE wallets.user_id = r.user_id AND EXISTS (SELECT 1 FROM s) RETURNING wallets.id, wallets.balance, r.user_id),
      o AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, idempotency_key, counterparty_user_id, metadata)
            SELECT s.id, 'transfer_out', ${amount}, s.balance, 'completed', 'internal', ${key + "-out"}, d.user_id, ${meta}::jsonb FROM s, d RETURNING id),
      i AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, idempotency_key, counterparty_user_id, metadata)
            SELECT d.id, 'transfer_in', ${amount}, d.balance, 'completed', 'internal', ${key + "-in"}, ${me}::uuid, ${meta}::jsonb FROM d RETURNING id),
      c AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, idempotency_key)
            SELECT s.id, 'commission', ${COMMISSION}, s.balance, 'completed', 'internal', ${key + "-fee"} FROM s, d RETURNING id)
      SELECT s.balance, o.id AS tx_id FROM s, d, o`;
    if (!rows.length) {
      const dest = await sql()`SELECT user_id FROM account_ids WHERE code = ${code}`;
      if (!dest.length) return res.status(404).json({ error: "Aucun client OMNIPAY avec cet identifiant." });
      if (dest[0].user_id === me) return res.status(400).json({ error: "Vous ne pouvez pas vous envoyer de l'argent à vous-même." });
      return res.status(400).json({ error: `Solde insuffisant (montant + ${COMMISSION} FCFA de commission).` });
    }
    res.json({ message: "Transfert effectué avec succès.", newBalance: Number(rows[0].balance).toFixed(2), receiptRef: refOf(rows[0].tx_id) });
  } catch (e) { console.error("ID_TRANSFER", e.message); res.status(500).json({ error: "Erreur serveur lors du transfert." }); }
});

// ---------- Reçus ----------
const refOf = (txId) => "OMP-R" + String(txId).replace(/-/g, "").slice(0, 10).toUpperCase();
const LABEL = { deposit: "Dépôt", withdrawal: "Retrait", commission: "Commission", transfer_in: "Transfert reçu", transfer_out: "Transfert envoyé", refund: "Remboursement" };

router.get("/receipts", requireAuth, async (req, res) => {
  try {
    const rows = await sql()`SELECT t.id, t.type, t.amount::float AS amount, t.status, t.created_at
      FROM transactions t JOIN wallets w ON w.id = t.wallet_id
      WHERE w.user_id = ${req.user.userId}::uuid AND t.type <> 'commission' ORDER BY t.created_at DESC LIMIT 100`;
    res.json({ receipts: rows.map((r) => ({ ref: refOf(r.id), type: r.type, label: LABEL[r.type] || r.type, amount: r.amount, status: r.status, date: r.created_at })) });
  } catch (e) { console.error("RC_LIST", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.get("/receipts/:ref", requireAuth, async (req, res) => {
  try {
    const m = /^OMP-R([0-9A-F]{10})$/.exec(String(req.params.ref || "").toUpperCase());
    if (!m) return res.status(400).json({ error: "Référence invalide." });
    const q = sql();
    const rows = await q`SELECT t.id, t.type, t.amount::float AS amount, t.balance_after::float AS balance_after, t.status, t.provider, t.provider_ref,
        t.idempotency_key, t.metadata, t.created_at, t.counterparty_user_id
      FROM transactions t JOIN wallets w ON w.id = t.wallet_id
      WHERE w.user_id = ${req.user.userId}::uuid AND replace(t.id::text, '-', '') LIKE ${m[1].toLowerCase() + "%"} LIMIT 1`;
    if (!rows.length) return res.status(404).json({ error: "Reçu introuvable." });
    const t = rows[0];
    const base = String(t.idempotency_key).replace(/-(out|in)$/, "");
    const fee = ["withdrawal", "transfer_out"].includes(t.type)
      ? (await q`SELECT coalesce(sum(amount),0)::float AS f FROM transactions WHERE idempotency_key = ${base + "-fee"} AND type = 'commission'`)[0].f : 0;
    let cp = null;
    if (t.counterparty_user_id) {
      const u = await q`SELECT u.first_name, u.last_name, a.code FROM users u LEFT JOIN account_ids a ON a.user_id = u.id WHERE u.id = ${t.counterparty_user_id}::uuid`;
      if (u.length) cp = { name: maskName(u[0].first_name, u[0].last_name), accountId: u[0].code || null };
    }
    const phone = ["withdrawal"].includes(t.type) && t.provider_ref ? String(t.provider_ref).replace(/.(?=.{3})/g, "•") : null;
    res.json({
      reference: refOf(t.id), label: LABEL[t.type] || t.type, type: t.type, status: t.status, date: t.created_at,
      amount: t.amount, fee, total: t.type === "deposit" || t.type === "transfer_in" || t.type === "refund" ? t.amount : t.amount + fee,
      balanceAfter: t.balance_after, channel: t.provider, destination: phone, counterparty: cp, note: (t.metadata && t.metadata.note) || null,
      issuer: "OMNIPAY — ETS OMNIPAY, Abomey-Calavi, Bénin",
    });
  } catch (e) { console.error("RC_ONE", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

// Admin : attribue un identifiant à tous les clients qui n'en ont pas encore.
router.post("/id/backfill", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Accès refusé." });
  try {
    await ensureTables();
    const users = await sql()`SELECT u.id FROM users u LEFT JOIN account_ids a ON a.user_id = u.id WHERE a.user_id IS NULL`;
    for (const u of users) await codeFor(u.id);
    res.json({ created: users.length });
  } catch (e) { console.error("ID_BACKFILL", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;
module.exports.validCode = validCode;
