"use strict";
// OMNIPAY — ENCAISSEMENT MOBILE MONEY (dépôt) via le prestataire, adresse neutre /api/cashin. Le nom du prestataire reste invisible côté client.
//   GET  /api/cashin/status         -> { enabled, providers, min, max }
//   POST /api/cashin                {amount, phone, provider:'mtn'|'moov'|'celtiis'} -> demande de paiement sur le téléphone du client
//   GET  /api/cashin/:ref           -> statut du dépôt (lu en base ; le crédit n'arrive QUE par webhook signé)
//   GET  /api/cashin/terminal/list  -> dernières ventes du terminal marchand
// Réglages Render : FEEXPAY_API_KEY (clé secrète, jamais dans le code), FEEXPAY_SHOP_ID, FEEXPAY_WEBHOOK_SECRET (déjà utilisé par le webhook).
// Optionnel : FEEXPAY_BASE (défaut https://api-v2.feexpay.me), FEEXPAY_MIN_XOF (100), FEEXPAY_MAX_XOF (2000000), FEEXPAY_DEPOSITS=off pour couper.
const express = require("express");
const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");
const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (n, d) => { const v = Number(process.env[n]); return Number.isFinite(v) && v > 0 ? v : d; };
const MIN = () => num("FEEXPAY_MIN_XOF", 100), MAX = () => num("FEEXPAY_MAX_XOF", 2000000);
const BASE = () => String(process.env.FEEXPAY_BASE || "https://api-v2.feexpay.me").replace(/\/+$/, "");
const ready = () => Boolean(process.env.FEEXPAY_API_KEY && process.env.FEEXPAY_SHOP_ID);
const enabled = () => ready() && String(process.env.FEEXPAY_DEPOSITS || "on").toLowerCase() !== "off";
const OPS = ["mtn", "moov", "celtiis"];
const digits = (p) => { let d = String(p || "").replace(/\D/g, ""); if (d.startsWith("00")) d = d.slice(2); return d.startsWith("229") ? d : "229" + d.replace(/^0+/, ""); };

const OK = new Set(["SUCCESSFUL", "SUCCESS", "SUCCEEDED", "COMPLETED", "PAID"]);
const KO = new Set(["FAILED", "FAILURE", "CANCELLED", "CANCELED", "REJECTED", "EXPIRED", "DECLINED"]);
// Lit un événement du prestataire quel que soit son habillage ({...} ou {data:{...}}). Un statut inconnu ne crédite jamais.
function interpret(body) {
  const b = body && typeof body === "object" ? body : {};
  const d = b.data && typeof b.data === "object" ? b.data : b;
  const st = String(d.status || b.status || "").toUpperCase();
  return {
    reference: d.reference ? String(d.reference) : null,
    mine: d.callback_info ? String(d.callback_info) : (d.callbackInfo ? String(d.callbackInfo) : null),
    amount: Number(d.amount), outcome: OK.has(st) ? "ok" : KO.has(st) ? "ko" : "pending", raw: st,
  };
}

router.get("/status", requireAuth, (req, res) => res.json({ enabled: enabled(), providers: OPS, min: MIN(), max: MAX() }));

// Règle un dépôt à partir d'un événement DÉJÀ vérifié (signature HMAC) : référence connue + montant au moins égal à celui demandé.
async function settleFromWebhook(body) {
  const ev = interpret(body); if (ev.outcome === "pending") return { done: false, why: "statut " + (ev.raw || "inconnu") };
  const q = sql();
  const rows = await q`SELECT id, provider_ref, amount::float AS amount, status FROM transactions
    WHERE provider = 'feexpay' AND type = 'deposit' AND (provider_ref = ${ev.mine && UUID.test(ev.mine) ? ev.mine : "-"} OR metadata->>'feexRef' = ${ev.reference || "-"}) LIMIT 1`;
  if (!rows.length) return { done: false, why: "référence inconnue" };
  const t = rows[0]; if (t.status !== "pending") return { done: false, why: "déjà réglé" };
  if (ev.outcome === "ko") { await q`UPDATE transactions SET status = 'failed' WHERE id = ${t.id} AND status = 'pending'`; return { done: true, status: "failed" }; }
  if (!Number.isFinite(ev.amount) || ev.amount + 0.0001 < t.amount) {
    await q`UPDATE transactions SET metadata = coalesce(metadata,'{}'::jsonb) || ${JSON.stringify({ amountMismatch: ev.amount })}::jsonb WHERE id = ${t.id}`;
    console.error("CASHIN_AMOUNT_MISMATCH", t.provider_ref, ev.amount); return { done: false, why: "montant différent" };
  }
  await q`WITH t AS (SELECT id, wallet_id, amount FROM transactions WHERE id = ${t.id} AND status = 'pending' FOR UPDATE),
    w AS (UPDATE wallets SET balance = balance + t.amount, updated_at = now() FROM t WHERE wallets.id = t.wallet_id RETURNING wallets.balance, t.id AS tx_id)
    UPDATE transactions SET status = 'completed', balance_after = w.balance FROM w WHERE transactions.id = w.tx_id AND transactions.status = 'pending'`;
  return { done: true, status: "completed" };
}

