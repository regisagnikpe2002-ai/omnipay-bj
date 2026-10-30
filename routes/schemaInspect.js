"use strict";
// OMNIPAY — inspecteur de schéma en LECTURE SEULE (admin). Il liste les colonnes de quelques tables pour vérifier la base sans y écrire.
// GET /api/schema-inspect/wallet-schema            → wallets + transactions
// GET /api/schema-inspect/tables                   → noms des tables du schéma public
// GET /api/schema-inspect/table/:name              → colonnes d'une table autorisée
const crypto = require("crypto");
const express = require("express");
const { neon } = require("@neondatabase/serverless");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const ALLOWED = new Set(["wallets", "transactions", "users", "account_ids", "inbound_payments", "manual_deposits", "manual_payouts", "linked_accounts", "cashdesk_orders", "pay_requests", "user_operators"]);

function adminOnly(req, res, next) {
  const provided = Buffer.from(String(req.headers["x-admin-key"] || ""));
  const expected = Buffer.from(String(process.env.ADMIN_KEY || ""));
  if (!expected.length || provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return res.status(403).json({ error: "Accès refusé." });
  }
  next();
}

async function columns(names) {
  const rows = await sql()`SELECT table_name, ordinal_position, column_name, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY(${names}) ORDER BY table_name, ordinal_position`;
  const tables = {};
  for (const n of names) tables[n] = [];
  for (const r of rows) {
    tables[r.table_name].push({ position: r.ordinal_position, column: r.column_name, type: r.data_type, postgresType: r.udt_name, nullable: r.is_nullable === "YES", hasDefault: r.column_default != null });
  }
  return tables;
}

router.get("/wallet-schema", adminOnly, async (req, res) => {
  try { res.json({ readOnly: true, generatedAt: new Date().toISOString(), tables: await columns(["wallets", "transactions"]) }); }
  catch (e) { console.error("SCHEMA_INSPECT", e.message); res.status(500).json({ error: "Inspection du schéma impossible." }); }
});

router.get("/tables", adminOnly, async (req, res) => {
  try {
    const rows = await sql()`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`;
    res.json({ readOnly: true, tables: rows.map((r) => r.table_name) });
  } catch (e) { console.error("SCHEMA_TABLES", e.message); res.status(500).json({ error: "Inspection du schéma impossible." }); }
});

router.get("/table/:name", adminOnly, async (req, res) => {
  try {
    const name = String(req.params.name || "").toLowerCase();
    if (!ALLOWED.has(name)) return res.status(404).json({ error: "Table non autorisée pour l'inspection." });
    res.json({ readOnly: true, table: name, columns: (await columns([name]))[name] });
  } catch (e) { console.error("SCHEMA_TABLE", e.message); res.status(500).json({ error: "Inspection du schéma impossible." }); }
});

module.exports = router;
