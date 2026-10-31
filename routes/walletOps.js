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
const autoPayout = () => ["on", "true", "1", "yes"].includes(String(process.env.AUTO_PAYOUT || "off").toLowerCase());
// PayDunya est désactivé par défaut : OMNIPAY fonctionne avec ses propres canaux (voir providers/payoutRouter.js et routes/channels.js).
const paydunyaOn = () => ["on", "true", "1", "yes"].includes(String(process.env.PAYDUNYA_ENABLED || "off").toLowerCase());
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

// Plafond d'envoi AUTOMATIQUE sur 24 h (sécurité) : au-delà, la demande reste en attente de validation. Défaut 1 000 000 ; 0 = envoi automatique suspendu.
const autoDayMax = () => { const v = Number(process.env.AUTO_PAYOUT_DAY_MAX_XOF); return Number.isFinite(v) && v >= 0 ? v : 1000000; };
const approvalXof = () => { const v = Number(process.env.APPROVAL_XOF); return Number.isFinite(v) && v > 0 ? v : 200000; };

// Envoi d'UN retrait vers le canal choisi pour l'opérateur. Le statut 'pending' est « réservé » (→ 'processing') AVANT l'appel,
// donc un même retrait ne peut jamais partir deux fois (clic double, lot + validation, etc.).
async function dispatchPayout(q, txId, operator, phone, amount) {
  const claim = await q`UPDATE transactions SET status = 'processing' WHERE id = ${txId}::uuid AND type = 'withdrawal' AND status = 'pending' RETURNING id`;
  if (!claim.length) return { status: "skipped" };
  let r;
  // Gestionnaire de fonds (FUND_ROUTER = off | advise | guard). advise : note la voie recommandée dans le dossier. guard : en plus, suspend l'envoi si la couverture passerait sous le plancher.
  let fundMeta = null;
  const fundMode = String(process.env.FUND_ROUTER || "off").toLowerCase();
  if (fundMode === "advise" || fundMode === "guard") {
    try {
      const fd = await require("../lib/fundManager.js").checkPayout({ operator, amount });
      fundMeta = { fund: { ok: fd.ok, hard: fd.hard, route: fd.choice ? fd.choice.code : null, reasons: fd.reasons, at: new Date().toISOString() } };
      if (fundMode === "guard" && fd.hard) {
        await q`UPDATE transactions SET status = 'pending', metadata = coalesce(metadata,'{}'::jsonb) || ${JSON.stringify(fundMeta)}::jsonb WHERE id = ${txId}::uuid AND status = 'processing'`;
        return { status: "unavailable", route: "fund-guard", detail: "Suspendu par le gestionnaire de fonds : " + fd.reasons.join(" ") };
      }
    } catch (e) { console.error("FUND_GUARD", e.message); }
  }
  try {
    const router = require("../providers/payoutRouter.js");
    r = await router.payout({ txId, operator, phone, amount, callbackUrl: `${baseUrl()}/wallet/withdraw/callback?id=${txId}&sig=${sig(txId)}` });
  } catch (e) { r = { status: "uncertain", detail: String(e.response?.data?.response_text || e.message).slice(0, 160), route: "?" }; }
  const meta = JSON.stringify({ ...(fundMeta || {}), payout: { route: r.route, result: r.status, detail: r.detail || null, at: new Date().toISOString() } });
  if (r.status === "sent" || r.status === "uncertain") {
    // sent : en attente de confirmation ; uncertain : reste 'processing' pour vérification humaine (jamais de renvoi automatique)
    await q`UPDATE transactions SET metadata = coalesce(metadata,'{}'::jsonb) || ${meta}::jsonb WHERE id = ${txId}::uuid`;
  } else {
    // refused / unavailable : rien n'est parti -> la demande redevient 'pending'
    await q`UPDATE transactions SET status = 'pending', metadata = coalesce(metadata,'{}'::jsonb) || ${meta}::jsonb WHERE id = ${txId}::uuid AND status = 'processing'`;
  }
  return r;
}

