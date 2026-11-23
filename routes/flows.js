"use strict";
// OMNIPAY — SUIVI AUTOMATIQUE DES ENTRÉES / SORTIES. FICHIER AJOUTÉ.
// GET /api/flows?days=7|30|90   entrées et sorties du client par jour (ou par semaine sur 90 jours), totaux, solde net, répartition par catégorie.
// Calculé à la demande depuis les opérations réelles : rien à saisir, il se met à jour après chaque opération.
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);

const IN = new Set(["deposit", "transfer_in", "refund"]);
const LABEL_IN = { deposit: "Dépôts", transfer_in: "Reçus", refund: "Remboursements" };
function catOut(type, provider) {
  const p = String(provider || "").toLowerCase();
  if (type === "commission") return "Frais";
  if (type === "transfer_out" || type === "transfer") return "Transferts";
  if (p === "bundle") return "Recharges";
  if (p === "virtualnum") return "Numéros virtuels";
  if (p === "omnichange") return "Crypto";
  if (p === "subscription" || p === "omnipro") return "Abonnement";
  if (p === "business") return "Paiements";
  if (p === "omnicash") return "Retraits espèces";
  return "Retraits";
}
const catIn = (type, provider) => (String(provider || "").toLowerCase() === "omnichange" ? "Crypto vendue" : LABEL_IN[type] || "Autres entrées");
const day = (d) => new Date(d).toISOString().slice(0, 10);

router.get("/", requireAuth, async (req, res) => {
  try {
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const q = sql();
    const rows = await q`SELECT t.type, t.provider, t.amount::float AS amount, t.created_at FROM transactions t JOIN wallets w ON w.id = t.wallet_id
      WHERE w.user_id = ${req.user.userId}::uuid AND t.status IN ('completed','pending','processing','success') AND t.created_at >= now() - make_interval(days => ${days * 2}::int) AND t.amount > 0`;
    const now = Date.now(), DAY = 864e5, cut = now - days * DAY, prevCut = now - 2 * days * DAY;
    const weekly = days === 90, step = weekly ? 7 : 1, n = Math.ceil(days / step);
    const series = []; for (let i = n - 1; i >= 0; i--) series.push({ date: day(now - i * step * DAY), in: 0, out: 0 });
    const catsIn = {}, catsOut = {}; let tin = 0, tout = 0, pin = 0, pout = 0;
    for (const r of rows) {
      const ts = new Date(r.created_at).getTime(), a = Number(r.amount), isIn = IN.has(r.type) || (r.type === "sale" && false);
      if (ts < cut) { if (ts >= prevCut) { if (isIn) pin += a; else pout += a; } continue; }
      const age = Math.floor((now - ts) / DAY), idx = n - 1 - Math.floor(age / step);
      if (idx < 0 || idx >= n) continue;
      if (isIn) { series[idx].in += a; tin += a; const c = catIn(r.type, r.provider); catsIn[c] = (catsIn[c] || 0) + a; }
      else { series[idx].out += a; tout += a; const c = catOut(r.type, r.provider); catsOut[c] = (catsOut[c] || 0) + a; }
    }
    const list = (o) => Object.entries(o).map(([label, amount]) => ({ label, amount: Math.round(amount) })).sort((a, b) => b.amount - a.amount);
    const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null);
    res.json({ days, step: weekly ? "week" : "day", series: series.map((s) => ({ date: s.date, in: Math.round(s.in), out: Math.round(s.out) })),
      totals: { in: Math.round(tin), out: Math.round(tout), net: Math.round(tin - tout) }, previous: { in: Math.round(pin), out: Math.round(pout), inPct: pct(tin, pin), outPct: pct(tout, pout) },
      categories: { in: list(catsIn), out: list(catsOut) } });
  } catch (e) { console.error("FLOWS", e.message); res.status(500).json({ error: "Erreur." }); }
});

