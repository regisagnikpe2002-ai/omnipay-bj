const crypto = require("crypto");
const { eq } = require("drizzle-orm");
const { db } = require("../db/index.js");
const { wallets, transactions } = require("../db/schema.js");
const binancePay = require("../integrations/binance/payClient.js");

function baseUrl() {
  return (process.env.PUBLIC_BASE_URL || "https://www.omnipay-bj.com").replace(/\/$/, "");
}

function merchantTradeNo() {
  return `OMP${Date.now()}${crypto.randomBytes(4).toString("hex")}`.slice(0, 32);
}

async function createBinancePayOrder(req, res) {
  try {
    if (!binancePay.configured()) {
      return res.status(503).json({ error: "Binance Pay n'est pas configuré." });
    }
    const amount = Number(req.body.amount);
    const currency = String(req.body.currency || "USDT").toUpperCase();
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Montant invalide." });
    }

    const wallet = await db.query.wallets.findFirst({
      where: eq(wallets.userId, req.user.userId),
    });
    if (!wallet) return res.status(404).json({ error: "Wallet introuvable." });

    const tradeNo = merchantTradeNo();
    const root = baseUrl();
    const result = await binancePay.createOrder({
      merchantTradeNo: tradeNo,
      amount,
      currency,
      returnUrl: `${root}/?binance=success`,
      cancelUrl: `${root}/?binance=cancelled`,
      webhookUrl: `${root}/api/binance-pay/webhook`,
    });

    if (result.status !== "SUCCESS" || !result.data?.prepayId) {
      return res.status(502).json({ error: result.errorMessage || "Création Binance Pay refusée." });
    }

    await db.insert(transactions).values({
      walletId: wallet.id,
      type: "deposit",
      amount: amount.toFixed(2),
      balanceAfter: wallet.balance,
      status: "pending",
      provider: "binance_pay",
      providerRef: String(result.data.prepayId),
      idempotencyKey: tradeNo,
      metadata: { merchantTradeNo: tradeNo, currency },
    });

    return res.status(201).json({
      omnipayId: tradeNo,
      status: "pending",
      currency: result.data.currency || currency,
      amount: result.data.totalFee || amount,
      prepayId: result.data.prepayId,
      qrcodeLink: result.data.qrcodeLink,
      qrContent: result.data.qrContent,
      checkoutUrl: result.data.checkoutUrl,
      deeplink: result.data.deeplink,
      universalUrl: result.data.universalUrl,
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
      timestamp: req.get("BinancePay-Timestamp"),
      nonce: req.get("BinancePay-Nonce"),
      signature: req.get("BinancePay-Signature"),
      certificateSN: req.get("BinancePay-Certificate-SN"),
      rawBody,
    });
    if (!valid) return res.status(401).send("INVALID_SIGNATURE");

    const event = req.body || {};
    let data = event.data;
    if (typeof data === "string") data = JSON.parse(data);
    data = data || {};

    const tradeNo = data.merchantTradeNo || event.merchantTradeNo;
    const tx = tradeNo
      ? await db.query.transactions.findFirst({ where: eq(transactions.idempotencyKey, tradeNo) })
      : null;

    if (!tx) return res.status(200).send("SUCCESS");
    if (tx.status === "completed" || tx.status === "cancelled") {
      return res.status(200).send("SUCCESS");
    }

    if (event.bizStatus === "PAY_CLOSED") {
      await db.update(transactions)
        .set({ status: "cancelled", metadata: { ...(tx.metadata || {}), binance: data } })
        .where(eq(transactions.id, tx.id));
      return res.status(200).send("SUCCESS");
    }

    if (event.bizStatus !== "PAY_SUCCESS") return res.status(200).send("SUCCESS");

    const expectedCurrency = String(tx.metadata?.currency || "").toUpperCase();
    const paidCurrency = String(data.currency || "").toUpperCase();
    const expectedAmount = Number(tx.amount);
    const paidAmount = Number(data.totalFee);
    if (expectedCurrency && paidCurrency !== expectedCurrency) {
      return res.status(400).send("CURRENCY_MISMATCH");
    }
    if (!Number.isFinite(paidAmount) || Math.abs(paidAmount - expectedAmount) > 0.00000001) {
      return res.status(400).send("AMOUNT_MISMATCH");
    }

    const wallet = await db.query.wallets.findFirst({ where: eq(wallets.id, tx.walletId) });
    if (!wallet) return res.status(500).send("WALLET_NOT_FOUND");
    const newBalance = (Number(wallet.balance) + expectedAmount).toFixed(2);

    // State claim first: only a pending row may enter processing.
    await db.update(transactions)
      .set({ status: "processing", metadata: { ...(tx.metadata || {}), binance: data } })
      .where(eq(transactions.id, tx.id));

    await db.update(wallets).set({ balance: newBalance }).where(eq(wallets.id, wallet.id));
    await db.update(transactions)
      .set({ status: "completed", balanceAfter: newBalance })
      .where(eq(transactions.id, tx.id));

    return res.status(200).send("SUCCESS");
  } catch (err) {
    console.error("BINANCE_PAY_WEBHOOK", err.response?.data || err.message || err);
    return res.status(500).send("ERROR");
  }
}

module.exports = { createBinancePayOrder, binancePayWebhook };
