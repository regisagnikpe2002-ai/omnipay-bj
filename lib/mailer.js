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

async function sendAdminNotification(subject, html) {
  try {
    if (!fromAddr() || !toAddr()) return; // rien de configuré : on ignore sans bruit
    const brevo = (process.env.BREVO_API_KEY || "").trim(), resend = (process.env.RESEND_API_KEY || "").trim();
    if (brevo || resend) { // API HTTPS (même réglage que les codes OTP)
      const raw = (process.env.MAIL_FROM || fromAddr()).trim(), m = raw.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/), f = m ? { name: m[1].trim() || "OMNIPAY", email: m[2].trim() } : { name: "OMNIPAY", email: raw };
      const r = brevo
        ? await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": brevo, "content-type": "application/json" }, body: JSON.stringify({ sender: f, to: [{ email: toAddr() }], subject, htmlContent: html }) })
        : await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: "Bearer " + resend, "content-type": "application/json" }, body: JSON.stringify({ from: `${f.name} <${f.email}>`, to: [toAddr()], subject, html }) });
      if (!r.ok) throw new Error("API e-mail " + r.status);
      return;
    }
    await transporter.sendMail({ from: fromAddr(), to: toAddr(), subject, html });
  } catch (err) {
    console.error("Erreur envoi notification admin:", err.message);
  }
}

module.exports = { transporter, sendAdminNotification };
