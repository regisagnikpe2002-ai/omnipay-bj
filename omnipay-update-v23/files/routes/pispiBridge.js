"use strict";
// OMNIPAY — BRANCHEUR PI-SPI : sert votre compte PI-SPI (Ecobank) de trésorerie à vos clients. Quand un client paie sur votre alias avec son identifiant OM
// en motif, la notification de la banque arrive ici et son portefeuille est crédité AUTOMATIQUEMENT (dans la limite d'un plafond), sinon le paiement attend
// une validation humaine (« à rapprocher »). Un même paiement ne peut jamais être crédité deux fois (identifiant d'opération unique).
// Deux entrées, au choix (désactivées tant que le secret n'est pas défini) :
//   POST /api/pispi/notify  : notification API / webhook de la banque (JSON). Authentification : signature HMAC-SHA256 du corps brut dans l'en-tête x-pispi-signature
//                             OU jeton secret dans l'en-tête x-pispi-token. Les champs sont lus selon PISPI_MAP (voir plus bas) : le format officiel d'Ecobank n'est pas
//                             supposé, il se règle sans modifier le code grâce à « Tester une notification » dans OMNICHECK.
//   POST /api/pispi/sms     : relais SMS (application « SMS forwarder » sur le téléphone qui reçoit les SMS de la banque), jeton x-pispi-token, expéditeur autorisé
//                             (PISPI_SMS_SENDERS), plafond automatique plus bas. Activé seulement si PISPI_SMS_ENABLED=on.
//   Admin : GET /api/pispi/status · POST /api/pispi/test (essai à blanc, n'écrit rien)
// Variables : PISPI_WEBHOOK_SECRET (≥ 32 car.) · PISPI_AUTO_MAX_XOF (défaut 200000) · PISPI_SMS_ENABLED · PISPI_SMS_SENDERS · PISPI_SMS_AUTO_MAX_XOF (défaut 50000)
//             PISPI_OK_STATUS (défaut ACSC,ACCC,ACSP,SETTLED,COMPLETED,SUCCESS,PAID,CONFIRMED) · PISPI_MAP (JSON facultatif : {"id":["data.txId"],"amount":["data.montant"],…})
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
const secret = () => String(process.env.PISPI_WEBHOOK_SECRET || "").trim();
const secretOk = () => secret().length >= 32;
const autoMax = () => num(process.env.PISPI_AUTO_MAX_XOF, 200000);
const smsMax = () => num(process.env.PISPI_SMS_AUTO_MAX_XOF, 50000);
const smsOn = () => ["on", "true", "1", "yes"].includes(String(process.env.PISPI_SMS_ENABLED || "off").toLowerCase());
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };

function adminOnly(req, res, next) {
  const e = String(process.env.ADMIN_KEY || "");
  if (!e || !safeEq(req.headers["x-admin-key"] || "", e)) return res.status(403).json({ error: "Accès refusé." });
  next();
}

const DEFAULT_MAP = {
  id: ["endToEndId", "txId", "transactionId", "id", "data.endToEndId", "data.txId", "data.transactionId", "data.id", "payload.endToEndId"],
  amount: ["amount", "montant", "amount.value", "data.amount", "data.amount.value", "data.montant", "payload.amount"],
  reference: ["reference", "motif", "remittanceInformation", "message", "data.reference", "data.motif", "data.remittanceInformation", "data.message", "payload.reference"],
  payer: ["payer", "debtor.name", "debtorName", "payerName", "data.payer", "data.debtor.name", "data.debtorName"],
  status: ["status", "statut", "state", "data.status", "data.statut", "data.state"],
  direction: ["direction", "type", "creditDebitIndicator", "data.direction", "data.type", "data.creditDebitIndicator"],
};
function mapping() {
  try { const m = JSON.parse(process.env.PISPI_MAP || "{}"); const out = { ...DEFAULT_MAP }; for (const k of Object.keys(DEFAULT_MAP)) if (Array.isArray(m[k]) && m[k].length) out[k] = m[k].map(String).slice(0, 10); return out; }
  catch (_) { return DEFAULT_MAP; }
}
const pick = (o, paths) => { for (const p of paths) { let v = o; for (const k of p.split(".")) { v = v == null ? undefined : v[k]; } if (v != null && typeof v !== "object") return v; } return undefined; };
const okStatus = () => new RegExp("^(" + String(process.env.PISPI_OK_STATUS || "ACSC,ACCC,ACSP,SETTLED,COMPLETED,SUCCESS,PAID,CONFIRMED").split(",").map((s) => s.trim().replace(/[^A-Za-z0-9_]/g, "")).filter(Boolean).join("|") + ")$", "i");

