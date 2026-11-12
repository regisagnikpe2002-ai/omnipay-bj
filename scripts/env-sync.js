"use strict";
// OMNIPAY — GÉRER LES VARIABLES DEPUIS VS CODE. Tu modifies le fichier local .env.render (jamais envoyé sur GitHub) et ce script les met sur Render.
// Réglages dans .env : RENDER_API_KEY (Render > Account Settings > API Keys) et RENDER_SERVICE_ID (srv-..., dans l'URL du service).
//   node scripts/env-sync.js            -> compare (n'écrit RIEN) : montre les variables à ajouter / modifier / déjà à jour (noms seulement)
//   node scripts/env-sync.js --apply    -> ajoute ou met à jour (ne supprime JAMAIS une variable existante). Puis redéploie le service sur Render.
const fs = require("fs"), path = require("path");
const parse = (txt) => { const o = {}; for (const l of String(txt).split(/\r?\n/)) { const m = l.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !/^\s*#/.test(l)) o[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2"); } return o; };
async function main({ fetchImpl = fetch, cwd = process.cwd(), apply = process.argv.includes("--apply"), log = console.log } = {}) {
  const env = fs.existsSync(path.join(cwd, ".env")) ? parse(fs.readFileSync(path.join(cwd, ".env"), "utf8")) : {};
  const key = process.env.RENDER_API_KEY || env.RENDER_API_KEY, sid = process.env.RENDER_SERVICE_ID || env.RENDER_SERVICE_ID;
  if (!key || !sid) throw new Error("RENDER_API_KEY et RENDER_SERVICE_ID manquants dans .env");
  const f = path.join(cwd, ".env.render"); if (!fs.existsSync(f)) throw new Error(".env.render introuvable (crée-le : une ligne NOM=valeur par variable).");
  const want = parse(fs.readFileSync(f, "utf8"));
  const H = { authorization: "Bearer " + key, accept: "application/json", "content-type": "application/json" };
  const r = await fetchImpl(`https://api.render.com/v1/services/${sid}/env-vars?limit=100`, { headers: H });
  if (!r.ok) throw new Error("Render a refusé la lecture (" + r.status + ") : vérifie RENDER_API_KEY et RENDER_SERVICE_ID.");
  const cur = {}; for (const it of await r.json()) { const e = it.envVar || it; if (e && e.key) cur[e.key] = e.value; }
  const plan = { add: [], update: [], same: [] };
  for (const [k, v] of Object.entries(want)) (!(k in cur) ? plan.add : cur[k] !== v ? plan.update : plan.same).push(k);
  log("À ajouter   :", plan.add.join(", ") || "-"); log("À modifier  :", plan.update.join(", ") || "-"); log("Déjà à jour :", plan.same.length + " variable(s)");
  if (!apply) { log("\nRien n'a été écrit. Lance avec --apply pour envoyer."); return plan; }
  for (const k of [...plan.add, ...plan.update]) {
    const w = await fetchImpl(`https://api.render.com/v1/services/${sid}/env-vars/${encodeURIComponent(k)}`, { method: "PUT", headers: H, body: JSON.stringify({ value: want[k] }) });
    if (!w.ok) throw new Error("Échec sur " + k + " (" + w.status + ")."); log("OK", k);
  }
  log("\nTerminé. Va sur Render > Manual Deploy pour que le serveur relise les variables."); return plan;
}
module.exports = { main, parse };
if (require.main === module) main().catch((e) => { console.error("Erreur :", e.message); process.exit(1); });
