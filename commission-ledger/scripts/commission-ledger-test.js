"use strict";
const assert = require("assert");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { CommissionLedger, allocate } = require("../services/CommissionLedger");

const filePath = path.join(os.tmpdir(), `omnipay-ledger-${Date.now()}.jsonl`);
const ledger = new CommissionLedger({ filePath });
const allocations = allocate(100);
assert.deepEqual(allocations, { operations: 40, productDevelopment: 30, firstOffice: 20, riskReserve: 10 });
ledger.recordCommission({ transactionId: "tx-test", provider: "paydunya", grossAmount: 10000, providerFee: 200, commissionAmount: 100, userId: "user-test" });
const summary = ledger.summary();
assert.equal(summary.count, 1);
assert.equal(summary.commissionAmount, 100);
assert.equal(summary.allocations.firstOffice, 20);
fs.unlinkSync(filePath);
console.log("COMMISSION_LEDGER_TEST_OK");
