"use strict";
// OMNIPAY — opérations portefeuille V2 (fichier AJOUTÉ, aucune migration destructive).
//  - Opérateurs Mobile Money par client (MTN / Moov / Celtiis)
//  - Retrait : débit atomique, puis envoi PayDunya si AUTO_PAYOUT=on (sinon file d'attente admin)
//  - Callback dépôt PayDunya atomique (aucun double crédit) + re-vérification admin des dépôts en attente
//  - Remboursement ADMIN des retraits bloqués/échoués, ligne par ligne, une seule fois
// Toute opération d'argent = UNE seule requête SQL gardée par le statut courant.
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const COMMISSION = 50;
const MIN_OUT = 500;
const MAX_OUT = Number(process.env.MAX_WITHDRAW_XOF || 500000);
const MODES = { mtn: "mtn-benin", moov: "moov-benin", celtiis: "celtiis-cash" };
let ready = false;

const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." }));
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const autoPayout = () => String(process.env.AUTO_PAYOUT || "off").toLowerCase() === "on";
const baseUrl = () => (process.env.PUBLIC_BASE_URL || "https://www.omnipay-bj.com").replace(/\/$/, "");
const secret = () => process.env.OTP_SECRET || process.env.ADMIN_KEY || "";
const sig = (id) => crypto.createHmac("sha256", secret()).update("wd:" + id).digest("hex").slice(0, 32);

async function ensureTables() {
  if (ready) return;
  const q = sql();
  await q`CREATE TABLE IF NOT EXISTS user_operators (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, operator varchar(10) NOT NULL,
    phone varchar(20) NOT NULL, is_default boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, operator, phone))`;
  ready = true;
}

// Numéro au format international Bénin (229…) pour PayDunya.
function intlPhone(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (!d.startsWith("229")) d = "229" + d;
  return d;
}
const validLocal = (p) => { const d = String(p || "").replace(/\D/g, ""); return d.length >= 8 && d.length <= 15; };

