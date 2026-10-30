"use strict";

const bhn = require("./bhnGiftCards.js");
const reloadly = require("./reloadlyGiftCards.js");

const PROVIDERS = Object.freeze({ bhn, reloadly });

function preferredProvider() {
  const name = String(process.env.GIFT_CARD_PROVIDER || "auto").toLowerCase();
  return name === "bhn" || name === "reloadly" ? name : "auto";
}

function status() {
  return Object.entries(PROVIDERS).map(([name, provider]) => ({
    name,
    ...provider.publicConfig()
  }));
}

function selectProvider(capability) {
  const preferred = preferredProvider();
  const candidates = preferred === "auto"
    ? ["bhn", "reloadly"]
    : [preferred];

  for (const name of candidates) {
    const provider = PROVIDERS[name];
    if (!provider || !provider.configured()) continue;

    if (capability === "catalog") {
      if (name === "bhn" && typeof provider.listCatalog === "function") return { name, provider };
      if (name === "reloadly" && typeof provider.listProducts === "function") return { name, provider };
    }

    if (capability === "order" && typeof provider.orderGiftCard === "function") {
      return { name, provider };
    }
  }

  return null;
}

async function catalog(options = {}) {
  const selected = selectProvider("catalog");
  if (!selected) {
    return {
      ok: false,
      status: "unavailable",
      provider: null,
      error: "Aucun fournisseur de cartes cadeaux configuré."
    };
  }

  const data = selected.name === "bhn"
    ? await selected.provider.listCatalog(options)
    : await selected.provider.listProducts(options);

  return { ok: true, provider: selected.name, data };
}

async function order(input = {}) {
  const selected = selectProvider("order");
  if (!selected) {
    return {
      ok: false,
      status: "unavailable",
      provider: null,
      error: "Aucun fournisseur configuré pour les commandes de cartes cadeaux."
    };
  }

  const data = await selected.provider.orderGiftCard(input);
  return { ok: true, provider: selected.name, data };
}

module.exports = {
  status,
  preferredProvider,
  selectProvider,
  catalog,
  order
};
