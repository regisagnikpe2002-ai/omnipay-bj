"use strict";

const crypto = require("crypto");

function stableHash(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

function timingSafeHexEqual(left, right) {
  try {
    const a = Buffer.from(String(left || ""), "hex");
    const b = Buffer.from(String(right || ""), "hex");

    return (
      a.length === b.length &&
      crypto.timingSafeEqual(a, b)
    );
  } catch {
    return false;
  }
}

function verifyHmacSha256(rawBody, signature, secret) {
  if (!secret) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  return timingSafeHexEqual(expected, signature);
}

module.exports = {
  stableHash,
  verifyHmacSha256,
};
