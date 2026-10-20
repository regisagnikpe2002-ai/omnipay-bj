"use strict";

const { officialOnly } = require("./baseProvider.js");

const disabled = officialOnly("MTN MoMo");

const capabilities = [
  "payin",
  "payout",
];

function isEnabled() {
  return (
    process.env.MTN_MOMO_ENABLED === "true" &&
    !!process.env.MTN_MOMO_BASE_URL &&
    !!process.env.MTN_MOMO_SUBSCRIPTION_KEY &&
    !!process.env.MTN_MOMO_API_USER &&
    !!process.env.MTN_MOMO_API_KEY
  );
}

async function initiate() {
  if (!isEnabled()) {
    return disabled.initiate();
  }

  throw new Error(
    "MTN MoMo: adapter RequestToPay/Disbursement uniquement aux paramètres officiels attribués à OMNIPAY."
  );
}

async function verifyWebhook() {
  if (!isEnabled()) {
    return disabled.verifyWebhook();
  }

  throw new Error(
    "MTN MoMo: callback à adapter aux accès officiels."
  );
}

module.exports = {
  capabilities,
  isEnabled,
  initiate,
  verifyWebhook,
};
