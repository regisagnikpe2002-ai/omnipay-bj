// OMNIPAY v54 — branche les routes récentes en TÊTE de server.js (avant tout routeur « fourre-tout »), ajoute /api/reserve au bouclier admin et la carte « Fonds de réserve » à OMNICHECK.
// Sans danger : relançable à volonté, sauvegarde server.js avant de le modifier. Usage : node scripts/apply-v54.js
const fs = require("fs"), path = require("path"), root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8"), write = (f, s) => fs.writeFileSync(path.join(root, f), s);
let s = read("server.js"); fs.writeFileSync(path.join(root, "server.js.before-v54"), s);
const NEW = [["/api/notify", "notify", "Notifications"], ["/api/business", "business", "Business"], ["/api/flows", "flows", "Entrées/sorties"], ["/api/omniwallet", "omniwallet", "OMNIWALLET"], ["/api/otp", "otp", "OTP e-mail + SMS"], ["/api/reserve", "reserve", "Fonds de réserve"]];
const lines = s.split("\n").filter((l) => !NEW.some(([u]) => l.trim().startsWith(`mount("${u}"`)));
const i = lines.findIndex((l) => l.includes('mount("/auth"'));
if (i < 0) { console.error('Ligne mount("/auth"…) introuvable : rien modifié.'); process.exit(1); }
lines.splice(i, 0, ...NEW.map(([u, f, l]) => `mount("${u}", "./routes/${f}", "${l}");`));
write("server.js", lines.join("\n")); console.log("server.js : routes récentes placées avant /auth");
try { let a = read("lib/adminShield.js"); if (!a.includes('"/api/reserve"')) { a = a.replace('"/api/id/backfill"]', '"/api/id/backfill", "/api/reserve"]'); write("lib/adminShield.js", a); console.log("adminShield : /api/reserve protégé"); } } catch (e) { console.log("adminShield non modifié :", e.message); }
try { let h = read("public/omnicheck.html"); if (!h.includes("omnicheck-reserve.js")) { h = h.replace("</body>", '<script src="/omnicheck-reserve.js"></script>\n</body>'); write("public/omnicheck.html", h); console.log("OMNICHECK : carte Fonds de réserve ajoutée"); } } catch (e) { console.log("omnicheck.html non modifié :", e.message); }
