"use strict";

// PI-SPI supervise par OMNIPAY.
// Aucun appel bancaire ni secret n'est utilise dans ce connecteur.
// Une sortie reste en attente jusqu'a la saisie d'une reference bancaire reelle.

const clean = (value, max = 160) =>
  String(value == null ? "" : value)
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, max);

const amountOk = (value) => {
  const amount = Number(value);
  return Number.isInteger(amount) && amount > 0;
};

function pispiAlias() {
  return clean(
    process.env.PISPI_OMNIPAY_ALIAS ||
    process.env.TREASURY_PISPI_ALIAS ||
    "1ced2141-456f-4a2c-af30-06b22360bb24", // alias PI-SPI officiel ETS OMNIPAY (EcobankPay)
    120
  );
}

function configured() {
  return Boolean(pispiAlias());
}

function publicConfig() {
  return {
    mode: "supervised",
    configured: configured(),
    alias: pispiAlias() || null,
    accountLabel:
      clean(process.env.PISPI_ACCOUNT_LABEL, 120) ||
      "Compte PI-SPI OMNIPAY",
    currency: "XOF",
    automatic: false
  };
}

function preparePayout({ txId, operator, phone, amount }) {
  if (!clean(txId, 100) || !amountOk(amount)) {
    return {
      status: "refused",
      detail: "Donnees de retrait PI-SPI invalides."
    };
  }

  const destination = clean(phone, 80);

  if (destination.length < 5) {
    return {
      status: "refused",
      detail: "Alias ou numero destinataire invalide."
    };
  }

  return {
    status: "unavailable",
    detail:
      "PI-SPI supervise : payer depuis le compte OMNIPAY, saisir la reference reelle, puis cliquer Paye.",
    ref: clean(txId, 100),
    supervised: true,
    instruction: {
      txId: clean(txId, 100),
      operator: clean(operator, 30).toLowerCase(),
      destination,
      amountXof: Number(amount),
      sourceAlias: publicConfig().alias
    }
  };
}

function normalizeRealOperation(input = {}) {
  const externalId = clean(
    input.externalId || input.txId || input.end2endId,
    160
  );

  const amountXof = Math.round(
    Number(input.amountXof || input.amount)
  );

  const status = clean(
    input.status || "IRREVOCABLE",
    30
  ).toUpperCase();

  if (externalId.length < 6) {
    throw new Error("Reference PI-SPI reelle requise.");
  }

  if (!amountOk(amountXof)) {
    throw new Error("Montant PI-SPI invalide.");
  }

  return {
    externalId,
    end2endId: clean(input.end2endId, 160) || null,
    txId: clean(input.txId, 160) || null,
    amountXof,
    status,
    payerAlias: clean(input.payerAlias, 160) || null,
    payeeAlias: clean(input.payeeAlias, 160) || null,
    note: clean(input.note, 240) || null
  };
}

module.exports = {
  configured,
  publicConfig,
  preparePayout,
  normalizeRealOperation
};
