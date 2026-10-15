"use strict";
const express = require("express");
const crypto = require("crypto");
const { requireAuth } = require("../authMiddleware");
const binancePay = require("../integrations/binance/client");
const router = express.Router();
function tradeNo(userId) {
  const uid = String(userId || "user").replace(/[^a-zA-Z0-9]/g, "").slice(-8);
  return (`OMNI${uid}${Date.now()}${crypto.randomBytes(3).toString("hex")}`).replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
}
router.get("/binance/status", requireAuth, (req, res) => res.json({ success: true, ...binancePay.healthCheck() }));
router.post("/binance/create-order", requireAuth, async (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, error: "Montant invalide." });
    const merchantTradeNo = tradeNo(req.user?.id);
    const result = await binancePay.createOrder({ merchantTradeNo, amount, currency: "USDT", returnUrl: "https://www.omnipay-bj.com/dashboard-v2.html?binance=success", cancelUrl: "https://www.omnipay-bj.com/dashboard-v2.html?binance=cancel", passThroughInfo: { userId: req.user?.id, purpose: "wallet_funding" } });
    if (result?.status !== "SUCCESS" || result?.code !== "000000" || !result?.data) return res.status(502).json({ success: false, code: result?.code || null, error: result?.errorMessage || "Ordre Binance refuse." });
    res.status(201).json({ success: true, provider: "binance", merchantTradeNo, prepayId: result.data.prepayId, expireTime: result.data.expireTime, amount: result.data.totalFee, currency: result.data.currency, checkoutUrl: result.data.checkoutUrl, qrcodeLink: result.data.qrcodeLink, qrContent: result.data.qrContent, deeplink: result.data.deeplink, universalUrl: result.data.universalUrl, status: "INITIAL" });
  } catch (error) {
    console.error("BINANCE_CREATE_ORDER_ERROR", error.providerResponse || error.message);
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Erreur Binance Pay." });
  }
});
router.post("/binance/order-status", requireAuth, async (req, res) => {
  try {
    const { prepayId, merchantTradeNo } = req.body || {};
    const result = await binancePay.queryOrder({ prepayId, merchantTradeNo });
    if (result?.status !== "SUCCESS" || result?.code !== "000000" || !result?.data) return res.status(502).json({ success: false, code: result?.code || null, error: result?.errorMessage || "Verification Binance impossible." });
    res.json({ success: true, provider: "binance", payment: result.data });
  } catch (error) {
    console.error("BINANCE_QUERY_ORDER_ERROR", error.providerResponse || error.message);
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Erreur Binance Pay." });
  }
});
module.exports = router;
