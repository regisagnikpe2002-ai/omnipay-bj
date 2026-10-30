"use strict";

const crypto = require("crypto");

const STATUSES = Object.freeze({
  CLICKED: "clicked",
  OPENING_PENDING: "opening_pending",
  OPENED_UNCONFIRMED: "opened_unconfirmed",
  CONFIRMED: "confirmed",
  REJECTED: "rejected",
  EXPIRED: "expired"
});

const ALLOWED_TRANSITIONS = Object.freeze({
  clicked: ["opening_pending", "rejected", "expired"],
  opening_pending: ["opened_unconfirmed", "rejected", "expired"],
  opened_unconfirmed: ["confirmed", "rejected", "expired"],
  confirmed: [],
  rejected: [],
  expired: []
});

function clean(value, max = 180) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function normalizeProvider(value) {
  const provider = clean(value, 40).toLowerCase();
  const allowed = ["mtn", "moov", "celtiis", "binance", "paypal", "bhn", "reloadly"];
  if (!allowed.includes(provider)) throw new Error("Prestataire d'affiliation invalide.");
  return provider;
}

function safeDestinationUrl(value) {
  const raw = clean(value, 1000);
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    throw new Error("Lien d'affiliation invalide.");
  }
  if (url.protocol !== "https:") throw new Error("Le lien d'affiliation doit utiliser HTTPS.");
  return url.toString();
}

function createClick(input = {}) {
  const provider = normalizeProvider(input.provider);
  const campaignId = clean(input.campaignId, 100);
  const destinationUrl = safeDestinationUrl(input.destinationUrl);
  if (!campaignId) throw new Error("campaignId obligatoire.");

  return Object.freeze({
    trackingId: "AFF_" + crypto.randomUUID(),
    provider,
    campaignId,
    userId: clean(input.userId, 80) || null,
    destinationUrl,
    status: STATUSES.CLICKED,
    externalReference: null,
    providerReference: null,
    revenueEventId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: input.metadata && typeof input.metadata === "object"
      ? Object.freeze({ ...input.metadata })
      : Object.freeze({})
  });
}

function transition(record, nextStatus, details = {}) {
  if (!record || typeof record !== "object" || !record.trackingId) {
    throw new Error("Tracking d'affiliation invalide.");
  }

  const next = clean(nextStatus, 40).toLowerCase();
  if (!Object.values(STATUSES).includes(next)) {
    throw new Error("Statut d'affiliation invalide.");
  }

  const allowed = ALLOWED_TRANSITIONS[record.status] || [];
  if (!allowed.includes(next)) {
    throw new Error(`Transition interdite: ${record.status} -> ${next}.`);
  }

  const externalReference = clean(details.externalReference, 180);
  const providerReference = clean(details.providerReference, 180);

  if (next === STATUSES.OPENED_UNCONFIRMED && !externalReference) {
    throw new Error("Référence d'ouverture obligatoire.");
  }
  if (next === STATUSES.CONFIRMED && !providerReference) {
    throw new Error("Confirmation du prestataire obligatoire.");
  }

  return Object.freeze({
    ...record,
    status: next,
    externalReference: externalReference || record.externalReference || null,
    providerReference: providerReference || record.providerReference || null,
    rejectionReason: next === STATUSES.REJECTED
      ? clean(details.reason, 240) || "rejected_by_provider"
      : record.rejectionReason || null,
    updatedAt: new Date().toISOString()
  });
}

function attachRevenueEvent(record, revenueEvent) {
  if (!record || record.status !== STATUSES.CONFIRMED) {
    throw new Error("La commission exige une affiliation confirmée.");
  }
  if (!revenueEvent || revenueEvent.status !== "confirmed" || !revenueEvent.eventId) {
    throw new Error("Événement de revenu confirmé obligatoire.");
  }
  if (record.provider !== revenueEvent.source) {
    throw new Error("Le prestataire du revenu ne correspond pas au tracking.");
  }

  return Object.freeze({
    ...record,
    revenueEventId: revenueEvent.eventId,
    updatedAt: new Date().toISOString()
  });
}

function canRecognizeRevenue(record) {
  return Boolean(
    record &&
    record.status === STATUSES.CONFIRMED &&
    record.providerReference
  );
}

module.exports = {
  STATUSES,
  createClick,
  transition,
  attachRevenueEvent,
  canRecognizeRevenue
};
