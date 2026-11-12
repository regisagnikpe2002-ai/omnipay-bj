// Ajoute la « Console paiements » dans OMNICHECK (public/omnicheck.html).
const fs = require("fs"), p = "public/omnicheck.html"; let s = fs.readFileSync(p, "utf8");
if (s.includes("omnicheck-console.js")) { console.log("déjà appliqué"); process.exit(0); }
const tag = '<script src="/omnicheck-console.js"></script>\n';
if (s.includes('<script src="/omnicheck-reserve.js"></script>')) s = s.replace('<script src="/omnicheck-reserve.js"></script>', '<script src="/omnicheck-reserve.js"></script>\n' + tag.trim());
else s = s.replace("</body>", tag + "</body>");
fs.writeFileSync(p, s); console.log("OK : console paiements ajoutée à OMNICHECK");
