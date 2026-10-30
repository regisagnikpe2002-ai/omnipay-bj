"use strict";
// OMNIPAY — diagnostic d'envoi e-mail (admin). Ne renvoie JAMAIS de mot de passe ni de clé : seulement « présent / absent » et l'erreur du fournisseur.
// GET  /api/email-diag/status      → méthode utilisée (Brevo / Resend / SMTP), variables manquantes, test de connexion SMTP
// POST /api/email-diag/send-test   → { to } envoie un vrai e-mail de test et renvoie la réponse du fournisseur
const crypto = require("crypto");
const express = require("express");
const router = express.Router();

function adminOnly(req, res, next) {
  const provided = Buffer.from(String(req.headers["x-admin-key"] || ""));
  const expected = Buffer.from(String(process.env.ADMIN_KEY || ""));
  if (!expected.length || provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return res.status(403).json({ error: "Accès refusé." });
  }
  next();
}
const has = (n) => Boolean((process.env[n] || "").trim());

function plan() {
  const method = has("BREVO_API_KEY") ? "brevo-api" : has("RESEND_API_KEY") ? "resend-api" : "smtp";
  const from = (process.env.MAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || "").trim();
  const need = method === "smtp" ? ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM"] : ["MAIL_FROM"];
  const missing = need.filter((n) => !has(n) && !(n === "MAIL_FROM" && (has("SMTP_FROM") || has("SMTP_USER"))));
  const tips = [];
  if (method === "smtp") {
    if (has("SMTP_HOST") && !/brevo|sendinblue/i.test(process.env.SMTP_HOST) && /brevo/i.test(process.env.SMTP_USER || "")) tips.push("SMTP_USER est un identifiant Brevo mais SMTP_HOST n'est pas smtp-relay.brevo.com.");
    if (has("SMTP_PORT") && !["587", "465", "25", "2525"].includes(String(process.env.SMTP_PORT).trim())) tips.push("SMTP_PORT inhabituel : utilisez 587.");
    if (/gmail/i.test(process.env.SMTP_HOST || "")) tips.push("Gmail refuse les mots de passe normaux (erreur 535) : utilisez Brevo.");
  }
  if (!/@/.test(from)) tips.push("L'expéditeur (SMTP_FROM / MAIL_FROM) doit être une adresse complète, par ex. OMNIPAY <contact@omnipay-bj.com>.");
  else if (/@(gmail|yahoo|outlook|hotmail)\./i.test(from)) tips.push("Expéditeur gratuit (gmail…) : les messages tombent souvent en spam. Utilisez une adresse @omnipay-bj.com validée dans Brevo (SPF/DKIM).");
  return { method, from: from || null, missing, tips };
}

router.get("/status", adminOnly, async (req, res) => {
  const p = plan();
  const out = { method: p.method, from: p.from, configured: p.missing.length === 0, missing: p.missing, tips: p.tips,
    present: Object.fromEntries(["BREVO_API_KEY", "RESEND_API_KEY", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM", "MAIL_FROM"].map((n) => [n, has(n)])) };
  if (p.method === "smtp" && out.configured) {
    try { await require("../services/emailService").verifyEmailTransport(); out.smtpConnection = "OK"; }
    catch (e) { out.smtpConnection = "ÉCHEC"; out.smtpError = String(e.message || e).slice(0, 200); if (/535|auth/i.test(out.smtpError)) out.tips.push("Identifiant ou clé SMTP refusés : régénérez la clé SMTP dans Brevo (SMTP & API) et recollez-la dans SMTP_PASSWORD."); }
  }
  res.json(out);
});

router.post("/send-test", adminOnly, async (req, res) => {
  const to = String((req.body && req.body.to) || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return res.status(400).json({ error: "Adresse e-mail invalide." });
  const p = plan();
  if (p.missing.length) return res.status(400).json({ error: "Configuration incomplète.", missing: p.missing });
  try {
    const r = await require("../services/emailService").sendOtpEmail({ email: to, code: "000000", expiresInMinutes: 5 });
    res.json({ sent: true, method: p.method, accepted: r.accepted || [to], rejected: r.rejected || [], messageId: r.messageId || null,
      note: "E-mail de test (code 000000). S'il n'arrive pas dans 2 minutes : vérifiez le dossier spam et que l'expéditeur est validé dans Brevo." });
  } catch (e) {
    console.error("EMAIL_DIAG", e.message);
    res.status(502).json({ sent: false, method: p.method, error: String(e.message || e).slice(0, 300) });
  }
});

module.exports = router;
