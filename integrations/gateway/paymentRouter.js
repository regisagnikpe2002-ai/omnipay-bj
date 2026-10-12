"use strict";

function resolveProvider(method) {
  switch (method) {
    case "mobile_money":
    case "deposit":
    case "paydunya":
      return "paydunya";

    case "crypto":
    case "binance":
    case "usdt":
    case "btc":
    case "bnb":
      return "binance";

    default:
      throw new Error(`Provider inconnu: ${method}`);
  }
}

module.exports = {
  resolveProvider,
};
