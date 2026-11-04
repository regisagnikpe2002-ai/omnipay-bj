"use strict";

const express = require("express");
const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");
const treasuryRegistry = require("../services/treasuryRegistry");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let ready = false;

function isAdmin(req) {
  const key = req.headers["x-admin-key"];
  return Boolean(key && process.env.ADMIN_KEY && key === process.env.ADMIN_KEY);
}

function adminOnly(req, res, next) {
  return isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." });
}

async function ensureTable() {
  if (ready) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS treasury_external_accounts (
      id uuid PRIMARY KEY,
      code varchar(80) NOT NULL UNIQUE,
      type varchar(30) NOT NULL,
      label varchar(120) NOT NULL,
      institution varchar(120),
      currency varchar(10) NOT NULL DEFAULT 'XOF',
      mode varchar(20) NOT NULL DEFAULT 'supervised',
      status varchar(20) NOT NULL DEFAULT 'pending',
      public_reference varchar(200) NOT NULL,
      network varchar(40),
      capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
      notes varchar(240),
      declared_balance numeric(18,2),
      reconciled_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await q`
    CREATE INDEX IF NOT EXISTS treasury_external_status_idx
    ON treasury_external_accounts (status, currency, type)
  `;
  ready = true;
}

function rowToAccount(row) {
  return {
    id: row.code,
    dbId: row.id,
    type: row.type,
    label: row.label,
    institution: row.institution,
    currency: row.currency,
    mode: row.mode,
    status: row.status,
    publicReference: row.public_reference,
    maskedReference: treasuryRegistry.maskReference(row.public_reference),
    network: row.network,
    capabilities: Array.isArray(row.capabilities) ? row.capabilities : [],
    notes: row.notes,
    declaredBalance: row.declared_balance == null ? null : Number(row.declared_balance),
    reconciledAt: row.reconciled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function adminView(row) {
  const account = rowToAccount(row);
  return {
    ...treasuryRegistry.publicView(account),
    dbId: account.dbId,
    declaredBalance: account.declaredBalance,
    reconciledAt: account.reconciledAt,
    notes: account.notes,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

router.get("/types", adminOnly, (req, res) => {
  res.json({
    types: treasuryRegistry.supportedTypes(),
    modes: [...treasuryRegistry.MODES],
    statuses: [...treasuryRegistry.STATUSES],
    capabilities: [...treasuryRegistry.CAPABILITIES]
  });
});

router.get("/", adminOnly, async (req, res) => {
  try {
    await ensureTable();
    const rows = await sql()`
      SELECT * FROM treasury_external_accounts
      ORDER BY created_at DESC
      LIMIT 200
    `;
    res.json({ accounts: rows.map(adminView) });
  } catch (error) {
    console.error("TREASURY_ACCOUNTS_LIST", error.message);
    res.status(500).json({ error: "Impossible de charger les trésoreries externes." });
  }
});

router.post("/", adminOnly, async (req, res) => {
  try {
    const normalized = treasuryRegistry.validate(req.body || {});
    if (normalized.error) return res.status(400).json({ error: normalized.error });

    await ensureTable();
    const dbId = crypto.randomUUID();
    const rows = await sql()`
      INSERT INTO treasury_external_accounts (
        id, code, type, label, institution, currency, mode, status,
        public_reference, network, capabilities, notes
      ) VALUES (
        ${dbId}::uuid,
        ${normalized.id},
        ${normalized.type},
        ${normalized.label},
        ${normalized.institution},
        ${normalized.currency},
        ${normalized.mode},
        ${normalized.status},
        ${normalized.publicReference},
        ${normalized.network},
        ${JSON.stringify(normalized.capabilities)}::jsonb,
        ${normalized.notes}
      )
      RETURNING *
    `;
    res.status(201).json({ account: adminView(rows[0]) });
  } catch (error) {
    if (String(error.message).toLowerCase().includes("unique")) {
      return res.status(409).json({ error: "Une trésorerie utilise déjà cet identifiant." });
    }
    console.error("TREASURY_ACCOUNTS_CREATE", error.message);
    res.status(500).json({ error: "Impossible de relier cette trésorerie." });
  }
});

router.patch("/:id", adminOnly, async (req, res) => {
  try {
    if (!UUID.test(String(req.params.id))) return res.status(400).json({ error: "Identifiant invalide." });
    await ensureTable();

    const currentRows = await sql()`SELECT * FROM treasury_external_accounts WHERE id = ${req.params.id}::uuid LIMIT 1`;
    if (!currentRows.length) return res.status(404).json({ error: "Trésorerie introuvable." });
    const current = rowToAccount(currentRows[0]);

    const candidate = treasuryRegistry.validate({
      id: current.id,
      type: req.body?.type ?? current.type,
      label: req.body?.label ?? current.label,
      institution: req.body?.institution ?? current.institution,
      currency: req.body?.currency ?? current.currency,
      mode: req.body?.mode ?? current.mode,
      status: req.body?.status ?? current.status,
      publicReference: req.body?.publicReference ?? current.publicReference,
      network: req.body?.network ?? current.network,
      capabilities: req.body?.capabilities ?? current.capabilities,
      notes: req.body?.notes ?? current.notes,
      pin: req.body?.pin,
      password: req.body?.password,
      otp: req.body?.otp,
      privateKey: req.body?.privateKey,
      seed: req.body?.seed,
      apiKey: req.body?.apiKey,
      accessToken: req.body?.accessToken
    });
    if (candidate.error) return res.status(400).json({ error: candidate.error });

    const rows = await sql()`
      UPDATE treasury_external_accounts SET
        type = ${candidate.type},
        label = ${candidate.label},
        institution = ${candidate.institution},
        currency = ${candidate.currency},
        mode = ${candidate.mode},
        status = ${candidate.status},
        public_reference = ${candidate.publicReference},
        network = ${candidate.network},
        capabilities = ${JSON.stringify(candidate.capabilities)}::jsonb,
        notes = ${candidate.notes},
        updated_at = now()
      WHERE id = ${req.params.id}::uuid
      RETURNING *
    `;
    res.json({ account: adminView(rows[0]) });
  } catch (error) {
    console.error("TREASURY_ACCOUNTS_UPDATE", error.message);
    res.status(500).json({ error: "Impossible de modifier cette trésorerie." });
  }
});

async function setStatus(req, res, status) {
  try {
    if (!UUID.test(String(req.params.id))) return res.status(400).json({ error: "Identifiant invalide." });
    await ensureTable();
    const rows = await sql()`
      UPDATE treasury_external_accounts
      SET status = ${status}, updated_at = now()
      WHERE id = ${req.params.id}::uuid
      RETURNING *
    `;
    if (!rows.length) return res.status(404).json({ error: "Trésorerie introuvable." });
    res.json({ account: adminView(rows[0]) });
  } catch (error) {
    console.error("TREASURY_ACCOUNTS_STATUS", error.message);
    res.status(500).json({ error: "Impossible de modifier le statut." });
  }
}

router.post("/:id/activate", adminOnly, (req, res) => setStatus(req, res, "active"));
router.post("/:id/suspend", adminOnly, (req, res) => setStatus(req, res, "suspended"));
router.post("/:id/disable", adminOnly, (req, res) => setStatus(req, res, "disabled"));

router.post("/:id/reconcile", adminOnly, async (req, res) => {
  try {
    if (!UUID.test(String(req.params.id))) return res.status(400).json({ error: "Identifiant invalide." });
    const balance = Number(req.body?.balance);
    if (!Number.isFinite(balance) || balance < 0 || balance > 1e15) {
      return res.status(400).json({ error: "Solde déclaré invalide." });
    }
    await ensureTable();
    const rows = await sql()`
      UPDATE treasury_external_accounts
      SET declared_balance = ${balance}, reconciled_at = now(), updated_at = now()
      WHERE id = ${req.params.id}::uuid
      RETURNING *
    `;
    if (!rows.length) return res.status(404).json({ error: "Trésorerie introuvable." });
    res.json({ account: adminView(rows[0]), message: "Solde de trésorerie rapproché." });
  } catch (error) {
    console.error("TREASURY_ACCOUNTS_RECONCILE", error.message);
    res.status(500).json({ error: "Impossible de rapprocher cette trésorerie." });
  }
});

router.get("/available/:capability", requireAuth, async (req, res) => {
  try {
    const capability = String(req.params.capability || "").toLowerCase();
    if (!treasuryRegistry.CAPABILITIES.includes(capability)) {
      return res.status(400).json({ error: "Capacité invalide." });
    }
    await ensureTable();
    const rows = await sql()`
      SELECT * FROM treasury_external_accounts
      WHERE status = 'active'
      ORDER BY created_at ASC
      LIMIT 100
    `;
    const accounts = rows.map(rowToAccount);
    const selected = treasuryRegistry.select(accounts, {
      capability,
      currency: String(req.query.currency || "XOF").toUpperCase(),
      type: req.query.type || ""
    });
    res.json({ accounts: selected.map(treasuryRegistry.publicView) });
  } catch (error) {
    console.error("TREASURY_ACCOUNTS_AVAILABLE", error.message);
    res.status(500).json({ error: "Impossible de charger les trésoreries disponibles." });
  }
});

module.exports = router;
