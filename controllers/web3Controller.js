const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");
const { getAddress, verifyMessage } = require("ethers");

function getSql() {
  return neon(process.env.DATABASE_URL);
}

function normalizeAddress(address) {
  return getAddress(String(address || "").trim());
}

function allowedChain(chainId) {
  const allowed =
    (process.env.WEB3_ALLOWED_CHAIN_IDS || "8453")
      .split(",")
      .map((x) => Number(x.trim()));

  return allowed.includes(Number(chainId));
}

module.exports = {
  getSql,
  normalizeAddress,
  allowedChain,
};
``
