"use strict";
// OMNIPAY — OMNITRADE : bourse gratuite des produits locaux (mise en relation). FICHIER AJOUTÉ.
// Principe : aucun argent ne passe par OMNITRADE. Les vendeurs publient des offres et des prix, les acheteurs les consultent
// et contactent le vendeur directement. Les membres qui publient sont vérifiés par l'administrateur.
//   Niveau 1 « Vendeur vérifié »     : pièce d'identité + téléphone.
//   Niveau 2 « Partenaire certifié » : en plus IFU + registre de commerce.
// Les numéros de pièce, IFU et RCCM ne sont JAMAIS renvoyés au public : seulement à l'intéressé (masqués) et à l'administrateur.
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);

const SEED = [
  ["tomate", "Tomate", "kg"], ["oignon", "Oignon", "kg"], ["piment", "Piment", "kg"], ["igname", "Igname", "tubercule"],
  ["manioc", "Manioc", "kg"], ["mais", "Maïs", "kg"], ["gari", "Gari", "kg"], ["huile-palme", "Huile de palme", "litre"],
  ["niebe", "Niébé (haricot)", "kg"], ["arachide", "Arachide", "kg"], ["riz-local", "Riz local", "kg"], ["poisson-fume", "Poisson fumé", "kg"],
  ["aubergine", "Aubergine", "kg"], ["gombo", "Gombo", "kg"], ["patate-douce", "Patate douce", "kg"], ["banane-plantain", "Banane plantain", "régime"],
  ["ananas", "Ananas", "pièce"], ["orange", "Orange", "kg"], ["soja", "Soja", "kg"], ["ail", "Ail", "kg"],
];
const UNITS = ["kg", "tubercule", "litre", "régime", "pièce", "sac", "tas", "tonne"];
const ID_TYPES = ["CIP", "Passeport", "Carte d'électeur", "Permis de conduire", "Carte consulaire"];
const KINDS = ["seller", "agent", "buyer"];
const MAX_PRICES_DAY = 30;
const MAX_OFFERS_OPEN = 15;

let ready = false;
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);
const digits = (v, n) => String(v == null ? "" : v).replace(/\D/g, "").slice(0, n);
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." }));
const mask = (v) => { const s = String(v || ""); return s.length <= 4 ? (s ? "••••" : "") : "•".repeat(Math.max(0, s.length - 4)) + s.slice(-4); };
const phoneOk = (p) => /^\+?\d{8,15}$/.test(p);

async function ensureTables() {
  if (ready) return;
  const q = sql();
  await q`CREATE TABLE IF NOT EXISTS ot_products (slug varchar(40) PRIMARY KEY, name varchar(60) NOT NULL, unit varchar(20) NOT NULL, active boolean NOT NULL DEFAULT true)`;
  await q`CREATE TABLE IF NOT EXISTS ot_members (
    user_id uuid PRIMARY KEY, kind varchar(10) NOT NULL, display_name varchar(80) NOT NULL, phone varchar(20) NOT NULL, whatsapp varchar(20),
    city varchar(60) NOT NULL, id_type varchar(30), id_number varchar(40), ifu varchar(20), rccm varchar(40),
    level int NOT NULL DEFAULT 0, status varchar(12) NOT NULL DEFAULT 'pending', note varchar(200),
    ref_code varchar(12) UNIQUE NOT NULL, referred_by varchar(12), created_at timestamptz NOT NULL DEFAULT now(), verified_at timestamptz)`;
  await q`CREATE TABLE IF NOT EXISTS ot_prices (
    id bigserial PRIMARY KEY, product varchar(40) NOT NULL, market varchar(80), city varchar(60) NOT NULL, price_xof numeric(14,2) NOT NULL,
    unit varchar(20) NOT NULL, user_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`;
  await q`CREATE INDEX IF NOT EXISTS ot_prices_idx ON ot_prices (product, city, created_at DESC)`;
  await q`CREATE TABLE IF NOT EXISTS ot_offers (
    id bigserial PRIMARY KEY, user_id uuid NOT NULL, product varchar(40) NOT NULL, qty numeric(14,2) NOT NULL, unit varchar(20) NOT NULL,
    price_xof numeric(14,2) NOT NULL, city varchar(60) NOT NULL, market varchar(80), available_from date, note varchar(200),
    status varchar(10) NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'))`;
  await q`CREATE INDEX IF NOT EXISTS ot_offers_idx ON ot_offers (status, product, city, created_at DESC)`;
  for (const [slug, name, unit] of SEED) await q`INSERT INTO ot_products (slug, name, unit) VALUES (${slug}, ${name}, ${unit}) ON CONFLICT (slug) DO NOTHING`;
  ready = true;
}

