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
  { id: "first_withdrawal", title: "Premier retrait", desc: "Retirez de l'argent vers votre Mobile Money.", metric: "withdrawals_all", target: 1, points: 50, unit: "retrait" },
  { id: "ops_5", title: "5 opérations ce mois", desc: "Dépôts, envois, réceptions ou retraits terminés.", metric: "ops_month", target: 5, points: 100, unit: "opérations" },
  { id: "sent_3", title: "3 envois ce mois", desc: "Envoyez de l'argent à 3 reprises.", metric: "sent_month", target: 3, points: 100, unit: "envois" },
  { id: "recv_2", title: "2 réceptions ce mois", desc: "Recevez de l'argent de 2 opérations différentes.", metric: "recv_month", target: 2, points: 100, unit: "réceptions" },
  { id: "crypto_deposit", title: "Dépôt crypto validé", desc: "Un dépôt en crypto (USDT…) vérifié et crédité par OMNIPAY.", metric: "crypto_deposits", target: 1, points: 100, unit: "dépôt" },
  { id: "vol_50k", title: "50 000 F échangés ce mois", desc: "Volume cumulé de vos opérations terminées.", metric: "volume_month", target: 50000, points: 150, unit: "FCFA" },
  { id: "ops_15", title: "15 opérations ce mois", desc: "Un mois très actif.", metric: "ops_month", target: 15, points: 200, unit: "opérations" },
  { id: "vol_200k", title: "200 000 F échangés ce mois", desc: "Gros volume cumulé sur le mois.", metric: "volume_month", target: 200000, points: 250, unit: "FCFA" },
];
const LEVELS = [{ name: "Bronze", at: 0 }, { name: "Argent", at: 150 }, { name: "Or", at: 400 }, { name: "Platine", at: 800 }];
const levelOf = (p) => { let i = 0; LEVELS.forEach((l, k) => { if (p >= l.at) i = k; }); return { name: LEVELS[i].name, next: LEVELS[i + 1] ? LEVELS[i + 1].at : null }; };

async function metrics(userId) {
  const q = sql();
  const m = (await q`SELECT
      count(*) FILTER (WHERE t.type = 'deposit' AND t.status = 'completed')::int AS deposits_all,
      count(*) FILTER (WHERE t.type = 'withdrawal' AND t.status = 'completed')::int AS withdrawals_all,
      count(*) FILTER (WHERE t.type IN ('deposit','withdrawal','transfer_in','transfer_out') AND t.status = 'completed' AND t.created_at >= date_trunc('month', now()))::int AS ops_month,
      count(*) FILTER (WHERE t.type = 'transfer_out' AND t.status = 'completed' AND t.created_at >= date_trunc('month', now()))::int AS sent_month,
      count(*) FILTER (WHERE t.type = 'transfer_in' AND t.status = 'completed' AND t.created_at >= date_trunc('month', now()))::int AS recv_month,
      coalesce(sum(t.amount) FILTER (WHERE t.type IN ('deposit','withdrawal','transfer_in','transfer_out') AND t.status = 'completed' AND t.created_at >= date_trunc('month', now())), 0)::float AS volume_month
    FROM wallets w LEFT JOIN transactions t ON t.wallet_id = w.id WHERE w.user_id = ${userId}::uuid`)[0] || {};
  let linked = 0, crypto = 0;
  try { linked = (await q`SELECT count(*)::int AS n FROM linked_accounts WHERE user_id = ${userId}::uuid AND status <> 'removed'`)[0].n; } catch (_) { /* table pas encore créée */ }
  try { crypto = (await q`SELECT count(*)::int AS n FROM manual_deposits WHERE user_id = ${userId}::uuid AND status = 'credited' AND currency IN ('USDT','BTC','ETH')`)[0].n; } catch (_) { /* table pas encore créée */ }
  return { deposits_all: m.deposits_all || 0, withdrawals_all: m.withdrawals_all || 0, ops_month: m.ops_month || 0, sent_month: m.sent_month || 0, recv_month: m.recv_month || 0, volume_month: m.volume_month || 0, linked, crypto_deposits: crypto };
}

// Activité des 6 dernières semaines (opérations terminées par semaine) pour le graphique en barres.
async function weekly(userId) {
  try {
    const rows = await sql()`SELECT date_trunc('week', t.created_at)::date::text AS wk, count(*)::int AS n, coalesce(sum(t.amount), 0)::float AS vol
      FROM wallets w JOIN transactions t ON t.wallet_id = w.id
      WHERE w.user_id = ${userId}::uuid AND t.status = 'completed' AND t.type IN ('deposit','withdrawal','transfer_in','transfer_out') AND t.created_at >= date_trunc('week', now()) - interval '5 weeks'
      GROUP BY 1 ORDER BY 1`;
    const map = new Map(rows.map((r) => [r.wk, r])), out = [];
    const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // lundi de la semaine courante
    for (let i = 5; i >= 0; i--) { const x = new Date(d); x.setUTCDate(x.getUTCDate() - 7 * i); const k = x.toISOString().slice(0, 10), r = map.get(k); out.push({ week: k, ops: r ? r.n : 0, volume: r ? r.vol : 0 }); }
    return out;
  } catch (_) { return []; }
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const m = await metrics(req.user.userId), wk = await weekly(req.user.userId);
    const challenges = DEFS.map((d) => { const v = m[d.metric] || 0; return { id: d.id, title: d.title, desc: d.desc, unit: d.unit, points: d.points, target: d.target, value: Math.min(v, d.target), done: v >= d.target }; });
    const points = challenges.filter((c) => c.done).reduce((s, c) => s + c.points, 0);
    const lv = levelOf(points);
    res.json({ challenges, points, level: lv.name, nextLevelAt: lv.next, levels: LEVELS, totalPoints: DEFS.reduce((a, d) => a + d.points, 0), weekly: wk, note: "Points de fidélité : aucune valeur monétaire pour l'instant." });
  } catch (e) { console.error("CHALLENGES", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;
module.exports.DEFS = DEFS;
