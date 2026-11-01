"use strict";
// OMNIPAY — DÉFIS du client. Chaque défi est calculé à partir des opérations RÉELLES terminées (aucun compteur déclaratif, aucune triche possible côté client).
// Les points sont des points de fidélité sans valeur monétaire : aucune somme n'est versée automatiquement.
// GET /api/challenges → défis, progression, points, niveau
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");
const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);

const DEFS = [
  { id: "first_deposit", title: "Premier dépôt", desc: "Alimentez votre compte une première fois.", metric: "deposits_all", target: 1, points: 50, unit: "dépôt" },
  { id: "link_account", title: "Compte relié", desc: "Reliez un compte (Mobile Money, banque, crypto).", metric: "linked", target: 1, points: 50, unit: "compte" },
  { id: "ops_5", title: "5 opérations ce mois", desc: "Dépôts, envois, réceptions ou retraits terminés.", metric: "ops_month", target: 5, points: 100, unit: "opérations" },
  { id: "sent_3", title: "3 envois ce mois", desc: "Envoyez de l'argent à 3 reprises.", metric: "sent_month", target: 3, points: 100, unit: "envois" },
  { id: "vol_50k", title: "50 000 F échangés ce mois", desc: "Volume cumulé de vos opérations terminées.", metric: "volume_month", target: 50000, points: 150, unit: "FCFA" },
];
const levelOf = (p) => (p >= 350 ? { name: "Or", next: null } : p >= 150 ? { name: "Argent", next: 350 } : { name: "Bronze", next: 150 });

async function metrics(userId) {
  const q = sql();
  const m = (await q`SELECT
      count(*) FILTER (WHERE t.type = 'deposit' AND t.status = 'completed')::int AS deposits_all,
      count(*) FILTER (WHERE t.type IN ('deposit','withdrawal','transfer_in','transfer_out') AND t.status = 'completed' AND t.created_at >= date_trunc('month', now()))::int AS ops_month,
      count(*) FILTER (WHERE t.type = 'transfer_out' AND t.status = 'completed' AND t.created_at >= date_trunc('month', now()))::int AS sent_month,
      coalesce(sum(t.amount) FILTER (WHERE t.type IN ('deposit','withdrawal','transfer_in','transfer_out') AND t.status = 'completed' AND t.created_at >= date_trunc('month', now())), 0)::float AS volume_month
    FROM wallets w LEFT JOIN transactions t ON t.wallet_id = w.id WHERE w.user_id = ${userId}::uuid`)[0] || {};
  let linked = 0;
  try { linked = (await q`SELECT count(*)::int AS n FROM linked_accounts WHERE user_id = ${userId}::uuid AND status <> 'removed'`)[0].n; } catch (_) { /* table pas encore créée */ }
  return { deposits_all: m.deposits_all || 0, ops_month: m.ops_month || 0, sent_month: m.sent_month || 0, volume_month: m.volume_month || 0, linked };
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const m = await metrics(req.user.userId);
    const challenges = DEFS.map((d) => { const v = m[d.metric] || 0; return { id: d.id, title: d.title, desc: d.desc, unit: d.unit, points: d.points, target: d.target, value: Math.min(v, d.target), done: v >= d.target }; });
    const points = challenges.filter((c) => c.done).reduce((s, c) => s + c.points, 0);
    const lv = levelOf(points);
    res.json({ challenges, points, level: lv.name, nextLevelAt: lv.next, note: "Points de fidélité : aucune valeur monétaire pour l'instant." });
  } catch (e) { console.error("CHALLENGES", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;
module.exports.DEFS = DEFS;
