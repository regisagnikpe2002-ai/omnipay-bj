"use strict";
// OMNIPAY — ORDRES DE PAIEMENT : l'IA RÉDIGE, un MARCHAND HUMAIN exécute, puis validation.
//   1) Rédaction (admin) : pour chaque retrait en attente, le moteur prépare un ordre (opérateur, numéro, montant, voie recommandée, contrôles). Il ne PAIE jamais.
//   2) Prise (marchand actif et « en ligne ») : il réserve l'ordre. Un marchand ne peut jamais prendre l'ordre de sa propre demande ni payer son propre numéro.
//   3) Exécution (marchand) : il paie depuis son compte puis saisit la RÉFÉRENCE réelle de l'opération (unique, jamais réutilisable).
//   4) Validation : sous le seuil (ORDER_ADMIN_XOF, 200 000 F par défaut) l'exécution validée par le marchand clôture le retrait ; au-dessus, l'admin valide en plus (double contrôle).
//   5) Chaque étape est écrite dans order_events (qui, quoi, quand). Un ordre pris mais non exécuté revient à la file après ORDER_TAKE_MINUTES (30 min).
// Le retrait client passe « processing » dès la prise (aucun autre envoi ne peut le doubler) et redevient « pending » si l'ordre est rendu, expire ou est rejeté.
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");
const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const adminLimit = () => num(process.env.ORDER_ADMIN_XOF, 200000);
const takeMinutes = () => num(process.env.ORDER_TAKE_MINUTES, 30);
const maxTaken = () => Math.floor(num(process.env.ORDER_MAX_TAKEN, 3));
const clean = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const last8 = (p) => String(p || "").replace(/\D/g, "").slice(-8);

