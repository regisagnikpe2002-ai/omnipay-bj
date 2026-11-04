"use strict";

const crypto = require("crypto");
const registry = require("./treasuryRegistry");

const OPERATORS = new Set(["mtn", "moov", "celtiis"]);

function clean(value, n = 160) {
  return String(value == null ? "" : value)
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, n);
}

function normalizeOperator(value) {
  const operator = clean(value, 20).toLowerCase();
  if (!OPERATORS.has(operator)) throw new Error("Operateur non pris en charge.");
  return operator;
}

function normalizeCapability(value) {
  const capability = clean(value, 8).toLowerCase();
  if (!['in', 'out'].includes(capability)) throw new Error("Capacite invalide.");
  return capability;
}

function usable(account, capability) {
  try {
    return Boolean(account && registry.canUse(account, capability));
  } catch (_) {
    return false;
  }
}

function typeOf(account) {
  return clean(account && account.type, 40).toLowerCase();
}

function labelOf(account) {
  return clean(`${account && account.label || ''} ${account && account.institution || ''}`, 240).toLowerCase();
}

function matchesMerchantSim(account, operator) {
  const type = typeOf(account);
  const label = labelOf(account);
  return (
    type === `${operator}_merchant` ||
    type === `${operator}_sim` ||
    type === "merchant_sim"
  ) && label.includes(operator === "celtiis" ? "celti" : operator);
}

function routeKind(account, operator) {
  const type = typeOf(account);
  if (type === "pawapay") return "pawapay";
  if (type === "pispi") return "pispi";
  if (matchesMerchantSim(account, operator)) return "merchant_sim";
  return null;
}

function priority(operator) {
  if (operator === "mtn" || operator === "moov") {
    return ["pawapay", "pispi", "merchant_sim"];
  }
  return ["pispi", "merchant_sim"];
}

function candidates({ accounts, operator, capability }) {
  const op = normalizeOperator(operator);
  const cap = normalizeCapability(capability);
  const list = Array.isArray(accounts) ? accounts : [];
  const order = priority(op);

  return list
    .filter((account) => usable(account, cap))
    .map((account) => ({ account, route: routeKind(account, op) }))
    .filter((item) => item.route && order.includes(item.route))
    .sort((a, b) => order.indexOf(a.route) - order.indexOf(b.route));
}

function chooseRoute({ accounts, operator, capability = "out" }) {
  const op = normalizeOperator(operator);
  const cap = normalizeCapability(capability);
  const list = candidates({ accounts, operator: op, capability: cap });

  if (!list.length) {
    return {
      ok: false,
      operator: op,
      capability: cap,
      route: null,
      treasuryId: null,
      reason: "Aucune tresorerie operationnelle n'est disponible pour cette operation."
    };
  }

  const selected = list[0];
  return {
    ok: true,
    operator: op,
    capability: cap,
    route: selected.route,
    treasuryId: clean(selected.account.id, 120),
    treasury: registry.publicView(selected.account)
  };
}

function makeTransferPlan({
  accounts,
  operator,
  capability = "out",
  transactionId,
  destination,
  amount,
  currency = "XOF"
}) {
  const tx = clean(transactionId, 120);
  const dest = clean(destination, 160);
  const value = Math.round(Number(amount));

  if (!tx) throw new Error("transactionId requis.");
  if (!dest) throw new Error("Destination requise.");
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Montant invalide.");

  const selected = chooseRoute({ accounts, operator, capability });
  const routeDecisionId = crypto.randomUUID();

  return {
    routeDecisionId,
    transactionId: tx,
    createdAt: new Date().toISOString(),
    operator: selected.operator,
    capability: selected.capability,
    destination: dest,
    amount: value,
    currency: clean(currency, 10).toUpperCase() || "XOF",
    route: selected.route,
    treasuryId: selected.treasuryId,
    routeLocked: Boolean(selected.ok),
    status: selected.ok ? "reserved" : "pending_route",
    reason: selected.reason || null,
    treasury: selected.treasury || null
  };
}

function assertRouteLocked(plan) {
  if (!plan || !plan.routeLocked || !plan.route || !plan.treasuryId) {
    throw new Error("Route de transfert non verrouillee.");
  }
  return true;
}

function markSubmitted(plan, providerReference) {
  assertRouteLocked(plan);
  const ref = clean(providerReference, 160);
  if (!ref) throw new Error("Reference fournisseur requise.");

  return {
    ...plan,
    providerReference: ref,
    status: "processing",
    submittedAt: new Date().toISOString()
  };
}

function markFinal(plan, status, settlementReference) {
  assertRouteLocked(plan);
  const normalized = clean(status, 20).toLowerCase();
  if (!['completed', 'failed'].includes(normalized)) throw new Error("Statut final invalide.");
  const ref = clean(settlementReference, 160);
  if (normalized === 'completed' && !ref) throw new Error("Reference de reglement requise.");

  return {
    ...plan,
    settlementReference: ref || null,
    status: normalized,
    finalizedAt: new Date().toISOString()
  };
}

module.exports = {
  candidates,
  chooseRoute,
  makeTransferPlan,
  assertRouteLocked,
  markSubmitted,
  markFinal
};
