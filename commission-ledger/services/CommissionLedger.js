"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const commissionPolicy = require("../config/commissionPolicy");

function money(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("Montant de commission invalide.");
  }
  return Math.round(amount);
}

function allocate(totalCommission) {
  const total = money(totalCommission);
  const a = commissionPolicy.allocations;
  const operations = Math.round(total * a.operations);
  const productDevelopment = Math.round(total * a.productDevelopment);
  const firstOffice = Math.round(total * a.firstOffice);
  const riskReserve = total - operations - productDevelopment - firstOffice;
  return { operations, productDevelopment, firstOffice, riskReserve };
}

class CommissionLedger {
  constructor({ filePath } = {}) {
    this.filePath = filePath || path.join(__dirname, "..", "data", "commission-ledger.jsonl");
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  recordCommission(input) {
    if (!input?.transactionId) throw new Error("transactionId requis.");
    if (!input?.provider) throw new Error("provider requis.");

    const grossAmount = money(input.grossAmount);
    const providerFee = money(input.providerFee || 0);
    const commissionAmount = money(input.commissionAmount);
    const netAmount = grossAmount - providerFee - commissionAmount;
    if (netAmount < 0) throw new Error("Répartition supérieure au montant brut.");

    const allocations = allocate(commissionAmount);
    const entry = {
      ledgerId: crypto.randomUUID(),
      recordedAt: new Date().toISOString(),
      transactionId: String(input.transactionId),
      provider: String(input.provider).toLowerCase(),
      userId: input.userId || null,
      operationType: input.operationType || "payment",
      currency: input.currency || commissionPolicy.currency,
      grossAmount,
      providerFee,
      commissionAmount,
      netAmount,
      allocations,
      status: input.status || "earned",
      note: input.note || "",
      policyVersion: commissionPolicy.version,
    };

    fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf8");
    return entry;
  }

  entries() {
    if (!fs.existsSync(this.filePath)) return [];
    return fs.readFileSync(this.filePath, "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  summary() {
    return this.entries().reduce((acc, e) => {
      acc.count += 1;
      acc.grossAmount += e.grossAmount;
      acc.providerFee += e.providerFee;
      acc.commissionAmount += e.commissionAmount;
      acc.netAmount += e.netAmount;
      for (const key of Object.keys(acc.allocations)) {
        acc.allocations[key] += e.allocations[key];
      }
      acc.byProvider[e.provider] = (acc.byProvider[e.provider] || 0) + e.commissionAmount;
      return acc;
    }, {
      count: 0, grossAmount: 0, providerFee: 0, commissionAmount: 0, netAmount: 0,
      allocations: { operations: 0, productDevelopment: 0, firstOffice: 0, riskReserve: 0 },
      byProvider: {},
    });
  }
}

module.exports = { CommissionLedger, allocate };
