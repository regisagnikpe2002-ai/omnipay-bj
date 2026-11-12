"use strict";
// OMNIWALLET — le portefeuille unique du client : solde FCFA, cryptos, carnet de portefeuilles (adresses crypto, numéros Mobile Money) et retraits.
// FICHIER AJOUTÉ.
// GET    /api/omniwallet            vue d'ensemble (solde, cryptos, carnet, comptes reliés, retraits espèces en cours)
// POST   /api/omniwallet/book       ajouter un portefeuille {kind: crypto|mobile, label, asset?, network?, address | operator+phone}
// DELETE /api/omniwallet/book/:id   retirer un portefeuille du carnet
// Le retrait en espèces « TPE direct » passe par OMNICASH (/api/omnicash/cashout/request) : le client obtient un code à donner à l'agent.
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);
const UUID = /^[0-9a-f-]{36}$/i;
const OPS = ["mtn", "moov", "celtiis"];
const MAX_BOOK = 20;
let ready = false;
async function ensure() {
  if (ready) return;
  await sql()`CREATE TABLE IF NOT EXISTS ow_book (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, kind varchar(10) NOT NULL, label varchar(40) NOT NULL, asset varchar(10), network varchar(10), address varchar(120) NOT NULL, created_at timestamptz DEFAULT now())`;
  await sql()`CREATE INDEX IF NOT EXISTS ow_book_user ON ow_book (user_id)`;
  ready = true;
}
const tryQ = async (p) => { try { return await p; } catch (_) { return []; } };
const ex = () => { try { return require("./exchange"); } catch (_) { return {}; } };

router.get("/", requireAuth, async (req, res) => {
  try {
    await ensure(); const uid = req.user.userId, q = sql();
    const w = await q`SELECT balance::float AS b FROM wallets WHERE user_id = ${uid}::uuid`;
    const crypto = await tryQ(q`SELECT asset, qty::float AS qty FROM ex_balances WHERE user_id = ${uid}::uuid AND qty > 0 ORDER BY asset`);
    const book = await q`SELECT id, kind, label, asset, network, address, created_at FROM ow_book WHERE user_id = ${uid}::uuid ORDER BY created_at DESC`;
    const linked = await tryQ(q`SELECT count(*)::int AS n FROM linked_accounts WHERE user_id = ${uid}::uuid AND status <> 'removed'`);
    const cash = await tryQ(q`SELECT amount::float AS amount, expires_at FROM omnicash_cashout_requests WHERE client_id = ${uid}::uuid AND status = 'pending' AND expires_at > now() ORDER BY expires_at DESC LIMIT 1`);
    res.json({ balance: w.length ? w[0].b : 0, crypto, book: book.map((r) => ({ id: r.id, kind: r.kind, label: r.label, asset: r.asset, network: r.network, address: r.address })), linked: linked.length ? linked[0].n : 0, cashPending: cash[0] || null });
  } catch (e) { console.error("OW_GET", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.post("/book", requireAuth, async (req, res) => {
  try {
    await ensure(); const uid = req.user.userId, b = req.body || {}, kind = String(b.kind || "").toLowerCase(), label = clean(b.label, 40);
    if (!label) return res.status(400).json({ error: "Donnez un nom à ce portefeuille." });
    let asset = null, network = null, address = "";
    if (kind === "crypto") {
      const E = ex(); asset = String(b.asset || "").toUpperCase(); network = String(b.network || "").toUpperCase(); address = clean(b.address, 120);
      const A = E._ASSETS && E._ASSETS[asset];
      if (!A || !A.nets.includes(network)) return res.status(400).json({ error: "Monnaie ou réseau non pris en charge." });
      if (!E._ADDR[network] || !E._ADDR[network].test(address)) return res.status(400).json({ error: "Adresse invalide pour ce réseau." });
    } else if (kind === "mobile") {
      network = String(b.operator || "").toLowerCase(); address = String(b.phone || "").replace(/[^\d]/g, "");
      if (!OPS.includes(network)) return res.status(400).json({ error: "Opérateur : MTN, Moov ou Celtiis." });
      if (address.length < 8 || address.length > 15) return res.status(400).json({ error: "Numéro invalide." });
    } else return res.status(400).json({ error: "Type de portefeuille inconnu." });
    const n = await sql()`SELECT count(*)::int AS n FROM ow_book WHERE user_id = ${uid}::uuid`;
    if (n[0].n >= MAX_BOOK) return res.status(400).json({ error: `Maximum ${MAX_BOOK} portefeuilles.` });
    const dup = await sql()`SELECT 1 FROM ow_book WHERE user_id = ${uid}::uuid AND kind = ${kind} AND address = ${address} AND coalesce(network,'') = ${network || ""}`;
    if (dup.length) return res.status(409).json({ error: "Ce portefeuille est déjà enregistré." });
    const [r] = await sql()`INSERT INTO ow_book (user_id, kind, label, asset, network, address) VALUES (${uid}::uuid, ${kind}, ${label}, ${asset}, ${network}, ${address}) RETURNING id`;
    res.status(201).json({ ok: true, id: r.id });
  } catch (e) { console.error("OW_ADD", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.delete("/book/:id", requireAuth, async (req, res) => {
  try {
    await ensure(); if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    const r = await sql()`DELETE FROM ow_book WHERE id = ${req.params.id}::uuid AND user_id = ${req.user.userId}::uuid RETURNING id`;
    if (!r.length) return res.status(404).json({ error: "Introuvable." });
    res.json({ ok: true });
  } catch (e) { console.error("OW_DEL", e.message); res.status(500).json({ error: "Erreur." }); }
});

module.exports = router;
