#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const { CommissionLedger } = require("../services/CommissionLedger");
const commissionPolicy = require("../config/commissionPolicy");

const ledger = new CommissionLedger();
let failures = 0;
const ok = (m) => console.log(`OK   ${m}`);
const fail = (m) => { failures += 1; console.log(`FAIL ${m}`); };

console.log("OMNICHECK COMMISSION LEDGER");
const allocationTotal = Object.values(commissionPolicy.allocations).reduce((a,b)=>a+b,0);
Math.abs(allocationTotal - 1) < 0.000001 ? ok("Affectations = 100%") : fail("Affectations différentes de 100%");

const entries = ledger.entries();
const ids = new Set();
for (const entry of entries) {
  if (ids.has(entry.ledgerId)) fail(`ledgerId dupliqué: ${entry.ledgerId}`);
  ids.add(entry.ledgerId);
  const allocationSum = Object.values(entry.allocations || {}).reduce((a,b)=>a+Number(b||0),0);
  allocationSum === entry.commissionAmount ? ok(`Répartition équilibrée: ${entry.transactionId}`) : fail(`Répartition déséquilibrée: ${entry.transactionId}`);
  entry.grossAmount - entry.providerFee - entry.commissionAmount === entry.netAmount ? ok(`Calcul net valide: ${entry.transactionId}`) : fail(`Calcul net invalide: ${entry.transactionId}`);
}
const summary = ledger.summary();
console.log(JSON.stringify(summary, null, 2));
console.log(`STATUT: ${failures ? "ECHEC" : "OK"}`);
process.exitCode = failures ? 1 : 0;
