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

const fromAddr = () => process.env.SMTP_FROM || (process.env.EMAIL_USER ? `"OMNIPAY" <${process.env.EMAIL_USER}>` : "");
const toAddr = () => process.env.ADMIN_NOTIFY_EMAIL || process.env.EMAIL_USER || process.env.SMTP_USER;

async function sendAdminNotification(subject, html) {
  try {
    if (!fromAddr() || !toAddr()) return; // rien de configuré : on ignore sans bruit
    await transporter.sendMail({ from: fromAddr(), to: toAddr(), subject, html });
  } catch (err) {
    console.error("Erreur envoi notification admin:", err.message);
  }
}

module.exports = { transporter, sendAdminNotification };
