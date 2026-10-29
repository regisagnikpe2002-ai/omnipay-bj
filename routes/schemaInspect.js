"use strict";

/*
 * OMNIPAY — Inspection temporaire et READ-ONLY du schéma PostgreSQL.
 *
 * Cette route :
 * - exige ADMIN_KEY ;
 * - ne lit que information_schema ;
 * - n'expose aucune donnée client ;
 * - n'expose aucun solde ;
 * - n'expose aucune variable d'environnement ;
 * - n'exécute aucune écriture SQL.
 */

const express = require("express");
const { neon } = require("@neondatabase/serverless");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);

const adminOnly = (req, res, next) => {
  const provided = String(req.headers["x-admin-key"] || "");
  const expected = String(process.env.ADMIN_KEY || "");

  if (!provided || !expected || provided !== expected) {
    return res.status(403).json({ error: "Accès refusé." });
  }

  next();
};

router.get("/wallet-schema", adminOnly, async (req, res) => {
  try {
    const rows = await sql()`
      SELECT
        table_name,
        ordin        ordin        ordin        ord     data_type,
        udt_name,
        is_nullable,
                 fault
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('wallets', 'transactions')
      ORDER BY table_name, ordinal_position
    `;

    const tables = {    const tables = {    const tables = {    co };

    for (const row of rows) {
      if (tables[row.table_name]) {
        tables[row.table_name].push({
          position: Number(row.ordinal_position),
          column: row.column_name,
          type: row.data_type,
          postgresType: row.udt_name,
          nullable: row.is_nullable === "YES",
          hasDefault: row.column_default != null
        });
      }
    }

    res.json({
      readOnly: true,
      generatedAt: new Date().toISOString(),
      tables
    });
  } catch  error) {
    console.error("SCHEMA_INSPECT", error.message);

    res.status(50    ren({
      error: "Inspection du schéma impossible."
    });
  }
});

module.exports = router;
