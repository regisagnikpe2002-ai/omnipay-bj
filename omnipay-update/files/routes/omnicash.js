"use strict";
// OMNIPAY — OMNICASH : réseau d'agents gérés par les clients eux-mêmes, relié à OMNICHECK.
// Un client devient agent (validation admin), reçoit une TRÉSORERIE (float) :
//   • Dépôt en espèces (cash-in)  : le client donne des espèces à l'agent → le float de l'agent baisse, le portefeuille du client monte.
//   • Retrait en espèces (cash-out): le client génère un code à 6 chiffres (10 min), l'agent le saisit → le portefeuille du client baisse (+ frais),
//     le float de l'agent monte (+ part de commission), l'agent remet les espèces.
// Toutes les opérations d'argent sont atomiques (une instruction SQL gardée par l'état courant) : pas de double exécution, float jamais négatif.
// Le float réel est chargé par l'admin après réception de l'argent réel (banque / Mobile Money / PI-SPI) : voir /api/omnicash/admin/*.
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const num = (n, d) => { const v = Number(process.env[n]); return Number.isFinite(v) && v >= 0 ? v : d; };
const MAX_OP = () => num("OMNICASH_MAX_OP", 500000);
const IN_BPS = () => num("OMNICASH_IN_COMM_BPS", 50);        // commission agent sur dépôt espèces (payée par OMNIPAY), 0,50 %
const OUT_BPS = () => num("OMNICASH_OUT_FEE_BPS", 100);      // frais client sur retrait espèces, 1 %
const OUT_MIN = () => num("OMNICASH_OUT_FEE_MIN", 100);
const SHARE = () => Math.min(100, num("OMNICASH_AGENT_SHARE_PCT", 50)); // part des frais de retrait reversée à l'agent
const CODE_TTL_MIN = 10, MAX_TRIES = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." }));
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);
const ref = (p) => p + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString("hex").toUpperCase();
const secret = () => process.env.OTP_SECRET || process.env.ADMIN_KEY || "";
const hashCode = (id, code) => crypto.createHmac("sha256", secret()).update("omc:" + id + ":" + code).digest("hex");
const outFee = (amount) => Math.max(OUT_MIN(), Math.ceil((amount * OUT_BPS()) / 10000));

let ready = null;
function ensure() {
  if (!ready) ready = (async () => {
    const q = sql();
    await q`CREATE TABLE IF NOT EXISTS omnicash_agents (
      user_id uuid PRIMARY KEY, name varchar(80), city varchar(80), status varchar(12) NOT NULL DEFAULT 'pending',
      float_xof numeric(18,2) NOT NULL DEFAULT 0 CHECK (float_xof >= 0), float_limit numeric(18,2) NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now())`;
    await q`CREATE TABLE IF NOT EXISTS omnicash_ops (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_id uuid NOT NULL, client_id uuid, kind varchar(14) NOT NULL,
      amount numeric(18,2) NOT NULL, fee numeric(18,2) NOT NULL DEFAULT 0, agent_commission numeric(18,2) NOT NULL DEFAULT 0,
      ref varchar(40) NOT NULL UNIQUE, note varchar(200), created_at timestamptz NOT NULL DEFAULT now())`;
    await q`CREATE TABLE IF NOT EXISTS omnicash_cashout_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL, amount numeric(18,2) NOT NULL, code_hash varchar(64) NOT NULL,
      status varchar(10) NOT NULL DEFAULT 'pending', attempts int NOT NULL DEFAULT 0, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`;
  })().catch((e) => { ready = null; throw e; });
  return ready;
}
const fail = (res, e, tag) => { console.error(tag, e.message); res.status(500).json({ error: "Erreur serveur." }); };
const amountOf = (v) => { const a = Math.floor(Number(v)); return Number.isFinite(a) && a >= 100 && a <= MAX_OP() ? a : null; };
const agentOf = async (userId) => (await sql()`SELECT user_id, name, city, status, float_xof::float AS float, float_limit::float AS "limit" FROM omnicash_agents WHERE user_id = ${userId}::uuid`)[0] || null;
const needAgent = async (req, res, next) => {
  try { await ensure(); const a = await agentOf(req.user.userId); if (!a || a.status !== "active") return res.status(403).json({ error: "Compte agent OMNICASH non actif." }); req.agent = a; next(); }
  catch (e) { fail(res, e, "OMC_AGENT"); }
};

