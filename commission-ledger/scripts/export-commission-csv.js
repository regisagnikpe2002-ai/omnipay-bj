#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const { CommissionLedger } = require("../services/CommissionLedger");
const ledger = new CommissionLedger();
const entries = ledger.entries();
const columns = ["recordedAt","transactionId","provider","userId","operationType","currency","grossAmount","providerFee","commissionAmount","netAmount","operations","productDevelopment","firstOffice","riskReserve","status","note"];
const q = (v) => `"${String(v ?? "").replaceAll('"','""')}"`;
const rows = [columns.join(",")];
for (const e of entries) rows.push([
 e.recordedAt,e.transactionId,e.provider,e.userId,e.operationType,e.currency,e.grossAmount,e.providerFee,e.commissionAmount,e.netAmount,
 e.allocations.operations,e.allocations.productDevelopment,e.allocations.firstOffice,e.allocations.riskReserve,e.status,e.note
].map(q).join(","));
const out = path.join(process.cwd(), "commission-ledger-export.csv");
fs.writeFileSync(out, rows.join("\n")+"\n", "utf8");
console.log(`EXPORT_CSV_OK ${out}`);
