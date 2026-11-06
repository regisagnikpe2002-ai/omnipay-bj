"use strict";
// OMNIPAY — Numéros virtuels (SMS de vérification) via SMSCodes : FICHIER AJOUTÉ.
// Principe : le client choisit un pays et un service, son solde est débité tout de suite (réservation),
// le serveur loue un numéro chez le fournisseur, le client reçoit son code SMS dans l'application.
// Pas de code reçu avant expiration = remboursement automatique. Aucun débit sans ligne d'historique, tout est atomique.
// La clé fournisseur (SMSCODES_KEY) reste sur le serveur : elle n'est jamais envoyée au navigateur ni écrite dans les logs.
// Réglages (Render) : SMSCODES_KEY, VN_PRICE_XOF (prix de vente), VN_TTL_MIN, VN_BLOCK (mots interdits), VN_ENABLED=off pour couper.
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const BASE = "https://code.smscodes.io/api/sms";
const MAX_OPEN = 3;
const MAX_DAY = 20;
const POLL_GAP_MS = 4000;
let ready = false;

const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);
const price = () => { const p = Math.round(Number(process.env.VN_PRICE_XOF || 500)); return Number.isFinite(p) && p >= 100 ? p : 500; };
const ttlMin = () => { const t = Number(process.env.VN_TTL_MIN || 20); return Number.isFinite(t) && t >= 5 && t <= 120 ? t : 20; };
const enabled = () => String(process.env.VN_ENABLED || "on").toLowerCase() !== "off";
const hasKey = () => Boolean(process.env.SMSCODES_KEY);
const blockList = () => String(process.env.VN_BLOCK == null ? "bank,banque,gouv,government" : process.env.VN_BLOCK).toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." }));

async function ensureTables() {
  if (ready) return;
  await sql()`CREATE TABLE IF NOT EXISTS vn_orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, iso varchar(8) NOT NULL,
    service_id varchar(64) NOT NULL, service_name varchar(80), price_xof numeric(18,2) NOT NULL,
    status varchar(12) NOT NULL DEFAULT 'renting', number varchar(40), supplier_order varchar(80), sec_id varchar(160),
    sms text, code varchar(16), expires_at timestamptz, received_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now())`;
  ready = true;
}

// ---------- Fournisseur (SMSCodes) ----------
function failed(d) {
  if (!d || typeof d !== "object") return true;
  const e = d.Error != null ? String(d.Error).trim() : "";
  if (e && !/^(0|none|null|false|no error|ok)$/i.test(e)) return true;
  return /error|fail/i.test(String(d.Status || ""));
}
async function supplier(method, params = {}) {
  if (!hasKey()) throw new Error("not_configured");
  const qs = new URLSearchParams({ key: process.env.SMSCODES_KEY, ...params });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(`${BASE}/${method}?${qs.toString()}`, { signal: ctl.signal });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d) throw new Error("supplier_http_" + r.status);
    return d;
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "supplier_timeout" : String(e.message || "supplier_error").replace(process.env.SMSCODES_KEY, "***"));
  } finally { clearTimeout(timer); }
}
const pick = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== "") return o[k]; return ""; };
function toList(v) {
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return []; } }
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") return Object.entries(v).map(([k, x]) => (x && typeof x === "object" ? { id: k, ...x } : { id: k, name: x }));
  return [];
}
const normCountries = (d) => toList(d && d.Countries).map((c) => {
  if (typeof c === "string") return { iso: c.toUpperCase().slice(0, 8), name: c };
  const iso = String(pick(c, ["iso", "ISO", "Iso", "code", "Code", "id", "Id", "ID"])).toUpperCase().slice(0, 8);
  return { iso, name: clean(pick(c, ["name", "Name", "country", "Country"]) || iso, 60) };
}).filter((c) => c.iso);
const normServices = (d) => toList(d && d.Services).map((s) => {
  if (typeof s === "string") return { id: s, name: s };
  const id = String(pick(s, ["id", "Id", "ID", "serviceId", "ServiceId", "service_id", "code"]));
  return { id: id.slice(0, 64), name: clean(pick(s, ["name", "Name", "service", "Service", "title"]) || id, 80) };
}).filter((s) => s.id);

