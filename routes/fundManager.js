"use strict";
// OMNIPAY — gestionnaire de fonds & risque (admin, lecture + simulation + réglage des seuils). Ne déplace jamais d'argent.
// GET  /api/fund/overview            → santé, couverture, canaux, alertes
// POST /api/fund/route               → { operator, amountXof } voie recommandée + explications
// GET  /api/fund/queue               → retraits en attente avec la voie recommandée pour chacun
// GET  /api/fund/rebalance           → plan de rééquilibrage indicatif
// GET/POST /api/fund/policy          → seuils (couverture minimale, concentration, exposition crypto…)
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const fm = require("../lib/fundManager.js");
const router = express.Router();

function adminOnly(req, res, next) {
  const provided = Buffer.from(String(req.headers["x-admin-key"] || ""));
  const expected = Buffer.from(String(process.env.ADMIN_KEY || ""));
  if (!expected.length || provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return res.status(403).json({ error: "Accès refusé." });
  next();
}
router.use(adminOnly);
const fail = (res, tag, e) => { console.error(tag, e.message); res.status(500).json({ error: "Erreur serveur." }); };

router.get("/overview", async (req, res) => {
  try { const [state, policy] = [await fm.loadState(), await fm.getPolicy()]; res.json({ policy, ...fm.assess(state, policy), generatedAt: new Date().toISOString(), mode: process.env.FUND_ROUTER || "off" }); }
  catch (e) { fail(res, "FUND_OVERVIEW", e); }
});

router.post("/route", async (req, res) => {
  try {
    const [state, policy] = [await fm.loadState(), await fm.getPolicy()];
    res.json(fm.chooseRoute(state, { operator: req.body?.operator, amount: req.body?.amountXof }, policy));
  } catch (e) { fail(res, "FUND_ROUTE", e); }
});

router.get("/queue", async (req, res) => {
  try {
    const q = neon(process.env.DATABASE_URL);
    const [state, policy] = [await fm.loadState(), await fm.getPolicy()];
    const rows = await q`SELECT id, provider AS operator, amount::float AS amount, created_at FROM transactions WHERE type = 'withdrawal' AND status = 'pending' ORDER BY created_at LIMIT 50`;
    // Les décisions sont prises en séquence : la liquidité d'un canal se réduit à mesure qu'on lui affecte des retraits.
    const funds = state.funds.map((f) => ({ ...f }));
    const items = rows.map((r) => {
      const d = fm.chooseRoute({ ...state, funds }, { operator: r.operator, amount: r.amount }, policy);
      if (d.ok) { const f = funds.find((x) => x.code === d.choice.code); if (f && f.balance != null) f.balance -= r.amount; }
      return { id: r.id, operator: r.operator, amount: r.amount, createdAt: r.created_at, ok: d.ok, hard: d.hard, route: d.choice ? { code: d.choice.code, label: d.choice.label, score: d.choice.score } : null, reasons: d.reasons };
    });
    res.json({ items });
  } catch (e) { fail(res, "FUND_QUEUE", e); }
});

router.get("/rebalance", async (req, res) => {
  try { const [state, policy] = [await fm.loadState(), await fm.getPolicy()]; res.json(fm.rebalance(state, policy)); }
  catch (e) { fail(res, "FUND_REBAL", e); }
});

router.get("/policy", async (req, res) => { try { res.json({ policy: await fm.getPolicy(), defaults: fm.DEFAULT_POLICY }); } catch (e) { fail(res, "FUND_POLICY", e); } });
router.post("/policy", async (req, res) => {
  try { res.json({ policy: await fm.setPolicy(req.body || {}) }); }
  catch (e) { if (/hors limites|bufferRatio/.test(e.message)) return res.status(400).json({ error: e.message }); fail(res, "FUND_POLICY_SET", e); }
});

module.exports = router;
