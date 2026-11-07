"use strict";
// OMNIPAY — Clés API regroupées en UNE seule variable Render : OMNIPAY_API_KEYS (FICHIER AJOUTÉ).
// Format : un objet JSON { "NOM_DE_VARIABLE": "valeur", ... }. Chaque entrée est copiée dans process.env au démarrage,
// donc tout le code existant continue de lire process.env.SMSCODES_KEY, PAWAPAY_API_TOKEN, etc. sans changement.
// - Une valeur vide est ignorée (un modèle à moitié rempli ne casse rien).
// - La variable groupée l'emporte sur une variable séparée du même nom : changer une clé = modifier UNE ligne.
// - Jamais de valeur dans les logs ni dans /api/keys/status : seulement présent / absent.
// Garder HORS du groupe : DATABASE_URL, JWT_*_SECRET, ADMIN_SESSION_SECRET, OTP_SECRET (les changer déconnecte les clients).
const PROTECTED = new Set(["PORT", "NODE_ENV", "PATH", "HOME", "APP_MODE", "RENDER", "OMNIPAY_API_KEYS"]);
const NAME = /^[A-Z][A-Z0-9_]{2,63}$/;

// Fournisseurs connus : sert uniquement à l'état « présent / absent » affiché à l'administrateur.
const KNOWN = [
  ["Administration", ["ADMIN_KEY"]],
  ["SMSCodes (numéros virtuels)", ["SMSCODES_KEY"]],
  ["PawaPay", ["PAWAPAY_API_TOKEN"]],
  ["Binance", ["BINANCE_API_KEY", "BINANCE_API_SECRET"]],
  ["Binance P2P", ["BINANCE_P2P_API_KEY", "BINANCE_P2P_API_SECRET"]],
  ["Binance Pay", ["BINANCE_PAY_API_KEY", "BINANCE_PAY_SECRET_KEY"]],
  ["MTN MoMo", ["MTN_MOMO_API_USER", "MTN_MOMO_API_KEY", "MTN_MOMO_SUBSCRIPTION_KEY"]],
  ["Ecobank", ["ECOBANK_CLIENT_ID", "ECOBANK_CLIENT_SECRET"]],
  ["PI-SPI", ["PISPI_CLIENT_ID", "PISPI_CLIENT_SECRET", "PISPI_WEBHOOK_SECRET"]],
  ["Celtiis", ["CELTIIS_CLIENT_ID", "CELTIIS_CLIENT_SECRET"]],
  ["PayPal", ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]],
  ["E-mail", ["RESEND_API_KEY", "BREVO_API_KEY", "SMTP_PASSWORD"]],
];

let fromGroup = new Set();

function install() {
  fromGroup = new Set();
  const raw = process.env.OMNIPAY_API_KEYS;
  if (!raw || !String(raw).trim()) return { loaded: 0 };
  let obj;
  try { obj = JSON.parse(raw); } catch { console.error("[CLÉS] OMNIPAY_API_KEYS n'est pas un JSON valide : ignorée."); return { loaded: 0, error: "invalid_json" }; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) { console.error("[CLÉS] OMNIPAY_API_KEYS doit être un objet JSON : ignorée."); return { loaded: 0, error: "not_object" }; }
  let loaded = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (!NAME.test(k) || PROTECTED.has(k)) continue;
    if (typeof v !== "string" && typeof v !== "number") continue;
    const val = String(v).trim();
    if (!val) continue;
    process.env[k] = val;
    fromGroup.add(k);
    loaded++;
  }
  console.log(`[CLÉS] ${loaded} clé(s) chargée(s) depuis OMNIPAY_API_KEYS`);
  return { loaded };
}

function status() {
  return KNOWN.map(([provider, names]) => ({
    provider,
    keys: names.map((n) => ({ name: n, present: Boolean(process.env[n]), source: fromGroup.has(n) ? "groupe" : process.env[n] ? "variable séparée" : null })),
    ready: names.every((n) => Boolean(process.env[n])),
  }));
}

module.exports = { install, status, KNOWN };
