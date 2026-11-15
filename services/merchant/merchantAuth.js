"use strict";

const crypto = require("crypto");

function hashApiKey(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex");
}

function generateApiKey(environment = "live") {
  const prefix =
    environment === "test"
      ? "omp_test_"
      : "omp_live_";

  return prefix + crypto.randomBytes(32).toString("hex");
}

function extractApiKey(req) {
  const direct =
    String(req.headers["x-omnipay-key"] || "").trim();

  if (direct) return direct;

  const auth =
    String(req.headers.authorization || "").trim();

  const match = auth.match(/^Bearer[ ]+(.+)$/i);

  return match ? match[1].trim() : "";
}

module.exports = {
  hashApiKey,
  generateApiKey,
  extractApiKey
};
