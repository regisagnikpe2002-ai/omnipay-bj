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

async function sendOtpEmail({ email, code, expiresInMinutes }) {
  const transporter = createTransporter();

  const result = await transporter.sendMail({
    from: required("SMTP_FROM"),
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
          </div>
        </div>
      </div>
    `,
  });
console.log("SMTP_RESULT", {
  accepted: result.accepted,
  rejected: result.rejected,
  response: result.response,
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
