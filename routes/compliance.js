"use strict";
// OMNIPAY — conformité (fichier AJOUTÉ) : statut KYC, limites par niveau, alertes anti-blanchiment (LAB/FT) à examiner.
// Les alertes sont des SIGNAUX pour l'administrateur : rien n'est bloqué ni déclaré automatiquement.
// Toute déclaration de soupçon à l'autorité compétente reste une décision humaine (à voir avec votre conseil/CENTIF).
const express = require("express");
const { neon } = require("@neondatabase/serverless");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." }));
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
let ready = false;

// Politique (modifiable par variables Render). Valeurs par défaut volontairement larges pour ne pas gêner les clients actuels.
function policy() {
  return {
    unverified: { perTx: num("LIMIT_UNVERIFIED_TX", 200000), perDay: num("LIMIT_UNVERIFIED_DAY", 500000) },
    verified: { perTx: num("LIMIT_VERIFIED_TX", 500000), perDay: num("LIMIT_VERIFIED_DAY", 2000000) },
    approvalXof: num("APPROVAL_XOF", 200000),       // au-delà : jamais d'envoi automatique, validation humaine
    amlThresholdXof: num("AML_THRESHOLD_XOF", 100000),
  };
}
const limitsFor = (kyc) => (kyc === "verified" ? policy().verified : policy().unverified);

async function ensureTables() {
  if (ready) return;
  await sql()`CREATE TABLE IF NOT EXISTS aml_alerts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, rule varchar(20) NOT NULL, detail varchar(300) NOT NULL,
    status varchar(10) NOT NULL DEFAULT 'open', day date NOT NULL DEFAULT current_date, created_at timestamptz NOT NULL DEFAULT now(),
    reviewed_at timestamptz, reviewer_note varchar(300), UNIQUE (user_id, rule, day))`;
  ready = true;
}

// Règles de détection sur les dernières 24 h.
async function scan() {
  await ensureTables();
  const q = sql();
  const T = policy().amlThresholdXof;
  const found = [];
  const add = (rows, rule, fmt) => rows.forEach((r) => found.push({ user_id: r.user_id, rule, detail: fmt(r).slice(0, 300) }));
  // 1) Fractionnement : au moins 3 dépôts réussis juste sous le seuil (entre 80 % et 100 % du seuil)
  add(await q`SELECT w.user_id, count(*)::int AS n, sum(t.amount)::float AS total FROM transactions t JOIN wallets w ON w.id = t.wallet_id
      WHERE t.type = 'deposit' AND t.status = 'completed' AND t.created_at > now() - interval '24 hours' AND t.amount >= ${T * 0.8} AND t.amount < ${T}
      GROUP BY w.user_id HAVING count(*) >= 3`, "STRUCTURING", (r) => `${r.n} dépôts juste sous ${T} FCFA en 24 h (total ${Math.round(r.total)}).`);
  // 2) Rafale : 10 opérations ou plus en 1 heure
  add(await q`SELECT w.user_id, count(*)::int AS n FROM transactions t JOIN wallets w ON w.id = t.wallet_id
      WHERE t.type <> 'commission' AND t.created_at > now() - interval '1 hour' GROUP BY w.user_id HAVING count(*) >= 10`, "VELOCITY", (r) => `${r.n} opérations en 1 heure.`);
  // 3) Passage rapide : dépôt d'au moins 50 000 puis retrait d'au moins 80 % dans l'heure qui suit
  add(await q`SELECT DISTINCT w.user_id, d.amount::float AS dep FROM transactions d JOIN wallets w ON w.id = d.wallet_id
      JOIN transactions x ON x.wallet_id = d.wallet_id AND x.type = 'withdrawal' AND x.status <> 'cancelled' AND x.created_at > d.created_at AND x.created_at <= d.created_at + interval '1 hour' AND x.amount >= d.amount * 0.8
      WHERE d.type = 'deposit' AND d.status = 'completed' AND d.amount >= 50000 AND d.created_at > now() - interval '24 hours'`, "PASSTHRU", (r) => `Dépôt de ${Math.round(r.dep)} FCFA retiré presque aussitôt.`);
  // 4) Montant élevé : opération unique d'au moins 2 fois le seuil
  add(await q`SELECT DISTINCT w.user_id, max(t.amount)::float AS m FROM transactions t JOIN wallets w ON w.id = t.wallet_id
      WHERE t.type IN ('deposit','withdrawal') AND t.status <> 'cancelled' AND t.created_at > now() - interval '24 hours' AND t.amount >= ${T * 2} GROUP BY w.user_id`, "LARGE", (r) => `Opération de ${Math.round(r.m)} FCFA.`);
  // 5) Compte récent (moins de 24 h) avec un volume d'au moins le seuil
  add(await q`SELECT w.user_id, sum(t.amount)::float AS v FROM transactions t JOIN wallets w ON w.id = t.wallet_id JOIN users u ON u.id = w.user_id
      WHERE t.type IN ('deposit','withdrawal') AND t.status <> 'cancelled' AND u.created_at > now() - interval '24 hours' GROUP BY w.user_id HAVING sum(t.amount) >= ${T}`, "NEWBIG", (r) => `Compte de moins de 24 h avec ${Math.round(r.v)} FCFA de volume.`);
  let created = 0;
  for (const f of found) {
    const r = await q`INSERT INTO aml_alerts (user_id, rule, detail) VALUES (${f.user_id}, ${f.rule}, ${f.detail}) ON CONFLICT (user_id, rule, day) DO NOTHING RETURNING id`;
    created += r.length;
  }
  return { scanned: found.length, created };
}

