"use strict";

const providerConfig = require("./config/providerConfig");
const DisabledProvider = require("./providers/DisabledProvider");
const PayDunyaProvider = require("./providers/PayDunyaProvider");
const ProviderRegistry = require("./services/ProviderRegistry");
const PaymentOrchestrator = require("./services/PaymentOrchestrator");
const {
  createInvoice,
  confirmInvoice,
} = require("../providers/paydunya.js");

const registry = new ProviderRegistry();

for (const config of Object.values(providerConfig)) {
  const provider =
    config.name === "paydunya"
      ? new PayDunyaProvider({
          config,
          createInvoice,
          confirmInvoice,
        })
      : new DisabledProvider(config);

  registry.register(provider, config.priority);
}

const paymentOrchestrator = new PaymentOrchestrator({ registry });

module.exports = {
  registry,
  paymentOrchestrator,
  ProviderRegistry,
  PaymentOrchestrator,
};
