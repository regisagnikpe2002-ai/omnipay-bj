"use strict";
// Client API PI-SPI (envoi). OAuth2 « client credentials » puis POST /comptes/transactions.
// Variables Render : PISPI_BASE_URL, PISPI_TOKEN_URL, PISPI_CLIENT_ID, PISPI_CLIENT_SECRET, PISPI_API_KEY (si fournie), PISPI_PAYER_ACCOUNT (numéro de compte OMNIPAY).
// Ce module ne touche à aucun solde client : le débit/crédit reste décidé par l'appelant.
const crypto = require("crypto");
const env = (k) => String(process.env[k] || "").trim();
let tok = { v: null, exp: 0 };

const ready = () => Boolean(env("PISPI_BASE_URL") && env("PISPI_TOKEN_URL") && env("PISPI_CLIENT_ID") && env("PISPI_CLIENT_SECRET"));

async function token() {
  if (tok.v && Date.now() < tok.exp - 30000) return tok.v;
  const r = await fetch(env("PISPI_TOKEN_URL"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(env("PISPI_CLIENT_ID") + ":" + env("PISPI_CLIENT_SECRET")).toString("base64") },
    body: "grant_type=client_credentials", signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("PI-SPI : jeton refusé (" + r.status + ")");
  tok = { v: j.access_token, exp: Date.now() + (Number(j.expires_in) || 300) * 1000 };
  return tok.v;
}

// montant en FCFA entier ; txId unique (réutilisable pour éviter les doublons)
async function initiateTransfer({ txId, payeurNumero, payeNumero, montant }) {
  if (!ready()) throw new Error("PI-SPI non configuré (variables Render manquantes).");
  const amount = Math.floor(Number(montant));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Montant invalide.");
  const body = { txId: String(txId || crypto.randomBytes(8).toString("hex")), payeurNumero: String(payeurNumero), payeNumero: String(payeNumero), montant: amount };
  const h = { "Content-Type": "application/json", Authorization: "Bearer " + (await token()) };
  if (env("PISPI_API_KEY")) h["x-api-key"] = env("PISPI_API_KEY");
  const r = await fetch(env("PISPI_BASE_URL").replace(/\/$/, "") + "/comptes/transactions", { method: "POST", headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  return { http: r.status, ok: r.status === 200 || r.status === 201, data: j, sent: body };
}
module.exports = { ready, initiateTransfer };
