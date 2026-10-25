"use strict";

const express = require("express");
const { verifyTotp } = require("../lib/adminShield");
const { createSessionToken, verifySessionToken, readCookie, ttlSeconds, safeEqual } = require("../lib/adminSessionToken");

const router = express.Router();
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;
const COOKIE = "omnipay_admin_session";

function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || "unknown").replace(/^::ffff:/, "");
}

function blocked(ip) {
  const item = attempts.get(ip);
  if (!item) return false;
  if (Date.now() - item.startedAt >= WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return item.count >= MAX_FAILS;
}

function fail(ip) {
  const item = attempts.get(ip);
  if (!item || Date.now() - item.startedAt >= WINDOW_MS) {
    attempts.set(ip, { count: 1, startedAt: Date.now() });
  } else {
    item.count += 1;
  }
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" || process.env.RENDER === "true",
    sameSite: "strict",
    path: "/",
    maxAge: ttlSeconds() * 1000
  };
}

router.post("/login", express.json(), (req, res) => {
  const ip = clientIp(req);
  if (blocked(ip)) return res.status(429).json({ error: "Trop de tentatives. Réessayez dans 15 minutes." });

  const expectedKey = String(process.env.ADMIN_KEY || "");
  const suppliedKey = String(req.body?.key || "");
  const otp = String(req.body?.otp || "");
  const totpSecret = String(process.env.ADMIN_TOTP_SECRET || "").trim();

  const keyValid = expectedKey.length > 0 && safeEqual(expectedKey, suppliedKey);
  const otpValid = !totpSecret || verifyTotp(totpSecret, otp);

  if (!keyValid || !otpValid) {
    fail(ip);
    return res.status(403).json({ error: "Accès administrateur refusé." });
  }

  attempts.delete(ip);
  const token = createSessionToken();
  res.cookie(COOKIE, token, cookieOptions());
  return res.json({ success: true, expiresIn: ttlSeconds() });
});

router.get("/me", (req, res) => {
  const session = verifySessionToken(readCookie(req, COOKIE));
  if (!session) return res.status(401).json({ authenticated: false });
  return res.json({ authenticated: true, expiresAt: session.exp });
});

router.post("/logout", (req, res) => {
  res.clearCookie(COOKIE, { httpOnly: true, secure: cookieOptions().secure, sameSite: "strict", path: "/" });
  return res.json({ success: true });
});

module.exports = router;
