"use strict";

const crypto = require("crypto");

function normalizeAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Montant invalide.");
  }
  return Number(amount.toFixed(2));
}

function normalizePhone(value) {
  const phone = String(value || "").replace(/\s+/g, "").trim();
  if (!/^\+?[0-9]{8,15}$/.test(phone)) {
    throw new Error("Numéro de téléphone invalide.");
  }
  return phone;
}

class PaymentOrchestrator {
  constructor({ registry }) {
    if (!registry) throw new Error("ProviderRegistry requis.");
    this.registry = registry;
  }

  async collect(input) {
    const request = {
      operationId: input.operationId || crypto.randomUUID(),
      idempotencyKey: input.idempotencyKey || crypto.randomUUID(),
      amount: normalizeAmount(input.amount),
      currency: input.currency || "XOF",
      phone: normalizePhone(input.phone),
      userId: input.userId,
      callbackUrl: input.callbackUrl,
      metadata: input.metadata || {},
    };

    const provider = this.registry.select({
      providerName: input.provider,
      capability: "collections",
    });

    const result = await provider.collect(request);
    return { provider: provider.name, request, result };
  }

  async disburse(input) {
    const request = {
      operationId: input.operationId || crypto.randomUUID(),
      idempotencyKey: input.idempotencyKey || crypto.randomUUID(),
      amount: normalizeAmount(input.amount),
      currency: input.currency || "XOF",
      phone: normalizePhone(input.phone),
      userId: input.userId,
      callbackUrl: input.callbackUrl,
      metadata: input.metadata || {},
    };

    const provider = this.registry.select({
      providerName: input.provider,
      capability: "disbursements",
    });

    const result = await provider.disburse(request);
    return { provider: provider.name, request, result };
  }

  async health() {
    const results = [];
    for (const item of this.registry.list()) {
      const provider = this.registry.get(item.name);
      try {
        results.push(await provider.healthCheck());
      } catch (error) {
        results.push({ provider: item.name, status: "error", error: error.message });
      }
    }
    return results;
  }
}

module.exports = PaymentOrchestrator;
