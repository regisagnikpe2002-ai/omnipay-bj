"use strict";

function envBoolean(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

const providerConfig = {
  paydunya: {
    name: "paydunya",
    enabled: envBoolean("PROVIDER_PAYDUNYA_ENABLED", true),
    collections: true,
    disbursements: false,
    priority: 10,
  },
  mtn: {
    name: "mtn",
    enabled: envBoolean("PROVIDER_MTN_ENABLED", false),
    collections: envBoolean("MTN_COLLECTIONS_ENABLED", false),
    disbursements: envBoolean("MTN_DISBURSEMENTS_ENABLED", false),
    priority: 20,
  },
  moov: {
    name: "moov",
    enabled: envBoolean("PROVIDER_MOOV_ENABLED", false),
    collections: envBoolean("MOOV_COLLECTIONS_ENABLED", false),
    disbursements: envBoolean("MOOV_DISBURSEMENTS_ENABLED", false),
    priority: 30,
  },
  celtiis: {
    name: "celtiis",
    enabled: envBoolean("PROVIDER_CELTIIS_ENABLED", false),
    collections: envBoolean("CELTIIS_COLLECTIONS_ENABLED", false),
    disbursements: envBoolean("CELTIIS_DISBURSEMENTS_ENABLED", false),
    priority: 40,
  },
};

module.exports = providerConfig;
