"use strict";

const AUTH_URL = "https://auth.reloadly.com/oauth/token";
const SANDBOX_URL = "https://giftcards-sandbox.reloadly.com";
const LIVE_URL = "https://giftcards.reloadly.com";
const ACCEPT = "application/com.reloadly.giftcards-v1+json";

let tokenCache = { token: null, expiresAt: 0, audience: null };

function mode() {
  return String(process.env.RELOADLY_MODE || "sandbox").toLowerCase() === "live"
    ? "live"
    : "sandbox";
}

function baseUrl() {
  return mode() === "live" ? LIVE_URL : SANDBOX_URL;
}

function configured() {
  return Boolean(
    process.env.RELOADLY_CLIENT_ID &&
    process.env.RELOADLY_CLIENT_SECRET
  );
}

function publicConfig() {
  return {
    provider: "reloadly",
    mode: mode(),
    configured: configured()
  };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    return { raw: text.slice(0, 1000) };
  }
}

async function request(path, options = {}) {
  const token = await accessToken();
  const response = await fetch(baseUrl() + path, {
    ...options,
    headers: {
      Accept: ACCEPT,
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
      ...(options.headers || {})
    }
  });

  const body = await readJson(response);
  if (!response.ok) {
    const error = new Error("Reloadly HTTP " + response.status);
    error.status = response.status;
    error.providerBody = body;
    throw error;
  }
  return body;
}

async function accessToken() {
  if (!configured()) {
    throw new Error("Reloadly non configuré: variables RELOADLY_CLIENT_ID et RELOADLY_CLIENT_SECRET absentes.");
  }

  const audience = baseUrl();
  const now = Date.now();
  if (tokenCache.token && tokenCache.audience === audience && now < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const response = await fetch(AUTH_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      client_id: process.env.RELOADLY_CLIENT_ID,
      client_secret: process.env.RELOADLY_CLIENT_SECRET,
      grant_type: "client_credentials",
      audience
    })
  });

  const body = await readJson(response);
  if (!response.ok || !body.access_token) {
    const error = new Error("Authentification Reloadly refusée.");
    error.status = response.status;
    error.providerBody = body;
    throw error;
  }

  const expiresIn = Number(body.expires_in || 3600);
  tokenCache = {
    token: body.access_token,
    audience,
    expiresAt: now + Math.max(60, expiresIn - 60) * 1000
  };
  return tokenCache.token;
}

async function listProducts({ countryCode = "BJ", size = 50, page = 1 } = {}) {
  const params = new URLSearchParams({
    countryCode: String(countryCode).toUpperCase(),
    size: String(Math.min(Math.max(Number(size) || 50, 1), 100)),
    page: String(Math.max(Number(page) || 1, 1))
  });
  return request("/products?" + params.toString());
}

async function getProduct(productId) {
  const id = Number(productId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("productId invalide.");
  return request("/products/" + id);
}

async function orderGiftCard(input = {}) {
  const productId = Number(input.productId);
  const quantity = Number(input.quantity || 1);
  const unitPrice = Number(input.unitPrice);
  const countryCode = String(input.countryCode || "").toUpperCase();
  const customIdentifier = String(input.customIdentifier || "").trim();
  const recipientEmail = String(input.recipientEmail || "").trim();

  if (!Number.isInteger(productId) || productId <= 0) throw new Error("productId invalide.");
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 10) throw new Error("quantity invalide.");
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) throw new Error("unitPrice invalide.");
  if (!countryCode) throw new Error("countryCode obligatoire.");
  if (!customIdentifier) throw new Error("customIdentifier obligatoire.");
  if (!recipientEmail) throw new Error("recipientEmail obligatoire.");

  return request("/orders", {
    method: "POST",
    body: JSON.stringify({
      productId,
      countryCode,
      quantity,
      unitPrice,
      customIdentifier,
      senderName: String(input.senderName || "OMNIPAY").slice(0, 80),
      recipientEmail
    })
  });
}

module.exports = {
  publicConfig,
  configured,
  listProducts,
  getProduct,
  orderGiftCard
};
