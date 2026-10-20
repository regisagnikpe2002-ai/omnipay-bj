"use strict";
// OMNIPAY — LEDGER CENTRAL (fichier AJOUTÉ). Ne modifie jamais les soldes ni les transactions : il les COPIE et les contrôle.
//  - Journal inviolable : chaque transaction et chaque changement de statut devient une ligne, chaînée par empreinte SHA-256
//    (toute modification ou suppression est refusée par la base ; /verify détecte une altération).
//  - Chaque ligne porte : référence reçu, order_id de réconciliation, origine, compte de fonds, montant, frais, statut, tx hash.
//  - Registre des comptes de fonds (banque, Mobile Money, prestataire, hot/cold wallet) : ADRESSES PUBLIQUES SEULEMENT.
//  - Soldes déclarés par l'administrateur => taux de couverture des soldes clients par les fonds réels de l'entreprise.
// Aucune clé privée n'est acceptée ni stockée : toute saisie ressemblant à une clé ou une phrase de récupération est refusée.
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." }));
const GENESIS = "0".repeat(64);
let ready = false;
let syncing = false;

async function ensureTables() {
  if (ready) return;
  const q = sql();
  await q`CREATE TABLE IF NOT EXISTS ledger_entries (
    seq bigserial PRIMARY KEY, ref varchar(24) NOT NULL, order_id varchar(100) NOT NULL, tx_id uuid NOT NULL, status varchar(20) NOT NULL,
    user_id uuid, kind varchar(30) NOT NULL, direction varchar(8) NOT NULL, origin varchar(40) NOT NULL, fund_account varchar(40),
    amount_xof numeric(18,2) NOT NULL, fee_xof numeric(18,2) NOT NULL DEFAULT 0, external_ref varchar(255), tx_hash varchar(200),
    occurred_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
    prev_hash char(64) NOT NULL, row_hash char(64) NOT NULL, UNIQUE (tx_id, status))`;
  await q`CREATE INDEX IF NOT EXISTS ledger_order_idx ON ledger_entries (order_id)`;
  await q`CREATE OR REPLACE FUNCTION ledger_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'ledger_entries est en ecriture seule'; END; $$ LANGUAGE plpgsql`;
  await q`DROP TRIGGER IF EXISTS ledger_no_change ON ledger_entries`;
  await q`CREATE TRIGGER ledger_no_change BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_immutable()`;
  await q`CREATE TABLE IF NOT EXISTS fund_accounts (
    code varchar(40) PRIMARY KEY, kind varchar(10) NOT NULL, label varchar(120) NOT NULL, currency varchar(10) NOT NULL DEFAULT 'XOF',
    network varchar(40), address varchar(200), custody varchar(200), hot_max_xof numeric(18,2), active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now())`;
  await q`CREATE TABLE IF NOT EXISTS fund_balances (
    id bigserial PRIMARY KEY, code varchar(40) NOT NULL, balance_xof numeric(18,2) NOT NULL, note varchar(200), declared_at timestamptz NOT NULL DEFAULT now())`;
  ready = true;
}

// ---------- Règles de classement ----------
const FUND_BY_ORIGIN = { paydunya: "PAYDUNYA", coingate: "COINGATE", binance_pay: "BINANCE", manual: "MANUEL", internal: "INTERNE" };
const refOf = (id) => "OMP-R" + String(id).replace(/-/g, "").slice(0, 10).toUpperCase();

function classify(t) {
  const origin = t.provider || "internal";
  let kind = t.type, direction = "internal", fund = FUND_BY_ORIGIN[origin] || "INTERNE", orderId = refOf(t.id);
  if (t.type === "deposit") {
    direction = "in";
    orderId = origin === "paydunya" ? String(t.provider_ref || orderId) : origin === "manual" ? "MD-" + t.provider_ref : String(t.idempotency_key);
  } else if (t.type === "withdrawal") {
    direction = "out"; fund = origin === "manual" ? "MANUEL" : "MOBILE_MONEY";
  } else if (t.type === "commission") {
    kind = "fee"; direction = "fee"; fund = "REVENUS";
    orderId = "FEE-" + String(t.idempotency_key).replace(/-fee$/, "").slice(0, 60);
  } else if (t.type === "refund") { fund = "INTERNE"; }
  const hash = t.manual_hash && String(t.manual_hash).length >= 16 ? String(t.manual_hash).slice(0, 200) : null;
  return { kind, direction, origin, fund, orderId, hash };
}

