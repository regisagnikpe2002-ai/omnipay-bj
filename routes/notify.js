"use strict";
// OMNIPAY — CENTRE DE NOTIFICATIONS (la cloche) + ABONNEMENTS. FICHIER AJOUTÉ, aucune migration destructive.
// Client : GET /api/notify            fil de notifications (opérations, crypto, annonces, rappels d'abonnement) + nombre de non lues
//          POST /api/notify/read      marque tout comme lu
//          GET /api/notify/plans      offres d'abonnement + abonnement du client
//          POST /api/notify/subscribe { plan:"pro", autoRenew:true }  paiement depuis le solde, atomique
//          POST /api/notify/autorenew { on:true|false }
// Admin  : POST /api/notify/admin/broadcast { title, body, go, days }   annonce pour tous les clients (clé admin)
// Abonnement : renouvellement automatique (si activé) vérifié toutes les 30 min ; rappel 3 jours avant l'échéance ; notification en cas d'échec.
// Réglages : PLAN_PRO_XOF (2500), PLAN_DAYS (30).
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const UUID_OK = (s) => /^[0-9a-f-]{36}$/i.test(String(s || ""));
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const days = () => Math.round(num("PLAN_DAYS", 30));
const PLANS = () => ({
  essentiel: { id: "essentiel", name: "Essentiel", price: 0, perks: ["Portefeuille, transferts, recharges", "Crypto et numéros virtuels", "Liens de paiement en mode test"] },
  pro: { id: "pro", name: "Pro", price: Math.round(num("PLAN_PRO_XOF", 2500)), perks: ["API Business en mode réel", "Liens de paiement et webhooks illimités", "Frais réduits sur les encaissements", "Assistance prioritaire"] },
});
const fx = (n) => Math.round(Number(n)).toLocaleString("fr-FR").replace(/ | /g, " ") + " FCFA";

let ready = false;
async function ensure() {
  if (ready) return;
  const q = sql();
  await q`CREATE TABLE IF NOT EXISTS notif_broadcast (id serial PRIMARY KEY, title varchar(80) NOT NULL, body varchar(300) NOT NULL, go varchar(20), created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL)`;
  await q`CREATE TABLE IF NOT EXISTS notif_user (id serial PRIMARY KEY, user_id uuid NOT NULL, dedupe varchar(80), title varchar(80) NOT NULL, body varchar(300) NOT NULL, go varchar(20), created_at timestamptz NOT NULL DEFAULT now())`;
  await q`CREATE UNIQUE INDEX IF NOT EXISTS notif_user_dd ON notif_user (user_id, dedupe) WHERE dedupe IS NOT NULL`;
  await q`CREATE TABLE IF NOT EXISTS notif_state (user_id uuid PRIMARY KEY, last_read timestamptz NOT NULL DEFAULT now())`;
  await q`CREATE TABLE IF NOT EXISTS subs (user_id uuid PRIMARY KEY, plan varchar(12) NOT NULL, status varchar(10) NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, auto_renew boolean NOT NULL DEFAULT true)`;
  ready = true;
}
async function hasTable(q, n) { try { const r = await q`SELECT to_regclass(${"public." + n}) AS t`; return Boolean(r[0] && r[0].t); } catch (_) { return false; } }
async function pushUser(uid, title, body, go, dedupe) {
  try { await sql()`INSERT INTO notif_user (user_id, dedupe, title, body, go) VALUES (${uid}::uuid, ${dedupe || null}, ${title}, ${body}, ${go || null}) ON CONFLICT DO NOTHING`; } catch (e) { console.error("NOTIF_PUSH", e.message); }
}
const proActive = async (uid) => { try { const r = await sql()`SELECT 1 FROM subs WHERE user_id = ${uid}::uuid AND plan = 'pro' AND status = 'active' AND expires_at > now()`; return r.length > 0; } catch (_) { return false; } };

function txItem(t) {
  const a = fx(t.amount), p = t.provider || "", s = t.status;
  if (t.type === "deposit") return s === "completed" ? ["💰", "Dépôt reçu", a + " ajoutés à votre solde.", "hist"] : null;
  if (t.type === "transfer_in") return ["📥", "Paiement reçu", a + " reçus sur votre solde.", "hist"];
  if (t.type === "transfer_out") return ["📤", "Paiement envoyé", a + " envoyés.", "hist"];
  if (t.type === "refund") return ["↩️", "Remboursement", a + " remis sur votre solde.", "hist"];
  if (t.type === "withdrawal") {
    const what = p === "bundle" ? "Recharge" : p === "virtualnum" ? "Numéro virtuel" : p === "omnichange" ? "Achat crypto" : p === "subscription" ? "Abonnement" : "Retrait";
    if (s === "completed") return ["✅", what + " effectué", a + ".", "hist"];
    if (s === "failed") return ["⚠️", what + " non abouti", a + ". Vous pouvez récupérer vos fonds depuis l'historique.", "hist"];
    if (s === "refunded") return ["↩️", what + " remboursé", a + " remis sur votre solde.", "hist"];
    if (s === "pending" || s === "processing") return ["⏳", what + " en cours", a + " en cours de traitement.", "hist"];
  }
  return null;
}

