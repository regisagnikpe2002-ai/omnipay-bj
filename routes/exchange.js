"use strict";
// OMNIPAY — OMNICHANGE : portefeuille crypto interne. FICHIER AJOUTÉ.
// Le client détient des soldes crypto DANS OMNIPAY (USDT, BTC, ETH, BNB, TRX, LTC) et :
//   ACHETER  : solde FCFA  -> solde crypto   (instantané, atomique)
//   VENDRE   : solde crypto -> solde FCFA    (instantané, atomique)  = dépenser : le FCFA sert ensuite à tout payer dans OMNIPAY
//   DÉPOSER  : envoi on-chain vers l'adresse OMNIPAY (OMNIPAY_PAYIN_ACCOUNTS, type "binance", "network", "asset") + hash -> l'admin contrôle puis crédite le solde crypto
//   RETIRER  : solde crypto débité, l'admin envoie on-chain et saisit le hash ; refus = remboursement du solde crypto
// Cours : Binance (public) x taux FCFA, marge OMNIPAY. Sans cours, pas d'ordre.
// Réglages : EX_BUY_MARGIN_PCT (3), EX_SELL_MARGIN_PCT (3), EX_MIN_XOF (1000), EX_MAX_XOF (1000000), EX_DAY_MAX_XOF (3000000), EX_ENABLED=off, USDT_XOF_RATE, MARKETS_BASE.
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const XOF_PER_EUR = 655.957;
const ASSETS = {
  USDT: { pair: null, dec: 2, nets: ["TRC20", "BEP20"] },
  BTC: { pair: "BTCUSDT", dec: 8, nets: ["BTC"] },
  ETH: { pair: "ETHUSDT", dec: 6, nets: ["ERC20"] },
  BNB: { pair: "BNBUSDT", dec: 5, nets: ["BEP20"] },
  TRX: { pair: "TRXUSDT", dec: 2, nets: ["TRC20"] },
  LTC: { pair: "LTCUSDT", dec: 5, nets: ["LTC"] },
  USDC: { pair: null, dec: 2, nets: ["BEP20", "ERC20", "TRC20"] },
  SOL: { pair: "SOLUSDT", dec: 5, nets: ["SOL"] },
  XRP: { pair: "XRPUSDT", dec: 2, nets: ["XRP"] },
  DOGE: { pair: "DOGEUSDT", dec: 2, nets: ["DOGE"] },
  ADA: { pair: "ADAUSDT", dec: 2, nets: ["ADA"] },
};
const ADDR = {
  TRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, BEP20: /^0x[0-9a-fA-F]{40}$/, ERC20: /^0x[0-9a-fA-F]{40}$/,
  BTC: /^(bc1[a-z0-9]{25,60}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/, LTC: /^(ltc1[a-z0-9]{25,60}|[LM3][a-km-zA-HJ-NP-Z1-9]{26,33})$/,
  SOL: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, XRP: /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/, DOGE: /^D[5-9A-HJ-NP-U][1-9A-HJ-NP-Za-km-z]{32}$/, ADA: /^addr1[a-z0-9]{50,110}$/,
};
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v >= 0 ? v : d; };
const enabled = () => String(process.env.EX_ENABLED || "on").toLowerCase() !== "off";
const buyMargin = () => Math.min(num("EX_BUY_MARGIN_PCT", 3), 30);
const sellMargin = () => Math.min(num("EX_SELL_MARGIN_PCT", 3), 30);
const minXof = () => Math.max(num("EX_MIN_XOF", 1000), 500);
const maxXof = () => num("EX_MAX_XOF", 1000000);
const dayMax = () => num("EX_DAY_MAX_XOF", 3000000);
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." }));
const floorDec = (v, d) => { const f = 10 ** d; return Math.floor(v * f + 1e-9) / f; };
const UUID = /^[0-9a-f-]{36}$/i;

let ready = false;
async function ensureTables() {
  if (ready) return;
  await sql()`CREATE TABLE IF NOT EXISTS ex_balances (user_id uuid NOT NULL, asset varchar(8) NOT NULL, qty numeric(28,10) NOT NULL DEFAULT 0 CHECK (qty >= 0), PRIMARY KEY (user_id, asset))`;
  await sql()`CREATE TABLE IF NOT EXISTS ex_orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, side varchar(8) NOT NULL, asset varchar(8) NOT NULL, network varchar(8),
    qty numeric(28,10) NOT NULL, rate_xof numeric(18,4), amount_xof numeric(18,2), address varchar(120), txid varchar(140), admin_txid varchar(140),
    reference varchar(12) NOT NULL, status varchar(10) NOT NULL, note varchar(200), created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz, done_at timestamptz)`;
  await sql()`CREATE INDEX IF NOT EXISTS ex_orders_u ON ex_orders (user_id, created_at DESC)`;
  await sql()`CREATE UNIQUE INDEX IF NOT EXISTS ex_orders_txid ON ex_orders (txid) WHERE txid IS NOT NULL`;
  await sql()`CREATE TABLE IF NOT EXISTS ex_addr (user_id uuid PRIMARY KEY, idx serial UNIQUE)`;
  await sql()`CREATE TABLE IF NOT EXISTS ex_state (k varchar(40) PRIMARY KEY, v text NOT NULL)`;
  await sql()`CREATE TABLE IF NOT EXISTS ex_flags (id serial PRIMARY KEY, user_id uuid NOT NULL, rule varchar(20) NOT NULL, level varchar(8) NOT NULL, detail varchar(200), created_at timestamptz NOT NULL DEFAULT now())`;
  await sql()`CREATE TABLE IF NOT EXISTS ex_reports (month varchar(7) PRIMARY KEY, data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`;
  ready = true;
}

