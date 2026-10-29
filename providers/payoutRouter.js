"use strict";
// OMNIPAY — aiguillage des retraits par opérateur (fichier AJOUTÉ, à placer dans providers/).
// Pour chaque opérateur on choisit le canal par variable Render :
//   PAYOUT_ROUTE_MTN / PAYOUT_ROUTE_MOOV / PAYOUT_ROUTE_CELTIIS = manual (DÉFAUT : file d'attente admin, aucun tiers) | momo (MTN MoMo API directe) | moov / celtiis (emplacements, en attente de leur API) | pispi (Ecobank PI-SPI) | paydunya (OPTIONNEL, à activer explicitement)
// Chaque canal renvoie : {status:'sent'|'refused'|'uncertain'|'unavailable', detail}
//   sent        : ordre accepté par le canal (la confirmation finale arrive par callback ou vérification)
//   refused     : refus clair AVANT envoi -> la demande reste en attente (rien n'est parti)
//   uncertain   : réponse incertaine (délai dépassé…) -> on ne renvoie JAMAIS : vérification humaine
//   unavailable : canal non configuré -> la demande reste en attente
const axios = require("axios");

const intlPhone = (p) => {
  let d = String(p || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  return d.startsWith("229") ? d : "229" + d;
};

// ---- Canal 1 : PayDunya (déjà intégré) ----
async function viaPaydunya({ txId, operator, phone, amount, callbackUrl }) {
  const MODES = { mtn: "mtn-benin", moov: "moov-benin", celtiis: "celtiis-cash" };
  const pd = require("./paydunya.js");
  const tok = await pd.createDisburseToken({ accountAlias: intlPhone(phone), amount, withdrawMode: MODES[operator], callbackUrl });
  if (!(tok && tok.response_code === "00" && tok.disburse_token)) return { status: "refused", detail: String((tok && (tok.response_text || tok.response_code)) || "refus PayDunya") };
  const sub = await pd.submitDisburse({ disburseInvoice: tok.disburse_token, disburseId: txId });
  return { status: "sent", detail: sub && sub.response_code, ref: String(txId) };
}

// ---- Canal 2 : MTN MoMo API directe (Disbursement) ----
// Écrit d'après la documentation publique « MTN MoMo API » (momodeveloper.mtn.com). À VALIDER D'ABORD en sandbox ;
// la production n'est ouverte que par MTN après accord. Variables : MTN_MOMO_BASE (ex. https://sandbox.momodeveloper.mtn.com),
// MTN_MOMO_ENV (sandbox | mtnbenin…), MTN_MOMO_SUB_KEY, MTN_MOMO_API_USER, MTN_MOMO_API_KEY, MTN_MOMO_CURRENCY (XOF ; EUR en sandbox).
const momoCfg = () => ({
  base: (process.env.MTN_MOMO_BASE || "").replace(/\/$/, ""), env: process.env.MTN_MOMO_ENV || "sandbox", sub: process.env.MTN_MOMO_SUB_KEY,
  user: process.env.MTN_MOMO_API_USER, key: process.env.MTN_MOMO_API_KEY, currency: process.env.MTN_MOMO_CURRENCY || "XOF",
});
const momoReady = (c) => Boolean(c.base && c.sub && c.user && c.key);
async function momoToken(c) {
  const r = await axios.post(`${c.base}/disbursement/token/`, null, {
    headers: { Authorization: "Basic " + Buffer.from(`${c.user}:${c.key}`).toString("base64"), "Ocp-Apim-Subscription-Key": c.sub }, timeout: 20000 });
  return r.data.access_token;
}
async function viaMomo({ txId, operator, phone, amount }) {
  if (operator !== "mtn") return { status: "unavailable", detail: "Le canal MoMo direct ne concerne que MTN." };
  const c = momoCfg();
  if (!momoReady(c)) return { status: "unavailable", detail: "MTN MoMo API non configurée." };
  let token;
  try { token = await momoToken(c); } catch (e) { return { status: "refused", detail: "Authentification MTN refusée." }; }
  try {
    const r = await axios.post(`${c.base}/disbursement/v1_0/transfer`, {
      amount: String(amount), currency: c.currency, externalId: String(txId), payee: { partyIdType: "MSISDN", partyId: intlPhone(phone) },
      payerMessage: "OMNIPAY", payeeNote: "Retrait OMNIPAY" },
      { headers: { Authorization: `Bearer ${token}`, "X-Reference-Id": txId, "X-Target-Environment": c.env, "Ocp-Apim-Subscription-Key": c.sub, "Content-Type": "application/json" },
        timeout: 20000, validateStatus: () => true });
    if (r.status === 202) return { status: "sent", detail: "MTN accepté", ref: String(txId) };
    if (r.status >= 400 && r.status < 500) return { status: "refused", detail: `MTN ${r.status}: ${JSON.stringify(r.data).slice(0, 120)}` };
    return { status: "uncertain", detail: `MTN ${r.status}` };
  } catch (e) { return { status: "uncertain", detail: String(e.message).slice(0, 120) }; }
}
// Statut d'un retrait MTN déjà envoyé : 'completed' | 'failed' | 'pending'
async function momoStatus(txId) {
  const c = momoCfg();
  if (!momoReady(c)) throw new Error("MTN MoMo API non configurée.");
  const token = await momoToken(c);
  const r = await axios.get(`${c.base}/disbursement/v1_0/transfer/${txId}`, {
    headers: { Authorization: `Bearer ${token}`, "X-Target-Environment": c.env, "Ocp-Apim-Subscription-Key": c.sub }, timeout: 20000 });
  const s = String(r.data && r.data.status).toUpperCase();
  return s === "SUCCESSFUL" ? "completed" : s === "FAILED" || s === "REJECTED" ? "failed" : "pending";
}

// ---- Canal 3 : Ecobank PI-SPI (à brancher avec les accès fournis par Ecobank) ----
// Aucun accès n'existe encore : ce canal renvoie « unavailable » et la demande reste en attente.
// Dès réception de la documentation et des clés d'Ecobank, c'est ici (et seulement ici) que l'appel est ajouté.
async function viaPispi(args) {
  const pi = require("./piSpiSupervised.js");
  return pi.preparePayout(args);
}

// Canal manuel : aucun tiers. La demande reste « en attente » ; l'admin paie depuis son propre compte puis clique « Payé ».
async function viaManual() { return { status: "unavailable", detail: "Traitement manuel OMNIPAY (file d'attente admin)." }; }
// ---- Canaux Moov Money et Celtiis Cash : emplacements prêts ----
// À ce jour ni Moov ni Celtiis ne publient d'API de paiement ouverte : aucun appel n'est inventé ici. Tant qu'ils ne fournissent pas de documentation
// et de clés, ces canaux renvoient « unavailable » (la demande reste en attente, traitée manuellement). Dès réception de leur documentation,
// l'appel s'ajoute dans viaMoov / viaCeltiis (même contrat {status, detail}) sans toucher au reste. Les dépôts entrants passent déjà par /api/channels/inbound.
async function viaMoov() { return { status: "unavailable", detail: "Moov Money : API non encore fournie (traitement manuel)." }; }
async function viaCeltiis() { return { status: "unavailable", detail: "Celtiis Cash : API non encore fournie (traitement manuel)." }; }
const CHANNELS = { manual: viaManual, paydunya: viaPaydunya, momo: viaMomo, moov: viaMoov, celtiis: viaCeltiis, pispi: viaPispi };
const routeFor = (operator) => {
  const key =
    "PAYOUT_ROUTE_" +
    String(operator || "").toUpperCase();

  const configuredRoute =
    process.env[key];

  const defaultRoute =
    ["mtn", "moov", "celtiis"].includes(
      String(operator || "").toLowerCase()
    )
      ? "pispi"
      : "manual";

  const route = String(
    configuredRoute || defaultRoute
  ).toLowerCase();

  return CHANNELS[route]
    ? route
    : defaultRoute;
};

async function payout(args) {
  const route = routeFor(args.operator);
  const r = await CHANNELS[route](args);
  return { ...r, route };
}

// Test de connexion (utilisé par OMNICHECK) : obtient un jeton MTN Disbursement, sans rien envoyer.
const momoConfigured = () => momoReady(momoCfg());
async function momoPing() {
  const c = momoCfg();
  if (!momoReady(c)) return { configured: false, ok: false };
  try { await momoToken(c); return { configured: true, ok: true }; } catch (e) { return { configured: true, ok: false, error: "HTTP " + (e.response && e.response.status || e.message) }; }
}

module.exports = { payout, routeFor, momoStatus, momoConfigured, momoPing, intlPhone };