function adminOnly(req, res, next) {
  const provided = Buffer.from(String(req.headers["x-admin-key"] || "")), expected = Buffer.from(String(process.env.ADMIN_KEY || ""));
  if (!expected.length || provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return res.status(403).json({ error: "Accès refusé." });
  next();
}

let ready = null;
function ensure() {
  if (!ready) ready = (async () => {
    const q = sql();
    await q`CREATE TABLE IF NOT EXISTS payment_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tx_id uuid NOT NULL, requester_id uuid, operator varchar(20) NOT NULL, phone varchar(30) NOT NULL, amount numeric(18,2) NOT NULL,
      route jsonb, checks jsonb, needs_admin boolean NOT NULL DEFAULT false, status varchar(12) NOT NULL DEFAULT 'drafted',
      taken_by uuid, taken_at timestamptz, executed_ref varchar(160), executed_at timestamptz, validated_by varchar(60), validated_at timestamptz, reject_reason varchar(200),
      created_at timestamptz NOT NULL DEFAULT now())`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS payment_orders_one_active ON payment_orders (tx_id) WHERE status IN ('drafted','taken','executed')`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS payment_orders_ref ON payment_orders (lower(executed_ref)) WHERE executed_ref IS NOT NULL`;
    await q`CREATE TABLE IF NOT EXISTS order_events (id bigserial PRIMARY KEY, order_id uuid NOT NULL, actor varchar(80) NOT NULL, action varchar(30) NOT NULL, detail varchar(300), at timestamptz NOT NULL DEFAULT now())`;
    await q`CREATE TABLE IF NOT EXISTS merchant_presence (user_id uuid PRIMARY KEY, online boolean NOT NULL DEFAULT false, last_seen timestamptz NOT NULL DEFAULT now())`;
  })().catch((e) => { ready = null; throw e; });
  return ready;
}
const event = (orderId, actor, action, detail) => sql()`INSERT INTO order_events (order_id, actor, action, detail) VALUES (${orderId}::uuid, ${actor}, ${action}, ${detail ? clean(detail, 300) : null})`;
const fail = (res, tag, e) => { console.error(tag, e.message); res.status(500).json({ error: "Erreur serveur." }); };

// Ordres pris depuis trop longtemps : ils reviennent à la file et le retrait redevient « pending ».
async function expireStale() {
  const q = sql();
  const rows = await q`UPDATE payment_orders SET status = 'drafted', taken_by = NULL, taken_at = NULL
    WHERE status = 'taken' AND taken_at < now() - make_interval(mins => ${takeMinutes()}::int) RETURNING id, tx_id`;
  for (const r of rows) {
    await q`UPDATE transactions SET status = 'pending' WHERE id = ${r.tx_id}::uuid AND type = 'withdrawal' AND status = 'processing'`;
    await event(r.id, "système", "expired", "Non exécuté dans le délai : retour à la file");
  }
  return rows.length;
}

// Clôture du retrait client avec la référence réelle (même règle que « marquer payé »). Renvoie false si le retrait est déjà traité ou si la référence est déjà utilisée.
async function settle(orderId, txId, reference, who, operator) {
  const q = sql();
  const dup = await q`SELECT id FROM transactions WHERE type = 'withdrawal' AND status = 'completed' AND lower(metadata->'settlement'->>'reference') = lower(${reference}::text) LIMIT 1`;
  if (dup.length) return { ok: false, error: "Cette référence de paiement est déjà utilisée." };
  const rows = await q`UPDATE transactions SET status = 'completed', metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object('settlement', jsonb_build_object(
      'channel', ${operator}::text, 'reference', ${reference}::text, 'confirmedAt', now()::text, 'confirmedBy', ${who}::text, 'order', ${orderId}::text))
    WHERE id = ${txId}::uuid AND type = 'withdrawal' AND status IN ('pending','processing') RETURNING id`;
  return rows.length ? { ok: true } : { ok: false, error: "Retrait introuvable ou déjà traité." };
}

// ===================== ADMIN =====================
// Rédaction : l'IA (moteur de fonds) prépare un ordre pour chaque retrait en attente qui n'en a pas.
router.post("/admin/draft", adminOnly, async (req, res) => {
  try {
    await ensure();
    const q = sql(), fm = require("../lib/fundManager.js");
    const [state, policy] = [await fm.loadState(), await fm.getPolicy()];
    const funds = state.funds.map((f) => ({ ...f }));
    const pend = await q`SELECT t.id, t.provider AS operator, t.provider_ref AS phone, t.amount::float AS amount, w.user_id AS requester
      FROM transactions t JOIN wallets w ON w.id = t.wallet_id
      WHERE t.type = 'withdrawal' AND t.status = 'pending' AND t.provider IN ('mtn','moov','celtiis') AND NOT EXISTS (SELECT 1 FROM payment_orders o WHERE o.tx_id = t.id AND o.status IN ('drafted','taken','executed'))
      ORDER BY t.created_at LIMIT 50`;
    let created = 0; const skipped = [];
    for (const t of pend) {
      const d = fm.chooseRoute({ ...state, funds }, { operator: t.operator, amount: t.amount }, policy);
      if (d.hard) { skipped.push({ tx: t.id, reason: d.reasons.join(" ") }); continue; } // couverture insuffisante : pas d'ordre tant que les fonds ne sont pas là
      if (d.ok) { const f = funds.find((x) => x.code === d.choice.code); if (f && f.balance != null) f.balance -= t.amount; }
      const needsAdmin = t.amount >= adminLimit();
      const checks = { coverageOk: !d.hard, routeFound: d.ok, notes: d.reasons || [], needsAdmin, draftedBy: "gestionnaire de fonds" };
      const route = d.choice ? { code: d.choice.code, label: d.choice.label, backup: Boolean(d.choice.backup) } : null;
      const o = await q`INSERT INTO payment_orders (tx_id, requester_id, operator, phone, amount, route, checks, needs_admin)
        VALUES (${t.id}::uuid, ${t.requester}::uuid, ${String(t.operator).replace(/-.*/, "")}, ${t.phone}, ${t.amount}, ${JSON.stringify(route)}::jsonb, ${JSON.stringify(checks)}::jsonb, ${needsAdmin})
        ON CONFLICT DO NOTHING RETURNING id`;
      if (o.length) { created++; await event(o[0].id, "IA (fonds & risque)", "drafted", route ? `voie recommandée : ${route.label}` : "aucune voie automatique : paiement manuel"); }
    }
    res.json({ created, skipped, message: `${created} ordre(s) rédigé(s). Rien n'a été payé : un marchand doit les exécuter.` });
  } catch (e) { fail(res, "ORDERS_DRAFT", e); }
});

router.get("/admin/list", adminOnly, async (req, res) => {
  try {
    await ensure(); await expireStale();
    const st = clean(req.query.status, 12);
    const rows = await sql()`SELECT o.id, o.tx_id, o.operator, o.phone, o.amount::float AS amount, o.route, o.needs_admin, o.status, o.executed_ref, o.executed_at, o.validated_by, o.created_at, o.taken_at,
        a.name AS merchant FROM payment_orders o LEFT JOIN omnicash_agents a ON a.user_id = o.taken_by
      WHERE (${st} = '' OR o.status = ${st}) ORDER BY CASE o.status WHEN 'executed' THEN 0 WHEN 'taken' THEN 1 WHEN 'drafted' THEN 2 ELSE 3 END, o.created_at DESC LIMIT 100`;
    res.json({ adminLimit: adminLimit(), orders: rows });
  } catch (e) { if (/omnicash_agents/.test(e.message)) return res.json({ adminLimit: adminLimit(), orders: [] }); fail(res, "ORDERS_LIST", e); }
});

router.get("/admin/:id/events", adminOnly, async (req, res) => {
  try { if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." }); await ensure(); res.json({ events: await sql()`SELECT actor, action, detail, at FROM order_events WHERE order_id = ${req.params.id}::uuid ORDER BY id` }); }
  catch (e) { fail(res, "ORDERS_EVENTS", e); }
});

// Validation administrateur d'un ordre déjà exécuté (obligatoire au-dessus du seuil).
router.post("/admin/:id/validate", adminOnly, async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    await ensure();
    const claim = await sql()`UPDATE payment_orders SET status = 'validated', validated_by = 'admin', validated_at = now() WHERE id = ${req.params.id}::uuid AND status = 'executed' RETURNING id, tx_id, operator, executed_ref`;
    if (!claim.length) return res.status(409).json({ error: "Ordre introuvable ou pas à l'état « exécuté »." });
    const s = await settle(claim[0].id, claim[0].tx_id, claim[0].executed_ref, "admin+marchand", claim[0].operator);
    if (!s.ok) { await sql()`UPDATE payment_orders SET status = 'executed', validated_by = NULL, validated_at = NULL WHERE id = ${claim[0].id}::uuid`; return res.status(409).json({ error: s.error }); }
    await event(claim[0].id, "admin", "validated", "Retrait clôturé");
    res.json({ message: "Ordre validé : retrait clôturé." });
  } catch (e) { fail(res, "ORDERS_VALIDATE", e); }
});

