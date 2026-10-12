"use strict";

const providers = {
  paydunya: {
    name: "paydunya",
    type: "mobile_money",
    enabled: true,
  },

  binance: {
    name: "binance",
    type: "crypto",
    enabled: true,
  },
};

function getProvider(name) {
  const provider = providers[name];

  if (!provider) {
    throw new Error(`Provider introuvable: ${name}`);
  }

  if (!provider.enabled) {
    throw new Error(`Provider désactivé: ${name}`);
  }

  return provider;
}

module.exports = {
  getProvider,
};
