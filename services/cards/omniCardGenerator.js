"use strict";

const crypto = require("crypto");

const CARD_TYPES = Object.freeze({
  VIRTUAL: "VIRTUAL",
  PHYSICAL: "PHYSICAL",
});

const CARD_STATUSES = Object.freeze({
  CREATED: "CREATED",
  ACTIVE: "ACTIVE",
  FROZEN: "FROZEN",
  BLOCKED: "BLOCKED",
  CANCELLED: "CANCELLED",
});

const SUPPORTED_CURRENCIES = new Set([
  "XOF",
  "EUR",
  "USD",
  "USDT",
]);

function randomDigits(length) {
  let output = "";

  while (output.length < length) {
    const bytes = crypto.randomBytes(length);

    for (const byte of bytes) {
      output += String(byte % 10);

      if (output.length === length) {
        break;
      }
    }
  }

  return output;
}

function normalizeType(value) {
  const type = String(value || "").trim().toUpperCase();

  if (!Object.values(CARD_TYPES).includes(type)) {
    throw new Error("Le type doit etre VIRTUAL ou PHYSICAL.");
  }

  return type;
}

function normalizeCurrency(value) {
  const currency = String(value || "XOF").trim().toUpperCase();

  if (!SUPPORTED_CURRENCIES.has(currency)) {
    throw new Error("Devise non prise en charge.");
  }

  return currency;
}

function normalizeHolderName(value) {
  const holderName = String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();

  if (holderName.length < 2 || holderName.length > 40) {
    throw new Error("Nom du titulaire invalide.");
  }

  return holderName;
}

function createPublicNumber() {
  return `OMNI-${randomDigits(4)}-${randomDigits(4)}-${randomDigits(4)}`;
}

function createCardReference(type) {
  const prefix = type === CARD_TYPES.VIRTUAL ? "OVC" : "OPC";

  return [
    prefix,
    Date.now().toString(36).toUpperCase(),
    crypto.randomBytes(4).toString("hex").toUpperCase(),
  ].join("-");
}

function generateOmniCard({
  userId,
  holderName,
  type,
  currency = "XOF",
  design = "MIDNIGHT",
} = {}) {
  if (!userId) {
    throw new Error("Utilisateur obligatoire.");
  }

  const normalizedType = normalizeType(type);
  const normalizedCurrency = normalizeCurrency(currency);
  const normalizedName = normalizeHolderName(holderName);
  const publicNumber = createPublicNumber();
  const now = new Date().toISOString();

  return {
    cardId: crypto.randomUUID(),
    userId: String(userId),
    cardReference: createCardReference(normalizedType),

    publicNumber,
    maskedNumber: `OMNI-****-****-${publicNumber.slice(-4)}`,
    last4: publicNumber.slice(-4),

    holderName: normalizedName,
    type: normalizedType,
    currency: normalizedCurrency,
    design: String(design || "MIDNIGHT").trim().toUpperCase(),

    status: CARD_STATUSES.ACTIVE,

    provider: null,
    providerCardId: null,
    providerToken: null,

    internalToken: `oc_tok_${crypto.randomBytes(32).toString("hex")}`,

    spendingControls: {
      onlinePayments: normalizedType === CARD_TYPES.VIRTUAL,
      contactlessPayments: normalizedType === CARD_TYPES.PHYSICAL,
      cashWithdrawal: false,
      internationalPayments: false,
      dailyLimitMinor: 0,
      monthlyLimitMinor: 0,
    },

    physicalOrder:
      normalizedType === CARD_TYPES.PHYSICAL
        ? {
            status: "ADDRESS_REQUIRED",
            shippingAddressId: null,
            trackingReference: null,
          }
        : null,

    createdAt: now,
    updatedAt: now,
  };
}

module.exports = {
  CARD_TYPES,
  CARD_STATUSES,
  generateOmniCard,
};
