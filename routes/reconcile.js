"use strict";
// OMNIPAY — RÉCONCILIATION : fonds suspendus et opérations non abouties. FICHIER AJOUTÉ, aucune migration.
// Admin  : GET  /api/recon/report[?email=]   état des fonds suspendus (retraits en attente/échoués, recharges, dépôts manuels, numéros) + total
//          POST /api/recon/auto              { apply:true, staleHours }  rembourse (sinon simple simulation)
// Client : GET  /api/recon/mine              mes opérations non abouties
//          POST /api/recon/mine/:id/refund   récupérer mes fonds (opération échouée, ou en attente depuis plus de RECON_USER_HOURS, 24 h par défaut)
// Automatique (toutes les RECON_EVERY_MIN minutes, 10 par défaut ; RECON_AUTO=off pour couper) :
//   - retraits « échoués » : remboursés tout de suite
//   - retraits « en attente » plus anciens que RECON_STALE_HOURS : remboursés seulement si cette variable est définie
// Un remboursement = UNE requête SQL gardée par le statut : rejouer ne rembourse jamais deux fois.
// Les recharges, numéros virtuels et ordres crypto ont leur propre remboursement : ils sont listés ici mais non touchés.
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWN = ["bundle", "virtualnum", "omnichange"];
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." }));
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const userHours = () => num("RECON_USER_HOURS", 24);

async function hasTable(q, name) { try { const r = await q`SELECT to_regclass(${"public." + name}) AS t`; return Boolean(r[0] && r[0].t); } catch (_) { return false; } }
async function activeOrderFor(q, id) {
  try { if (!(await hasTable(q, "payment_orders"))) return false; return (await q`SELECT id FROM payment_orders WHERE tx_id = ${id}::uuid AND status IN ('taken','executed') LIMIT 1`).length > 0; }
  catch (_) { return false; }
}
// Remboursement atomique d'un retrait (montant + commission). uid = null pour l'administration, sinon l'opération doit appartenir au client.
async function refundTx(id, note, uid) {
  const q = sql();
  if (await activeOrderFor(q, id)) return { ok: false, reason: "pris par un marchand" };
  const r = await q`
    WITH t AS (UPDATE transactions SET status = 'refunded', metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object('refundedAt', now()::text, 'refundNote', ${note}::text)
               WHERE id = ${id}::uuid AND type = 'withdrawal' AND status IN ('pending','failed','processing') AND coalesce(provider,'') <> ALL(${OWN}::text[])
                 AND (${uid}::uuid IS NULL OR wallet_id IN (SELECT id FROM wallets WHERE user_id = ${uid}::uuid)) RETURNING wallet_id, amount, idempotency_key),
    f AS (UPDATE transactions SET status = 'refunded' FROM t WHERE transactions.idempotency_key = t.idempotency_key || '-fee' AND transactions.type = 'commission' AND transactions.status = 'completed' RETURNING transactions.amount AS fee),
    w AS (UPDATE wallets SET balance = balance + t.amount + coalesce((SELECT sum(fee) FROM f),0), updated_at = now() FROM t WHERE wallets.id = t.wallet_id
          RETURNING wallets.id AS wid, wallets.balance, t.amount + coalesce((SELECT sum(fee) FROM f),0) AS refunded),
    x AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key)
          SELECT wid, 'refund', refunded, balance, 'completed', 'internal', ${id}::text, ${"refund-" + id}::text FROM w RETURNING id)
    SELECT w.balance, w.refunded FROM w`;
  return r.length ? { ok: true, refunded: Number(r[0].refunded), balance: Number(r[0].balance) } : { ok: false, reason: "déjà traité ou non remboursable" };
}

async function candidates(failedOnly, staleHours) {
  return sql()`SELECT id, status, amount::float AS amount, provider FROM transactions WHERE type = 'withdrawal' AND coalesce(provider,'') <> ALL(${OWN}::text[])
    AND (status = 'failed' OR (${!failedOnly}::boolean AND status IN ('pending','processing') AND created_at < now() - make_interval(hours => ${staleHours}::int))) ORDER BY created_at LIMIT 200`;
}
async function autoRun(apply, staleHours) {
  const list = await candidates(!staleHours, staleHours || 0);
  const done = [], skipped = [];
  for (const c of list) {
    if (!apply) { done.push({ id: c.id, status: c.status, amount: c.amount, provider: c.provider }); continue; }
    try { const r = await refundTx(c.id, "Remboursement automatique", null); if (r.ok) done.push({ id: c.id, refunded: r.refunded }); else skipped.push({ id: c.id, reason: r.reason }); }
    catch (e) { console.error("RECON_REFUND", c.id, e.message); skipped.push({ id: c.id, reason: "erreur" }); }
  }
  return { apply, count: done.length, total: done.reduce((s, d) => s + (d.refunded || d.amount || 0), 0), done, skipped };
}