// ================= Client / agent =================
router.get("/me", requireAuth, async (req, res) => {
  try {
    await ensure();
    const a = await agentOf(req.user.userId);
    if (!a) return res.json({ agent: null, rates: { outFeeBps: OUT_BPS(), outFeeMin: OUT_MIN() } });
    const ops = await sql()`SELECT kind, amount::float AS amount, fee::float AS fee, agent_commission::float AS commission, ref, created_at FROM omnicash_ops WHERE agent_id = ${req.user.userId}::uuid ORDER BY created_at DESC LIMIT 30`;
    res.json({ agent: a, ops, maxOp: MAX_OP() });
  } catch (e) { fail(res, e, "OMC_ME"); }
});

router.post("/apply", requireAuth, async (req, res) => {
  try {
    await ensure();
    const name = clean(req.body?.name, 80), city = clean(req.body?.city, 80);
    if (name.length < 2 || city.length < 2) return res.status(400).json({ error: "Nom du point et ville requis." });
    const r = await sql()`INSERT INTO omnicash_agents (user_id, name, city) VALUES (${req.user.userId}::uuid, ${name}, ${city}) ON CONFLICT (user_id) DO NOTHING RETURNING user_id`;
    if (!r.length) return res.status(409).json({ error: "Vous avez déjà une demande agent." });
    res.status(201).json({ message: "Demande envoyée. OMNIPAY vous contactera pour la validation et le chargement de votre trésorerie." });
  } catch (e) { fail(res, e, "OMC_APPLY"); }
});

// Dépôt en espèces : le float de l'agent finance le portefeuille du client.
router.post("/cashin", requireAuth, needAgent, async (req, res) => {
  try {
    const amount = amountOf(req.body?.amount);
    const code = clean(req.body?.code, 20).toUpperCase().replace(/\s/g, "");
    if (!amount) return res.status(400).json({ error: `Montant entre 100 et ${MAX_OP()} FCFA.` });
    const c = await sql()`SELECT user_id FROM account_ids WHERE code = ${code}`;
    if (!c.length) return res.status(404).json({ error: "Identifiant OM du client introuvable." });
    if (c[0].user_id === req.user.userId) return res.status(400).json({ error: "Vous ne pouvez pas vous servir vous-même." });
    const comm = Math.floor((amount * IN_BPS()) / 10000), r = ref("OMC"), agent = req.user.userId, client = c[0].user_id;
    const out = await sql()`
      WITH a AS (UPDATE omnicash_agents SET float_xof = float_xof - ${amount} + ${comm} WHERE user_id = ${agent}::uuid AND status = 'active' AND float_xof >= ${amount}
                   AND EXISTS (SELECT 1 FROM wallets WHERE user_id = ${client}::uuid) RETURNING user_id, float_xof),
      w AS (UPDATE wallets SET balance = balance + ${amount}, updated_at = now() FROM a WHERE wallets.user_id = ${client}::uuid RETURNING wallets.id AS wid, wallets.balance AS bal),
      t AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key, metadata)
            SELECT w.wid, 'deposit', ${amount}, w.bal, 'completed', 'omnicash', ${r}, ${"omc-" + r}, ${JSON.stringify({ agent, kind: "cashin" })}::jsonb FROM w RETURNING id),
      o AS (INSERT INTO omnicash_ops (agent_id, client_id, kind, amount, agent_commission, ref) SELECT ${agent}::uuid, ${client}::uuid, 'cashin', ${amount}, ${comm}, ${r} FROM w RETURNING id)
      SELECT (SELECT count(*) FROM t)::int AS n, (SELECT float_xof FROM a)::float AS float`;
    if (out[0]?.n !== 1) return res.status(400).json({ error: "Trésorerie insuffisante ou compte client indisponible." });
    res.status(201).json({ message: "Dépôt effectué.", ref: r, amount, commission: comm, float: out[0].float });
  } catch (e) { fail(res, e, "OMC_CASHIN"); }
});

