"use strict";
// OMNIPAY — COMPTES RELIÉS (fichier AJOUTÉ). Le client enregistre SES destinations de retrait : Mobile Money, banque (IBAN), portefeuille crypto.
// OMNIPAY n'a aucun accès à ces comptes : on mémorise seulement une destination déclarée, que l'équipe valide dans OMNICHECK avant tout usage.
// Jamais de mot de passe, de PIN, de clé privée ni de phrase de récupération.
//   Client (connecté) : GET /mine · POST / {kind, provider, detail, holderName, network?} · DELETE /:id
//   Admin (x-admin-key) : GET /admin/pending · POST /admin/:id/verify · POST /admin/:id/reject {note?}
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." }));
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PER_USER = 12;
const MOBILE = ["mtn", "moov", "celtiis", "autre"];
const BANKS = ["biic", "ecobank", "boa", "uba", "nsia", "bsic", "autre"];
const PAYPAL = ["paypal"];
const WALLETS = ["autre"];
const CRYPTO_PROVIDERS = ["binance", "metamask", "wallet"];

const NETWORKS = { EVM: /^0x[0-9a-fA-F]{40}$/, TRON: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, BITCOIN: /^(bc1[0-9a-z]{20,80}|[13][1-9A-HJ-NP-Za-km-z]{25,39})$/, SOLANA: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, STELLAR: /^G[A-Z2-7]{55}$/ };