let CACHE = null;
async function getJson(url) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 8000);
  try { const r = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json" } }); if (!r.ok) throw new Error("source " + r.status); return await r.json(); } finally { clearTimeout(to); }
}
async function market() {
  if (CACHE && Date.now() - CACHE.at < 15000) return CACHE.d;
  try {
    const base = (process.env.MARKETS_BASE || "https://data-api.binance.vision").replace(/\/$/, "");
    const syms = [...Object.values(ASSETS).map((a) => a.pair).filter(Boolean), "EURUSDT"];
    const arr = await getJson(`${base}/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(syms))}`);
    const px = {}; for (const x of arr) px[x.symbol] = Number(x.price);
    const env = Number(process.env.USDT_XOF_RATE);
    const fx = Number.isFinite(env) && env > 0 ? env : px.EURUSDT > 0 ? XOF_PER_EUR / px.EURUSDT : null;
    if (!fx) throw new Error("taux FCFA indisponible");
    CACHE = { at: Date.now(), d: { px, fx } }; feed(px);
  } catch (e) { console.error("EX_MARKET", e.message); if (!CACHE || Date.now() - CACHE.at > 10 * 60000) throw e; }
  return CACHE.d;
}
// Marge dynamique : plus le marché bouge vite (écart haut/bas des 10 dernières minutes), plus OMNIPAY élargit sa marge pour se protéger. Plafond EX_DYN_MAX_PCT (2).
const HIST = {};
function feed(px) { const now = Date.now(); for (const k of Object.keys(px)) { const h = (HIST[k] = HIST[k] || []); h.push([now, px[k]]); while (h.length && now - h[0][0] > 600000) h.shift(); } }
function dynPct(asset) {
  const pair = ASSETS[asset] && ASSETS[asset].pair; if (!pair || !HIST[pair] || HIST[pair].length < 3) return 0;
  const v = HIST[pair].map((x) => x[1]), hi = Math.max(...v), lo = Math.min(...v), avg = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.min(((hi - lo) / avg) * 100 * 0.5, num("EX_DYN_MAX_PCT", 2));
}
const mid = (m, asset) => { const a = ASSETS[asset]; const usd = a.pair ? m.px[a.pair] : 1; return usd > 0 ? usd * m.fx : null; };
const rates = (m, asset) => { const x = mid(m, asset); if (!x) return null; const d = dynPct(asset); return { mid: x, dyn: d, buy: x * (1 + (buyMargin() + d) / 100), sell: x * (1 - (sellMargin() + d) / 100) }; };
const r2 = (v) => Math.round(v * 100) / 100;

// Adresses de dépôt. Si EX_XPUB (clé PUBLIQUE étendue, jamais de clé privée sur le serveur) est définie, OMNIPAY génère une adresse unique par client
// pour les réseaux EVM (BEP20, ERC20) et TRON (TRC20). Sinon : adresse commune lue dans OMNIPAY_PAYIN_ACCOUNTS.
const HD_NETS = ["BEP20", "ERC20", "TRC20"];
const hdOn = () => Boolean(process.env.EX_XPUB);
let HDNODE = null;
function hdNode() {
  if (!HDNODE) { const { HDNodeWallet } = require("ethers"); HDNODE = HDNodeWallet.fromExtendedKey(process.env.EX_XPUB); if (HDNODE.privateKey) throw new Error("EX_XPUB doit être une clé publique"); }
  return HDNODE;
}
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function tronAddr(evm) {
  const raw = Buffer.concat([Buffer.from([0x41]), Buffer.from(evm.slice(2), "hex")]);
  const h = (b) => crypto.createHash("sha256").update(b).digest();
  const full = Buffer.concat([raw, h(h(raw)).subarray(0, 4)]);
  let n = BigInt("0x" + full.toString("hex")), out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of full) { if (b === 0) out = "1" + out; else break; }
  return out;
}
async function hdIndex(uid) {
  await sql()`CREATE TABLE IF NOT EXISTS ex_addr (user_id uuid PRIMARY KEY, idx serial UNIQUE)`;
  await sql()`INSERT INTO ex_addr (user_id) VALUES (${uid}::uuid) ON CONFLICT (user_id) DO NOTHING`;
  const [r] = await sql()`SELECT idx FROM ex_addr WHERE user_id = ${uid}::uuid`;
  return Number(r.idx);
}
async function depositAddress(asset, network, uid) {
  if (hdOn() && asset === "USDT" && HD_NETS.includes(network) && ASSETS[asset] && ASSETS[asset].nets.includes(network) && uid) {
    const evm = hdNode().deriveChild(await hdIndex(uid)).address;
    return network === "TRC20" ? tronAddr(evm) : evm;
  }
  let list = []; try { list = JSON.parse(process.env.OMNIPAY_PAYIN_ACCOUNTS || "[]"); } catch (_) { list = []; }
  const a = list.find((x) => x && x.type === "binance" && String(x.network || "").toUpperCase() === network && String(x.asset || "USDT").toUpperCase() === asset && ADDR[network] && ADDR[network].test(String(x.detail || "")));
  return a ? String(a.detail) : null;
}
const depositable = (asset, network) => (hdOn() && asset === "USDT" && HD_NETS.includes(network)) || Boolean((() => { let l = []; try { l = JSON.parse(process.env.OMNIPAY_PAYIN_ACCOUNTS || "[]"); } catch (_) {} return l.find((x) => x && x.type === "binance" && String(x.network || "").toUpperCase() === network && String(x.asset || "USDT").toUpperCase() === asset && ADDR[network] && ADDR[network].test(String(x.detail || ""))); })());
const pub = (o) => ({ id: o.id, side: o.side, asset: o.asset, network: o.network, qty: Number(o.qty), rate: o.rate_xof == null ? null : Number(o.rate_xof),
  amount: o.amount_xof == null ? null : Number(o.amount_xof), address: o.address, txid: o.txid, adminTxid: o.admin_txid, reference: o.reference, status: o.status, note: o.note,
  createdAt: o.created_at, expiresAt: o.expires_at });
