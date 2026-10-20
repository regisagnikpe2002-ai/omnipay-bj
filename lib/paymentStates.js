"use strict";

const STATES = Object.freeze({
  CREATED: "created",
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  REFUNDED: "refunded",
  MANUAL_REVIEW: "manual_review",
});

const TRANSITIONS = Object.freeze({
  created: ["pending", "manual_review", "cancelled"],
  pending: [
    "processing",
    "completed",
    "failed",
    "cancelled",
    "manual_review",
  ],
  processing: ["completed", "failed", "manual_review"],
  manual_review: [
    "pending",
    "processing",
    "completed",
    "failed",
    "cancelled",
  ],
  failed: ["refunded"],
  completed: ["refunded"],
  cancelled: [],
  refunded: [],
});

function assertTransition(from, to) {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new Error(
      `Transition de paiement interdite: ${from} -> ${to}`
    );
  }
}

module.exports = {
  STATES,
  TRANSITIONS,
  assertTransition,
};
