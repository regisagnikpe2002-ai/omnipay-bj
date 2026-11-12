"use strict";
// OMNIPAY — SAUVEGARDE SUR TON MAC, sans dépendre de Render. Lecture seule de la base Neon (toutes les tables).
// Usage : node scripts/backup-local.js            (lit DATABASE_URL dans .env du dossier)
//   BACKUP_DIR   dossier de destination (défaut ~/OMNIPAY-SAUVEGARDES)
//   BACKUP_PASSPHRASE   si définie : le fichier est chiffré (AES-256-GCM, extension .enc) ; recommandé
//   BACKUP_KEEP  nombre de sauvegardes gardées (défaut 60)
//   BACKUP_ENV=on  (défaut) sauvegarde aussi une copie chiffrée de .env (seulement si BACKUP_PASSPHRASE est définie)
// Déchiffrer : node scripts/backup-local.js --decrypt fichier.json.gz.enc  -> écrit fichier.json
const fs = require("fs"), path = require("path"), os = require("os"), zlib = require("zlib"), crypto = require("crypto");

function loadEnv(file) {
  try { for (const l of fs.readFileSync(file, "utf8").split(/\r?\n/)) { const m = l.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2"); } } catch (_) {}
}
const enc = (buf, pass) => { const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), key = crypto.scryptSync(pass, salt, 32), c = crypto.createCipheriv("aes-256-gcm", key, iv); const body = Buffer.concat([c.update(buf), c.final()]); return Buffer.concat([Buffer.from("OMNB1"), salt, iv, c.getAuthTag(), body]); };
const dec = (buf, pass) => { if (buf.subarray(0, 5).toString() !== "OMNB1") throw new Error("Format inconnu."); const salt = buf.subarray(5, 21), iv = buf.subarray(21, 33), tag = buf.subarray(33, 49), d = crypto.createDecipheriv("aes-256-gcm", crypto.scryptSync(pass, salt, 32), iv); d.setAuthTag(tag); return Buffer.concat([d.update(buf.subarray(49)), d.final()]); };

async function run({ query, dir, pass, keep = 60, envFile }) {
  const out = { date: new Date().toISOString(), tables: {} };
  const t = await query("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1");
  for (const { table_name } of t) out.tables[table_name] = await query('select * from "' + String(table_name).replace(/"/g, '""') + '"');
  if (!Object.keys(out.tables).length) throw new Error("Aucune table lue : sauvegarde refusée.");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const raw = zlib.gzipSync(Buffer.from(JSON.stringify(out)));
  const name = "omnipay-db-" + stamp + ".json.gz" + (pass ? ".enc" : "");
  const file = path.join(dir, name); fs.writeFileSync(file, pass ? enc(raw, pass) : raw, { mode: 0o600 });
  const counts = Object.fromEntries(Object.entries(out.tables).map(([k, v]) => [k, v.length]));
  fs.writeFileSync(file + ".manifest.json", JSON.stringify({ date: out.date, file: name, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), rows: counts }, null, 1), { mode: 0o600 });
  // Vérification : on relit et on déchiffre le fichier qu'on vient d'écrire.
  const back = JSON.parse(zlib.gunzipSync(pass ? dec(fs.readFileSync(file), pass) : fs.readFileSync(file)));
  if (Object.keys(back.tables).length !== Object.keys(out.tables).length) throw new Error("Vérification échouée : fichier incomplet.");
  let envSaved = false;
  if (pass && envFile && String(process.env.BACKUP_ENV || "on").toLowerCase() !== "off" && fs.existsSync(envFile)) { fs.writeFileSync(path.join(dir, "omnipay-env-" + stamp + ".enc"), enc(fs.readFileSync(envFile), pass), { mode: 0o600 }); envSaved = true; }
  // Rotation : on garde les « keep » plus récentes.
  for (const pre of ["omnipay-db-", "omnipay-env-"]) {
    const old = fs.readdirSync(dir).filter((f) => f.startsWith(pre) && !f.endsWith(".manifest.json")).sort().reverse().slice(keep);
    for (const f of old) { try { fs.unlinkSync(path.join(dir, f)); fs.unlinkSync(path.join(dir, f + ".manifest.json")); } catch (_) {} }
  }
  return { file, tables: Object.keys(counts).length, rows: Object.values(counts).reduce((a, b) => a + b, 0), encrypted: Boolean(pass), envSaved };
}
module.exports = { run, enc, dec };

if (require.main === module) {
  loadEnv(path.join(process.cwd(), ".env"));
  const pass = process.env.BACKUP_PASSPHRASE || "";
  const di = process.argv.indexOf("--decrypt");
  if (di > 0) { try { const f = process.argv[di + 1]; const o = f.replace(/\.gz\.enc$/, "").replace(/\.enc$/, "") + (f.endsWith(".gz.enc") ? "" : ".out"); const plain = dec(fs.readFileSync(f), pass); fs.writeFileSync(o, f.endsWith(".gz.enc") ? zlib.gunzipSync(plain) : plain, { mode: 0o600 }); console.log("Déchiffré :", o); } catch (e) { console.error("Erreur :", e.message); process.exit(1); } return; }
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL manquante (mets-la dans .env)."); process.exit(1); }
  if (!pass) console.warn("Attention : BACKUP_PASSPHRASE absente, la sauvegarde ne sera PAS chiffrée.");
  const { neon } = require("@neondatabase/serverless"), sql = neon(process.env.DATABASE_URL);
  run({ query: (q) => sql.query(q), dir: process.env.BACKUP_DIR || path.join(os.homedir(), "OMNIPAY-SAUVEGARDES"), pass, keep: Number(process.env.BACKUP_KEEP) || 60, envFile: path.join(process.cwd(), ".env") })
    .then((r) => console.log(`Sauvegarde OK : ${r.file}\n${r.tables} tables, ${r.rows} lignes${r.encrypted ? ", chiffrée" : ""}${r.envSaved ? ", copie .env chiffrée" : ""}`))
    .catch((e) => { console.error("Erreur :", e.message); process.exit(1); });
}