// Comptes Mobile Money suivis : pour chaque opérateur, ce qui est ENTRÉ et SORTI par OMNIPAY. Ce n'est PAS le solde réel du compte Mobile Money
// (OMNIPAY n'a aucun accès à ces comptes) : c'est le suivi des mouvements passés par OMNIPAY, calculé depuis les opérations réelles.
const OPS = [["mtn", "MTN MoMo"], ["moov", "Moov Money"], ["celtiis", "Celtiis Cash"]];
router.get("/operators", requireAuth, async (req, res) => {
  try {
    const q = sql(), uid = req.user.userId;
    const rows = await q`SELECT CASE WHEN t.type = 'deposit' THEN lower(coalesce(t.metadata->>'provider','')) ELSE lower(t.provider) END AS op, t.type,
        sum(t.amount)::float AS amount, count(*)::int AS n, max(t.created_at) AS last_at
      FROM transactions t JOIN wallets w ON w.id = t.wallet_id
      WHERE w.user_id = ${uid}::uuid AND t.amount > 0 AND (
        (t.type = 'deposit' AND t.provider = 'fedapay' AND t.status = 'completed') OR
        (t.type = 'withdrawal' AND t.provider IN ('mtn','moov','celtiis') AND t.status NOT IN ('cancelled','refunded','failed')))
      GROUP BY 1, 2`;
    const phones = {}, state = {};
    try { for (const r of await q`SELECT operator, phone FROM user_operators WHERE user_id = ${uid}::uuid ORDER BY is_default DESC, created_at`) if (!phones[r.operator]) phones[r.operator] = r.phone; } catch (_) { /* table absente */ }
    try { for (const r of await q`SELECT provider, detail, status FROM linked_accounts WHERE user_id = ${uid}::uuid AND kind = 'mobile' AND status IN ('pending','verified')`) {
      const p = String(r.provider || "").toLowerCase(); if (!phones[p]) phones[p] = r.detail; if (state[p] !== "verified") state[p] = r.status; } } catch (_) { /* table absente */ }
    const decl = {};
    try { await q`CREATE TABLE IF NOT EXISTS user_declared_balances (user_id uuid NOT NULL, operator varchar(12) NOT NULL, amount numeric NOT NULL, declared_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, operator))`;
      for (const r of await q`SELECT operator, amount::float AS amount, declared_at FROM user_declared_balances WHERE user_id = ${uid}::uuid`) decl[r.operator] = r; } catch (_) { /* indicatif seulement */ }
    const mask = (p) => { const d = String(p || "").replace(/\D/g, ""); return d.length >= 4 ? "••••" + d.slice(-4) : null; };
    let tin = 0, tout = 0;
    const operators = OPS.map(([op, label]) => {
      let i = 0, o = 0, last = null;
      for (const r of rows) if (r.op === op) { if (r.type === "deposit") i += r.amount; else o += r.amount; if (!last || new Date(r.last_at) > new Date(last)) last = r.last_at; }
      tin += i; tout += o;
      const linked = state[op] || (phones[op] ? "pending" : "none");
      return { operator: op, label, linked, phone: mask(phones[op]), in: Math.round(i), out: Math.round(o), net: Math.round(i - o), lastAt: last, declared: decl[op] ? Math.round(decl[op].amount) : null, declaredAt: decl[op] ? decl[op].declared_at : null };
    });
    res.json({ operators, totals: { in: Math.round(tin), out: Math.round(tout), net: Math.round(tin - tout) } });
  } catch (e) { console.error("FLOWS_OPS", e.message); res.status(500).json({ error: "Erreur." }); }
});

// Solde que le CLIENT déclare avoir sur son compte Mobile Money : purement indicatif, non vérifiable par OMNIPAY, jamais utilisé pour créditer ou débiter.
router.post("/declared", requireAuth, async (req, res) => {
  try {
    const op = String((req.body || {}).operator || "").toLowerCase(), amount = Number((req.body || {}).amount);
    if (!OPS.some((o) => o[0] === op)) return res.status(400).json({ error: "Opérateur invalide." });
    if (!Number.isFinite(amount) || amount < 0 || amount > 100000000) return res.status(400).json({ error: "Montant invalide." });
    const q = sql();
    await q`CREATE TABLE IF NOT EXISTS user_declared_balances (user_id uuid NOT NULL, operator varchar(12) NOT NULL, amount numeric NOT NULL, declared_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, operator))`;
    await q`INSERT INTO user_declared_balances (user_id, operator, amount) VALUES (${req.user.userId}::uuid, ${op}, ${Math.round(amount)}) ON CONFLICT (user_id, operator) DO UPDATE SET amount = EXCLUDED.amount, declared_at = now()`;
    res.json({ ok: true, message: "Solde déclaré enregistré (indicatif)." });
  } catch (e) { console.error("FLOWS_DECL", e.message); res.status(500).json({ error: "Erreur." }); }
});

module.exports = router;
