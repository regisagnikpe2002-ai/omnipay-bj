"use strict";

const { resolveProvider } = require("./paymentRouter");
const { getProvider } = require("./providerResolver");

function resolveTransaction(method) {
  const providerName = resolveProvider(method);
  const provider = getProvider(providerName);

  return {
    method,
    provider: provider.name,
    type: provider.type,
    enabled: provider.enabled,
    resolvedAt: new Date().toISOString(),
  };
}

module.exports = {
  resolveTransaction,
};
