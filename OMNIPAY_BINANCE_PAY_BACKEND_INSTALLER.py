#!/usr/bin/env python3
from pathlib import Path
from datetime import datetime
import shutil

root = Path.cwd()
if not (root / 'server.js').exists():
    raise SystemExit('ERREUR: lance ce fichier depuis la racine omnipay-bj')

stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
for rel in ['server.js', 'integrations/binance/payClient.js', 'routes/binancePay.js', 'controllers/binancePayController.js']:
    p = root / rel
    if p.exists():
        shutil.copy2(p, p.with_name(p.name + f'.{stamp}.bak'))

(root / 'integrations/binance').mkdir(parents=True, exist_ok=True)
(root / 'controllers').mkdir(parents=True, exist_ok=True)
(root / 'routes').mkdir(parents=True, exist_ok=True)

(root / 'integrations/binance/payClient.js').write_text(r'''const axios = require("axios");
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
''', encoding='utf-8')

(root / 'controllers/binancePayController.js').write_text(r'''const crypto = require("crypto");
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
''', encoding='utf-8')

(root / 'routes/binancePay.js').write_text(r'''const express = require("express");
const router = express.Router();
const { requireAuth } = require("../authMiddleware.js");
const {
  createBinancePayOrder,
  binancePayWebhook,
} = require("../controllers/binancePayController.js");

router.post("/order", requireAuth, createBinancePayOrder);
router.post("/webhook", binancePayWebhook);
module.exports = router;
''', encoding='utf-8')

server = (root / 'server.js').read_text(encoding='utf-8')
if 'req.rawBody = buf.toString("utf8")' not in server:
    old = 'app.use(express.json());'
    new = '''app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString("utf8");
  },
}));'''
    if old in server:
        server = server.replace(old, new, 1)
    else:
        raise SystemExit('ERREUR: app.use(express.json()) introuvable dans server.js')

require_line = 'const binancePayRoutes = require("./routes/binancePay.js");'
if require_line not in server:
    anchor = 'const express = require("express");'
    if anchor in server:
        server = server.replace(anchor, anchor + '\n' + require_line, 1)
    else:
        server = require_line + '\n' + server

mount_line = 'app.use("/api/binance-pay", binancePayRoutes);'
if mount_line not in server:
    candidates = ['app.use("/wallet",', 'app.get("/', 'app.listen(']
    inserted = False
    for marker in candidates:
        pos = server.find(marker)
        if pos != -1:
            line_start = server.rfind('\n', 0, pos) + 1
            server = server[:line_start] + mount_line + '\n' + server[line_start:]
            inserted = True
            break
    if not inserted:
        server += '\n' + mount_line + '\n'

(root / 'server.js').write_text(server, encoding='utf-8')

print('OMNIPAY_BINANCE_PAY_BACKEND_INSTALLE')
print('FICHIERS=integrations/binance/payClient.js,controllers/binancePayController.js,routes/binancePay.js,server.js')
print('TEST=node --check integrations/binance/payClient.js && node --check controllers/binancePayController.js && node --check routes/binancePay.js && node --check server.js')
