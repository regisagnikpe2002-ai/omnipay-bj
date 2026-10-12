"use strict";

const client = require("./client");

const health = client.healthCheck();

console.log("==================================");
console.log("OMNICHECK BINANCE");
console.log("==================================");

console.log("Provider :", health.provider);
console.log("Testnet  :", health.testnet);

if (health.configured) {
  console.log("STATUT   : OK");
} else {
  console.log("STATUT   : WARN");
  console.log("Cause    : BINANCE_API_KEY ou BINANCE_API_SECRET manquante");
}
