"use strict";

const crypto = require("crypto");

const DECISIONS = Object.freeze({
  ALLOW: "ALLOW",
  REVIEW: "REVIEW",
  BLOCK: "BLOCK"
});

const CODES = Object.freeze({
  ALLOWED: "SG_ALLOWED",
  INVALID_CONTEXT: "SG_INVALID_CONTEXT",
  INVALID_USER: "SG_INVALID_USER",
  INVALID_AMOUNT: "SG_INVALID_AMOUNT",
  INVALID_FEES: "SG_INVALID_FEES",
  INVALID_RAIL: "SG_INVALID_RAIL",
  INVALID_DESTINATION: "SG_INVALID_DESTINATION",
  DUPLICATE_REQUEST: "SG_DUPLICATE_REQUEST",
  ACCOUNT_RESTRICTED: "SG_ACCOUNT_RESTRICTED",
  KYC_REQUIRED: "SG_KYC_REQUIRED",
  BENEFICIARY_UNVERIFIED: "SG_BENEFICIARY_UNVERIFIED",
  INSUFFICIENT_BALANCE: "SG_INSUFFICIENT_BALANCE",
  INSUFFICIENT_RESERVE: "SG_INSUFFICIENT_RESERVE",
  RAIL_UNAVAILABLE: "SG_RAIL_UNAVAILABLE",
  LIMIT_EXCEEDED: "SG_LIMIT_EXCEEDED",
  LIQUIDITY_UNKNOWN: "SG_LIQUIDITY_UNKNOWN",
  MANUAL_REVIEW: "SG_MANUAL_REVIEW",
  INTERNAL_ERROR: "SG_INTERNAL_ERROR"
});

function makeGateId() {
  return "SG_" + crypto.randomUUID();
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function clean(value, max = 160) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function decision(gateId, status, code, reason, context = {}) {
  return Object.freeze({
    ok: status === DECISIONS.ALLOW,
    gateId,
    decision: status,
    reasonCode: code,
    reason: reason || null,
    evaluatedAt: new Date().toISOString(),
    context
  });
}

async function evaluate(input = {}) {
  const gateId = makeGateId();

  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return decision(gateId, DECISIONS.BLOCK, CODES.INVALID_CONTEXT, "Contexte invalide.");
    }

    const userId = clean(input.userId, 80);
    const rail = clean(input.rail, 40).toLowerCase();
    const destination = clean(input.destination, 160);
    const idempotencyKey = clean(input.idempotencyKey, 160);
    const amountXof = money(input.amountXof);
    const feesXof = money(input.feesXof ?? 0);

    if (!userId) {
      return decision(gateId, DECISIONS.BLOCK, CODES.INVALID_USER, "Utilisateur invalide.");
    }
    if (amountXof === null || amountXof <= 0) {
      return decision(gateId, DECISIONS.BLOCK, CODES.INVALID_AMOUNT, "Montant invalide.");
    }
    if (feesXof === null) {
      return decision(gateId, DECISIONS.BLOCK, CODES.INVALID_FEES, "Frais invalides.");
    }
    if (!rail) {
      return decision(gateId, DECISIONS.BLOCK, CODES.INVALID_RAIL, "Rail absent.");
    }
    if (!destination) {
      return decision(gateId, DECISIONS.BLOCK, CODES.INVALID_DESTINATION, "Destination absente.");
    }
    if (!idempotencyKey || input.duplicate === true) {
      return decision(gateId, DECISIONS.BLOCK, CODES.DUPLICATE_REQUEST, "Requête dupliquée ou sans clé.");
    }

    const totalDebitXof = amountXof + feesXof;
    const context = { userId, rail, destination, amountXof, feesXof, totalDebitXof };

    if (input.accountActive === false || input.accountRestricted === true) {
      return decision(gateId, DECISIONS.BLOCK, CODES.ACCOUNT_RESTRICTED, "Compte restreint.", context);
    }
    if (input.kycRequired === true && input.kycVerified !== true) {
      return decision(gateId, DECISIONS.REVIEW, CODES.KYC_REQUIRED, "Vérification KYC requise.", context);
    }
    if (input.verifiedBeneficiaryRequired === true && input.beneficiaryVerified !== true) {
      return decision(gateId, DECISIONS.BLOCK, CODES.BENEFICIARY_UNVERIFIED, "Bénéficiaire non vérifié.", context);
    }

    const balance = input.availableBalanceXof == null ? null : money(input.availableBalanceXof);
    if (balance !== null && balance < totalDebitXof) {
      return decision(gateId, DECISIONS.BLOCK, CODES.INSUFFICIENT_BALANCE, "Solde insuffisant.", { ...context, availableBalanceXof: balance });
    }

    const perTxLimit = input.perTransactionLimitXof == null ? null : money(input.perTransactionLimitXof);
    if (perTxLimit !== null && amountXof > perTxLimit) {
      return decision(gateId, DECISIONS.BLOCK, CODES.LIMIT_EXCEEDED, "Plafond par opération dépassé.", { ...context, perTransactionLimitXof: perTxLimit });
    }

    const usedDaily = input.usedDailyXof == null ? null : money(input.usedDailyXof);
    const dailyLimit = input.dailyLimitXof == null ? null : money(input.dailyLimitXof);
    if (usedDaily !== null && dailyLimit !== null && usedDaily + amountXof > dailyLimit) {
      return decision(gateId, DECISIONS.BLOCK, CODES.LIMIT_EXCEEDED, "Plafond sur 24 heures dépassé.", { ...context, usedDailyXof: usedDaily, dailyLimitXof: dailyLimit });
    }

    if (input.railAvailable === false) {
      return decision(gateId, DECISIONS.REVIEW, CODES.RAIL_UNAVAILABLE, "Rail indisponible.", context);
    }

    const reserve = input.reserveAvailableXof == null ? null : money(input.reserveAvailableXof);
    if (reserve !== null && reserve < totalDebitXof) {
      return decision(gateId, DECISIONS.REVIEW, CODES.INSUFFICIENT_RESERVE, "Réserve insuffisante.", { ...context, reserveAvailableXof: reserve });
    }
    if (input.requireKnownLiquidity === true && reserve === null) {
      return decision(gateId, DECISIONS.REVIEW, CODES.LIQUIDITY_UNKNOWN, "Liquidité non vérifiée.", context);
    }

    const reviewAbove = input.manualReviewAboveXof == null ? null : money(input.manualReviewAboveXof);
    if ((reviewAbove !== null && amountXof >= reviewAbove) || input.forceReview === true) {
      return decision(gateId, DECISIONS.REVIEW, CODES.MANUAL_REVIEW, "Validation humaine requise.", context);
    }

    return decision(gateId, DECISIONS.ALLOW, CODES.ALLOWED, null, context);
  } catch (error) {
    console.error("PAYMENT_SAFETY_GATE", error && error.message ? error.message : error);
    return decision(gateId, DECISIONS.BLOCK, CODES.INTERNAL_ERROR, "Erreur du contrôle de sécurité.");
  }
}

module.exports = {
  evaluate,
  DECISIONS,
  CODES,
  makeGateId,
  money
};
