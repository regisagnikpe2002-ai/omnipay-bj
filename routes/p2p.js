"use strict";
// OMNIPAY — Binance P2P (fichier AJOUTÉ, LECTURE SEULE). Binance ne propose aucune API pour passer ou valider un ordre P2P :
// ce module LIT l'historique P2P de TON compte Binance pour vérifier qu'un ordre existe, qu'il est terminé et pour quel montant,
// avant que tu crédites un client (dépôt déclaré avec le n° d'ordre comme preuve). Il ne crédite rien tout seul.
// Variables Render : BINANCE_P2P_API_KEY, BINANCE_P2P_API_SECRET (distinctes de celles de Binance Pay) (clé en LECTURE SEULE, sans retrait, restreinte aux IP sortantes de Render).
// Écrit d'après la documentation publique Binance (C2C, listUserOrderHistory) : à valider avec ta clé.
const crypto = require("crypto");
const axios = require("axios");
const express = require("express");

const router = express.Router();
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
router.use((req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." })));
const base = () => (process.env.BINANCE_SAPI_BASE || "https://api.binance.com").replace(/\/$/, "");

async function history(tradeType, startTs, endTs) {
  const key = (process.env.BINANCE_P2P_API_KEY || "").trim(), secret = (process.env.BINANCE_P2P_API_SECRET || "").trim();
  if (!key || !secret) throw Object.assign(new Error("Clés Binance absentes."), { code: "NOKEY" });
  const qs = new URLSearchParams({ tradeType, startTimestamp: String(startTs), endTimestamp: String(endTs), page: "1", rows: "100", recvWindow: "10000", timestamp: String(Date.now()) });
  const sig = crypto.createHmac("sha256", secret).update(qs.toString()).digest("hex");
  const r = await axios.get(`${base()}/sapi/v1/c2c/orderMatch/listUserOrderHistory?${qs.toString()}&signature=${sig}`, { headers: { "X-MBX-APIKEY": key }, timeout: 20000 });
  const list = Array.isArray(r.data?.data) ? r.data.data : [];
  return list.map((o) => ({
    orderNumber: String(o.orderNumber), tradeType: o.tradeType || tradeType, status: o.orderStatus, asset: o.asset, fiat: o.fiat || o.fiatSymbol,
    amount: Number(o.amount), totalPrice: Number(o.totalPrice), unitPrice: Number(o.unitPrice), counterparty: o.counterPartNickName || null, createTime: o.createTime,
  }));
}
async function recent(days) {
  const end = Date.now(), start = end - Math.min(Math.max(days, 1), 30) * 86400000; // Binance limite la plage à 30 jours
  const [buy, sell] = await Promise.all([history("BUY", start, end), history("SELL", start, end)]);
  return [...buy, ...sell].sort((a, b) => b.createTime - a.createTime);
}
const fail = (res, e, tag) => {
  console.error(tag, e.response?.data || e.message);
  if (e.code === "NOKEY") return res.status(503).json({ error: "Clés Binance non configurées." });
  res.status(502).json({ error: "Binance a refusé la requête (clé en lecture activée ? IP de Render autorisée ?)." });
};

router.get("/orders", async (req, res) => {
  try { res.json({ orders: await recent(parseInt(req.query.days, 10) || 7) }); } catch (e) { fail(res, e, "P2P_ORDERS"); }
});

router.get("/verify/:orderNumber", async (req, res) => {
  try {
    const n = String(req.params.orderNumber || "").trim();
    if (!/^\d{12,25}$/.test(n)) return res.status(400).json({ error: "Numéro d'ordre P2P invalide (chiffres uniquement)." });
    const o = (await recent(30)).find((x) => x.orderNumber === n);
    if (!o) return res.json({ found: false, message: "Ordre introuvable sur les 30 derniers jours de votre compte Binance." });
    res.json({ found: true, completed: String(o.status).toUpperCase() === "COMPLETED", order: o });
  } catch (e) { fail(res, e, "P2P_VERIFY"); }
});

// Solde réel du compte Binance (LECTURE SEULE) : portefeuille Spot + Funding. Même clé que ci-dessus : activer « Lecture » seulement, jamais « Retrait ».
async function signed(method, path, params) {
  const key = (process.env.BINANCE_P2P_API_KEY || "").trim(), secret = (process.env.BINANCE_P2P_API_SECRET || "").trim();
  if (!key || !secret) throw Object.assign(new Error("Clés Binance absentes."), { code: "NOKEY" });
  const qs = new URLSearchParams({ ...params, recvWindow: "10000", timestamp: String(Date.now()) });
  const sig = crypto.createHmac("sha256", secret).update(qs.toString()).digest("hex");
  const url = `${base()}${path}?${qs.toString()}&signature=${sig}`;
  const r = await axios.request({ method, url, headers: { "X-MBX-APIKEY": key }, timeout: 20000 });
  return r.data;
}
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
async function balances() {
  const out = { spot: [], funding: [], errors: [] };
  try {
    const d = await signed("GET", "/api/v3/account", { omitZeroBalances: "true" });
    out.spot = (d.balances || []).map((b) => ({ asset: b.asset, free: num(b.free), locked: num(b.locked) })).filter((b) => b.free + b.locked > 0);
  } catch (e) { if (e.code === "NOKEY") throw e; out.errors.push("Spot : " + (e.response?.data?.msg || e.message)); }
  try {
    const d = await signed("POST", "/sapi/v1/asset/get-funding-asset", {});
    out.funding = (Array.isArray(d) ? d : []).map((b) => ({ asset: b.asset, free: num(b.free), locked: num(b.locked) + num(b.freeze) })).filter((b) => b.free + b.locked > 0);
  } catch (e) { out.errors.push("Funding : " + (e.response?.data?.msg || e.message)); }
  const sum = (arr, a) => arr.filter((b) => b.asset === a).reduce((t, b) => t + b.free + b.locked, 0);
  out.usdt = { spot: sum(out.spot, "USDT"), funding: sum(out.funding, "USDT") };
  out.usdt.total = out.usdt.spot + out.usdt.funding;
  out.at = new Date().toISOString();
  return out;
}
router.get("/balance", async (req, res) => {
  try {
    const b = await balances();
    if (b.errors.length === 2) return res.status(502).json({ error: "Binance a refusé la lecture du solde (clé en lecture activée ? IP de Render autorisée ?).", details: b.errors });
    res.json(b);
  } catch (e) { fail(res, e, "BINANCE_BALANCE"); }
});

module.exports = router;
module.exports._balances = balances;