// ---------- Opérateurs du client ----------
// Nouveau dépôt PayDunya : fermé sauf PAYDUNYA_ENABLED=on (les dépôts déjà créés restent vérifiables).
router.post("/wallet/deposit", (req, res, next) => (paydunyaOn() ? next() : res.status(410).json({ error: "Ce mode de dépôt n'est plus disponible. Utilisez « Dépôt & retrait directs » (MTN, PI-SPI, crypto)." })));

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
    let viaLinked = false;
    const guard = (() => { try { return require("../lib/omnicashGuard.js"); } catch (_) { return null; } })();
    if (req.body?.linkedId && guard) { // compte Mobile Money relié ET validé par l'équipe
      if (!UUID.test(String(req.body.linkedId))) return res.status(400).json({ error: "Compte relié invalide." });
      const l = await guard.verifiedMobile(req.user.userId, { linkedId: req.body.linkedId });
      if (!l) return res.status(403).json({ error: "Ce compte relié n'est pas encore validé par OMNIPAY." });
      operator = l.operator; phone = l.phone; viaLinked = true;
    } else if (req.body?.operatorId) { // numéro enregistré par le client
      if (!UUID.test(String(req.body.operatorId))) return res.status(400).json({ error: "Numéro enregistré invalide." });
      const o = await q`SELECT operator, phone FROM user_operators WHERE id = ${req.body.operatorId} AND user_id = ${req.user.userId}`;
      if (!o.length) return res.status(404).json({ error: "Numéro enregistré introuvable." });
      operator = o[0].operator; phone = o[0].phone;
    }
    if (!MODES[operator]) return res.status(400).json({ error: "Choisissez MTN, Moov ou Celtiis." });
    if (guard && guard.requireLinked() && !viaLinked) {
      const l = await guard.verifiedMobile(req.user.userId, { operator, phone });
      if (!l) return res.status(403).json({ error: "Pour votre sécurité, les retraits partent uniquement vers un compte relié et validé. Reliez votre compte dans « Réseau OMNIPAY »." });
      viaLinked = true;
    }
    if (!validLocal(phone)) return res.status(400).json({ error: "Numéro Mobile Money invalide." });
    // Limites par niveau KYC (voir routes/compliance.js). Si le module est absent, aucune limite supplémentaire n'est appliquée.
    try {
      const comp = require("./compliance.js");
      const kyc = (await q`SELECT kyc_status FROM users WHERE id = ${req.user.userId}::uuid`)[0]?.kyc_status;
      const lim = comp.limitsFor(kyc);
      if (amount > lim.perTx) return res.status(400).json({ error: `Limite par retrait : ${lim.perTx} FCFA. Faites vérifier votre identité pour relever vos limites.` });
      const day = await q`SELECT coalesce(sum(t.amount), 0)::float AS v FROM transactions t JOIN wallets w ON w.id = t.wallet_id
        WHERE w.user_id = ${req.user.userId}::uuid AND t.type = 'withdrawal' AND t.status NOT IN ('cancelled','refunded','failed') AND t.created_at > now() - interval '24 hours'`;
      if (day[0].v + amount > lim.perDay) return res.status(400).json({ error: `Limite sur 24 h atteinte (${lim.perDay} FCFA). Réessayez plus tard ou faites vérifier votre identité.` });
    } catch (e) { if (e && e.code !== "MODULE_NOT_FOUND") console.error("LIMITS", e.message); }

    const total = amount + COMMISSION;
    const key = crypto.randomUUID();
    // Portail de sécurité (services/paymentSafetyGate.js) : BLOQUE un retrait incohérent, ou le met en validation humaine (jamais d'envoi automatique).
    let gateReview = false, gateId = null;
    try {
      const gate = require("../services/paymentSafetyGate.js");
      const bal = (await q`SELECT balance FROM wallets WHERE user_id = ${req.user.userId}::uuid`)[0]?.balance;
      const dec = await gate.evaluate({ userId: String(req.user.userId), rail: operator, destination: phone, amountXof: amount, feesXof: COMMISSION, idempotencyKey: key,
        availableBalanceXof: bal == null ? null : Number(bal), perTransactionLimitXof: MAX_OUT, manualReviewAboveXof: approvalXof(),
        verifiedBeneficiaryRequired: Boolean(guard && guard.requireLinked()), beneficiaryVerified: viaLinked });
      gateId = dec.gateId;
      if (dec.decision === "BLOCK") return res.status(dec.reasonCode === "SG_INSUFFICIENT_BALANCE" ? 400 : 403).json({ error: dec.reasonCode === "SG_INSUFFICIENT_BALANCE" ? `Solde insuffisant (montant + ${COMMISSION} FCFA de commission).` : (dec.reason || "Retrait refusé par le contrôle de sécurité."), code: dec.reasonCode });
      gateReview = dec.decision === "REVIEW";
    } catch (e) { if (e && e.code !== "MODULE_NOT_FOUND") { console.error("SAFETY_GATE", e.message); return res.status(503).json({ error: "Contrôle de sécurité indisponible. Réessayez dans un instant." }); } }
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
    const needsApproval = amount >= approvalXof() || gateReview;
    let capped = false;
    let paused = false;
    try { paused = Boolean(guard && (await guard.isPaused())); } catch (_) { paused = false; }
    if (autoPayout() && !needsApproval && !paused) {
      try {
        const sent = await q`SELECT coalesce(sum(amount), 0)::float AS v FROM transactions WHERE type = 'withdrawal' AND metadata->'payout'->>'result' = 'sent' AND created_at > now() - interval '24 hours'`;
        capped = sent[0].v + amount > autoDayMax();
      } catch (_) { capped = false; }
    }
    if (autoPayout() && !needsApproval && !capped && !paused) {
      const r = await dispatchPayout(q, txId, operator, phone, amount);
      if (r.status === "sent") message = "Retrait envoyé vers votre Mobile Money. Confirmation en cours.";
    } else if (paused) {
      message = "Demande enregistrée : les envois automatiques sont temporairement suspendus, votre retrait sera traité par l'équipe.";
    } else if (needsApproval) {
      message = "Demande enregistrée : ce montant est soumis à validation avant envoi (sous 24h).";
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
    res.json({ autoPayout: autoPayout(), approvalXof: approvalXof(), withdrawals: rows });
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
    if (!UUID.test(req.params.id)) {
      return res.status(400).json({ error: "Identifiant invalide." });
    }
    const paymentRef = clean(req.body?.paymentRef, 160);
    const channel = clean(req.body?.channel || "pispi", 20).toLowerCase();
    if (paymentRef.length < 6) {
      return res.status(400).json({
        error: "Reference reelle requise: txId ou end2endId PI-SPI."
      });
    }
    const duplicate = await sql()`
      SELECT id FROM transactions
      WHERE type = 'withdrawal'
        AND status = 'completed'
        AND metadata->'settlement'->>'reference' = ${paymentRef}::text
      LIMIT 1
    `;
    if (duplicate.length) {
      return res.status(409).json({
        error: "Cette reference de paiement est deja utilisee."
      });
    }
    const rows = await sql()`
      UPDATE transactions
      SET status = 'completed',
          metadata = coalesce(metadata, '{}'::jsonb) ||
            jsonb_build_object('settlement', jsonb_build_object(
              'channel', ${channel}::text,
              'reference', ${paymentRef}::text,
              'confirmedAt', now()::text,
              'confirmedBy', 'admin'
            ))
      WHERE id = ${req.params.id}::uuid
        AND type = 'withdrawal'
        AND status IN ('pending', 'failed', 'processing')
      RETURNING id
    `;
    if (!rows.length) {
      return res.status(409).json({
        error: "Retrait introuvable ou deja traite."
      });
    }
    res.json({
      message: "Paiement reel confirme et retrait cloture.",
      paymentRef,
      channel
    });
  } catch (e) {
    console.error("WD_PAID", e.message);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// Export CSV des retraits à payer (pour un paiement en lot depuis le portail Mobile Money / Ecobank), puis « payé » en lot.
// Ne déplace aucun argent : c'est vous qui payez, OMNIPAY ne fait que préparer la liste et fermer les lignes.
router.get("/api/ops/payouts.csv", adminOnly, async (req, res) => {
  try {
    const rows = await sql()`
      SELECT t.id, t.status, t.amount::float AS amount, t.provider AS operator, t.provider_ref AS phone, t.created_at, u.first_name, u.last_name, u.email
      FROM transactions t JOIN wallets w ON w.id = t.wallet_id JOIN users u ON u.id = w.user_id
      WHERE t.type = 'withdrawal' AND t.status = 'pending' ORDER BY t.created_at LIMIT 500`;
    const cell = (v) => { let x = String(v == null ? "" : v); if (/^[=+\-@]/.test(x)) x = "'" + x; return '"' + x.replace(/"/g, '""') + '"'; };
    const head = ["id", "operateur", "telephone", "montant_fcfa", "beneficiaire", "email", "date"];
    const lines = rows.map((r) => [r.id, String(r.operator).replace(/-.*/, ""), intlPhoneSafe(r.phone), r.amount, `${r.first_name || ""} ${r.last_name || ""}`.trim(), r.email, new Date(r.created_at).toISOString().slice(0, 10)].map(cell).join(";"));
    res.set("Content-Type", "text/csv; charset=utf-8").set("Content-Disposition", 'attachment; filename="retraits-a-payer.csv"').send("\ufeff" + [head.join(";"), ...lines].join("\r\n"));
  } catch (e) { console.error("PAYOUT_CSV", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});
function intlPhoneSafe(p) { let d = String(p || "").replace(/\D/g, ""); if (d.startsWith("00")) d = d.slice(2); return d.startsWith("229") ? d : "229" + d; }

router.post("/api/ops/batch/paid", adminOnly, async (req, res) => {
  return res.status(410).json({
    error: "Paiement en lot desactive : chaque retrait PI-SPI doit avoir son propre txId ou end2endId."
  });
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

// Nettoyage : clôture (« cancelled ») les dépôts PayDunya restés 'pending' depuis plus de N jours (7 par défaut, 3 minimum).
// Aucun solde n'est touché (un dépôt en attente n'a jamais été crédité) ; l'historique est conservé dans le ledger. dryRun:true = simple comptage.
router.post("/api/ops/deposits/expire-stale", adminOnly, async (req, res) => {
  try {
    const days = Math.max(3, Math.min(365, parseInt(req.body?.days, 10) || 7));
    const q = sql();
    if (req.body?.dryRun) {
      const r = await q`SELECT count(*)::int AS n, coalesce(sum(amount),0)::float AS total FROM transactions WHERE type = 'deposit' AND provider = 'paydunya' AND status = 'pending' AND created_at < now() - make_interval(days => ${days})`;
      return res.json({ dryRun: true, days, count: r[0].n, totalXof: r[0].total });
    }
    const rows = await q`UPDATE transactions SET status = 'cancelled', metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object('expiredAt', now()::text, 'expiredReason', 'dépôt PayDunya jamais confirmé')
      WHERE type = 'deposit' AND provider = 'paydunya' AND status = 'pending' AND created_at < now() - make_interval(days => ${days}) RETURNING id, amount`;
    res.json({ days, closed: rows.length, totalXof: rows.reduce((a, r) => a + Number(r.amount), 0) });
  } catch (e) { console.error("EXPIRE_STALE", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

// Valide et envoie UN retrait en attente (montants élevés compris).
router.post("/api/ops/withdraw/:id/send", adminOnly, async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    const q = sql();
    const t = await q`SELECT provider AS operator, provider_ref AS phone, amount::float AS amount FROM transactions WHERE id = ${req.params.id}::uuid AND type = 'withdrawal' AND status = 'pending'`;
    if (!t.length) return res.status(409).json({ error: "Retrait introuvable ou déjà traité." });
    const r = await dispatchPayout(q, req.params.id, t[0].operator, t[0].phone, t[0].amount);
    res.json({ result: r.status, route: r.route, detail: r.detail || null });
  } catch (e) { console.error("WD_SEND", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

// Envoi par LOT (20 retraits maximum, un à la fois, avec une courte pause) ; uniquement des identifiants choisis par l'administrateur.
router.post("/api/ops/batch/send", adminOnly, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))].slice(0, 20) : [];
    if (!ids.length || ids.some((i) => !UUID.test(i))) return res.status(400).json({ error: "Liste d'identifiants invalide (20 maximum)." });
    const q = sql();
    const out = [];
    for (const id of ids) {
      const t = await q`SELECT provider AS operator, provider_ref AS phone, amount::float AS amount FROM transactions WHERE id = ${id}::uuid AND type = 'withdrawal' AND status = 'pending'`;
      if (!t.length) { out.push({ id, result: "ignoré" }); continue; }
      const r = await dispatchPayout(q, id, t[0].operator, t[0].phone, t[0].amount);
      out.push({ id, result: r.status, detail: r.detail || null });
      await new Promise((ok) => setTimeout(ok, 400));
    }
    res.json({ results: out, sent: out.filter((o) => o.result === "sent").length });
  } catch (e) { console.error("WD_BATCH", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

// Interroge MTN pour un retrait envoyé par le canal MoMo direct, et met à jour le statut (jamais de remboursement automatique).
router.post("/api/ops/withdraw/:id/check", adminOnly, async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    const st = await require("../providers/payoutRouter.js").momoStatus(req.params.id);
    if (st !== "pending") await sql()`UPDATE transactions SET status = ${st} WHERE id = ${req.params.id}::uuid AND type = 'withdrawal' AND status IN ('processing','pending')`;
    res.json({ status: st });
  } catch (e) { console.error("WD_CHECK", e.message); res.status(502).json({ error: "Vérification impossible : " + String(e.message).slice(0, 100) }); }
});

router.refundOne = refundOne;
module.exports = router;
