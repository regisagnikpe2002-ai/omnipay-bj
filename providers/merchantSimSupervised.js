"use strict";

/*
 * OMNIPAY - Caisses marchandes locales supervisees.
 *
 * Objectif:
 * - MTN, Moov et Celtiis servent de caisses IN/OUT de dernier kilometre.
 * - PI-SPI reste le rail XOF prioritaire lorsqu'un alias est disponible.
 * - Aucun PIN, mot de passe, OTP operateur ou secret bancaire n'est stocke.
 * - Ce fichier ne deplace aucun argent et n'appelle aucune API operateur.
 * - Toute operation reelle doit etre confirmee dans OMNICHECK avec une
 *   reference externe unique avant cloture.
 */

const OPERATORS = Object.freeze({
  mtn: Object.freeze({
    code: "mtn",
    name: "MTN MoMo",
    currency: "XOF",
    payin: true,
    payout: true
  }),
  moov: Object.freeze({
    code: "moov",
    name: "Moov Money",
    currency: "XOF",
    payin: true,
    payout: true
  }),
  celtiis: Object.freeze({
    code: "celtiis",
    name: "Celtiis Cash",
    currency: "XOF",
    payin: true,
    payout: true
  })
});

const clean = (value, max = 160) =>
  String(value == null ? "" : value)
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, max);

const integerAmount = (value) => {
  const amount = Math.round(Number(value));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
};

function normalizePhone(value) {
  let phone = String(value || "").replace(/\D/g, "");
  if (phone.startsWith("00")) phone = phone.slice(2);
  if (phone.startsWith("229")) phone = phone.slice(3);
  if (!/^\d{8,10}$/.test(phone)) {
    throw new Error("Numero Mobile Money invalide.");
  }
  return phone;
}

function getOperator(code) {
  return OPERATORS[clean(code, 20).toLowerCase()] || null;
}

function envName(operator, suffix) {
  return `MERCHANT_${operator.toUpperCase()}_${suffix}`;
}

function accountConfig(operatorCode) {
  const operator = getOperator(operatorCode);
  if (!operator) throw new Error("Operateur marchand inconnu.");

  const number = clean(process.env[envName(operator.code, "NUMBER")], 40);
  const label = clean(process.env[envName(operator.code, "LABEL")], 100);
  const activeValue = clean(
    process.env[envName(operator.code, "ACTIVE")] || "off",
    10
  ).toLowerCase();

  return {
    operator: operator.code,
    name: operator.name,
    currency: operator.currency,
    number: number || null,
    label: label || `Caisse marchande ${operator.name}`,
    active: ["1", "true", "on", "yes"].includes(activeValue) && Boolean(number),
    payin: operator.payin,
    payout: operator.payout,
    mode: "supervised"
  };
}

function publicConfig() {
  return Object.keys(OPERATORS).map(accountConfig);
}

function preparePayout({ txId, operator, phone, amount }) {
  const account = accountConfig(operator);
  const amountXof = integerAmount(amount);
  const destination = normalizePhone(phone);
  const reference = clean(txId, 100);

  if (!reference || !amountXof) {
    return {
      status: "refused",
      detail: "Donnees du retrait marchand invalides."
    };
  }

  if (!account.active) {
    return {
      status: "unavailable",
      supervised: true,
      route: "merchant_sim",
      detail: `${account.name}: caisse marchande non activee.`,
      instruction: {
        txId: reference,
        operator: account.operator,
        destination,
        amountXof,
        sourceNumber: account.number
      }
    };
  }

  return {
    status: "unavailable",
    supervised: true,
    route: "merchant_sim",
    ref: reference,
    detail:
      "Paiement supervise: effectuer le transfert depuis la SIM marchande, puis saisir la reference reelle dans OMNICHECK.",
    instruction: {
      txId: reference,
      operator: account.operator,
      destination,
      amountXof,
      sourceNumber: account.number,
      sourceLabel: account.label
    }
  };
}

function normalizeInbound(input = {}) {
  const operator = getOperator(input.operator || input.channel);
  if (!operator) throw new Error("Operateur entrant inconnu.");

  const externalId = clean(
    input.externalId || input.transactionId || input.reference,
    160
  );
  const amountXof = integerAmount(input.amountXof || input.amount);
  const payer = clean(input.payer || input.phone, 120);
  const omReference = clean(input.omReference || input.omId, 40).toUpperCase();

  if (externalId.length < 6) {
    throw new Error("Reference reelle de depot requise.");
  }
  if (!amountXof) throw new Error("Montant de depot invalide.");

  return {
    channel: operator.code,
    externalId,
    amount: amountXof,
    currency: "XOF",
    reference: omReference || null,
    payer: payer || null,
    source: "merchant_sim_supervised"
  };
}

function normalizeSettlement(input = {}) {
  const operator = getOperator(input.operator || input.channel);
  if (!operator) throw new Error("Operateur de reglement inconnu.");

  const paymentRef = clean(
    input.paymentRef || input.transactionId || input.reference,
    160
  );
  const amountXof = integerAmount(input.amountXof || input.amount);

  if (paymentRef.length < 6) {
    throw new Error("Reference reelle du paiement requise.");
  }
  if (!amountXof) throw new Error("Montant de paiement invalide.");

  return {
    channel: operator.code,
    paymentRef,
    amountXof,
    status: "confirmed_by_admin",
    confirmedAt: new Date().toISOString(),
    source: "merchant_sim_supervised"
  };
}

module.exports = {
  getOperator,
  accountConfig,
  publicConfig,
  preparePayout,
  normalizeInbound,
  normalizeSettlement,
  normalizePhone
};
