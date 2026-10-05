const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");
const { sendOtpEmail } = require("../services/emailService");

const OTP_TTL_MINUTES = Number(process.env.OTP_TTL_MINUTES || 5);
const OTP_RESEND_SECONDS = Number(process.env.OTP_RESEND_SECONDS || 60);
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5);

function getSql() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL manquante.");
  }

  return neon(process.env.DATABASE_URL);
}

function getOtpSecret() {
  const secret = process.env.OTP_SECRET?.trim();

  if (!secret || secret.length < 32) {
    throw new Error("OTP_SECRET doit contenir au moins 32 caractères.");
  }

  return secret;
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Adresse email invalide.");
  }

  return email;
}

function normalizePurpose(value) {
  const purpose = String(value || "register").trim().toLowerCase();

  const allowed = [
    "register",
    "login",
    "password_reset",
    "transaction",
  ];

  if (!allowed.includes(purpose)) {
    throw new Error("Utilisation OTP invalide.");
  }

  return purpose;
}

function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

function hashOtp({ challengeId, email, purpose, code }) {
  return crypto
    .createHmac("sha256", getOtpSecret())
    .update(`${challengeId}:${email}:${purpose}:${code}`)
    .digest("hex");
}

function safeCompareHex(left, right) {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createVerificationProof({ email, purpose }) {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 10 * 60 * 1000;

  const payload = Buffer.from(
    JSON.stringify({
      email,
      purpose,
      issuedAt,
      expiresAt,
    })
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", getOtpSecret())
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

async function requestEmailOtp(req, res) {
  const sql = getSql();
  let challengeId = null;

  try {
    const email = normalizeEmail(req.body?.email);
    const purpose = normalizePurpose(req.body?.purpose);

    const recent = await sql`
      SELECT created_at
      FROM email_otp_challenges
      WHERE email = ${email}
        AND purpose = ${purpose}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    if (recent.length > 0) {
      const createdAt = new Date(recent[0].created_at).getTime();
      const elapsedSeconds = Math.floor((Date.now() - createdAt) / 1000);

      if (elapsedSeconds < OTP_RESEND_SECONDS) {
        return res.status(429).json({
          success: false,
          error: "Veuillez patienter avant de demander un nouveau code.",
          retryAfter: OTP_RESEND_SECONDS - elapsedSeconds,
        });
      }
    }

    challengeId = crypto.randomUUID();
    const code = generateOtp();
    const codeHash = hashOtp({
      challengeId,
      email,
      purpose,
      code,
    });

    const expiresAt = new Date(
      Date.now() + OTP_TTL_MINUTES * 60 * 1000
    );

    await sql.transaction([
      sql`
        UPDATE email_otp_challenges
        SET consumed_at = NOW()
        WHERE email = ${email}
          AND purpose = ${purpose}
          AND consumed_at IS NULL
      `,
      sql`
        INSERT INTO email_otp_challenges (
          id,
          email,
          purpose,
          code_hash,
          expires_at,
          attempts,
          max_attempts
        )
        VALUES (
          ${challengeId},
          ${email},
          ${purpose},
          ${codeHash},
          ${expiresAt},
          0,
          ${OTP_MAX_ATTEMPTS}
        )
      `,
    ]);

    await sendOtpEmail({
      email,
      code,
      expiresInMinutes: OTP_TTL_MINUTES,
    });

    return res.status(200).json({
      success: true,
      message: "Un code de vérification a été envoyé.",
      challengeId,
      expiresIn: OTP_TTL_MINUTES * 60,
      resendAfter: OTP_RESEND_SECONDS,
    });
  } catch (error) {
    console.error("EMAIL_OTP_REQUEST_ERROR", error.message);

    if (challengeId) {
      try {
        await sql`
          DELETE FROM email_otp_challenges
          WHERE id = ${challengeId}
        `;
      } catch (cleanupError) {
        console.error("EMAIL_OTP_CLEANUP_ERROR", cleanupError.message);
      }
    }

    const clientError =
      error.message === "Adresse email invalide." ||
      error.message === "Utilisation OTP invalide.";

    return res.status(clientError ? 400 : 500).json({
      success: false,
      error: clientError
        ? error.message
        : "Impossible d’envoyer le code pour le moment.",
    });
  }
}

async function verifyEmailOtp(req, res) {
  const sql = getSql();

  try {
    const challengeId = String(req.body?.challengeId || "").trim();
    const email = normalizeEmail(req.body?.email);
    const purpose = normalizePurpose(req.body?.purpose);
    const code = String(req.body?.code || "").trim();

    if (!challengeId || !/^\d{6}$/.test(code)) {
      return res.status(400).json({
        success: false,
        error: "Code de vérification invalide.",
      });
    }

    const rows = await sql`
      SELECT
        id,
        email,
        purpose,
        code_hash,
        expires_at,
        attempts,
        max_attempts,
        consumed_at
      FROM email_otp_challenges
      WHERE id = ${challengeId}
      LIMIT 1
    `;

    const challenge = rows[0];

    if (
      !challenge ||
      challenge.email !== email ||
      challenge.purpose !== purpose ||
      challenge.consumed_at
    ) {
      return res.status(400).json({
        success: false,
        error: "Code invalide ou expiré.",
      });
    }

    if (new Date(challenge.expires_at).getTime() <= Date.now()) {
      await sql`
        UPDATE email_otp_challenges
        SET consumed_at = NOW()
        WHERE id = ${challengeId}
          AND consumed_at IS NULL
      `;

      return res.status(400).json({
        success: false,
        error: "Code expiré.",
      });
    }

    if (challenge.attempts >= challenge.max_attempts) {
      return res.status(429).json({
        success: false,
        error: "Nombre maximal de tentatives atteint.",
      });
    }

    const submittedHash = hashOtp({
      challengeId,
      email,
      purpose,
      code,
    });

    const valid = safeCompareHex(
      challenge.code_hash,
      submittedHash
    );

    if (!valid) {
      await sql`
        UPDATE email_otp_challenges
        SET attempts = attempts + 1
        WHERE id = ${challengeId}
          AND consumed_at IS NULL
      `;

      return res.status(400).json({
        success: false,
        error: "Code invalide ou expiré.",
      });
    }

    const updated = await sql`
      UPDATE email_otp_challenges
      SET consumed_at = NOW()
      WHERE id = ${challengeId}
        AND consumed_at IS NULL
      RETURNING id
    `;

    if (updated.length !== 1) {
      return res.status(409).json({
        success: false,
        error: "Ce code a déjà été utilisé.",
      });
    }

    const verificationToken = createVerificationProof({
      email,
      purpose,
    });

    return res.status(200).json({
      success: true,
      message: "Adresse email vérifiée avec succès.",
      verificationToken,
      expiresIn: 600,
    });
  } catch (error) {
    console.error("EMAIL_OTP_VERIFY_ERROR", error.message);

    return res.status(500).json({
      success: false,
      error: "Impossible de vérifier le code pour le moment.",
    });
  }
}

module.exports = {
  requestEmailOtp,
  verifyEmailOtp,
};
