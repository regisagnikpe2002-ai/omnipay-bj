"use strict";
// OMNIPAY — Binance Pay (remplace l'ancien fichier, mêmes exports).
// Correctif majeur : le montant payé en USDT est CONVERTI en FCFA (USDT_XOF_RATE) avant crédit.
// Sans USDT_XOF_RATE, aucune commande n'est créée (impossible de créditer au mauvais taux).
const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");
const binancePay = require("../integrations/binance/payClient.js");

const sql = () => neon(process.env.DATABASE_URL);
const MIN_USDT = Number(process.env.BINANCE_MIN_USDT || 2);
const MAX_USDT = Number(process.env.BINANCE_MAX_USDT || 2000);

const baseUrl = () => (process.env.PUBLIC_BASE_URL || "https://www.omnipay-bj.com").replace(/\/$/, "");
const rate = () => Number(process.env.USDT_XOF_RATE);
const merchantTradeNo = () => `OMP${Date.now()}${crypto.randomBytes(4).toString("hex")}`.slice(0, 32);

async function createBinancePayOrder(req, res) {
  try {
    if (!binancePay.configured()) return res.status(503).json({ error: "Binance Pay n'est pas configuré." });
    const r = rate();
    if (!Number.isFinite(r) || r < 100) return res.status(503).json({ error: "Dépôt USDT indisponible : taux de conversion non configuré." });
    const usdt = Math.round(Number(req.body.amount) * 100) / 100;
    if (!Number.isFinite(usdt) || usdt < MIN_USDT || usdt > MAX_USDT) {
      return res.status(400).json({ error: `Montant USDT entre ${MIN_USDT} et ${MAX_USDT}.` });
    }
    const xof = Math.floor(usdt * r); // crédit en FCFA, arrondi vers le bas

    const q = sql();
    const w = await q`SELECT id, balance FROM wallets WHERE user_id = ${req.user.userId}`;
    if (!w.length) return res.status(404).json({ error: "Wallet introuvable." });

    const tradeNo = merchantTradeNo();
    const root = baseUrl();
    const result = await binancePay.createOrder({
      merchantTradeNo: tradeNo, amount: usdt, currency: "USDT",
      returnUrl: `${root}/?binance=success`, cancelUrl: `${root}/?binance=cancelled`,
      webhookUrl: `${root}/api/binance-pay/webhook`,
    });
    if (result.status !== "SUCCESS" || !result.data?.prepayId) {
      return res.status(502).json({ error: result.errorMessage || "Création Binance Pay refusée." });
    }

    await q`INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key, metadata)
            VALUES (${w[0].id}, 'deposit', ${xof}, ${w[0].balance}, 'pending', 'binance_pay', ${String(result.data.prepayId)}, ${tradeNo},
                    ${JSON.stringify({ merchantTradeNo: tradeNo, currency: "USDT", usdtAmount: usdt, rate: r })}::jsonb)`;

    return res.status(201).json({
      omnipayId: tradeNo, status: "pending", currency: "USDT", amount: usdt, creditXof: xof, rate: r,
      prepayId: result.data.prepayId, qrcodeLink: result.data.qrcodeLink, qrContent: result.data.qrContent,
      checkoutUrl: result.data.checkoutUrl, deeplink: result.data.deeplink, universalUrl: result.data.universalUrl,
      expireTime: result.data.expireTime,
    });
  } catch (err) {
    console.error("BINANCE_PAY_CREATE", err.response?.data || err.message || err);
    return res.status(500).json({ error: "Impossible de créer la demande Binance Pay." });
  }
}

async function binancePayWebhook(req, res) {
  try {
    const rawBody = req.rawBody || JSON.stringify(req.body || {});
    const valid = await binancePay.verifyWebhook({
      timestamp: req.get("BinancePay-Timestamp"), nonce: req.get("BinancePay-Nonce"),
      signature: req.get("BinancePay-Signature"), certificateSN: req.get("BinancePay-Certificate-SN"), rawBody,
    });
    if (!valid) return res.status(401).send("INVALID_SIGNATURE");

    const event = req.body || {};
    let data = event.data;
    if (typeof data === "string") data = JSON.parse(data);
    data = data || {};

    const tradeNo = data.merchantTradeNo || event.merchantTradeNo;
    if (!tradeNo) return res.status(200).send("SUCCESS");
    const q = sql();
    const rows = await q`SELECT id, status, metadata FROM transactions WHERE idempotency_key = ${tradeNo}`;
    const tx = rows[0];
    if (!tx || ["completed", "cancelled"].includes(tx.status)) return res.status(200).send("SUCCESS");

    if (event.bizStatus === "PAY_CLOSED") {
      await q`UPDATE transactions SET status = 'cancelled' WHERE id = ${tx.id} AND status = 'pending'`;
      return res.status(200).send("SUCCESS");
    }
    if (event.bizStatus !== "PAY_SUCCESS") return res.status(200).send("SUCCESS");

    const meta = tx.metadata || {};
    // Anciennes commandes (sans taux enregistré) : jamais créditées automatiquement.
    if (!meta.usdtAmount || !meta.rate) {
      await q`UPDATE transactions SET metadata = coalesce(metadata,'{}'::jsonb) || '{"needsReview":true}'::jsonb WHERE id = ${tx.id}`;
      return res.status(200).send("SUCCESS");
    }
    if (String(data.currency || "").toUpperCase() !== "USDT") return res.status(400).send("CURRENCY_MISMATCH");
    if (!Number.isFinite(Number(data.totalFee)) || Math.abs(Number(data.totalFee) - Number(meta.usdtAmount)) > 0.00000001) {
      return res.status(400).send("AMOUNT_MISMATCH");
    }

    // Crédit atomique : si la ligne n'est plus 'pending', rien n'est ajouté.
    await q`
      WITH t AS (SELECT id, wallet_id, amount FROM transactions WHERE id = ${tx.id} AND status = 'pending' FOR UPDATE),
      w AS (UPDATE wallets SET balance = balance + t.amount, updated_at = now() FROM t WHERE wallets.id = t.wallet_id RETURNING wallets.balance, t.id AS tx_id),
      u AS (UPDATE transactions SET status = 'completed', balance_after = w.balance,
              metadata = coalesce(transactions.metadata,'{}'::jsonb) || ${JSON.stringify({ binance: { orderStatus: data.status || event.bizStatus, paidAt: new Date().toISOString() } })}::jsonb
            FROM w WHERE transactions.id = w.tx_id AND transactions.status = 'pending' RETURNING transactions.id)
      SELECT w.balance FROM w`;
    return res.status(200).send("SUCCESS");
  } catch (err) {
    console.error("BINANCE_PAY_WEBHOOK", err.response?.data || err.message || err);
    return res.status(500).send("ERROR");
  }
}

module.exports = { createBinancePayOrder, binancePayWebhook };