// Le client prépare un retrait en espèces et obtient un code à remettre à l'agent.
router.post("/cashout/request", requireAuth, async (req, res) => {
  try {
    await ensure();
    const amount = amountOf(req.body?.amount);
    if (!amount) return res.status(400).json({ error: `Montant entre 100 et ${MAX_OP()} FCFA.` });
    const fee = outFee(amount), q = sql();
    const w = await q`SELECT balance::float AS b FROM wallets WHERE user_id = ${req.user.userId}::uuid`;
    if (!w.length || w[0].b < amount + fee) return res.status(400).json({ error: `Solde insuffisant (montant + ${fee} FCFA de frais).` });
    await q`UPDATE omnicash_cashout_requests SET status = 'cancelled' WHERE client_id = ${req.user.userId}::uuid AND status = 'pending'`;
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0"), id = crypto.randomUUID();
    await q`INSERT INTO omnicash_cashout_requests (id, client_id, amount, code_hash, expires_at) VALUES (${id}::uuid, ${req.user.userId}::uuid, ${amount}, ${hashCode(id, code)}, now() + make_interval(mins => ${CODE_TTL_MIN}::int))`;
    res.status(201).json({ code, amount, fee, total: amount + fee, expiresInMinutes: CODE_TTL_MIN });
  } catch (e) { fail(res, e, "OMC_COREQ"); }
});

// L'agent saisit l'identifiant OM du client + son code : retrait exécuté, espèces à remettre.
router.post("/cashout", requireAuth, needAgent, async (req, res) => {
  try {
    const omCode = clean(req.body?.client, 20).toUpperCase().replace(/\s/g, ""), code = clean(req.body?.code, 6);
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "Code à 6 chiffres requis." });
    const q = sql(), agent = req.user.userId;
    const c = await q`SELECT user_id FROM account_ids WHERE code = ${omCode}`;
    if (!c.length || c[0].user_id === agent) return res.status(404).json({ error: "Identifiant OM du client introuvable." });
    const client = c[0].user_id;
    const rq = await q`SELECT id, amount::float AS amount, code_hash, attempts FROM omnicash_cashout_requests WHERE client_id = ${client}::uuid AND status = 'pending' AND expires_at > now() ORDER BY created_at DESC LIMIT 1`;
    if (!rq.length) return res.status(404).json({ error: "Aucune demande de retrait valide pour ce client (code expiré ?)." });
    const row = rq[0];
    if (hashCode(row.id, code) !== row.code_hash) {
      await q`UPDATE omnicash_cashout_requests SET attempts = attempts + 1, status = CASE WHEN attempts + 1 >= ${MAX_TRIES} THEN 'cancelled' ELSE status END WHERE id = ${row.id}::uuid`;
      return res.status(400).json({ error: "Code incorrect." });
    }
    const amount = row.amount, fee = outFee(amount), comm = Math.floor((fee * SHARE()) / 100), r = ref("OMC");
    const out = await q`
      WITH rq AS (UPDATE omnicash_cashout_requests SET status = 'used' WHERE id = ${row.id}::uuid AND status = 'pending' AND expires_at > now() AND amount = ${amount}
                    AND EXISTS (SELECT 1 FROM wallets WHERE user_id = ${client}::uuid AND balance >= ${amount + fee})
                    AND EXISTS (SELECT 1 FROM omnicash_agents WHERE user_id = ${agent}::uuid AND status = 'active') RETURNING id),
      w AS (UPDATE wallets SET balance = balance - ${amount + fee}, updated_at = now() FROM rq WHERE wallets.user_id = ${client}::uuid RETURNING wallets.id AS wid, wallets.balance AS bal),
      a AS (UPDATE omnicash_agents SET float_xof = float_xof + ${amount + comm} FROM w WHERE omnicash_agents.user_id = ${agent}::uuid RETURNING omnicash_agents.float_xof AS fl),
      t1 AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key, metadata)
             SELECT w.wid, 'withdrawal', ${amount}, w.bal + ${fee}, 'completed', 'omnicash', ${r}, ${"omc-" + r}, ${JSON.stringify({ agent, kind: "cashout" })}::jsonb FROM w RETURNING id),
      t2 AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, idempotency_key)
             SELECT w.wid, 'commission', ${fee}, w.bal, 'completed', 'internal', ${"omc-" + r + "-fee"} FROM w WHERE ${fee} > 0 RETURNING id),
      o AS (INSERT INTO omnicash_ops (agent_id, client_id, kind, amount, fee, agent_commission, ref) SELECT ${agent}::uuid, ${client}::uuid, 'cashout', ${amount}, ${fee}, ${comm}, ${r} FROM w RETURNING id)
      SELECT (SELECT count(*) FROM t1)::int AS n, (SELECT fl FROM a)::float AS float`;
    if (out[0]?.n !== 1) return res.status(409).json({ error: "Retrait impossible (solde client insuffisant ou demande déjà utilisée)." });
    res.status(201).json({ message: `Remettez ${amount} FCFA en espèces au client.`, ref: r, amount, fee, commission: comm, float: out[0].float });
  } catch (e) { fail(res, e, "OMC_CASHOUT"); }
});