// Rejet : avant exécution → retour à la file ; après exécution → « litige » (le retrait reste bloqué pour enquête, rien n'est clôturé ni remboursé automatiquement).
router.post("/admin/:id/reject", adminOnly, async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    await ensure();
    const reason = clean(req.body?.reason, 200) || "rejeté par l'administrateur";
    const q = sql();
    const o = (await q`SELECT id, tx_id, status FROM payment_orders WHERE id = ${req.params.id}::uuid`)[0];
    if (!o || !["drafted", "taken", "executed"].includes(o.status)) return res.status(409).json({ error: "Ordre introuvable ou déjà clos." });
    if (o.status === "executed") { await q`UPDATE payment_orders SET status = 'disputed', reject_reason = ${reason} WHERE id = ${o.id}::uuid AND status = 'executed'`; await event(o.id, "admin", "disputed", reason); return res.json({ message: "Ordre mis en litige : le retrait reste bloqué pour vérification." }); }
    await q`UPDATE payment_orders SET status = 'rejected', reject_reason = ${reason} WHERE id = ${o.id}::uuid AND status IN ('drafted','taken')`;
    await q`UPDATE transactions SET status = 'pending' WHERE id = ${o.tx_id}::uuid AND type = 'withdrawal' AND status = 'processing'`;
    await event(o.id, "admin", "rejected", reason);
    res.json({ message: "Ordre rejeté : le retrait est revenu en attente." });
  } catch (e) { fail(res, "ORDERS_REJECT", e); }
});

