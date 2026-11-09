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
};
const ADDR = {
  TRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, BEP20: /^0x[0-9a-fA-F]{40}$/, ERC20: /^0x[0-9a-fA-F]{40}$/,
  BTC: /^(bc1[a-z0-9]{25,60}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/, LTC: /^(ltc1[a-z0-9]{25,60}|[LM3][a-km-zA-HJ-NP-Z1-9]{26,33})$/,
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
    CACHE = { at: Date.now(), d: { px, fx } };
  } catch (e) { console.error("EX_MARKET", e.message); if (!CACHE || Date.now() - CACHE.at > 10 * 60000) throw e; }
  return CACHE.d;
}
const mid = (m, asset) => { const a = ASSETS[asset]; const usd = a.pair ? m.px[a.pair] : 1; return usd > 0 ? usd * m.fx : null; };
const rates = (m, asset) => { const x = mid(m, asset); return x ? { mid: x, buy: x * (1 + buyMargin() / 100), sell: x * (1 - sellMargin() / 100) } : null; };
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
  if (hdOn() && HD_NETS.includes(network) && ASSETS[asset] && ASSETS[asset].nets.includes(network) && uid) {
    const evm = hdNode().deriveChild(await hdIndex(uid)).address;
    return network === "TRC20" ? tronAddr(evm) : evm;
  }
  let list = []; try { list = JSON.parse(process.env.OMNIPAY_PAYIN_ACCOUNTS || "[]"); } catch (_) { list = []; }
  const a = list.find((x) => x && x.type === "binance" && String(x.network || "").toUpperCase() === network && String(x.asset || "USDT").toUpperCase() === asset && ADDR[network] && ADDR[network].test(String(x.detail || "")));
  return a ? String(a.detail) : null;
}
const depositable = (asset, network) => (hdOn() && HD_NETS.includes(network)) || Boolean((() => { let l = []; try { l = JSON.parse(process.env.OMNIPAY_PAYIN_ACCOUNTS || "[]"); } catch (_) {} return l.find((x) => x && x.type === "binance" && String(x.network || "").toUpperCase() === network && String(x.asset || "USDT").toUpperCase() === asset && ADDR[network] && ADDR[network].test(String(x.detail || ""))); })());
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

// ---- Client ----
router.get("/info", async (req, res) => {
  try {
    const m = await market().catch(() => null);
    const assets = Object.entries(ASSETS).map(([a, v]) => { const r = m ? rates(m, a) : null;
      return { asset: a, networks: v.nets, decimals: v.dec, buy: r ? r2(r.buy) : null, sell: r ? r2(r.sell) : null, depositNets: v.nets.filter((n) => depositable(a, n)) }; });
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
    res.status(201).json({ order: pub(rows[0]), newBalance: Number(rows[0].new_balance), cryptoBalance: Number(rows[0].crypto_balance) });
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
    res.status(201).json({ order: pub(rows[0]), newBalance: Number(rows[0].new_balance), cryptoBalance: Number(rows[0].crypto_balance) });
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
    res.status(201).json({ order: pub(rows[0]) });
  } catch (e) { console.error("EX_WD", e.message); res.status(500).json({ error: "Opération impossible." }); }
});

// ---- Administration ----
router.get("/admin/orders", adminOnly, async (req, res) => {
  try {
    await ensureTables();
    const rows = await sql()`SELECT * FROM ex_orders WHERE status IN ('paid','review') ORDER BY created_at LIMIT 100`;
    res.json({ orders: rows.map((o) => ({ ...pub(o), userId: o.user_id })) });
  } catch (e) { console.error("EX_ADM", e.message); res.status(500).json({ error: "Erreur." }); }
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