function rowHash(prev, e) {
  return crypto.createHash("sha256").update([prev, e.ref, e.order_id, e.tx_id, e.status, e.kind, e.direction, e.origin, e.fund, Number(e.amount).toFixed(2),
    Number(e.fee).toFixed(2), e.ext || "", e.hash || "", new Date(e.at).toISOString()].join("|")).digest("hex");
}

// Copie dans le journal les transactions (ou statuts) pas encore enregistrés. Idempotent.
async function syncLedger(max = 500) {
  if (syncing) return { added: 0, busy: true };
  syncing = true;
  try {
    await ensureTables();
    const q = sql();
    const hasManual = (await q`SELECT to_regclass('public.manual_deposits') IS NOT NULL AS ok`)[0].ok;
    const base = `SELECT t.id, t.type, t.status, t.amount::float AS amount, t.provider, t.provider_ref, t.idempotency_key, t.created_at, w.user_id,
        CASE WHEN t.type IN ('withdrawal','transfer_out') THEN coalesce((SELECT c.amount FROM transactions c WHERE c.type = 'commission'
          AND c.idempotency_key = regexp_replace(t.idempotency_key, '-(out|in)$', '') || '-fee' LIMIT 1), 0)::float ELSE 0 END AS fee,
        ${hasManual ? "md.tx_ref" : "NULL"} AS manual_hash
      FROM transactions t JOIN wallets w ON w.id = t.wallet_id
      ${hasManual ? "LEFT JOIN manual_deposits md ON t.provider = 'manual' AND md.id::text = t.provider_ref" : ""}
      WHERE NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.tx_id = t.id AND l.status = t.status)
      ORDER BY t.created_at, t.id LIMIT ${Number(max) | 0}`;
    const rows = await q.query(base);
    if (!rows.length) return { added: 0 };
    const last = await q`SELECT row_hash FROM ledger_entries ORDER BY seq DESC LIMIT 1`;
    let prev = last.length ? last[0].row_hash : GENESIS;
    let added = 0;
    for (const t of rows) {
      const c = classify(t);
      const e = { ref: refOf(t.id), order_id: c.orderId, tx_id: t.id, status: t.status, kind: c.kind, direction: c.direction, origin: c.origin, fund: c.fund,
        amount: t.amount, fee: t.fee, ext: t.provider_ref ? String(t.provider_ref).slice(0, 255) : null, hash: c.hash, at: t.created_at };
      const h = rowHash(prev, e);
      const ins = await q`INSERT INTO ledger_entries (ref, order_id, tx_id, status, user_id, kind, direction, origin, fund_account, amount_xof, fee_xof, external_ref, tx_hash, occurred_at, prev_hash, row_hash)
        VALUES (${e.ref}, ${e.order_id}, ${e.tx_id}, ${e.status}, ${t.user_id}, ${e.kind}, ${e.direction}, ${e.origin}, ${e.fund}, ${e.amount}, ${e.fee}, ${e.ext}, ${e.hash}, ${new Date(e.at).toISOString()}, ${prev}, ${h})
        ON CONFLICT (tx_id, status) DO NOTHING RETURNING seq`;
      if (ins.length) { prev = h; added++; }
    }
    return { added };
  } finally { syncing = false; }
}

async function verifyChain() {
  await ensureTables();
  const q = sql();
  let prev = GENESIS, count = 0, lastSeq = 0;
  for (;;) {
    const rows = await q`SELECT seq, ref, order_id, tx_id, status, kind, direction, origin, fund_account, amount_xof, fee_xof, external_ref, tx_hash, occurred_at, prev_hash, row_hash
      FROM ledger_entries WHERE seq > ${lastSeq} ORDER BY seq LIMIT 1000`;
    if (!rows.length) break;
    for (const r of rows) {
      const e = { ref: r.ref, order_id: r.order_id, tx_id: r.tx_id, status: r.status, kind: r.kind, direction: r.direction, origin: r.origin, fund: r.fund_account,
        amount: r.amount_xof, fee: r.fee_xof, ext: r.external_ref, hash: r.tx_hash, at: r.occurred_at };
      if (r.prev_hash !== prev || rowHash(prev, e) !== r.row_hash) return { ok: false, count, brokenAtSeq: Number(r.seq) };
      prev = r.row_hash; count++; lastSeq = Number(r.seq);
    }
  }
  return { ok: true, count };
}

