"use strict";
// OMNIPAY — FONDS DE RÉSERVE (admin, OMNICHECK). FICHIER AJOUTÉ.
// Objectif : constituer puis piloter un fonds de réserve propre (cible par défaut 500 000 000 FCFA) pour financer les marchands, servir les transferts et développer d'autres secteurs.
// Ce module est un REGISTRE : il ne crée pas d'argent et ne touche à aucun solde client. Chaque ligne correspond à de l'argent réel que vous avez mis de côté (référence du compte/virement obligatoire).
//   GET  /api/reserve/overview        cible, constitué, engagé, disponible, progression, commissions réelles du mois, mise de côté conseillée, projection
//   GET  /api/reserve/entries         journal (200 dernières lignes)
//   POST /api/reserve/entry           {kind: apport|engagement|retour|sortie, amount, bucket?, account?, ref, note?}
//   POST /api/reserve/settings        {target, setAsidePct}
// Règles : un engagement ou une sortie ne peut jamais dépasser le DISPONIBLE (apports − sorties − engagements en cours) ; un retour ne peut pas dépasser les engagements en cours.
const express = require("express");
const { neon } = require("@neondatabase/serverless");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
router.use((req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." })));
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);
const KINDS = ["apport", "engagement", "retour", "sortie"];
const BUCKETS = ["marchands", "transferts", "developpement"];
const DEFAULT_TARGET = 500000000, DEFAULT_PCT = 20, MAX_AMOUNT = 1000000000000;

let ready = false;
async function ensure() {
  if (ready) return;
  await sql()`CREATE TABLE IF NOT EXISTS rsv_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind varchar(12) NOT NULL, amount numeric(18,0) NOT NULL CHECK (amount > 0), bucket varchar(14), account varchar(60), ref varchar(80) NOT NULL, note varchar(200), created_at timestamptz NOT NULL DEFAULT now())`;
  await sql()`CREATE TABLE IF NOT EXISTS rsv_settings (k varchar(20) PRIMARY KEY, v numeric(18,2) NOT NULL)`;
  ready = true;
}
async function settings() {
  const rows = await sql()`SELECT k, v::float AS v FROM rsv_settings`; const m = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  return { target: m.target || DEFAULT_TARGET, setAsidePct: m.pct == null ? DEFAULT_PCT : m.pct };
}
async function totals() {
  const [t] = await sql()`SELECT COALESCE(sum(amount) FILTER (WHERE kind='apport'),0)::float AS apport, COALESCE(sum(amount) FILTER (WHERE kind='sortie'),0)::float AS sortie,
    COALESCE(sum(amount) FILTER (WHERE kind='engagement'),0)::float AS eng, COALESCE(sum(amount) FILTER (WHERE kind='retour'),0)::float AS ret FROM rsv_entries`;
  const byBucket = await sql()`SELECT bucket, (COALESCE(sum(amount) FILTER (WHERE kind='engagement'),0) - COALESCE(sum(amount) FILTER (WHERE kind='retour'),0))::float AS out FROM rsv_entries WHERE bucket IS NOT NULL GROUP BY bucket`;
  const funded = t.apport - t.sortie, engaged = t.eng - t.ret;
  return { funded, engaged, available: funded - engaged, byBucket: Object.fromEntries(BUCKETS.map((b) => [b, (byBucket.find((x) => x.bucket === b) || { out: 0 }).out])) };
}

router.get("/overview", async (req, res) => {
  try {
    await ensure(); const s = await settings(), t = await totals();
    const [c] = await sql()`SELECT COALESCE(sum(amount),0)::float AS m FROM transactions WHERE type = 'commission' AND status IN ('completed','success') AND created_at >= now() - interval '30 days'`;
    const advised = Math.round(c.m * s.setAsidePct / 100), remaining = Math.max(0, s.target - t.funded);
    res.json({ target: s.target, setAsidePct: s.setAsidePct, funded: t.funded, engaged: t.engaged, available: t.available, byBucket: t.byBucket,
      progressPct: s.target > 0 ? Math.min(100, Math.round((t.funded / s.target) * 1000) / 10) : 0, remaining,
      commissions30d: Math.round(c.m), advisedMonthly: advised, monthsToTarget: advised > 0 && remaining > 0 ? Math.ceil(remaining / advised) : remaining === 0 ? 0 : null,
      note: "Le fonds n'existe que par les apports réels que vous enregistrez. Rien n'est créé automatiquement." });
  } catch (e) { console.error("RSV_OV", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.get("/entries", async (req, res) => {
  try { await ensure(); res.json({ entries: await sql()`SELECT id, kind, amount::float AS amount, bucket, account, ref, note, created_at FROM rsv_entries ORDER BY created_at DESC LIMIT 200` }); }
  catch (e) { console.error("RSV_EN", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.post("/entry", express.json(), async (req, res) => {
  try {
    await ensure(); const b = req.body || {}, kind = String(b.kind || ""), amount = Math.round(Number(b.amount)), ref = clean(b.ref, 80);
    if (!KINDS.includes(kind)) return res.status(400).json({ error: "Type inconnu (apport, engagement, retour, sortie)." });
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) return res.status(400).json({ error: "Montant invalide." });
    if (ref.length < 3) return res.status(400).json({ error: "Référence obligatoire (n° de virement, compte, contrat…)." });
    const bucket = b.bucket ? String(b.bucket) : null;
    if ((kind === "engagement" || kind === "retour") && !BUCKETS.includes(bucket)) return res.status(400).json({ error: "Choisissez l'usage : marchands, transferts ou développement." });
    if (bucket && !BUCKETS.includes(bucket)) return res.status(400).json({ error: "Usage inconnu." });
    // Insertion atomique : les plafonds sont recalculés dans la même requête (pas de dépassement possible même avec deux validations simultanées).
    const r = await sql()`
      WITH t AS (SELECT COALESCE(sum(amount) FILTER (WHERE kind='apport'),0) AS apport, COALESCE(sum(amount) FILTER (WHERE kind='sortie'),0) AS sortie,
                        COALESCE(sum(amount) FILTER (WHERE kind='engagement'),0) AS eng, COALESCE(sum(amount) FILTER (WHERE kind='retour'),0) AS ret,
                        COALESCE(sum(amount) FILTER (WHERE kind='engagement' AND bucket=${bucket}),0) - COALESCE(sum(amount) FILTER (WHERE kind='retour' AND bucket=${bucket}),0) AS bucket_out FROM rsv_entries)
      INSERT INTO rsv_entries (kind, amount, bucket, account, ref, note)
      SELECT ${kind}, ${amount}, ${bucket}, ${clean(b.account, 60) || null}, ${ref}, ${clean(b.note, 200) || null} FROM t
      WHERE CASE WHEN ${kind} IN ('engagement','sortie') THEN ${amount} <= (t.apport - t.sortie - (t.eng - t.ret))
                 WHEN ${kind} = 'retour' THEN ${amount} <= t.bucket_out ELSE true END
      RETURNING id`;
    if (!r.length) return res.status(400).json({ error: kind === "retour" ? "Ce retour dépasse les engagements en cours pour cet usage." : "Montant supérieur au disponible dans le fonds." });
    res.status(201).json({ ok: true, id: r[0].id, totals: await totals() });
  } catch (e) { console.error("RSV_ADD", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.post("/settings", express.json(), async (req, res) => {
  try {
    await ensure(); const b = req.body || {}, target = Number(b.target), pct = Number(b.setAsidePct);
    if (b.target != null && (!Number.isFinite(target) || target < 1000000 || target > MAX_AMOUNT)) return res.status(400).json({ error: "Cible entre 1 000 000 et 1 000 milliards de FCFA." });
    if (b.setAsidePct != null && (!Number.isFinite(pct) || pct < 0 || pct > 100)) return res.status(400).json({ error: "Pourcentage entre 0 et 100." });
    if (b.target != null) await sql()`INSERT INTO rsv_settings (k, v) VALUES ('target', ${Math.round(target)}) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`;
    if (b.setAsidePct != null) await sql()`INSERT INTO rsv_settings (k, v) VALUES ('pct', ${pct}) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`;
    res.json({ ok: true, ...(await settings()) });
  } catch (e) { console.error("RSV_SET", e.message); res.status(500).json({ error: "Erreur." }); }
});

module.exports = router;
