"use strict";
// OMNIPAY — CLIENTS & ACTIVITÉ (lecture seule, administrateur). Votre base Neon enregistre déjà tout : ce module la montre sous forme de
// registre unique, sans copier ni dupliquer aucune donnée (donc rien ne peut se contredire).
//   GET /api/activity/clients?q=…        → clients (nom, e-mail, téléphone, statut, solde, dernière activité) — recherche facultative
//   GET /api/activity/feed?type=&days=   → journal unifié : inscriptions, dépôts, retraits, envois, paiements PI-SPI reçus, ordres des marchands
//   GET /api/activity/export.csv         → journal des 30 derniers jours en CSV
// Aucun mot de passe ni secret n'est jamais renvoyé.
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
function adminOnly(req, res, next) {
  const p = Buffer.from(String(req.headers["x-admin-key"] || "")), e = Buffer.from(String(process.env.ADMIN_KEY || ""));
  if (!e.length || p.length !== e.length || !crypto.timingSafeEqual(p, e)) return res.status(403).json({ error: "Accès refusé." });
  next();
}
const maskPhone = (p) => { const d = String(p || ""); return d.length > 5 ? d.slice(0, 3) + "•".repeat(Math.max(0, d.length - 5)) + d.slice(-2) : d; };
const TYPES = ["signup", "deposit", "withdrawal", "transfer", "pispi", "order"];

async function feed(days, type, limit) {
  const q = sql();
  const rows = [];
  if (!type || type === "signup") rows.push(...await q`SELECT u.created_at AS at, 'signup' AS kind, trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')) AS who, 'Nouveau client' AS what, NULL::float AS amount, u.status AS status FROM users u WHERE u.created_at >= now() - make_interval(days => ${days}::int) ORDER BY u.created_at DESC LIMIT ${limit}`);
  const tx = await q`SELECT t.created_at AS at, t.type AS ttype, trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')) AS who, coalesce(t.provider,'') AS provider, t.amount::float AS amount, t.status AS status
      FROM transactions t JOIN wallets w ON w.id = t.wallet_id JOIN users u ON u.id = w.user_id
      WHERE t.created_at >= now() - make_interval(days => ${days}::int) AND t.type IN ('deposit','withdrawal','transfer_in','transfer_out') ORDER BY t.created_at DESC LIMIT ${limit * 2}`;
  for (const t of tx) {
    const kind = t.ttype === "deposit" ? "deposit" : t.ttype === "withdrawal" ? "withdrawal" : "transfer";
    if (type && type !== kind) continue;
    rows.push({ at: t.at, kind, who: t.who, what: ({ deposit: "Dépôt", withdrawal: "Retrait", transfer_in: "Transfert reçu", transfer_out: "Transfert envoyé" })[t.ttype] + (t.provider ? " · " + t.provider : ""), amount: t.amount, status: t.status });
  }
  if (!type || type === "pispi") { try { rows.push(...(await q`SELECT p.created_at AS at, 'pispi' AS kind, coalesce(p.payer,'') AS who, 'PI-SPI reçu' || CASE WHEN p.reference IS NOT NULL THEN ' · ' || p.reference ELSE '' END AS what, p.amount::float AS amount, p.status AS status FROM inbound_payments p WHERE p.created_at >= now() - make_interval(days => ${days}::int) ORDER BY p.created_at DESC LIMIT ${limit}`)); } catch (_) { /* table absente */ } }
  if (!type || type === "order") { try { rows.push(...(await q`SELECT e.at AS at, 'order' AS kind, e.actor AS who, 'Ordre de paiement · ' || e.action AS what, o.amount::float AS amount, o.status AS status FROM order_events e JOIN payment_orders o ON o.id = e.order_id WHERE e.at >= now() - make_interval(days => ${days}::int) ORDER BY e.id DESC LIMIT ${limit}`)); } catch (_) { /* table absente */ } }
  return rows.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit);
}

router.get("/clients", adminOnly, async (req, res) => {
  try {
    const term = String(req.query.q || "").trim().slice(0, 60).toLowerCase();
    const like = "%" + term.replace(/[%_\\]/g, "") + "%";
    const q = sql();
    const rows = await q`SELECT u.id, trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')) AS name, u.email, u.phone, u.kyc_status, u.status, u.created_at,
        coalesce(w.balance,0)::float AS balance, (SELECT max(t.created_at) FROM transactions t WHERE t.wallet_id = w.id) AS last_activity,
        (SELECT count(*)::int FROM transactions t WHERE t.wallet_id = w.id AND t.status = 'completed') AS ops
      FROM users u LEFT JOIN wallets w ON w.user_id = u.id
      WHERE (${term} = '' OR lower(u.email) LIKE ${like} OR lower(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')) LIKE ${like} OR u.phone LIKE ${like})
      ORDER BY coalesce((SELECT max(t.created_at) FROM transactions t WHERE t.wallet_id = w.id), u.created_at) DESC LIMIT 100`;
    const tot = (await q`SELECT count(*)::int AS clients, coalesce(sum(balance),0)::float AS held FROM wallets`)[0];
    const week = (await q`SELECT count(*)::int AS n FROM users WHERE created_at >= now() - interval '7 days'`)[0].n;
    res.json({ totals: { clients: tot.clients, balanceHeld: tot.held, newThisWeek: week }, clients: rows.map((r) => ({ ...r, phone: maskPhone(r.phone) })) });
  } catch (e) { console.error("ACTIVITY_CLIENTS", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.get("/feed", adminOnly, async (req, res) => {
  try {
    const type = TYPES.includes(String(req.query.type)) ? String(req.query.type) : "";
    const days = Math.min(90, Math.max(1, Math.floor(Number(req.query.days) || 7)));
    res.json({ days, type, items: await feed(days, type, 150) });
  } catch (e) { console.error("ACTIVITY_FEED", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.get("/export.csv", adminOnly, async (req, res) => {
  try {
    const items = await feed(30, "", 1000);
    const esc = (v) => { let s = String(v == null ? "" : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }; // anti-injection de formules Excel
    res.set("Content-Type", "text/csv; charset=utf-8").set("Content-Disposition", 'attachment; filename="omnipay-activite-30j.csv"');
    res.send("﻿date;type;client;operation;montant_xof;statut\n" + items.map((r) => [new Date(r.at).toISOString(), r.kind, r.who, r.what, r.amount == null ? "" : r.amount, r.status].map(esc).join(";")).join("\n"));
  } catch (e) { console.error("ACTIVITY_CSV", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;