const newRef = () => "OT" + Math.random().toString(36).slice(2, 8).toUpperCase();
const badge = (level) => (level >= 2 ? "Partenaire certifié" : level === 1 ? "Vendeur vérifié" : "");
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function verifiedMember(uid) {
  const [m] = await sql()`SELECT * FROM ot_members WHERE user_id = ${uid}::uuid AND status = 'verified' AND level >= 1 AND kind IN ('seller','agent')`;
  return m || null;
}

// ---------- Public ----------
router.get("/products", async (req, res) => {
  try {
    await ensureTables();
    const rows = await sql()`SELECT slug, name, unit FROM ot_products WHERE active ORDER BY name`;
    res.json({ products: rows, units: UNITS });
  } catch (e) { console.error("OT_PRODUCTS", e.message); res.status(500).json({ error: "Erreur." }); }
});

// Cours du jour : 7 derniers jours, comparés aux 7 jours d'avant. Uniquement des relevés réels.
router.get("/board", async (req, res) => {
  try {
    await ensureTables();
    const city = clean(req.query.city, 60);
    const rows = await sql()`
      SELECT p.slug, p.name, p.unit, r.price_xof::float AS price, r.created_at, r.city,
             (r.created_at > now() - interval '7 days') AS recent
      FROM ot_products p JOIN ot_prices r ON r.product = p.slug
      WHERE p.active AND r.created_at > now() - interval '14 days' AND r.unit = p.unit AND (${city} = '' OR lower(r.city) = lower(${city}))`;
    const by = {};
    for (const r of rows) { (by[r.slug] = by[r.slug] || { slug: r.slug, name: r.name, unit: r.unit, cur: [], prev: [], last: null })[r.recent ? "cur" : "prev"].push(r.price); const t = new Date(r.created_at).getTime(); if (!by[r.slug].last || t > by[r.slug].last) by[r.slug].last = t; }
    const items = Object.values(by).filter((x) => x.cur.length).map((x) => {
      const m = median(x.cur), pm = x.prev.length ? median(x.prev) : null;
      return { slug: x.slug, name: x.name, unit: x.unit, median: Math.round(m), min: Math.round(Math.min(...x.cur)), max: Math.round(Math.max(...x.cur)),
        reports: x.cur.length, trendPct: pm ? Math.round(((m - pm) / pm) * 1000) / 10 : null, updatedAt: new Date(x.last).toISOString() };
    }).sort((a, b) => a.name.localeCompare(b.name, "fr"));
    const cities = await sql()`SELECT DISTINCT city FROM ot_prices WHERE created_at > now() - interval '14 days' ORDER BY city LIMIT 60`;
    res.json({ items, cities: cities.map((c) => c.city), note: "Prix déclarés par des membres vérifiés. Indicatifs, sans garantie." });
  } catch (e) { console.error("OT_BOARD", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.get("/offers", async (req, res) => {
  try {
    await ensureTables();
    const product = clean(req.query.product, 40), city = clean(req.query.city, 60);
    const rows = await sql()`
      SELECT o.id, o.product, p.name AS product_name, o.qty::float AS qty, o.unit, o.price_xof::float AS price, o.city, o.market, o.available_from, o.note,
             o.created_at, m.display_name AS seller, m.level
      FROM ot_offers o JOIN ot_members m ON m.user_id = o.user_id AND m.status = 'verified'
      LEFT JOIN ot_products p ON p.slug = o.product
      WHERE o.status = 'active' AND o.expires_at > now() AND (${product} = '' OR o.product = ${product}) AND (${city} = '' OR lower(o.city) = lower(${city}))
      ORDER BY m.level DESC, o.created_at DESC LIMIT 60`;
    res.json({ offers: rows.map((o) => ({ ...o, badge: badge(o.level) })) });
  } catch (e) { console.error("OT_OFFERS", e.message); res.status(500).json({ error: "Erreur." }); }
});

// ---------- Membres connectés ----------
// Le contact du vendeur n'est donné qu'aux utilisateurs connectés (évite l'aspiration de numéros).
router.get("/contact/:id", requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Offre invalide." });
    const [r] = await sql()`SELECT m.display_name, m.phone, m.whatsapp, m.level FROM ot_offers o JOIN ot_members m ON m.user_id = o.user_id
      WHERE o.id = ${id} AND o.status = 'active' AND o.expires_at > now() AND m.status = 'verified'`;
    if (!r) return res.status(404).json({ error: "Offre introuvable." });
    res.json({ seller: r.display_name, badge: badge(r.level), phone: r.phone, whatsapp: r.whatsapp || r.phone,
      notice: "OMNITRADE met en relation. OMNIPAY n'intervient ni dans la vente ni dans le paiement : vérifiez la marchandise avant de payer." });
  } catch (e) { console.error("OT_CONTACT", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const uid = req.user.userId;
    const [m] = await sql()`SELECT * FROM ot_members WHERE user_id = ${uid}::uuid`;
    if (!m) return res.json({ member: null, idTypes: ID_TYPES });
    const [rf] = await sql()`SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'verified')::int AS v FROM ot_members WHERE referred_by = ${m.ref_code}`;
    const mine = await sql()`SELECT id, product, qty::float AS qty, unit, price_xof::float AS price, city, status, created_at, expires_at FROM ot_offers WHERE user_id = ${uid}::uuid ORDER BY created_at DESC LIMIT 30`;
    res.json({ member: { kind: m.kind, name: m.display_name, phone: m.phone, whatsapp: m.whatsapp, city: m.city, level: m.level, badge: badge(m.level), status: m.status,
      note: m.note || "", idType: m.id_type, idNumber: mask(m.id_number), ifu: mask(m.ifu), rccm: mask(m.rccm), refCode: m.ref_code,
      referrals: rf.n, referralsVerified: rf.v }, offers: mine, idTypes: ID_TYPES });
  } catch (e) { console.error("OT_ME", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.post("/join", requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const uid = req.user.userId, b = req.body || {};
    const kind = KINDS.includes(b.kind) ? b.kind : "seller";
    const name = clean(b.displayName, 80), phone = clean(b.phone, 20).replace(/[\s.-]/g, ""), wa = clean(b.whatsapp, 20).replace(/[\s.-]/g, ""), city = clean(b.city, 60);
    if (name.length < 3) return res.status(400).json({ error: "Indiquez le nom de votre activité ou votre nom." });
    if (!phoneOk(phone)) return res.status(400).json({ error: "Numéro de téléphone invalide." });
    if (wa && !phoneOk(wa)) return res.status(400).json({ error: "Numéro WhatsApp invalide." });
    if (city.length < 2) return res.status(400).json({ error: "Indiquez votre ville." });
    let idType = null, idNumber = null, ifu = null, rccm = null, level = 0, status = "verified";
    if (kind !== "buyer") {
      idType = ID_TYPES.includes(b.idType) ? b.idType : null; idNumber = clean(b.idNumber, 40);
      if (!idType || idNumber.length < 5) return res.status(400).json({ error: "Une pièce d'identité valide est obligatoire pour publier." });
      ifu = digits(b.ifu, 20); rccm = clean(b.rccm, 40);
      if ((ifu || rccm) && !(ifu.length >= 10 && rccm.length >= 6)) return res.status(400).json({ error: "Pour le niveau Partenaire certifié, indiquez l'IFU (10 chiffres ou plus) et le registre de commerce." });
      status = "pending";
    }
    const [old] = await sql()`SELECT ref_code FROM ot_members WHERE user_id = ${uid}::uuid`;
    if (old) return res.status(409).json({ error: "Vous êtes déjà inscrit." });
    let ref = String(b.ref || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    if (ref) { const [r] = await sql()`SELECT ref_code FROM ot_members WHERE ref_code = ${ref}`; if (!r) ref = ""; }
    let code = newRef();
    for (let i = 0; i < 5; i++) { const [x] = await sql()`SELECT 1 FROM ot_members WHERE ref_code = ${code}`; if (!x) break; code = newRef(); }
    await sql()`INSERT INTO ot_members (user_id, kind, display_name, phone, whatsapp, city, id_type, id_number, ifu, rccm, level, status, ref_code, referred_by)
      VALUES (${uid}::uuid, ${kind}, ${name}, ${phone}, ${wa || null}, ${city}, ${idType}, ${idNumber}, ${ifu || null}, ${rccm || null}, ${level}, ${status}, ${code}, ${ref || null})`;
    res.status(201).json({ ok: true, status, message: kind === "buyer" ? "Inscription enregistrée." : "Demande reçue. Votre identité sera vérifiée par OMNIPAY avant publication." });
  } catch (e) { console.error("OT_JOIN", e.message); res.status(500).json({ error: "Impossible d'enregistrer la demande." }); }
});

router.post("/price", requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const uid = req.user.userId, b = req.body || {};
    if (!(await verifiedMember(uid))) return res.status(403).json({ error: "Réservé aux membres vérifiés." });
    const product = clean(b.product, 40), city = clean(b.city, 60), market = clean(b.market, 80);
    const price = Number(b.price);
    const [p] = await sql()`SELECT unit FROM ot_products WHERE slug = ${product} AND active`;
    if (!p) return res.status(400).json({ error: "Produit inconnu." });
    if (!(price >= 10 && price <= 10000000)) return res.status(400).json({ error: "Prix invalide." });
    if (city.length < 2) return res.status(400).json({ error: "Indiquez la ville." });
    const [c] = await sql()`SELECT count(*)::int AS n FROM ot_prices WHERE user_id = ${uid}::uuid AND created_at > now() - interval '1 day'`;
    if (c.n >= MAX_PRICES_DAY) return res.status(429).json({ error: "Limite de relevés atteinte pour aujourd'hui." });
    // Garde-fou : prix aberrant par rapport aux relevés récents de la même ville.
    const ref = await sql()`SELECT price_xof::float AS p FROM ot_prices WHERE product = ${product} AND lower(city) = lower(${city}) AND created_at > now() - interval '14 days' LIMIT 50`;
    if (ref.length >= 3) { const m = median(ref.map((x) => x.p)); if (price > m * 4 || price < m / 4) return res.status(422).json({ error: "Ce prix s'écarte fortement des relevés récents. Vérifiez le montant et l'unité." }); }
    await sql()`INSERT INTO ot_prices (product, market, city, price_xof, unit, user_id) VALUES (${product}, ${market || null}, ${city}, ${price}, ${p.unit}, ${uid}::uuid)`;
    res.status(201).json({ ok: true });
  } catch (e) { console.error("OT_PRICE", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.post("/offers", requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const uid = req.user.userId, b = req.body || {};
    const m = await verifiedMember(uid);
    if (!m) return res.status(403).json({ error: "Réservé aux vendeurs vérifiés." });
    const product = clean(b.product, 40), city = clean(b.city || m.city, 60), market = clean(b.market, 80), note = clean(b.note, 200);
    const qty = Number(b.qty), price = Number(b.price), unit = UNITS.includes(b.unit) ? b.unit : null;
    const [p] = await sql()`SELECT unit FROM ot_products WHERE slug = ${product} AND active`;
    if (!p) return res.status(400).json({ error: "Produit inconnu." });
    if (!(qty > 0 && qty <= 1000000)) return res.status(400).json({ error: "Quantité invalide." });
    if (!(price >= 10 && price <= 100000000)) return res.status(400).json({ error: "Prix invalide." });
    if (!unit) return res.status(400).json({ error: "Unité invalide." });
    if (/(\+?\d[\s.-]?){8,}/.test(note) || /https?:|www\./i.test(note)) return res.status(400).json({ error: "N'écrivez pas de numéro ni de lien dans la note : le contact se fait par le bouton Contacter." });
    const [c] = await sql()`SELECT count(*)::int AS n FROM ot_offers WHERE user_id = ${uid}::uuid AND status = 'active' AND expires_at > now()`;
    if (c.n >= MAX_OFFERS_OPEN) return res.status(429).json({ error: "Vous avez déjà beaucoup d'offres ouvertes. Fermez-en avant d'en publier." });
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(b.availableFrom || "")) ? b.availableFrom : null;
    const [o] = await sql()`INSERT INTO ot_offers (user_id, product, qty, unit, price_xof, city, market, available_from, note) VALUES (${uid}::uuid, ${product}, ${qty}, ${unit}, ${price}, ${city}, ${market || null}, ${from}, ${note || null}) RETURNING id`;
    res.status(201).json({ ok: true, id: o.id });
  } catch (e) { console.error("OT_OFFER", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.post("/offers/:id/close", requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Offre invalide." });
    const r = await sql()`UPDATE ot_offers SET status = 'closed' WHERE id = ${id} AND user_id = ${req.user.userId}::uuid RETURNING id`;
    res.json({ ok: r.length > 0 });
  } catch (e) { console.error("OT_CLOSE", e.message); res.status(500).json({ error: "Erreur." }); }
});

// ---------- Administration ----------
router.get("/admin/pending", adminOnly, async (req, res) => {
  try {
    await ensureTables();
    const rows = await sql()`SELECT user_id, kind, display_name, phone, whatsapp, city, id_type, id_number, ifu, rccm, level, status, ref_code, referred_by, created_at
      FROM ot_members WHERE status = 'pending' ORDER BY created_at LIMIT 100`;
    res.json({ pending: rows });
  } catch (e) { console.error("OT_PENDING", e.message); res.status(500).json({ error: "Erreur." }); }
});

// body : { userId, decision: "verify"|"reject"|"suspend", level: 1|2, note }
router.post("/admin/decide", adminOnly, async (req, res) => {
  try {
    await ensureTables();
    const b = req.body || {}, uid = clean(b.userId, 40), d = String(b.decision || "");
    if (!/^[0-9a-f-]{36}$/i.test(uid)) return res.status(400).json({ error: "Identifiant invalide." });
    const note = clean(b.note, 200);
    if (d === "verify") {
      const level = Number(b.level) === 2 ? 2 : 1;
      const [m] = await sql()`SELECT ifu, rccm FROM ot_members WHERE user_id = ${uid}::uuid`;
      if (!m) return res.status(404).json({ error: "Membre introuvable." });
      if (level === 2 && !(m.ifu && m.rccm)) return res.status(400).json({ error: "IFU et registre de commerce requis pour le niveau 2." });
      await sql()`UPDATE ot_members SET status = 'verified', level = ${level}, note = ${note || null}, verified_at = now() WHERE user_id = ${uid}::uuid`;
    } else if (d === "reject" || d === "suspend") {
      await sql()`UPDATE ot_members SET status = ${d === "reject" ? "rejected" : "suspended"}, level = 0, note = ${note || null} WHERE user_id = ${uid}::uuid`;
      await sql()`UPDATE ot_offers SET status = 'closed' WHERE user_id = ${uid}::uuid AND status = 'active'`;
    } else return res.status(400).json({ error: "Décision invalide." });
    res.json({ ok: true });
  } catch (e) { console.error("OT_DECIDE", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.get("/admin/stats", adminOnly, async (req, res) => {
  try {
    await ensureTables();
    const [a] = await sql()`SELECT count(*)::int AS members, count(*) FILTER (WHERE status = 'verified')::int AS verified, count(*) FILTER (WHERE status = 'pending')::int AS pending,
      count(*) FILTER (WHERE level = 2)::int AS certified FROM ot_members`;
    const [b] = await sql()`SELECT count(*)::int AS active_offers FROM ot_offers WHERE status = 'active' AND expires_at > now()`;
    const [c] = await sql()`SELECT count(*)::int AS prices_7d FROM ot_prices WHERE created_at > now() - interval '7 days'`;
    res.json({ ...a, ...b, ...c });
  } catch (e) { console.error("OT_STATS", e.message); res.status(500).json({ error: "Erreur." }); }
});

module.exports = router;
