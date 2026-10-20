"use strict";

const { officialOnly } = require("./baseProvider.js");

const disabled = officialOnly("Ecobank");

const capabilities = [
  "payin",
  "payout",
  "transfer",
];

function isEnabled() {
  return (
    process.env.ECOBANK_ENABLED === "true" &&
    !!process.env.ECOBANK_BASE_URL &&
    !!process.env.ECOBANK_CLIENT_ID &&
    !!process.env.ECOBANK_CLIENT_SECRET
  );
}

async function initiate() {
  if (!isEnabled()) {
    return disabled.initiate();
  }

  throw new Error(
    "Ecobank: adapter les endpoints, en-têtes, hash et payloads uniquement à la documentation officielle attribuée à OMNIPAY."
  );
}

async function verifyWebhook() {
  if (!isEnabled()) {
    return disabled.verifyWebhook();
  }

  throw new Error(
    "Ecobank: vérifier la notification selon la spécification officielle attribuée à OMNIPAY."
  );
}

module.exports = {
  capabilities,
  isEnabled,
  initiate,
  verifyWebhook,
};
