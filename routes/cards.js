"use strict";
// OMNIPAY — CARTES VIRTUELLES (gérées par OMNIPAY, numéros fournis par l'émetteur partenaire : voir providers/cardIssuer.js).
// OMNIPAY gère : création (frais), alimentation depuis le solde FCFA, gel/dégel, clôture avec remboursement du solde, historique. Aucun numéro complet n'est jamais stocké.
// GET  /api/cards                    → { available, provider, fee, cards:[…] }
// POST /api/cards                    { label }              création (frais débités) — code de confirmation OTP
// POST /api/cards/:id/fund           { amount }             solde FCFA → carte — OTP
// POST /api/cards/:id/freeze|unfreeze|close
// POST /api/cards/:id/reveal         → { pan, cvv, expiry } affichage unique, jamais stocké — OTP
// GET  /api/cards/admin/status · POST /api/cards/admin/freeze/:id  (x-admin-key)
// Réglages : CARDS_PROVIDER, CARD_ISSUE_FEE_XOF (1000), CARD_MAX_PER_USER (3), CARD_MIN_FUND_XOF (500), CARD_MAX_FUND_XOF (500000)
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");
const issuer = require("../providers/cardIssuer.js");
const { generateOmniCard } = require("../services/cards/omniCardGenerator.js"); // identité OMNIPAY de la carte (n° OMNI-…, type, contrôles de dépense)
const sql = () => neon(process.env.DATABASE_URL);
const router = express.Router();
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v >= 0 ? v : d; };
const UUID = /^[0-9a-f-]{36}$/i;
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." }));
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);
let ready = false;
async function ensure() {
  if (ready) return;
  await sql()`CREATE TABLE IF NOT EXISTS omni_cards (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, provider varchar(20) NOT NULL, provider_card_id varchar(80), label varchar(40) NOT NULL,
    last4 varchar(4), brand varchar(12), expiry varchar(5), is_test boolean NOT NULL DEFAULT false, status varchar(12) NOT NULL DEFAULT 'creating', balance_xof numeric(18,2) NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now())`;
  for (const c of ["card_reference varchar(40)", "public_number varchar(24)", "ctype varchar(10) DEFAULT 'VIRTUAL'", "design varchar(20) DEFAULT 'MIDNIGHT'", "holder_name varchar(40)", "controls jsonb"]) await sql().query(`ALTER TABLE omni_cards ADD COLUMN IF NOT EXISTS ${c}`);
  await sql()`CREATE INDEX IF NOT EXISTS omni_cards_user ON omni_cards (user_id)`;
  ready = true;
}
const FEE = () => num("CARD_ISSUE_FEE_XOF", 1000), MAXN = () => num("CARD_MAX_PER_USER", 3), MINF = () => num("CARD_MIN_FUND_XOF", 500), MAXF = () => num("CARD_MAX_FUND_XOF", 500000);
const pub = (c) => ({ id: c.id, label: c.label, publicNumber: c.public_number, type: c.ctype || "VIRTUAL", design: c.design, holder: c.holder_name, controls: c.controls, last4: c.last4, brand: c.brand, expiry: c.expiry, test: c.is_test, status: c.status, balance: Number(c.balance_xof), createdAt: c.created_at });
const own = async (uid, id) => { if (!UUID.test(String(id))) return null; const [c] = await sql()`SELECT * FROM omni_cards WHERE id = ${id}::uuid AND user_id = ${uid}::uuid`; return c || null; };

