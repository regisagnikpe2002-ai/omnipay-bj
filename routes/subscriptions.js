"use strict";
// OMNIPAY — ABONNEMENTS TV (Canal+ et autres). FICHIER AJOUTÉ.
//   Client : GET /api/subs/plans · POST /api/subs/order {planId, decoder, phone} · GET /api/subs/mine
//   Admin (x-admin-key) : GET /api/subs/admin/orders?status= · POST /api/subs/admin/orders/:id/done {ref}
//                         POST /api/subs/admin/orders/:id/refuse {note} (remboursement immédiat)
//                         GET /api/subs/admin/plans · POST /api/subs/admin/plans {id?, provider, name, priceXof, months, active}
// Le client paie avec son solde OMNIPAY : le montant est débité tout de suite (une seule instruction atomique), la commande reste « en attente »
// jusqu'à ce que l'équipe active l'abonnement chez le fournisseur et la marque « faite » ; refusée = remboursée. Les prix sont fixés par l'admin
// (aucun tarif n'est écrit dans le code : ils changent chez le fournisseur).
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." }));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
const MAX_PENDING = 5;

let ready = null;
function ensure() {
  if (!ready) ready = (async () => {
    const q = sql();
    await q`CREATE TABLE IF NOT EXISTS sub_plans (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider varchar(30) NOT NULL DEFAULT 'canal', name text NOT NULL, price_xof numeric NOT NULL,
      months int NOT NULL DEFAULT 1, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now())`;
    await q`CREATE TABLE IF NOT EXISTS sub_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, plan_id uuid, provider varchar(30) NOT NULL, plan_name text NOT NULL, months int NOT NULL DEFAULT 1,
      amount numeric NOT NULL, decoder text NOT NULL, phone text, status varchar(10) NOT NULL DEFAULT 'pending', note text, ref text, created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz)`;
    await q`CREATE INDEX IF NOT EXISTS sub_orders_user ON sub_orders (user_id, created_at DESC)`;
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

router.get("/plans", requireAuth, async (req, res) => {
  try {
    await ensure();
    const r = await sql()`SELECT id, provider, name, price_xof::float AS price, months FROM sub_plans WHERE active ORDER BY provider, price_xof`;
    res.json({ plans: r });
  } catch (e) { console.error("SUBS_PLANS", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/order", requireAuth, async (req, res) => {
  try {
    await ensure();
    const uid = req.user.userId, b = req.body || {};
    if (!UUID.test(String(b.planId || ""))) return res.status(400).json({ error: "Choisissez une formule." });
    const q = sql();
    const pl = await q`SELECT provider FROM sub_plans WHERE id = ${b.planId}::uuid AND active`;
    const isVpn = pl.length && pl[0].provider === "vpn";
    // VPN : l'identifiant est l'adresse e-mail où livrer les accès ; TV : numéro de décodeur ou de carte.
    const decoder = isVpn ? clean(b.decoder, 80).toLowerCase().replace(/[^0-9a-z@._+-]/g, "") : clean(b.decoder, 20).replace(/[^0-9A-Za-z-]/g, "");
    if (isVpn && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(decoder)) return res.status(400).json({ error: "Adresse e-mail invalide : c'est là que vos accès VPN seront envoyés." });
    if (!isVpn && decoder.length < 6) return res.status(400).json({ error: "Numéro de décodeur ou de carte invalide (au moins 6 caractères)." });
    const phone = clean(b.phone, 20).replace(/[^\d+]/g, "");
    const open = await q`SELECT count(*)::int AS n FROM sub_orders WHERE user_id = ${uid}::uuid AND status = 'pending'`;
    if (open[0].n >= MAX_PENDING) return res.status(429).json({ error: "Vous avez déjà des abonnements en cours de traitement. Patientez." });
    const r = await q`WITH p AS (SELECT id, provider, name, price_xof, months FROM sub_plans WHERE id = ${b.planId}::uuid AND active),
      w AS (UPDATE wallets SET balance = balance - p.price_xof, updated_at = now() FROM p WHERE wallets.user_id = ${uid}::uuid AND wallets.balance >= p.price_xof RETURNING wallets.id AS wid, wallets.balance AS bal),
      o AS (INSERT INTO sub_orders (user_id, plan_id, provider, plan_name, months, amount, decoder, phone)
        SELECT ${uid}::uuid, p.id, p.provider, p.name, p.months, p.price_xof, ${decoder}, ${phone || null} FROM p, w RETURNING id, amount, plan_name),
      t AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key, metadata)
        SELECT w.wid, 'transfer_out', o.amount, w.bal, 'completed', 'subscription', o.id::text, 'sub-out-' || o.id::text, jsonb_build_object('subscription', 'order') FROM w, o RETURNING id)
      SELECT o.id, o.amount::float AS amount, o.plan_name FROM o`;
    if (!r.length) {
      const p = await q`SELECT 1 FROM sub_plans WHERE id = ${b.planId}::uuid AND active`;
      return res.status(p.length ? 400 : 404).json({ error: p.length ? "Solde insuffisant." : "Formule indisponible." });
    }
    res.status(201).json({ id: r[0].id, message: `Commande enregistrée : ${r[0].plan_name} (${r[0].amount} FCFA débités). L'abonnement est activé par notre équipe, en général sous peu. Si nous ne pouvons pas l'activer, vous êtes remboursé.` });
  } catch (e) { console.error("SUBS_ORDER", e.message); res.status(500).json({ error: "Impossible d'enregistrer la commande." }); }
});

router.get("/mine", requireAuth, async (req, res) => {
  try {
    await ensure();
    const r = await sql()`SELECT id, provider, plan_name, months, amount::float AS amount, decoder, status, note, CASE WHEN status = 'done' AND provider = 'vpn' THEN ref END AS ref, created_at, decided_at FROM sub_orders WHERE user_id = ${req.user.userId}::uuid ORDER BY created_at DESC LIMIT 30`;
    res.json({ orders: r });
  } catch (e) { console.error("SUBS_MINE", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

// ---------- Admin ----------
router.get("/admin/orders", adminOnly, async (req, res) => {
  try {
    await ensure();
    const st = ["pending", "done", "refused"].includes(req.query.status) ? req.query.status : null;
    const q = sql();
    const r = await q`SELECT id, user_id, provider, plan_name, months, amount::float AS amount, decoder, phone, status, note, ref, created_at, decided_at
      FROM sub_orders WHERE (${st}::text IS NULL OR status = ${st}) ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 100`;
    let codes = {};
    try { const c = await q`SELECT user_id, code FROM account_ids WHERE user_id = ANY(${[...new Set(r.map((o) => o.user_id))]}::uuid[])`; c.forEach((x) => { codes[x.user_id] = x.code; }); } catch (_) { /* identifiants non disponibles : repli ci-dessous */ }
    r.forEach((o) => { o.client = codes[o.user_id] || String(o.user_id).slice(0, 8); delete o.user_id; });
    res.json({ orders: r });
  } catch (e) { console.error("SUBS_ADMIN_LIST", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/admin/orders/:id/done", adminOnly, async (req, res) => {
  try {
    await ensure();
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    const r = await sql()`UPDATE sub_orders SET status = 'done', ref = ${clean(req.body && req.body.ref, 200) || null}, decided_at = now() WHERE id = ${req.params.id}::uuid AND status = 'pending' RETURNING id`;
    if (!r.length) return res.status(409).json({ error: "Commande introuvable ou déjà traitée." });
    res.json({ ok: true });
  } catch (e) { console.error("SUBS_DONE", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/admin/orders/:id/refuse", adminOnly, async (req, res) => {
  try {
    await ensure();
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    const note = clean(req.body && req.body.note, 160);
    if (note.length < 3) return res.status(400).json({ error: "Indiquez le motif (3 caractères minimum)." });
    const r = await sql()`WITH o AS (UPDATE sub_orders SET status = 'refused', note = ${note}, decided_at = now() WHERE id = ${req.params.id}::uuid AND status = 'pending' RETURNING id, user_id, amount),
      w AS (UPDATE wallets SET balance = balance + o.amount, updated_at = now() FROM o WHERE wallets.user_id = o.user_id RETURNING wallets.id AS wid, wallets.balance AS bal, o.id AS oid, o.amount AS am),
      t AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key, metadata)
        SELECT wid, 'refund', am, bal, 'completed', 'subscription', oid::text, 'sub-refund-' || oid::text, jsonb_build_object('subscription', 'refund') FROM w RETURNING id)
      SELECT oid FROM w`;
    if (!r.length) return res.status(409).json({ error: "Commande introuvable ou déjà traitée." });
    res.json({ ok: true, refunded: true });
  } catch (e) { console.error("SUBS_REFUSE", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.get("/admin/plans", adminOnly, async (req, res) => {
  try { await ensure(); res.json({ plans: await sql()`SELECT id, provider, name, price_xof::float AS price, months, active FROM sub_plans ORDER BY provider, price_xof` }); }
  catch (e) { console.error("SUBS_ADMIN_PLANS", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/admin/plans", adminOnly, async (req, res) => {
  try {
    await ensure();
    const b = req.body || {}, name = clean(b.name, 80), provider = clean(b.provider || "canal", 30).toLowerCase().replace(/[^a-z0-9-]/g, "") || "canal";
    const price = Math.round(Number(b.priceXof)), months = Math.round(Number(b.months || 1));
    if (name.length < 2) return res.status(400).json({ error: "Nom de la formule requis." });
    if (!Number.isFinite(price) || price < 100 || price > 500000) return res.status(400).json({ error: "Prix invalide (100 à 500 000 FCFA)." });
    if (!Number.isFinite(months) || months < 1 || months > 12) return res.status(400).json({ error: "Durée : 1 à 12 mois." });
    const active = b.active !== false;
    const q = sql();
    if (b.id) {
      if (!UUID.test(String(b.id))) return res.status(400).json({ error: "Identifiant invalide." });
      const r = await q`UPDATE sub_plans SET provider = ${provider}, name = ${name}, price_xof = ${price}, months = ${months}, active = ${active} WHERE id = ${b.id}::uuid RETURNING id`;
      if (!r.length) return res.status(404).json({ error: "Formule introuvable." });
      return res.json({ ok: true, id: r[0].id });
    }
    const r = await q`INSERT INTO sub_plans (provider, name, price_xof, months, active) VALUES (${provider}, ${name}, ${price}, ${months}, ${active}) RETURNING id`;
    res.status(201).json({ ok: true, id: r[0].id });
  } catch (e) { console.error("SUBS_ADMIN_PLAN_SAVE", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;
