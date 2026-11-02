"use strict";

const providers = {
  mtn: require("../providers/mtn"),
  moov: require("../providers/moov"),
  celtiis: require("../providers/celtiis"),
};

async function purchase({ operator, phone, amount, reference }) {
  const key = String(operator || "").toLowerCase();
  const provider = providers[key];
  if (!provider) throw new Error("Operateur non supporte");
  if (!provider.configured()) throw new Error(`${key} non configure`);
  return provider.airtime({ phone, amount, reference });
}

module.exports = { purchase };