router.get("/", requireAuth, async (req, res) => {
  try {
    await ensure(); const p = issuer.current();
    const cards = await sql()`SELECT * FROM omni_cards WHERE user_id = ${req.user.userId}::uuid AND status <> 'closed' AND status <> 'failed' ORDER BY created_at DESC`;
    res.json({ available: Boolean(p), provider: p ? p.name : null, test: Boolean(p && p.name === "test"), fee: FEE(), max: MAXN(), minFund: MINF(), maxFund: MAXF(), cards: cards.map(pub) });
  } catch (e) { console.error("CARD_LIST", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.post("/", requireAuth, async (req, res) => {
  const p = issuer.current(); if (!p) return res.status(503).json({ error: "Les cartes virtuelles ouvrent bientôt." });
  try {
    await ensure(); const uid = req.user.userId, label = clean((req.body || {}).label, 40) || "Ma carte";
    const [n] = await sql()`SELECT count(*)::int AS n FROM omni_cards WHERE user_id = ${uid}::uuid AND status IN ('creating','active','frozen')`;
    if (n.n >= MAXN()) return res.status(400).json({ error: `Maximum ${MAXN()} cartes.` });
    const b = req.body || {}, type = String(b.type || "VIRTUAL").toUpperCase();
    if (type === "PHYSICAL") return res.status(400).json({ error: "Les cartes physiques ouvrent bientôt (livraison à renseigner)." });
    const [u] = await sql()`SELECT first_name, last_name FROM users WHERE id = ${uid}::uuid`, nm = [u && u.first_name, u && u.last_name].filter(Boolean).join(" ");
    let g; try { g = generateOmniCard({ userId: uid, holderName: clean(b.holderName, 40) || nm || "CLIENT OMNIPAY", type: "VIRTUAL", currency: "XOF", design: clean(b.design, 20) || "MIDNIGHT" }); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const key = "cardfee-" + crypto.randomUUID(), fee = FEE();
    const rows = await sql()`
      WITH w AS (UPDATE wallets SET balance = balance - ${fee}, updated_at = now() WHERE user_id = ${uid}::uuid AND balance >= ${fee} RETURNING id, balance),
      o AS (INSERT INTO omni_cards (user_id, provider, label, status, card_reference, public_number, ctype, design, holder_name, controls) SELECT ${uid}::uuid, ${p.name}, ${label}, 'creating', ${g.cardReference}, ${g.publicNumber}, ${g.type}, ${g.design}, ${g.holderName}, ${JSON.stringify(g.spendingControls)}::jsonb FROM w RETURNING id),
      t AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key) SELECT w.id, 'card_fee', ${fee}, w.balance, 'completed', 'cards', o.id::text, ${key} FROM w, o RETURNING id)
      SELECT o.id, w.balance FROM o, w`;
    if (!rows.length) return res.status(400).json({ error: `Solde insuffisant : la création coûte ${fee} FCFA.` });
    const cardId = rows[0].id;
    try {
      const r = await p.create({ cardId, userId: uid, label });
      const [c] = await sql()`UPDATE omni_cards SET status = 'active', provider_card_id = ${r.providerCardId}, last4 = ${r.last4}, brand = ${r.brand}, expiry = ${r.expiry}, is_test = ${Boolean(r.test)} WHERE id = ${cardId}::uuid RETURNING *`;
      res.status(201).json({ card: pub(c), newBalance: Number(rows[0].balance) });
    } catch (e) { // l'émetteur a refusé : on rembourse les frais, atomiquement
      console.error("CARD_CREATE", e.message);
      await sql()`WITH f AS (UPDATE omni_cards SET status = 'failed' WHERE id = ${cardId}::uuid AND status = 'creating' RETURNING id),
        w AS (UPDATE wallets SET balance = balance + ${fee}, updated_at = now() WHERE user_id = ${uid}::uuid AND EXISTS (SELECT 1 FROM f) RETURNING id, balance)
        INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key) SELECT w.id, 'refund', ${fee}, w.balance, 'completed', 'cards', ${String(cardId)}, ${"cardrf-" + cardId} FROM w`;
      res.status(502).json({ error: "Création impossible pour le moment. Vos frais ont été remboursés." });
    }
  } catch (e) { console.error("CARD_NEW", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.post("/:id/fund", requireAuth, async (req, res) => {
  const p = issuer.current(); if (!p) return res.status(503).json({ error: "Les cartes virtuelles ouvrent bientôt." });
  try {
    await ensure(); const uid = req.user.userId, amount = Math.floor(Number((req.body || {}).amount)), c = await own(uid, req.params.id);
    if (!c) return res.status(404).json({ error: "Carte introuvable." });
    if (c.status !== "active") return res.status(400).json({ error: "Carte non active." });
    if (!(amount >= MINF()) || amount > MAXF()) return res.status(400).json({ error: `Montant : ${MINF()} à ${MAXF()} FCFA.` });
    const rows = await sql()`
      WITH k0 AS (SELECT id FROM omni_cards WHERE id = ${c.id}::uuid AND user_id = ${uid}::uuid AND status = 'active' FOR UPDATE),
      w AS (UPDATE wallets SET balance = balance - ${amount}, updated_at = now() WHERE user_id = ${uid}::uuid AND balance >= ${amount} AND EXISTS (SELECT 1 FROM k0) RETURNING id, balance),
      k AS (UPDATE omni_cards SET balance_xof = balance_xof + ${amount} WHERE id = ${c.id}::uuid AND EXISTS (SELECT 1 FROM w) RETURNING balance_xof),
      t AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key) SELECT w.id, 'card_topup', ${amount}, w.balance, 'completed', 'cards', ${String(c.id)}, ${"cardfund-" + crypto.randomUUID()} FROM w RETURNING id)
      SELECT w.balance AS wbal, k.balance_xof AS cbal FROM w, k`;
    if (!rows.length) return res.status(400).json({ error: "Solde insuffisant." });
    try { await p.fund({ providerCardId: c.provider_card_id, amountXof: amount }); }
    catch (e) { // l'émetteur n'a pas crédité : on annule le mouvement
      console.error("CARD_FUND", e.message);
      await sql()`WITH k AS (UPDATE omni_cards SET balance_xof = balance_xof - ${amount} WHERE id = ${c.id}::uuid RETURNING id),
        w AS (UPDATE wallets SET balance = balance + ${amount}, updated_at = now() WHERE user_id = ${uid}::uuid AND EXISTS (SELECT 1 FROM k) RETURNING id, balance)
        INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key) SELECT w.id, 'refund', ${amount}, w.balance, 'completed', 'cards', ${String(c.id)}, ${"cardfundrf-" + crypto.randomUUID()} FROM w`;
      return res.status(502).json({ error: "Alimentation impossible pour le moment. Votre solde n'a pas été débité." });
    }
    res.json({ message: "Carte alimentée.", newBalance: Number(rows[0].wbal), cardBalance: Number(rows[0].cbal) });
  } catch (e) { console.error("CARD_FUNDERR", e.message); res.status(500).json({ error: "Erreur." }); }
});

const setState = (to, from, label) => async (req, res) => {
  const p = issuer.current(); if (!p) return res.status(503).json({ error: "Les cartes virtuelles ouvrent bientôt." });
  try {
    await ensure(); const c = await own(req.user.userId, req.params.id); if (!c) return res.status(404).json({ error: "Carte introuvable." });
    if (c.status !== from) return res.status(400).json({ error: "Action impossible dans l'état actuel de la carte." });
    await p.setFrozen({ providerCardId: c.provider_card_id, frozen: to === "frozen" });
    await sql()`UPDATE omni_cards SET status = ${to} WHERE id = ${c.id}::uuid AND status = ${from}`;
    res.json({ message: label });
  } catch (e) { console.error("CARD_STATE", e.message); res.status(500).json({ error: "Erreur." }); }
};
router.post("/:id/freeze", requireAuth, setState("frozen", "active", "Carte gelée."));
router.post("/:id/unfreeze", requireAuth, setState("active", "frozen", "Carte réactivée."));

router.post("/:id/close", requireAuth, async (req, res) => { // le solde restant de la carte revient sur le portefeuille OMNIPAY
  const p = issuer.current(); if (!p) return res.status(503).json({ error: "Les cartes virtuelles ouvrent bientôt." });
  try {
    await ensure(); const uid = req.user.userId, c = await own(uid, req.params.id); if (!c) return res.status(404).json({ error: "Carte introuvable." });
    if (!["active", "frozen"].includes(c.status)) return res.status(400).json({ error: "Carte déjà clôturée." });
    await p.close({ providerCardId: c.provider_card_id });
    const rows = await sql()`
      WITH s AS (SELECT id, balance_xof AS amt FROM omni_cards WHERE id = ${c.id}::uuid AND user_id = ${uid}::uuid AND status IN ('active','frozen') FOR UPDATE),
      k AS (UPDATE omni_cards SET status = 'closed', balance_xof = 0 WHERE id IN (SELECT id FROM s) RETURNING id),
      w AS (UPDATE wallets SET balance = balance + (SELECT amt FROM s), updated_at = now() WHERE user_id = ${uid}::uuid AND EXISTS (SELECT 1 FROM k) RETURNING id, balance),
      t AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key) SELECT w.id, 'refund', (SELECT amt FROM s), w.balance, 'completed', 'cards', ${String(c.id)}, ${"cardclose-" + c.id} FROM w WHERE (SELECT amt FROM s) > 0 RETURNING id)
      SELECT w.balance, (SELECT amt FROM s)::float AS amt FROM w`;
    if (!rows.length) return res.status(400).json({ error: "Carte déjà clôturée." });
    res.json({ message: "Carte clôturée." + (rows[0].amt > 0 ? " Le solde restant est revenu sur votre OMNIPAY." : ""), newBalance: Number(rows[0].balance) });
  } catch (e) { console.error("CARD_CLOSE", e.message); res.status(500).json({ error: "Erreur." }); }
});

const lastReveal = new Map();
router.post("/:id/reveal", requireAuth, async (req, res) => {
  const p = issuer.current(); if (!p) return res.status(503).json({ error: "Les cartes virtuelles ouvrent bientôt." });
  try {
    await ensure(); const uid = String(req.user.userId), now = Date.now(), arr = (lastReveal.get(uid) || []).filter((t) => now - t < 60000);
    if (arr.length >= 5) return res.status(429).json({ error: "Trop de demandes. Réessayez dans une minute." });
    arr.push(now); lastReveal.set(uid, arr);
    const c = await own(uid, req.params.id); if (!c || !["active", "frozen"].includes(c.status)) return res.status(404).json({ error: "Carte introuvable." });
    const d = await p.reveal({ cardId: c.id, providerCardId: c.provider_card_id });
    res.set("Cache-Control", "no-store"); res.json({ pan: d.pan, cvv: d.cvv, expiry: d.expiry, test: Boolean(d.test) });
  } catch (e) { console.error("CARD_REVEAL", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.get("/admin/status", adminOnly, async (req, res) => {
  try { await ensure(); const p = issuer.current();
    const [s] = await sql()`SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'frozen')::int AS frozen, coalesce(sum(balance_xof) FILTER (WHERE status IN ('active','frozen')),0)::float AS held FROM omni_cards`;
    res.json({ provider: p ? p.name : null, fee: FEE(), ...s });
  } catch (e) { console.error("CARD_ADM", e.message); res.status(500).json({ error: "Erreur." }); }
});
router.post("/admin/freeze/:id", adminOnly, async (req, res) => {
  try { await ensure(); if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    const r = await sql()`UPDATE omni_cards SET status = 'frozen' WHERE id = ${req.params.id}::uuid AND status = 'active' RETURNING id`; res.json({ ok: r.length === 1 });
  } catch (e) { console.error("CARD_AFRZ", e.message); res.status(500).json({ error: "Erreur." }); }
});
module.exports = router;
