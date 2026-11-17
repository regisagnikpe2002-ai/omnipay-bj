"use strict";
// OMNIPAY — API v1 (clés API pour les commerçants et partenaires). AJOUT SEUL : aucun solde n'est modifié ici.
// Sécurité volontaire : une clé API peut LIRE le solde et l'historique et CRÉER des demandes de paiement (le client paie lui-même).
// Une clé ne peut PAS envoyer d'argent, ni retirer, ni changer de réglage. La clé complète n'est montrée qu'une fois ;
// seule son empreinte SHA-256 est conservée. Création/révocation de clé : connexion + code de confirmation (OTP).
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const MAX_KEYS = 5, MIN = 100;
const MAX = () => Number(process.env.PAY_MAX_XOF || 1000000);
const RATE = Number(process.env.API_V1_RATE_PER_MIN || 60);
const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TOKEN_RE = /^[A-HJ-NP-Z2-9]{10}$/;
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);
const refOf = (id) => "OMP-R" + String(id).replace(/-/g, "").slice(0, 10).toUpperCase();
const newKey = () => "opk_live_" + Array.from(crypto.randomBytes(40), (b) => B62[b % 62]).join("");
const newToken = () => Array.from(crypto.randomBytes(10), (b) => ALPHA[b % ALPHA.length]).join("");
const KEY_RE = /^opk_live_[A-Za-z0-9]{40}$/;

