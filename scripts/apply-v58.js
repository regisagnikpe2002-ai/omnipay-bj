// Applique le v58 : monte /api/fedapay/deposit dans server.js (avant /api/fedapay).
const fs = require("fs"); const p = "server.js"; let s = fs.readFileSync(p, "utf8");
if (s.includes("/api/fedapay/deposit")) { console.log("déjà appliqué"); process.exit(0); }
const line = '  mount("/api/fedapay/deposit", "./routes/fedapayDeposit", "FedaPay (dépôts)");\n';
const m = s.match(/^[ \t]*mount\("\/api\/fedapay"[^\n]*\n/m);
if (m) s = s.replace(m[0], line.replace(/^  /, m[0].match(/^[ \t]*/)[0]) + m[0]);
else { const a = s.match(/^[ \t]*mount\("\/auth"[^\n]*\n/m); if (!a) { console.error("point d'insertion introuvable"); process.exit(1); } s = s.replace(a[0], line + a[0]); }
fs.writeFileSync(p, s); console.log("OK : /api/fedapay/deposit monté");
