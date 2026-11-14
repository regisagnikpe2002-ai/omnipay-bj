"use strict";
// OMNIPAY — VERROU DU PREMIER DÉPÔT. Tant qu'un client n'a pas un dépôt TERMINÉ (≥ FIRST_DEPOSIT_MIN), le serveur refuse toute opération d'argent
// ou de service (retrait, transfert, crypto, boutique, abonnements…). Connexion, profil, dépôt et support restent ouverts. Contrôle côté serveur : l'écran ne suffit pas.
// FIRST_DEPOSIT_GATE=off pour désactiver · FIRST_DEPOSIT_MIN (défaut 500) · FIRST_DEPOSIT_GRANDFATHER=AAAA-MM-JJ : comptes créés avant cette date restent libres (défaut 2026-11-15).
const { neon } = require("@neondatabase/serverless");
const { verifyAccessToken } = require("./auth-utils.js");
const sql = () => neon(process.env.DATABASE_URL);
const on = () => String(process.env.FIRST_DEPOSIT_GATE || "on").toLowerCase() !== "off";
const MIN = () => { const v = Number(process.env.FIRST_DEPOSIT_MIN); return Number.isFinite(v) && v > 0 ? v : 500; };
const FROM = () => { const d = new Date(process.env.FIRST_DEPOSIT_GRANDFATHER || "2026-11-15"); return Number.isNaN(d.getTime()) ? new Date("2026-11-15") : d; };
const BLOCKED = [/^\/wallet\/(transfer|withdraw)\/?$/, /^\/api\/exchange\/(buy|sell|withdraw)/, /^\/api\/(bundles|vn|omnicash|notify|omniwallet|linked|business|cashdesk|orders|pay|omnitrade|p2pdesk|treasury-accounts|subscriptions|shop)(\/|$)/];
const okCache = new Map(); // userId → true (un client débloqué le reste)

async function status(uid) {
  if (!on()) return { required: false, unlocked: true, min: MIN() };
  if (okCache.get(uid)) return { required: true, unlocked: true, min: MIN() };
  const [r] = await sql()`SELECT (SELECT created_at FROM users WHERE id = ${uid}::uuid) AS created,
    coalesce((SELECT sum(t.amount) FROM transactions t JOIN wallets w ON w.id = t.wallet_id WHERE w.user_id = ${uid}::uuid AND t.type = 'deposit' AND t.status = 'completed'), 0)::float AS dep,
    EXISTS (SELECT 1 FROM transactions t JOIN wallets w ON w.id = t.wallet_id WHERE w.user_id = ${uid}::uuid AND t.type = 'deposit' AND t.status = 'completed' AND t.amount >= ${MIN()}) AS ok`;
  const old = r && r.created && new Date(r.created) < FROM();
  const unlocked = Boolean(old || (r && r.ok));
  if (unlocked) okCache.set(uid, true);
  return { required: true, unlocked, min: MIN(), deposited: r ? r.dep : 0, grandfathered: Boolean(old) };
}

async function guard(req, res, next) {
  try {
    if (!on() || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const p = req.path.replace(/\/+$/, "") || "/";
    if (!BLOCKED.some((r) => r.test(p))) return next();
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return next(); // pas de session : la route répondra 401 elle-même
    let uid; try { uid = verifyAccessToken(h.slice(7)).userId; } catch { return next(); }
    if (!uid) return next();
    const s = await status(String(uid));
    if (s.unlocked) return next();
    res.status(403).json({ firstDepositRequired: true, min: s.min, error: `Faites votre premier dépôt (minimum ${s.min} FCFA) pour activer votre compte OMNIPAY.` });
  } catch (e) { console.error("FIRST_DEPOSIT_GATE", e.message); next(); } // en cas de panne du contrôle, on ne bloque pas les clients
}
module.exports = guard; module.exports.status = status; module.exports._reset = () => okCache.clear();