// Recharge de trésorerie depuis le portefeuille de l'agent (une seule requête atomique). Aussi utilisée par le dépôt MoMo automatique (routes/momo.js).
async function floatLoad(agent, amount) {
  await ensure();
  const r = ref("OMF");
  const out = await sql()`
    WITH a AS (UPDATE omnicash_agents SET float_xof = float_xof + ${amount} WHERE user_id = ${agent}::uuid AND status = 'active'
                 AND (float_limit = 0 OR float_xof + ${amount} <= float_limit)
                 AND EXISTS (SELECT 1 FROM wallets WHERE user_id = ${agent}::uuid AND balance >= ${amount}) RETURNING user_id, float_xof),
    w AS (UPDATE wallets SET balance = balance - ${amount}, updated_at = now() FROM a WHERE wallets.user_id = ${agent}::uuid RETURNING wallets.id AS wid, wallets.balance AS bal),
    t AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key, metadata)
          SELECT w.wid, 'transfer_out', ${amount}, w.bal, 'completed', 'internal', ${r}, ${"omc-" + r}, ${JSON.stringify({ kind: "float_load" })}::jsonb FROM w RETURNING id),
    o AS (INSERT INTO omnicash_ops (agent_id, kind, amount, ref) SELECT ${agent}::uuid, 'float_load', ${amount}, ${r} FROM w RETURNING id)
    SELECT (SELECT count(*) FROM t)::int AS n, (SELECT float_xof FROM a)::float AS float`;
  return out[0]?.n === 1 ? { ok: true, float: out[0].float, ref: r } : { ok: false };
}
router.floatLoad = floatLoad;

router.post("/float/load", requireAuth, needAgent, async (req, res) => {
  try {
    const amount = amountOf(req.body?.amount);
    if (!amount) return res.status(400).json({ error: `Montant entre 100 et ${MAX_OP()} FCFA.` });
    const r = await floatLoad(req.user.userId, amount);
    if (!r.ok) return res.status(400).json({ error: "Solde insuffisant ou plafond de trésorerie dépassé." });
    res.status(201).json({ message: "Trésorerie rechargée.", float: r.float });
  } catch (e) { fail(res, e, "OMC_FLOAD"); }
});