const refCode = () => "EX" + crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
const sweep = (uid) => sql()`UPDATE ex_orders SET status = 'expired' WHERE user_id = ${uid}::uuid AND side = 'deposit' AND status = 'awaiting' AND expires_at < now()`;

async function pricing(asset, net, side, expected) {
  const A = ASSETS[asset];
  if (!A) return { err: [400, "Actif non pris en charge."] };
  if (net && !A.nets.includes(net)) return { err: [400, "Réseau non pris en charge."] };
  const m = await market().catch(() => null); const r = m && rates(m, asset);
  if (!r) return { err: [503, "Cours indisponibles. Réessayez dans un instant."] };
  const rate = side === "buy" ? r.buy : r.sell;
  const exp = Number(expected);
  if (Number.isFinite(exp) && exp > 0 && Math.abs(rate - exp) / exp > 0.01) return { err: [409, "Le cours a changé.", { rate: r2(rate) }] };
  return { A, rate };
}
const fail = (res, e) => res.status(e[0]).json({ error: e[1], ...(e[2] || {}) });

async function guard(uid, amountXof) {
  if (amountXof < minXof()) return `Montant minimum : ${minXof()} FCFA.`;
  if (amountXof > maxXof()) return `Montant maximum par opération : ${maxXof()} FCFA.`;
  const [d] = await sql()`SELECT COALESCE(sum(amount_xof),0)::float AS s FROM ex_orders WHERE user_id = ${uid}::uuid AND created_at > now() - interval '1 day' AND side IN ('buy','sell') AND status = 'done'`;
  if (d.s + amountXof > dayMax()) return "Limite journalière atteinte.";
  return null;
}


// ================= Détecteurs de risque =================
// Trois règles, enregistrées dans ex_flags et visibles par l'administrateur avec chaque ordre en attente :
//  vitesse  : 6 opérations ou plus en 10 minutes
//  transit  : retrait de 90 % ou plus de ce qui vient d'être déposé (2 h) sans aucun achat/vente : schéma de passage
//  pic      : volume du jour supérieur à 5 fois la moyenne quotidienne des 30 jours (et à 500 000 FCFA)
async function flag(uid, rule, level, detail) {
  const [x] = await sql()`SELECT count(*)::int AS n FROM ex_flags WHERE user_id = ${uid}::uuid AND rule = ${rule} AND created_at > now() - interval '6 hours'`;
  if (x.n) return;
  await sql()`INSERT INTO ex_flags (user_id, rule, level, detail) VALUES (${uid}::uuid, ${rule}, ${level}, ${String(detail).slice(0, 200)})`;
}
async function detect(uid) {
  try {
    const [v] = await sql()`SELECT count(*)::int AS n FROM ex_orders WHERE user_id = ${uid}::uuid AND side IN ('buy','sell') AND created_at > now() - interval '10 minutes'`;
    if (v.n >= 6) await flag(uid, "vitesse", "medium", v.n + " opérations en 10 minutes");
    const [d] = await sql()`SELECT COALESCE(sum(qty) FILTER (WHERE side = 'deposit' AND status = 'done'),0)::float AS dep, COALESCE(sum(qty) FILTER (WHERE side = 'withdraw'),0)::float AS wd,
        count(*) FILTER (WHERE side IN ('buy','sell'))::int AS trades FROM ex_orders WHERE user_id = ${uid}::uuid AND created_at > now() - interval '2 hours'`;
    if (d.dep > 0 && d.trades === 0 && d.wd >= 0.9 * d.dep) await flag(uid, "transit", "high", "retrait de " + d.wd + " pour " + d.dep + " déposés, sans achat ni vente");
    const [t] = await sql()`SELECT COALESCE(sum(amount_xof) FILTER (WHERE created_at > now() - interval '1 day'),0)::float AS today,
        COALESCE(sum(amount_xof) FILTER (WHERE created_at <= now() - interval '1 day'),0)::float / 30 AS avg FROM ex_orders
        WHERE user_id = ${uid}::uuid AND side IN ('buy','sell') AND status = 'done' AND created_at > now() - interval '31 days'`;
    if (t.today > 500000 && t.today > 5 * t.avg) await flag(uid, "pic", "medium", "volume du jour " + Math.round(t.today) + " FCFA contre " + Math.round(t.avg) + " en moyenne");
  } catch (e) { console.error("EX_DETECT", e.message); }
}

