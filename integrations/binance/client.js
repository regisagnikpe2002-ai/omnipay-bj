"use strict";
const axios = require("axios");
const crypto = require("crypto");
const BASE_URL = process.env.BINANCE_PAY_BASE_URL || "https://bpay.binanceapi.com";
function getConfig() {
  const key = (process.env.BINANCE_API_KEY || "").trim();
  const secret = (process.env.BINANCE_API_SECRET || "").trim();
  return { provider: "binance", testnet: process.env.BINANCE_TESTNET === "true", configured: Boolean(key && secret), baseUrl: BASE_URL };
}
function healthCheck() { return getConfig(); }
function credentials() {
  const apiKey = (process.env.BINANCE_API_KEY || "").trim();
  const apiSecret = (process.env.BINANCE_API_SECRET || "").trim();
  if (!apiKey || !apiSecret) throw new Error("BINANCE_API_KEY ou BINANCE_API_SECRET manquante.");
  return { apiKey, apiSecret };
}
function makeHeaders(bodyText) {
  const { apiKey, apiSecret } = credentials();
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString("hex");
  const payload = `${timestamp}\n${nonce}\n${bodyText}\n`;
  const signature = crypto.createHmac("sha512", apiSecret).update(payload).digest("hex").toUpperCase();
  return { "Content-Type": "application/json", "BinancePay-Timestamp": timestamp, "BinancePay-Nonce": nonce, "BinancePay-Certificate-SN": apiKey, "BinancePay-Signature": signature };
}
async function signedPost(path, body) {
  const bodyText = JSON.stringify(body);
  try {
    const response = await axios.post(`${BASE_URL}${path}`, bodyText, { headers: makeHeaders(bodyText), timeout: 15000 });
    return response.data;
  } catch (error) {
    const upstream = error.response?.data || null;
    const safe = new Error(upstream?.errorMessage || upstream?.message || error.message || "Erreur Binance Pay.");
    safe.statusCode = error.response?.status || 502;
    safe.providerResponse = upstream;
    throw safe;
  }
}
async function createOrder({ merchantTradeNo, amount, currency = "USDT", returnUrl, cancelUrl, passThroughInfo }) {
  const orderAmount = Number(amount);
  const normalizedCurrency = String(currency).toUpperCase();
  if (!merchantTradeNo) throw new Error("merchantTradeNo manquant.");
  if (!Number.isFinite(orderAmount) || orderAmount <= 0) throw new Error("Montant invalide.");
  if (normalizedCurrency !== "USDT") throw new Error("Seule la devise USDT est autorisee.");
  const body = { env: { terminalType: "WEB" }, merchantTradeNo: String(merchantTradeNo), orderAmount, currency: normalizedCurrency, goods: { goodsType: "02", goodsCategory: "Z000", referenceGoodsId: String(merchantTradeNo), goodsName: "OMNIPAY Wallet Funding" } };
  if (returnUrl) body.returnUrl = String(returnUrl);
  if (cancelUrl) body.cancelUrl = String(cancelUrl);
  if (passThroughInfo) body.passThroughInfo = JSON.stringify(passThroughInfo);
  return signedPost("/binancepay/openapi/v2/order", body);
}
async function queryOrder({ prepayId, merchantTradeNo }) {
  if (!prepayId && !merchantTradeNo) throw new Error("prepayId ou merchantTradeNo requis.");
  const body = prepayId ? { prepayId: String(prepayId) } : { merchantTradeNo: String(merchantTradeNo) };
  return signedPost("/binancepay/openapi/v2/order/query", body);
}
module.exports = { getConfig, healthCheck, createOrder, queryOrder };