let ready = null;
async function ensure() {
  if (!ready) ready = (async () => {
    await sql()`CREATE TABLE IF NOT EXISTS linked_accounts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, kind varchar(10) NOT NULL, provider varchar(30) NOT NULL,
      network varchar(20), detail varchar(120) NOT NULL, holder_name varchar(120) NOT NULL, status varchar(12) NOT NULL DEFAULT 'pending',
      note varchar(200), created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz)`;
    await sql()`CREATE UNIQUE INDEX IF NOT EXISTS linked_accounts_uniq ON linked_accounts (user_id, kind, detail) WHERE status <> 'removed'`;
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

function ibanOk(s) {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0; for (const ch of r) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

function validate(b) {
  const kind = clean(b.kind, 10).toLowerCase();
  const provider = clean(b.provider, 30).toLowerCase();
  const holder = clean(b.holderName, 120);

  if (holder.replace(/[^A-Za-zÀ-ÿ]/g, "").length < 3)
    return { error: "Indiquez le nom du titulaire du compte." };

  if (kind === "mobile") {
    if (!MOBILE.includes(provider))
      return { error: "Opérateur invalide." };

    let detail = String(b.detail || "")
      .replace(/[\s.\-()]/g, "")
      .replace(/^\+?229/, "");

    if (!/^\d{8,10}$/.test(detail))
      return { error: "Numéro Mobile Money invalide." };

    return { kind, provider, network: null, detail, holder };
  }

  if (kind === "bank") {
    if (!BANKS.includes(provider))
      return { error: "Banque invalide." };

    const detail = clean(b.detail, 120).replace(/\s+/g, " ").trim();

    if (detail.length < 6)
      return { error: "Numéro de compte ou IBAN invalide." };

    return { kind, provider, network: null, detail, holder };
  }

  if (kind === "crypto") {
    if (!CRYPTO_PROVIDERS.includes(provider))
      return { error: "Portefeuille crypto invalide." };

    const net = clean(b.network, 20).toUpperCase();

    if (!NETWORKS[net])
      return { error: "Réseau crypto invalide." };

    const detail = clean(b.detail, 120).replace(/\s/g, "");

    if (!NETWORKS[net].test(detail))
      return { error: "Adresse invalide pour ce réseau." };

    return { kind, provider, network: net, detail, holder };
  }

  if (kind === "paypal") {
    if (!PAYPAL.includes(provider))
      return { error: "Fournisseur PayPal invalide." };

    const detail = clean(b.detail, 120);

    if (detail.length < 4)
      return { error: "Indiquez votre identifiant ou lien PayPal public." };

    return { kind, provider, network: null, detail, holder };
  }

  if (kind === "wallet") {
    if (!WALLETS.includes(provider))
      return { error: "Portefeuille invalide." };

    const detail = clean(b.detail, 120);

    if (detail.length < 4)
      return { error: "Identifiant du portefeuille invalide." };

    return { kind, provider, network: null, detail, holder };
  }

  return { error: "Type de compte invalide." };
}
router.get("/mine", requireAuth, async (req, res) => {
  try {
    await ensure();
    const rows = await sql()`SELECT id, kind, provider, network, detail, holder_name, status, note, created_at FROM linked_accounts
      WHERE user_id = ${req.user.userId}::uuid AND status <> 'removed' ORDER BY created_at DESC LIMIT 20`;
    res.json({ accounts: rows, max: MAX_PER_USER });
  } catch (e) { console.error("LINKED_MINE", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    await ensure();
    const v = validate(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const uid = req.user.userId;
    const n = (await sql()`SELECT count(*)::int AS n FROM linked_accounts WHERE user_id = ${uid}::uuid AND status <> 'removed'`)[0].n;
    if (n >= MAX_PER_USER) return res.status(409).json({ error: `Maximum ${MAX_PER_USER} comptes reliés. Supprimez-en un d'abord.` });
    const r = await sql()`INSERT INTO linked_accounts (user_id, kind, provider, network, detail, holder_name) VALUES (${uid}::uuid, ${v.kind}, ${v.provider}, ${v.network}, ${v.detail}, ${v.holder})
      ON CONFLICT DO NOTHING RETURNING id`;
    if (!r.length) return res.status(409).json({ error: "Ce compte est déjà relié." });
    res.status(201).json({ id: r[0].id, message: "Compte enregistré. Il sera utilisable pour vos retraits après vérification par l'équipe OMNIPAY." });
  } catch (e) { console.error("LINKED_ADD", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    if (!UUID.test(String(req.params.id))) return res.status(400).json({ error: "Identifiant invalide." });
    await ensure();
    const r = await sql()`UPDATE linked_accounts SET status = 'removed', decided_at = now() WHERE id = ${req.params.id}::uuid AND user_id = ${req.user.userId}::uuid AND status <> 'removed' RETURNING id`;
    if (!r.length) return res.status(404).json({ error: "Compte introuvable." });
    res.json({ message: "Compte supprimé." });
  } catch (e) { console.error("LINKED_DEL", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.get("/admin/pending", adminOnly, async (req, res) => {
  try {
    await ensure();
    const rows = await sql()`SELECT l.id, l.kind, l.provider, l.network, l.detail, l.holder_name, l.created_at, u.first_name, u.last_name, u.phone, u.email
      FROM linked_accounts l LEFT JOIN users u ON u.id = l.user_id WHERE l.status = 'pending' ORDER BY l.created_at LIMIT 100`;
    res.json({ accounts: rows });
  } catch (e) { console.error("LINKED_PENDING", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

const decide = (status) => async (req, res) => {
  try {
    if (!UUID.test(String(req.params.id))) return res.status(400).json({ error: "Identifiant invalide." });
    await ensure();
    const note = clean(req.body?.note, 200) || null;
    const r = await sql()`UPDATE linked_accounts SET status = ${status}, note = ${note}, decided_at = now() WHERE id = ${req.params.id}::uuid AND status = 'pending' RETURNING id`;
    if (!r.length) return res.status(409).json({ error: "Déjà traité ou introuvable." });
    res.json({ message: status === "verified" ? "Compte validé." : "Compte refusé." });
  } catch (e) { console.error("LINKED_DECIDE", e.message); res.status(500).json({ error: "Erreur serveur." }); }
};
router.post("/admin/:id/verify", adminOnly, decide("verified"));
router.post("/admin/:id/reject", adminOnly, decide("rejected"));

router._test = { validate, ibanOk };
router._ensure = ensure;
module.exports = router;