// ================= Détection automatique des dépôts =================
// USDT TRC20 (TronGrid) et USDT BEP20 (nœud BSC) sur les adresses générées par OMNIPAY. Idempotent : un hash n'est crédité qu'une fois.
const USDT_TRC = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", USDT_BSC = "0x55d398326f99059ff775485246999027b3197955";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MIN_AUTO = () => num("EX_AUTO_MIN_USDT", 1);
const ADDRS = new Map();
function addrsOf(idx) {
  if (!ADDRS.has(idx)) { const evm = hdNode().deriveChild(idx).address; ADDRS.set(idx, { evm, tron: tronAddr(evm) }); }
  return ADDRS.get(idx);
}
async function creditDeposit(uid, asset, net, txid, qty, addr) {
  const rows = await sql()`
    WITH u AS (UPDATE ex_orders SET status = 'done', qty = ${qty}, done_at = now() WHERE txid = ${txid} AND side = 'deposit' AND status IN ('review','awaiting') AND user_id = ${uid}::uuid RETURNING id),
    i AS (INSERT INTO ex_orders (user_id, side, asset, network, qty, address, txid, reference, status, done_at)
          SELECT ${uid}::uuid, 'deposit', ${asset}, ${net}, ${qty}, ${addr}, ${txid}, ${refCode()}, 'done', now() WHERE NOT EXISTS (SELECT 1 FROM u) AND NOT EXISTS (SELECT 1 FROM ex_orders WHERE txid = ${txid})
          ON CONFLICT DO NOTHING RETURNING id),
    c AS (INSERT INTO ex_balances (user_id, asset, qty) SELECT ${uid}::uuid, ${asset}, ${qty} WHERE EXISTS (SELECT 1 FROM u) OR EXISTS (SELECT 1 FROM i)
          ON CONFLICT (user_id, asset) DO UPDATE SET qty = ex_balances.qty + EXCLUDED.qty RETURNING qty)
    SELECT qty FROM c`;
  if (rows.length) { await detect(uid); return true; }
  return false;
}
async function watchTron(list) {
  let n = 0; const key = process.env.EX_TRONGRID_KEY, base = (process.env.EX_TRON_API || "https://api.trongrid.io").replace(/\/$/, "");
  const since = Date.now() - 7 * 864e5;
  for (const x of list) {
    try {
      const r = await fetch(`${base}/v1/accounts/${x.tron}/transactions/trc20?only_to=true&only_confirmed=true&limit=30&contract_address=${USDT_TRC}&min_timestamp=${since}`, { headers: key ? { "TRON-PRO-API-KEY": key } : {} });
      if (!r.ok) continue; const j = await r.json();
      for (const t of j.data || []) { if (t.to !== x.tron) continue; const q = Number(t.value) / 10 ** Number((t.token_info && t.token_info.decimals) || 6); if (q >= MIN_AUTO() && (await creditDeposit(x.uid, "USDT", "TRC20", t.transaction_id, q, x.tron))) n++; }
    } catch (e) { console.error("EX_TRON", e.message); }
  }
  return n;
}
async function rpc(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
async function watchBsc(list) {
  const url = process.env.EX_BSC_RPC || "https://bsc-dataseed.binance.org"; let n = 0;
  const head = parseInt(await rpc(url, "eth_blockNumber", []), 16), safe = head - num("EX_BSC_CONF", 15);
  const [st] = await sql()`SELECT v FROM ex_state WHERE k = 'bsc_cursor'`;
  let from = st ? Number(st.v) + 1 : safe - 1200; if (from > safe) return 0;
  const to = Math.min(safe, from + 1500), map = new Map(list.map((x) => [x.evm.toLowerCase(), x]));
  const all = [...map.keys()];
  for (let i = 0; i < all.length; i += 100) {
    const topics = [TRANSFER, null, all.slice(i, i + 100).map((a) => "0x" + a.slice(2).padStart(64, "0"))];
    const logs = await rpc(url, "eth_getLogs", [{ fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), address: USDT_BSC, topics }]);
    for (const l of logs) {
      const x = map.get("0x" + l.topics[2].slice(26).toLowerCase()); if (!x) continue;
      const q = Number(BigInt(l.data) / 10n ** 12n) / 1e6;
      if (q >= MIN_AUTO() && (await creditDeposit(x.uid, "USDT", "BEP20", l.transactionHash, q, x.evm))) n++;
    }
  }
  await sql()`INSERT INTO ex_state (k, v) VALUES ('bsc_cursor', ${String(to)}) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`;
  return n;
}
let WROTATE = 0;
async function watchOnce() {
  if (!hdOn()) return { tron: 0, bsc: 0 };
  await ensureTables();
  const users = (await sql()`SELECT user_id, idx FROM ex_addr ORDER BY idx`).map((u) => ({ uid: u.user_id, ...addrsOf(Number(u.idx)) }));
  const out = { tron: 0, bsc: 0 };
  if (!users.length) return out;
  const B = 25, off = (WROTATE++ * B) % users.length;           // TRON : par lots, tous les clients sont revus en rotation
  out.tron = await watchTron(users.slice(off, off + B).concat(off + B > users.length ? users.slice(0, off + B - users.length) : []));
  try { out.bsc = await watchBsc(users); } catch (e) { console.error("EX_BSC", e.message); }
  return out;
}

