"use strict";
// OMNIPAY — Numéros SIM africains (MTN, Moov, Celtiis…) : FICHIER AJOUTÉ.
// Le client choisit un pays et un opérateur. Deux modes de livraison, honnêtes :
//   - "stock"  : OMNIPAY a des numéros en stock (chargés par l'admin) -> numéro livré tout de suite ;
//   - "order"  : pas de stock -> commande en attente, livrée par l'équipe sous SIM_DELIVERY_HOURS (défaut 24 h).
// Option "à mon nom" : le client donne nom + pièce d'identité ; l'équipe enregistre la ligne chez l'opérateur (toujours livraison manuelle).
// Débit atomique, annulation = remboursement atomique. Aucun faux numéro n'est jamais affiché.
// Réglages (Render) : SIM_PRICE_XOF (3000), SIM_REGISTER_FEE_XOF (1000), SIM_PRICE_<ISO>_<OP> (ex SIM_PRICE_BJ_MTN), SIM_DELIVERY_HOURS, SIM_ENABLED=off.
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const CATALOG = [
  { iso: "BJ", name: "Bénin", ops: ["MTN", "Moov", "Celtiis"] },
  { iso: "TG", name: "Togo", ops: ["Moov", "Togocel"] },
  { iso: "CI", name: "Côte d'Ivoire", ops: ["MTN", "Moov", "Orange"] },
  { iso: "SN", name: "Sénégal", ops: ["Orange", "Free", "Expresso"] },
  { iso: "BF", name: "Burkina Faso", ops: ["Moov", "Orange"] },
  { iso: "NE", name: "Niger", ops: ["Moov", "Airtel"] },
  { iso: "ML", name: "Mali", ops: ["Moov", "Orange"] },
  { iso: "GH", name: "Ghana", ops: ["MTN", "Telecel"] },
  { iso: "NG", name: "Nigeria", ops: ["MTN", "Airtel", "Glo"] },
  { iso: "CM", name: "Cameroun", ops: ["MTN", "Orange"] },
];
const ID_TYPES = ["CNI", "Passeport", "Permis", "Carte d'électeur", "Autre"];
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);
const num = (v, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 ? n : d; };
const enabled = () => String(process.env.SIM_ENABLED || "on").toLowerCase() !== "off";
const hours = () => num(process.env.SIM_DELIVERY_HOURS, 24) || 24;
const regFee = () => num(process.env.SIM_REGISTER_FEE_XOF, 1000);
const op = (iso, name) => { const c = CATALOG.find((x) => x.iso === iso); return c && c.ops.includes(name) ? c : null; };
const priceOf = (iso, o) => num(process.env["SIM_PRICE_" + iso + "_" + String(o).toUpperCase()], num(process.env.SIM_PRICE_XOF, 3000));
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." }));
const phoneOk = (s) => /^\+?[0-9]{8,15}$/.test(s);
let ready = false;
const busy = new Set();

async function ensureTables() {
  if (ready) return;
  const q = sql();
  await q`CREATE TABLE IF NOT EXISTS sim_stock (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), iso varchar(2) NOT NULL, operator varchar(20) NOT NULL,
    number varchar(20) NOT NULL UNIQUE, status varchar(10) NOT NULL DEFAULT 'free', created_at timestamptz NOT NULL DEFAULT now())`;
  await q`CREATE TABLE IF NOT EXISTS sim_orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, iso varchar(2) NOT NULL, operator varchar(20) NOT NULL,
    price_xof numeric(18,2) NOT NULL, in_my_name boolean NOT NULL DEFAULT false, holder_name varchar(120), id_type varchar(30), id_number varchar(40),
    status varchar(12) NOT NULL DEFAULT 'pending', number varchar(20), note varchar(200),
    created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz)`;
  await q`CREATE INDEX IF NOT EXISTS sim_orders_user ON sim_orders (user_id, created_at DESC)`;
  await q`CREATE INDEX IF NOT EXISTS sim_stock_free ON sim_stock (iso, operator, status)`;
  ready = true;
}
const maskId = (s) => (s ? "••••" + String(s).slice(-3) : null);
const pub = (r) => ({ id: r.id, iso: r.iso, operator: r.operator, price: Number(r.price_xof), inMyName: r.in_my_name, holderName: r.holder_name,
  idNumber: maskId(r.id_number), status: r.status, number: r.number, note: r.note, createdAt: r.created_at, deliveredAt: r.delivered_at });

