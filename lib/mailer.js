const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

async function sendAdminNotification(subject, html) {
  try {
    await transporter.sendMail({
      from: `"OMNIPAY" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_USER,
      subject,
      html,
    });
  } catch (err) {
    console.error("Erreur envoi notification admin:", err);
  }
}

module.exports = { transporter, sendAdminNotification };
