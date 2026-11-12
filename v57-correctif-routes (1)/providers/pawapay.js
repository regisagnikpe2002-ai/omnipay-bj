"use strict";
// OMNIPAY — client HTTP PawaPay (API v2). Aucune clé n'est écrite ici : PAWAPAY_API_TOKEN vient de Render.
const axios = require("axios");

const PROVIDERS = { mtn: "MTN_MOMO_BEN", moov: "MOOV_BEN" };
const token = () => String(process.env.PAWAPAY_API_TOKEN || "").trim();
const env = () => (String(process.env.PAWAPAY_ENV || "sandbox").toLowerCase() === "live" ? "live" : "sandbox");
const base = () => (process.env.PAWAPAY_BASE_URL || (env() === "live" ? "https://api.pawapay.io" : "https://api.sandbox.pawapay.io")).replace(/\/$/, "");
const ready = () => token().length > 20;
const providerCode = (p) => PROVIDERS[String(p || "").toLowerCase()] || null;
const msisdn = (p) => { let d = String(p || "").replace(/\D/g, ""); if (d.startsWith("00")) d = d.slice(2); if (d.startsWith("229")) return d; return "229" + d.replace(/^0+/, ""); };
const H = () => ({ Authorization: "Bearer " + token(), "Content-Type": "application/json" });
const A = { timeout: 20000, validateStatus: () => true };

async function activeConf() {
  const r = await axios.get(base() + "/v2/active-conf", { headers: H(), timeout: 20000 });
  return r.data || {};
}

// Initiation : { status: ACCEPTED | REJECTED | DUPLICATE_IGNORED | UNKNOWN, failureCode }
async function initiateDeposit({ depositId, amount, phone, provider }) {
  try {
    const r = await axios.post(base() + "/v2/deposits", { depositId, amount: String(Math.floor(amount)), currency: "XOF", customerMessage: "OMNIPAY",
      payer: { type: "MMO", accountDetails: { phoneNumber: msisdn(phone), provider } } }, { headers: H(), ...A });
    const d = r.data || {};
    if (r.status >= 500) return { status: "UNKNOWN" };
    return { status: String(d.status || (r.status < 300 ? "ACCEPTED" : "REJECTED")).toUpperCase(), failureCode: d.failureReason && d.failureReason.failureCode };
  } catch (e) { return { status: "UNKNOWN" }; }
}
async function initiatePayout({ payoutId, amount, phone, provider }) {
  try {
    const r = await axios.post(base() + "/v2/payouts", { payoutId, amount: String(Math.floor(amount)), currency: "XOF",
      recipient: { type: "MMO", accountDetails: { phoneNumber: msisdn(phone), provider } } }, { headers: H(), ...A });
    const d = r.data || {};
    if (r.status >= 500) return { status: "UNKNOWN" };
    return { status: String(d.status || (r.status < 300 ? "ACCEPTED" : "REJECTED")).toUpperCase(), failureCode: d.failureReason && d.failureReason.failureCode };
  } catch (e) { return { status: "UNKNOWN" }; }
}

// Lecture de statut (forme défensive : { status:'FOUND', data:{status,...} } ou objet à plat). -> { found, status, amount, currency, failureCode }
function normalize(body) {
  const b = body || {};
  const top = String(b.status || "").toUpperCase();
  if (top === "NOT_FOUND") return { found: false };
  const d = b.data && typeof b.data === "object" ? b.data : b;
  return { found: true, status: String(d.status || "").toUpperCase(), amount: d.amount, currency: d.currency, failureCode: d.failureReason && d.failureReason.failureCode };
}
async function depositStatus(id) { const r = await axios.get(base() + "/v2/deposits/" + id, { headers: H(), timeout: 20000, validateStatus: (s) => s < 500 }); if (r.status === 404) return { found: false }; if (r.status >= 400) throw new Error("PawaPay " + r.status); return normalize(r.data); }
async function payoutStatus(id) { const r = await axios.get(base() + "/v2/payouts/" + id, { headers: H(), timeout: 20000, validateStatus: (s) => s < 500 }); if (r.status === 404) return { found: false }; if (r.status >= 400) throw new Error("PawaPay " + r.status); return normalize(r.data); }

module.exports = { ready, env, base, providerCode, msisdn, activeConf, initiateDeposit, initiatePayout, depositStatus, payoutStatus, normalize, PROVIDERS };
