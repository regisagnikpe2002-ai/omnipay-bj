"use strict";
// OMNIPAY — OMNIWALLET : LES 10 ADRESSES CRYPTO DU CLIENT, générées et surveillées par OMNIPAY (clé publique EX_XPUB, aucune clé privée sur le serveur).
// Débloquées quand le client a déposé au moins CW_UNLOCK_XOF FCFA au total (défaut 10 000). Chaque adresse est unique au client ; le dépôt est crédité automatiquement
// dans le portefeuille crypto OMNIWALLET du client (même mécanisme que le dépôt USDT), puis vendable en FCFA ou retirable (OMNICHANGE).
// Une adresse n'est montrée au client QUE si OMNIPAY en surveille bien les dépôts (sinon « bientôt »).
// GET  /api/cryptowallets            → { unlocked, deposited, unlockAt, wallets:[{slot,asset,network,label,status,address?}] }
// POST /api/cryptowallets/generate   → crée (une fois) les adresses actives du client
// GET  /api/cryptowallets/admin/status · POST /api/cryptowallets/admin/watch   (x-admin-key)
// Variables : EX_XPUB (obligatoire) · CW_UNLOCK_XOF · CW_WATCH=off · CW_WATCH_BTC=on (+ CW_BTC_API, défaut https://mempool.space/api) · CW_LTC_API (ex. https://litecoinspace.org/api)
//             CW_USDC_TRC / CW_USDC_BSC (contrats, à vérifier sur tronscan / bscscan) · EX_TRONGRID_KEY · EX_BSC_RPC · CW_MIN_USDC, CW_MIN_TRX, CW_MIN_BTC, CW_MIN_LTC
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");
const addr = require("../lib/cryptoAddr.js");
const sql = () => neon(process.env.DATABASE_URL);
const router = express.Router();
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v >= 0 ? v : d; };
const on = (k, d) => ["on", "true", "1", "yes"].includes(String(process.env[k] == null ? d : process.env[k]).toLowerCase());
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." }));
const hdOn = () => Boolean(process.env.EX_XPUB);
const UNLOCK = () => num("CW_UNLOCK_XOF", 10000);
const USDC_TRC = () => process.env.CW_USDC_TRC || "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8";
const USDC_BSC = () => (process.env.CW_USDC_BSC || "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d").toLowerCase();
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SLOT_BASE = 1000000;

// watch : clé du suiveur qui crédite ce portefeuille ; legacy : adresses USDT déjà gérées par OMNICHANGE (même indice que le dépôt USDT existant).
const WALLETS = [
  { slot: 1, asset: "USDT", net: "TRC20", label: "USDT · TRON", kind: "tron", legacy: true, watch: "exchange" },
  { slot: 2, asset: "USDT", net: "BEP20", label: "USDT · BNB Chain", kind: "evm", legacy: true, watch: "exchange" },
  { slot: 3, asset: "USDC", net: "TRC20", label: "USDC · TRON", kind: "tron", watch: "tron" },
  { slot: 4, asset: "USDC", net: "BEP20", label: "USDC · BNB Chain", kind: "evm", watch: "bsc" },
  { slot: 5, asset: "TRX", net: "TRC20", label: "TRX · TRON", kind: "tron", watch: "tron" },
  { slot: 6, asset: "BNB", net: "BEP20", label: "BNB · BNB Chain", kind: "evm", watch: null },
  { slot: 7, asset: "ETH", net: "ERC20", label: "ETH · Ethereum", kind: "evm", watch: null },
  { slot: 8, asset: "BTC", net: "BTC", label: "Bitcoin", kind: "btc", watch: "btc" },
  { slot: 9, asset: "LTC", net: "LTC", label: "Litecoin", kind: "ltc", watch: "ltc" },
  { slot: 10, asset: "DOGE", net: "DOGE", label: "Dogecoin", kind: "doge", watch: null },
];
const live = (w) => hdOn() && (w.watch === "exchange" || (w.watch === "tron" && on("CW_WATCH_TRON", "on")) || (w.watch === "bsc" && on("CW_WATCH_BSC", "on")) || (w.watch === "btc" && on("CW_WATCH_BTC", "off")) || (w.watch === "ltc" && Boolean(process.env.CW_LTC_API)));
const MIN = (a) => ({ USDC: num("CW_MIN_USDC", 1), TRX: num("CW_MIN_TRX", 20), BTC: num("CW_MIN_BTC", 0.00005), LTC: num("CW_MIN_LTC", 0.002) }[a] || 0);

