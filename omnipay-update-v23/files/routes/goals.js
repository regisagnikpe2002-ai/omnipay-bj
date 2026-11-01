"use strict";
// OMNIPAY — OBJECTIF DU MOIS (admin). Compare un objectif que VOUS fixez (par défaut 1 000 000 FCFA) aux chiffres RÉELS du mois, et en tire une projection
// fondée sur le rythme actuel. L'objectif n'est jamais présenté comme un résultat : « projection » = réalisé ÷ jours écoulés × jours du mois.
// GET  /api/goals/month → { target, metric, actual, projection, onTrack, series… }      metric = 'commissions' (revenus OMNIPAY) | 'volume' (FCFA échangés)
// POST /api/goals/month → { targetXof?, metric? }
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);

function adminOnly(req, res, next) {
  const provided = Buffer.from(String(req.headers["x-admin-key"] || "")), expected = Buffer.from(String(process.env.ADMIN_KEY || ""));
  if (!expected.length || provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return res.status(403).json({ error: "Accès refusé." });
  next();
}
router.use(adminOnly);

let ready = null;
const ensure = () => (ready = ready || sql()`CREATE TABLE IF NOT EXISTS goals (key varchar(30) PRIMARY KEY, value varchar(60) NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`.catch((e) => { ready = null; throw e; }));
async function settings() {
  await ensure();
  const rows = await sql()`SELECT key, value FROM goals`;
  const g = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const target = Number(g.month_target || process.env.MONTH_TARGET_XOF || 1000000);
  return { target: Number.isFinite(target) && target > 0 ? target : 1000000, metric: g.month_metric === "volume" ? "volume" : "commissions" };
}

// Fonction pure (testée) : projection linéaire sur le mois.
function project({ actual, day, daysInMonth, target }) {
  const pace = day > 0 ? actual / day : 0;
  const projection = Math.round(pace * daysInMonth);
  const expectedNow = (target / daysInMonth) * day;
  return { pace: Math.round(pace), projection, expectedNow: Math.round(expectedNow), onTrack: actual >= expectedNow, early: day < 3, remaining: Math.max(0, target - actual), perDayNeeded: daysInMonth - day > 0 ? Math.ceil(Math.max(0, target - actual) / (daysInMonth - day)) : 0 };
}

router.get("/month", async (req, res) => {
  try {
    const s = await settings(), q = sql();
    const now = new Date(), day = now.getUTCDate(), daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const rows = await q`SELECT to_char(date_trunc('day', created_at), 'DD') AS d,
        coalesce(sum(amount) FILTER (WHERE type = 'commission' AND status = 'completed'), 0)::float AS commissions,
        coalesce(sum(amount) FILTER (WHERE type IN ('deposit','withdrawal','transfer_out') AND status = 'completed'), 0)::float AS volume
      FROM transactions WHERE created_at >= date_trunc('month', now()) GROUP BY 1 ORDER BY 1`;
    const key = s.metric === "volume" ? "volume" : "commissions";
    const actual = rows.reduce((a, r) => a + r[key], 0);
    const series = []; let cum = 0;
    for (let d = 1; d <= day; d++) { const r = rows.find((x) => Number(x.d) === d); cum += r ? r[key] : 0; series.push({ day: d, cumulative: Math.round(cum) }); }
    res.json({ metric: s.metric, target: s.target, actual: Math.round(actual), progress: Math.min(1, actual / s.target), day, daysInMonth, ...project({ actual, day, daysInMonth, target: s.target }), series,
      note: "La projection est calculée à partir du rythme réel du mois ; l'objectif est une cible, pas un résultat." });
  } catch (e) { console.error("GOALS", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/month", async (req, res) => {
  try {
    await ensure();
    const q = sql(), b = req.body || {};
    if (b.targetXof != null && b.targetXof !== "") {
      const v = Number(b.targetXof);
      if (!Number.isFinite(v) || v < 1000 || v > 1e12) return res.status(400).json({ error: "Objectif invalide (1 000 à 1 000 000 000 000 FCFA)." });
      await q`INSERT INTO goals (key, value) VALUES ('month_target', ${String(Math.round(v))}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    }
    if (b.metric != null) {
      if (!["commissions", "volume"].includes(b.metric)) return res.status(400).json({ error: "Mesure invalide (commissions ou volume)." });
      await q`INSERT INTO goals (key, value) VALUES ('month_metric', ${b.metric}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    }
    res.json({ ...(await settings()) });
  } catch (e) { console.error("GOALS_SET", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;
module.exports.project = project;
