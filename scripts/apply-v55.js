// OMNIPAY v55 — branche le rail FedaPay (transferts sortants) : canal « fedapay » dans providers/payoutRouter.js, route de suivi, bouclier admin.
// Relançable sans danger ; sauvegarde les fichiers modifiés (.before-v55). Usage : node scripts/apply-v55.js
const fs = require("fs"), path = require("path"), root = path.join(__dirname, "..");
const rd = (f) => fs.readFileSync(path.join(root, f), "utf8"), wr = (f, s) => fs.writeFileSync(path.join(root, f), s);
const bak = (f) => fs.writeFileSync(path.join(root, f + ".before-v55"), rd(f));
let r = rd("providers/payoutRouter.js");
if (!r.includes("viaFedapay")) {
  if (!r.includes("const CHANNELS = { pawapay: viaPawapay,")) { console.error("payoutRouter.js : ligne CHANNELS introuvable, rien modifié."); process.exit(1); }
  bak("providers/payoutRouter.js");
  r = r.replace("const CHANNELS = { pawapay: viaPawapay,", '// ---- Canal FedaPay : transferts sortants uniquement (PAYOUT_ROUTE_<OPÉRATEUR>=fedapay) ----\nasync function viaFedapay(args) { return require("./fedapay.js").payout(args); }\nconst CHANNELS = { fedapay: viaFedapay, pawapay: viaPawapay,');
  wr("providers/payoutRouter.js", r); console.log("payoutRouter : canal fedapay ajouté");
} else console.log("payoutRouter : déjà à jour");
let s = rd("server.js");
if (!s.includes('mount("/api/fedapay"')) {
  const lines = s.split("\n"), i = lines.findIndex((l) => l.includes('mount("/auth"'));
  if (i < 0) { console.error('mount("/auth") introuvable : server.js non modifié.'); process.exit(1); }
  bak("server.js"); lines.splice(i, 0, 'mount("/api/fedapay", "./routes/fedapay", "FedaPay (transferts sortants)");'); wr("server.js", lines.join("\n")); console.log("server.js : route FedaPay montée");
} else console.log("server.js : déjà à jour");
try { let a = rd("lib/adminShield.js"); if (!a.includes('"/api/fedapay/admin"')) { a = a.replace('"/api/id/backfill"', '"/api/id/backfill", "/api/fedapay/admin"'); wr("lib/adminShield.js", a); console.log("adminShield : /api/fedapay/admin protégé"); } } catch (e) { console.log("adminShield non modifié :", e.message); }
