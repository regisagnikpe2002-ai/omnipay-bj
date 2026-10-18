"use strict";
// OMNICHECK — agent d'analyse OMNIPAY (fichier AJOUTÉ).
// - Inventaire automatique toutes les 24 h (lecture seule sur users / wallets / transactions)
// - Détection des opérations non abouties (en attente > 30 min) : signalées, JAMAIS exécutées automatiquement
// - Centre d'aide : réception des avis / critiques / limites des clients
// - Consultation réservée à l'administrateur (en-tête x-admin-key = ADMIN_KEY)
const express = require("express");
const { neon } = require("@neondatabase/serverless");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
let ready = false;

async function ensureTables() {
  if (ready) return;
  const q = sql();
  await q`CREATE TABLE IF NOT EXISTS omnicheck_feedback (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rating integer, category varchar(30), message text NOT NULL, contact varchar(255),
    created_at timestamptz NOT NULL DEFAULT now())`;
  await q`CREATE TABLE IF NOT EXISTS omnicheck_reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    report jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`;
  ready = true;
}

function isAdmin(req) {
  const key = req.headers["x-admin-key"];
  return Boolean(key && process.env.ADMIN_KEY && key === process.env.ADMIN_KEY);
}

async function buildReport() {
  const q = sql();
  const [users] = await q`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS new_24h FROM users`;
  const [wal] = await q`SELECT count(*)::int AS wallets, coalesce(sum(balance),0)::float AS total_balance,
      count(*) FILTER (WHERE balance < 0)::int AS negative FROM wallets`;
  const flows = await q`SELECT type, status, count(*)::int AS n, coalesce(sum(amount),0)::float AS total
      FROM transactions WHERE created_at > now() - interval '24 hours' GROUP BY type, status ORDER BY type, status`;
  const [com] = await q`SELECT coalesce(sum(amount) FILTER (WHERE created_at > now() - interval '24 hours'),0)::float AS commissions_24h,
      coalesce(sum(amount),0)::float AS commissions_total FROM transactions WHERE type = 'commission' AND status = 'completed'`;
  const stuck = await q`SELECT id, type, amount::float AS amount, provider, status,
      round(extract(epoch FROM (now() - created_at))/60)::int AS age_minutes
      FROM transactions WHERE status IN ('pending','processing') AND created_at < now() - interval '30 minutes'
      ORDER BY created_at ASC LIMIT 50`;
  const [fb] = await q`SELECT count(*)::int AS total, coalesce(round(avg(rating),2),0)::float AS avg_rating,
      count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS new_24h FROM omnicheck_feedback`;
  const alerts = [];
  if (wal.negative > 0) alerts.push(`${wal.negative} portefeuille(s) avec solde négatif`);
  if (stuck.length > 0) alerts.push(`${stuck.length} opération(s) non abouties depuis plus de 30 min : à vérifier`);
  return {
    generatedAt: new Date().toISOString(), users, wallets: wal, flows24h: flows, commissions: com,
    notCompleted: stuck, feedback: fb, alerts, status: alerts.length ? "ATTENTION" : "OK",
  };
}

async function runInventory() {
  await ensureTables();
  const report = await buildReport();
  await sql()`INSERT INTO omnicheck_reports (report) VALUES (${JSON.stringify(report)}::jsonb)`;
  console.log(`[OMNICHECK] inventaire 24h : ${report.status} — ${report.alerts.length} alerte(s)`);
  return report;
}

function startScheduler() {
  const DAY = 24 * 60 * 60 * 1000;
  const run = () => runInventory().catch((e) => console.error("[OMNICHECK] erreur inventaire :", e.message));
  setTimeout(run, 90 * 1000);
  setInterval(run, DAY).unref?.();
  console.log("[OMNICHECK] inventaire automatique toutes les 24 h activé");
}

// --- Avis clients (public, limité : 5 avis / heure / adresse IP)
const hits = new Map();
router.post("/feedback", async (req, res) => {
  try {
    const ip = req.ip || "x";
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < 3600 * 1000);
    if (recent.length >= 5) return res.status(429).json({ error: "Merci ! Vous avez déjà envoyé plusieurs avis. Réessayez plus tard." });
    const message = String(req.body?.message || "").trim().slice(0, 2000);
    if (message.length < 5) return res.status(400).json({ error: "Décrivez votre expérience en quelques mots." });
    const rating = Math.min(5, Math.max(1, parseInt(req.body?.rating, 10) || 0)) || null;
    const allowed = ["avis", "critique", "limite", "probleme", "idee"];
    const category = allowed.includes(req.body?.category) ? req.body.category : "avis";
    const contact = String(req.body?.contact || "").trim().slice(0, 255) || null;
    await ensureTables();
    await sql()`INSERT INTO omnicheck_feedback (rating, category, message, contact) VALUES (${rating}, ${category}, ${message}, ${contact})`;
    hits.set(ip, [...recent, now]);
    return res.status(201).json({ message: "Merci, votre retour a bien été reçu par OMNICHECK." });
  } catch (e) {
    console.error("OMNICHECK_FEEDBACK", e.message);
    return res.status(500).json({ error: "Impossible d'enregistrer votre avis pour le moment." });
  }
});

// --- Administrateur
router.get("/report", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Accès refusé." });
  try {
    await ensureTables();
    res.json({ live: await buildReport() });
  } catch (e) { console.error("OMNICHECK_REPORT", e.message); res.status(500).json({ error: "Erreur OMNICHECK." }); }
});
router.post("/run", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Accès refusé." });
  try { res.json({ report: await runInventory() }); }
  catch (e) { console.error("OMNICHECK_RUN", e.message); res.status(500).json({ error: "Erreur OMNICHECK." }); }
});
router.get("/feedback", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Accès refusé." });
  try {
    await ensureTables();
    const rows = await sql()`SELECT id, rating, category, message, contact, created_at FROM omnicheck_feedback ORDER BY created_at DESC LIMIT 200`;
    res.json({ feedback: rows });
  } catch (e) { console.error("OMNICHECK_FB", e.message); res.status(500).json({ error: "Erreur OMNICHECK." }); }
});

module.exports = router;
module.exports.startScheduler = startScheduler;
