"use strict";
// OMNIPAY — BUREAU CASH / OMNIXPAY (fichier AJOUTÉ). Retraits d'espèces livrés par l'administrateur, sous séquestre.
// Principe : l'expéditeur PAIE d'abord sur vos comptes de base (PI-SPI, MoMo, banque) avec la référence de la commande ; vous constatez la réception
// réelle et la liez à la commande ; le receveur (obligatoirement client OMNIPAY, identifié par son ID OM) voit son code à 6 chiffres dans son application ;
// vous livrez les espèces contre ce code. Aucun crédit « virtuel » n'est créé : le portefeuille n'est jamais touché, chaque franc suivi ici correspond à un paiement réel reçu.
//   Admin (x-admin-key) : POST /order · GET /orders · POST /order/:id/fund {paymentId} · POST /order/:id/deliver {code} · POST /order/:id/cancel
//   Client receveur     : GET /mine  (ses commandes, avec le code quand la commande est financée)
// Variables : CASHDESK_MAX_XOF (plafond du total en séquestre, défaut 20 000 000) · CASHDESK_HOURS (délai avant remboursement à l'expéditeur, défaut 48) · CASHDESK_MIN_XOF (défaut 1 000)
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." }));
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const numEnv = (n, d) => { const v = Number(process.env[n]); return Number.isFinite(v) && v > 0 ? v : d; };
const MAX = () => numEnv("CASHDESK_MAX_XOF", 20000000);
const MIN = () => numEnv("CASHDESK_MIN_XOF", 1000);
const HOURS = () => numEnv("CASHDESK_HOURS", 48);
const MAX_TRIES = 5;
const CHANNELS = ["momo", "mtn", "moov", "celtiis", "pispi", "bank"];

// Code à 6 chiffres déduit de l'identifiant de commande (HMAC) : rien à stocker, impossible à deviner sans la clé serveur.
const codeOf = (id) => String(parseInt(crypto.createHmac("sha256", String(process.env.ADMIN_KEY || "") + ":cashdesk").update(String(id)).digest("hex").slice(0, 8), 16) % 1000000).padStart(6, "0");

let ready = null;
async function ensure() {
  if (!ready) ready = (async () => {
    await sql()`CREATE TABLE IF NOT EXISTS cash_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ref varchar(16) NOT NULL UNIQUE, receiver_id uuid NOT NULL, receiver_code varchar(13) NOT NULL,
      amount_xof numeric(18,2) NOT NULL, city varchar(80) NOT NULL, sender_name varchar(120), note varchar(200),
      status varchar(12) NOT NULL DEFAULT 'open', payment_id uuid, tries int NOT NULL DEFAULT 0, deadline timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), funded_at timestamptz, closed_at timestamptz)`;
  })().catch((e) => { ready = null; throw e; });
  return ready;
}
const newRef = () => "CASH-" + crypto.randomBytes(4).toString("hex").toUpperCase();

// Les commandes financées dont le délai est dépassé passent en « expired » : le paiement redevient « à rembourser » à l'expéditeur.
async function sweep() {
  await sql()`
    WITH d AS (UPDATE cash_orders SET status = 'expired', closed_at = now() WHERE status = 'funded' AND deadline < now() RETURNING payment_id)
    UPDATE inbound_payments SET status = 'received' FROM d WHERE inbound_payments.id = d.payment_id AND inbound_payments.status = 'cashdesk'`;
}
const outstanding = async () => (await sql()`SELECT coalesce(sum(amount_xof),0)::float AS v FROM cash_orders WHERE status IN ('open','funded')`)[0].v;