router.post("/float/unload", requireAuth, needAgent, async (req, res) => {
  try {
    const amount = amountOf(req.body?.amount), agent = req.user.userId, r = ref("OMF");
    if (!amount) return res.status(400).json({ error: `Montant entre 100 et ${MAX_OP()} FCFA.` });
    const out = await sql()`
      WITH a AS (UPDATE omnicash_agents SET float_xof = float_xof - ${amount} WHERE user_id = ${agent}::uuid AND status = 'active' AND float_xof >= ${amount}
                   AND EXISTS (SELECT 1 FROM wallets WHERE user_id = ${agent}::uuid) RETURNING user_id, float_xof),
      w AS (UPDATE wallets SET balance = balance + ${amount}, updated_at = now() FROM a WHERE wallets.user_id = ${agent}::uuid RETURNING wallets.id AS wid, wallets.balance AS bal),
      t AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key, metadata)
            SELECT w.wid, 'transfer_in', ${amount}, w.bal, 'completed', 'internal', ${r}, ${"omc-" + r}, ${JSON.stringify({ kind: "float_unload" })}::jsonb FROM w RETURNING id),
      o AS (INSERT INTO omnicash_ops (agent_id, kind, amount, ref) SELECT ${agent}::uuid, 'float_unload', ${amount}, ${r} FROM w RETURNING id)
      SELECT (SELECT count(*) FROM t)::int AS n, (SELECT float_xof FROM a)::float AS float`;
    if (out[0]?.n !== 1) return res.status(400).json({ error: "Trésorerie insuffisante." });
    res.status(201).json({ message: "Montant reversé sur votre portefeuille.", float: out[0].float });
  } catch (e) { fail(res, e, "OMC_FUNLOAD"); }
});

// ================= Admin (OMNICHECK) =================
router.get("/admin/agents", adminOnly, async (req, res) => {
  try {
    await ensure();
    const rows = await sql()`
      SELECT a.user_id AS id, u.email, a.name, a.city, a.status, a.float_xof::float AS float, a.float_limit::float AS "limit", a.created_at,
        coalesce((SELECT sum(amount) FROM omnicash_ops o WHERE o.agent_id = a.user_id AND o.kind = 'cashin' AND o.created_at > now() - interval '24 hours'), 0)::float AS cashin24,
        coalesce((SELECT sum(amount) FROM omnicash_ops o WHERE o.agent_id = a.user_id AND o.kind = 'cashout' AND o.created_at > now() - interval '24 hours'), 0)::float AS cashout24,
        coalesce((SELECT sum(agent_commission) FROM omnicash_ops o WHERE o.agent_id = a.user_id), 0)::float AS commissions
      FROM omnicash_agents a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.status = 'pending' DESC, a.float_xof DESC`;
    res.json({ agents: rows });
  } catch (e) { fail(res, e, "OMC_ALIST"); }
});

const setStatus = (status) => async (req, res) => {
  try {
    await ensure();
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    const limit = req.body?.floatLimit != null ? Math.max(0, Math.floor(Number(req.body.floatLimit)) || 0) : null;
    const r = await sql()`UPDATE omnicash_agents SET status = ${status}, float_limit = coalesce(${limit}::numeric, float_limit) WHERE user_id = ${req.params.id}::uuid RETURNING user_id`;
    if (!r.length) return res.status(404).json({ error: "Agent introuvable." });
    res.json({ message: "Statut mis à jour : " + status });
  } catch (e) { fail(res, e, "OMC_STATUS"); }
};
router.post("/admin/agents/:id/approve", adminOnly, setStatus("active"));
router.post("/admin/agents/:id/suspend", adminOnly, setStatus("suspended"));