// ===================== MARCHAND =====================
async function needMerchant(req, res, next) {
  try {
    await ensure();
    const a = (await sql()`SELECT user_id, name, status FROM omnicash_agents WHERE user_id = ${req.user.userId}::uuid`)[0];
    if (!a || a.status !== "active") return res.status(403).json({ error: "Compte marchand OMNICASH non actif." });
    req.merchant = a; next();
  } catch (e) { fail(res, "ORDERS_MERCHANT", e); }
}
const maskName = (s) => { const x = String(s || "").trim(); return x ? x[0].toUpperCase() + "•••" : "Client"; };

router.post("/presence", requireAuth, needMerchant, async (req, res) => {
  try {
    const online = Boolean(req.body?.online);
    await sql()`INSERT INTO merchant_presence (user_id, online, last_seen) VALUES (${req.user.userId}::uuid, ${online}, now()) ON CONFLICT (user_id) DO UPDATE SET online = EXCLUDED.online, last_seen = now()`;
    res.json({ online });
  } catch (e) { fail(res, "ORDERS_PRESENCE", e); }
});

router.get("/available", requireAuth, needMerchant, async (req, res) => {
  try {
    await expireStale();
    const q = sql(), me = req.user.userId;
    const pres = (await q`SELECT online FROM merchant_presence WHERE user_id = ${me}::uuid`)[0];
    const mine = await q`SELECT id, operator, phone, amount::float AS amount, status, route, needs_admin, taken_at FROM payment_orders WHERE taken_by = ${me}::uuid AND status IN ('taken','executed') ORDER BY taken_at DESC`;
    const me2 = (await q`SELECT phone FROM users WHERE id = ${me}::uuid`)[0];
    const avail = pres && pres.online ? await q`SELECT o.id, o.operator, o.amount::float AS amount, o.route, o.needs_admin, o.created_at, u.first_name
      FROM payment_orders o LEFT JOIN users u ON u.id = o.requester_id WHERE o.status = 'drafted' AND o.requester_id IS DISTINCT FROM ${me}::uuid ORDER BY o.created_at LIMIT 30` : [];
    res.json({ online: Boolean(pres && pres.online), maxTaken: maxTaken(), adminLimit: adminLimit(), takeMinutes: takeMinutes(),
      available: avail.map((a) => ({ id: a.id, operator: a.operator, amount: a.amount, route: a.route, needsAdmin: a.needs_admin, client: maskName(a.first_name), createdAt: a.created_at })),
      mine: mine.map((m) => ({ ...m, phone: m.phone, needsAdmin: m.needs_admin })), myPhoneLast8: last8(me2 && me2.phone) });
  } catch (e) { fail(res, "ORDERS_AVAILABLE", e); }
});

router.post("/:id/take", requireAuth, needMerchant, async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    const q = sql(), me = req.user.userId;
    const pres = (await q`SELECT online FROM merchant_presence WHERE user_id = ${me}::uuid`)[0];
    if (!pres || !pres.online) return res.status(409).json({ error: "Passez « en ligne » pour prendre un ordre." });
    const n = (await q`SELECT count(*)::int AS n FROM payment_orders WHERE taken_by = ${me}::uuid AND status IN ('taken','executed')`)[0].n;
    if (n >= maxTaken()) return res.status(409).json({ error: `Maximum ${maxTaken()} ordres en cours.` });
    const o = (await q`SELECT id, requester_id, phone, status FROM payment_orders WHERE id = ${req.params.id}::uuid`)[0];
    if (!o || o.status !== "drafted") return res.status(409).json({ error: "Cet ordre n'est plus disponible." });
    if (String(o.requester_id) === String(me)) return res.status(403).json({ error: "Vous ne pouvez pas prendre l'ordre issu de votre propre demande." });
    const mu = (await q`SELECT phone FROM users WHERE id = ${me}::uuid`)[0];
    if (mu && last8(mu.phone) && last8(mu.phone) === last8(o.phone)) return res.status(403).json({ error: "Vous ne pouvez pas payer votre propre numéro." });
    const got = await q`UPDATE payment_orders SET status = 'taken', taken_by = ${me}::uuid, taken_at = now() WHERE id = ${o.id}::uuid AND status = 'drafted' RETURNING id, tx_id`;
    if (!got.length) return res.status(409).json({ error: "Cet ordre vient d'être pris par un autre marchand." });
    const r = await q`UPDATE transactions SET status = 'processing' WHERE id = ${got[0].tx_id}::uuid AND type = 'withdrawal' AND status = 'pending' RETURNING id`;
    if (!r.length) { await q`UPDATE payment_orders SET status = 'rejected', reject_reason = 'retrait déjà traité' WHERE id = ${got[0].id}::uuid`; return res.status(409).json({ error: "Ce retrait a déjà été traité." }); }
    await event(got[0].id, "marchand:" + req.merchant.name, "taken", null);
    res.json({ message: `Ordre pris. Vous avez ${takeMinutes()} minutes pour payer puis saisir la référence.` });
  } catch (e) { fail(res, "ORDERS_TAKE", e); }
});

