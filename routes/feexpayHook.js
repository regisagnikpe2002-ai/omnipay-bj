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
  if (!ready) ready = sql()`CREATE TABLE IF NOT EXISTS feexpay_events (id bigserial PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now(),
    verified boolean NOT NULL DEFAULT false, event text, body text, headers jsonb)`.catch((e) => { ready = null; throw e; });
  return ready;
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
// Signature : HMAC-SHA256 du corps brut avec le secret, en hexadécimal ou en base64, éventuellement précédée de « sha256= » ou « v1= ».
function verify(raw, headers) {
  const secret = String(process.env.FEEXPAY_WEBHOOK_SECRET || "").trim();
  if (!secret || !raw) return false;
  const mac = crypto.createHmac("sha256", secret).update(raw).digest();
  const cands = [mac.toString("hex"), mac.toString("base64")];
  for (const [k, v] of Object.entries(headers)) {
    if (!/sig|hmac|signature/i.test(k)) continue;
    for (const part of String(v).split(",")) {
      const val = part.trim().replace(/^(sha256=|v1=)/i, "");
      if (cands.some((c) => safeEq(val, c))) return true;
    }
  }
  return false;
}
const keepHeaders = (h) => { const o = {}; for (const [k, v] of Object.entries(h)) if (/^(content-type|user-agent)$/i.test(k) || /sig|hmac|signature|webhook|feexpay|event|timestamp/i.test(k)) o[k] = String(v).slice(0, 300); return o; };

router.post("/webhook", async (req, res) => {
  try {
    await ensure();
    const raw = typeof req.rawBody === "string" ? req.rawBody : JSON.stringify(req.body || {});
    const ok = verify(raw, req.headers);
    const ev = req.body && typeof req.body === "object" ? String(req.body.event || req.body.type || req.body.status || "").slice(0, 80) : "";
    const q = sql();
    await q`INSERT INTO feexpay_events (verified, event, body, headers) VALUES (${ok}, ${ev || null}, ${raw.slice(0, 20000)}, ${JSON.stringify(keepHeaders(req.headers))}::jsonb)`;
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