// Chargement (montant > 0) ou retrait (montant < 0) de trésorerie, après réception / remise de l'argent réel. Référence bancaire obligatoire.
router.post("/admin/agents/:id/float", adminOnly, async (req, res) => {
  try {
    await ensure();
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    const amount = Math.trunc(Number(req.body?.amount)), note = clean(req.body?.note, 200);
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 50000000) return res.status(400).json({ error: "Montant invalide." });
    if (note.length < 4) return res.status(400).json({ error: "Indiquez la référence du virement ou du reçu (obligatoire)." });
    const r = ref("OMA");
    const out = await sql()`
      WITH a AS (UPDATE omnicash_agents SET float_xof = float_xof + ${amount} WHERE user_id = ${req.params.id}::uuid AND float_xof + ${amount} >= 0
                   AND (${amount} < 0 OR float_limit = 0 OR float_xof + ${amount} <= float_limit) RETURNING user_id, float_xof),
      o AS (INSERT INTO omnicash_ops (agent_id, kind, amount, ref, note) SELECT a.user_id, 'float_admin', ${amount}, ${r}, ${note} FROM a RETURNING id)
      SELECT (SELECT float_xof FROM a)::float AS float, (SELECT count(*) FROM o)::int AS n`;
    if (out[0]?.n !== 1) return res.status(400).json({ error: "Refusé : agent introuvable, float négatif ou plafond dépassé." });
    res.json({ message: "Trésorerie mise à jour.", ref: r, float: out[0].float });
  } catch (e) { fail(res, e, "OMC_AFLOAT"); }
});

// Vue trésorerie : tout ce qui est dû (clients + agents) face aux fonds réels déclarés (ledger).
router.get("/admin/treasury", adminOnly, async (req, res) => {
  try {
    await ensure();
    const q = sql();
    const t = (await q`SELECT
        (SELECT coalesce(sum(float_xof),0) FROM omnicash_agents)::float AS agents_float,
        (SELECT coalesce(sum(balance),0) FROM wallets)::float AS clients,
        (SELECT count(*) FROM omnicash_agents WHERE status = 'active')::int AS active,
        (SELECT count(*) FROM omnicash_agents WHERE status = 'pending')::int AS pending,
        coalesce((SELECT sum(amount) FROM omnicash_ops WHERE kind = 'cashin' AND created_at > now() - interval '24 hours'),0)::float AS cashin24,
        coalesce((SELECT sum(amount) FROM omnicash_ops WHERE kind = 'cashout' AND created_at > now() - interval '24 hours'),0)::float AS cashout24,
        coalesce((SELECT sum(agent_commission) FROM omnicash_ops),0)::float AS commissions_agents,
        coalesce((SELECT sum(fee) FROM omnicash_ops),0)::float AS fees`)[0];
    let held = null;
    try { const c = await q`SELECT coalesce(sum(b.balance_xof),0)::float AS v FROM fund_accounts f LEFT JOIN LATERAL (SELECT balance_xof FROM fund_balances WHERE code = f.code ORDER BY id DESC LIMIT 1) b ON true WHERE f.active`; held = c[0].v; } catch (_) { held = null; }
    const due = t.clients + t.agents_float;
    const alerts = [];
    if (held === null || held === 0) alerts.push("Aucun solde de fonds réels déclaré : déclarez vos comptes (Fonds réels & couverture).");
    else if (held < due) alerts.push(`Couverture insuffisante : fonds déclarés ${Math.round(held)} F pour ${Math.round(due)} F dus (clients + agents).`);
    const low = await q`SELECT name, city, float_xof::float AS f FROM omnicash_agents WHERE status = 'active' AND float_xof < 20000`;
    for (const a of low) alerts.push(`Agent « ${a.name} » (${a.city}) : trésorerie basse (${Math.round(a.f)} F).`);
    const sus = await q`SELECT name FROM omnicash_agents WHERE status = 'suspended' AND float_xof > 0`;
    for (const a of sus) alerts.push(`Agent suspendu « ${a.name} » détient encore de la trésorerie : à régulariser.`);
    res.json({ ...t, due, held, coverage: held && due > 0 ? held / due : null, alerts, status: alerts.length ? "ATTENTION" : "OK" });
  } catch (e) { fail(res, e, "OMC_TREAS"); }
});

module.exports = router;