// Lecture d'une notification : renvoie ce qu'on comprend, SANS rien écrire.
function interpret(body) {
  const m = mapping(), why = [];
  const id = clean(pick(body, m.id), 120), amountRaw = pick(body, m.amount), reference = clean(pick(body, m.reference), 200), payer = clean(pick(body, m.payer), 120);
  const status = clean(pick(body, m.status), 40), direction = clean(pick(body, m.direction), 40);
  const amount = Math.floor(Number(String(amountRaw == null ? "" : amountRaw).replace(/[\s,]/g, "")));
  const om = (reference.toUpperCase().replace(/[\s\-_.]/g, "").match(/OM\d{11}/) || [null])[0];
  if (!id || id.length < 6) why.push("Identifiant d'opération introuvable (6 caractères minimum).");
  if (!Number.isFinite(amount) || amount < 1) why.push("Montant introuvable ou invalide.");
  if (direction && /(debit|dbit|out|sortant|emis|sent)/i.test(direction) && !/(credit|crdt|in\b|entrant|recu)/i.test(direction)) why.push("Cette notification est une SORTIE d'argent : ignorée.");
  let pending = false;
  if (status && !okStatus().test(status)) { pending = true; why.push(`Statut « ${status} » non final : en attente, rien n'est crédité.`); }
  return { id, amount: Number.isFinite(amount) ? amount : null, reference, omId: om, payer, status: status || null, direction: direction || null, problems: why, pending, accept: !why.length };
}

async function logActivity(action, detail) {
  try { await sql()`CREATE TABLE IF NOT EXISTS pispi_events (id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), source varchar(10) NOT NULL, outcome varchar(20) NOT NULL, external_id varchar(120), amount numeric(18,2), detail varchar(300))`;
    await sql()`INSERT INTO pispi_events (source, outcome, external_id, amount, detail) VALUES (${detail.source}, ${action}, ${detail.id || null}, ${detail.amount == null ? null : detail.amount}, ${clean(detail.note, 300) || null})`; } catch (e) { console.error("PISPI_LOG", e.message); }
}

async function process_(p, source, cap) {
  const ch = require("./channels.js");
  // Même opération reçue avec une autre casse = même opération (jamais de 2e crédit).
  try { const dup = await sql()`SELECT 1 FROM inbound_payments WHERE channel = 'pispi' AND lower(external_id) = lower(${p.id}) LIMIT 1`; if (dup.length) { await logActivity("duplicate", { source, id: p.id, amount: p.amount, note: "déjà reçu" }); return { http: 200, body: { duplicate: true } }; } } catch (_) { /* table pas encore créée : premier paiement */ }
  const r = await ch.ingest({ channel: "pispi", externalId: p.id, amount: p.amount, reference: p.omId || p.reference || null, payer: p.payer || null, source, autoMax: cap });
  const b = r.body;
  if (b.duplicate) { await logActivity("duplicate", { source, id: p.id, amount: p.amount, note: "déjà reçu" }); return { http: 200, body: { duplicate: true } }; }
  if (b.credited) { await logActivity("credited", { source, id: p.id, amount: p.amount, note: p.omId }); return { http: 201, body: { credited: true } }; }
  await logActivity(b.held ? "held" : "to_assign", { source, id: p.id, amount: p.amount, note: b.held ? `au-dessus du plafond automatique (${cap} F)` : "client non reconnu : à rapprocher" });
  return { http: 202, body: { credited: false, held: Boolean(b.held), matched: Boolean(b.matched) } };
}

