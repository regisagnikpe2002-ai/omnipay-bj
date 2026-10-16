const axios = require("axios");
const crypto = require("crypto");

const BASE_URL = process.env.BINANCE_PAY_BASE_URL || "https://bpay.binanceapi.com";
const API_KEY = (process.env.BINANCE_PAY_API_KEY || process.env.BINANCE_API_KEY || "").trim();
const SECRET_KEY = (process.env.BINANCE_PAY_SECRET_KEY || process.env.BINANCE_API_SECRET || "").trim();

function configured() {
  return Boolean(API_KEY && SECRET_KEY);
}

function nonce32() {
  return crypto.randomBytes(24).toString("base64url").slice(0, 32);
}

function signedHeaders(bodyText) {
  if (!configured()) throw new Error("Clés Binance Pay manquantes.");
  const timestamp = Date.now().toString();
  const nonce = nonce32();
  const payload = `${timestamp}\n${nonce}\n${bodyText}\n`;
  const signature = crypto
    .createHmac("sha512", SECRET_KEY)
    .update(payload, "utf8")
    .digest("hex")
    .toUpperCase();

  return {
    "Content-Type": "application/json",
    "BinancePay-Timestamp": timestamp,
    "BinancePay-Nonce": nonce,
    "BinancePay-Certificate-SN": API_KEY,
    "BinancePay-Signature": signature,
  };
}

async function signedPost(path, body = {}) {
  const bodyText = JSON.stringify(body);
  const response = await axios.post(`${BASE_URL}${path}`, bodyText, {
    headers: signedHeaders(bodyText),
    timeout: 20000,
  });
  return response.data;
}

async function createOrder({ merchantTradeNo, amount, currency = "USDT", returnUrl, cancelUrl, webhookUrl }) {
  return signedPost("/binancepay/openapi/v2/order", {
    env: { terminalType: "WEB" },
    merchantTradeNo,
    orderAmount: Number(amount),
    currency: String(currency).toUpperCase(),
    goods: {
      goodsType: "02",
      goodsCategory: "Z000",
      referenceGoodsId: merchantTradeNo,
      goodsName: "OMNIPAY Wallet Funding",
    },
    returnUrl,
    cancelUrl,
    webhookUrl,
    passThroughInfo: merchantTradeNo,
  });
}

let certificateCache = { expiresAt: 0, certificates: new Map() };
async function getCertificates() {
  if (Date.now() < certificateCache.expiresAt && certificateCache.certificates.size) {
    return certificateCache.certificates;
  }
  const result = await signedPost("/binancepay/openapi/certificates", {});
  const rows = result.data || [];
  const list = Array.isArray(rows) ? rows : (rows.certificates || []);
  const map = new Map();
  for (const cert of list) {
    const serial = String(cert.certSerial || cert.certificateSerial || "");
    const publicKey = cert.certPublic || cert.publicKey;
    if (serial && publicKey) map.set(serial, publicKey);
  }
  certificateCache = { expiresAt: Date.now() + 10 * 60 * 1000, certificates: map };
  return map;
}

async function verifyWebhook({ timestamp, nonce, signature, certificateSN, rawBody }) {
  if (!timestamp || !nonce || !signature || !certificateSN || !rawBody) return false;
  const certificates = await getCertificates();
  const publicKey = certificates.get(String(certificateSN));
  if (!publicKey) return false;
  const payload = `${timestamp}\n${nonce}\n${rawBody}\n`;
  return crypto.verify(
    "RSA-SHA256",
    Buffer.from(payload, "utf8"),
    publicKey,
    Buffer.from(signature, "base64")
  );
}

module.exports = { configured, createOrder, verifyWebhook };
