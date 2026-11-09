"use strict";
// OMNIPAY — « DU JOUR » : cartes générées chaque jour par algorithme (marché crypto, prix OMNITRADE, défi, nouveau marché, service à découvrir).
// FICHIER AJOUTÉ. Les cartes servent à l'écran d'accueil et se partagent en image ou en courte vidéo depuis l'application.
// GET  /api/daily               cartes du jour (public, mises en cache 10 min)
// POST /api/daily/suggest       un client propose un marché à ajouter (connecté, 3 par jour)
// GET  /api/daily/admin/suggestions   propositions reçues (clé admin)
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);

const CHALLENGES = [
  ["Défi du jour : parrainer un ami", "Partagez votre lien de parrainage : 50 FCFA pour chaque filleul qui rejoint OMNIPAY.", "aff", "Mon lien"],
  ["Défi du jour : premier achat crypto", "Achetez 1 000 FCFA d'USDT dans votre portefeuille OMNIPAY, en moins d'une minute.", "crypto", "Acheter"],
  ["Défi du jour : le prix du marché", "Signalez le prix d'un produit de votre marché sur OMNITRADE et aidez tout le monde à mieux vendre.", "ot", "Signaler un prix"],
  ["Défi du jour : sécurisez votre compte", "Vérifiez votre profil et gardez votre mot de passe pour vous seul.", "prefs", "Mon profil"],
  ["Défi du jour : recharge sans friction", "Rechargez un proche en crédit ou forfait depuis votre solde, sans vous déplacer.", "recharge", "Recharger"],
  ["Défi du jour : un numéro pour vos comptes", "Recevez un code SMS sur un numéro virtuel pour WhatsApp, Telegram ou vos autres services.", "vn", "Obtenir un numéro"],
  ["Défi du jour : suivez vos dépenses", "Consultez votre graphique de dépenses de la semaine dans l'historique.", "hist", "Voir mon historique"],
];
const MARKETS = [
  ["Pharmacies de garde", "Trouver la pharmacie ouverte près de vous, de jour comme de nuit."],
  ["Transport", "Zémidjans, bus, taxis : prix et points de départ partout au Bénin."],
  ["Restaurants et maquis", "Les bonnes adresses, leurs plats et leurs prix du jour."],
  ["Hôtels et auberges", "Chambres, tarifs et contacts directs, sans intermédiaire."],
  ["Lotto et jeux", "Résultats et points de vente proches de chez vous."],
  ["Matériaux de construction", "Ciment, fer, sable : comparez les prix des fournisseurs."],
  ["Services à domicile", "Plombiers, électriciens, coiffeurs, mécaniciens : trouvez et contactez."],
];
const SERVICES = [
  ["Cryptos dans votre poche", "Achetez, vendez et dépensez USDT, BTC et plus, directement dans OMNIPAY.", "crypto", "Ouvrir Crypto"],
  ["Numéros virtuels", "Un numéro pour recevoir vos codes SMS, payable en FCFA ou en crypto.", "vn", "Obtenir un numéro"],
  ["OMNITRADE, la bourse locale", "Prix du jour de la tomate, de l'oignon, du piment et des vendeurs vérifiés.", "ot", "Ouvrir OMNITRADE"],
  ["Recharges et forfaits", "Crédit d'appel et forfaits internet MTN, Moov et Celtiis depuis votre solde.", "recharge", "Recharger"],
];