router.get("/catalog", requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const rows = await sql()`SELECT iso, operator, count(*)::int AS n FROM sim_stock WHERE status = 'free' GROUP BY iso, operator`;
    const st = {}; rows.forEach((r) => { st[r.iso + "/" + r.operator] = r.n; });
    res.json({ enabled: enabled(), deliveryHours: hours(), registerFee: regFee(), idTypes: ID_TYPES,
      countries: CATALOG.map((c) => ({ iso: c.iso, name: c.name, ops: c.ops.map((o) => {
        const n = st[c.iso + "/" + o] || 0;
        return { name: o, price: priceOf(c.iso, o), mode: n > 0 ? "stock" : "order" };
      }) })) });
  } catch (e) { console.error("SIM_CATALOG", e.message); res.status(500).json({ error: "Catalogue indisponible." }); }
});

router.post("/order", requireAuth, async (req, res) => {
  const uid = req.user.userId;
  if (busy.has(uid)) return res.status(429).json({ error: "Une commande est déjà en cours." });
  busy.add(uid);
  try {
    if (!enabled()) return res.status(503).json({ error: "Service en cours d'activation." });
    const iso = clean(req.body?.iso, 2).toUpperCase(), opn = clean(req.body?.operator, 20);
    if (!op(iso, opn)) return res.status(400).json({ error: "Choisissez un pays et un opérateur." });
    const mine = req.body?.inMyName === true;
    let holder = null, idType = null, idNum = null;
    if (mine) {
      holder = clean(req.body?.holderName, 120); idType = clean(req.body?.idType, 30); idNum = clean(req.body?.idNumber, 40);
      if (holder.length < 5 || !holder.includes(" ")) return res.status(400).json({ error: "Indiquez votre nom et prénom tels que sur votre pièce." });
      if (!ID_TYPES.includes(idType)) return res.status(400).json({ error: "Choisissez le type de pièce." });
      if (idNum.length < 5) return res.status(400).json({ error: "Numéro de pièce invalide." });
    }
    await ensureTables();
    const q = sql();
    const [c] = await q`SELECT count(*) FILTER (WHERE status = 'pending')::int AS open, count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS day FROM sim_orders WHERE user_id = ${uid}`;
    if (c.open >= 3) return res.status(429).json({ error: "Vous avez déjà 3 commandes en attente de livraison." });
    if (c.day >= 5) return res.status(429).json({ error: "Limite journalière atteinte." });
    const amount = priceOf(iso, opn) + (mine ? regFee() : 0);
    const key = "sim-" + crypto.randomUUID();
    const rows = await q`
      WITH w AS (UPDATE wallets SET balance = balance - ${amount} WHERE user_id = ${uid} AND balance >= ${amount} RETURNING id, balance),
      o AS (INSERT INTO sim_orders (user_id, iso, operator, price_xof, in_my_name, holder_name, id_type, id_number)
            SELECT ${uid}, ${iso}, ${opn}, ${amount}, ${mine}, ${holder}, ${idType}, ${idNum} FROM w RETURNING id),
      t AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key)
            SELECT w.id, 'withdrawal', ${amount}, w.balance, 'pending', 'simnumber', o.id::text, ${key} FROM w, o RETURNING id)
      SELECT o.id, w.balance FROM o, w`;
    if (!rows.length) return res.status(400).json({ error: "Solde insuffisant." });
    const id = rows[0].id;
    let order = null;
    if (!mine) {
      // Numéro en stock : attribution atomique (une seule commande peut prendre un numéro donné).
      const got = await q`
        WITH s AS (SELECT id FROM sim_stock WHERE iso = ${iso} AND operator = ${opn} AND status = 'free' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED),
        u AS (UPDATE sim_stock SET status = 'sold' WHERE id IN (SELECT id FROM s) RETURNING number),
        o AS (UPDATE sim_orders SET status = 'ready', number = (SELECT number FROM u), delivered_at = now()
              WHERE id = ${id}::uuid AND EXISTS (SELECT 1 FROM u) RETURNING *),
        t AS (UPDATE transactions SET status = 'completed' WHERE provider = 'simnumber' AND provider_ref = ${id} AND EXISTS (SELECT 1 FROM o) RETURNING id)
        SELECT * FROM o`;
      if (got.length) order = got[0];
    }
    if (!order) [order] = await q`SELECT * FROM sim_orders WHERE id = ${id}::uuid`;
    res.status(201).json({ order: pub(order), deliveryHours: hours(), newBalance: Number(rows[0].balance) });
  } catch (e) { console.error("SIM_ORDER", e.message); res.status(500).json({ error: "Impossible de traiter la commande." }); }
  finally { busy.delete(uid); }
});

