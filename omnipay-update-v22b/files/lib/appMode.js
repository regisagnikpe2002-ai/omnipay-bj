"use strict";
// OMNIPAY — MODE de l'application. APP_MODE = live (défaut) | demo. Le mode DÉMO tourne sur un site et une base SÉPARÉS : aucune clé réelle, aucun envoi réel.
const isDemo = () => String(process.env.APP_MODE || "live").trim().toLowerCase() === "demo";
module.exports = { isDemo };
