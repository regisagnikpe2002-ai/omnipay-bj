"use strict";

class BaseProvider {
  constructor({ name, enabled = false, collections = false, disbursements = false }) {
    if (!name) throw new Error("Le nom du provider est requis.");
    this.name = name;
    this.enabled = Boolean(enabled);
    this.capabilities = {
      collections: Boolean(collections),
      disbursements: Boolean(disbursements),
    };
  }

  assertEnabled() {
    if (!this.enabled) throw new Error(`Provider ${this.name} désactivé.`);
  }

  assertCapability(capability) {
    this.assertEnabled();
    if (!this.capabilities[capability]) {
      throw new Error(`Provider ${this.name}: capacité ${capability} indisponible.`);
    }
  }

  async healthCheck() {
    return {
      provider: this.name,
      enabled: this.enabled,
      capabilities: this.capabilities,
      status: this.enabled ? "configured" : "disabled",
    };
  }

  async collect() {
    throw new Error(`${this.name}.collect() non implémenté.`);
  }

  async getCollectionStatus() {
    throw new Error(`${this.name}.getCollectionStatus() non implémenté.`);
  }

  async disburse() {
    throw new Error(`${this.name}.disburse() non implémenté.`);
  }

  async getDisbursementStatus() {
    throw new Error(`${this.name}.getDisbursementStatus() non implémenté.`);
  }

  async getBalance() {
    throw new Error(`${this.name}.getBalance() non implémenté.`);
  }

  async verifyAccount() {
    throw new Error(`${this.name}.verifyAccount() non implémenté.`);
  }

  async handleWebhook() {
    throw new Error(`${this.name}.handleWebhook() non implémenté.`);
  }
}

module.exports = BaseProvider;
