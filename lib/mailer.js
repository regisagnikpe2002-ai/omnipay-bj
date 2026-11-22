const nodemailer = require("nodemailer");

// Même configuration que les codes OTP (SMTP_*) ; à défaut, ancien réglage Gmail (EMAIL_USER / EMAIL_PASS).
function build() {
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD) {
    const port = Number(process.env.SMTP_PORT || 587);
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST, port, secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    });
  }
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
}
const transporter = build();

const fromAddr = () => process.env.MAIL_FROM || process.env.SMTP_FROM || (process.env.EMAIL_USER ? `"OMNIPAY" <${process.env.EMAIL_USER}>` : "");
const toAddr = () => process.env.ADMIN_NOTIFY_EMAIL || process.env.EMAIL_USER || process.env.SMTP_USER;

// Envoi générique : Brevo (API HTTPS), sinon Resend, sinon SMTP. Ne lève jamais d'erreur (un e-mail raté ne doit pas casser une opération).
async function sendMail(to, subject, html) {
  try {
    if (require("./appMode").isDemo()) { console.log("[DÉMO] e-mail non envoyé :", subject); return false; }
    if (!fromAddr() || !to) return false; // rien de configuré : on ignore sans bruit
    const brevo = (process.env.BREVO_API_KEY || "").trim(), resend = (process.env.RESEND_API_KEY || "").trim();
    if (brevo || resend) {
      const raw = (process.env.MAIL_FROM || fromAddr()).trim(), m = raw.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/), f = m ? { name: m[1].trim() || "OMNIPAY", email: m[2].trim() } : { name: "OMNIPAY", email: raw };
      const r = brevo
        ? await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": brevo, "content-type": "application/json" }, body: JSON.stringify({ sender: f, to: [{ email: to }], subject, htmlContent: html }) })
        : await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: "Bearer " + resend, "content-type": "application/json" }, body: JSON.stringify({ from: `${f.name} <${f.email}>`, to: [to], subject, html }) });
      if (!r.ok) throw new Error("API e-mail " + r.status);
      return true;
    }
    await transporter.sendMail({ from: fromAddr(), to, subject, html });
    return true;
  } catch (err) {
    console.error("Erreur envoi e-mail:", err.message);
    return false;
  }
}
const sendAdminNotification = (subject, html) => sendMail(toAddr(), subject, html);
const esc = (v) => String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Notification client : mise en page simple et sobre, texte échappé. Ne contient JAMAIS de code de carte ni de secret.
const sendUserNotification = (to, subject, lines) => sendMail(to, subject,
  `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#111"><h2 style="color:#0a7a4a">OMNIPAY</h2>${lines.map((l) => `<p>${esc(l)}</p>`).join("")}<p style="color:#666;font-size:12px">Message automatique d'OMNIPAY. Ne répondez pas à cet e-mail.</p></div>`);

module.exports = { transporter, sendMail, sendAdminNotification, sendUserNotification };