router.get("/", requireAuth, async (req, res) => {
  try {
    await ensure(); const q = sql(), uid = req.user.userId, items = [];
    const [st] = await q`SELECT last_read FROM notif_state WHERE user_id = ${uid}::uuid`;
    const lastRead = st ? new Date(st.last_read).getTime() : 0;
    const txs = await q`SELECT t.id, t.type, t.amount::float AS amount, t.status, t.provider, t.created_at FROM transactions t JOIN wallets w ON w.id = t.wallet_id
      WHERE w.user_id = ${uid}::uuid AND t.created_at > now() - interval '14 days' AND t.type <> 'commission' ORDER BY t.created_at DESC LIMIT 40`;
    for (const t of txs) { const x = txItem(t); if (x) items.push({ id: "t" + t.id, icon: x[0], title: x[1], body: x[2], go: x[3], at: t.created_at }); }
    if (await hasTable(q, "ex_orders")) {
      const eo = await q`SELECT id, side, asset, qty::float AS qty, status, created_at FROM ex_orders WHERE user_id = ${uid}::uuid AND created_at > now() - interval '14 days' AND side IN ('deposit','withdraw') AND status IN ('done','rejected') ORDER BY created_at DESC LIMIT 20`;
      for (const o of eo) items.push({ id: "e" + o.id, icon: o.status === "done" ? "🪙" : "⚠️", title: (o.side === "deposit" ? "Dépôt crypto " : "Retrait crypto ") + (o.status === "done" ? (o.side === "deposit" ? "crédité" : "envoyé") : "refusé"),
        body: o.qty + " " + o.asset + (o.status === "rejected" ? ". Vos fonds ont été remis dans votre portefeuille." : "."), go: "crypto", at: o.created_at });
    }
    const un = await q`SELECT id, title, body, go, created_at FROM notif_user WHERE user_id = ${uid}::uuid AND created_at > now() - interval '30 days' ORDER BY created_at DESC LIMIT 20`;
    for (const n of un) items.push({ id: "u" + n.id, icon: "🔔", title: n.title, body: n.body, go: n.go, at: n.created_at });
    const bc = await q`SELECT id, title, body, go, created_at FROM notif_broadcast WHERE expires_at > now() ORDER BY created_at DESC LIMIT 10`;
    for (const n of bc) items.push({ id: "b" + n.id, icon: "📣", title: n.title, body: n.body, go: n.go, at: n.created_at });
    // rappel d'échéance calculé à la volée
    const [sub] = await q`SELECT plan, expires_at, auto_renew, status FROM subs WHERE user_id = ${uid}::uuid`;
    if (sub && sub.status === "active") { const left = (new Date(sub.expires_at).getTime() - Date.now()) / 864e5; if (left > 0 && left <= 3) items.push({ id: "s-" + new Date(sub.expires_at).getTime(), icon: "⏰", title: "Votre abonnement Pro se termine bientôt", body: sub.auto_renew ? "Il sera renouvelé automatiquement depuis votre solde." : "Renouvelez-le pour garder vos avantages.", go: "plan", at: new Date().toISOString() }); }
    items.sort((a, b) => new Date(b.at) - new Date(a.at));
    const out = items.slice(0, 40).map((i) => ({ ...i, unread: new Date(i.at).getTime() > lastRead }));
    res.json({ items: out, unread: out.filter((i) => i.unread).length });
  } catch (e) { console.error("NOTIFY", e.message); res.status(500).json({ error: "Erreur." }); }
});
router.post("/read", requireAuth, async (req, res) => {
  try { await ensure(); await sql()`INSERT INTO notif_state (user_id, last_read) VALUES (${req.user.userId}::uuid, now()) ON CONFLICT (user_id) DO UPDATE SET last_read = now()`; res.json({ ok: true }); }
  catch (e) { console.error("NOTIFY_READ", e.message); res.status(500).json({ error: "Erreur." }); }
});
router.post("/admin/broadcast", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Accès refusé." });
  try {
    await ensure(); const b = req.body || {}, title = clean(b.title, 80), body = clean(b.body, 300), d = Math.min(Math.max(Math.round(Number(b.days)) || 7, 1), 60);
    if (title.length < 3 || body.length < 3) return res.status(400).json({ error: "Titre et message requis." });
    await sql()`INSERT INTO notif_broadcast (title, body, go, expires_at) VALUES (${title}, ${body}, ${clean(b.go, 20) || null}, now() + make_interval(days => ${d}))`;
    res.status(201).json({ ok: true });
  } catch (e) { console.error("NOTIFY_BC", e.message); res.status(500).json({ error: "Erreur." }); }
});

