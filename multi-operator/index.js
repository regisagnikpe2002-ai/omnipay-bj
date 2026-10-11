"use strict";

const providerConfig = require("./config/providerConfig");
const DisabledProvider = require("./providers/DisabledProvider");
const ProviderRegistry = require("./services/ProviderRegistry");
const PaymentOrchestrator = require("./services/PaymentOrchestrator");

const registry = new ProviderRegistry();

for (const config of Object.values(providerConfig)) {
  registry.register(new DisabledProvider(config), config.priority);
}

const paymentOrchestrator = new PaymentOrchestrator({ registry });

module.exports = {
  registry,
  paymentOrchestrator,
  ProviderRegistry,
  PaymentOrchestrator,
};
