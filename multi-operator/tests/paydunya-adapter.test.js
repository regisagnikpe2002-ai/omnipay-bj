"use strict";

const assert = require("assert");
const PayDunyaProvider = require("../providers/PayDunyaProvider");

async function fakeCreateInvoice(input) {
  assert.equal(input.amount, 2500);
  assert.equal(input.userId, "user-test");
  assert.equal(input.customData.provider, "paydunya");

  return {
    response_text: "https://paydunya.example/checkout/test-token",
    token: "test-token",
    status: "pending",
  };
}

async function fakeConfirmInvoice(token) {
  assert.equal(token, "test-token");
  return { status: "completed", token };
}

(async () => {
  const provider = new PayDunyaProvider({
    config: {
      name: "paydunya",
      enabled: true,
      collections: true,
      disbursements: false,
    },
    createInvoice: fakeCreateInvoice,
    confirmInvoice: fakeConfirmInvoice,
  });

  const collection = await provider.collect({
    operationId: "operation-test",
    idempotencyKey: "idempotency-test",
    amount: 2500,
    currency: "XOF",
    userId: "user-test",
    callbackUrl: "https://www.omnipay-bj.com/wallet/deposit/callback",
    metadata: {
      returnUrl: "https://www.omnipay-bj.com/dashboard-v2.html",
    },
  });

  assert.equal(collection.status, "pending");
  assert.equal(collection.providerReference, "test-token");
  assert.ok(collection.paymentUrl.includes("test-token"));

  const status = await provider.getCollectionStatus("test-token");
  assert.equal(status.status, "completed");

  const webhook = await provider.handleWebhook({
    data: { invoice: { token: "test-token" } },
  });
  assert.equal(webhook.status, "completed");

  console.log("PAYDUNYA_ADAPTER_TEST_OK");
})().catch((error) => {
  console.error("PAYDUNYA_ADAPTER_TEST_FAILED", error);
  process.exitCode = 1;
});