// ---- Abonnements ----
router.get("/plans", requireAuth, async (req, res) => {
  try { await ensure(); const [s] = await sql()`SELECT plan, status, expires_at, auto_renew FROM subs WHERE user_id = ${req.user.userId}::uuid`;
    res.json({ plans: Object.values(PLANS()), days: days(), mine: s ? { plan: s.plan, status: s.status, expiresAt: s.expires_at, autoRenew: s.auto_renew, active: s.status === "active" && new Date(s.expires_at) > new Date() } : null }); }
  catch (e) { console.error("PLANS", e.message); res.status(500).json({ error: "Erreur." }); }
});
// Paiement + activation en UNE requête : débit gardé par le solde, abonnement prolongé, écriture au journal.
async function charge(uid, price, key, auto) {
  return sql()`
    WITH w AS (UPDATE wallets SET balance = balance - ${price}, updated_at = now() WHERE user_id = ${uid}::uuid AND balance >= ${price} RETURNING id, balance),
    s AS (INSERT INTO subs (user_id, plan, status, expires_at, auto_renew) SELECT ${uid}::uuid, 'pro', 'active', now() + make_interval(days => ${days()}), ${auto}::boolean FROM w
          ON CONFLICT (user_id) DO UPDATE SET plan = 'pro', status = 'active', auto_renew = EXCLUDED.auto_renew,
            expires_at = GREATEST(subs.expires_at, now()) + make_interval(days => ${days()}) RETURNING expires_at),
    t AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key)
          SELECT w.id, 'withdrawal', ${price}, w.balance, 'completed', 'subscription', 'pro', ${key} FROM w, s RETURNING id)
    SELECT w.balance, s.expires_at FROM w, s`;
}
router.post("/subscribe", requireAuth, async (req, res) => {
  try {
    await ensure(); const uid = req.user.userId, plan = PLANS().pro;
    if (String((req.body || {}).plan || "pro") !== "pro") return res.status(400).json({ error: "Offre inconnue." });
    const r = await charge(uid, plan.price, "sub-" + crypto.randomUUID(), (req.body || {}).autoRenew !== false);
    if (!r.length) return res.status(400).json({ error: "Solde insuffisant : il faut " + fx(plan.price) + "." });
    await pushUser(uid, "Abonnement Pro activé", "Valable jusqu'au " + new Date(r[0].expires_at).toLocaleDateString("fr-FR") + ". Merci de votre confiance.", "plan");
    res.status(201).json({ ok: true, expiresAt: r[0].expires_at, newBalance: Number(r[0].balance) });
  } catch (e) { console.error("SUBSCRIBE", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});
router.post("/autorenew", requireAuth, async (req, res) => {
  try { await ensure(); const on = (req.body || {}).on === true; const r = await sql()`UPDATE subs SET auto_renew = ${on}::boolean WHERE user_id = ${req.user.userId}::uuid RETURNING user_id`; res.json({ ok: r.length > 0, autoRenew: on }); }
  catch (e) { console.error("AUTORENEW", e.message); res.status(500).json({ error: "Erreur." }); }
});

// ---- Renouvellements automatiques ----
async function renewals() {
  await ensure(); const q = sql(), plan = PLANS().pro;
  const due = await q`SELECT user_id, expires_at, auto_renew FROM subs WHERE status = 'active' AND expires_at <= now() + interval '3 days' LIMIT 200`;
  for (const s of due) {
    const uid = s.user_id, exp = new Date(s.expires_at), late = exp <= new Date();
    if (!late) { await pushUser(uid, "Abonnement Pro : échéance proche", "Il se termine le " + exp.toLocaleDateString("fr-FR") + (s.auto_renew ? ". Renouvellement automatique prévu." : ". Pensez à le renouveler."), "plan", "pre-" + exp.getTime()); continue; }
    if (s.auto_renew) {
      const r = await charge(uid, plan.price, "sub-" + uid + "-" + exp.getTime(), true).catch(() => []);
      if (r.length) { await pushUser(uid, "Abonnement Pro renouvelé", fx(plan.price) + " débités. Valable jusqu'au " + new Date(r[0].expires_at).toLocaleDateString("fr-FR") + ".", "plan", "ren-" + exp.getTime()); continue; }
      await q`UPDATE subs SET status = 'expired' WHERE user_id = ${uid}::uuid AND status = 'active' AND expires_at <= now()`;
      await pushUser(uid, "Abonnement Pro expiré", "Solde insuffisant pour le renouvellement (" + fx(plan.price) + "). Rechargez puis réabonnez-vous.", "plan", "exp-" + exp.getTime());
    } else {
      await q`UPDATE subs SET status = 'expired' WHERE user_id = ${uid}::uuid AND status = 'active' AND expires_at <= now()`;
      await pushUser(uid, "Abonnement Pro terminé", "Vos avantages Pro sont suspendus. Vous pouvez vous réabonner à tout moment.", "plan", "end-" + exp.getTime());
    }
  }
  return due.length;
}
let LOOP = null;
function start() {
  if (LOOP || !process.env.DATABASE_URL || String(process.env.PLAN_AUTO || "on").toLowerCase() === "off") return;
  LOOP = setInterval(() => renewals().catch((e) => console.error("RENEW", e.message)), 30 * 60000); if (LOOP.unref) LOOP.unref();
  const t0 = setTimeout(() => renewals().catch((e) => console.error("RENEW", e.message)), 45000); if (t0.unref) t0.unref();
}
module.exports = router;
module.exports._renewals = renewals;
module.exports._push = pushUser;
module.exports.proActive = proActive;
start();
