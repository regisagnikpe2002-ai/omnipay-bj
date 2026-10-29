const nodemailer = require("nodemailer");

function required(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Variable manquante : ${name}`);
  }

  return value;
}

function createTransporter() {
  const port = Number(process.env.SMTP_PORT || 587);

  return nodemailer.createTransport({
    host: required("SMTP_HOST"),
    port,
    secure: port === 465,
    auth: {
      user: required("SMTP_USER"),
      pass: required("SMTP_PASSWORD"),
    },
  });
}

async function verifyEmailTransport() {
  const transporter = createTransporter();
  await transporter.verify();
  return true;
}

// Envoi : 1) Brevo (BREVO_API_KEY) 2) Resend (RESEND_API_KEY) 3) SMTP (SMTP_*). Les API HTTPS sont plus fiables que Gmail (pas de blocage, pas de limite de 500/jour).
function fromParts() {
  const raw = (process.env.MAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || "").trim();
  const m = raw.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
  return m ? { name: m[1].trim() || "OMNIPAY", email: m[2].trim() } : { name: "OMNIPAY", email: raw };
}
async function deliver(mail) {
  const brevo = (process.env.BREVO_API_KEY || "").trim();
  const resend = (process.env.RESEND_API_KEY || "").trim();
  if (brevo || resend) {
    const f = fromParts();
    if (!f.email) throw new Error("Variable manquante : MAIL_FROM ou SMTP_FROM");
    const r = brevo
      ? await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": brevo, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ sender: f, to: [{ email: mail.to }], subject: mail.subject, htmlContent: mail.html, textContent: mail.text }) })
      : await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: "Bearer " + resend, "content-type": "application/json" },
          body: JSON.stringify({ from: `${f.name} <${f.email}>`, to: [mail.to], subject: mail.subject, html: mail.html, text: mail.text }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Envoi e-mail refusé (${brevo ? "Brevo" : "Resend"} ${r.status}) : ${String(body.message || body.error || "").slice(0, 160)}`);
    return { messageId: body.messageId || body.id || null, accepted: [mail.to], rejected: [] };
  }
  return createTransporter().sendMail({ ...mail, from: required("SMTP_FROM") });
}

async function sendOtpEmail({ email, code, expiresInMinutes }) {
  const result = await deliver({
    to: email,
    subject: "Votre code de vérification OMNIPAY",
    text: [
      "OMNIPAY",
      "",
      `Votre code de vérification est : ${code}`,
      `Ce code expire dans ${expiresInMinutes} minute(s).`,
      "",
      "Ne partagez jamais ce code avec une autre personne.",
      "",
      "Ouvrir OMNIPAY : https://www.omnipay-bj.com",
      "",
      "OMNIPAY",
      "Votre quotidien financier tout-en-un",
    ].join("\n"),
    html: `
      <div style="background:#f4f7fb;padding:32px;font-family:Arial,sans-serif;color:#0f172a">
        <div style="max-width:520px;margin:auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 12px 35px rgba(15,23,42,.10)">
          <div style="padding:28px;background:linear-gradient(135deg,#0f172a,#1d4ed8,#10b981);color:#fff">
            <div style="font-size:26px;font-weight:800;letter-spacing:1px">
              OMNIPAY
            </div>
            <div style="margin-top:6px;opacity:.88">
              Votre quotidien financier tout-en-un
            </div>
          </div>

          <div style="padding:32px">
            <h1 style="font-size:22px;margin:0 0 14px">
              Vérification de votre adresse email
            </h1>

            <p style="line-height:1.6;color:#475569">
              Utilisez le code suivant pour confirmer votre adresse email :
            </p>

            <div style="margin:28px 0;padding:20px;text-align:center;background:#eff6ff;border:1px solid #bfdbfe;border-radius:16px;font-size:34px;font-weight:800;letter-spacing:8px;color:#1d4ed8">
              ${code}
            </div>

            <p style="line-height:1.6;color:#475569">
              Ce code expire dans
              <strong>${expiresInMinutes} minute(s)</strong>.
            </p>

            <p style="line-height:1.6;color:#b91c1c;font-weight:600">
              Ne communiquez jamais ce code à une autre personne.
            </p>

            <p style="text-align:center;margin:26px 0 4px">
              <a href="https://www.omnipay-bj.com" style="display:inline-block;background:#10b981;color:#052e22;text-decoration:none;font-weight:700;padding:13px 26px;border-radius:12px">Ouvrir OMNIPAY</a>
            </p>
            <p style="text-align:center;font-size:13px;color:#64748b;margin:8px 0 0">
              ou copiez ce lien : <a href="https://www.omnipay-bj.com" style="color:#1d4ed8">https://www.omnipay-bj.com</a>
            </p>
          </div>
        </div>
      </div>
    `,
  });

  return {
    messageId: result.messageId,
    accepted: result.accepted,
    rejected: result.rejected,
  };
}

module.exports = {
  sendOtpEmail,
  verifyEmailTransport,
};
