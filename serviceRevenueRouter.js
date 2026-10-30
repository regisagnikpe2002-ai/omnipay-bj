"use strict";

const crypto = require("crypto");

const REVENUE_TYPES = Object.freeze({
  PAYMENT_COMMISSION: "payment_commission",
  AFFILIATE_COMMISSION: "affiliate_commission",
  GIFT_CARD_MARGIN: "gift_card_margin",
  PROVIDER_REBATE: "provider_rebate"
});

const SOURCES = Object.freeze({
  MTN: "mtn",
  MOOV: "moov",
  CELTIIS: "celtiis",
  BINANCE: "binance",
  PAYPAL: "paypal",
  BHN: "bhn",
  RELOADLY: "reloadly",
  OTHER: "other"
});

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function clean(value, max = 160) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function basisPoints(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 10000 ? n : null;
}

function calculate(input = {}) {
  const grossXof = money(input.grossXof);
  const providerCostXof = money(input.providerCostXof ?? 0);
  const paymentFeesXof = money(input.paymentFeesXof ?? 0);
  const fixedCommissionXof = money(input.fixedCommissionXof ?? 0);
  const commissionBps = basisPoints(input.commissionBps ?? 0);

  if (
    grossXof === null ||
    providerCostXof === null ||
    paymentFeesXof === null ||
    fixedCommissionXof === null ||
    commissionBps === null
  ) {
    throw new Error("Paramètres financiers invalides.");
  }

  const percentageCommissionXof = Math.floor(
    grossXof * commissionBps / 10000
  );
  const contractualCommissionXof =
    fixedCommissionXof + percentageCommissionXof;
  const commercialMarginXof =
    grossXof - providerCostXof - paymentFeesXof;
  const revenueXof = Math.max(
    contractualCommissionXof,
    commercialMarginXof,
    0
  );

  return Object.freeze({
    grossXof,
    providerCostXof,
    paymentFeesXof,
    fixedCommissionXof,
    commissionBps,
    percentageCommissionXof,
    contractualCommissionXof,
    commercialMarginXof,
    revenueXof
  });
}

function createRevenueEvent(input = {}) {
  const source = clean(input.source, 40).toLowerCase();
  const type = clean(input.type, 60).toLowerCase();
  const externalReference = clean(input.externalReference, 180);
  const idempotencyKey = clean(input.idempotencyKey, 180);

  if (!Object.values(SOURCES).includes(source)) {
    throw new Error("Source de revenu invalide.");
  }
  if (!Object.values(REVENUE_TYPES).includes(type)) {
    throw new Error("Type de revenu invalide.");
  }
  if (!externalReference) {
    throw new Error("Référence externe obligatoire.");
  }
  if (!idempotencyKey) {
    throw new Error("Clé d'idempotence obligatoire.");
  }

  const financials = calculate(input);

  return Object.freeze({
    eventId: "REV_" + crypto.randomUUID(),
    source,
    type,
    status: "pending_confirmation",
    externalReference,
    idempotencyKey,
    userId: clean(input.userId, 80) || null,
    campaignId: clean(input.campaignId, 80) || null,
    currency: "XOF",
    ...financials,
    createdAt: new Date().toISOString(),
    metadata: input.metadata && typeof input.metadata === "object"
      ? Object.freeze({ ...input.metadata })
      : Object.freeze({})
  });
}

function confirmRevenue(event, confirmation = {}) {
  if (!event || typeof event !== "object" || !event.eventId) {
    throw new Error("Événement de revenu invalide.");
  }

  const providerReference = clean(
    confirmation.providerReference,
    180
  );
  if (!providerReference) {
    throw new Error("Confirmation fournisseur obligatoire.");
  }

  return Object.freeze({
    ...event,
    status: "confirmed",
    providerReference,
    confirmedAt: new Date().toISOString()
  });
}

module.exports = {
  REVENUE_TYPES,
  SOURCES,
  money,
  calculate,
  createRevenueEvent,
  confirmRevenue
};