let ready = false;
async function ensure() {
  if (ready) return;
  await sql()`CREATE TABLE IF NOT EXISTS cw_wallets (user_id uuid NOT NULL, slot int NOT NULL, asset varchar(10) NOT NULL, network varchar(10) NOT NULL, address varchar(120) NOT NULL, idx int NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, slot))`;
  await sql()`CREATE INDEX IF NOT EXISTS cw_wallets_addr ON cw_wallets (address)`;
  await sql()`CREATE TABLE IF NOT EXISTS ex_addr (user_id uuid PRIMARY KEY, idx serial UNIQUE)`;
  await sql()`CREATE TABLE IF NOT EXISTS ex_state (k varchar(40) PRIMARY KEY, v text NOT NULL)`;
  ready = true;
}
async function userIdx(uid) {
  await sql()`INSERT INTO ex_addr (user_id) VALUES (${uid}::uuid) ON CONFLICT (user_id) DO NOTHING`;
  const [r] = await sql()`SELECT idx FROM ex_addr WHERE user_id = ${uid}::uuid`; return Number(r.idx);
}
const deposited = async (uid) => (await sql()`SELECT coalesce(sum(t.amount),0)::float AS v FROM transactions t JOIN wallets w ON w.id = t.wallet_id WHERE w.user_id = ${uid}::uuid AND t.type = 'deposit' AND t.status = 'completed' AND t.provider <> 'omnichange'`)[0].v;
const deriveIdx = (w, uidx) => (w.legacy ? uidx : SLOT_BASE + uidx * 16 + w.slot);