router.post("/", requireAuth, async (req, res) => {
  try {
    if (!enabled()) return res.status(503).json({ error: "Dépôt Mobile Money indisponible pour le moment." });
    const amount = Math.floor(Number(req.body && req.body.amount));
    if (!Number.isFinite(amount) || amount < MIN() || amount > MAX()) return res.status(400).json({ error: `Montant entre ${MIN()} et ${MAX()} FCFA.` });
    const provider = String((req.body && req.body.provider) || "").toLowerCase();
    if (!OPS.includes(provider)) return res.status(400).json({ error: "Choisissez MTN, Moov ou Celtiis." });
    const phone = digits(req.body && req.body.phone);
    if (!/^229\d{8,10}$/.test(phone)) return res.status(400).json({ error: "Numéro invalide." });
    const q = sql();
    const w = await q`SELECT id, balance FROM wallets WHERE user_id = ${req.user.userId}::uuid`;
    if (!w.length) return res.status(404).json({ error: "Wallet introuvable." });
    const recent = await q`SELECT count(*)::int AS n FROM transactions WHERE wallet_id = ${w[0].id} AND provider = 'feexpay' AND status = 'pending' AND created_at > now() - interval '15 minutes'`;
    if (recent[0].n >= 3) return res.status(429).json({ error: "Plusieurs demandes sont déjà en attente. Validez-les sur votre téléphone ou patientez quelques minutes." });
    let f = "Client", l = "OMNIPAY";
    try { const [u] = await q`SELECT first_name, last_name FROM users WHERE id = ${req.user.userId}::uuid`; if (u) { f = String(u.first_name || f).slice(0, 40) || f; l = String(u.last_name || l).slice(0, 40) || l; } } catch (e) {}
    const ref = crypto.randomUUID(), term = Boolean(req.body && req.body.terminal);
    await q`INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key, metadata)
            VALUES (${w[0].id}, 'deposit', ${amount}, ${w[0].balance}, 'pending', 'feexpay', ${ref}, ${"feexpay-" + ref}, ${JSON.stringify(term ? { phone, provider, terminal: true, note: String((req.body && req.body.note) || "").slice(0, 80) } : { phone, provider })}::jsonb)`;
    let r, body = null;
    try {
      const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 20000);
      r = await fetch(`${BASE()}/api/transactions/public/requesttopay/${provider}`, { method: "POST", signal: ctl.signal,
        headers: { Authorization: "Bearer " + process.env.FEEXPAY_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: phone, amount, shop: process.env.FEEXPAY_SHOP_ID, first_name: f, last_name: l, description: "Depot OMNIPAY", callback_info: ref }) });
      clearTimeout(to); body = await r.json().catch(() => null);
    } catch (e) { console.error("CASHIN_NET", e.message); }
    if (!r || !r.ok) {
      await q`UPDATE transactions SET status = 'failed' WHERE provider_ref = ${ref} AND provider = 'feexpay'`;
      console.error("CASHIN_REFUSED", provider, r && r.status, JSON.stringify(body || {}).slice(0, 160)); // jamais de clé ni de numéro
      return res.status(400).json({ error: "La demande a été refusée (numéro, montant ou service indisponible)." });
    }
    if (body && body.reference) await q`UPDATE transactions SET metadata = coalesce(metadata,'{}'::jsonb) || ${JSON.stringify({ feexRef: String(body.reference) })}::jsonb WHERE provider_ref = ${ref} AND provider = 'feexpay'`;
    res.status(201).json({ reference: ref, status: "pending", message: "Validez le paiement sur votre téléphone (code secret Mobile Money)." });
  } catch (e) { console.error("CASHIN", e.message); res.status(500).json({ error: "Impossible de lancer le dépôt." }); }
});

router.get("/terminal/list", requireAuth, async (req, res) => {
  try {
    const rows = await sql()`SELECT t.provider_ref AS ref, t.amount::float AS amount, t.status, t.created_at, t.metadata->>'phone' AS phone, t.metadata->>'provider' AS op, t.metadata->>'note' AS note
      FROM transactions t JOIN wallets w ON w.id = t.wallet_id
      WHERE w.user_id = ${req.user.userId}::uuid AND t.provider IN ('feexpay','fedapay') AND t.type = 'deposit' AND t.metadata->>'terminal' = 'true' ORDER BY t.created_at DESC LIMIT 15`;
    res.json({ sales: rows.map((r) => ({ ...r, phone: "••••" + String(r.phone || "").slice(-4) })) });
  } catch (e) { console.error("CASHIN_TERMINAL", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.get("/:ref", requireAuth, async (req, res) => {
  try {
    if (!UUID.test(req.params.ref)) return res.status(400).json({ error: "Référence invalide." });
    const r = await sql()`SELECT t.status FROM transactions t JOIN wallets w ON w.id = t.wallet_id WHERE t.provider IN ('feexpay','fedapay') AND t.provider_ref = ${req.params.ref} AND w.user_id = ${req.user.userId}::uuid`;
    if (!r.length) return res.status(404).json({ error: "Dépôt introuvable." });
    res.json({ status: r[0].status });
  } catch (e) { console.error("CASHIN_POLL", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router; module.exports.enabled = enabled; module.exports.settleFromWebhook = settleFromWebhook; module.exports._interpret = interpret;