// ================= Bilan mensuel automatique =================
async function buildReport(month) {
  const [y, m] = month.split("-").map(Number), start = new Date(Date.UTC(y, m - 1, 1)).toISOString(), end = new Date(Date.UTC(y, m, 1)).toISOString();
  const rows = await sql()`SELECT side, asset, count(*)::int AS n, COALESCE(sum(amount_xof),0)::float AS xof, COALESCE(sum(qty),0)::float AS qty FROM ex_orders WHERE status = 'done' AND created_at >= ${start} AND created_at < ${end} GROUP BY side, asset ORDER BY side, asset`;
  const [u] = await sql()`SELECT count(DISTINCT user_id)::int AS n FROM ex_orders WHERE status = 'done' AND created_at >= ${start} AND created_at < ${end}`;
  const fl = await sql()`SELECT rule, count(*)::int AS n FROM ex_flags WHERE created_at >= ${start} AND created_at < ${end} GROUP BY rule`;
  const sum = (side) => rows.filter((r) => r.side === side).reduce((a, r) => a + r.xof, 0);
  const bm = buyMargin(), sm = sellMargin();
  const data = { month, activeUsers: u.n, byAsset: rows, buyXof: sum("buy"), sellXof: sum("sell"),
    estimatedRevenueXof: Math.round(sum("buy") * bm / (100 + bm) + sum("sell") * sm / (100 - sm)),
    note: "Revenu estimé d'après les marges actuelles (hors marge dynamique et frais réseau).", flags: fl, generatedAt: new Date().toISOString() };
  await sql()`INSERT INTO ex_reports (month, data) VALUES (${month}, ${JSON.stringify(data)}) ON CONFLICT (month) DO UPDATE SET data = EXCLUDED.data, created_at = now()`;
  return data;
}
async function monthlyCheck() {
  const d = new Date(), pm = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)), key = pm.getUTCFullYear() + "-" + String(pm.getUTCMonth() + 1).padStart(2, "0");
  const [x] = await sql()`SELECT count(*)::int AS n FROM ex_reports WHERE month = ${key}`;
  if (!x.n) await buildReport(key);
}
let LOOP = null, RUNNING = false;
async function cycle() {
  if (RUNNING) return; RUNNING = true;
  try { await ensureTables(); await market().catch(() => null); await watchOnce(); await monthlyCheck(); } catch (e) { console.error("EX_CYCLE", e.message); } finally { RUNNING = false; }
}
function startWatcher() { if (LOOP || String(process.env.EX_WATCH || "on").toLowerCase() === "off" || !process.env.DATABASE_URL) return; LOOP = setInterval(cycle, num("EX_WATCH_SEC", 60) * 1000); if (LOOP.unref) LOOP.unref(); const t0 = setTimeout(cycle, 15000); if (t0.unref) t0.unref(); }

