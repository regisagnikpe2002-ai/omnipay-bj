"use strict";
// OMNIPAY — DÉPÔTS PAR FEDAPAY (rail secondaire d'encaissement Mobile Money MTN / Moov). FICHIER AJOUTÉ.
//   GET  /api/fedapay/deposit/status   -> { enabled, min, max }
//   POST /api/fedapay/deposit          {amount, phone, provider:'mtn'|'moov'} -> demande de paiement sur le téléphone du client
//   GET  /api/fedapay/deposit/:ref     -> relit le statut chez FedaPay et règle le dépôt (jamais de crédit sur la foi d'un callback)
// Le client valide lui-même sur sa SIM. Crédit atomique, une seule fois, après vérification du montant. Suivi automatique toutes les 60 s.
const express = require("express");
const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");
const fp = require("../providers/fedapay.js");
const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (n, d) => { const v = Number(process.env[n]); return Number.isFinite(v) && v > 0 ? v : d; };
const MIN = () => num("FEDAPAY_MIN_XOF", 100), MAX = () => num("FEDAPAY_MAX_XOF", 500000);
const digits = (p) => { let d = String(p || "").replace(/\D/g, ""); if (d.startsWith("00")) d = d.slice(2); return d.startsWith("229") ? d : "229" + d.replace(/^0+/, ""); };
const sandboxOk = () => ["on", "true", "1", "yes"].includes(String(process.env.FEDAPAY_SANDBOX_DEPOSITS || "off").toLowerCase());
const enabled = () => fp.ready() && (fp.env() === "live" || sandboxOk()) && String(process.env.FEDAPAY_DEPOSITS || "on").toLowerCase() !== "off";

router.get("/status", requireAuth, (req, res) => res.json({ enabled: enabled(), env: fp.env(), providers: ["mtn", "moov"], min: MIN(), max: MAX() }));

const creditPending = (ref) => sql()`
  WITH t AS (SELECT id, wallet_id, amount FROM transactions WHERE provider_ref = ${ref} AND provider = 'fedapay' AND type = 'deposit' AND status = 'pending' FOR UPDATE),
  w AS (UPDATE wallets SET balance = balance + t.amount, updated_at = now() FROM t WHERE wallets.id = t.wallet_id RETURNING wallets.balance, t.id AS tx_id),
  u AS (UPDATE transactions SET status = 'completed', balance_after = w.balance FROM w WHERE transactions.id = w.tx_id AND transactions.status = 'pending' RETURNING transactions.id)
  SELECT w.balance FROM w`;

async function settleDeposit(ref) {
  const q = sql();
  const t = await q`SELECT t.amount::float AS amount, t.status, t.metadata->>'fedaId' AS feda_id, (now() - t.created_at) > interval '30 minutes' AS old
    FROM transactions t WHERE t.provider = 'fedapay' AND t.type = 'deposit' AND t.provider_ref = ${ref}`;
  if (!t.length) return { status: "unknown" };
  if (t[0].status !== "pending") return { status: t[0].status };
  if (!fp.ready()) return { status: "pending" };
  if (!t[0].feda_id) {
    if (t[0].old) { await q`UPDATE transactions SET status = 'failed', metadata = coalesce(metadata,'{}'::jsonb) || ${JSON.stringify({ fedapayReason: "NO_TRANSACTION" })}::jsonb WHERE provider_ref = ${ref} AND provider = 'fedapay' AND status = 'pending'`; return { status: "failed" }; }
    return { status: "pending" };
  }
  let d; try { d = await fp.collectStatus(t[0].feda_id); } catch (e) { return { status: "pending" }; }
  if (d.found === false) return { status: "pending" };
  if (d.status === "completed") {
    if ((d.currency && String(d.currency).toUpperCase() !== "XOF") || !Number.isFinite(d.amount) || d.amount + 0.0001 < t[0].amount) {
      await q`UPDATE transactions SET metadata = coalesce(metadata,'{}'::jsonb) || ${JSON.stringify({ fedapayMismatch: { amount: d.amount, currency: d.currency } })}::jsonb WHERE provider_ref = ${ref} AND provider = 'fedapay'`;
      console.error("FEDAPAY_MISMATCH", ref, d.amount, d.currency); return { status: "pending", alert: true };
    }
    await creditPending(ref); return { status: "completed" };
  }
  if (d.status === "failed") {
    await q`UPDATE transactions SET status = 'failed', metadata = coalesce(metadata,'{}'::jsonb) || ${JSON.stringify({ fedapayReason: String(d.raw || "declined").slice(0, 40) })}::jsonb WHERE provider_ref = ${ref} AND provider = 'fedapay' AND status = 'pending'`;
    return { status: "failed" };
  }
  return { status: "pending" };
}

