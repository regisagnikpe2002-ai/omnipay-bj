"use strict";
// OMNIPAY — OMNIGIFT : le client SOUMET une carte cadeau à vendre ; l'administrateur la vérifie à la main, puis crédite.
// Rien n'est automatique : aucun crédit sans validation humaine, et jamais avant la fin du délai de sécurité (GIFT_HOLD_HOURS, 24 h par défaut).
// Le code et la photo sont chiffrés (AES-256-GCM) et ne sont lisibles que par l'administrateur (x-admin-key).
//   GET  /api/omnigift/catalog            → marques acceptées + état « Acheter » (bientôt)
//   POST /api/omnigift/sell               (client) {brand, value, currency, code, photo?}
//   GET  /api/omnigift/mine               (client) ses demandes, sans le code
//   GET  /api/omnigift/admin/list         (admin) demandes à traiter
//   GET  /api/omnigift/admin/:id          (admin) détail avec code et photo déchiffrés
//   POST /api/omnigift/admin/:id/decide   (admin) {decision:"validated"|"refused", creditXof, note}
//   POST /api/omnigift/admin/:id/pay      (admin) crédite le solde du client (une seule fois, après le délai)
//   POST /api/omnigift/admin/:id/purge    (admin) efface code et photo après traitement
const express = require("express");
const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." }));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);

const BRANDS = ["Google Play", "PlayStation", "Steam", "Apple", "Amazon", "Airbnb", "Netflix", "Spotify", "Paysafecard", "Autre"];
const CURRENCIES = ["EUR", "USD", "XOF", "GBP"];
const MAX_OPEN = () => Number(process.env.GIFT_MAX_OPEN || 3);
const HOLD_H = () => Math.max(0, Number(process.env.GIFT_HOLD_HOURS == null || process.env.GIFT_HOLD_HOURS === "" ? 24 : process.env.GIFT_HOLD_HOURS));
const MAX_PHOTO = 700 * 1024; // caractères base64 après compression côté navigateur

// Clé de chiffrement : GIFT_ENC_KEY (recommandé). À défaut, dérivée d'un secret serveur existant.
function keyBytes() {
  const raw = process.env.GIFT_ENC_KEY || process.env.JWT_SECRET || process.env.ADMIN_KEY || "";
  if (String(raw).length < 16) return null;
  return crypto.createHash("sha256").update("omnigift|" + raw).digest();
}
function enc(plain) {
  const key = keyBytes(); if (!key) throw new Error("NO_KEY");
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}
function dec(b64) {
  if (!b64) return null;
  const key = keyBytes(); if (!key) throw new Error("NO_KEY");
  const buf = Buffer.from(b64, "base64"), d = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}
// Empreinte du code : refuse deux fois le même code (même client ou autre), sans stocker le code en clair.
const codeHash = (code) => crypto.createHash("sha256").update("gift-code|" + String(code).replace(/[\s-]/g, "").toUpperCase() + "|" + (process.env.GIFT_ENC_KEY || process.env.ADMIN_KEY || "")).digest("hex");

