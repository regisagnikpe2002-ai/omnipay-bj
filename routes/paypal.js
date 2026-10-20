"use strict";
// OMNIPAY — dépôt par PayPal (fichier AJOUTÉ). Fonctionne UNIQUEMENT avec les identifiants API du titulaire du compte PayPal Business
// (developer.paypal.com → Apps & Credentials → Live). Variables Render :
//   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV = "live" ou "sandbox" (défaut sandbox), PAYPAL_WEBHOOK_ID (facultatif, conseillé),
//   PAYPAL_FEE_PCT (défaut 5 : frais PayPal ajoutés au prix payé par le client), PAYPAL_MIN_XOF / PAYPAL_MAX_XOF, PUBLIC_BASE_URL.
// Le FCFA étant arrimé à l'euro (1 EUR = 655,957 FCFA), la commande est en EUR. Le crédit n'a lieu qu'après CAPTURE confirmée (COMPLETED),
// de façon atomique : aucun double crédit possible.
const crypto = require("crypto");
const axios = require("axios");
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const XOF_PER_EUR = 655.957;
const MIN = Number(process.env.PAYPAL_MIN_XOF || 1000);
const MAX = Number(process.env.PAYPAL_MAX_XOF || 500000);
const feePct = () => { const v = Number(process.env.PAYPAL_FEE_PCT); return Number.isFinite(v) && v >= 0 && v <= 20 ? v : 5; };
const api = () => (String(process.env.PAYPAL_ENV || "sandbox").toLowerCase() === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");
const baseUrl = () => (process.env.PUBLIC_BASE_URL || "https://www.omnipay-bj.com").replace(/\/$/, "");
const configured = () => Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
let cache = { t: null, exp: 0 };

async function accessToken() {
  if (cache.t && Date.now() < cache.exp) return cache.t;
  const r = await axios.post(`${api()}/v1/oauth2/token`, "grant_type=client_credentials", {
    auth: { username: process.env.PAYPAL_CLIENT_ID, password: process.env.PAYPAL_CLIENT_SECRET },
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 20000 });
  cache = { t: r.data.access_token, exp: Date.now() + Math.max(60, Number(r.data.expires_in || 300) - 60) * 1000 };
  return cache.t;
}
const auth = async () => ({ Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" });

// Crédit atomique d'un dépôt PayPal en attente (une seule fois).
const creditPending = (orderKey) => sql()`
  WITH t AS (SELECT id, wallet_id, amount FROM transactions WHERE idempotency_key = ${orderKey} AND provider = 'paypal' AND status = 'pending' FOR UPDATE),
  w AS (UPDATE wallets SET balance = balance + t.amount, updated_at = now() FROM t WHERE wallets.id = t.wallet_id RETURNING wallets.balance, t.id AS tx_id),
  u AS (UPDATE transactions SET status = 'completed', balance_after = w.balance FROM w WHERE transactions.id = w.tx_id AND transactions.status = 'pending' RETURNING transactions.id)
  SELECT w.balance FROM w`;

router.get("/status", requireAuth, (req, res) => res.json({ enabled: configured(), feePct: feePct(), min: MIN, max: MAX }));

router.post("/order", requireAuth, async (req, res) => {
  try {
    if (!configured()) return res.status(503).json({ error: "Dépôt PayPal indisponible pour le moment." });
    const xof = Math.floor(Number(req.body?.amountXof));
    if (!Number.isFinite(xof) || xof < MIN || xof > MAX) return res.status(400).json({ error: `Montant entre ${MIN} et ${MAX} FCFA.` });
    const eur = Math.ceil((xof / XOF_PER_EUR) * (1 + feePct() / 100) * 100) / 100;
    const q = sql();
    const w = await q`SELECT id, balance FROM wallets WHERE user_id = ${req.user.userId}::uuid`;
    if (!w.length) return res.status(404).json({ error: "Wallet introuvable." });
    const orderKey = "OMPPP" + Date.now() + crypto.randomBytes(3).toString("hex");
    const h = { ...(await auth()), "PayPal-Request-Id": orderKey };
    const r = await axios.post(`${api()}/v2/checkout/orders`, {
      intent: "CAPTURE",
      purchase_units: [{ reference_id: orderKey, custom_id: orderKey, description: `Dépôt OMNIPAY ${xof} FCFA`, amount: { currency_code: "EUR", value: eur.toFixed(2) } }],
      payment_source: { paypal: { experience_context: { brand_name: "OMNIPAY", locale: "fr-FR", landing_page: "LOGIN", user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING",
        return_url: `${baseUrl()}/?paypal=success`, cancel_url: `${baseUrl()}/?paypal=cancelled` } } },
    }, { headers: h, timeout: 20000 });
    const o = r.data || {};
    const link = (o.links || []).find((l) => l.rel === "payer-action") || (o.links || []).find((l) => l.rel === "approve");
    if (!o.id || !link) return res.status(502).json({ error: "PayPal a refusé la commande." });
    await q`INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key, metadata)
            VALUES (${w[0].id}, 'deposit', ${xof}, ${w[0].balance}, 'pending', 'paypal', ${String(o.id)}, ${orderKey}, ${JSON.stringify({ orderKey, eur, xof, feePct: feePct() })}::jsonb)`;
    res.status(201).json({ approveUrl: link.href, amountEur: eur, creditXof: xof, feePct: feePct() });
  } catch (e) { console.error("PAYPAL_ORDER", e.response?.data || e.message); res.status(500).json({ error: "Impossible de créer le paiement PayPal." }); }
});

// Appelé par l'application quand le client revient de PayPal (?paypal=success&token=<id commande>).
router.post("/capture", requireAuth, async (req, res) => {
  try {
    const orderId = String(req.body?.orderId || "");
    if (!/^[A-Z0-9]{10,30}$/.test(orderId)) return res.status(400).json({ error: "Commande invalide." });
    const q = sql();
    const t = await q`SELECT t.idempotency_key, t.status, t.metadata FROM transactions t JOIN wallets w ON w.id = t.wallet_id
      WHERE t.provider = 'paypal' AND t.provider_ref = ${orderId} AND w.user_id = ${req.user.userId}::uuid`;
    if (!t.length) return res.status(404).json({ error: "Commande introuvable." });
    if (t[0].status === "completed") return res.json({ message: "Dépôt déjà crédité.", status: "completed" });
    if (t[0].status !== "pending") return res.status(409).json({ error: "Cette commande n'est plus valide." });
    const eur = Number(t[0].metadata?.eur);
    let data;
    try {
      data = (await axios.post(`${api()}/v2/checkout/orders/${orderId}/capture`, {}, { headers: { ...(await auth()), "PayPal-Request-Id": "cap-" + orderId }, timeout: 20000 })).data;
    } catch (e) {
      const issue = e.response?.data?.details?.[0]?.issue;
      if (issue !== "ORDER_ALREADY_CAPTURED") throw e;
      data = (await axios.get(`${api()}/v2/checkout/orders/${orderId}`, { headers: await auth(), timeout: 20000 })).data;
    }
    const cap = data?.purchase_units?.[0]?.payments?.captures?.[0];
    if (data?.status !== "COMPLETED" || !cap || cap.status !== "COMPLETED") return res.json({ message: "Paiement en cours de confirmation par PayPal.", status: "pending" });
    if (cap.amount?.currency_code !== "EUR" || Number(cap.amount?.value) + 0.0001 < eur) return res.status(400).json({ error: "Montant payé inattendu : contactez OMNIPAY." });
    await creditPending(t[0].idempotency_key);
    res.json({ message: "Dépôt PayPal crédité.", status: "completed" });
  } catch (e) { console.error("PAYPAL_CAPTURE", e.response?.data || e.message); res.status(500).json({ error: "Impossible de confirmer le paiement PayPal." }); }
});

// Webhook PayPal (filet de sécurité si le client ne revient pas sur le site) + alerte en cas de remboursement/contestation.
router.post("/webhook", async (req, res) => {
  try {
    if (!configured() || !process.env.PAYPAL_WEBHOOK_ID) return res.status(200).send("IGNORED");
    const hd = (k) => req.get(k);
    const v = await axios.post(`${api()}/v1/notifications/verify-webhook-signature`, {
      auth_algo: hd("paypal-auth-algo"), cert_url: hd("paypal-cert-url"), transmission_id: hd("paypal-transmission-id"), transmission_sig: hd("paypal-transmission-sig"),
      transmission_time: hd("paypal-transmission-time"), webhook_id: process.env.PAYPAL_WEBHOOK_ID, webhook_event: req.body }, { headers: await auth(), timeout: 20000 });
    if (v.data?.verification_status !== "SUCCESS") return res.status(401).send("INVALID_SIGNATURE");
    const ev = req.body || {};
    const cap = ev.resource || {};
    const orderKey = String(cap.custom_id || "");
    if (!orderKey.startsWith("OMPPP")) return res.status(200).send("OK");
    const q = sql();
    if (ev.event_type === "PAYMENT.CAPTURE.COMPLETED") {
      const t = await q`SELECT metadata FROM transactions WHERE idempotency_key = ${orderKey} AND provider = 'paypal'`;
      const eur = Number(t[0]?.metadata?.eur);
      if (t.length && cap.amount?.currency_code === "EUR" && Number(cap.amount?.value) + 0.0001 >= eur) await creditPending(orderKey);
    } else if (["PAYMENT.CAPTURE.REVERSED", "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.DENIED"].includes(ev.event_type)) {
      await q`UPDATE transactions SET metadata = coalesce(metadata,'{}'::jsonb) || ${JSON.stringify({ paypalDispute: ev.event_type })}::jsonb WHERE idempotency_key = ${orderKey}`;
      try {
        await q`INSERT INTO aml_alerts (user_id, rule, detail) SELECT w.user_id, 'PP_REVERSAL', ${"PayPal : " + ev.event_type + " sur la commande " + orderKey}
                FROM transactions t JOIN wallets w ON w.id = t.wallet_id WHERE t.idempotency_key = ${orderKey} ON CONFLICT DO NOTHING`;
      } catch (_) { /* table d'alertes absente : ignoré */ }
    }
    res.status(200).send("OK");
  } catch (e) { console.error("PAYPAL_WEBHOOK", e.response?.data || e.message); res.status(500).send("ERROR"); }
});

module.exports = router;
