"use strict";
// OMNIPAY — canaux d'entrée indépendants (PI-SPI, MTN MoMo, Moov, Celtiis…). AUCUN tiers de paiement imposé.
// Principe : chaque connecteur (PI-SPI Ecobank, MoMo, Moov, Celtiis, banque) traduit sa notification en UN format commun et l'envoie ici.
//   POST /api/channels/inbound   (signé HMAC-SHA256 du corps brut, en-tête x-omnipay-signature, secret CHANNEL_INBOUND_SECRET ≥ 32 car.)
//   corps : { channel: "pispi", externalId: "ID-UNIQUE-DU-PAIEMENT", amount: 5000, currency: "XOF", reference: "OM1234567890", payer: "nom ou n°" }
// Règles : un même (channel, externalId) n'est traité qu'une fois ; si la référence est l'identifiant OM d'un client, son portefeuille est
// crédité atomiquement ; sinon le paiement reste « à rapprocher » et l'admin l'attribue (ou le rejette).
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." }));
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IN = Number(process.env.CHANNEL_MAX_XOF || 5000000);
let ready = null;
function ensure() {
  if (!ready) ready = sql()`CREATE TABLE IF NOT EXISTS inbound_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), channel varchar(30) NOT NULL, external_id varchar(120) NOT NULL,
    amount numeric(18,2) NOT NULL, reference varchar(80), payer varchar(120), status varchar(20) NOT NULL DEFAULT 'received',
    user_id uuid, raw jsonb, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (channel, external_id))`.catch((e) => { ready = null; throw e; });
  return ready;
}

// Crédit atomique : le paiement doit être « received » ; un seul passage possible.
const credit = (id, userId) => sql()`
  WITH p AS (UPDATE inbound_payments SET status = 'credited', user_id = ${userId}::uuid WHERE id = ${id}::uuid AND status = 'received' AND EXISTS (SELECT 1 FROM wallets WHERE user_id = ${userId}::uuid) RETURNING id, channel, external_id, amount, reference),
  w AS (UPDATE wallets SET balance = balance + p.amount, updated_at = now() FROM p WHERE wallets.user_id = ${userId}::uuid RETURNING wallets.id AS wid, wallets.balance AS bal, p.id AS pid, p.channel, p.external_id, p.amount, p.reference),
  t AS (INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key, metadata)
        SELECT w.wid, 'deposit', w.amount, w.bal, 'completed', w.channel, w.external_id, 'in-' || w.channel || '-' || w.external_id,
               jsonb_build_object('inbound', true, 'reference', w.reference) FROM w RETURNING id)
  SELECT (SELECT count(*) FROM t)::int AS n`;

// Enregistrement UNIQUE d'un paiement reçu (même règle pour le canal signé et pour la saisie admin) : (channel, externalId) ne passe qu'une fois.
async function ingest({ channel, externalId, amount, reference, payer, source }) {
  await ensure();
  const q = sql();
  const ins = await q`INSERT INTO inbound_payments (channel, external_id, amount, reference, payer, raw)
    VALUES (${channel}, ${externalId}, ${amount}, ${reference}, ${payer}, ${JSON.stringify({ channel, externalId, amount, reference, payer, source })}::jsonb)
    ON CONFLICT (channel, external_id) DO NOTHING RETURNING id`;
  if (!ins.length) return { status: 200, body: { duplicate: true } };
  const m = reference ? await q`SELECT user_id FROM account_ids WHERE code = ${reference.toUpperCase().replace(/\s/g, "")}` : [];
  if (!m.length) return { status: 202, body: { matched: false, id: ins[0].id } }; // reste « à rapprocher »
  const r = await credit(ins[0].id, m[0].user_id);
  return { status: 201, body: { matched: true, credited: r[0]?.n === 1, id: ins[0].id } };
}
const parsePayment = (b) => {
  const channel = clean(b?.channel, 30).toLowerCase(), externalId = clean(b?.externalId, 120);
  const amount = Math.floor(Number(b?.amount)), reference = clean(b?.reference, 80), payer = clean(b?.payer, 120);
  if (!/^[a-z0-9_-]{2,30}$/.test(channel) || !externalId) return { error: "channel / externalId requis." };
  if (String(b?.currency || "XOF").toUpperCase() !== "XOF") return { error: "Seul le XOF est accepté." };
  if (!Number.isFinite(amount) || amount < 1 || amount > MAX_IN) return { error: "Montant invalide." };
  return { channel, externalId, amount, reference, payer };
};

