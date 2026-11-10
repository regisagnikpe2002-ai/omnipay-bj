"use strict";
// OMNIPAY — CODE OTP À CHAQUE TRANSACTION (e-mail + SMS). FICHIER AJOUTÉ.
// Principe : toute opération qui touche à l'argent (retrait, transfert, achat, recharge, crypto, abonnement, paiement…) exige un code à 6 chiffres
// envoyé sur l'e-mail ET le numéro du client. Le code donne un jeton à usage unique, valable 5 minutes, lié au client.
//   POST /api/otp/request  {action?}            envoie le code (e-mail + SMS), renvoie challengeId et les contacts masqués
//   POST /api/otp/verify   {challengeId, code}  contrôle le code, renvoie {token} à joindre à l'opération (en-tête x-otp-token)
//   GET  /api/otp/admin/status                  (clé admin) canaux actifs et activité récente
// Le contrôle est fait par un garde (otp.guard) monté AVANT les routes : aucune route existante n'est modifiée.
// Réglages Render :
//   OTP_ENFORCE=off        coupe l'exigence (par défaut actif, mais seulement si un canal d'envoi fonctionne : jamais de client bloqué sans moyen de recevoir le code)
//   OTP_TTL_MIN (5) · OTP_TOKEN_MIN (5) · OTP_MAX_ATTEMPTS (5) · OTP_RESEND_SEC (45) · OTP_MAX_PER_HOUR (8) · OTP_SECRET (sinon JWT_SECRET)
//   E-mail : le même envoi que les codes d'inscription (services/emailService).
//   SMS : SMS_PROVIDER=twilio (TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM) ou SMS_PROVIDER=infobip (INFOBIP_BASE, INFOBIP_KEY, SMS_SENDER). SMS_COUNTRY_CODE (229).
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const secret = () => process.env.OTP_SECRET || process.env.JWT_SECRET || "omnipay-otp";
const h = (s) => crypto.createHmac("sha256", secret()).update(String(s)).digest("hex");
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const UUID = /^[0-9a-f-]{36}$/i;
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };

// ---------- canaux ----------
const emailOn = () => Boolean(process.env.BREVO_API_KEY || process.env.RESEND_API_KEY || (process.env.SMTP_HOST && process.env.SMTP_USER) || process.env.EMAIL_USER);
const smsProvider = () => String(process.env.SMS_PROVIDER || "").toLowerCase();
const smsOn = () => { const p = smsProvider();
  if (p === "twilio") return Boolean(process.env.TWILIO_SID && process.env.TWILIO_TOKEN && process.env.TWILIO_FROM);
  if (p === "infobip") return Boolean(process.env.INFOBIP_BASE && process.env.INFOBIP_KEY);
  return false; };
const enforced = () => String(process.env.OTP_ENFORCE || "on").toLowerCase() !== "off" && (emailOn() || smsOn());
const isDemo = () => { try { return require("../lib/appMode").isDemo(); } catch (_) { return String(process.env.APP_MODE || "").toLowerCase() === "demo"; } };

function e164(phone) {
  let p = String(phone || "").trim(); if (!p) return null;
  const plus = p.startsWith("+"); p = p.replace(/\D/g, ""); if (!p) return null;
  if (p.startsWith("00")) p = p.slice(2);
  else if (!plus) { const cc = String(process.env.SMS_COUNTRY_CODE || "229"); if (!p.startsWith(cc)) p = cc + p; }
  return p.length >= 8 && p.length <= 15 ? "+" + p : null;
}
const maskMail = (m) => { const [a, b] = String(m || "").split("@"); return b ? a.slice(0, 2) + "•••@" + b : ""; };
const maskTel = (t) => (t ? "••••" + String(t).slice(-3) : "");