router.post("/notify", async (req, res) => {
  try {
    if (!secretOk()) return res.status(503).json({ error: "Brancheur PI-SPI non configuré." });
    const sig = String(req.headers["x-pispi-signature"] || "").replace(/^sha256=/i, ""), tok = String(req.headers["x-pispi-token"] || "");
    const want = crypto.createHmac("sha256", secret()).update(req.rawBody || "").digest("hex");
    if (!((sig && safeEq(sig.toLowerCase(), want)) || (tok && safeEq(tok, secret())))) return res.status(401).json({ error: "Authentification invalide." });
    const p = interpret(req.body || {});
    if (!p.accept) { await logActivity("ignored", { source: "api", id: p.id, amount: p.amount, note: p.problems.join(" ") }); return res.status(p.pending && p.problems.length === 1 ? 202 : 422).json({ accepted: false, problems: p.problems }); }
    const r = await process_(p, "api", autoMax());
    res.status(r.http).json(r.body);
  } catch (e) { console.error("PISPI_NOTIFY", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/sms", async (req, res) => {
  try {
    if (!secretOk() || !smsOn()) return res.status(503).json({ error: "Relais SMS non activé." });
    if (!safeEq(req.headers["x-pispi-token"] || "", secret())) return res.status(401).json({ error: "Authentification invalide." });
    const senders = String(process.env.PISPI_SMS_SENDERS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!senders.length) return res.status(503).json({ error: "PISPI_SMS_SENDERS requis (expéditeurs autorisés)." });
    const from = clean(req.body?.sender || req.body?.from, 40).toLowerCase();
    if (!senders.includes(from)) { await logActivity("ignored", { source: "sms", note: "expéditeur non autorisé" }); return res.status(403).json({ error: "Expéditeur non autorisé." }); }
    const text = clean(req.body?.text || req.body?.message, 1000);
    const t = require("./channels.js").parseBankText(text);
    if (/SORTIE d'argent/.test(t.warnings.join(" "))) { await logActivity("ignored", { source: "sms", note: "SMS de débit" }); return res.status(200).json({ accepted: false, reason: "débit" }); }
    if (!t.amount) { await logActivity("ignored", { source: "sms", note: "montant illisible" }); return res.status(422).json({ accepted: false, reason: "montant illisible : à saisir à la main" }); }
    // Sans identifiant d'opération lisible : empreinte du texte (empêche un doublon) ET aucun crédit automatique (plafond 0).
    const synthetic = !t.externalId || t.externalId.length < 6;
    const id = synthetic ? "SMS-" + crypto.createHash("sha256").update(text).digest("hex").slice(0, 24) : t.externalId;
    const r = await process_({ id, amount: t.amount, omId: t.omId, reference: t.omId, payer: t.payer }, "sms", synthetic ? 0 : smsMax());
    res.status(r.http).json(r.body);
  } catch (e) { console.error("PISPI_SMS", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/test", adminOnly, (req, res) => {
  const body = typeof req.body?.payload === "string" ? (() => { try { return JSON.parse(req.body.payload); } catch (_) { return null; } })() : req.body?.payload;
  if (!body || typeof body !== "object") return res.status(400).json({ error: "Collez un JSON valide." });
  const p = interpret(body);
  res.json({ ...p, decision: p.accept ? (p.omId ? (p.amount <= autoMax() ? "crédit automatique du client" : `en attente de validation (au-dessus de ${autoMax()} F)`) : "à rapprocher (aucun identifiant OM dans le motif)") : "ignoré", note: "Essai à blanc : rien n'a été enregistré." });
});

router.get("/status", adminOnly, async (req, res) => {
  const out = { secretConfigured: secretOk(), smsEnabled: smsOn(), smsSenders: String(process.env.PISPI_SMS_SENDERS || "").split(",").map((s) => s.trim()).filter(Boolean), autoMaxXof: autoMax(), smsAutoMaxXof: smsMax(), mapping: mapping(), today: null, last: [], lastReceivedAt: null };
  try {
    const q = sql();
    out.today = (await q`SELECT count(*)::int AS n, coalesce(sum(amount),0)::float AS total, count(*) FILTER (WHERE status = 'credited')::int AS credited, count(*) FILTER (WHERE status = 'received')::int AS waiting FROM inbound_payments WHERE channel = 'pispi' AND created_at >= date_trunc('day', now())`)[0];
    out.lastReceivedAt = (await q`SELECT max(created_at) AS t FROM inbound_payments WHERE channel = 'pispi'`)[0].t;
  } catch (_) { /* table pas encore créée : aucun paiement reçu */ }
  try { out.last = await sql()`SELECT at, source, outcome, external_id, amount::float AS amount, detail FROM pispi_events ORDER BY id DESC LIMIT 15`; } catch (_) { /* aucun événement */ }
  res.json(out);
});

module.exports = router;
module.exports._interpret = interpret;