// ---- Client ----
router.get("/info", async (req, res) => {
  try {
    const m = await market().catch(() => null);
    const assets = Object.entries(ASSETS).map(([a, v]) => { const r = m ? rates(m, a) : null;
      return { asset: a, networks: v.nets, decimals: v.dec, buy: r ? r2(r.buy) : null, sell: r ? r2(r.sell) : null, extra: r ? r2(r.dyn) : 0, depositNets: v.nets.filter((n) => depositable(a, n)) }; });
    res.json({ enabled: enabled() && Boolean(m), min: minXof(), max: maxXof(), assets });
  } catch (e) { console.error("EX_INFO", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    await ensureTables(); await sweep(req.user.userId);
    const uid = req.user.userId;
    const bal = await sql()`SELECT asset, qty FROM ex_balances WHERE user_id = ${uid}::uuid AND qty > 0`;
    const ord = await sql()`SELECT * FROM ex_orders WHERE user_id = ${uid}::uuid ORDER BY created_at DESC LIMIT 30`;
    const m = await market().catch(() => null);
    const balances = bal.map((b) => { const r = m && rates(m, b.asset); return { asset: b.asset, qty: Number(b.qty), valueXof: r ? Math.floor(Number(b.qty) * r.sell) : null }; });
    res.json({ balances, orders: ord.map(pub) });
  } catch (e) { console.error("EX_ME", e.message); res.status(500).json({ error: "Erreur." }); }
});

// ACHETER : { asset, amountXof, expectedRate } — FCFA -> crypto interne
router.post("/buy", requireAuth, async (req, res) => {
  try {
    if (!enabled()) return res.status(503).json({ error: "Service en cours d'activation." });
    await ensureTables();
    const uid = req.user.userId, b = req.body || {}, asset = String(b.asset || "").toUpperCase(), amount = Math.round(Number(b.amountXof));
    if (!Number.isFinite(amount)) return res.status(400).json({ error: "Montant invalide." });
    const p = await pricing(asset, null, "buy", b.expectedRate); if (p.err) return fail(res, p.err);
    const bad = await guard(uid, amount); if (bad) return res.status(400).json({ error: bad });
    const qty = floorDec(amount / p.rate, p.A.dec);
    if (!(qty > 0)) return res.status(400).json({ error: "Montant trop faible." });
    const key = "ex-" + crypto.randomUUID();
    const rows = await sql()`
      WITH w AS (UPDATE wallets SET balance = balance - ${amount} WHERE user_id = ${uid}::uuid AND balance >= ${amount} RETURNING id, balance),
      c AS (INSERT INTO ex_balances (user_id, asset, qty) SELECT ${uid}::uuid, ${asset}, ${qty} FROM w
            ON CONFLICT (user_id, asset) DO UPDATE SET qty = ex_balances.qty + EXCLUDED.qty RETURNING qty),
      o AS (INSERT INTO ex_orders (user_id, side, asset, qty, rate_xof, amount_xof, reference, status, done_at)
            SELECT ${uid}::uuid, 'buy', ${asset}, ${qty}, ${p.rate}, ${amount}, ${refCode()}, 'done', now() FROM w, c RETURNING *),
      t AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key)
            SELECT w.id, 'withdrawal', ${amount}, w.balance, 'completed', 'omnichange', o.id::text, ${key} FROM w, o RETURNING id)
      SELECT o.*, w.balance AS new_balance, c.qty AS crypto_balance FROM o, w, c`;
    if (!rows.length) return res.status(400).json({ error: "Solde FCFA insuffisant." });
    detect(uid); res.status(201).json({ order: pub(rows[0]), newBalance: Number(rows[0].new_balance), cryptoBalance: Number(rows[0].crypto_balance) });
  } catch (e) { console.error("EX_BUY", e.message); res.status(500).json({ error: "Opération impossible." }); }
});

// VENDRE / DÉPENSER : { asset, qty, expectedRate } — crypto interne -> FCFA
router.post("/sell", requireAuth, async (req, res) => {
  try {
    if (!enabled()) return res.status(503).json({ error: "Service en cours d'activation." });
    await ensureTables();
    const uid = req.user.userId, b = req.body || {}, asset = String(b.asset || "").toUpperCase();
    const p = await pricing(asset, null, "sell", b.expectedRate); if (p.err) return fail(res, p.err);
    const qty = floorDec(Number(b.qty), p.A.dec);
    if (!(qty > 0)) return res.status(400).json({ error: "Quantité invalide." });
    const amount = Math.floor(qty * p.rate);
    const bad = await guard(uid, amount); if (bad) return res.status(400).json({ error: bad });
    const key = "ex-" + crypto.randomUUID();
    const rows = await sql()`
      WITH c AS (UPDATE ex_balances SET qty = qty - ${qty} WHERE user_id = ${uid}::uuid AND asset = ${asset} AND qty >= ${qty} RETURNING qty),
      w AS (UPDATE wallets SET balance = balance + ${amount} WHERE user_id = ${uid}::uuid AND EXISTS (SELECT 1 FROM c) RETURNING id, balance),
      o AS (INSERT INTO ex_orders (user_id, side, asset, qty, rate_xof, amount_xof, reference, status, done_at)
            SELECT ${uid}::uuid, 'sell', ${asset}, ${qty}, ${p.rate}, ${amount}, ${refCode()}, 'done', now() FROM w, c RETURNING *),
      t AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key)
            SELECT w.id, 'deposit', ${amount}, w.balance, 'completed', 'omnichange', o.id::text, ${key} FROM w, o RETURNING id)
      SELECT o.*, w.balance AS new_balance, c.qty AS crypto_balance FROM o, w, c`;
    if (!rows.length) return res.status(400).json({ error: "Solde " + asset + " insuffisant." });
    detect(uid); res.status(201).json({ order: pub(rows[0]), newBalance: Number(rows[0].new_balance), cryptoBalance: Number(rows[0].crypto_balance) });
  } catch (e) { console.error("EX_SELL", e.message); res.status(500).json({ error: "Opération impossible." }); }
});

// DÉPOSER : { asset, network } -> adresse OMNIPAY + référence ; puis /order/:id/declare avec le hash
router.post("/deposit", requireAuth, async (req, res) => {
  try {
    if (!enabled()) return res.status(503).json({ error: "Service en cours d'activation." });
    await ensureTables(); await sweep(req.user.userId);
    const uid = req.user.userId, b = req.body || {}, asset = String(b.asset || "").toUpperCase(), net = String(b.network || "").toUpperCase();
    const A = ASSETS[asset];
    if (!A || !A.nets.includes(net)) return res.status(400).json({ error: "Actif ou réseau non pris en charge." });
    const addr = await depositAddress(asset, net, uid);
    if (!addr) return res.status(503).json({ error: "Dépôt " + asset + " (" + net + ") bientôt disponible." });
    const [n] = await sql()`SELECT count(*)::int AS n FROM ex_orders WHERE user_id = ${uid}::uuid AND side = 'deposit' AND status IN ('awaiting','review')`;
    if (n.n >= 5) return res.status(400).json({ error: "Plusieurs dépôts sont déjà en cours." });
    const [o] = await sql()`INSERT INTO ex_orders (user_id, side, asset, network, qty, address, reference, status, expires_at)
      VALUES (${uid}::uuid, 'deposit', ${asset}, ${net}, 0, ${addr}, ${refCode()}, 'awaiting', now() + interval '24 hours') RETURNING *`;
    res.status(201).json({ order: pub(o), notice: "Envoyez uniquement du " + asset + " sur le réseau " + net + " à cette adresse, puis collez le hash. Un mauvais réseau fait perdre les fonds." });
  } catch (e) { console.error("EX_DEP", e.message); res.status(500).json({ error: "Opération impossible." }); }
});

router.post("/order/:id/declare", requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const id = String(req.params.id || ""), txid = clean((req.body || {}).txid, 140), qty = Number((req.body || {}).qty);
    if (!UUID.test(id)) return res.status(400).json({ error: "Ordre invalide." });
    if (!/^(0x)?[0-9a-zA-Z]{30,140}$/.test(txid)) return res.status(400).json({ error: "Hash de transaction invalide." });
    if (!(qty > 0)) return res.status(400).json({ error: "Indiquez la quantité envoyée." });
    let r;
    try { r = await sql()`UPDATE ex_orders SET status = 'review', txid = ${txid}, qty = ${qty} WHERE id = ${id}::uuid AND user_id = ${req.user.userId}::uuid AND side = 'deposit' AND status = 'awaiting' AND expires_at > now() RETURNING *`; }
    catch (e) { if (/unique|duplicate/i.test(e.message)) return res.status(409).json({ error: "Ce hash a déjà été déclaré." }); throw e; }
    if (!r.length) return res.status(404).json({ error: "Dépôt introuvable ou expiré." });
    res.json({ order: pub(r[0]) });
  } catch (e) { console.error("EX_DECL", e.message); res.status(500).json({ error: "Erreur." }); }
});