async function sendSms(to, text) {
  const p = smsProvider();
  if (p === "twilio") {
    const auth = Buffer.from(process.env.TWILIO_SID + ":" + process.env.TWILIO_TOKEN).toString("base64");
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`, { method: "POST", headers: { authorization: "Basic " + auth, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM, Body: text }).toString() });
    if (!r.ok) throw new Error("SMS Twilio " + r.status); return;
  }
  if (p === "infobip") {
    const base = String(process.env.INFOBIP_BASE).replace(/^https?:\/\//, "").replace(/\/$/, "");
    const r = await fetch(`https://${base}/sms/2/text/advanced`, { method: "POST", headers: { authorization: "App " + process.env.INFOBIP_KEY, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ messages: [{ destinations: [{ to: to.replace("+", "") }], from: process.env.SMS_SENDER || "OMNIPAY", text }] }) });
    if (!r.ok) throw new Error("SMS Infobip " + r.status); return;
  }
  throw new Error("SMS non configuré");
}
async function sendMail(email, code, mins) { return require("../services/emailService").sendOtpEmail({ email, code, expiresInMinutes: mins }); }

// ---------- stockage ----------
let ready = false;
async function ensure() {
  if (ready) return;
  await sql()`CREATE TABLE IF NOT EXISTS otp_tx (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, action varchar(40), code_hash varchar(64) NOT NULL, expires_at timestamptz NOT NULL,
    attempts int NOT NULL DEFAULT 0, token_hash varchar(64), token_exp timestamptz, used_at timestamptz, via varchar(20), created_at timestamptz NOT NULL DEFAULT now())`;
  await sql()`CREATE INDEX IF NOT EXISTS otp_tx_user ON otp_tx (user_id, created_at DESC)`;
  ready = true;
}