router.post("/:id/release", requireAuth, needMerchant, async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    const q = sql();
    const o = await q`UPDATE payment_orders SET status = 'drafted', taken_by = NULL, taken_at = NULL WHERE id = ${req.params.id}::uuid AND taken_by = ${req.user.userId}::uuid AND status = 'taken' RETURNING id, tx_id`;
    if (!o.length) return res.status(409).json({ error: "Ordre introuvable ou déjà exécuté." });
    await q`UPDATE transactions SET status = 'pending' WHERE id = ${o[0].tx_id}::uuid AND type = 'withdrawal' AND status = 'processing'`;
    await event(o[0].id, "marchand:" + req.merchant.name, "released", null);
    res.json({ message: "Ordre rendu à la file." });
  } catch (e) { fail(res, "ORDERS_RELEASE", e); }
});

router.post("/:id/execute", requireAuth, needMerchant, async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    const reference = clean(req.body?.reference, 160);
    if (reference.length < 6) return res.status(400).json({ error: "Référence réelle de l'opération requise (6 caractères minimum)." });
    const q = sql();
    const dupTx = await q`SELECT id FROM transactions WHERE type = 'withdrawal' AND status = 'completed' AND lower(metadata->'settlement'->>'reference') = lower(${reference}::text) LIMIT 1`;
    if (dupTx.length) return res.status(409).json({ error: "Cette référence de paiement est déjà utilisée." });
    let o;
    try {
      o = await q`UPDATE payment_orders SET status = 'executed', executed_ref = ${reference}, executed_at = now() WHERE id = ${req.params.id}::uuid AND taken_by = ${req.user.userId}::uuid AND status = 'taken'
        RETURNING id, tx_id, operator, amount::float AS amount, needs_admin`;
    } catch (e) { if (/payment_orders_ref|unique/i.test(e.message)) return res.status(409).json({ error: "Cette référence de paiement est déjà utilisée." }); throw e; }
    if (!o.length) return res.status(409).json({ error: "Ordre introuvable, expiré ou non pris par vous." });
    await event(o[0].id, "marchand:" + req.merchant.name, "executed", "référence " + reference);
    if (o[0].needs_admin || o[0].amount >= adminLimit()) return res.json({ status: "executed", message: "Exécution enregistrée. Montant élevé : en attente de validation de l'administrateur." });
    const claim = await q`UPDATE payment_orders SET status = 'validated', validated_by = 'marchand', validated_at = now() WHERE id = ${o[0].id}::uuid AND status = 'executed' RETURNING id`;
    const s = claim.length ? await settle(o[0].id, o[0].tx_id, reference, "marchand:" + req.merchant.name, o[0].operator) : { ok: false, error: "Ordre déjà traité." };
    if (!s.ok) { await q`UPDATE payment_orders SET status = 'disputed', reject_reason = ${clean(s.error, 200)} WHERE id = ${o[0].id}::uuid`; await event(o[0].id, "système", "disputed", s.error); return res.status(409).json({ error: s.error + " L'ordre est en litige : l'administrateur va vérifier." }); }
    await event(o[0].id, "marchand:" + req.merchant.name, "validated", "Retrait clôturé (sous le seuil)");
    res.json({ status: "validated", message: "Paiement confirmé : le retrait du client est clôturé." });
  } catch (e) { fail(res, "ORDERS_EXECUTE", e); }
});

module.exports = router;
module.exports._expireStale = expireStale;
