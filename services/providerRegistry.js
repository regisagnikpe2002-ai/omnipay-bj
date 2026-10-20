"use strict";

const ecobank = require("../providers/ecobank.js");
const pispi = require("../providers/piSpi.js");
const mtn = require("../providers/mtnMomo.js");
const celtiis = require("../providers/celtiis.js");

const providers = {
  ecobank,
  pispi,
  mtn,
  celtiis,
};

function getProvider(name) {
  const provider =
    providers[String(name || "").toLowerCase()];

  if (!provider) {
    throw new Error("Prestataire inconnu.");
  }

  if (!provider.isEnabled()) {
    throw new Error(
      "Prestataire non activé avec des accès officiels."
    );
  }

  return provider;
}

function listProviders() {
  return Object.entries(providers).map(
    ([name, provider]) => ({
      name,
      enabled: provider.isEnabled(),
      capabilities: provider.capabilities,
    })
  );
}

module.exports = {
  getProvider,
  listProviders,
};