// ---------- Refus de tout secret ----------
function looksSecret(v) {
  const s = String(v || "").trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(s)) return true;                       // clé privée hexadécimale
  if (/^(xprv|yprv|zprv)[1-9A-HJ-NP-Za-km-z]{50,}/.test(s)) return true;   // clé étendue privée
  if (/^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(s)) return true;           // clé privée WIF
  if (/^([a-z]{3,8}\s+){11,23}[a-z]{3,8}$/.test(s)) return true;           // phrase de récupération 12-24 mots
  return false;
}
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);

// ---------- Routes (administrateur) ----------
router.use(adminOnly);

router.post("/sync", async (req, res) => {
  try { res.json(await syncLedger(2000)); } catch (e) { console.error("LEDGER_SYNC", e.message); res.status(500).json({ error: "Erreur de synchronisation." }); }
});
router.get("/verify", async (req, res) => {
  try { res.json(await verifyChain()); } catch (e) { console.error("LEDGER_VERIFY", e.message); res.status(500).json({ error: "Erreur de vérification." }); }
});
router.get("/entries", async (req, res) => {
  try {
    await ensureTables();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 5000);
    const order = clean(req.query.order_id, 100);
    const rows = order
      ? await sql()`SELECT seq, ref, order_id, status, kind, direction, origin, fund_account, amount_xof::float AS amount, fee_xof::float AS fee, external_ref, tx_hash, occurred_at FROM ledger_entries WHERE order_id = ${order} ORDER BY seq`
      : await sql()`SELECT seq, ref, order_id, status, kind, direction, origin, fund_account, amount_xof::float AS amount, fee_xof::float AS fee, external_ref, tx_hash, occurred_at FROM ledger_entries ORDER BY seq DESC LIMIT ${limit}`;
    res.json({ entries: rows });
  } catch (e) { console.error("LEDGER_ENTRIES", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.get("/funds", async (req, res) => {
  try {
    await ensureTables();
    const q = sql();
    const funds = await q`SELECT f.code, f.kind, f.label, f.currency, f.network, f.address, f.custody, f.hot_max_xof::float AS hot_max_xof, f.active,
        b.balance_xof::float AS balance_xof, b.declared_at,
        coalesce((SELECT sum(CASE WHEN l.direction = 'in' THEN l.amount_xof WHEN l.direction = 'out' THEN -l.amount_xof ELSE 0 END)
                  FROM ledger_entries l WHERE l.fund_account = f.code AND l.status = 'completed'), 0)::float AS net_movement
      FROM fund_accounts f LEFT JOIN LATERAL (SELECT balance_xof, declared_at FROM fund_balances WHERE code = f.code ORDER BY id DESC LIMIT 1) b ON true
      ORDER BY f.kind, f.code`;
    const flows = await q`SELECT fund_account AS code, sum(CASE WHEN direction = 'in' THEN amount_xof ELSE 0 END)::float AS entrees,
        sum(CASE WHEN direction = 'out' THEN amount_xof ELSE 0 END)::float AS sorties FROM ledger_entries WHERE status = 'completed' GROUP BY fund_account ORDER BY 1`;
    res.json({ funds, flowsByFund: flows });
  } catch (e) { console.error("LEDGER_FUNDS", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.post("/funds", async (req, res) => {
  try {
    await ensureTables();
    const b = req.body || {};
    for (const k of Object.keys(b)) if (looksSecret(b[k])) return res.status(400).json({ error: "Ne saisissez jamais de clé privée ni de phrase de récupération : seules les adresses publiques et numéros de compte sont acceptés." });
    const code = clean(b.code, 40).toUpperCase().replace(/[^A-Z0-9_]/g, "");
    const kind = String(b.kind || "").toLowerCase();
    if (!code || !["bank", "momo", "psp", "hot", "cold"].includes(kind)) return res.status(400).json({ error: "Code et type (bank, momo, psp, hot, cold) requis." });
    const label = clean(b.label, 120);
    if (!label) return res.status(400).json({ error: "Libellé requis." });
    const hotMax = Number(b.hotMaxXof);
    await sql()`INSERT INTO fund_accounts (code, kind, label, currency, network, address, custody, hot_max_xof, active)
      VALUES (${code}, ${kind}, ${label}, ${clean(b.currency, 10) || "XOF"}, ${clean(b.network, 40) || null}, ${clean(b.address, 200) || null}, ${clean(b.custody, 200) || null},
              ${Number.isFinite(hotMax) && hotMax > 0 ? hotMax : null}, ${b.active !== false})
      ON CONFLICT (code) DO UPDATE SET kind = EXCLUDED.kind, label = EXCLUDED.label, currency = EXCLUDED.currency, network = EXCLUDED.network, address = EXCLUDED.address,
        custody = EXCLUDED.custody, hot_max_xof = EXCLUDED.hot_max_xof, active = EXCLUDED.active`;
    res.json({ message: "Compte enregistré.", code });
  } catch (e) { console.error("LEDGER_FUND_SAVE", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.post("/funds/:code/balance", async (req, res) => {
  try {
    await ensureTables();
    const code = clean(req.params.code, 40).toUpperCase();
    const bal = Number(req.body?.balanceXof);
    if (!Number.isFinite(bal) || bal < 0 || bal > 1e12) return res.status(400).json({ error: "Solde (FCFA équivalent) invalide." });
    const f = await sql()`SELECT code FROM fund_accounts WHERE code = ${code}`;
    if (!f.length) return res.status(404).json({ error: "Compte inconnu." });
    await sql()`INSERT INTO fund_balances (code, balance_xof, note) VALUES (${code}, ${bal}, ${clean(req.body?.note, 200) || null})`;
    res.json({ message: "Solde enregistré." });
  } catch (e) { console.error("LEDGER_BAL", e.message); res.status(500).json({ error: "Erreur." }); }
});

// Couverture : les fonds réels de l'entreprise couvrent-ils ce que OMNIPAY doit à ses clients ?
async function coverage() {
  await ensureTables();
  const q = sql();
  const liab = (await q`SELECT coalesce(sum(balance), 0)::float AS v FROM wallets`)[0].v;
  const held = await q`SELECT f.kind, coalesce(sum(b.balance_xof), 0)::float AS v
    FROM fund_accounts f LEFT JOIN LATERAL (SELECT balance_xof FROM fund_balances WHERE code = f.code ORDER BY id DESC LIMIT 1) b ON true
    WHERE f.active GROUP BY f.kind`;
  const byKind = Object.fromEntries(held.map((h) => [h.kind, h.v]));
  const total = held.reduce((s, h) => s + h.v, 0);
  const ratio = liab > 0 ? total / liab : null;
  const hot = await q`SELECT f.code, f.label, f.hot_max_xof::float AS max, b.balance_xof::float AS bal
    FROM fund_accounts f JOIN LATERAL (SELECT balance_xof FROM fund_balances WHERE code = f.code ORDER BY id DESC LIMIT 1) b ON true
    WHERE f.active AND f.kind = 'hot' AND f.hot_max_xof IS NOT NULL AND b.balance_xof > f.hot_max_xof`;
  const alerts = [];
  if (liab > 0 && total === 0) alerts.push("Aucun solde de fonds déclaré : impossible de vérifier que les soldes clients sont couverts.");
  else if (ratio !== null && ratio < 1) alerts.push(`Couverture insuffisante : ${(ratio * 100).toFixed(1)} % des soldes clients.`);
  for (const h of hot) alerts.push(`Hot wallet ${h.code} au-dessus de son plafond (${Math.round(h.bal)} > ${Math.round(h.max)} FCFA) : transférez l'excédent vers le cold wallet.`);
  return { liabilities: liab, held: total, byKind, ratio, status: alerts.length ? "ATTENTION" : "OK", alerts };
}
router.get("/coverage", async (req, res) => {
  try { res.json(await coverage()); } catch (e) { console.error("LEDGER_COV", e.message); res.status(500).json({ error: "Erreur." }); }
});

// Tâche planifiée : copie du journal toutes les 10 minutes + alerte e-mail (1 fois / 24 h) si la couverture est insuffisante.
let lastNotice = 0;
function startScheduler() {
  const tick = async () => {
    try {
      await syncLedger(2000);
      const c = await coverage();
      if (c.status !== "OK" && Date.now() - lastNotice > 24 * 3600 * 1000) {
        lastNotice = Date.now();
        try { await require("../lib/mailer.js").sendAdminNotification("OMNIPAY — alerte fonds", `<p>${c.alerts.map((a) => String(a).replace(/[<>]/g, "")).join("</p><p>")}</p>`); } catch (_) { /* e-mail facultatif */ }
      }
    } catch (e) { console.error("[LEDGER] tâche :", e.message); }
  };
  setTimeout(tick, 20000);
  setInterval(tick, 10 * 60 * 1000);
}

module.exports = router;
module.exports.startScheduler = startScheduler;
module.exports.syncLedger = syncLedger;
module.exports.looksSecret = looksSecret;