let ready = null;
function ensure() {
  if (!ready) ready = (async () => {
    const q = sql();
    await q`CREATE TABLE IF NOT EXISTS omnigift_sales (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, brand varchar(40) NOT NULL, face_value numeric(14,2) NOT NULL, currency varchar(5) NOT NULL,
      code_enc text, code_hash varchar(64) NOT NULL, photo_enc text, status varchar(12) NOT NULL DEFAULT 'pending', credit_xof numeric(14,2), admin_note varchar(300),
      credit_after timestamptz, created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz, paid_at timestamptz)`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS omnigift_code_uq ON omnigift_sales (code_hash)`;
    await q`CREATE INDEX IF NOT EXISTS omnigift_user_idx ON omnigift_sales (user_id, created_at DESC)`;
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

router.get("/catalog", requireAuth, (req, res) => res.json({
  sell: { enabled: Boolean(keyBytes()), brands: BRANDS, currencies: CURRENCIES, holdHours: HOLD_H(), maxOpen: MAX_OPEN() },
  buy: { enabled: false, message: "Acheter : bientôt disponible." },
}));

router.post("/sell", requireAuth, async (req, res) => {
  try {
    if (!keyBytes()) return res.status(503).json({ error: "Service momentanément indisponible." });
    const brand = clean(req.body?.brand, 40), currency = clean(req.body?.currency, 5).toUpperCase();
    const value = Number(req.body?.value), code = clean(req.body?.code, 80);
    const photo = typeof req.body?.photo === "string" ? req.body.photo : "";
    if (!BRANDS.includes(brand)) return res.status(400).json({ error: "Type de carte non accepté." });
    if (!CURRENCIES.includes(currency)) return res.status(400).json({ error: "Devise non acceptée." });
    if (!Number.isFinite(value) || value <= 0 || value > 100000000) return res.status(400).json({ error: "Montant invalide." });
    if (code.replace(/[\s-]/g, "").length < 6) return res.status(400).json({ error: "Code de la carte invalide." });
    if (photo && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo) || photo.length > MAX_PHOTO)) return res.status(400).json({ error: "Photo invalide ou trop lourde." });
    await ensure();
    const q = sql();
    const [open] = await q`SELECT count(*)::int AS n FROM omnigift_sales WHERE user_id = ${req.user.userId}::uuid AND status IN ('pending','validated')`;
    if (open.n >= MAX_OPEN()) return res.status(429).json({ error: "Vous avez déjà des cartes en cours de vérification." });
    const h = codeHash(code);
    const dup = await q`SELECT 1 FROM omnigift_sales WHERE code_hash = ${h} LIMIT 1`;
    if (dup.length) return res.status(409).json({ error: "Ce code a déjà été soumis." });
    const rows = await q`INSERT INTO omnigift_sales (user_id, brand, face_value, currency, code_enc, code_hash, photo_enc)
      VALUES (${req.user.userId}::uuid, ${brand}, ${value}, ${currency}, ${enc(code)}, ${h}, ${photo ? enc(photo) : null}) ON CONFLICT (code_hash) DO NOTHING RETURNING id`;
    if (!rows.length) return res.status(409).json({ error: "Ce code a déjà été soumis." });
    try { require("../lib/mailer").sendAdminNotification("OMNIGIFT : nouvelle carte à vérifier", `<p>Une carte ${brand} de ${value} ${currency} attend votre vérification dans OMNICHECK (le code n'est pas envoyé par e-mail).</p>`).catch(() => {}); } catch (_) {}
    res.status(201).json({ id: rows[0].id, message: "Carte reçue. OMNIPAY la vérifie, vous serez crédité après validation." });
  } catch (e) { console.error("GIFT_SELL", e.message); res.status(500).json({ error: "Impossible d'enregistrer la carte." }); }
});

router.get("/mine", requireAuth, async (req, res) => {
  try {
    await ensure();
    const rows = await sql()`SELECT id, brand, face_value::float AS value, currency, status, credit_xof::float AS credit_xof, admin_note AS note, credit_after, created_at
      FROM omnigift_sales WHERE user_id = ${req.user.userId}::uuid ORDER BY created_at DESC LIMIT 20`;
    res.json({ sales: rows });
  } catch (e) { console.error("GIFT_MINE", e.message); res.status(500).json({ error: "Erreur." }); }
});

// ---------- Administrateur ----------
router.get("/admin/list", adminOnly, async (req, res) => {
  try {
    await ensure();
    const rows = await sql()`SELECT s.id, s.brand, s.face_value::float AS value, s.currency, s.status, s.credit_xof::float AS credit_xof, s.credit_after, s.created_at, u.email
      FROM omnigift_sales s JOIN users u ON u.id = s.user_id WHERE s.status IN ('pending','validated') ORDER BY s.created_at LIMIT 100`;
    res.json({ sales: rows, holdHours: HOLD_H() });
  } catch (e) { console.error("GIFT_LIST", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.get("/admin/:id", adminOnly, async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    await ensure();
    const r = (await sql()`SELECT s.*, u.email FROM omnigift_sales s JOIN users u ON u.id = s.user_id WHERE s.id = ${req.params.id}::uuid`)[0];
    if (!r) return res.status(404).json({ error: "Introuvable." });
    res.json({ id: r.id, email: r.email, brand: r.brand, value: Number(r.face_value), currency: r.currency, status: r.status, code: dec(r.code_enc), photo: dec(r.photo_enc), note: r.admin_note, creditXof: r.credit_xof == null ? null : Number(r.credit_xof), creditAfter: r.credit_after, createdAt: r.created_at });
  } catch (e) { console.error("GIFT_ONE", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.post("/admin/:id/decide", adminOnly, async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    const decision = req.body?.decision, note = clean(req.body?.note, 300);
    await ensure();
    const q = sql();
    if (decision === "refused") {
      const r = await q`UPDATE omnigift_sales SET status = 'refused', admin_note = ${note || null}, decided_at = now(), code_enc = NULL, photo_enc = NULL WHERE id = ${req.params.id}::uuid AND status = 'pending' RETURNING id`;
      return r.length ? res.json({ ok: true, status: "refused" }) : res.status(409).json({ error: "Déjà traitée." });
    }
    if (decision !== "validated") return res.status(400).json({ error: "Décision invalide." });
    const credit = Number(req.body?.creditXof);
    if (!Number.isFinite(credit) || credit <= 0 || credit > 100000000) return res.status(400).json({ error: "Indiquez le montant à créditer en FCFA." });
    const r = await q`UPDATE omnigift_sales SET status = 'validated', credit_xof = ${credit}, admin_note = ${note || null}, decided_at = now(), credit_after = now() + make_interval(hours => ${HOLD_H()})
      WHERE id = ${req.params.id}::uuid AND status = 'pending' RETURNING credit_after`;
    if (!r.length) return res.status(409).json({ error: "Déjà traitée." });
    res.json({ ok: true, status: "validated", creditAfter: r[0].credit_after });
  } catch (e) { console.error("GIFT_DECIDE", e.message); res.status(500).json({ error: "Erreur." }); }
});

// Crédit unique et atomique : la ligne passe de 'validated' à 'paid' dans la même instruction que le crédit du solde.
router.post("/admin/:id/pay", adminOnly, async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    await ensure();
    const q = sql();
    const rows = await q`
      WITH s AS (UPDATE omnigift_sales SET status = 'paid', paid_at = now(), code_enc = NULL, photo_enc = NULL
                 WHERE id = ${req.params.id}::uuid AND status = 'validated' AND credit_after <= now() RETURNING user_id, credit_xof, id),
      w AS (UPDATE wallets SET balance = balance + (SELECT credit_xof FROM s) WHERE user_id = (SELECT user_id FROM s) AND EXISTS (SELECT 1 FROM s) RETURNING id, balance),
      t AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key)
            SELECT w.id, 'deposit', s.credit_xof, w.balance, 'completed', 'omnigift', s.id::text, 'gift-' || s.id::text FROM w, s RETURNING id)
      SELECT t.id FROM t`;
    if (!rows.length) return res.status(409).json({ error: "Pas encore créditable (délai de sécurité) ou déjà payée." });
    res.json({ ok: true, status: "paid" });
  } catch (e) { console.error("GIFT_PAY", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.post("/admin/:id/purge", adminOnly, async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    await ensure();
    await sql()`UPDATE omnigift_sales SET code_enc = NULL, photo_enc = NULL WHERE id = ${req.params.id}::uuid`;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Erreur." }); }
});

module.exports = router;
