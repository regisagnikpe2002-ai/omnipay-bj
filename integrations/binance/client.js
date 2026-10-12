"use strict";

function getConfig() {
  return {
    provider: "binance",
    apiKey: process.env.BINANCE_API_KEY ? "***configured***" : null,
    apiSecret: process.env.BINANCE_API_SECRET ? "***configured***" : null,
    testnet: process.env.BINANCE_TESTNET === "true",
  };
}

function healthCheck() {
  const cfg = getConfig();

  return {
    provider: cfg.provider,
    testnet: cfg.testnet,
    configured:
      !!cfg.apiKey &&
      !!cfg.apiSecret,
  };
}

module.exports = {
  getConfig,
  healthCheck,
};
