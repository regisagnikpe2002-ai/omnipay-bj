"use strict";
// OMNIPAY — Crée les identifiants de TEST MTN MoMo (sandbox) à partir de tes deux clés d'abonnement et vérifie qu'elles fonctionnent.
// À lancer sur ton Mac (jamais sur Render) :
//   read -s COLL;  read -s DISB;  COLL_SUB_KEY="$COLL" DISB_SUB_KEY="$DISB" node scripts/momo-sandbox-setup.js
// COLL_SUB_KEY = clé primaire de l'abonnement « Recouvrement » (Collections) · DISB_SUB_KEY = clé primaire de « Décaissements » (Disbursements)
// Résultat : les 6 lignes à copier dans les variables Render. Aucune clé n'est écrite dans un fichier.
const crypto = require("crypto");
const BASE = (process.env.MTN_MOMO_BASE || "https://sandbox.momodeveloper.mtn.com").replace(/\/$/, "");
const HOST = process.env.PROVIDER_CALLBACK_HOST || "www.omnipay-bj.com";

async function setup(product, subKey) {
  const user = crypto.randomUUID(), h = { "Ocp-Apim-Subscription-Key": subKey, "Content-Type": "application/json" };
  let r = await fetch(`${BASE}/v1_0/apiuser`, { method: "POST", headers: { ...h, "X-Reference-Id": user }, body: JSON.stringify({ providerCallbackHost: HOST }) });
  if (r.status !== 201) { const body = (await r.text().catch(() => "")).slice(0, 160); throw new Error(`${product} : création de l'utilisateur refusée (${r.status}) ${body}\n  → clé reçue : ${subKey.length} caractères (attendu : 32). Recopie la clé primaire du bon abonnement, sans espace.`); }
  r = await fetch(`${BASE}/v1_0/apiuser/${user}/apikey`, { method: "POST", headers: h });
  if (r.status !== 201) throw new Error(`${product} : création de la clé API refusée (${r.status}).`);
  const apiKey = (await r.json()).apiKey;
  const t = await fetch(`${BASE}/${product}/token/`, { method: "POST", headers: { Authorization: "Basic " + Buffer.from(user + ":" + apiKey).toString("base64"), "Ocp-Apim-Subscription-Key": subKey } });
  return { user, apiKey, tokenOk: t.status === 200 };
}
(async () => {
  const clean = (v) => String(v || "").replace(/[^0-9a-fA-F]/g, ""), coll = clean(process.env.COLL_SUB_KEY), disb = clean(process.env.DISB_SUB_KEY);
  if (!coll && !disb) { console.log("Donne au moins une clé : COLL_SUB_KEY et/ou DISB_SUB_KEY (voir l'en-tête du fichier)."); process.exit(1); }
  const out = ["MTN_MOMO_BASE=" + BASE, "MTN_MOMO_ENV=sandbox", "MTN_MOMO_CURRENCY=EUR"];
  if (coll) { const c = await setup("collection", coll); out.push("MTN_MOMO_COLL_SUB_KEY=" + coll, "MTN_MOMO_COLL_API_USER=" + c.user, "MTN_MOMO_COLL_API_KEY=" + c.apiKey); console.error("Collections : " + (c.tokenOk ? "OK (jeton obtenu)" : "identifiants créés mais jeton refusé")); }
  if (disb) { const d = await setup("disbursement", disb); out.push("MTN_MOMO_SUB_KEY=" + disb, "MTN_MOMO_API_USER=" + d.user, "MTN_MOMO_API_KEY=" + d.apiKey); console.error("Décaissements : " + (d.tokenOk ? "OK (jeton obtenu)" : "identifiants créés mais jeton refusé")); }
  if (process.env.RAW === "1") { console.log(out.join("\n")); return; } // pour « >> fichier » : uniquement les lignes CLE=VALEUR, rien à recopier à la main
  console.log("\nÀ COPIER dans Render → Environment (puis supprime ce texte de ton terminal) :\n\n" + out.join("\n") + "\n");
})().catch((e) => { console.error("ERREUR : " + e.message); process.exit(1); });
