"use strict";
// OMNIPAY — BUREAU P2P (fichier AJOUTÉ, admin uniquement). Sert à ne JAMAIS libérer des cryptos sur Binance P2P sans paiement réellement reçu.
// Binance n'offre aucune API pour libérer un ordre : la libération reste un clic de votre part dans l'application Binance.
// Ce module est le garde-fou : il rapproche l'ordre P2P (acheteur, montant en FCFA) du paiement Mobile Money enregistré dans OMNICHECK
// (table inbound_payments, canal momo/mtn/…), vérifie le montant EXACT et le NOM du payeur, et verrouille le paiement pour qu'il ne serve qu'UNE fois.
//   POST /order            {orderNumber, asset, cryptoAmount, fiatXof, buyerName, side?}   déclare l'ordre (vu dans Binance)
//   GET  /orders           liste + paiements candidats (montant identique, non utilisés) + contrôle du nom
//   POST /order/:id/confirm {paymentId}                  lie le paiement (atomique, un paiement = un ordre)
//   POST /order/:id/released                             « j'ai libéré dans Binance » (seulement si le paiement est confirmé)
//   POST /order/:id/cancel                               annule l'ordre (le paiement lié redevient « à rapprocher »)
// Option P2P_AUTO_CONFIRM=on : si UN SEUL paiement correspond au montant ET au nom, le lien se fait tout seul (la libération reste manuelle).
const express = require("express");
const { neon } = require("@neondatabase/serverless");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
router.use((req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." })));
const on = (n) => ["on", "true", "1", "yes"].includes(String(process.env[n] || "off").toLowerCase());
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNELS = ["momo", "mtn", "moov", "celtiis", "pispi"];

let ready = null;
async function ensure() {
  if (!ready) ready = (async () => {
    await sql()`CREATE TABLE IF NOT EXISTS p2p_desk (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_number varchar(30) NOT NULL UNIQUE, side varchar(4) NOT NULL DEFAULT 'sell',
      asset varchar(12) NOT NULL, crypto_amount numeric(24,8) NOT NULL, fiat_xof numeric(18,2) NOT NULL, buyer_name varchar(120) NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'open', payment_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`;
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

// Comparaison de noms tolérante (ordre, accents, casse) : tous les mots du plus court nom doivent se retrouver dans l'autre.
const words = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z ]/g, " ").split(/\s+/).filter((w) => w.length > 1);
function nameMatch(a, b) {
  const A = words(a), B = words(b);
  if (!A.length || !B.length) return false;
  const [s, l] = A.length <= B.length ? [A, B] : [B, A];
  return s.every((w) => l.includes(w));
}

async function candidates(o) {
  const rows = await sql()`SELECT id, channel, external_id, amount::float AS amount, payer, created_at FROM inbound_payments
    WHERE status = 'received' AND channel = ANY(${CHANNELS}) AND amount = ${o.fiat_xof} AND created_at >= ${new Date(o.created_at).toISOString()}::timestamptz - interval '2 hours'
    ORDER BY created_at DESC LIMIT 10`;
  return rows.map((p) => ({ ...p, nameMatch: nameMatch(p.payer, o.buyer_name) }));
}

// Lien atomique : le paiement doit être « received », même montant, et l'ordre « open » ; les deux changent d'état en une seule instruction.
const link = (orderId, paymentId) => sql()`
  WITH o AS (SELECT id, fiat_xof FROM p2p_desk WHERE id = ${orderId}::uuid AND status = 'open'),
  p AS (UPDATE inbound_payments SET status = 'p2p' FROM o WHERE inbound_payments.id = ${paymentId}::uuid AND inbound_payments.status = 'received' AND inbound_payments.amount = o.fiat_xof RETURNING inbound_payments.id),
  d AS (UPDATE p2p_desk SET status = 'paid', payment_id = p.id, updated_at = now() FROM p WHERE p2p_desk.id = ${orderId}::uuid AND p2p_desk.status = 'open' RETURNING p2p_desk.id)
  SELECT (SELECT count(*) FROM d)::int AS n`;

async function autoLink() {
  if (!on("P2P_AUTO_CONFIRM")) return 0;
  let n = 0;
  const open = await sql()`SELECT * FROM p2p_desk WHERE status = 'open' ORDER BY created_at LIMIT 50`;
  for (const o of open) {
    const good = (await candidates(o)).filter((c) => c.nameMatch);
    if (good.length === 1 && (await link(o.id, good[0].id))[0]?.n === 1) n++;
  }
  return n;
}

router.post("/order", async (req, res) => {
  try {
    await ensure();
    const b = req.body || {};
    const orderNumber = clean(b.orderNumber, 30), asset = clean(b.asset, 12).toUpperCase(), buyer = clean(b.buyerName, 120);
    const crypto = Number(b.cryptoAmount), fiat = Math.floor(Number(b.fiatXof)), side = String(b.side || "sell").toLowerCase() === "buy" ? "buy" : "sell";
    if (!/^\d{12,25}$/.test(orderNumber)) return res.status(400).json({ error: "Numéro d'ordre Binance invalide (12 à 25 chiffres)." });
    if (!/^[A-Z0-9]{2,12}$/.test(asset)) return res.status(400).json({ error: "Crypto invalide (ex. BTC, USDT)." });
    if (!(crypto > 0) || !(fiat >= 1) || fiat > 50000000) return res.status(400).json({ error: "Montants invalides." });
    if (words(buyer).length < 1) return res.status(400).json({ error: "Nom de l'acheteur requis (celui affiché par Binance)." });
    const r = await sql()`INSERT INTO p2p_desk (order_number, side, asset, crypto_amount, fiat_xof, buyer_name) VALUES (${orderNumber}, ${side}, ${asset}, ${crypto}, ${fiat}, ${buyer})
      ON CONFLICT (order_number) DO NOTHING RETURNING id`;
    if (!r.length) return res.status(409).json({ error: "Cet ordre est déjà enregistré." });
    await autoLink();
    res.status(201).json({ id: r[0].id, message: "Ordre enregistré. Dès que le paiement MoMo est enregistré dans OMNICHECK, il sera rapproché." });
  } catch (e) { console.error("P2PDESK_ORDER", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.get("/orders", async (req, res) => {
  try {
    await ensure();
    const auto = await autoLink();
    const rows = await sql()`SELECT id, order_number, side, asset, crypto_amount::float AS crypto_amount, fiat_xof::float AS fiat_xof, buyer_name, status, payment_id, created_at, updated_at
      FROM p2p_desk ORDER BY created_at DESC LIMIT 50`;
    const orders = [];
    for (const o of rows) {
      const item = { ...o };
      if (o.status === "open") item.candidates = await candidates({ ...o, created_at: o.created_at });
      if (o.payment_id) {
        const p = await sql()`SELECT channel, external_id, amount::float AS amount, payer FROM inbound_payments WHERE id = ${o.payment_id}::uuid`;
        item.payment = p[0] ? { ...p[0], nameMatch: nameMatch(p[0].payer, o.buyer_name) } : null;
      }
      orders.push(item);
    }
    res.json({ orders, autoConfirm: on("P2P_AUTO_CONFIRM"), autoLinked: auto });
  } catch (e) { console.error("P2PDESK_LIST", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/order/:id/confirm", async (req, res) => {
  try {
    const id = String(req.params.id), pid = String(req.body?.paymentId || "");
    if (!UUID.test(id) || !UUID.test(pid)) return res.status(400).json({ error: "Identifiants invalides." });
    await ensure();
    const r = await link(id, pid);
    if (r[0]?.n !== 1) return res.status(409).json({ error: "Impossible : ordre déjà traité, paiement déjà utilisé ou montant différent." });
    res.json({ message: "Paiement lié à l'ordre. Vous pouvez libérer dans Binance." });
  } catch (e) { console.error("P2PDESK_CONFIRM", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/order/:id/released", async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!UUID.test(id)) return res.status(400).json({ error: "Identifiant invalide." });
    await ensure();
    const r = await sql()`UPDATE p2p_desk SET status = 'released', updated_at = now() WHERE id = ${id}::uuid AND status = 'paid' RETURNING id`;
    if (!r.length) return res.status(409).json({ error: "Aucun paiement confirmé pour cet ordre : ne libérez pas." });
    res.json({ message: "Ordre clôturé." });
  } catch (e) { console.error("P2PDESK_RELEASED", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/order/:id/cancel", async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!UUID.test(id)) return res.status(400).json({ error: "Identifiant invalide." });
    await ensure();
    const r = await sql()`
      WITH d AS (UPDATE p2p_desk SET status = 'cancelled', updated_at = now() WHERE id = ${id}::uuid AND status IN ('open','paid') RETURNING payment_id),
      p AS (UPDATE inbound_payments SET status = 'received' FROM d WHERE inbound_payments.id = d.payment_id AND inbound_payments.status = 'p2p' RETURNING 1)
      SELECT (SELECT count(*) FROM d)::int AS n`;
    if (r[0]?.n !== 1) return res.status(409).json({ error: "Ordre introuvable ou déjà clôturé." });
    res.json({ message: "Ordre annulé. Si un paiement était lié, il redevient « à rapprocher » (à rembourser à l'acheteur)." });
  } catch (e) { console.error("P2PDESK_CANCEL", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router._test = { nameMatch };
module.exports = router;