const cache = {};
async function cached(key, fn) {
  const c = cache[key];
  if (c && Date.now() - c.at < 10 * 60 * 1000) return c.v;
  const v = await fn();
  cache[key] = { at: Date.now(), v };
  return v;
}

// ---------- Aide : remboursement atomique (une seule fois) ----------
async function refundOrder(id, newStatus) {
  const rows = await sql()`
    WITH o AS (UPDATE vn_orders SET status = ${newStatus} WHERE id = ${id}::uuid AND status IN ('renting','active') RETURNING user_id, price_xof),
    w AS (UPDATE wallets SET balance = balance + o.price_xof FROM o WHERE wallets.user_id = o.user_id RETURNING wallets.balance),
    t AS (UPDATE transactions SET status = 'failed' WHERE provider = 'virtualnum' AND provider_ref = ${id} AND EXISTS (SELECT 1 FROM o) RETURNING id)
    SELECT balance FROM w`;
  return rows.length ? Number(rows[0].balance) : null;
}
const expiryOf = (row) => (row.expires_at ? new Date(row.expires_at).getTime() : new Date(row.created_at).getTime() + ttlMin() * 60000);
async function sweepExpired(userId) {
  const rows = await sql()`SELECT id, status, expires_at, created_at FROM vn_orders WHERE user_id = ${userId} AND status = 'active' AND code IS NULL ORDER BY created_at DESC LIMIT 20`;
  for (const r of rows) if (Date.now() > expiryOf(r)) await refundOrder(r.id, "expired");
}
const publicOrder = (r) => ({
  id: r.id, iso: r.iso, serviceId: r.service_id, serviceName: r.service_name, price: Number(r.price_xof), status: r.status,
  number: r.number || null, sms: r.sms || null, code: r.code || null, expiresAt: r.expires_at || null, createdAt: r.created_at,
});
const lastPoll = {};
const busy = new Set();