router.post("/inbound", async (req, res) => {
  try {
    const key = (process.env.CHANNEL_INBOUND_SECRET || "").trim();
    if (key.length < 32) return res.status(503).json({ error: "Canal non configuré." });
    const given = String(req.headers["x-omnipay-signature"] || "");
    const want = crypto.createHmac("sha256", key).update(req.rawBody || "").digest("hex");
    const a = Buffer.from(given), b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Signature invalide." });
    const p = parsePayment(req.body);
    if (p.error) return res.status(400).json({ error: p.error });
    const r = await ingest({ ...p, source: "signed" });
    res.status(r.status).json(r.body);
  } catch (e) { console.error("CHANNEL_INBOUND", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

// Saisie ADMIN d'un paiement vu dans l'application de la banque (PI-SPI, virement, Mobile Money) : la référence de l'opération bancaire
// sert d'identifiant unique, donc un même paiement ne peut JAMAIS être crédité deux fois. Sans identifiant OM, il reste « à rapprocher ».
router.post("/record", adminOnly, async (req, res) => {
  try {
    const p = parsePayment({ ...req.body, channel: req.body?.channel || "pispi" });
    if (p.error) return res.status(400).json({ error: p.error });
    if (p.externalId.length < 6) return res.status(400).json({ error: "Référence de l'opération bancaire requise (6 caractères minimum)." });
    const r = await ingest({ ...p, source: "admin" });
    res.status(r.status === 200 ? 409 : 200).json(r.status === 200 ? { error: "Cette opération a déjà été enregistrée." } : { ...r.body, message: r.body.matched ? (r.body.credited ? "Paiement enregistré et client crédité." : "Paiement enregistré, crédit impossible.") : "Paiement enregistré : à rattacher à un client." });
  } catch (e) { console.error("CHANNEL_RECORD", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

// Lecture d'un message de banque COLLÉ par l'admin (SMS / notification PI-SPI) : extrait montant, référence, identifiant OM, payeur.
// N'ENREGISTRE RIEN : l'admin relit les champs préremplis puis valide lui-même (« Enregistrer et créditer »). Format Ecobank non garanti : on signale ce qui manque.
function parseBankText(text) {
  const t = String(text || "").replace(/[\u00a0\u202f]/g, " ").slice(0, 2000);
  const warnings = [];
  let amount = null;
  const am = t.match(/(?:montant|re[cç]u|cr[ée]dit(?:[ée])?|de)\s*:?\s*(\d{1,3}(?:[ .]\d{3})+|\d+)(?:[,.]\d{1,2})?\s*(?:FCFA|F\s?CFA|XOF|CFA|F)\b/i) || t.match(/(\d{1,3}(?:[ .]\d{3})+|\d+)(?:[,.]\d{1,2})?\s*(?:FCFA|F\s?CFA|XOF|CFA)\b/i);
  if (am) amount = parseInt(am[1].replace(/[ .]/g, ""), 10);
  let externalId = null;
  const rf = t.match(/(?:r[ée]f(?:[ée]rence)?|id(?:\s*(?:op[ée]ration|transaction|paiement))?|transaction|trx|n[°o])\s*[:#°]?\s*([A-Za-z0-9][A-Za-z0-9\-_]{5,39})/i) || t.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
  if (rf) externalId = rf[1];
  const om = t.match(/\bOM\s?(\d{10})\b/i);
  const pm = t.match(/(?:de|from|exp[ée]diteur|payeur|par)\s*:?\s*([A-ZÀ-Ý][A-ZÀ-Ý'\- ]{3,60}[A-ZÀ-Ý])(?=\s|$|[.,;])/);
  if (/d[ée]bit|envoy[ée]|vous avez pay|retrait/i.test(t) && !/re[cç]u|cr[ée]dit|re[cç]u de/i.test(t)) warnings.push("Ce message ressemble à une SORTIE d'argent, pas à un paiement reçu.");
  if (amount == null) warnings.push("Montant introuvable : saisissez-le.");
  if (!externalId) warnings.push("Référence de l'opération introuvable : copiez-la depuis l'application bancaire.");
  return { amount, externalId, omId: om ? "OM" + om[1] : null, payer: pm ? pm[1].trim() : null, warnings };
}
router.post("/parse-text", adminOnly, (req, res) => res.json(parseBankText(req.body?.text)));
router._test = { parseBankText };


// ---- Rapprochement par lot (MTN · Moov · Celtiis · PI-SPI) ----
// 1) /reconcile : l'admin COLLE plusieurs SMS / lignes de relevé ; on lit chaque message, on signale les doublons et les clients reconnus. N'ENREGISTRE RIEN.
// 2) /record-batch : après relecture, l'admin valide les lignes cochées ; chaque opération passe par ingest() (jamais de double crédit).
const RECO_CHANNELS = { mtn: "momo", momo: "momo", moov: "moov", celtiis: "celtiis", pispi: "pispi" };
function splitMessages(text) {
  const t = String(text || "").replace(/\r/g, "").slice(0, 20000).trim();
  if (!t) return [];
  let parts = t.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  if (parts.length === 1) {
    const lines = t.split("\n").map((x) => x.trim()).filter(Boolean);
    if (lines.length > 1 && lines.every((l) => /\d+\s*(?:FCFA|F\s?CFA|XOF|CFA|F)\b/i.test(l))) parts = lines;
  }
  return parts.slice(0, 50);
}
router.post("/reconcile", adminOnly, async (req, res) => {
  try {
    await ensure();
    const channel = RECO_CHANNELS[clean(req.body?.operator, 20).toLowerCase()];
    if (!channel) return res.status(400).json({ error: "Opérateur inconnu (mtn, moov, celtiis, pispi)." });
    const msgs = splitMessages(req.body?.text);
    if (!msgs.length) return res.status(400).json({ error: "Collez au moins un message." });
    const q = sql(); const items = [];
    for (const m of msgs) {
      const p = parseBankText(m); const w = [...p.warnings];
      let duplicate = false, clientFound = false;
      if (p.externalId) { duplicate = (await q`SELECT 1 FROM inbound_payments WHERE channel = ${channel} AND external_id = ${p.externalId}`).length > 0; }
      if (p.omId) { clientFound = (await q`SELECT 1 FROM account_ids WHERE code = ${p.omId}`).length > 0; if (!clientFound) w.push("Identifiant OM inconnu : le paiement restera « à rapprocher »."); }
      else w.push("Pas d'identifiant OM : le paiement restera « à rapprocher » (vous l'attribuerez ensuite).");
      if (duplicate) w.push("Déjà enregistré : sera ignoré.");
      items.push({ channel, raw: m.slice(0, 300), amount: p.amount, externalId: p.externalId, reference: p.omId, payer: p.payer, duplicate, clientFound, warnings: w, ok: !!(p.amount && p.externalId && p.externalId.length >= 6 && !duplicate) });
    }
    res.json({ channel, items });
  } catch (e) { console.error("CHANNEL_RECONCILE", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});
router.post("/record-batch", adminOnly, async (req, res) => {
  try {
    const channel = RECO_CHANNELS[clean(req.body?.operator, 20).toLowerCase()];
    if (!channel) return res.status(400).json({ error: "Opérateur inconnu." });
    const list = Array.isArray(req.body?.items) ? req.body.items.slice(0, 50) : [];
    if (!list.length) return res.status(400).json({ error: "Aucune ligne à enregistrer." });
    const out = { credited: 0, toAssign: 0, duplicates: 0, errors: 0, details: [] };
    for (const it of list) {
      const p = parsePayment({ ...it, channel });
      if (p.error || p.externalId.length < 6) { out.errors++; out.details.push({ externalId: it?.externalId || "?", result: p.error || "Référence trop courte" }); continue; }
      const r = await ingest({ ...p, source: "admin-batch" });
      if (r.status === 200) { out.duplicates++; out.details.push({ externalId: p.externalId, result: "doublon ignoré" }); }
      else if (r.body.matched && r.body.credited) { out.credited++; out.details.push({ externalId: p.externalId, result: "client crédité" }); }
      else { out.toAssign++; out.details.push({ externalId: p.externalId, result: "à rapprocher" }); }
    }
    res.json({ ...out, message: `${out.credited} crédité(s), ${out.toAssign} à attribuer, ${out.duplicates} doublon(s), ${out.errors} erreur(s).` });
  } catch (e) { console.error("CHANNEL_RECORD_BATCH", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

// Vue d'ensemble des routes (OMNICHECK) : pour chaque opérateur, quel canal est utilisé et s'il est réellement prêt.
router.get("/routes", adminOnly, async (req, res) => {
  try {
    await ensure();
    const po = require("../providers/payoutRouter.js");
    const on = (n) => ["on", "true", "1", "yes"].includes(String(process.env[n] || "off").toLowerCase());
    const ready = (route) => route === "manual" ? { ok: true, note: "Manuel : vous payez puis cliquez « Payé »." }
      : route === "momo" ? (po.momoConfigured() ? { ok: true, note: "API MTN configurée." } : { ok: false, note: "API MTN non configurée." })
      : route === "paydunya" ? (on("PAYDUNYA_ENABLED") ? { ok: true, note: "PayDunya activé." } : { ok: false, note: "PayDunya désactivé." })
      : { ok: false, note: "API non encore fournie." };
    const operators = ["mtn", "moov", "celtiis"].map((op) => { const route = po.routeFor(op); return { operator: op, route, ...ready(route) }; });
    let accounts = [];
    try { accounts = JSON.parse(process.env.OMNIPAY_PAYIN_ACCOUNTS || "[]").map((a) => String(a.label || a.type || "compte")); } catch (_) { accounts = []; }
    const q = sql();
    const last = await q`SELECT channel, count(*)::int AS n, coalesce(sum(amount),0)::float AS total FROM inbound_payments WHERE created_at > now() - interval '24 hours' GROUP BY channel ORDER BY channel`;
    const pend = (await q`SELECT count(*)::int AS n FROM inbound_payments WHERE status = 'received'`)[0].n;
    res.json({ operators, pispi: { payin: "Entrant : alias PI-SPI + saisie admin (API Ecobank à venir)", payout: "Sortant : « Envoyer » dans l'app Ecobank puis « Payé » (API à venir)" },
      inboundSecretSet: (process.env.CHANNEL_INBOUND_SECRET || "").trim().length >= 32, payinAccounts: accounts, last24h: last, toReconcile: pend,
      autoPayout: on("AUTO_PAYOUT"), autoDayMax: Number(process.env.AUTO_PAYOUT_DAY_MAX_XOF || 1000000) });
  } catch (e) { console.error("CHANNEL_ROUTES", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

// ---- Admin : paiements reçus mais non rattachés ----
router.get("/pending", adminOnly, async (req, res) => {
  try {
    await ensure();
    const rows = await sql()`SELECT id, channel, external_id, amount, reference, payer, created_at FROM inbound_payments WHERE status = 'received' ORDER BY created_at DESC LIMIT 100`;
    res.json({ payments: rows });
  } catch (e) { console.error("CHANNEL_PENDING", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/:id/assign", adminOnly, async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!UUID.test(id)) return res.status(400).json({ error: "Identifiant invalide." });
    await ensure();
    const code = clean(req.body?.code, 20).toUpperCase().replace(/\s/g, "");
    const u = await sql()`SELECT user_id FROM account_ids WHERE code = ${code}`;
    if (!u.length) return res.status(404).json({ error: "Identifiant OM introuvable." });
    const r = await credit(id, u[0].user_id);
    if (r[0]?.n !== 1) return res.status(409).json({ error: "Paiement introuvable ou déjà traité." });
    res.json({ message: "Paiement attribué et crédité." });
  } catch (e) { console.error("CHANNEL_ASSIGN", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/:id/reject", adminOnly, async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!UUID.test(id)) return res.status(400).json({ error: "Identifiant invalide." });
    await ensure();
    const r = await sql()`UPDATE inbound_payments SET status = 'rejected' WHERE id = ${id}::uuid AND status = 'received' RETURNING id`;
    if (!r.length) return res.status(409).json({ error: "Paiement introuvable ou déjà traité." });
    res.json({ message: "Paiement rejeté (à rembourser hors OMNIPAY si nécessaire)." });
  } catch (e) { console.error("CHANNEL_REJECT", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;