router.post("/order", adminOnly, async (req, res) => {
  try {
    await ensure(); await sweep();
    const b = req.body || {};
    const om = clean(b.receiverOm, 13).toUpperCase().replace(/\s/g, "");
    const amount = Math.floor(Number(b.amount)), city = clean(b.city, 80);
    if (!/^OM\d{11}$/.test(om)) return res.status(400).json({ error: "ID OM du receveur invalide (OM + 11 chiffres)." });
    if (!(amount >= MIN())) return res.status(400).json({ error: `Montant minimum : ${MIN()} FCFA.` });
    if (city.length < 2) return res.status(400).json({ error: "Indiquez la ville de livraison." });
    const u = await sql()`SELECT user_id FROM account_ids WHERE code = ${om}`;
    if (!u.length) return res.status(404).json({ error: "Ce receveur n'a pas de compte OMNIPAY : il doit s'inscrire d'abord." });
    const used = await outstanding();
    if (used + amount > MAX()) return res.status(409).json({ error: `Plafond du Bureau Cash atteint : ${Math.round(used)} F déjà en cours sur ${MAX()} F.` });
    const ref = newRef();
    const r = await sql()`INSERT INTO cash_orders (ref, receiver_id, receiver_code, amount_xof, city, sender_name, note) VALUES (${ref}, ${u[0].user_id}, ${om}, ${amount}, ${city}, ${clean(b.senderName, 120) || null}, ${clean(b.note, 200) || null}) RETURNING id`;
    res.status(201).json({ id: r[0].id, ref, message: `Commande créée. L'expéditeur doit payer ${amount} F sur vos comptes avec la référence ${ref}.` });
  } catch (e) { console.error("CASHDESK_ORDER", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.get("/orders", adminOnly, async (req, res) => {
  try {
    await ensure(); await sweep();
    const orders = await sql()`SELECT o.id, o.ref, o.receiver_code, o.amount_xof::float AS amount_xof, o.city, o.sender_name, o.note, o.status, o.payment_id, o.tries, o.deadline, o.created_at,
        u.first_name, u.last_name, u.phone FROM cash_orders o LEFT JOIN users u ON u.id = o.receiver_id ORDER BY o.created_at DESC LIMIT 60`;
    for (const o of orders) {
      if (o.status === "open") o.candidates = await sql()`SELECT id, channel, external_id, amount::float AS amount, payer, reference, created_at FROM inbound_payments
        WHERE status = 'received' AND channel = ANY(${CHANNELS}) AND amount = ${o.amount_xof} ORDER BY (upper(coalesce(reference,'')) = ${o.ref}) DESC, created_at DESC LIMIT 8`;
    }
    const used = await outstanding();
    const toRefund = await sql()`SELECT o.ref, o.amount_xof::float AS amount_xof, o.sender_name FROM cash_orders o WHERE o.status IN ('expired','cancelled') AND o.payment_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM inbound_payments p WHERE p.id = o.payment_id AND p.status = 'received') LIMIT 30`;
    res.json({ orders, outstanding: used, max: MAX(), hours: HOURS(), toRefund });
  } catch (e) { console.error("CASHDESK_LIST", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

// Financement : le paiement doit être « received », de MÊME montant, et la commande « open » ; les deux changent d'état en une seule instruction.
router.post("/order/:id/fund", adminOnly, async (req, res) => {
  try {
    const id = String(req.params.id), pid = String(req.body?.paymentId || "");
    if (!UUID.test(id) || !UUID.test(pid)) return res.status(400).json({ error: "Identifiants invalides." });
    await ensure();
    const r = await sql()`
      WITH o AS (SELECT id, amount_xof FROM cash_orders WHERE id = ${id}::uuid AND status = 'open'),
      p AS (UPDATE inbound_payments SET status = 'cashdesk' FROM o WHERE inbound_payments.id = ${pid}::uuid AND inbound_payments.status = 'received' AND inbound_payments.amount = o.amount_xof RETURNING inbound_payments.id),
      d AS (UPDATE cash_orders SET status = 'funded', payment_id = p.id, funded_at = now(), deadline = now() + (${HOURS()}::float8 * interval '1 hour') FROM p WHERE cash_orders.id = ${id}::uuid AND cash_orders.status = 'open' RETURNING cash_orders.id)
      SELECT (SELECT count(*) FROM d)::int AS n`;
    if (r[0]?.n !== 1) return res.status(409).json({ error: "Impossible : commande déjà traitée, paiement déjà utilisé ou montant différent." });
    res.json({ message: `Commande financée. Le receveur voit son code dans son application OMNIPAY. Livraison avant ${HOURS()} h.` });
  } catch (e) { console.error("CASHDESK_FUND", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/order/:id/deliver", adminOnly, async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!UUID.test(id)) return res.status(400).json({ error: "Identifiant invalide." });
    await ensure(); await sweep();
    const code = clean(req.body?.code, 6);
    // Compte l'essai AVANT de comparer (anti-devinette), puis clôture seulement si le code est bon.
    const t = await sql()`UPDATE cash_orders SET tries = tries + 1 WHERE id = ${id}::uuid AND status = 'funded' AND tries < ${MAX_TRIES} RETURNING id`;
    if (!t.length) return res.status(409).json({ error: "Commande non financée, expirée, déjà livrée ou bloquée après trop d'essais." });
    if (code !== codeOf(id)) return res.status(403).json({ error: "Code incorrect. Ne remettez PAS les espèces." });
    const r = await sql()`UPDATE cash_orders SET status = 'delivered', closed_at = now() WHERE id = ${id}::uuid AND status = 'funded' RETURNING id`;
    if (!r.length) return res.status(409).json({ error: "Commande déjà clôturée." });
    res.json({ message: "Code valide : vous pouvez remettre les espèces. Commande clôturée." });
  } catch (e) { console.error("CASHDESK_DELIVER", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/order/:id/cancel", adminOnly, async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!UUID.test(id)) return res.status(400).json({ error: "Identifiant invalide." });
    await ensure();
    const r = await sql()`
      WITH d AS (UPDATE cash_orders SET status = 'cancelled', closed_at = now() WHERE id = ${id}::uuid AND status IN ('open','funded') RETURNING payment_id),
      p AS (UPDATE inbound_payments SET status = 'received' FROM d WHERE inbound_payments.id = d.payment_id AND inbound_payments.status = 'cashdesk' RETURNING 1)
      SELECT (SELECT count(*) FROM d)::int AS n`;
    if (r[0]?.n !== 1) return res.status(409).json({ error: "Commande introuvable ou déjà clôturée." });
    res.json({ message: "Commande annulée. Si un paiement était lié, rendez l'argent à l'expéditeur (il est listé « à rembourser »)." });
  } catch (e) { console.error("CASHDESK_CANCEL", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

// Côté receveur : il voit sa commande et son code (jamais celui des autres).
router.get("/mine", requireAuth, async (req, res) => {
  try {
    await ensure(); await sweep();
    const rows = await sql()`SELECT id, ref, amount_xof::float AS amount_xof, city, status, deadline, created_at FROM cash_orders WHERE receiver_id = ${req.user.userId}::uuid ORDER BY created_at DESC LIMIT 20`;
    res.json({ orders: rows.map((o) => ({ ref: o.ref, amount: o.amount_xof, city: o.city, status: o.status, deadline: o.deadline, createdAt: o.created_at, code: o.status === "funded" ? codeOf(o.id) : null })) });
  } catch (e) { console.error("CASHDESK_MINE", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router._test = { codeOf };
module.exports = router;
