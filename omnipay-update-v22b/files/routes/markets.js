"use strict";
// OMNIPAY — MARCHÉS (cours crypto en direct, LECTURE SEULE). Les cours viennent de l'API publique de marché de Binance (aucune clé, aucun compte) ;
// le serveur les met en cache (15 s) pour que 1 000 clients n'envoient pas 1 000 requêtes à Binance, et ne propose qu'une liste fermée de paires.
// GET /api/markets/tickers                 → prix, variation 24 h, (FCFA si USDT_XOF_RATE est défini)
// GET /api/markets/sparklines              → 24 dernières clôtures horaires de chaque crypto (mini-graphiques de la liste)
// GET /api/markets/klines?symbol=BTCUSDT&interval=1h → clôtures pour tracer le graphique détaillé
// Taux FCFA : USDT_XOF_RATE s'il est défini (ex. votre taux réel), sinon calculé = 655,957 (parité fixe EUR/XOF) ÷ EURUSDT du marché. Jamais inventé : si aucun n'est disponible, pas de FCFA.
// Tarifs indicatifs « achat / vente » : seulement si CRYPTO_SPREAD_BPS est défini (ex. 150 = 1,5 %) ; toujours étiquetés indicatifs.
// Variables (facultatives) : MARKETS_BASE (défaut https://data-api.binance.vision, miroir public des données de marché), USDT_XOF_RATE, CRYPTO_SPREAD_BPS.
const express = require("express");
const router = express.Router();

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "SOLUSDT", "TRXUSDT", "DOGEUSDT", "ADAUSDT", "LTCUSDT", "TONUSDT"];
const NAMES = { BTC: "Bitcoin", ETH: "Ethereum", BNB: "BNB", XRP: "XRP", SOL: "Solana", TRX: "TRON", DOGE: "Dogecoin", ADA: "Cardano", LTC: "Litecoin", TON: "Toncoin" };
const XOF_PER_EUR = 655.957; // parité fixe officielle FCFA/euro
const INTERVALS = { "15m": 15, "1h": 60, "4h": 240, "1d": 1440 };
const TTL_TICK = 15000, TTL_KL = 60000;
const base = () => (process.env.MARKETS_BASE || "https://data-api.binance.vision").replace(/\/$/, "");
const cache = new Map();

async function getJson(url) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json" } });
    if (!r.ok) throw new Error("source " + r.status);
    return await r.json();
  } finally { clearTimeout(to); }
}
// Cache avec repli : si la source est en panne, on renvoie la dernière valeur connue en la marquant « périmée » (jamais un prix inventé).
async function cached(key, ttl, load) {
  const hit = cache.get(key), now = Date.now();
  if (hit && now - hit.at < ttl) return { data: hit.data, at: hit.at, stale: false };
  try { const data = await load(); cache.set(key, { at: now, data }); return { data, at: now, stale: false }; }
  catch (e) { if (hit) return { data: hit.data, at: hit.at, stale: true }; throw e; }
}
const envRate = () => { const v = Number(process.env.USDT_XOF_RATE); return Number.isFinite(v) && v > 0 ? v : null; };
const spread = () => { const v = Number(process.env.CRYPTO_SPREAD_BPS); return Number.isFinite(v) && v > 0 && v <= 1000 ? v / 10000 : null; };

router.get("/tickers", async (req, res) => {
  try {
    const r = await cached("tickers", TTL_TICK, async () => {
      const want = [...SYMBOLS, "EURUSDT"];
      const arr = await getJson(`${base()}/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(want))}`);
      if (!Array.isArray(arr)) throw new Error("réponse invalide");
      const items = SYMBOLS.map((s) => arr.find((x) => x.symbol === s)).filter(Boolean).map((x) => ({
        symbol: x.symbol, asset: x.symbol.replace("USDT", ""), name: NAMES[x.symbol.replace("USDT", "")] || x.symbol,
        price: Number(x.lastPrice), changePct: Number(x.priceChangePercent), high: Number(x.highPrice), low: Number(x.lowPrice), volume: Number(x.quoteVolume) })).filter((x) => Number.isFinite(x.price));
      const eur = arr.find((x) => x.symbol === "EURUSDT"), eurusd = eur ? Number(eur.lastPrice) : NaN;
      return { items, eurusd: Number.isFinite(eurusd) && eurusd > 0 ? eurusd : null };
    });
    const env = envRate(), fx = env || (r.data.eurusd ? Math.round((XOF_PER_EUR / r.data.eurusd) * 100) / 100 : null), sp = spread();
    res.set("Cache-Control", "public, max-age=10");
    res.json({ updatedAt: new Date(r.at).toISOString(), stale: r.stale, rateXof: fx, rateSource: env ? "défini par OMNIPAY" : (fx ? "parité EUR/XOF ÷ cours EURUSDT" : null), spreadPct: sp ? sp * 100 : null,
      items: r.data.items.map((x) => { const px = fx ? x.price * fx : null; return { ...x, priceXof: px ? Math.round(px) : null, buyXof: px && sp ? Math.round(px * (1 + sp)) : null, sellXof: px && sp ? Math.round(px * (1 - sp)) : null }; }) });
  } catch (e) { console.error("MARKETS_TICK", e.message); res.status(503).json({ error: "Cours indisponibles pour le moment." }); }
});

// Mini-graphiques : 24 clôtures horaires par crypto (une seule réponse mise en cache 2 minutes, au lieu de 10 requêtes par client).
router.get("/sparklines", async (req, res) => {
  try {
    const r = await cached("spark", 120000, async () => {
      const out = {};
      const all = await Promise.allSettled(SYMBOLS.map((s) => getJson(`${base()}/api/v3/klines?symbol=${s}&interval=1h&limit=24`)));
      all.forEach((x, i) => { if (x.status === "fulfilled" && Array.isArray(x.value)) { const c = x.value.map((k) => Number(k[4])).filter(Number.isFinite); if (c.length > 1) out[SYMBOLS[i]] = c; } });
      if (!Object.keys(out).length) throw new Error("aucune série");
      return out;
    });
    res.set("Cache-Control", "public, max-age=60");
    res.json({ updatedAt: new Date(r.at).toISOString(), stale: r.stale, series: r.data });
  } catch (e) { console.error("MARKETS_SPARK", e.message); res.status(503).json({ error: "Mini-graphiques indisponibles." }); }
});

router.get("/klines", async (req, res) => {
  const symbol = String(req.query.symbol || "BTCUSDT").toUpperCase(), interval = String(req.query.interval || "1h");
  if (!SYMBOLS.includes(symbol) || !INTERVALS[interval]) return res.status(400).json({ error: "Paire ou intervalle non pris en charge." });
  try {
    const r = await cached(`kl:${symbol}:${interval}`, TTL_KL, async () => {
      const arr = await getJson(`${base()}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=48`);
      if (!Array.isArray(arr)) throw new Error("réponse invalide");
      return arr.map((k) => ({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]) })).filter((k) => Number.isFinite(k.c));
    });
    res.set("Cache-Control", "public, max-age=30");
    res.json({ symbol, interval, stale: r.stale, updatedAt: new Date(r.at).toISOString(), points: r.data });
  } catch (e) { console.error("MARKETS_KL", e.message); res.status(503).json({ error: "Graphique indisponible pour le moment." }); }
});

module.exports = router;
module.exports._reset = () => cache.clear();
