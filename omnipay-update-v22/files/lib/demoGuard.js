"use strict";
// OMNIPAY — GARDE-FOU DU MODE DÉMO. Quand APP_MODE=demo, toute connexion sortante vers un hôte NON autorisé est refusée (fetch, http, https).
// Résultat : même si une clé réelle était présente par erreur, le site démo ne peut ni contacter MTN / Moov / Celtiis / Ecobank / Binance (hors cours publics) ni payer quoi que ce soit.
// Hôtes autorisés par défaut : la base de données (Neon) et les cours publics (MARKETS_BASE). Ajout possible : DEMO_ALLOW_HOSTS=hote1,hote2.
const http = require("http");
const https = require("https");
const { isDemo } = require("./appMode");

function allowedHosts() {
  const list = ["localhost", "127.0.0.1", "::1", "data-api.binance.vision"];
  try { list.push(new URL(process.env.MARKETS_BASE || "https://data-api.binance.vision").hostname); } catch (_) {}
  for (const h of String(process.env.DEMO_ALLOW_HOSTS || "").split(",")) if (h.trim()) list.push(h.trim().toLowerCase());
  return list;
}
function hostOk(host) {
  const h = String(host || "").toLowerCase().replace(/:\d+$/, "");
  if (!h) return true;
  if (h.endsWith(".neon.tech") || h === "neon.tech") return true;
  return allowedHosts().some((a) => h === a || h.endsWith("." + a));
}
const blocked = (host) => new Error(`MODE DÉMO : appel sortant bloqué vers « ${host} » (aucun envoi réel n'est possible sur ce site).`);

function hostFromArgs(args) {
  const a = args[0];
  if (typeof a === "string") { try { return new URL(a).hostname; } catch (_) { return a; } }
  if (a && typeof a === "object") { if (a.hostname || a.host) return a.hostname || a.host; if (a.href) { try { return new URL(a.href).hostname; } catch (_) {} } }
  return "";
}

let installed = false;
function install() {
  if (!isDemo() || installed) return false;
  installed = true;
  const realFetch = global.fetch;
  if (typeof realFetch === "function") {
    global.fetch = function guardedFetch(input, init) {
      let host = "";
      try { host = new URL(typeof input === "string" ? input : input && input.url ? input.url : String(input)).hostname; } catch (_) {}
      if (host && !hostOk(host)) return Promise.reject(blocked(host));
      return realFetch.call(this, input, init);
    };
  }
  for (const mod of [http, https]) {
    for (const fn of ["request", "get"]) {
      const real = mod[fn];
      mod[fn] = function guarded(...args) {
        const host = hostFromArgs(args);
        if (host && !hostOk(host)) throw blocked(host);
        return real.apply(this, args);
      };
    }
  }
  console.log("[DÉMO] Garde-fou actif : connexions sortantes limitées à la base de données et aux cours publics.");
  return true;
}
module.exports = { install, hostOk };