let CACHE = null;
async function marketCard() {
  try {
    const base = (process.env.MARKETS_BASE || "https://data-api.binance.vision").replace(/\/$/, "");
    const syms = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "TRXUSDT", "LTCUSDT"];
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(`${base}/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(syms))}`, { signal: ctl.signal }); clearTimeout(to);
    if (!r.ok) return null;
    const a = (await r.json()).map((x) => ({ s: x.symbol.replace("USDT", ""), p: Number(x.priceChangePercent) })).filter((x) => Number.isFinite(x.p));
    if (!a.length) return null;
    a.sort((x, y) => Math.abs(y.p) - Math.abs(x.p)); const m = a[0], up = m.p >= 0, v = Math.abs(m.p).toFixed(1).replace(".", ",");
    return { kind: "market", emoji: up ? "📈" : "📉", title: m.s + (up ? " monte de " : " recule de ") + v + " %", text: "Variation sur 24 h. Achetez ou vendez au cours du moment, directement dans votre portefeuille OMNIPAY.", go: "crypto", cta: "Ouvrir Crypto" };
  } catch (_) { return null; }
}
async function priceCard() {
  try {
    const q = sql();
    const r = await q`SELECT p.product, COALESCE(n.name, p.product) AS name, p.unit, round(avg(p.price_xof) FILTER (WHERE p.created_at > now() - interval '2 days'))::int AS now_p,
        round(avg(p.price_xof) FILTER (WHERE p.created_at <= now() - interval '2 days' AND p.created_at > now() - interval '9 days'))::int AS before_p
      FROM ot_prices p LEFT JOIN ot_products n ON n.slug = p.product WHERE p.created_at > now() - interval '9 days' GROUP BY p.product, n.name, p.unit HAVING avg(p.price_xof) FILTER (WHERE p.created_at > now() - interval '2 days') IS NOT NULL ORDER BY count(*) DESC LIMIT 1`;
    if (!r.length) return null; const x = r[0];
    let t = x.name + " : " + x.now_p + " FCFA le " + x.unit + " en ce moment.";
    if (x.before_p) { const d = Math.round(((x.now_p - x.before_p) / x.before_p) * 100); t += d === 0 ? " Prix stable cette semaine." : " " + (d > 0 ? "+" : "") + d + " % depuis la semaine dernière."; }
    return { kind: "price", emoji: "🌾", title: "Prix du jour : " + x.name, text: t, go: "ot", cta: "Voir la bourse" };
  } catch (_) { return null; }
}
async function build() {
  const day = Math.floor(Date.now() / 864e5), cards = [];
  const [m, p] = await Promise.all([marketCard(), priceCard()]);
  if (m) cards.push(m);
  cards.push(p || { kind: "price", emoji: "🌾", title: "OMNITRADE : le prix de votre marché", text: "Vendeurs, acheteurs et agents : consultez et partagez les prix du jour des produits locaux.", go: "ot", cta: "Ouvrir OMNITRADE" });
  const c = CHALLENGES[day % CHALLENGES.length]; cards.push({ kind: "challenge", emoji: "🏆", title: c[0], text: c[1], go: c[2], cta: c[3] });
  const mk = MARKETS[day % MARKETS.length]; cards.push({ kind: "market-idea", emoji: "🧭", title: "Bientôt : " + mk[0], text: mk[1] + " Voulez-vous qu'on l'ouvre en premier ? Dites-le-nous.", go: "suggest", cta: "Proposer un marché", idea: mk[0] });
  const s = SERVICES[day % SERVICES.length]; cards.push({ kind: "service", emoji: "✨", title: s[0], text: s[1], go: s[2], cta: s[3] });
  return { date: new Date(day * 864e5).toISOString().slice(0, 10), cards };
}
router.get("/", async (req, res) => {
  try { if (!CACHE || Date.now() - CACHE.at > 600000) CACHE = { at: Date.now(), d: await build() }; res.set("Cache-Control", "public, max-age=300"); res.json(CACHE.d); }
  catch (e) { console.error("DAILY", e.message); res.status(500).json({ error: "Erreur." }); }
});

let ready = false;
async function ensure() { if (ready) return; await sql()`CREATE TABLE IF NOT EXISTS daily_suggest (id serial PRIMARY KEY, user_id uuid NOT NULL, text varchar(200) NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`; ready = true; }
router.post("/suggest", requireAuth, async (req, res) => {
  try {
    await ensure(); const text = clean((req.body || {}).text, 200);
    if (text.length < 3) return res.status(400).json({ error: "Écrivez votre idée en quelques mots." });
    const [n] = await sql()`SELECT count(*)::int AS n FROM daily_suggest WHERE user_id = ${req.user.userId}::uuid AND created_at > now() - interval '1 day'`;
    if (n.n >= 3) return res.status(429).json({ error: "Vous avez déjà envoyé 3 idées aujourd'hui. Merci !" });
    await sql()`INSERT INTO daily_suggest (user_id, text) VALUES (${req.user.userId}::uuid, ${text})`;
    res.status(201).json({ ok: true, message: "Merci ! Votre idée est enregistrée." });
  } catch (e) { console.error("DAILY_SUG", e.message); res.status(500).json({ error: "Erreur." }); }
});
router.get("/admin/suggestions", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Accès refusé." });
  try { await ensure(); res.json({ top: await sql()`SELECT lower(text) AS text, count(*)::int AS votes FROM daily_suggest GROUP BY lower(text) ORDER BY votes DESC, max(created_at) DESC LIMIT 50` }); }
  catch (e) { console.error("DAILY_ADM", e.message); res.status(500).json({ error: "Erreur." }); }
});
module.exports = router;
module.exports._reset = () => { CACHE = null; };