// RETIRER : { asset, network, qty, address }
router.post("/withdraw", requireAuth, async (req, res) => {
  try {
    if (!enabled()) return res.status(503).json({ error: "Service en cours d'activation." });
    await ensureTables();
    const uid = req.user.userId, b = req.body || {}, asset = String(b.asset || "").toUpperCase(), net = String(b.network || "").toUpperCase(), A = ASSETS[asset];
    if (!A || !A.nets.includes(net)) return res.status(400).json({ error: "Actif ou réseau non pris en charge." });
    const address = clean(b.address, 120);
    if (!ADDR[net].test(address)) return res.status(400).json({ error: "Adresse invalide pour le réseau " + net + ". Vérifiez-la attentivement." });
    const qty = floorDec(Number(b.qty), A.dec);
    if (!(qty > 0)) return res.status(400).json({ error: "Quantité invalide." });
    const [n] = await sql()`SELECT count(*)::int AS n FROM ex_orders WHERE user_id = ${uid}::uuid AND side = 'withdraw' AND status = 'paid'`;
    if (n.n >= 3) return res.status(400).json({ error: "Des retraits sont déjà en cours de traitement." });
    const rows = await sql()`
      WITH c AS (UPDATE ex_balances SET qty = qty - ${qty} WHERE user_id = ${uid}::uuid AND asset = ${asset} AND qty >= ${qty} RETURNING qty)
      INSERT INTO ex_orders (user_id, side, asset, network, qty, address, reference, status)
      SELECT ${uid}::uuid, 'withdraw', ${asset}, ${net}, ${qty}, ${address}, ${refCode()}, 'paid' FROM c RETURNING *`;
    if (!rows.length) return res.status(400).json({ error: "Solde " + asset + " insuffisant." });
    await detect(uid); res.status(201).json({ order: pub(rows[0]) });
  } catch (e) { console.error("EX_WD", e.message); res.status(500).json({ error: "Opération impossible." }); }
});

