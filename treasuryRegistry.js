"use strict";

/**
 * OMNIPAY — Treasury Registry
 * Registre central des trésoreries externes.
 *
 * IMPORTANT :
 * - ne déplace aucun fonds ;
 * - ne stocke aucun PIN, mot de passe, OTP, clé privée ou seed phrase ;
 * - décrit uniquement les rails/identifiants publics utilisables par OMNIPAY ;
 * - un compte n'est utilisable que si son statut est "active" et si la capacité demandée est autorisée.
 */

const TYPES = Object.freeze([
  "pispi",
  "bank",
  "pawapay",
  "mtn_merchant",
  "moov_merchant",
  "celtiis_merchant",
  "crypto"
]);

const MODES = Object.freeze(["supervised", "api"]);
const STATUSES = Object.freeze(["pending", "active", "suspended", "disabled"]);
const CAPABILITIES = Object.freeze(["in", "out"]);

const SECRET_FIELDS = Object.freeze([
  "pin",
  "password",
  "passphrase",
  "seed",
  "seedphrase",
  "privatekey",
  "private_key",
  "otp",
  "secret",
  "apikey",
  "api_key",
  "accesstoken",
  "access_token"
]);

function clean(value, max = 160) {
  return String(value == null ? "" : value)
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, max);
}

function normalizeId(value) {
  return clean(value, 80).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

function normalizeCapabilities(value) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.map(v => clean(v, 8).toLowerCase()))]
    .filter(v => CAPABILITIES.includes(v));
}

function containsForbiddenSecret(input) {
  if (!input || typeof input !== "object") return false;
  return Object.keys(input).some(key => {
    const normalized = String(key).toLowerCase().replace(/[^a-z0-9_]/g, "");
    return SECRET_FIELDS.includes(normalized) && clean(input[key], 500).length > 0;
  });
}

function maskReference(value) {
  const raw = clean(value, 200);
  if (!raw) return null;
  if (raw.length <= 8) return "••••" + raw.slice(-2);
  return raw.slice(0, 4) + "••••••" + raw.slice(-4);
}

function validate(input = {}) {
  if (containsForbiddenSecret(input)) {
    return { error: "Information secrète interdite. Ne stockez jamais PIN, OTP, mot de passe, clé privée ou token dans le registre." };
  }

  const id = normalizeId(input.id || input.code);
  const type = clean(input.type, 30).toLowerCase();
  const label = clean(input.label, 120);
  const institution = clean(input.institution, 120);
  const currency = clean(input.currency || "XOF", 10).toUpperCase();
  const mode = clean(input.mode || "supervised", 20).toLowerCase();
  const status = clean(input.status || "pending", 20).toLowerCase();
  const publicReference = clean(input.publicReference || input.alias || input.number || input.address, 200);
  const network = clean(input.network, 40).toUpperCase() || null;
  const capabilities = normalizeCapabilities(input.capabilities);

  if (!id || id.length < 3) return { error: "Identifiant de trésorerie invalide." };
  if (!TYPES.includes(type)) return { error: "Type de trésorerie invalide." };
  if (label.length < 3) return { error: "Libellé de trésorerie requis." };
  if (!/^[A-Z0-9]{3,10}$/.test(currency)) return { error: "Devise invalide." };
  if (!MODES.includes(mode)) return { error: "Mode invalide." };
  if (!STATUSES.includes(status)) return { error: "Statut invalide." };
  if (!capabilities.length) return { error: "Ajoutez au moins une capacité : in ou out." };
  if (publicReference.length < 4) return { error: "Alias, numéro de compte, numéro marchand ou adresse publique requis." };
  if (type === "crypto" && !network) return { error: "Réseau crypto requis." };

  return {
    id,
    type,
    label,
    institution: institution || null,
    currency,
    mode,
    status,
    publicReference,
    maskedReference: maskReference(publicReference),
    network,
    capabilities,
    notes: clean(input.notes, 240) || null
  };
}

function canUse(account, capability) {
  if (!account || account.status !== "active") return false;
  const cap = clean(capability, 8).toLowerCase();
  return CAPABILITIES.includes(cap) && Array.isArray(account.capabilities) && account.capabilities.includes(cap);
}

function publicView(account) {
  if (!account) return null;
  return {
    id: account.id,
    type: account.type,
    label: account.label,
    institution: account.institution || null,
    currency: account.currency,
    mode: account.mode,
    status: account.status,
    reference: account.maskedReference || maskReference(account.publicReference),
    network: account.network || null,
    capabilities: Array.isArray(account.capabilities) ? [...account.capabilities] : [],
    canPayin: canUse(account, "in"),
    canPayout: canUse(account, "out")
  };
}

function select(accounts, { capability, currency = "XOF", type } = {}) {
  const cap = clean(capability, 8).toLowerCase();
  const cur = clean(currency, 10).toUpperCase();
  const wantedType = clean(type, 30).toLowerCase();

  return (Array.isArray(accounts) ? accounts : [])
    .filter(a => canUse(a, cap))
    .filter(a => !cur || a.currency === cur)
    .filter(a => !wantedType || a.type === wantedType)
    .sort((a, b) => {
      if (a.mode !== b.mode) return a.mode === "api" ? -1 : 1;
      return a.label.localeCompare(b.label, "fr");
    });
}

function supportedTypes() {
  return [...TYPES];
}

module.exports = {
  TYPES,
  MODES,
  STATUSES,
  CAPABILITIES,
  validate,
  canUse,
  publicView,
  select,
  supportedTypes,
  maskReference
};
