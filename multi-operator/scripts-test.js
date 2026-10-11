"use strict";

const { registry, paymentOrchestrator } = require("./index");

(async () => {
  console.log("OMNIPAY MULTI-OPERATOR CORE");
  console.table(registry.list());
  console.log(await paymentOrchestrator.health());
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
