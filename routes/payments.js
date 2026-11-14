"use strict";
// OMNIPAY — /api/payments : UNE seule porte d'entrée pour les paiements du client. Le client ne voit que OMNIPAY ;
// le routeur choisit le canal en coulisses (FedaPay, PawaPay… ordre PAYMENTS_DEPOSIT_RAILS, défaut « fedapay,pawapay ») et crédite le ledger OMNIPAY.
// GET  /methods          → canal de dépôt disponible, montants min/max, numéros enregistrés, état du verrou « premier dépôt »
// GET  /gate             → { required, unlocked, min }
// POST /deposit          { amount, phone, provider: mtn|moov } → { reference, message }
// GET  /deposit/:ref     → { status: pending|completed|failed } ; à la réussite, le numéro est enregistré pour les retraits du client
// Les retraits restent sur /wallet/withdraw (avec code de confirmation) : ils ne passent pas par ce routeur, pour ne jamais contourner la garde OTP.
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");
const gate = require("../lib/firstDepositGate.js");
const sql = () => neon(process.env.DATABASE_URL);
const router = express.Router();
const UUIDLIKE = /^[A-Za-z0-9_.:-]{6,120}$/;

let tbl = false;
async function ensureOps() { if (tbl) return; await sql()`CREATE TABLE IF NOT EXISTS user_operators (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, operator varchar(10) NOT NULL, phone varchar(20) NOT NULL, is_default boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, operator, phone))`; tbl = true; }
const lazy = (f) => { try { return f(); } catch (_) { return null; } };
const RAILS = {
  fedapay: { mod: () => require("./fedapayDeposit"), on: () => { const m = lazy(() => require("./fedapayDeposit")); return Boolean(m && m.enabled && m.enabled()); }, post: "/", get: (r) => "/" + r },
  pawapay: { mod: () => require("./pawapay"), on: () => Boolean(lazy(() => require("../providers/pawapay.js").ready())), post: "/deposit", get: (r) => "/deposit/" + r },
};
const order = () => String(process.env.PAYMENTS_DEPOSIT_RAILS || "fedapay,pawapay").split(",").map((x) => x.trim()).filter((x) => RAILS[x]);
const pick = () => order().find((k) => RAILS[k].on()) || null;
const limits = () => ({ min: Number(process.env.PAYMENTS_MIN_DEPOSIT) || 100, max: Number(process.env.PAYMENTS_MAX_DEPOSIT) || 500000 });

router.get("/gate", requireAuth, async (req, res) => {
  try { res.json(await gate.status(String(req.user.userId))); } catch (e) { console.error("PAY_GATE", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.get("/methods", requireAuth, async (req, res) => {
  try {
    await ensureOps(); const rail = pick(), ops = await sql()`SELECT id, operator, phone, is_default FROM user_operators WHERE user_id = ${req.user.userId}::uuid ORDER BY is_default DESC, created_at`.catch(() => []);
    res.json({ deposit: { enabled: Boolean(rail), providers: ["mtn", "moov"], ...limits() }, saved: ops.map((o) => ({ id: o.id, operator: o.operator, phone: o.phone, isDefault: o.is_default })), gate: await gate.status(String(req.user.userId)) });
  } catch (e) { console.error("PAY_METHODS", e.message); res.status(500).json({ error: "Erreur." }); }
});

router.post("/deposit", requireAuth, (req, res, next) => {
  const rail = pick();
  if (!rail) return res.status(503).json({ error: "Dépôt Mobile Money indisponible pour le moment." });
  req.url = RAILS[rail].post; RAILS[rail].mod()(req, res, next);
});

router.get("/deposit/:ref", requireAuth, async (req, res, next) => {
  try {
    const ref = req.params.ref; if (!UUIDLIKE.test(ref)) return res.status(400).json({ error: "Référence invalide." });
    const [t] = await sql()`SELECT t.provider, t.metadata FROM transactions t JOIN wallets w ON w.id = t.wallet_id WHERE t.provider_ref = ${ref} AND t.type = 'deposit' AND w.user_id = ${req.user.userId}::uuid`;
    if (!t || !RAILS[t.provider]) return res.status(404).json({ error: "Dépôt introuvable." });
    const orig = res.json.bind(res);
    res.json = async (body) => { // à la réussite : on retient le numéro du client (retraits futurs) puis on répond
      try { if (body && body.status === "completed") await remember(req.user.userId, t.metadata); } catch (e) { console.error("PAY_REMEMBER", e.message); }
      return orig(body);
    };
    req.url = RAILS[t.provider].get(ref); RAILS[t.provider].mod()(req, res, next);
  } catch (e) { console.error("PAY_STATUS", e.message); res.status(500).json({ error: "Erreur." }); }
});

// Enregistre l'opérateur + numéro utilisés pour un dépôt réussi (max 6 numéros, sans doublon). Le retrait reste soumis aux règles existantes.
async function remember(userId, meta) {
  const m = meta || {}, op = String(m.provider || "").toLowerCase(), phone = String(m.phone || "").replace(/[^\d+]/g, "").replace(/^\+?229/, "").slice(0, 20);
  if (!["mtn", "moov", "celtiis"].includes(op) || phone.length < 8) return;
  await ensureOps(); const q = sql(); const [n] = await q`SELECT count(*)::int AS n FROM user_operators WHERE user_id = ${userId}::uuid`;
  if (n.n >= 6) return;
  await q`INSERT INTO user_operators (user_id, operator, phone, is_default) VALUES (${userId}::uuid, ${op}, ${phone}, ${n.n === 0}) ON CONFLICT (user_id, operator, phone) DO NOTHING`;
}
module.exports = router; module.exports._remember = remember; module.exports._pick = pick;
