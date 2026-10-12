"use strict";

const client = require("./client");

const health = client.healthCheck();

console.log("BINANCE CLIENT CHECK");
console.log(JSON.stringify(health, null, 2));

if (!health.configured) {
  console.log("WARN: BINANCE_API_KEY ou BINANCE_API_SECRET manquante.");
} else {
  console.log("OK: Binance configuré.");
}
