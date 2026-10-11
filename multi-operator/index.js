"use strict";

const providerConfig = require("./config/providerConfig");
const DisabledProvider = require("./providers/DisabledProvider");
const PayDunyaProvider = require("./providers/PayDunyaProvider");
const ProviderRegistry = require("./services/ProviderRegistry");
const PaymentOrchestrator = require("./services/PaymentOrchestrator");

const registry = new ProviderRegistry();

function createInvoiceStub() {
  throw new Error(
    "PayDunya createInvoice non encore branche au service existant."
  );
}

function confirmInvoiceStub() {
  throw new Error(
    "PayDunya confirmInvoice non encore branche au service existant."
  );
}

for (const config of Object.values(providerConfig)) {
  const provider =
    config.name === "paydunya"
      ? new PayDunyaProvider({
          config,
          createInvoice: createInvoiceStub,
          confirmInvoice: confirmInvoiceStub,
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
