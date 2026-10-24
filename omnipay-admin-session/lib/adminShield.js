"use strict";

const crypto = require("crypto");
const { verifySessionToken, readCookie } = require("./adminSessionToken");

const ADMIN_PREFIXES = ["/api/admin", "/api/ledger", "/api/compliance", "/api/ops", "/api/manual/admin", "/api/id/backfill"];
const MAX_FAILS = 10;
const WINDOW_MS = 15 * 60 * 1000;
const COOKIE = "omnipay_admin_session";

function b32decode(s) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of String(s || "").toUpperCase().replace(/[=\s]/g, "")) {
    const i = A.indexOf(c);
    if (i < 0) return null;
    bits += i.toString(2).padStart(5, "0");
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return out.length ? Buffer.from(out) : null;
}

function totp(key, timeMs, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30000)));
  const h = crypto.createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, "0");
}

function verifyTotp(secretB32, code, now = Date.now()) {
  const key = b32decode(secretB32);
  if (!key || !/^\d{6}$/.test(String(code || ""))) return false;
  const given = Buffer.from(String(code));
  for (const step of [-1, 0, 1]) {
    const expected = Buffer.from(totp(key, now + step * 30000));
    if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) return true;
  }
  return false;
}

const cleanIp = (ip) => String(ip || "").replace(/^::ffff:/, "");
const isAdminShaped = (req) => Boolean(req.headers["x-admin-key"]) || ADMIN_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + "/"));

function adminShield() {
  const fails = new Map();
  const record = (ip) => {
    const f = fails.get(ip);
    if (!f || Date.now() - f.t > WINDOW_MS) fails.set(ip, { n: 1, t: Date.now() });
    else f.n += 1;
  };

  return (req, res, next) => {
    if (!isAdminShaped(req)) return next();

    const session = verifySessionToken(readCookie(req, COOKIE));
    if (session) {
      req.adminSession = session;
      req.headers["x-admin-key"] = process.env.ADMIN_KEY || "";
      return next();
    }

    const ip = cleanIp(req.ip);
    const f = fails.get(ip);
    if (f && f.n >= MAX_FAILS && Date.now() - f.t < WINDOW_MS) {
      return res.status(429).json({ error: "Trop de tentatives. Réessayez dans 15 minutes." });
    }

    const allow = String(process.env.ADMIN_IP_ALLOWLIST || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (allow.length && !allow.includes(ip)) {
      record(ip);
      return res.status(403).json({ error: "Accès refusé." });
    }

    const secret = process.env.ADMIN_TOTP_SECRET;
    if (secret && !verifyTotp(secret, req.headers["x-admin-otp"])) {
      record(ip);
      return res.status(403).json({ error: "Code de double authentification requis ou invalide." });
    }

    res.on("finish", () => {
      if (res.statusCode === 403) record(ip);
      else if (res.statusCode < 400) fails.delete(ip);
    });
    next();
  };
}

module.exports = adminShield;
module.exports.verifyTotp = verifyTotp;
module.exports.totp = totp;
module.exports.b32decode = b32decode;
