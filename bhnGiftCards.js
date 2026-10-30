"use strict";

const SANDBOX_BASE_URL = "https://api-sandbox.blackhawknetwork.com";
const LIVE_BASE_URL = "https://api-external.blackhawknetwork.com";
const SANDBOX_TOKEN_URL = "https://auth-pp.blackhawknetwork.com/realms/dev-experience/protocol/openid-connect/token";
const LIVE_TOKEN_URL = "https://auth.blackhawknetwork.com/realms/core-apps/protocol/openid-connect/token";

let tokenCache = { token: null, expiresAt: 0, mode: null };

function mode() {
  return String(process.env.BHN_MODE || "sandbox").toLowerCase() === "live"
    ? "live"
    : "sandbox";
}

function baseUrl() {
  return mode() === "live" ? LIVE_BASE_URL : SANDBOX_BASE_URL;
}

function tokenUrl() {
  return mode() === "live" ? LIVE_TOKEN_URL : SANDBOX_TOKEN_URL;
}

function configured() {
  return Boolean(process.env.BHN_CLIENT_ID && process.env.BHN_CLIENT_SECRET);
}

function publicConfig() {
  return {
    provider: "bhn",
    mode: mode(),
    configured: configured(),
    capabilities: ["catalog"]
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

async function accessToken() {
  if (!configured()) {
    throw new Error("BHN non configuré: BHN_CLIENT_ID et BHN_CLIENT_SECRET sont requis.");
  }

  const currentMode = mode();
  const now = Date.now();
  if (
    tokenCache.token &&
    tokenCache.mode === currentMode &&
    now < tokenCache.expiresAt
  ) {
    return tokenCache.token;
  }

  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.BHN_CLIENT_ID,
    client_secret: process.env.BHN_CLIENT_SECRET,
    scope: "openid"
  });

  const response = await fetch(tokenUrl(), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  const body = await readJson(response);
  if (!response.ok || !body.access_token) {
    const error = new Error("Authentification BHN refusée.");
    error.status = response.status;
    error.providerBody = body;
    throw error;
  }

  const expiresIn = Math.max(Number(body.expires_in || 300), 60);
  tokenCache = {
    token: body.access_token,
    mode: currentMode,
    expiresAt: now + Math.max(expiresIn - 30, 30) * 1000
  };
  return tokenCache.token;
}

async function request(path, options = {}) {
  const token = await accessToken();
  const response = await fetch(baseUrl() + path, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: "Bearer " + token,
      ...(options.headers || {})
    }
  });

  const body = await readJson(response);
  if (!response.ok) {
    const error = new Error("BHN HTTP " + response.status);
    error.status = response.status;
    error.providerBody = body;
    throw error;
  }
  return body;
}

async function listCatalog({ pageNumber = 1, pageSize = 10 } = {}) {
  const page = Math.max(Number(pageNumber) || 1, 1);
  const size = Math.min(Math.max(Number(pageSize) || 10, 1), 100);
  const params = new URLSearchParams({
    pageNumber: String(page),
    pageSize: String(size)
  });
  return request("/v1/catalogs/default?" + params.toString());
}

module.exports = {
  publicConfig,
  configured,
  accessToken,
  listCatalog
};