// ---------- Opérateurs du client ----------
router.get("/api/operators", requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const rows = await sql()`SELECT id, operator, phone, is_default FROM user_operators WHERE user_id = ${req.user.userId} ORDER BY is_default DESC, created_at`;
    res.json({ operators: rows.map((r) => ({ id: r.id, operator: r.operator, phone: r.phone, isDefault: r.is_default })) });
  } catch (e) { console.error("OPS_LIST", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/api/operators", requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const operator = String(req.body?.operator || "").toLowerCase();
    const phone = String(req.body?.phone || "").replace(/[^\d+]/g, "").slice(0, 20);
    if (!MODES[operator]) return res.status(400).json({ error: "Opérateur invalide (mtn, moov ou celtiis)." });
    if (!validLocal(phone)) return res.status(400).json({ error: "Numéro invalide." });
    const q = sql();
    const n = await q`SELECT count(*)::int AS n FROM user_operators WHERE user_id = ${req.user.userId}`;
    if (n[0].n >= 6) return res.status(400).json({ error: "Maximum 6 numéros enregistrés." });
    const rows = await q`INSERT INTO user_operators (user_id, operator, phone, is_default)
      VALUES (${req.user.userId}, ${operator}, ${phone}, ${n[0].n === 0})
      ON CONFLICT (user_id, operator, phone) DO NOTHING RETURNING id`;
    if (!rows.length) return res.status(409).json({ error: "Ce numéro est déjà enregistré." });
    res.status(201).json({ message: "Numéro enregistré.", id: rows[0].id });
  } catch (e) { console.error("OPS_ADD", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/api/operators/:id/default", requireAuth, async (req, res) => {
  try {
    await ensureTables();
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    const rows = await sql()`WITH x AS (UPDATE user_operators SET is_default = (id = ${req.params.id}) WHERE user_id = ${req.user.userId} RETURNING id, is_default)
      SELECT id FROM x WHERE is_default`;
    if (!rows.length) return res.status(404).json({ error: "Numéro introuvable." });
    res.json({ message: "Numéro par défaut mis à jour." });
  } catch (e) { console.error("OPS_DEF", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.delete("/api/operators/:id", requireAuth, async (req, res) => {
  try {
    await ensureTables();
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    const rows = await sql()`DELETE FROM user_operators WHERE id = ${req.params.id} AND user_id = ${req.user.userId} RETURNING id`;
    if (!rows.length) return res.status(404).json({ error: "Numéro introuvable." });
    res.json({ message: "Numéro supprimé." });
  } catch (e) { console.error("OPS_DEL", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

// ---------- Retrait (remplace l'ancien /wallet/withdraw ; même réponse {message,newBalance}) ----------
router.post("/wallet/withdraw", requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const amount = Math.floor(Number(req.body?.amount));
    if (!Number.isFinite(amount) || amount < MIN_OUT) return res.status(400).json({ error: `Montant minimum : ${MIN_OUT} FCFA.` });
    if (amount > MAX_OUT) return res.status(400).json({ error: `Montant maximum : ${MAX_OUT} FCFA par retrait.` });
    const q = sql();
    let operator = String(req.body?.operator || "").toLowerCase();
    let phone = String(req.body?.phone || "").replace(/[^\d+]/g, "").slice(0, 20);
    if (req.body?.operatorId) { // numéro enregistré par le client
      if (!UUID.test(String(req.body.operatorId))) return res.status(400).json({ error: "Numéro enregistré invalide." });
      const o = await q`SELECT operator, phone FROM user_operators WHERE id = ${req.body.operatorId} AND user_id = ${req.user.userId}`;
      if (!o.length) return res.status(404).json({ error: "Numéro enregistré introuvable." });
      operator = o[0].operator; phone = o[0].phone;
    }
    if (!MODES[operator]) return res.status(400).json({ error: "Choisissez MTN, Moov ou Celtiis." });
    if (!validLocal(phone)) return res.status(400).json({ error: "Numéro Mobile Money invalide." });

    const total = amount + COMMISSION;
    const key = crypto.randomUUID();
    // Débit + écriture du retrait + commission : tout ou rien, solde vérifié dans la même requête.
    const rows = await q`
      WITH w AS (UPDATE wallets SET balance = balance - ${total}, updated_at = now()
                 WHERE user_id = ${req.user.userId} AND balance >= ${total} RETURNING id, balance),
      t AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key)
            SELECT w.id, 'withdrawal', ${amount}, w.balance, 'pending', ${operator}, ${phone}, ${key} FROM w RETURNING id),
      c AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, idempotency_key)
            SELECT w.id, 'commission', ${COMMISSION}, w.balance, 'completed', 'internal', ${key + "-fee"} FROM w RETURNING id)
      SELECT t.id AS tx_id, w.balance FROM w, t`;
    if (!rows.length) return res.status(400).json({ error: `Solde insuffisant (montant + ${COMMISSION} FCFA de commission).` });
    const txId = rows[0].tx_id;
    const newBalance = Number(rows[0].balance).toFixed(2);

    let message = "Demande de retrait enregistrée. Traitement sous 24h.";
    if (autoPayout()) {
      try {
        const pd = require("../providers/paydunya.js");
        const cb = `${baseUrl()}/wallet/withdraw/callback?id=${txId}&sig=${sig(txId)}`;
        const tok = await pd.createDisburseToken({ accountAlias: intlPhone(phone), amount, withdrawMode: MODES[operator], callbackUrl: cb });
        if (tok && tok.response_code === "00" && tok.disburse_token) {
          const sub = await pd.submitDisburse({ disburseInvoice: tok.disburse_token, disburseId: txId });
          await q`UPDATE transactions SET status = 'processing', metadata = coalesce(metadata,'{}'::jsonb) || ${JSON.stringify({ paydunya: { submit: sub && sub.response_code, at: new Date().toISOString() } })}::jsonb
                  WHERE id = ${txId} AND status = 'pending'`;
          message = "Retrait envoyé vers votre Mobile Money. Confirmation en cours.";
        } else {
          // Refus clair de PayDunya AVANT envoi : on garde 'pending' pour traitement/remboursement par l'administrateur.
          await q`UPDATE transactions SET metadata = coalesce(metadata,'{}'::jsonb) || ${JSON.stringify({ paydunyaRefused: tok && (tok.response_text || tok.response_code) })}::jsonb WHERE id = ${txId}`;
        }
      } catch (e) {
        // Résultat incertain (timeout…) : on ne rembourse JAMAIS automatiquement, l'argent a pu partir.
        console.error("AUTO_PAYOUT", e.response?.data || e.message);
        await q`UPDATE transactions SET metadata = coalesce(metadata,'{}'::jsonb) || ${JSON.stringify({ autoPayoutError: String(e.response?.data?.response_text || e.message).slice(0, 200) })}::jsonb WHERE id = ${txId}`;
      }
    }
    try { await require("../lib/mailer.js").sendAdminNotification("Nouvelle demande de retrait OMNIPAY", `<p>Montant : <b>${amount} XOF</b></p><p>Numéro : <b>${phone}</b> (${operator})</p>`); } catch (_) { /* e-mail facultatif */ }
    res.json({ message, newBalance });
  } catch (e) { console.error("WITHDRAW", e.message); res.status(500).json({ error: "Erreur serveur lors du retrait." }); }
});

// Callback retrait PayDunya : URL signée. Ne rembourse jamais ; marque seulement 'completed' ou 'failed' (à rembourser par l'admin).
router.post("/wallet/withdraw/callback", async (req, res) => {
  try {
    const id = String(req.query.id || req.body?.disburse_id || "");
    if (!UUID.test(id) || String(req.query.sig || "") !== sig(id)) return res.status(403).json({ error: "Signature invalide." });
    const st = String(req.body?.status || "").toLowerCase();
    const next = st === "success" ? "completed" : st === "failed" ? "failed" : null;
    if (next) await sql()`UPDATE transactions SET status = ${next} WHERE id = ${id} AND type = 'withdrawal' AND status IN ('pending','processing')`;
    res.json({ message: "OK" });
  } catch (e) { console.error("WD_CB", e.message); res.status(500).json({ error: "Erreur callback retrait." }); }
});

// ---------- Dépôt PayDunya : crédit atomique ----------
async function creditDeposit(token) {
  // Une seule instruction : si le dépôt n'est plus 'pending', rien n'est crédité.
  return sql()`
    WITH t AS (SELECT id, wallet_id, amount FROM transactions WHERE provider_ref = ${token} AND type = 'deposit' AND provider = 'paydunya' AND status = 'pending' FOR UPDATE),
    w AS (UPDATE wallets SET balance = balance + t.amount, updated_at = now() FROM t WHERE wallets.id = t.wallet_id RETURNING wallets.balance, t.id AS tx_id),
    u AS (UPDATE transactions SET status = 'completed', balance_after = w.balance FROM w WHERE transactions.id = w.tx_id AND transactions.status = 'pending' RETURNING transactions.id)
    SELECT w.balance FROM w`;
}

router.post("/wallet/deposit/callback", async (req, res) => {
  try {
    const token = req.body?.data?.invoice?.token || req.body?.data?.token || req.body?.token;
    if (!token) return res.status(400).json({ error: "Token manquant." });
    const confirmation = await require("../providers/paydunya.js").confirmInvoice(token); // vérifié auprès de PayDunya, jamais cru sur parole
    if (confirmation.status !== "completed") return res.status(200).json({ message: "Paiement non confirmé." });
    const rows = await creditDeposit(token);
    res.json({ message: rows.length ? "Dépôt confirmé et crédité." : "Déjà traité ou introuvable." });
  } catch (e) { console.error("DEP_CB", e.response?.data || e.message); res.status(500).json({ error: "Erreur lors de la confirmation du dépôt." }); }
});

// ---------- Administration ----------
// Retraits en attente / échoués (argent débité, jamais livré ou statut non résolu).
router.get("/api/ops/stuck", adminOnly, async (req, res) => {
  try {
    const rows = await sql()`
      SELECT t.id, t.status, t.amount::float AS amount, t.provider AS operator, t.provider_ref AS phone, t.created_at,
             u.email, u.first_name, u.last_name, t.metadata,
             coalesce((SELECT sum(c.amount) FROM transactions c WHERE c.idempotency_key = t.idempotency_key || '-fee' AND c.type = 'commission' AND c.status = 'completed'),0)::float AS fee
      FROM transactions t JOIN wallets w ON w.id = t.wallet_id JOIN users u ON u.id = w.user_id
      WHERE t.type = 'withdrawal' AND t.status IN ('pending','failed','processing')
      ORDER BY t.created_at`;
    res.json({ autoPayout: autoPayout(), withdrawals: rows });
  } catch (e) { console.error("STUCK", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

// Remboursement atomique d'UN retrait : montant (+ commission si includeFee). Rejouer = refusé (409).
async function refundOne(id, includeFee, note) {
  return sql()`
    WITH t AS (UPDATE transactions SET status = 'refunded', metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object('refundedAt', now()::text, 'refundNote', ${note}::text)
               WHERE id = ${id}::uuid AND type = 'withdrawal' AND status IN ('pending','failed','processing') RETURNING wallet_id, amount, idempotency_key),
    f AS (UPDATE transactions SET status = 'refunded' FROM t
          WHERE ${includeFee}::boolean AND transactions.idempotency_key = t.idempotency_key || '-fee' AND transactions.type = 'commission' AND transactions.status = 'completed'
          RETURNING transactions.amount AS fee),
    w AS (UPDATE wallets SET balance = balance + t.amount + coalesce((SELECT sum(fee) FROM f),0), updated_at = now()
          FROM t WHERE wallets.id = t.wallet_id RETURNING wallets.id AS wid, wallets.balance, t.amount + coalesce((SELECT sum(fee) FROM f),0) AS refunded),
    r AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key)
          SELECT wid, 'refund', refunded, balance, 'completed', 'internal', ${id}::text, ${"refund-" + id}::text FROM w RETURNING id)
    SELECT w.balance, w.refunded FROM w`;
}

router.post("/api/ops/refund", adminOnly, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))].slice(0, 200) : [];
    if (!ids.length || ids.some((i) => !UUID.test(i))) return res.status(400).json({ error: "Liste d'identifiants invalide." });
    const includeFee = req.body?.includeFee !== false;
    const note = clean(req.body?.note, 200) || "Remboursement administrateur";
    const done = [], skipped = [];
    for (const id of ids) {
      try {
        const r = await refundOne(id, includeFee, note);
        if (r.length) done.push({ id, refunded: Number(r[0].refunded) }); else skipped.push({ id, reason: "déjà traité ou introuvable" });
      } catch (e) { console.error("REFUND", id, e.message); skipped.push({ id, reason: "erreur" }); }
    }
    res.json({ refundedCount: done.length, totalRefunded: done.reduce((s, d) => s + d.refunded, 0), done, skipped });
  } catch (e) { console.error("REFUND_ALL", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

// Retrait déjà payé à la main par l'administrateur : on ferme la ligne SANS rembourser.
router.post("/api/ops/withdraw/:id/paid", adminOnly, async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    const rows = await sql()`UPDATE transactions SET status = 'completed' WHERE id = ${req.params.id} AND type = 'withdrawal' AND status IN ('pending','failed','processing') RETURNING id`;
    if (!rows.length) return res.status(409).json({ error: "Introuvable ou déjà traité." });
    res.json({ message: "Marqué comme payé." });
  } catch (e) { console.error("WD_PAID", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

// Re-vérifie auprès de PayDunya les dépôts 'pending' (jusqu'à 50) et crédite ceux réellement payés.
router.post("/api/ops/deposits/reverify", adminOnly, async (req, res) => {
  try {
    const pd = require("../providers/paydunya.js");
    const pend = await sql()`SELECT provider_ref FROM transactions WHERE type = 'deposit' AND provider = 'paydunya' AND status = 'pending' AND provider_ref IS NOT NULL ORDER BY created_at LIMIT 50`;
    let credited = 0, unpaid = 0, errors = 0;
    for (const p of pend) {
      try {
        const c = await pd.confirmInvoice(p.provider_ref);
        if (c.status === "completed") { const r = await creditDeposit(p.provider_ref); if (r.length) credited++; } else unpaid++;
      } catch (e) { errors++; }
    }
    res.json({ checked: pend.length, credited, unpaid, errors });
  } catch (e) { console.error("REVERIFY", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;