router.post("/", requireAuth, async (req, res) => {
  try {
    if (!enabled()) return res.status(503).json({ error: "Dépôt Mobile Money indisponible pour le moment." });
    const amount = Math.floor(Number(req.body && req.body.amount));
    if (!Number.isFinite(amount) || amount < MIN() || amount > MAX()) return res.status(400).json({ error: `Montant entre ${MIN()} et ${MAX()} FCFA.` });
    const provider = String((req.body && req.body.provider) || "").toLowerCase();
    if (!["mtn", "moov"].includes(provider)) return res.status(400).json({ error: "Choisissez MTN ou Moov." });
    const phone = digits(req.body && req.body.phone);
    if (!/^229\d{8,10}$/.test(phone)) return res.status(400).json({ error: "Numéro invalide." });
    const q = sql();
    const w = await q`SELECT id, balance FROM wallets WHERE user_id = ${req.user.userId}::uuid`;
    if (!w.length) return res.status(404).json({ error: "Wallet introuvable." });
    const recent = await q`SELECT count(*)::int AS n FROM transactions WHERE wallet_id = ${w[0].id} AND provider = 'fedapay' AND status = 'pending' AND created_at > now() - interval '15 minutes'`;
    if (recent[0].n >= 3) return res.status(429).json({ error: "Plusieurs demandes sont déjà en attente. Validez-les sur votre téléphone ou patientez quelques minutes." });
    let name = { f: "Client", l: "OMNIPAY" };
    try { const [u] = await q`SELECT first_name, last_name FROM users WHERE id = ${req.user.userId}::uuid`; if (u) name = { f: String(u.first_name || "Client").slice(0, 40) || "Client", l: String(u.last_name || "OMNIPAY").slice(0, 40) || "OMNIPAY" }; } catch (_) {}
    const ref = crypto.randomUUID();
    await q`INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key, metadata)
            VALUES (${w[0].id}, 'deposit', ${amount}, ${w[0].balance}, 'pending', 'fedapay', ${ref}, ${"fedapay-" + ref}, ${JSON.stringify({ phone, provider })}::jsonb)`;
    const r = await fp.collect({ ref, operator: provider, phone, amount, name });
    if (r.id) await q`UPDATE transactions SET metadata = coalesce(metadata,'{}'::jsonb) || ${JSON.stringify({ fedaId: r.id })}::jsonb WHERE provider_ref = ${ref} AND provider = 'fedapay'`;
    if (r.status === "refused" || r.status === "unavailable") {
      await q`UPDATE transactions SET status = 'failed', metadata = coalesce(metadata,'{}'::jsonb) || ${JSON.stringify({ fedapayReason: String(r.detail || "").slice(0, 80) })}::jsonb WHERE provider_ref = ${ref} AND provider = 'fedapay' AND status = 'pending'`;
      return res.status(400).json({ error: "La demande a été refusée (numéro, montant ou service indisponible)." });
    }
    if (r.status === "sent") return res.status(201).json({ reference: ref, status: "pending", message: "Validez le paiement sur votre téléphone (code secret Mobile Money)." });
    res.status(202).json({ reference: ref, status: "pending", message: "Demande en cours. Votre solde sera crédité dès la confirmation." });
  } catch (e) { console.error("FEDAPAY_DEPOSIT", e.message); res.status(500).json({ error: "Impossible de lancer le dépôt." }); }
});

router.get("/:ref", requireAuth, async (req, res) => {
  try {
    if (!UUID.test(req.params.ref)) return res.status(400).json({ error: "Référence invalide." });
    const own = await sql()`SELECT 1 FROM transactions t JOIN wallets w ON w.id = t.wallet_id WHERE t.provider = 'fedapay' AND t.provider_ref = ${req.params.ref} AND w.user_id = ${req.user.userId}::uuid`;
    if (!own.length) return res.status(404).json({ error: "Dépôt introuvable." });
    res.json(await settleDeposit(req.params.ref));
  } catch (e) { console.error("FEDAPAY_POLL", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

async function tick() {
  const out = { checked: 0, credited: 0 }; if (!fp.ready()) return out;
  const rows = await sql()`SELECT provider_ref FROM transactions WHERE provider = 'fedapay' AND type = 'deposit' AND status = 'pending' AND created_at > now() - interval '3 days' ORDER BY created_at LIMIT 40`;
  for (const r of rows) { out.checked++; try { if ((await settleDeposit(r.provider_ref)).status === "completed") out.credited++; } catch (e) { console.error("FEDAPAY_DEP_TICK", e.message); } }
  return out;
}
let timer = null;
if (!timer && fp.ready() && process.env.DATABASE_URL && String(process.env.FEDAPAY_WATCH || "on").toLowerCase() !== "off") { timer = setInterval(() => { tick().catch((e) => console.error("FEDAPAY_DEP_WATCH", e.message)); }, 60000); if (timer.unref) timer.unref(); }
module.exports = router; module.exports._tick = tick; module.exports._settle = settleDeposit;