let ready = null;
function ensure() {
  if (!ready) ready = (async () => {
    const q = sql();
    await q`CREATE TABLE IF NOT EXISTS api_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, name varchar(40) NOT NULL,
      prefix varchar(16) NOT NULL, last4 varchar(4) NOT NULL, key_hash varchar(64) NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz, revoked_at timestamptz)`;
    // même définition que routes/payRequests.js : sans effet si la table existe déjà
    await q`CREATE TABLE IF NOT EXISTS pay_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token varchar(10) NOT NULL UNIQUE, owner_id uuid NOT NULL,
      amount integer, note varchar(60), status varchar(12) NOT NULL DEFAULT 'open', expires_at timestamptz,
      paid_by uuid, paid_at timestamptz, pay_count integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now())`;
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

// ---- gestion des clés (connexion client) ----
router.post("/keys", requireAuth, async (req, res) => {
  try {
    await ensure();
    const name = clean(req.body?.name, 40);
    if (name.length < 2) return res.status(400).json({ error: "Donnez un nom à la clé (2 caractères minimum)." });
    const q = sql();
    const n = (await q`SELECT count(*)::int AS n FROM api_keys WHERE user_id = ${req.user.userId}::uuid AND revoked_at IS NULL`)[0].n;
    if (n >= MAX_KEYS) return res.status(429).json({ error: `Maximum ${MAX_KEYS} clés actives. Révoquez-en une.` });
    const key = newKey();
    const r = await q`INSERT INTO api_keys (user_id, name, prefix, last4, key_hash)
      VALUES (${req.user.userId}::uuid, ${name}, ${key.slice(0, 12)}, ${key.slice(-4)}, ${sha(key)}) RETURNING id, created_at`;
    res.status(201).json({ id: r[0].id, name, key, createdAt: r[0].created_at,
      warning: "Copiez cette clé maintenant : elle ne sera plus jamais affichée en entier." });
  } catch (e) { console.error("API_KEY_NEW", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.get("/keys", requireAuth, async (req, res) => {
  try {
    await ensure();
    const rows = await sql()`SELECT id, name, prefix, last4, created_at, last_used_at, revoked_at FROM api_keys
      WHERE user_id = ${req.user.userId}::uuid ORDER BY created_at DESC LIMIT 20`;
    res.json({ keys: rows.map((k) => ({ id: k.id, name: k.name, hint: `${k.prefix}…${k.last4}`, createdAt: k.created_at, lastUsedAt: k.last_used_at, revoked: !!k.revoked_at })) });
  } catch (e) { console.error("API_KEY_LIST", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.delete("/keys/:id", requireAuth, async (req, res) => {
  try {
    await ensure();
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    const r = await sql()`UPDATE api_keys SET revoked_at = now() WHERE id = ${req.params.id}::uuid AND user_id = ${req.user.userId}::uuid AND revoked_at IS NULL RETURNING id`;
    if (!r.length) return res.status(404).json({ error: "Clé introuvable ou déjà révoquée." });
    res.json({ ok: true });
  } catch (e) { console.error("API_KEY_DEL", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

// ---- authentification par clé API ----
const hits = new Map();
function limited(id) {
  const m = Math.floor(Date.now() / 60000), h = hits.get(id);
  if (!h || h.m !== m) { hits.set(id, { m, n: 1 }); if (hits.size > 5000) hits.clear(); return false; }
  return ++h.n > RATE;
}
async function keyAuth(req, res, next) {
  try {
    const raw = String(req.headers["x-api-key"] || (/^Bearer (.+)$/i.exec(req.headers.authorization || "") || [])[1] || "").trim();
    if (!KEY_RE.test(raw)) return res.status(401).json({ error: "Clé API manquante ou invalide.", code: "invalid_key" });
    await ensure();
    const r = await sql()`SELECT id, user_id FROM api_keys WHERE key_hash = ${sha(raw)} AND revoked_at IS NULL`;
    if (!r.length) return res.status(401).json({ error: "Clé API manquante ou invalide.", code: "invalid_key" });
    if (limited(r[0].id)) return res.status(429).json({ error: `Limite : ${RATE} requêtes par minute.`, code: "rate_limited" });
    req.apiUser = r[0].user_id;
    sql()`UPDATE api_keys SET last_used_at = now() WHERE id = ${r[0].id}::uuid AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`.catch(() => {});
    next();
  } catch (e) { console.error("API_V1_AUTH", e.message); res.status(500).json({ error: "Erreur serveur." }); }
}

router.get("/", (req, res) => res.json({ name: "OMNIPAY API", version: "v1", currency: "XOF", auth: "Authorization: Bearer opk_live_…  (ou en-tête x-api-key)",
  endpoints: ["GET /api/v1/balance", "GET /api/v1/transactions?limit=20", "POST /api/v1/payment-requests {amount,note,hours}", "GET /api/v1/payment-requests/:token"],
  limits: { requestsPerMinute: RATE, minAmount: MIN, maxAmount: MAX() }, note: "Une clé ne peut pas envoyer ni retirer de l'argent." }));

router.get("/balance", keyAuth, async (req, res) => {
  try {
    const w = (await sql()`SELECT balance, currency, updated_at FROM wallets WHERE user_id = ${req.apiUser}::uuid`)[0];
    if (!w) return res.status(404).json({ error: "Portefeuille introuvable." });
    res.json({ currency: w.currency || "XOF", balance: Number(w.balance), updatedAt: w.updated_at });
  } catch (e) { console.error("API_V1_BAL", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.get("/transactions", keyAuth, async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, Math.floor(Number(req.query.limit)) || 20));
    const before = req.query.before && !isNaN(Date.parse(req.query.before)) ? new Date(req.query.before).toISOString() : null;
    const rows = await sql()`SELECT t.id, t.type, t.amount, t.status, t.provider, t.created_at FROM transactions t
      JOIN wallets w ON w.id = t.wallet_id WHERE w.user_id = ${req.apiUser}::uuid AND (${before}::timestamptz IS NULL OR t.created_at < ${before}::timestamptz)
      ORDER BY t.created_at DESC LIMIT ${limit}`;
    res.json({ transactions: rows.map((t) => ({ id: t.id, reference: refOf(t.id), type: t.type, amount: Number(t.amount), status: t.status, provider: t.provider, createdAt: t.created_at })),
      next: rows.length === limit ? rows[rows.length - 1].created_at : null });
  } catch (e) { console.error("API_V1_TX", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/payment-requests", keyAuth, async (req, res) => {
  try {
    const raw = req.body?.amount;
    const amount = raw == null || raw === "" ? null : Math.floor(Number(raw));
    if (amount !== null && (!Number.isFinite(amount) || amount < MIN || amount > MAX())) return res.status(400).json({ error: `Montant entre ${MIN} et ${MAX()} FCFA.` });
    const hours = Math.min(168, Math.max(1, Math.floor(Number(req.body?.hours)) || 24));
    const note = clean(req.body?.note, 60) || null;
    const q = sql();
    const open = (await q`SELECT count(*)::int AS n FROM pay_requests WHERE owner_id = ${req.apiUser}::uuid AND status = 'open' AND (expires_at IS NULL OR expires_at > now())`)[0].n;
    if (open >= 30) return res.status(429).json({ error: "Trop de demandes ouvertes (30)." });
    for (let i = 0; i < 5; i++) {
      const token = newToken();
      const r = await q`INSERT INTO pay_requests (token, owner_id, amount, note, expires_at)
        VALUES (${token}, ${req.apiUser}::uuid, ${amount}, ${note}, ${new Date(Date.now() + hours * 3600e3).toISOString()}::timestamptz)
        ON CONFLICT DO NOTHING RETURNING token, expires_at`;
      if (r.length) return res.status(201).json({ token: r[0].token, amount, note, expiresAt: r[0].expires_at,
        link: `${(process.env.PUBLIC_BASE_URL || "https://www.omnipay-bj.com").replace(/\/$/, "")}/?pay=${r[0].token}` });
    }
    res.status(500).json({ error: "Erreur serveur." });
  } catch (e) { console.error("API_V1_PR", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.get("/payment-requests/:token", keyAuth, async (req, res) => {
  try {
    if (!TOKEN_RE.test(req.params.token)) return res.status(400).json({ error: "Jeton invalide." });
    const r = (await sql()`SELECT token, amount, note, status, expires_at, paid_at, pay_count,
      (status = 'open' AND expires_at IS NOT NULL AND expires_at <= now()) AS expired
      FROM pay_requests WHERE token = ${req.params.token} AND owner_id = ${req.apiUser}::uuid`)[0];
    if (!r) return res.status(404).json({ error: "Demande introuvable." });
    res.json({ token: r.token, amount: r.amount, note: r.note, status: r.expired ? "expired" : r.status, expiresAt: r.expires_at, paidAt: r.paid_at, payCount: r.pay_count });
  } catch (e) { console.error("API_V1_PRG", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;
