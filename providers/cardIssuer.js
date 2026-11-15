"use strict";
// OMNIPAY — ÉMETTEUR DE CARTES : interface unique entre OMNIPAY et le partenaire qui ÉMET réellement les cartes Visa/Mastercard.
// IMPORTANT : un numéro de carte utilisable chez un commerçant ne peut être créé que par un émetteur agréé (programme BIN) avec qui OMNIPAY a un contrat.
// OMNIPAY ne « fabrique » jamais de vrais numéros : le portefeuille, les frais, les plafonds, le gel et l'historique sont gérés par OMNIPAY ; le numéro, lui, vient de l'émetteur.
// CARDS_PROVIDER = test | <émetteur à brancher> ; sans valeur : cartes indisponibles.
//   test : cartes de DÉMONSTRATION (préfixe 9999, étiquetées TEST), inutilisables chez un commerçant. Pour les démos (Dakar…) et pour tester l'écran.
// Un adaptateur réel (Maplerad, Sudo, Bridgecard, Stripe Issuing…) = un objet avec les mêmes 6 méthodes : create, fund, setFrozen, close, reveal, ready.
const crypto = require("crypto");
const secret = () => process.env.CARD_TEST_SECRET || process.env.JWT_SECRET || "omnipay-card-test";
const hm = (s) => crypto.createHmac("sha256", secret()).update(s).digest();
const luhn = (d) => { let s = 0; for (let i = d.length - 1, alt = true; i >= 0; i--, alt = !alt) { let n = +d[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } s += n; } return (10 - (s % 10)) % 10; };
const digits = (buf, n) => Array.from(buf).map((x) => x % 10).slice(0, n).join("");

const test = {
  name: "test",
  ready: () => true,
  async create({ cardId }) {
    const body = "9999" + digits(hm("pan:" + cardId), 11), pan = body + luhn(body);
    return { providerCardId: "test_" + cardId, last4: pan.slice(-4), brand: "TEST", expiry: new Date(Date.now() + 3 * 365 * 864e5).toISOString().slice(0, 7).split("-").reverse().join("/").replace(/^(\d\d)\/\d\d(\d\d)$/, "$1/$2"), test: true };
  },
  async fund() { return { ok: true }; },
  async setFrozen() { return { ok: true }; },
  async close() { return { ok: true }; },
  async reveal({ cardId }) {
    const body = "9999" + digits(hm("pan:" + cardId), 11), pan = body + luhn(body), cvv = digits(hm("cvv:" + cardId), 3);
    const e = new Date(Date.now() + 3 * 365 * 864e5);
    return { pan, cvv, expiry: String(e.getUTCMonth() + 1).padStart(2, "0") + "/" + String(e.getUTCFullYear()).slice(-2), test: true };
  },
};
const PROVIDERS = { test };
const current = () => { const k = String(process.env.CARDS_PROVIDER || "").toLowerCase(); return PROVIDERS[k] && PROVIDERS[k].ready() ? PROVIDERS[k] : null; };
module.exports = { current, PROVIDERS, _luhn: luhn };
