// Sauvegarde de la base OMNIPAY (toutes les tables -> un fichier JSON). Lecture seule.
// Usage (depuis le dossier omnipay-bj) :  DATABASE_URL='...' node backup-db.js
const fs = require("fs"), path = require("path"), os = require("os");
let Pool; try { ({ Pool } = require("pg")); } catch (e) { console.error("Module pg introuvable : lance d'abord 'npm install' dans le dossier omnipay-bj."); process.exit(1); }
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL manquante."); process.exit(1); }
(async () => {
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const out = { date: new Date().toISOString(), tables: {} };
  const t = await pool.query("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1");
  for (const { table_name } of t.rows) {
    const r = await pool.query('select * from "' + table_name.replace(/"/g, '""') + '"');
    out.tables[table_name] = r.rows; console.log(table_name.padEnd(35), r.rows.length, "lignes");
  }
  const dir = path.join(os.homedir(), "Documents"); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "omnipay-db-" + new Date().toISOString().slice(0, 10) + ".json");
  fs.writeFileSync(f, JSON.stringify(out)); fs.chmodSync(f, 0o600);
  console.log("\nSauvegarde écrite :", f, (fs.statSync(f).size / 1024).toFixed(0) + " Ko");
  await pool.end();
})().catch(e => { console.error("Erreur :", e.message); process.exit(1); });
