// Sauvegarde complète de la base OMNIPAY (toutes les tables -> un fichier JSON). Lecture seule. Utilisé par la sauvegarde quotidienne automatique (GitHub Actions).
// Usage : DATABASE_URL=... BACKUP_DIR=./out node scripts/backup-ci.js
const fs = require("fs"), path = require("path");
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL manquante."); process.exit(1); }
const dir = process.env.BACKUP_DIR || "backup-out";
(async () => {
  const { neon } = require("@neondatabase/serverless"), sql = neon(url), query = async (q) => await sql.query(q);
  const out = { date: new Date().toISOString(), tables: {} };
  const t = await query("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1");
  for (const { table_name } of t) {
    const rows = await query('select * from "' + table_name.replace(/"/g, '""') + '"');
    out.tables[table_name] = rows; console.log(table_name.padEnd(35), rows.length, "lignes");
  }
  if (!Object.keys(out.tables).length) throw new Error("Aucune table lue : sauvegarde refusée.");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "omnipay-db-" + new Date().toISOString().slice(0, 10) + ".json");
  fs.writeFileSync(f, JSON.stringify(out)); fs.chmodSync(f, 0o600);
  console.log("Sauvegarde écrite :", f, (fs.statSync(f).size / 1024).toFixed(0) + " Ko");
})().catch((e) => { console.error("Erreur :", e.message); process.exit(1); });
