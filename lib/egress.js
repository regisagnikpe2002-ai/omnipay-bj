"use strict";
// Sortie réseau à adresse IP FIXE (facultative). FedaPay n'autorise les retraits que depuis des adresses IP connues ; or Render en change.
// Si FEDAPAY_PROXY_URL est défini (ex. http://utilisateur:motdepasse@proxy.exemple.com:9293), les appels de retrait passent par ce relais
// à adresse fixe : c'est CETTE adresse qu'on autorise dans FedaPay. Sans cette variable, rien ne change.
// L'adresse du relais contient un mot de passe : elle ne s'écrit que dans Render et n'est jamais affichée ni journalisée.
const proxyUrl = () => String(process.env.FEDAPAY_PROXY_URL || "").trim();
const enabled = () => /^https?:\/\/.+/i.test(proxyUrl());
let agent = null, agentFor = "";
function dispatcher() {
  if (!enabled()) return undefined;
  if (!agent || agentFor !== proxyUrl()) {
    const { ProxyAgent } = require("undici");
    agent = new ProxyAgent(proxyUrl()); agentFor = proxyUrl();
  }
  return agent;
}
// fetch() qui passe par le relais quand il est configuré. On utilise le fetch du même paquet « undici » que l'agent (versions compatibles).
function egressFetch(url, opts) {
  const d = dispatcher();
  return d ? require("undici").fetch(url, { ...(opts || {}), dispatcher: d }) : fetch(url, opts);
}
module.exports = { enabled, egressFetch };
