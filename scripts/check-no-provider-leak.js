"use strict";
// Règle OMNIPAY : les prestataires techniques (FedaPay, FeexPay, PawaPay, PayDunya, KKiaPay) restent INVISIBLES pour les clients.
// Ce contrôle échoue si l'un de ces noms apparaît dans les pages ou scripts servis aux clients. Lancer : npm run check:providers
const fs = require("fs"), path = require("path");
const NAMES = /fedapay|feexpay|pawapay|paydunya|kkiapay/i;
const PUBLIC_OK = new Set(["omnicheck.html", "omnicheck-console.js"]); // console d'administration : peut les nommer
let bad = 0;
(function walk(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) { if (!["vendor", "logos", "node_modules"].includes(f.name)) walk(p); continue; }
    if (!/\.(html|js|css|json|webmanifest)$/i.test(f.name) || PUBLIC_OK.has(f.name)) continue;
    fs.readFileSync(p, "utf8").split("\n").forEach((l, i) => { if (NAMES.test(l)) { bad++; console.log(`${p}:${i + 1}: ${l.trim().slice(0, 120)}`); } });
  }
})(path.join(__dirname, "..", "public"));
if (bad) { console.error(`\n${bad} ligne(s) montrent un nom de prestataire aux clients.`); process.exit(1); }
console.log("OK : aucun nom de prestataire technique dans les pages clients.");
