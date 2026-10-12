"use strict";

function getConfig() {
  return {
    provider: "paydunya",
    mode: process.env.PAYDUNYA_MODE || "test",
    masterKey: process.env.PAYDUNYA_MASTER_KEY ? "***configured***" : null,
    privateKey: process.env.PAYDUNYA_PRIVATE_KEY ? "***configured***" : null,
    publicKey: process.env.PAYDUNYA_PUBLIC_KEY ? "***configured***" : null,
    token: process.env.PAYDUNYA_TOKEN ? "***configured***" : null,
  };
}

function healthCheck() {
  const cfg = getConfig();

  return {
    provider: cfg.provider,
    mode: cfg.mode,
    configured:
      !!cfg.masterKey &&
      !!cfg.privateKey &&
      !!cfg.publicKey &&
      !!cfg.token,
  };
}

module.exports = {
  getConfig,
  healthCheck,
};
