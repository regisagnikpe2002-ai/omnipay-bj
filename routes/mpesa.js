"use strict";
// OMNIPAY — M-Pesa Open API : obtention de la clé de session (étape 1 obligatoire).
// Lecture seule côté OMNIPAY : aucun solde n'est modifié. Réservé à l'administrateur (en-tête x-admin-key).
// Variables Render : MPESA_API_KEY (secrète), MPESA_ENV (sandbox|openapi, défaut sandbox), MPESA_MARKET (défaut vodafoneGHA),
// MPESA_ORIGIN (défaut *, doit correspondre à l'application M-Pesa), MPESA_PUBLIC_KEY (optionnel : clé publique Base64).
const crypto = require("crypto");
const express = require("express");
const router = express.Router();

const DEFAULT_PUB = "MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAxF60L7prpzfJy6nblhNn3pVCepxsKIEgutdJ5SQJnhaebIIKOrcqyvZ2pZZFuvdjhk74BvWDKgsDBPA+kIbMaDVgY9DELRIG7ONZT1OVTWi+IlINdOvrQxsBnNcONdVtAkp/RP6ZbAYaHfB7HTbv0K9b0prMV3Xf05mDad9jJlfT2v/CgCn5yyvRmv3PbPeMurRB7dr//Ne5AQ9+5CZ3yVX+8sXsP6JjH96qZ/be7RI04UHFnFTF9tF04ynJUOmWZdag8xUWtI6Fkeu9wG+lRCSLZSYpQjV0o0CmEAE2LReNSPWrn2DR+8aviA8tdK/XYLiWTSyCa9JeOLbm3esiqu5vcsLvvjMru/RrbFlVjk6WhS+KXZZtU/aK6BJJXawb5FUZV5AFmZVKdyeyjpjArcNPU2oCUDsIKEtHdxHkMih03PiThHQqrxfo8TpsBsEtRRb9TjtlGeUPu/172WBIJzkCpPHMUV3ZF/U7PedfUd7ANU4xADgjNB+a6jU5qsIT08TGWtK4YKQ0xfFrgzX+6fSs6K8a1ejJs5GZR++U9bssoLnrV6u8hvmuk1ubCuMHzmgOVx0/yMLsc9savGTvkuuqGpFJ+u0le4DMbOBKQH4IPXG9K5rGItv8XJMAye9q+ag8T5ben/Go0EQ7W0SybfpbycgFdQE+g8C3E10s8BUCAwEAAQ==";
const MARKETS = ["vodacomRC", "vodacomLES", "vodacomMOZ", "vodacomTZN", "VodafoneEGP", "vodafoneGHA", "vodafoneKEN", "Vodafone"];

const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const adminOnly = (req, res, next) => isAdmin(req) ? next() : res.status(403).json({ error: "Accès réservé à l'administrateur." });

function encryptKey(apiKey, pubB64) {
  const pem = "-----BEGIN PUBLIC KEY-----\n" + pubB64.replace(/\s+/g, "").match(/.{1,64}/g).join("\n") + "\n-----END PUBLIC KEY-----";
  return crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(apiKey)).toString("base64");
}
const cfg = () => {
  const env = process.env.MPESA_ENV === "openapi" ? "openapi" : "sandbox";
  const market = MARKETS.includes(process.env.MPESA_MARKET) ? process.env.MPESA_MARKET : "vodafoneGHA";
  return { env, market, origin: process.env.MPESA_ORIGIN || "*", pub: process.env.MPESA_PUBLIC_KEY || DEFAULT_PUB, key: process.env.MPESA_API_KEY || "" };
};

router.get("/status", adminOnly, (req, res) => {
  const c = cfg();
  res.json({ apiKeyPresent: !!c.key, env: c.env, market: c.market, origin: c.origin, markets: MARKETS });
});

// Échange la clé API contre une clé de session. La clé de session n'est jamais renvoyée en entier.
router.get("/session", adminOnly, async (req, res) => {
  const c = cfg();
  if (!c.key) return res.status(503).json({ error: "MPESA_API_KEY absente : ajoutez-la dans les variables Render." });
  try {
    const url = `https://uat.openapi.m-pesa.com/${c.env}/ipg/v2/${c.market}/getSession/`;
    const r = await fetch(url, { method: "GET", headers: { "Content-Type": "application/json", Authorization: "Bearer " + encryptKey(c.key, c.pub), Origin: c.origin }, signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    const sid = j.output_SessionID || "";
    res.status(r.ok ? 200 : 502).json({ http: r.status, code: j.output_ResponseCode || null, description: j.output_ResponseDesc || null,
      sessionObtained: !!sid, sessionHint: sid ? sid.slice(0, 4) + "…" + sid.slice(-4) : null, env: c.env, market: c.market });
  } catch (e) { console.error("MPESA_SESSION", e.message); res.status(502).json({ error: "M-Pesa injoignable ou réponse invalide." }); }
});

module.exports = router;
