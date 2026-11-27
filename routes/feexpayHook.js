"use strict";
// OMNIPAY — Réception des webhooks FeexPay (ENREGISTREMENT SEUL). FICHIER AJOUTÉ.
// Cette route ne crédite ni ne débite RIEN : elle garde chaque notification reçue (corps, signature vérifiée ou non) pour que l'on voie
// le format réel envoyé par FeexPay. Le crédit automatique sera branché ensuite, sur ce format réel.
//   POST /api/feexpay/webhook   (public ; FeexPay y envoie ses événements)   GET /api/feexpay/events   (admin, x-admin-key)
// Réglage Render : FEEXPAY_WEBHOOK_SECRET = le secret HMAC affiché une seule fois par FeexPay à la création du webhook.
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const KEEP = 500;
let ready = null;
function ensure() {
  if (!ready) ready = (async () => {
    const q = sql();
    await q`CREATE TABLE IF NOT EXISTS feexpay_events (id bigserial PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now(),
      verified boolean NOT NULL DEFAULT false, event text, body text, headers jsonb, delivery_id text)`;
    await q`ALTER TABLE feexpay_events ADD COLUMN IF NOT EXISTS delivery_id text`;
    await q`CREATE UNIQUE INDEX IF NOT EXISTS feexpay_events_delivery ON feexpay_events (delivery_id) WHERE delivery_id IS NOT NULL`;
  })().catch((e) => { ready = null; throw e; });
  return ready;
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
// Signature FeexPay (documentée dans leur tableau de bord) : HMAC-SHA256 en hexadécimal de « timestamp.delivery_id.corps_brut »,
// comparée à x-feexpay-signature (une ou plusieurs valeurs séparées par des virgules, préfixe « v1= » possible).
// Refusée si l'heure signée s'écarte de plus de 300 s (anti-rejeu). x-feexpay-delivery-id sert à ignorer les doublons.
function verify(raw, headers, nowMs = Date.now()) {
  const secret = String(process.env.FEEXPAY_WEBHOOK_SECRET || "").trim();
  const ts = headers["x-feexpay-timestamp"], id = headers["x-feexpay-delivery-id"];
  if (!secret || !raw || !ts || !id) return false;
  if (!Number.isFinite(Number(ts)) || Math.abs(nowMs / 1000 - Number(ts)) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${ts}.${id}.`).update(raw).digest("hex");
  return String(headers["x-feexpay-signature"] || "").split(",").some((e) => safeEq(e.trim().replace(/^v1=/, ""), expected));
}
const keepHeaders = (h) => { const o = {}; for (const [k, v] of Object.entries(h)) if (/^(content-type|user-agent)$/i.test(k) || /sig|hmac|signature|webhook|feexpay|event|timestamp/i.test(k)) o[k] = String(v).slice(0, 300); return o; };

router.post("/webhook", async (req, res) => {
  try {
    await ensure();
    const raw = typeof req.rawBody === "string" ? req.rawBody : JSON.stringify(req.body || {});
    const ok = verify(raw, req.headers);
    const ev = String(req.headers["x-feexpay-event"] || (req.body && typeof req.body === "object" ? req.body.event || req.body.type || req.body.status : "") || "").slice(0, 80);
    const did = String(req.headers["x-feexpay-delivery-id"] || "").slice(0, 120) || null;
    const q = sql();
    await q`INSERT INTO feexpay_events (verified, event, body, headers, delivery_id) VALUES (${ok}, ${ev || null}, ${raw.slice(0, 20000)}, ${JSON.stringify(keepHeaders(req.headers))}::jsonb, ${did}) ON CONFLICT DO NOTHING`;
    await q`DELETE FROM feexpay_events WHERE id <= (SELECT max(id) FROM feexpay_events) - ${KEEP}`;
  } catch (e) { console.error("FEEXPAY_WEBHOOK", e.message); }
  res.status(200).json({ ok: true }); // toujours 2xx : FeexPay réessaie sinon
});

router.get("/events", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Accès refusé." });
  try {
    await ensure();
    const rows = await sql()`SELECT id, received_at, verified, event, body, headers FROM feexpay_events ORDER BY id DESC LIMIT 50`;
    res.json({ secretSet: Boolean(process.env.FEEXPAY_WEBHOOK_SECRET), events: rows });
  } catch (e) { console.error("FEEXPAY_EVENTS", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;
module.exports._verify = verify;