// ---- Administration ----
router.get("/admin/orders", adminOnly, async (req, res) => {
  try {
    await ensureTables();
    const rows = await sql()`SELECT * FROM ex_orders WHERE status IN ('paid','review') ORDER BY created_at LIMIT 100`;
    const fl = await sql()`SELECT user_id, rule, level, detail FROM ex_flags WHERE created_at > now() - interval '24 hours'`;
    res.json({ orders: rows.map((o) => ({ ...pub(o), userId: o.user_id, flags: fl.filter((f) => f.user_id === o.user_id).map((f) => ({ rule: f.rule, level: f.level, detail: f.detail })) })) });
  } catch (e) { console.error("EX_ADM", e.message); res.status(500).json({ error: "Erreur." }); }
});
router.get("/admin/flags", adminOnly, async (req, res) => {
  try { await ensureTables(); res.json({ flags: await sql()`SELECT id, user_id, rule, level, detail, created_at FROM ex_flags ORDER BY created_at DESC LIMIT 100` }); }
  catch (e) { console.error("EX_FLAGS", e.message); res.status(500).json({ error: "Erreur." }); }
});
router.get("/admin/report", adminOnly, async (req, res) => {
  try {
    await ensureTables();
    const m = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || "")) ? String(req.query.month) : null;
    if (!m) { const l = await sql()`SELECT month, data FROM ex_reports ORDER BY month DESC LIMIT 12`; return res.json({ reports: l.map((r) => JSON.parse(r.data)) }); }
    res.json({ report: await buildReport(m) });
  } catch (e) { console.error("EX_REPORT", e.message); res.status(500).json({ error: "Erreur." }); }
});
router.post("/admin/watch", adminOnly, async (req, res) => {
  try { res.json({ ok: true, credited: await watchOnce() }); } catch (e) { console.error("EX_WATCH", e.message); res.status(500).json({ error: "Erreur." }); }
});

// Retrait envoyé on-chain : on saisit le hash.
router.post("/admin/:id/complete", adminOnly, async (req, res) => {
  try {
    await ensureTables();
    const id = String(req.params.id || ""), tx = clean((req.body || {}).txid, 140);
    if (!UUID.test(id)) return res.status(400).json({ error: "Ordre invalide." });
    if (tx.length < 20) return res.status(400).json({ error: "Saisissez le hash de l'envoi." });
    const r = await sql()`UPDATE ex_orders SET status = 'done', admin_txid = ${tx}, done_at = now() WHERE id = ${id}::uuid AND side = 'withdraw' AND status = 'paid' RETURNING id`;
    res.json({ ok: r.length > 0 });
  } catch (e) { console.error("EX_COMPLETE", e.message); res.status(500).json({ error: "Erreur." }); }
});

// Dépôt contrôlé : crédit du solde crypto (une seule fois). Option { qty } pour corriger la quantité réellement reçue.
router.post("/admin/:id/credit", adminOnly, async (req, res) => {
  try {
    await ensureTables();
    const id = String(req.params.id || ""), q = Number((req.body || {}).qty);
    if (!UUID.test(id)) return res.status(400).json({ error: "Ordre invalide." });
    const qty = Number.isFinite(q) && q > 0 ? q : null;
    const r = await sql()`
      WITH o AS (UPDATE ex_orders SET status = 'done', done_at = now(), qty = COALESCE(${qty}, qty) WHERE id = ${id}::uuid AND side = 'deposit' AND status = 'review' AND COALESCE(${qty}, qty) > 0 RETURNING user_id, asset, qty)
      INSERT INTO ex_balances (user_id, asset, qty) SELECT user_id, asset, qty FROM o
      ON CONFLICT (user_id, asset) DO UPDATE SET qty = ex_balances.qty + EXCLUDED.qty RETURNING qty`;
    res.json({ ok: r.length > 0, cryptoBalance: r.length ? Number(r[0].qty) : null });
  } catch (e) { console.error("EX_CREDIT", e.message); res.status(500).json({ error: "Erreur." }); }
});

// Refus : retrait payé -> le solde crypto est rendu ; dépôt -> clôture.
router.post("/admin/:id/reject", adminOnly, async (req, res) => {
  try {
    await ensureTables();
    const id = String(req.params.id || ""), note = clean((req.body || {}).note, 200);
    if (!UUID.test(id)) return res.status(400).json({ error: "Ordre invalide." });
    const wd = await sql()`
      WITH o AS (UPDATE ex_orders SET status = 'rejected', note = ${note || null}, done_at = now() WHERE id = ${id}::uuid AND side = 'withdraw' AND status = 'paid' RETURNING user_id, asset, qty)
      INSERT INTO ex_balances (user_id, asset, qty) SELECT user_id, asset, qty FROM o
      ON CONFLICT (user_id, asset) DO UPDATE SET qty = ex_balances.qty + EXCLUDED.qty RETURNING qty`;
    if (wd.length) return res.json({ ok: true, refunded: true });
    const dp = await sql()`UPDATE ex_orders SET status = 'rejected', note = ${note || null}, done_at = now() WHERE id = ${id}::uuid AND side = 'deposit' AND status IN ('awaiting','review') RETURNING id`;
    res.json({ ok: dp.length > 0, refunded: false });
  } catch (e) { console.error("EX_REJECT", e.message); res.status(500).json({ error: "Erreur." }); }
});

module.exports = router;
module.exports._reset = () => { CACHE = null; };
module.exports._watchOnce = watchOnce;
module.exports._buildReport = buildReport;
module.exports._detect = detect;
startWatcher();
module.exports._ADDR = ADDR;
module.exports._ASSETS = ASSETS;