router.get("/", requireAuth, async (req, res) => {
  try {
    await ensure(); const uid = req.user.userId, dep = await deposited(uid), unlocked = dep >= UNLOCK();
    const have = new Map((await sql()`SELECT slot, address FROM cw_wallets WHERE user_id = ${uid}::uuid`).map((r) => [Number(r.slot), r.address]));
    res.json({ unlocked, deposited: Math.round(dep), unlockAt: UNLOCK(), remaining: Math.max(0, Math.ceil(UNLOCK() - dep)), enabled: hdOn(),
      wallets: WALLETS.map((w) => {
        const isLive = live(w), status = !isLive ? "soon" : !unlocked ? "locked" : have.has(w.slot) ? "active" : "ready";
        return { slot: w.slot, asset: w.asset, network: w.net, label: w.label, status, address: status === "active" ? have.get(w.slot) : undefined };
      }),
      notice: "Envoyez uniquement l'actif et le réseau indiqués. Un mauvais réseau peut faire perdre les fonds. Le dépôt est crédité automatiquement dans votre OMNIWALLET après confirmation." });
  } catch (e) { console.error("CW_GET", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.post("/generate", requireAuth, async (req, res) => {
  try {
    if (!hdOn()) return res.status(503).json({ error: "Adresses crypto en cours d'activation." });
    await ensure(); const uid = req.user.userId, dep = await deposited(uid);
    if (dep < UNLOCK()) return res.status(403).json({ error: `Déposez encore ${Math.ceil(UNLOCK() - dep)} FCFA pour débloquer vos adresses crypto.`, remaining: Math.ceil(UNLOCK() - dep) });
    const uidx = await userIdx(uid); let made = 0;
    for (const w of WALLETS.filter(live)) {
      const idx = deriveIdx(w, uidx), a = addr.address(process.env.EX_XPUB, idx, w.kind);
      const r = await sql()`INSERT INTO cw_wallets (user_id, slot, asset, network, address, idx) VALUES (${uid}::uuid, ${w.slot}, ${w.asset}, ${w.net}, ${a}, ${idx}) ON CONFLICT (user_id, slot) DO NOTHING RETURNING slot`;
      made += r.length;
    }
    res.json({ ok: true, created: made });
  } catch (e) { console.error("CW_GEN", e.message); res.status(500).json({ error: "Erreur." }); }
});

// ---------------- suivi des dépôts (crédit automatique, idempotent par hash de transaction) ----------------
const ex = () => require("./exchange");
async function fetchJson(url, opt) { const r = await fetch(url, opt); if (!r.ok) throw new Error("HTTP " + r.status + " " + url.split("/")[2]); return r.json(); }
async function rpc(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
const rowsFor = (asset) => sql()`SELECT user_id AS uid, address, asset, network FROM cw_wallets WHERE asset = ${asset} ORDER BY created_at`;
const batch = (list, key) => { if (!list.length) return []; const B = 25, off = ((watchBatch[key] = (watchBatch[key] || 0) + 1) * B) % list.length; return list.slice(off, off + B).concat(off + B > list.length ? list.slice(0, off + B - list.length) : []); };
const watchBatch = {};

async function watchTron() {
  let n = 0; const key = process.env.EX_TRONGRID_KEY, base = (process.env.EX_TRON_API || "https://api.trongrid.io").replace(/\/$/, ""), hdr = key ? { "TRON-PRO-API-KEY": key } : {}, since = Date.now() - 7 * 864e5;
  for (const x of batch(await rowsFor("USDC"), "tronusdc")) {
    try {
      const j = await fetchJson(`${base}/v1/accounts/${x.address}/transactions/trc20?only_to=true&only_confirmed=true&limit=30&contract_address=${USDC_TRC()}&min_timestamp=${since}`, { headers: hdr });
      for (const t of j.data || []) { if (t.to !== x.address) continue; const q = Number(t.value) / 10 ** Number((t.token_info && t.token_info.decimals) || 6); if (q >= MIN("USDC") && (await ex()._creditDeposit(x.uid, "USDC", "TRC20", t.transaction_id, q, x.address))) n++; }
    } catch (e) { console.error("CW_TRON_USDC", e.message); }
  }
  for (const x of batch(await rowsFor("TRX"), "tronnative")) {
    try {
      const hex = addr.tronToHex(x.address), j = await fetchJson(`${base}/v1/accounts/${x.address}/transactions?only_to=true&only_confirmed=true&limit=30&min_timestamp=${since}`, { headers: hdr });
      for (const t of j.data || []) {
        const c = t.raw_data && t.raw_data.contract && t.raw_data.contract[0]; if (!c || c.type !== "TransferContract" || !(t.ret && t.ret[0] && t.ret[0].contractRet === "SUCCESS")) continue;
        const v = c.parameter && c.parameter.value; if (!v || String(v.to_address).toLowerCase() !== hex) continue;
        const q = Number(v.amount) / 1e6; if (q >= MIN("TRX") && (await ex()._creditDeposit(x.uid, "TRX", "TRC20", t.txID, q, x.address))) n++;
      }
    } catch (e) { console.error("CW_TRON_TRX", e.message); }
  }
  return n;
}
async function watchBsc() {
  const list = await rowsFor("USDC"), bsc = list.filter((x) => x.network === "BEP20"); if (!bsc.length) return 0;
  const url = process.env.EX_BSC_RPC || "https://bsc-dataseed.binance.org"; let n = 0;
  const head = parseInt(await rpc(url, "eth_blockNumber", []), 16), safe = head - num("EX_BSC_CONF", 15);
  const [st] = await sql()`SELECT v FROM ex_state WHERE k = 'cw_bsc_cursor'`; let from = st ? Number(st.v) + 1 : safe - 1200; if (from > safe) return 0;
  const to = Math.min(safe, from + 1500), map = new Map(bsc.map((x) => [x.address.toLowerCase(), x])), all = [...map.keys()];
  for (let i = 0; i < all.length; i += 100) {
    const topics = [TRANSFER, null, all.slice(i, i + 100).map((a) => "0x" + a.slice(2).padStart(64, "0"))];
    const logs = await rpc(url, "eth_getLogs", [{ fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), address: USDC_BSC(), topics }]);
    for (const l of logs) { const x = map.get("0x" + l.topics[2].slice(26).toLowerCase()); if (!x) continue; const q = Number(BigInt(l.data) / 10n ** 12n) / 1e6; if (q >= MIN("USDC") && (await ex()._creditDeposit(x.uid, "USDC", "BEP20", l.transactionHash, q, x.address))) n++; }
  }
  await sql()`INSERT INTO ex_state (k, v) VALUES ('cw_bsc_cursor', ${String(to)}) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`;
  return n;
}
// Bitcoin / Litecoin via une API « esplora » (mempool.space, litecoinspace.org…) : crédité après CW_UTXO_CONF confirmations (défaut 2).
async function watchUtxo(asset, apiBase) {
  const base = apiBase.replace(/\/$/, ""), conf = num("CW_UTXO_CONF", 2); let n = 0;
  const list = batch(await rowsFor(asset), "utxo" + asset); if (!list.length) return 0;
  const tip = Number(await (await fetch(base + "/blocks/tip/height")).text());
  for (const x of list) {
    try {
      const txs = await fetchJson(`${base}/address/${x.address}/txs`);
      for (const t of txs || []) {
        if (!t.status || !t.status.confirmed || !(tip - Number(t.status.block_height) + 1 >= conf)) continue;
        const sats = (t.vout || []).filter((o) => o.scriptpubkey_address === x.address).reduce((a, o) => a + Number(o.value || 0), 0), q = sats / 1e8;
        if (q >= MIN(asset) && (await ex()._creditDeposit(x.uid, asset, asset, t.txid, q, x.address))) n++;
      }
    } catch (e) { console.error("CW_" + asset, e.message); }
  }
  return n;
}
async function watchOnce() {
  const out = { tron: 0, bsc: 0, btc: 0, ltc: 0 }; if (!hdOn()) return out;
  await ensure(); await ex()._ensureTables();
  if (on("CW_WATCH_TRON", "on")) try { out.tron = await watchTron(); } catch (e) { console.error("CW_TRON", e.message); }
  if (on("CW_WATCH_BSC", "on")) try { out.bsc = await watchBsc(); } catch (e) { console.error("CW_BSC", e.message); }
  if (on("CW_WATCH_BTC", "off")) try { out.btc = await watchUtxo("BTC", process.env.CW_BTC_API || "https://mempool.space/api"); } catch (e) { console.error("CW_BTC", e.message); }
  if (process.env.CW_LTC_API) try { out.ltc = await watchUtxo("LTC", process.env.CW_LTC_API); } catch (e) { console.error("CW_LTC", e.message); }
  return out;
}
router.get("/admin/status", adminOnly, async (req, res) => {
  try { await ensure(); const [c] = await sql()`SELECT count(*)::int AS wallets, count(DISTINCT user_id)::int AS clients FROM cw_wallets`;
    res.json({ hd: hdOn(), unlockXof: UNLOCK(), watch: Object.fromEntries(WALLETS.map((w) => [w.label, live(w) ? "actif" : "bientôt"])), ...c });
  } catch (e) { console.error("CW_ADM", e.message); res.status(500).json({ error: "Erreur." }); }
});
router.post("/admin/watch", adminOnly, async (req, res) => { try { res.json({ ok: true, credited: await watchOnce() }); } catch (e) { console.error("CW_WATCH", e.message); res.status(500).json({ error: "Erreur." }); } });

let LOOP = null, RUN = false;
if (!LOOP && process.env.DATABASE_URL && hdOn() && on("CW_WATCH", "on")) {
  LOOP = setInterval(async () => { if (RUN) return; RUN = true; try { await watchOnce(); } catch (e) { console.error("CW_CYCLE", e.message); } finally { RUN = false; } }, num("CW_WATCH_MS", 90000));
  if (LOOP.unref) LOOP.unref();
}
module.exports = router; module.exports._watchOnce = watchOnce; module.exports._WALLETS = WALLETS;
