"use strict";
// OMNIPAY — ESPACE ENTREPRISE (enregistrement et vérification d'une entreprise). FICHIER AJOUTÉ.
//   Client : GET /api/company/mine · POST /api/company (crée ou corrige tant que le dossier n'est pas validé)
//   Admin (x-admin-key) : GET /api/company/admin/list?status=pending|verified|rejected|all · POST /api/company/admin/:id/decide {status:'verified'|'rejected', note}
// Les numéros RCCM / IFU ne sont visibles que de leur propriétaire et de l'administrateur. Aucune pièce n'est stockée ici : l'équipe demande les documents par e-mail.
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." }));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
const FORMS = ["Entreprise individuelle", "SARL", "SA", "SAS", "GIE", "Association / ONG", "Coopérative", "Autre"];

let ready = null;
function ensure() {
  if (!ready) ready = (async () => {
    const q = sql();
    await q`CREATE TABLE IF NOT EXISTS company_registrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, legal_name text NOT NULL, trade_name text, legal_form text NOT NULL,
      rccm text NOT NULL, ifu text NOT NULL, activity text NOT NULL, address text NOT NULL, city text NOT NULL, phone text NOT NULL, email text, rep_name text NOT NULL, rep_role text,
      status varchar(10) NOT NULL DEFAULT 'pending', note text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz)`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS company_user_uniq ON company_registrations (user_id)`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS company_rccm_uniq ON company_registrations (upper(rccm)) WHERE status <> 'rejected'`;
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

function validate(b) {
  const o = {
    legal_name: clean(b.legalName, 120), trade_name: clean(b.tradeName, 120), legal_form: clean(b.legalForm, 40),
    rccm: clean(b.rccm, 30).toUpperCase(), ifu: clean(b.ifu, 20).replace(/\s/g, ""), activity: clean(b.activity, 160), address: clean(b.address, 160), city: clean(b.city, 60),
    phone: clean(b.phone, 20).replace(/[^\d+]/g, ""), email: clean(b.email, 120).toLowerCase(), rep_name: clean(b.repName, 120), rep_role: clean(b.repRole, 60),
  };
  if (o.legal_name.length < 3) return { error: "Indiquez la raison sociale." };
  if (!FORMS.includes(o.legal_form)) return { error: "Choisissez la forme juridique." };
  if (!/^[A-Z0-9][A-Z0-9 ./-]{4,29}$/.test(o.rccm)) return { error: "Numéro RCCM invalide (ex. RB/ABC/21 B 1234)." };
  if (!/^[A-Z0-9]{10,15}$/i.test(o.ifu)) return { error: "Numéro IFU invalide (10 à 15 caractères, sans espaces)." };
  if (o.activity.length < 3) return { error: "Décrivez l'activité principale." };
  if (o.address.length < 5 || o.city.length < 2) return { error: "Adresse et ville requises." };
  if (o.phone.replace(/\D/g, "").length < 8) return { error: "Téléphone invalide." };
  if (o.email && !/^\S+@\S+\.\S+$/.test(o.email)) return { error: "E-mail invalide." };
  if (o.rep_name.replace(/[^A-Za-zÀ-ÿ]/g, "").length < 3) return { error: "Indiquez le nom du représentant légal." };
  if (!b.certify) return { error: "Cochez la case pour certifier l'exactitude des informations." };
  return { o };
}

router.get("/mine", requireAuth, async (req, res) => {
  try {
    await ensure();
    const r = await sql()`SELECT id, legal_name, trade_name, legal_form, rccm, ifu, activity, address, city, phone, email, rep_name, rep_role, status, note, created_at, decided_at FROM company_registrations WHERE user_id = ${req.user.userId}::uuid`;
    res.json({ company: r[0] || null, forms: FORMS });
  } catch (e) { console.error("COMPANY_MINE", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    await ensure();
    const v = validate(req.body || {}); if (v.error) return res.status(400).json({ error: v.error });
    const o = v.o, uid = req.user.userId, q = sql();
    const cur = await q`SELECT id, status FROM company_registrations WHERE user_id = ${uid}::uuid`;
    if (cur.length && cur[0].status === "verified") return res.status(409).json({ error: "Entreprise déjà validée : contactez le support pour la modifier." });
    try {
      if (cur.length) await q`UPDATE company_registrations SET legal_name = ${o.legal_name}, trade_name = ${o.trade_name}, legal_form = ${o.legal_form}, rccm = ${o.rccm}, ifu = ${o.ifu}, activity = ${o.activity}, address = ${o.address}, city = ${o.city},
        phone = ${o.phone}, email = ${o.email}, rep_name = ${o.rep_name}, rep_role = ${o.rep_role}, status = 'pending', note = NULL, updated_at = now() WHERE id = ${cur[0].id}::uuid`;
      else await q`INSERT INTO company_registrations (user_id, legal_name, trade_name, legal_form, rccm, ifu, activity, address, city, phone, email, rep_name, rep_role)
        VALUES (${uid}::uuid, ${o.legal_name}, ${o.trade_name}, ${o.legal_form}, ${o.rccm}, ${o.ifu}, ${o.activity}, ${o.address}, ${o.city}, ${o.phone}, ${o.email}, ${o.rep_name}, ${o.rep_role})`;
    } catch (e) { if (/unique|duplicate/i.test(String(e.message))) return res.status(409).json({ error: "Ce numéro RCCM est déjà enregistré." }); throw e; }
    try { await require("../lib/mailer.js").sendAdminNotification("Nouvelle entreprise à vérifier", `<p><b>${o.legal_name}</b> (${o.legal_form}) · ${o.city}</p><p>À valider dans OMNICHECK.</p>`); } catch (_) { /* e-mail facultatif */ }
    res.status(201).json({ message: "Dossier enregistré. Notre équipe le vérifie (délai habituel : 48 h) et peut vous demander vos documents par e-mail." });
  } catch (e) { console.error("COMPANY_SAVE", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.get("/admin/list", adminOnly, async (req, res) => {
  try {
    await ensure();
    const st = ["pending", "verified", "rejected"].includes(req.query.status) ? req.query.status : null;
    const rows = await sql()`SELECT c.id, c.legal_name, c.trade_name, c.legal_form, c.rccm, c.ifu, c.activity, c.address, c.city, c.phone, c.email, c.rep_name, c.rep_role, c.status, c.note, c.created_at, u.email AS user_email
      FROM company_registrations c LEFT JOIN users u ON u.id = c.user_id WHERE (${st}::text IS NULL OR c.status = ${st}) ORDER BY c.created_at DESC LIMIT 100`;
    res.json({ companies: rows });
  } catch (e) { console.error("COMPANY_LIST", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/admin/:id/decide", adminOnly, async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    const status = String((req.body || {}).status || ""), note = clean((req.body || {}).note, 200);
    if (!["verified", "rejected"].includes(status)) return res.status(400).json({ error: "Statut invalide." });
    if (status === "rejected" && note.length < 3) return res.status(400).json({ error: "Indiquez le motif du refus." });
    await ensure();
    const r = await sql()`UPDATE company_registrations SET status = ${status}, note = ${note || null}, decided_at = now(), updated_at = now() WHERE id = ${req.params.id}::uuid AND status = 'pending' RETURNING user_id, legal_name`;
    if (!r.length) return res.status(409).json({ error: "Dossier introuvable ou déjà traité." });
    try { const u = await sql()`SELECT email FROM users WHERE id = ${r[0].user_id}::uuid`; if (u[0] && u[0].email) await require("../lib/mailer.js").sendUserNotification(u[0].email, status === "verified" ? "Votre entreprise est validée" : "Votre dossier entreprise : action requise", [status === "verified" ? `${r[0].legal_name} est validée sur OMNIPAY.` : `Votre dossier ${r[0].legal_name} n'est pas validé : ${note}`]); } catch (_) { /* e-mail facultatif */ }
    res.json({ ok: true });
  } catch (e) { console.error("COMPANY_DECIDE", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;
