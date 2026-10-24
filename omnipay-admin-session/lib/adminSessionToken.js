"use strict";

const crypto = require("crypto");

const b64 = (value) => Buffer.from(value).toString("base64url");
const unb64 = (value) => Buffer.from(value, "base64url").toString("utf8");

function secret() {
  const value = String(process.env.ADMIN_SESSION_SECRET || "").trim();
  if (value.length < 32) throw new Error("ADMIN_SESSION_SECRET manquant ou trop court.");
  return value;
}

function ttlSeconds() {
  const value = Number(process.env.ADMIN_SESSION_TTL_SECONDS || 28800);
  return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 900), 86400) : 28800;
}

function signature(payloadPart) {
  return crypto.createHmac("sha256", secret()).update(payloadPart).digest("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createSessionToken() {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: "omnipay-admin",
    iat: now,
    exp: now + ttlSeconds(),
    nonce: crypto.randomBytes(16).toString("hex")
  };
  const payloadPart = b64(JSON.stringify(payload));
  return `${payloadPart}.${signature(payloadPart)}`;
}

function verifySessionToken(token) {
  try {
    const [payloadPart, suppliedSignature] = String(token || "").split(".");
    if (!payloadPart || !suppliedSignature || !safeEqual(signature(payloadPart), suppliedSignature)) return null;
    const payload = JSON.parse(unb64(payloadPart));
    const now = Math.floor(Date.now() / 1000);
    if (payload.sub !== "omnipay-admin" || !Number.isFinite(payload.exp) || payload.exp <= now) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function readCookie(req, name) {
  const raw = String(req.headers.cookie || "");
  for (const item of raw.split(";")) {
    const index = item.indexOf("=");
    if (index < 0) continue;
    const key = item.slice(0, index).trim();
    if (key === name) return decodeURIComponent(item.slice(index + 1).trim());
  }
  return "";
}

module.exports = { createSessionToken, verifySessionToken, readCookie, ttlSeconds, safeEqual };