router.get("/mine", requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const rows = await sql()`SELECT * FROM sim_orders WHERE user_id = ${req.user.userId} ORDER BY created_at DESC LIMIT 30`;
    res.json({ orders: rows.map(pub) });
  } catch (e) { console.error("SIM_MINE", e.message); res.status(500).json({ error: "Historique indisponible." }); }
});

// ---- Admin ----
router.post("/admin/stock", adminOnly, async (req, res) => {
  try {
    await ensureTables();
    const iso = clean(req.body?.iso, 2).toUpperCase(), opn = clean(req.body?.operator, 20);
    if (!op(iso, opn)) return res.status(400).json({ error: "Pays ou opérateur inconnu." });
    const list = (Array.isArray(req.body?.numbers) ? req.body.numbers : []).map((n) => clean(n, 20).replace(/[\s.+-]/g, "")).filter(phoneOk).slice(0, 500);
    if (!list.length) return res.status(400).json({ error: "Aucun numéro valide." });
    let added = 0;
    for (const n of list) { const r = await sql()`INSERT INTO sim_stock (iso, operator, number) VALUES (${iso}, ${opn}, ${n}) ON CONFLICT (number) DO NOTHING RETURNING id`; added += r.length; }
    res.json({ added, ignored: list.length - added });
  } catch (e) { console.error("SIM_STOCK", e.message); res.status(500).json({ error: "Erreur." }); }
});
router.get("/admin/orders", adminOnly, async (req, res) => {
  try {
    await ensureTables();
    const st = clean(req.query.status, 12) || "pending";
    const rows = await sql()`SELECT * FROM sim_orders WHERE status = ${st} ORDER BY created_at LIMIT 100`;
    res.json({ orders: rows.map((r) => ({ ...pub(r), userId: r.user_id, idType: r.id_type, idNumberFull: r.id_number })) });
  } catch (e) { console.error("SIM_ADM", e.message); res.status(500).json({ error: "Erreur." }); }
});
router.post("/admin/orders/:id/deliver", adminOnly, async (req, res) => {
  try {
    await ensureTables();
    const id = String(req.params.id || ""), number = clean(req.body?.number, 20).replace(/[\s.+-]/g, "");
    if (!/^[0-9a-f-]{36}$/i.test(id) || !phoneOk(number)) return res.status(400).json({ error: "Commande ou numéro invalide." });
    const rows = await sql()`
      WITH o AS (UPDATE sim_orders SET status = 'ready', number = ${number}, delivered_at = now(), note = ${clean(req.body?.note, 200) || null}
                 WHERE id = ${id}::uuid AND status = 'pending' RETURNING id),
      t AS (UPDATE transactions SET status = 'completed' WHERE provider = 'simnumber' AND provider_ref = ${id} AND EXISTS (SELECT 1 FROM o) RETURNING id)
      SELECT id FROM o`;
    if (!rows.length) return res.status(409).json({ error: "Commande déjà traitée ou introuvable." });
    res.json({ ok: true });
  } catch (e) { console.error("SIM_DELIVER", e.message); res.status(500).json({ error: "Erreur." }); }
});
router.post("/admin/orders/:id/cancel", adminOnly, async (req, res) => {
  try {
    await ensureTables();
    const id = String(req.params.id || "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: "Commande invalide." });
    const rows = await sql()`
      WITH o AS (UPDATE sim_orders SET status = 'cancelled', note = ${clean(req.body?.note, 200) || null} WHERE id = ${id}::uuid AND status = 'pending' RETURNING user_id, price_xof),
      w AS (UPDATE wallets SET balance = balance + o.price_xof FROM o WHERE wallets.user_id = o.user_id RETURNING wallets.balance),
      t AS (UPDATE transactions SET status = 'failed' WHERE provider = 'simnumber' AND provider_ref = ${id} AND EXISTS (SELECT 1 FROM o) RETURNING id)
      SELECT balance FROM w`;
    if (!rows.length) return res.status(409).json({ error: "Commande déjà traitée ou introuvable." });
    res.json({ ok: true, refunded: true });
  } catch (e) { console.error("SIM_CANCEL", e.message); res.status(500).json({ error: "Erreur." }); }
});

module.exports = router;
