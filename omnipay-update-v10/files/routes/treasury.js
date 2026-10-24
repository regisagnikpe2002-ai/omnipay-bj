"use strict";
// OMNIPAY — TRÉSORERIE (fichier AJOUTÉ, admin uniquement, LECTURE + déclaration de soldes). Deux comptes réels seulement :
//   1) PI-SPI Ecobank (alias de paiement)         → entrées/sorties suivies ici, solde déclaré par vous (pas d'API Ecobank pour l'instant)
//   2) MetaMask (adresse EVM publique)            → soldes LUS sur la blockchain (BNB Chain, Polygon, Base, Ethereum) : USDT/USDC + monnaie native
// Tout le reste (MoMo, PayPal, CoinGate, Binance…) est classé « hors trésorerie » pour que rien n'échappe.
// Aucune clé privée n'est jamais demandée : seule l'adresse publique est utilisée (lecture seule, JSON-RPC publics, modifiables par variables).
// Variables Render (toutes facultatives) : TREASURY_PISPI_ALIAS, TREASURY_METAMASK_ADDRESS (à défaut : 1re adresse 0x… de OMNIPAY_PAYIN_ACCOUNTS),
//   USDT_XOF_RATE (valeur d'un USDT/USDC en FCFA), TREASURY_AUTO_DECLARE=on (déclare automatiquement le solde MetaMask toutes les 10 min),
//   TREASURY_RPC_BSC / _POLYGON / _BASE / _ETH (points d'accès JSON-RPC).
const express = require("express");
const { neon } = require("@neondatabase/serverless");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
router.use((req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." })));
const on = (n) => ["on", "true", "1", "yes"].includes(String(process.env[n] || "off").toLowerCase());

const PISPI_CODE = "PISPI_ECOBANK", META_CODE = "METAMASK";
const pispiAlias = () => (process.env.TREASURY_PISPI_ALIAS || "853c809e-f225-46d4-8eb3-3bd0001adb76").trim();
const EVM = /^0x[0-9a-fA-F]{40}$/;
function metaAddress() {
  const e = (process.env.TREASURY_METAMASK_ADDRESS || "").trim();
  if (EVM.test(e)) return e;
  try { const a = JSON.parse(process.env.OMNIPAY_PAYIN_ACCOUNTS || "[]").find((x) => EVM.test(String(x.detail || "").trim())); return a ? String(a.detail).trim() : ""; } catch (_) { return ""; }
}
const rate = () => { const v = Number(process.env.USDT_XOF_RATE); return Number.isFinite(v) && v > 0 ? v : null; };

// Réseaux et jetons lus (adresses de contrats officielles, affichées dans la réponse pour que vous puissiez les vérifier sur l'explorateur).
const CHAINS = [
  { key: "bsc", name: "BNB Chain", env: "TREASURY_RPC_BSC", rpc: "https://bsc-dataseed.binance.org", native: "BNB", tokens: [
    { sym: "USDT", addr: "0x55d398326f99059fF775485246999027B3197955", dec: 18 }, { sym: "USDC", addr: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", dec: 18 } ] },
  { key: "polygon", name: "Polygon", env: "TREASURY_RPC_POLYGON", rpc: "https://polygon-bor-rpc.publicnode.com", native: "POL", tokens: [
    { sym: "USDT", addr: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", dec: 6 }, { sym: "USDC", addr: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", dec: 6 } ] },
  { key: "base", name: "Base", env: "TREASURY_RPC_BASE", rpc: "https://mainnet.base.org", native: "ETH", tokens: [
    { sym: "USDC", addr: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", dec: 6 } ] },
  { key: "eth", name: "Ethereum", env: "TREASURY_RPC_ETH", rpc: "https://ethereum-rpc.publicnode.com", native: "ETH", tokens: [
    { sym: "USDT", addr: "0xdAC17F958D2ee523a2206206994597C13D831ec7", dec: 6 }, { sym: "USDC", addr: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", dec: 6 } ] },
];

async function rpc(url, method, params) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctl.signal });
    const j = await r.json();
    if (j.error) throw new Error(String(j.error.message || "erreur RPC").slice(0, 80));
    if (typeof j.result !== "string") throw new Error("réponse RPC invalide");
    return j.result;
  } finally { clearTimeout(to); }
}
const fromHex = (hex, dec) => { const v = BigInt(hex === "0x" ? "0x0" : hex); const d = 10n ** BigInt(dec); return Number(v / d) + Number(v % d) / Number(d); };

let cache = { at: 0, data: null };
async function readChain(c, addr) {
  const url = (process.env[c.env] || c.rpc).trim();
  const out = { chain: c.name, key: c.key, native: { sym: c.native, amount: null }, tokens: [], ok: true };
  try {
    out.native.amount = fromHex(await rpc(url, "eth_getBalance", [addr, "latest"]), 18);
    for (const t of c.tokens) {
      const data = "0x70a08231" + addr.slice(2).toLowerCase().padStart(64, "0");
      const amount = fromHex(await rpc(url, "eth_call", [{ to: t.addr, data }, "latest"]), t.dec);
      out.tokens.push({ sym: t.sym, amount, contract: t.addr });
    }
  } catch (e) { out.ok = false; out.error = String(e.message || e).slice(0, 80); }
  return out;
}
async function onchain(force) {
  const addr = metaAddress();
  if (!addr) return { address: "", chains: [], stableTotal: null, complete: false };
  if (!force && cache.data && cache.addr === addr && Date.now() - cache.at < 60000) return cache.data;
  const chains = await Promise.all(CHAINS.map((c) => readChain(c, addr)));
  const stable = chains.reduce((s, c) => s + c.tokens.reduce((a, t) => a + t.amount, 0), 0);
  const data = { address: addr, chains, stableTotal: stable, complete: chains.every((c) => c.ok) };
  cache = { at: Date.now(), addr, data };
  return data;
}

let ready = null;
function ensure() {
  if (!ready) ready = (async () => {
    const q = sql();
    await q`CREATE TABLE IF NOT EXISTS fund_accounts (
      code varchar(40) PRIMARY KEY, kind varchar(10) NOT NULL, label varchar(120) NOT NULL, currency varchar(10) NOT NULL DEFAULT 'XOF',
      network varchar(40), address varchar(200), custody varchar(200), hot_max_xof numeric(18,2), active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now())`;
    await q`CREATE TABLE IF NOT EXISTS fund_balances (
      id bigserial PRIMARY KEY, code varchar(40) NOT NULL, balance_xof numeric(18,2) NOT NULL, note varchar(200), declared_at timestamptz NOT NULL DEFAULT now())`;
    await q`INSERT INTO fund_accounts (code, kind, label, currency, network, address, custody) VALUES (${PISPI_CODE}, 'bank', 'PI-SPI Ecobank (alias)', 'XOF', 'PI-SPI', ${pispiAlias()}, 'Ecobank Bénin')
            ON CONFLICT (code) DO UPDATE SET address = EXCLUDED.address`;
    await q`INSERT INTO fund_accounts (code, kind, label, currency, network, address, custody) VALUES (${META_CODE}, 'hot', 'MetaMask (USDT/USDC)', 'XOF', 'EVM', ${metaAddress() || null}, 'MetaMask (auto-garde)')
            ON CONFLICT (code) DO UPDATE SET address = coalesce(EXCLUDED.address, fund_accounts.address)`;
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

// Entrées / sorties par compte de trésorerie, depuis les transactions TERMINÉES (30 jours).
async function flows() {
  const q = sql();
  const base = (withJoin) => withJoin ? q`
    SELECT CASE
        WHEN t.provider = 'pispi' THEN 'PISPI'
        WHEN t.provider = 'manual' THEN CASE lower(coalesce(md.method, mp.method, '')) WHEN 'pispi' THEN 'PISPI' WHEN 'virement' THEN 'PISPI' WHEN 'usdt' THEN 'METAMASK' ELSE 'AUTRE' END
        WHEN t.provider = 'omnicash' THEN 'OMNICASH' ELSE 'AUTRE' END AS fund,
      sum(CASE WHEN t.type = 'deposit' AND t.created_at > now() - interval '24 hours' THEN t.amount ELSE 0 END)::float AS in24,
      sum(CASE WHEN t.type = 'withdrawal' AND t.created_at > now() - interval '24 hours' THEN t.amount ELSE 0 END)::float AS out24,
      sum(CASE WHEN t.type = 'deposit' AND t.created_at > now() - interval '7 days' THEN t.amount ELSE 0 END)::float AS in7,
      sum(CASE WHEN t.type = 'withdrawal' AND t.created_at > now() - interval '7 days' THEN t.amount ELSE 0 END)::float AS out7,
      sum(CASE WHEN t.type = 'deposit' THEN t.amount ELSE 0 END)::float AS in30,
      sum(CASE WHEN t.type = 'withdrawal' THEN t.amount ELSE 0 END)::float AS out30
    FROM transactions t
    LEFT JOIN manual_deposits md ON t.provider = 'manual' AND t.type = 'deposit' AND md.id::text = t.provider_ref
    LEFT JOIN manual_payouts mp ON t.provider = 'manual' AND t.type = 'withdrawal' AND mp.id::text = t.provider_ref
    WHERE t.status = 'completed' AND t.type IN ('deposit', 'withdrawal') AND t.created_at > now() - interval '30 days' GROUP BY 1`
  : q`
    SELECT CASE WHEN t.provider = 'pispi' THEN 'PISPI' WHEN t.provider = 'omnicash' THEN 'OMNICASH' ELSE 'AUTRE' END AS fund,
      sum(CASE WHEN t.type = 'deposit' AND t.created_at > now() - interval '24 hours' THEN t.amount ELSE 0 END)::float AS in24,
      sum(CASE WHEN t.type = 'withdrawal' AND t.created_at > now() - interval '24 hours' THEN t.amount ELSE 0 END)::float AS out24,
      sum(CASE WHEN t.type = 'deposit' AND t.created_at > now() - interval '7 days' THEN t.amount ELSE 0 END)::float AS in7,
      sum(CASE WHEN t.type = 'withdrawal' AND t.created_at > now() - interval '7 days' THEN t.amount ELSE 0 END)::float AS out7,
      sum(CASE WHEN t.type = 'deposit' THEN t.amount ELSE 0 END)::float AS in30,
      sum(CASE WHEN t.type = 'withdrawal' THEN t.amount ELSE 0 END)::float AS out30
    FROM transactions t WHERE t.status = 'completed' AND t.type IN ('deposit', 'withdrawal') AND t.created_at > now() - interval '30 days' GROUP BY 1`;
  let rows;
  try { rows = await base(true); } catch (_) { rows = await base(false); } // tables de dépôts directs absentes : classement par fournisseur seulement
  const zero = { in24: 0, out24: 0, in7: 0, out7: 0, in30: 0, out30: 0 };
  const res = { PISPI: { ...zero }, METAMASK: { ...zero }, OMNICASH: { ...zero }, AUTRE: { ...zero } };
  for (const r of rows) res[r.fund] = r;
  return res;
}

async function overview(force) {
  await ensure();
  const q = sql();
  const [fl, oc, funds, liab] = await Promise.all([
    flows(), onchain(force),
    q`SELECT f.code, f.label, f.address, b.balance_xof::float AS balance_xof, b.declared_at, b.note
      FROM fund_accounts f LEFT JOIN LATERAL (SELECT balance_xof, declared_at, note FROM fund_balances WHERE code = f.code ORDER BY id DESC LIMIT 1) b ON true WHERE f.code IN (${PISPI_CODE}, ${META_CODE})`,
    q`SELECT (SELECT coalesce(sum(balance), 0) FROM wallets)::float AS wallets`,
  ]);
  const byCode = Object.fromEntries(funds.map((f) => [f.code, f]));
  let agents = { float: 0, byChannel: [] };
  try {
    agents.float = (await q`SELECT coalesce(sum(float_xof), 0)::float AS v FROM omnicash_agents`)[0].v;
    agents.byChannel = await q`SELECT upper(coalesce(nullif(split_part(note, ' · ', 1), ''), 'SANS CANAL')) AS channel,
        coalesce(sum(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0)::float AS loaded, coalesce(sum(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0)::float AS returned
      FROM omnicash_ops WHERE kind = 'float_admin' GROUP BY 1 ORDER BY 1`;
  } catch (_) { /* OMNICASH pas encore utilisé */ }
  const r = rate();
  const metaXof = r && oc.stableTotal !== null ? Math.round(oc.stableTotal * r) : null;
  const declaredPispi = byCode[PISPI_CODE]?.balance_xof ?? null, declaredMeta = byCode[META_CODE]?.balance_xof ?? null;
  const due = liab[0].wallets + agents.float;
  const held = (declaredPispi || 0) + (metaXof !== null ? metaXof : declaredMeta || 0);
  const alerts = [];
  if (!metaAddress()) alerts.push("Adresse MetaMask inconnue : renseignez TREASURY_METAMASK_ADDRESS.");
  else if (!oc.complete) alerts.push("Lecture blockchain incomplète : certains réseaux n'ont pas répondu (voir détail).");
  if (oc.stableTotal !== null && !r) alerts.push("USDT_XOF_RATE absent : les soldes MetaMask ne sont pas convertis en FCFA.");
  if (declaredPispi === null) alerts.push("Solde PI-SPI non déclaré : saisissez-le (Ecobank ne fournit pas encore d'API).");
  if (due > 0 && held < due) alerts.push(`Couverture insuffisante : ${Math.round(held)} F en trésorerie pour ${Math.round(due)} F dus (clients + agents).`);
  const other = fl.AUTRE;
  if (other.in30 > 0 || other.out30 > 0) alerts.push(`Mouvements hors trésorerie PI-SPI/MetaMask sur 30 jours : ${Math.round(other.in30)} F entrés, ${Math.round(other.out30)} F sortis (MoMo, PayPal, CoinGate…).`);
  return {
    generatedAt: new Date().toISOString(), rate: r,
    pispi: { code: PISPI_CODE, alias: pispiAlias(), declared: declaredPispi, declaredAt: byCode[PISPI_CODE]?.declared_at || null, flows: fl.PISPI },
    metamask: { code: META_CODE, address: oc.address, chains: oc.chains, stableTotal: oc.stableTotal, valueXof: metaXof, declared: declaredMeta, declaredAt: byCode[META_CODE]?.declared_at || null, flows: fl.METAMASK },
    omnicash: { agentsFloat: agents.float, byChannel: agents.byChannel, flows: fl.OMNICASH },
    other: { flows: other },
    coverage: { due, held, ratio: due > 0 ? held / due : null }, alerts, status: alerts.length ? "ATTENTION" : "OK",
  };
}

router.get("/overview", async (req, res) => {
  try { res.json(await overview(req.query.refresh === "1")); } catch (e) { console.error("TREASURY_OVERVIEW", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

// Déclare le solde (FCFA équivalent) d'un des deux comptes. MetaMask : sans montant, utilise la lecture blockchain × USDT_XOF_RATE.
router.post("/declare", async (req, res) => {
  try {
    await ensure();
    const code = String(req.body?.code || "").toUpperCase();
    if (![PISPI_CODE, META_CODE].includes(code)) return res.status(400).json({ error: `Compte inconnu (${PISPI_CODE} ou ${META_CODE}).` });
    let amount = Number(req.body?.balanceXof), note = String(req.body?.note || "").replace(/[<>]/g, "").trim().slice(0, 160);
    if (code === META_CODE && (req.body?.balanceXof === undefined || req.body?.balanceXof === "")) {
      const oc = await onchain(true);
      if (!oc.complete || !rate()) return res.status(409).json({ error: "Lecture blockchain incomplète ou USDT_XOF_RATE absent : indiquez le montant à la main." });
      amount = Math.round(oc.stableTotal * rate()); note = note || "Lecture blockchain automatique";
    }
    if (!Number.isFinite(amount) || amount < 0 || amount > 1e12) return res.status(400).json({ error: "Solde invalide." });
    if (code === PISPI_CODE && note.length < 3) note = "Solde relevé dans l'application Ecobank";
    await sql()`INSERT INTO fund_balances (code, balance_xof, note) VALUES (${code}, ${amount}, ${note || null})`;
    res.json({ message: "Solde déclaré.", code, balanceXof: amount });
  } catch (e) { console.error("TREASURY_DECLARE", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

// Tâche planifiée facultative : déclare le solde MetaMask lu sur la blockchain (uniquement si TOUS les réseaux ont répondu).
let lastDeclared = null;
async function autoDeclare() {
  if (!on("TREASURY_AUTO_DECLARE") || !metaAddress() || !rate()) return;
  await ensure();
  const oc = await onchain(true);
  if (!oc.complete) return;
  const amount = Math.round(oc.stableTotal * rate());
  if (lastDeclared === amount) return;
  await sql()`INSERT INTO fund_balances (code, balance_xof, note) VALUES (${META_CODE}, ${amount}, 'Lecture blockchain automatique')`;
  lastDeclared = amount;
}
let timer = null;
function startScheduler() {
  if (timer || !on("TREASURY_AUTO_DECLARE")) return;
  setTimeout(() => autoDeclare().catch((e) => console.error("TREASURY_AUTO", e.message)), 60000).unref?.();
  timer = setInterval(() => autoDeclare().catch((e) => console.error("TREASURY_AUTO", e.message)), 10 * 60000);
  if (timer.unref) timer.unref();
  console.log("[TRÉSORERIE] déclaration automatique du solde MetaMask active (toutes les 10 min)");
}

router.startScheduler = startScheduler;
router._test = { onchain, flows };
module.exports = router;
