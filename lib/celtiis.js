"use strict";

const { officialOnly } = require("./baseProvider.js");

const disabled = officialOnly("Celtiis Cash");

const capabilities = [
  "payin",
  "payout",
];

function isEnabled() {
  return (
    process.env.CELTIIS_ENABLED === "true" &&
    !!process.env.CELTIIS_BASE_URL &&
    !!process.env.CELTIIS_CLIENT_ID &&
    !!process.env.CELTIIS_CLIENT_SECRET
  );
}

async function initiate() {
  if (!isEnabled()) {
    return disabled.initiate();
  }

  throw new Error(
    "Celtiis: documentation et accès officiels requis avant activation."
  );
}

async function verifyWebhook() {
  if (!isEnabled()) {
    return disabled.verifyWebhook();
  }

  throw new Error(
    "Celtiis: vérification webhook à adapter à la documentation officielle."
  );
}

module.exports = {
  capabilities,
  isEnabled,
  initiate,
  verifyWebhook,
};