router.get("/report", adminOnly, async (req, res) => {
  try {
    const q = sql(), email = String(req.query.email || "").trim().toLowerCase().slice(0, 120) || null;
    const wd = await q`SELECT t.id, t.status, t.amount::float AS amount, t.provider, t.provider_ref, t.created_at, round(extract(epoch FROM now() - t.created_at)/3600)::int AS age_hours, u.email
      FROM transactions t JOIN wallets w ON w.id = t.wallet_id JOIN users u ON u.id = w.user_id
      WHERE t.type = 'withdrawal' AND t.status IN ('pending','processing','failed') AND (${email}::text IS NULL OR lower(u.email) = ${email}) ORDER BY t.created_at LIMIT 300`;
    const out = { withdrawals: wd, suspendedXof: wd.reduce((s, r) => s + r.amount, 0), failedXof: wd.filter((r) => r.status === "failed").reduce((s, r) => s + r.amount, 0),
      byProvider: wd.reduce((m, r) => { m[r.provider] = (m[r.provider] || 0) + r.amount; return m; }, {}), other: {} };
    for (const [tbl, key, sumCol] of [["bundle_orders", "recharges", "amount_xof"], ["manual_deposits", "depotsManuels", "amount_xof"], ["manual_payouts", "retraitsManuels", "amount_xof"]]) {
      try { if (await hasTable(q, tbl)) { const r = await q.query("SELECT count(*)::int AS n FROM " + tbl + " WHERE status = 'pending'"); out.other[key] = r[0].n; } } catch (_) {}
    }
    out.hint = "failed = à rembourser ; pending/processing = en attente. POST /api/recon/auto avec {\"apply\":true} rembourse les échecs ; ajoutez {\"staleHours\":72} pour inclure les attentes de plus de 72 h.";
    res.json(out);
  } catch (e) { console.error("RECON_REPORT", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});
router.post("/auto", adminOnly, async (req, res) => {
  try { const sh = Math.floor(Number((req.body || {}).staleHours)); res.json(await autoRun((req.body || {}).apply === true, Number.isFinite(sh) && sh >= 1 ? sh : 0)); }
  catch (e) { console.error("RECON_AUTO", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.get("/mine", requireAuth, async (req, res) => {
  try {
    const h = userHours();
    const rows = await sql()`SELECT t.id, t.status, t.amount::float AS amount, t.provider, t.created_at, round(extract(epoch FROM now() - t.created_at)/3600)::int AS age_hours
      FROM transactions t JOIN wallets w ON w.id = t.wallet_id WHERE w.user_id = ${req.user.userId}::uuid AND t.type = 'withdrawal' AND t.status IN ('pending','processing','failed')
      ORDER BY t.created_at DESC LIMIT 30`;
    res.json({ afterHours: h, items: rows.map((r) => ({ ...r, refundable: !OWN.includes(r.provider) && (r.status === "failed" || r.age_hours >= h) })) });
  } catch (e) { console.error("RECON_MINE", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});
router.post("/mine/:id/refund", requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || ""); if (!UUID.test(id)) return res.status(400).json({ error: "Opération invalide." });
    const [t] = await sql()`SELECT t.status, t.provider, round(extract(epoch FROM now() - t.created_at)/3600)::int AS age_hours FROM transactions t JOIN wallets w ON w.id = t.wallet_id
      WHERE t.id = ${id}::uuid AND w.user_id = ${req.user.userId}::uuid AND t.type = 'withdrawal'`;
    if (!t) return res.status(404).json({ error: "Opération introuvable." });
    if (OWN.includes(t.provider)) return res.status(409).json({ error: "Cette opération est remboursée automatiquement par son service." });
    if (t.status !== "failed" && t.age_hours < userHours()) return res.status(409).json({ error: "Cette opération est encore en cours de traitement. Vous pourrez récupérer vos fonds si elle n'aboutit pas dans " + (userHours() - t.age_hours) + " h." });
    const r = await refundTx(id, "Remboursement demandé par le client", req.user.userId);
    if (!r.ok) return res.status(409).json({ error: "Opération déjà traitée." });
    res.json({ ok: true, refunded: r.refunded, newBalance: r.balance, message: "Vos fonds ont été remis sur votre solde." });
  } catch (e) { console.error("RECON_USER", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

let LOOP = null;
function start() {
  if (LOOP || !process.env.DATABASE_URL || String(process.env.RECON_AUTO || "on").toLowerCase() === "off") return;
  const run = async () => { try { const sh = Number(process.env.RECON_STALE_HOURS); const r = await autoRun(true, Number.isFinite(sh) && sh >= 1 ? Math.floor(sh) : 0); if (r.count) console.log("RECON auto:", r.count, "remboursés,", r.total, "FCFA"); } catch (e) { console.error("RECON_LOOP", e.message); } };
  LOOP = setInterval(run, num("RECON_EVERY_MIN", 10) * 60000); if (LOOP.unref) LOOP.unref();
  const t0 = setTimeout(run, 30000); if (t0.unref) t0.unref();
}
module.exports = router;
module.exports._autoRun = autoRun;
module.exports._refundTx = refundTx;
start();
