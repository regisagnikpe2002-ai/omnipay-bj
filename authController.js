"use strict";

const crypto = require("crypto");
const { eq, or } = require("drizzle-orm");
const { db } = require("./db/index.js");
const { users, wallets } = require("./db/schema.js");
const {
  hashPassword,
  comparePassword,
  signAccessToken,
  signRefreshToken,
} = require("./lib/auth-utils.js");

function verifyEmailVerificationToken({ verificationToken, email, purpose = "register" }) {
  const secret = process.env.OTP_SECRET?.trim();

  if (!secret || secret.length < 32) {
    throw new Error("OTP_SECRET doit contenir au moins 32 caractères.");
  }

  const token = String(verificationToken || "").trim();
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const parts = token.split(".");

  if (parts.length !== 2) return false;

  const [payload, providedSignature] = parts;
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");

  const providedBuffer = Buffer.from(providedSignature, "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return false;
  }

  let data;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return false;
  }

  return (
    data.email === normalizedEmail &&
    data.purpose === purpose &&
    Number(data.expiresAt) > Date.now()
  );
}

async function register(req, res) {
  try {
    const {
      email,
      phone,
      password,
      firstName,
      lastName,
      verificationToken,
    } = req.body;

    if (!email || !phone || !password || !verificationToken) {
      return res.status(400).json({
        error: "email, phone, password et verificationToken sont requis.",
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const normalizedPhone = String(phone).trim();

    const otpVerified = verifyEmailVerificationToken({
      verificationToken,
      email: normalizedEmail,
      purpose: "register",
    });

    if (!otpVerified) {
      return res.status(403).json({
        error: "Vérification OTP invalide ou expirée.",
      });
    }

    const existing = await db.query.users.findFirst({
      where: or(
        eq(users.email, normalizedEmail),
        eq(users.phone, normalizedPhone)
      ),
    });

    if (existing) {
      return res.status(409).json({
        error: "Un compte existe déjà avec cet email ou ce numéro.",
      });
    }

    const passwordHash = await hashPassword(password);

    const [user] = await db
      .insert(users)
      .values({
        email: normalizedEmail,
        phone: normalizedPhone,
        passwordHash,
        firstName,
        lastName,
      })
      .returning();

    await db.insert(wallets).values({
      userId: user.id,
      balance: "0",
      currency: "XOF",
    });

    const payload = { userId: user.id, role: user.role };

    return res.status(201).json({
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
      accessToken: signAccessToken(payload),
      refreshToken: signRefreshToken(payload),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "Erreur serveur lors de l'inscription.",
    });
  }
}

async function login(req, res) {
  try {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({
        error: "identifier et password sont requis.",
      });
    }

    const normalizedIdentifier = String(identifier).trim();

    const user = await db.query.users.findFirst({
      where: or(
        eq(users.email, normalizedIdentifier.toLowerCase()),
        eq(users.phone, normalizedIdentifier)
      ),
    });

    if (!user) {
      return res.status(401).json({ error: "Identifiants invalides." });
    }

    const valid = await comparePassword(password, user.passwordHash);

    if (!valid) {
      return res.status(401).json({ error: "Identifiants invalides." });
    }

    const payload = { userId: user.id, role: user.role };

    return res.status(200).json({
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
      accessToken: signAccessToken(payload),
      refreshToken: signRefreshToken(payload),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "Erreur serveur lors de la connexion.",
    });
  }
}


async function resetPassword(req, res) {
  try {
    const { email, newPassword, verificationToken } = req.body;

    if (!email || !newPassword || !verificationToken) {
      return res.status(400).json({
        error: "email, newPassword et verificationToken sont requis.",
      });
    }

    if (String(newPassword).length < 8) {
      return res.status(400).json({
        error: "Le nouveau mot de passe doit contenir au moins 8 caractères.",
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const otpVerified = verifyEmailVerificationToken({
      verificationToken,
      email: normalizedEmail,
      purpose: "password_reset",
    });

    if (!otpVerified) {
      return res.status(403).json({
        error: "Vérification OTP invalide ou expirée.",
      });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.email, normalizedEmail),
    });

    if (!user) {
      return res.status(404).json({ error: "Compte OMNIPAY introuvable." });
    }

    const passwordHash = await hashPassword(String(newPassword));

    await db
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, user.id));

    return res.status(200).json({
      success: true,
      message: "Mot de passe modifié. Vous pouvez vous connecter.",
    });
  } catch (err) {
    console.error("PASSWORD_RESET_ERROR", err);
    return res.status(500).json({
      error: "Erreur serveur lors de la modification du mot de passe.",
    });
  }
}

module.exports = { register, login, resetPassword };