// ---------- Client ----------
router.get("/info", requireAuth, async (req, res) => {
  try {
    const ok = enabled() && hasKey();
    let countries = [];
    if (ok) { try { countries = await cached("countries", async () => normCountries(await supplier("GetRentalCountries"))); } catch (e) { console.error("VN_COUNTRIES", e.message); } }
    res.json({ enabled: ok, price: price(), ttlMin: ttlMin(), openMax: MAX_OPEN, countries: countries.slice(0, 300),
      message: ok ? undefined : "Service en cours d'activation." });
  } catch (e) { console.error("VN_INFO", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.get("/services", requireAuth, async (req, res) => {
  try {
    if (!enabled() || !hasKey()) return res.json({ services: [] });
    const q = clean(req.query.q, 40).toLowerCase();
    const all = await cached("services", async () => normServices(await supplier("GetServiceCodes")));
    const bl = blockList();
    const list = all.filter((s) => !bl.some((w) => s.name.toLowerCase().includes(w)) && (!q || s.name.toLowerCase().includes(q))).slice(0, 60);
    res.json({ services: list });
  } catch (e) { console.error("VN_SERVICES", e.message); res.status(502).json({ error: "Liste des services indisponible." }); }
});

router.post("/rent", requireAuth, async (req, res) => {
  const uid = req.user.userId;
  if (busy.has(uid)) return res.status(429).json({ error: "Une commande est déjà en cours." });
  busy.add(uid);
  let orderId = null;
  try {
    if (!enabled() || !hasKey()) return res.status(503).json({ error: "Service en cours d'activation." });
    const iso = clean(req.body?.iso, 8).toUpperCase();
    const serviceId = clean(req.body?.serviceId, 64);
    const serviceName = clean(req.body?.serviceName, 80) || serviceId;
    if (!/^[A-Z0-9]{2,8}$/.test(iso)) return res.status(400).json({ error: "Choisissez un pays." });
    if (!serviceId) return res.status(400).json({ error: "Choisissez un service." });
    const bl = blockList();
    if (bl.some((w) => serviceName.toLowerCase().includes(w))) return res.status(400).json({ error: "Ce service n'est pas disponible." });
    await ensureTables();
    await sweepExpired(uid);
    const q = sql();
    const [c] = await q`SELECT count(*) FILTER (WHERE status = 'active' AND code IS NULL)::int AS open, count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS day FROM vn_orders WHERE user_id = ${uid}`;
    if (c.open >= MAX_OPEN) return res.status(429).json({ error: "Vous avez déjà des numéros en attente de code. Patientez ou attendez leur expiration." });
    if (c.day >= MAX_DAY) return res.status(429).json({ error: "Limite journalière atteinte." });
    const amount = price();
    const key = "vn-" + crypto.randomUUID();
    const rows = await q`
      WITH w AS (UPDATE wallets SET balance = balance - ${amount} WHERE user_id = ${uid} AND balance >= ${amount} RETURNING id, balance),
      o AS (INSERT INTO vn_orders (user_id, iso, service_id, service_name, price_xof)
            SELECT ${uid}, ${iso}, ${serviceId}, ${serviceName}, ${amount} FROM w RETURNING id),
      t AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key)
            SELECT w.id, 'withdrawal', ${amount}, w.balance, 'pending', 'virtualnum', o.id::text, ${key} FROM w, o RETURNING id)
      SELECT o.id, w.balance FROM o, w`;
    if (!rows.length) return res.status(400).json({ error: "Solde insuffisant." });
    orderId = rows[0].id;
    let d;
    try { d = await supplier("RentNumber", { iso, serviceId }); } catch (e) { console.error("VN_RENT", e.message); d = null; }
    if (!d || failed(d) || !pick(d, ["Number", "number"])) {
      const nb = await refundOrder(orderId, "failed");
      return res.status(502).json({ error: "Aucun numéro disponible pour ce service. Vous n'avez pas été débité.", newBalance: nb });
    }
    const number = clean(pick(d, ["Number", "number"]), 40);
    const supOrder = clean(pick(d, ["OrderId", "orderId", "OrderID"]), 80);
    const expRaw = pick(d, ["Expiry Date", "ExpiryDate", "Expiry", "expiry"]);
    const expTs = Date.parse(String(expRaw));
    const expires = Number.isFinite(expTs) && expTs > Date.now() ? new Date(expTs) : new Date(Date.now() + ttlMin() * 60000);
    let secId = "";
    try { const r2 = await supplier("SetRentedNumber", { number }); if (!failed(r2)) secId = clean(pick(r2, ["SecurityId", "securityId", "SecurityID"]), 160); } catch (e) { console.error("VN_SET", e.message); }
    const [row] = await q`UPDATE vn_orders SET status = 'active', number = ${number}, supplier_order = ${supOrder}, sec_id = ${secId}, expires_at = ${expires.toISOString()}
      WHERE id = ${orderId}::uuid RETURNING *`;
    res.status(201).json({ order: publicOrder(row), newBalance: Number(rows[0].balance) });
  } catch (e) {
    console.error("VN_RENT_FATAL", e.message);
    if (orderId) { try { await refundOrder(orderId, "failed"); } catch (e2) { console.error("VN_REFUND", e2.message); } }
    res.status(500).json({ error: "Impossible de traiter la commande. Si vous avez été débité, le remboursement est automatique." });
  } finally { busy.delete(uid); }
});

router.get("/order/:id", requireAuth, async (req, res) => {
  try {
    await ensureTables();
    const id = String(req.params.id || "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: "Commande invalide." });
    const q = sql();
    let [row] = await q`SELECT * FROM vn_orders WHERE id = ${id}::uuid AND user_id = ${req.user.userId}`;
    if (!row) return res.status(404).json({ error: "Commande introuvable." });
    let newBalance;
    if (row.status === "active" && !row.code && Date.now() > expiryOf(row)) {
      newBalance = await refundOrder(row.id, "expired");
      [row] = await q`SELECT * FROM vn_orders WHERE id = ${id}::uuid`;
    } else if ((row.status === "active" || row.status === "done") && row.number && hasKey() && Date.now() - (lastPoll[row.id] || 0) > POLL_GAP_MS) {
      lastPoll[row.id] = Date.now();
      try {
        let sec = row.sec_id;
        if (!sec) { const r2 = await supplier("SetRentedNumber", { number: row.number }); if (!failed(r2)) { sec = clean(pick(r2, ["SecurityId", "securityId", "SecurityID"]), 160); if (sec) await q`UPDATE vn_orders SET sec_id = ${sec} WHERE id = ${row.id}::uuid`; } }
        if (sec) {
          const d = await supplier("GetRentedSMSCode", { sid: sec, number: row.number });
          const sms = clean(pick(d, ["SMS", "Sms", "sms"]), 600);
          if (!failed(d) && sms && !/^(none|no sms|null|waiting|0)$/i.test(sms) && sms !== row.sms) {
            const m = sms.match(/\b\d{4,8}\b/);
            const code = m ? m[0] : sms.slice(0, 16);
            const upd = await q`
              WITH o AS (UPDATE vn_orders SET sms = ${sms}, code = ${code}, received_at = COALESCE(received_at, now()), status = 'done'
                         WHERE id = ${row.id}::uuid AND status IN ('active','done') RETURNING id),
              t AS (UPDATE transactions SET status = 'completed' WHERE provider = 'virtualnum' AND provider_ref = ${row.id} AND status = 'pending' AND EXISTS (SELECT 1 FROM o) RETURNING id)
              SELECT id FROM o`;
            if (upd.length) [row] = await q`SELECT * FROM vn_orders WHERE id = ${id}::uuid`;
          }
        }
      } catch (e) { console.error("VN_POLL", e.message); }
    }
    res.json({ order: publicOrder(row), newBalance });
  } catch (e) { console.error("VN_ORDER", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.get("/mine", requireAuth, async (req, res) => {
  try {
    await ensureTables();
    await sweepExpired(req.user.userId);
    const rows = await sql()`SELECT * FROM vn_orders WHERE user_id = ${req.user.userId} ORDER BY created_at DESC LIMIT 20`;
    res.json({ orders: rows.map(publicOrder) });
  } catch (e) { console.error("VN_MINE", e.message); res.status(500).json({ error: "Erreur." }); }
});

// ---------- Administrateur ----------
// Montre la forme exacte des réponses du fournisseur (sans la clé) pour vérifier le branchement.
router.get("/admin/probe", adminOnly, async (req, res) => {
  try {
    const out = {};
    for (const m of ["GetRentalCountries", "GetServiceCodes", "GetLiveRentedNumbers"]) {
      try { const d = await supplier(m); out[m] = JSON.parse(JSON.stringify(d, (k, v) => (Array.isArray(v) ? v.slice(0, 5) : v))); } catch (e) { out[m] = { error: e.message }; }
    }
    res.json({ configured: hasKey(), enabled: enabled(), price: price(), probe: out });
  } catch (e) { res.status(500).json({ error: "Erreur." }); }
});
router.get("/admin/orders", adminOnly, async (req, res) => {
  try {
    await ensureTables();
    const rows = await sql()`SELECT id, user_id, iso, service_name, price_xof::float AS price, status, number, created_at FROM vn_orders ORDER BY created_at DESC LIMIT 100`;
    res.json({ orders: rows });
  } catch (e) { res.status(500).json({ error: "Erreur." }); }
});

module.exports = router;
