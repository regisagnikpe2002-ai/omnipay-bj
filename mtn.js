"use strict";

function configured() {
  return Boolean(process.env.MTN_MOMO_BASE_URL && process.env.MTN_MOMO_SUBSCRIPTION_KEY);
}

async function airtime() {
  throw new Error("MTN airtime non active: connecter uniquement l'API officielle autorisee pour OMNIPAY.");
}

async function bundle() {
  throw new Error("MTN bundle non active: connecter uniquement l'API officielle autorisee pour OMNIPAY.");
}

module.exports = { configured, airtime, bundle };
