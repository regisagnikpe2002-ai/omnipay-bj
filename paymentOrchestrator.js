"use strict";

const crypto = require("crypto");
const secureLedger = require("./secureLedger");
const payoutRouter = require("../providers/payoutRouter");

function positiveAmount(value, field = "amount") {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${field} invalide`);
  return n;
}

function ref(prefix = "PAY") {
  return `OMNIPAY-${prefix}-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;
}

async function confirmPayin({ userId, amount, provider, providerRef, idempotencyKey }) {
  if (!userId || !provider || !providerRef) throw new Error("Pay-in incomplet");
  return secureLedger.creditPayin({
    userId,
    amount: positiveAmount(amount),
    provider,
    providerRef,
    idempotencyKey: idempotencyKey || `${provider}:payin:${providerRef}`,
  });
}

async function withdraw({ userId, amount, fee = 0, provider, destination, idempotencyKey, callbackUrl }) {
  if (!userId || !provider || !destination) throw new Error("Retrait incomplet");
  const cleanAmount = positiveAmount(amount);
  const cleanFee = Number(fee || 0);
  if (!Number.isFinite(cleanFee) || cleanFee < 0) throw new Error("Frais invalides");

  const operationKey = idempotencyKey || ref("OUT");
  const reservation = await secureLedger.reserveWithdrawal({
    userId,
    amount: cleanAmount,
    fee: cleanFee,
    provider,
    destination,
    idempotencyKey: operationKey,
  });

  const transactionId = reservation.transactionId || reservation.id;
  if (!transactionId) throw new Error("transactionId absent de la reservation");

  try {
    const result = await payoutRouter.payout({
      txId: transactionId,
      operator: provider,
      phone: destination,
      amount: cleanAmount,
      callbackUrl,
    });

    const status = String(result && result.status || "").toLowerCase();

    if (["success", "successful", "completed", "paid"].includes(status)) {
      const settlementRef = result.providerRef || result.reference || result.transactionId || operationKey;
      await secureLedger.completeWithdrawal({
        transactionId,
        settlementRef,
        channel: provider,
      });
      return { ok: true, status: "completed", transactionId, providerResult: result };
    }

    if (["pending", "processing", "queued", "submitted"].includes(status)) {
      return { ok: true, status: "pending", transactionId, providerResult: result };
    }

    await secureLedger.releaseWithdrawal({
      transactionId,
      note: `Echec payout ${provider}: ${status || "unknown"}`,
    });
    return { ok: false, status: "failed", transactionId, providerResult: result };
  } catch (error) {
    // Un timeout peut cacher un paiement effectivement parti. On garde donc
    // la reservation pour reconciliation au lieu de recréditer automatiquement.
    if (["ETIMEDOUT", "ECONNRESET", "PROVIDER_TIMEOUT"].includes(error.code)) {
      error.transactionId = transactionId;
      error.reconciliationRequired = true;
      throw error;
    }

    await secureLedger.releaseWithdrawal({ transactionId, note: error.message || "Payout failed" });
    throw error;
  }
}

async function completeWithdrawal({ transactionId, settlementRef, channel }) {
  return secureLedger.completeWithdrawal({ transactionId, settlementRef, channel });
}

async function releaseWithdrawal({ transactionId, note }) {
  return secureLedger.releaseWithdrawal({ transactionId, note });
}

module.exports = { confirmPayin, withdraw, completeWithdrawal, releaseWithdrawal };
