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

module.exports = router;
