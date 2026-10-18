"use strict";
// OMNIPAY — réinitialisation du mot de passe (fichier AJOUTÉ, ne modifie rien d'existant).
// Flux : /api/email-otp/request {purpose:"password_reset"} -> /api/email-otp/verify -> POST /auth/reset-password
const crypto = require("crypto");
const express = require("express");
const { eq } = require("drizzle-orm");
const { db } = require("../db/index.js");
const { users } = require("../db/schema.js");
const { hashPassword } = require("../lib/auth-utils.js");

const router = express.Router();

function verifyResetToken({ verificationToken, email }) {
  const secret = process.env.OTP_SECRET?.trim();
  if (!secret || secret.length < 32) return false;
  const parts = String(verificationToken || "").trim().split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  let data;
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return false; }
  return data.email === email && data.purpose === "password_reset" && Number(data.expiresAt) > Date.now();
}

router.post("/reset-password", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const newPassword = String(req.body?.newPassword || "");
    const token = req.body?.verificationToken;
    if (!email || !token || newPassword.length < 8) {
      return res.status(400).json({ error: "Email, code vérifié et nouveau mot de passe (8 caractères min.) requis." });
    }
    if (!verifyResetToken({ verificationToken: token, email })) {
      return res.status(400).json({ error: "Code invalide ou expiré. Recommencez la procédure." });
    }
    const user = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (!user) return res.status(400).json({ error: "Code invalide ou expiré. Recommencez la procédure." });
    await db.update(users).set({ passwordHash: await hashPassword(newPassword) }).where(eq(users.id, user.id));
    return res.status(200).json({ message: "Mot de passe modifié. Vous pouvez vous connecter." });
  } catch (err) {
    console.error("RESET_PASSWORD_ERROR", err.message);
    return res.status(500).json({ error: "Impossible de modifier le mot de passe pour le moment." });
  }
});

module.exports = router;