router.use(adminOnly);

router.get("/policy", (req, res) => res.json(policy()));

router.get("/alerts", async (req, res) => {
  try {
    await ensureTables();
    const status = req.query.status === "reviewed" ? "reviewed" : "open";
    const rows = await sql()`SELECT a.id, a.rule, a.detail, a.status, a.created_at, a.reviewer_note, u.email, u.kyc_status
      FROM aml_alerts a LEFT JOIN users u ON u.id = a.user_id WHERE a.status = ${status} ORDER BY a.created_at DESC LIMIT 200`;
    res.json({ alerts: rows });
  } catch (e) { console.error("AML_LIST", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.post("/scan", async (req, res) => {
  try { res.json(await scan()); } catch (e) { console.error("AML_SCAN", e.message); res.status(500).json({ error: "Erreur d'analyse." }); }
});

router.post("/alerts/:id/review", async (req, res) => {
  try {
    await ensureTables();
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    const note = String(req.body?.note || "").replace(/[<>]/g, "").trim().slice(0, 300);
    const r = await sql()`UPDATE aml_alerts SET status = 'reviewed', reviewed_at = now(), reviewer_note = ${note || null} WHERE id = ${req.params.id} AND status = 'open' RETURNING id`;
    if (!r.length) return res.status(409).json({ error: "Alerte introuvable ou déjà examinée." });
    res.json({ message: "Alerte marquée comme examinée." });
  } catch (e) { console.error("AML_REVIEW", e.message); res.status(500).json({ error: "Erreur." }); }
});

// Niveau KYC d'un client (après contrôle de sa pièce d'identité par vos soins).
router.post("/kyc", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const status = String(req.body?.status || "");
    if (!["unverified", "pending", "verified", "rejected"].includes(status) || !email) return res.status(400).json({ error: "E-mail et statut (unverified, pending, verified, rejected) requis." });
    const r = await sql()`UPDATE users SET kyc_status = ${status}, updated_at = now() WHERE lower(email) = ${email} RETURNING id`;
    if (!r.length) return res.status(404).json({ error: "Client introuvable." });
    res.json({ message: "Statut KYC mis à jour.", status });
  } catch (e) { console.error("KYC_SET", e.message); res.status(500).json({ error: "Erreur." }); }
});

let lastMail = 0;
function startScheduler() {
  const tick = async () => {
    try {
      const r = await scan();
      if (r.created > 0 && Date.now() - lastMail > 3600 * 1000) {
        lastMail = Date.now();
        try { await require("../lib/mailer.js").sendAdminNotification("OMNIPAY — alertes conformité", `<p>${r.created} nouvelle(s) alerte(s) à examiner dans l'administration OMNICHECK.</p>`); } catch (_) { /* e-mail facultatif */ }
      }
    } catch (e) { console.error("[CONFORMITÉ] tâche :", e.message); }
  };
  setTimeout(tick, 30000);
  setInterval(tick, 15 * 60 * 1000);
}

module.exports = router;
module.exports.startScheduler = startScheduler;
module.exports.limitsFor = limitsFor;
module.exports.policy = policy;
module.exports.scan = scan;
