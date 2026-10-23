"use strict";

module.exports = {
  defaultCurrency: process.env.OMNIPAY_CURRENCY || "XOF",
  timeoutMs: Number(process.env.CONNECTOR_TIMEOUT_MS || 15000),
  piSpi: {
    enabled: process.env.PISPI_ENABLED === "true",
    mock: process.env.PISPI_MOCK !== "false",
    baseUrl: process.env.PISPI_BASE_URL || "",
    tokenUrl: process.env.PISPI_TOKEN_URL || "",
    clientId: process.env.PISPI_CLIENT_ID || "",
    clientSecret: process.env.PISPI_CLIENT_SECRET || "",
    scope: process.env.PISPI_SCOPE || "",
    participantId: process.env.PISPI_PARTICIPANT_ID || "",
    paths: {
      pay: process.env.PISPI_PAY_PATH || "/payments",
      status: process.env.PISPI_STATUS_PATH || "/payments/{id}",
      requestToPay: process.env.PISPI_RTP_PATH || "/requests-to-pay",
      alias: process.env.PISPI_ALIAS_PATH || "/aliases/resolve"
    }
  },
  wallets: {
    mtn: { enabled: process.env.MTN_ENABLED === "true", baseUrl: process.env.MTN_BASE_URL || "", apiKey: process.env.MTN_API_KEY || "" },
    moov: { enabled: process.env.MOOV_ENABLED === "true", baseUrl: process.env.MOOV_BASE_URL || "", apiKey: process.env.MOOV_API_KEY || "" },
    celtiis: { enabled: process.env.CELTIIS_ENABLED === "true", baseUrl: process.env.CELTIIS_BASE_URL || "", apiKey: process.env.CELTIIS_API_KEY || "" }
  }
};
