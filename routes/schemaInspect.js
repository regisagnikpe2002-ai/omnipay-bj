"use strict";

const express = require("express");
const { neon } = require("@neondatabase/serverless");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);

function adminOnly(req, res, next) {
  const provided = String(req.headers["x-admin-key"] || "");
  const expected = String(process.env.ADMIN_KEY || "");

  if (!provided || !expected || provided !== expected) {
    return res.status(403).json({ error: "Accès refusé." });
  }

  next();
}

router.get("/wallet-schema", adminOnly, async (req, res) => {
  try {
    const rows = await sql()`
      SELECT
        table_name,
        ordinal_position,
        column_name,
        data_type,
        udt_name,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('wallets', 'transactions')
      ORDER BY table_name, ordinal_position
    `;

    const tables = {
                                       []                     st row of rows) {
      if (!tables[row.table_name]) continue;

                                                        mbe                  tion),
        column: row.column_name,
        type: row.data_type,
        postgresType: row.udt_name,
        nullable: row.is_nullable === "YES",
        hasDef        hasDef        hasDef        hasDef        hasDres.json({
      readOnly: true,
      generatedAt: new Date().toISOString(),
      tables
    });
  } catch (error) {
    conso    cons("SCHEMA_INSPECT", error.message);

    res.status(500).json({
          r: "Inspection du schéma impossible."
    })    })    })    })exports = router;
