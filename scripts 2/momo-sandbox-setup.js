"use strict";
// OMNIPAY — TEST MTN MoMo EN BAC À SABLE (argent fictif). Crée les « utilisateurs API » de test chez MTN et vérifie qu'on obtient un jeton.
// Avant : sur momodeveloper.mtn.com, crée un compte, abonne-toi aux produits « Collection » et « Disbursement », copie les 2 clés d'abonnement (Primary key).
// Mets-les dans ton .env LOCAL :  MTN_MOMO_COLL_SUB_KEY=...   MTN_MOMO_SUB_KEY=...   (SUB_KEY = Disbursement)
// Puis :  node scripts/momo-sandbox-setup.js
// Résultat : un fichier .env.momo (droits 600, ignoré par git) avec les variables à copier dans Render. Les secrets ne s'affichent PAS dans le terminal.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const parse = (txt) => { const o = {}; for (const l of String(txt).split(/\r?\n/)) { const m = l.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !/^\s*#/.test(l)) o[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2"); } return o; };
const BASE = "https://sandbox.momodeveloper.mtn.com";
async function provision(fetchImpl, product, subKey, host) {
  const id = crypto.randomUUID();
  const c = await fetchImpl(`${BASE}/v1_0/apiuser`, { method: "POST", headers: { "X-Reference-Id": id, "Ocp-Apim-Subscription-Key": subKey, "Content-Type": "application/json" }, body: JSON.stringify({ providerCallbackHost: host }) });
  if (c.status !== 201) throw new Error(`${product} : création de l'utilisateur API refusée (${c.status}). Vérifie la clé d'abonnement ${product}.`);
  const k = await fetchImpl(`${BASE}/v1_0/apiuser/${id}/apikey`, { method: "POST", headers: { "Ocp-Apim-Subscription-Key": subKey } });
  const kb = await k.json().catch(() => ({})); if (!(k.status === 200 || k.status === 201) || !kb.apiKey) throw new Error(`${product} : clé API non obtenue (${k.status}).`);
  const t = await fetchImpl(`${BASE}/${product.toLowerCase()}/token/`, { method: "POST", headers: { Authorization: "Basic " + Buffer.from(id + ":" + kb.apiKey).toString("base64"), "Ocp-Apim-Subscription-Key": subKey } });
  const tb = await t.json().catch(() => ({})); if (!tb.access_token) throw new Error(`${product} : jeton non obtenu (${t.status}).`);
  return { user: id, key: kb.apiKey };
}
async function main({ fetchImpl = fetch, cwd = process.cwd(), log = console.log } = {}) {
  const env = fs.existsSync(path.join(cwd, ".env")) ? parse(fs.readFileSync(path.join(cwd, ".env"), "utf8")) : {};
  const coll = process.env.MTN_MOMO_COLL_SUB_KEY || env.MTN_MOMO_COLL_SUB_KEY, dis = process.env.MTN_MOMO_SUB_KEY || env.MTN_MOMO_SUB_KEY;
  if (!coll && !dis) throw new Error("Mets MTN_MOMO_COLL_SUB_KEY et/ou MTN_MOMO_SUB_KEY dans .env (clés d'abonnement du portail MTN).");
  const host = process.env.PUBLIC_BASE_URL ? new URL(process.env.PUBLIC_BASE_URL).host : "www.omnipay-bj.com";
  const out = ["# Variables MTN MoMo (SANDBOX, argent fictif). À copier dans Render. NE PAS ENVOYER SUR GITHUB.", "MTN_MOMO_BASE=" + BASE, "MTN_MOMO_ENV=sandbox", "MTN_MOMO_CURRENCY=EUR"];
  if (coll) { const r = await provision(fetchImpl, "Collection", coll, host); out.push("MTN_MOMO_COLL_SUB_KEY=" + coll, "MTN_MOMO_COLL_API_USER=" + r.user, "MTN_MOMO_COLL_API_KEY=" + r.key); log("Collection : OK (utilisateur API créé, jeton obtenu)"); }
  if (dis) { const r = await provision(fetchImpl, "Disbursement", dis, host); out.push("MTN_MOMO_SUB_KEY=" + dis, "MTN_MOMO_API_USER=" + r.user, "MTN_MOMO_API_KEY=" + r.key, "# Pour tester les retraits : PAYOUT_ROUTE_MTN=momo"); log("Disbursement : OK (utilisateur API créé, jeton obtenu)"); }
  const f = path.join(cwd, ".env.momo"); fs.writeFileSync(f, out.join("\n") + "\n", { mode: 0o600 }); log("Écrit : .env.momo (ouvre-le dans VS Code et copie les lignes dans Render)."); return f;
}
module.exports = { main };
if (require.main === module) main().catch((e) => { console.error("Erreur :", e.message); process.exit(1); });