router.post("/request", requireAuth, async (req, res) => {
  try {
    await ensure(); const uid = req.user.userId, q = sql();
    const [u] = await q`SELECT email, phone FROM users WHERE id = ${uid}::uuid`;
    if (!u) return res.status(404).json({ error: "Compte introuvable." });
    const tel = e164(u.phone), canMail = emailOn() && u.email, canSms = smsOn() && tel;
    if (!canMail && !canSms) return res.status(503).json({ error: "Envoi du code momentanément indisponible. Réessayez dans quelques minutes." });
    const [last] = await q`SELECT extract(epoch FROM now() - created_at)::int AS age FROM otp_tx WHERE user_id = ${uid}::uuid ORDER BY created_at DESC LIMIT 1`;
    if (last && last.age < num("OTP_RESEND_SEC", 45)) return res.status(429).json({ error: "Patientez un instant avant de redemander un code.", retryAfter: num("OTP_RESEND_SEC", 45) - last.age });
    const [hr] = await q`SELECT count(*)::int AS n FROM otp_tx WHERE user_id = ${uid}::uuid AND created_at > now() - interval '1 hour'`;
    if (hr.n >= num("OTP_MAX_PER_HOUR", 8)) return res.status(429).json({ error: "Trop de demandes. Réessayez plus tard." });
    const mins = num("OTP_TTL_MIN", 5), code = String(crypto.randomInt(0, 1000000)).padStart(6, "0"), id = crypto.randomUUID();
    await q`UPDATE otp_tx SET used_at = now() WHERE user_id = ${uid}::uuid AND used_at IS NULL`;
    const via = []; const jobs = [];
    if (canMail) jobs.push(sendMail(u.email, code, mins).then(() => via.push("email")).catch((e) => console.error("OTP_MAIL", e.message)));
    if (canSms) jobs.push(sendSms(tel, `OMNIPAY : votre code est ${code}. Valable ${mins} min. Ne le partagez jamais.`).then(() => via.push("sms")).catch((e) => console.error("OTP_SMS", e.message)));
    await Promise.all(jobs);
    if (!via.length) return res.status(502).json({ error: "Le code n'a pas pu être envoyé. Réessayez dans un instant." });
    await q`INSERT INTO otp_tx (id, user_id, action, code_hash, expires_at, via) VALUES (${id}::uuid, ${uid}::uuid, ${String((req.body || {}).action || "").slice(0, 40)}, ${h(id + ":" + code)}, now() + make_interval(mins => ${mins}::int), ${via.join("+")})`;
    res.status(201).json({ challengeId: id, expiresIn: mins * 60, channels: via, to: { email: via.includes("email") ? maskMail(u.email) : null, phone: via.includes("sms") ? maskTel(tel) : null } });
  } catch (e) { console.error("OTP_REQ", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.post("/verify", requireAuth, async (req, res) => {
  try {
    await ensure(); const uid = req.user.userId, b = req.body || {}, id = String(b.challengeId || ""), code = String(b.code || "").replace(/\D/g, "");
    if (!UUID.test(id) || code.length !== 6) return res.status(400).json({ error: "Code à 6 chiffres requis." });
    const [c] = await sql()`SELECT * FROM otp_tx WHERE id = ${id}::uuid AND user_id = ${uid}::uuid`;
    if (!c || c.used_at || c.token_hash || new Date(c.expires_at) < new Date()) return res.status(400).json({ error: "Code expiré. Demandez-en un nouveau." });
    if (c.attempts >= num("OTP_MAX_ATTEMPTS", 5)) return res.status(429).json({ error: "Trop d'essais. Demandez un nouveau code." });
    if (!eq(h(id + ":" + code), c.code_hash)) { await sql()`UPDATE otp_tx SET attempts = attempts + 1 WHERE id = ${id}::uuid`; return res.status(400).json({ error: "Code incorrect." }); }
    const token = crypto.randomBytes(24).toString("hex"), mins = num("OTP_TOKEN_MIN", 5);
    await sql()`UPDATE otp_tx SET token_hash = ${h("t:" + token)}, token_exp = now() + make_interval(mins => ${mins}::int) WHERE id = ${id}::uuid`;
    res.json({ token, expiresIn: mins * 60 });
  } catch (e) { console.error("OTP_VER", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.get("/admin/status", (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." })), async (req, res) => {
  try {
    await ensure(); const [s] = await sql()`SELECT count(*)::int AS sent, count(*) FILTER (WHERE token_hash IS NOT NULL)::int AS verified, count(*) FILTER (WHERE used_at IS NOT NULL AND token_hash IS NOT NULL)::int AS consumed FROM otp_tx WHERE created_at > now() - interval '24 hours'`;
    res.json({ enforced: enforced(), email: emailOn(), sms: smsOn(), smsProvider: smsProvider() || null, last24h: s });
  } catch (e) { console.error("OTP_ADM", e.message); res.status(500).json({ error: "Erreur." }); }
});

// ---------- garde : exige le jeton OTP sur les routes d'argent ----------
const GUARDED = [/^\/wallet\/(transfer|withdraw|deposit)$/, /^\/api\/exchange\/(buy|sell|withdraw|deposit)$/, /^\/api\/bundles\/order$/, /^\/api\/vn\/rent$/, /^\/api\/omnicash\/cashout\/request$/,
  /^\/api\/notify\/subscribe$/, /^\/api\/omniwallet\/book$/, /^\/api\/linked\/?$/, /^\/api\/business\/checkout\/[^/]+\/pay$/];
function guard(req, res, next) {
  if (req.method !== "POST" || !enforced() || isDemo()) return next();
  const p = req.path.replace(/\/+$/, "") || "/";
  if (!GUARDED.some((r) => r.test(p))) return next();
  requireAuth(req, res, async () => {
    try {
      await ensure(); const tok = String(req.headers["x-otp-token"] || "");
      if (/^[0-9a-f]{48}$/.test(tok)) {
        const r = await sql()`UPDATE otp_tx SET used_at = now() WHERE token_hash = ${h("t:" + tok)} AND user_id = ${req.user.userId}::uuid AND used_at IS NULL AND token_exp > now() RETURNING id`;
        if (r.length) return next();
      }
      res.status(428).json({ otpRequired: true, error: "Confirmez l'opération avec le code reçu par e-mail et SMS.", action: p });
    } catch (e) { console.error("OTP_GUARD", e.message); res.status(503).json({ error: "Vérification indisponible. Réessayez." }); }
  });
}

module.exports = router;
module.exports.guard = guard;
module.exports._e164 = e164;
module.exports._enforced = enforced;
