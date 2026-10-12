"use strict";

function buildLedgerEntry(transaction) {
  return {
    transactionId: transaction.transactionId,
    provider: transaction.provider,
    amount: transaction.amount,
    commission: transaction.commission || 50,
    createdAt: new Date().toISOString(),
  };
}

module.exports = {
  buildLedgerEntry,
};
