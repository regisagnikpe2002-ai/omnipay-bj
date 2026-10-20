"use strict";

const { officialOnly } = require("./baseProvider.js");

const disabled = officialOnly("PI-SPI");

const capabilities = [
  "payin",
  "payout",
  "transfer",
];

function isEnabled() {
  return (
    process.env.PISPI_ENABLED === "true" &&
    !!process.env.PISPI_BASE_URL &&
    !!process.env.PISPI_CLIENT_ID &&
    !!process.env.PISPI_CLIENT_SECRET &&
    !!process.env.PISPI_MTLS_CERT_PATH &&
    !!process.env.PISPI_MTLS_KEY_PATH
  );
}

async function initiate() {
  if (!isEnabled()) {
    return disabled.initiate();
  }

  throw new Error(
    "PI-SPI: branchement à finaliser uniquement avec les credentials, certificats mTLS et paramètres officiels du participant autorisé."
  );
}

async function verifyWebhook() {
  if (!isEnabled()) {
    return disabled.verifyWebhook();
  }

  throw new Error(
    "PI-SPI: vérification webhook à adapter à la documentation officielle attribuée à OMNIPAY."
  );
}

module.exports = {
  capabilities,
  isEnabled,
  initiate,
  verifyWebhook,
};
