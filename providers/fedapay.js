"use strict";
// OMNIPAY — RAIL FEDAPAY : TRANSFERTS SORTANTS UNIQUEMENT (Mobile Money). FICHIER AJOUTÉ.
// Totalement séparé du fonds de réserve OMNICHECK : aucune table ni route commune. FedaPay débite SON propre solde marchand (à alimenter dans le tableau de bord FedaPay).
// Activation : PAYOUT_ROUTE_MTN / PAYOUT_ROUTE_MOOV / PAYOUT_ROUTE_CELTIIS = fedapay (providers/payoutRouter.js).
// Réglages Render : FEDAPAY_SECRET_KEY (clé secrète), FEDAPAY_ENV (live | sandbox, défaut live), FEDAPAY_PAYOUT_MAX_XOF (plafond automatique, 50000),
//   FEDAPAY_MODE_MTN / FEDAPAY_MODE_MOOV / FEDAPAY_MODE_CELTIIS (valeur « mode » du retrait chez FedaPay, défaut mobile_money : à confirmer dans votre tableau de bord),
//   FEDAPAY_SANDBOX_PAYOUTS=on (autorise l'essai en sandbox : aucun argent réel ne bouge).
// Sécurité : jamais de double envoi. Une ligne par retrait (fedapay_payouts, clé = id de la transaction) est écrite AVANT l'appel ; si la réponse est incertaine, on ne renvoie jamais.
const { neon } = require("@neondatabase/serverless");
const sql = () => neon(process.env.DATABASE_URL);

const key = () => String(process.env.FEDAPAY_SECRET_KEY || "").trim();
const env = () => (String(process.env.FEDAPAY_ENV || process.env.FEDAPAY_ENVIRONMENT || "live").toLowerCase() === "sandbox" ? "sandbox" : "live");
const base = () => (env() === "sandbox" ? "https://sandbox-api.fedapay.com/v1" : "https://api.fedapay.com/v1");
const ready = () => key().length > 15;
const cap = () => (Number(process.env.FEDAPAY_PAYOUT_MAX_XOF) > 0 ? Number(process.env.FEDAPAY_PAYOUT_MAX_XOF) : 50000);
const modeFor = (op) => process.env["FEDAPAY_MODE_" + String(op || "").toUpperCase()] || "mobile_money";
const local = (p) => { let d = String(p || "").replace(/\D/g, ""); if (d.startsWith("00")) d = d.slice(2); return d.startsWith("229") ? d.slice(3) : d; };

let tbl = false;
async function ensure() {
  if (tbl) return;
  await sql()`CREATE TABLE IF NOT EXISTS fedapay_payouts (tx_id uuid PRIMARY KEY, payout_id text, status varchar(12) NOT NULL DEFAULT 'creating', detail varchar(200), amount numeric(18,0), operator varchar(10), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`;
  tbl = true;
}
async function call(method, path, body) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(base() + path, { method, signal: ctl.signal, headers: { authorization: "Bearer " + key(), "content-type": "application/json", accept: "application/json" }, body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) {}
    return { status: r.status, data: d };
  } finally { clearTimeout(to); }
}
// FedaPay renvoie parfois l'objet seul, parfois sous une clé « v1/payout(s) » : on accepte les deux.
const first = (d) => { if (!d) return null; if (Array.isArray(d)) return d[0] || null; const w = d["v1/payout"] || d.payout || (Array.isArray(d["v1/payouts"]) ? d["v1/payouts"][0] : d["v1/payouts"]) || (Array.isArray(d.payouts) ? d.payouts[0] : null); return w || d; };
const mapStatus = (s) => { s = String(s || "").toLowerCase(); return s === "sent" ? "completed" : s === "failed" || s === "canceled" || s === "cancelled" ? "failed" : "pending"; };
const errText = (d) => String((d && (d.message || (d.errors && JSON.stringify(d.errors)) || d.error)) || "refus").slice(0, 140);

// Contrat identique aux autres canaux : {status:'sent'|'refused'|'uncertain'|'unavailable', detail, ref}
async function payout({ txId, operator, phone, amount }) {
  if (!ready()) return { status: "unavailable", detail: "FedaPay non configuré." };
  if (env() !== "live" && !["on", "true", "1", "yes"].includes(String(process.env.FEDAPAY_SANDBOX_PAYOUTS || "off").toLowerCase())) return { status: "unavailable", detail: "FedaPay est en mode test (aucun argent réel) : traitement manuel." };
  const amt = Math.round(Number(amount));
  if (!(amt > 0)) return { status: "refused", detail: "Montant invalide." };
  if (amt > cap()) return { status: "unavailable", detail: `Au-dessus du plafond automatique (${cap()} F) : traitement manuel.` };
  const num = local(phone); if (num.length < 8) return { status: "refused", detail: "Numéro invalide." };
  await ensure();
  const ins = await sql()`INSERT INTO fedapay_payouts (tx_id, amount, operator) VALUES (${String(txId)}::uuid, ${amt}, ${String(operator || "").slice(0, 10)}) ON CONFLICT (tx_id) DO NOTHING RETURNING tx_id`;
  if (!ins.length) return { status: "uncertain", detail: "FedaPay : ce retrait a déjà été tenté (vérification humaine, jamais de renvoi)." };
  let name = { f: "Client", l: "OMNIPAY" };
  try { const [u] = await sql()`SELECT u.first_name, u.last_name FROM transactions t JOIN wallets w ON w.id = t.wallet_id JOIN users u ON u.id = w.user_id WHERE t.id = ${String(txId)}::uuid`; if (u) name = { f: String(u.first_name || "Client").slice(0, 40) || "Client", l: String(u.last_name || "OMNIPAY").slice(0, 40) || "OMNIPAY" }; } catch (_) {}
  let id = null;
  try {
    const c = await call("POST", "/payouts", { amount: amt, currency: { iso: "XOF" }, mode: modeFor(operator), merchant_reference: String(txId), description: "Retrait OMNIPAY",
      customer: { firstname: name.f, lastname: name.l, phone_number: { number: num, country: "bj" } } });
    if (c.status >= 400 && c.status < 500) { await sql()`DELETE FROM fedapay_payouts WHERE tx_id = ${String(txId)}::uuid`; return { status: "refused", detail: "FedaPay refuse : " + errText(c.data) }; }
    const p = first(c.data); id = p && p.id != null ? String(p.id) : null;
    if (c.status >= 500 || !id) { await sql()`UPDATE fedapay_payouts SET status = 'unknown', detail = ${"création incertaine (" + c.status + ")"}, updated_at = now() WHERE tx_id = ${String(txId)}::uuid`; return { status: "uncertain", detail: "FedaPay : réponse incertaine à la création." }; }
    await sql()`UPDATE fedapay_payouts SET payout_id = ${id}, status = 'created', updated_at = now() WHERE tx_id = ${String(txId)}::uuid`;
  } catch (e) { await sql()`UPDATE fedapay_payouts SET status = 'unknown', detail = ${String(e.message).slice(0, 150)}, updated_at = now() WHERE tx_id = ${String(txId)}::uuid`; return { status: "uncertain", detail: "FedaPay : " + String(e.message).slice(0, 100) }; }
  try {
    const s = await call("PUT", "/payouts/start", [{ id: Number(id) }]);
    if (s.status >= 400) { await sql()`UPDATE fedapay_payouts SET status = 'created', detail = ${"démarrage refusé : " + errText(s.data)}, updated_at = now() WHERE tx_id = ${String(txId)}::uuid`; return { status: "refused", detail: "FedaPay : démarrage refusé : " + errText(s.data) }; }
    await sql()`UPDATE fedapay_payouts SET status = 'started', updated_at = now() WHERE tx_id = ${String(txId)}::uuid`;
    return { status: "sent", detail: "FedaPay accepté", ref: id };
  } catch (e) { await sql()`UPDATE fedapay_payouts SET status = 'started', detail = 'démarrage incertain', updated_at = now() WHERE tx_id = ${String(txId)}::uuid`; return { status: "uncertain", detail: "FedaPay : démarrage incertain (le suivi vérifiera)." }; }
}
// Statut chez FedaPay : 'completed' | 'failed' | 'pending'
async function status(payoutId) {
  const r = await call("GET", "/payouts/" + encodeURIComponent(payoutId));
  if (r.status === 404) return { found: false, status: "pending" };
  if (r.status >= 400) throw new Error("FedaPay " + r.status);
  const p = first(r.data); return { found: true, status: mapStatus(p && p.status), raw: String((p && p.status) || ""), reason: String((p && p.last_error_code) || "") };
}

// ---- ENCAISSEMENT (dépôts clients) : transaction -> jeton -> demande de paiement sur le téléphone du client (code secret) ----
// Modes d'encaissement chez FedaPay : FEDAPAY_COLLECT_MODE_MTN (défaut « mtn »), FEDAPAY_COLLECT_MODE_MOOV (défaut « moov »). À valider d'abord en sandbox (500 F).
const collectMode = (op) => process.env["FEDAPAY_COLLECT_MODE_" + String(op || "").toUpperCase()] || (String(op).toLowerCase() === "moov" ? "moov" : "mtn");
const one = (d, k) => { if (!d) return null; const w = d["v1/" + k] || d[k] || (Array.isArray(d["v1/" + k + "s"]) ? d["v1/" + k + "s"][0] : null) || (Array.isArray(d) ? d[0] : null); return w || d; };
// -> { status:'sent'|'refused'|'uncertain'|'unavailable', detail, id }
async function collect({ ref, operator, phone, amount, name }) {
  if (!ready()) return { status: "unavailable", detail: "FedaPay non configuré." };
  if (env() !== "live" && !["on", "true", "1", "yes"].includes(String(process.env.FEDAPAY_SANDBOX_DEPOSITS || "off").toLowerCase())) return { status: "unavailable", detail: "FedaPay est en mode test (aucun argent réel)." };
  const num = local(phone); if (num.length < 8) return { status: "refused", detail: "Numéro invalide." };
  let id = null;
  try {
    const c = await call("POST", "/transactions", { description: "Dépôt OMNIPAY", amount: Math.round(Number(amount)), currency: { iso: "XOF" }, merchant_reference: String(ref),
      customer: { firstname: (name && name.f) || "Client", lastname: (name && name.l) || "OMNIPAY", phone_number: { number: num, country: "bj" } } });
    if (c.status >= 400 && c.status < 500) return { status: "refused", detail: "FedaPay refuse : " + errText(c.data) };
    const t = one(c.data, "transaction"); id = t && t.id != null ? String(t.id) : null;
    if (c.status >= 500 || !id) return { status: "uncertain", detail: "FedaPay : réponse incertaine à la création." };
    const k = await call("POST", "/transactions/" + encodeURIComponent(id) + "/token");
    const token = k.data && (k.data.token || (one(k.data, "token") || {}).token);
    if (k.status >= 400 || !token) return { status: "uncertain", id, detail: "FedaPay : jeton non obtenu (" + k.status + ")." };
    const s = await call("POST", "/transactions/" + encodeURIComponent(collectMode(operator)), { token, phone_number: { number: num, country: "bj" } });
    if (s.status >= 400 && s.status < 500) return { status: "refused", id, detail: "FedaPay : demande refusée : " + errText(s.data) };
    if (s.status >= 500) return { status: "uncertain", id, detail: "FedaPay : envoi incertain." };
    return { status: "sent", id, detail: "FedaPay accepté" };
  } catch (e) { return { status: "uncertain", id, detail: "FedaPay : " + String(e.message).slice(0, 100) }; }
}
// Statut d'un encaissement : { found, status:'completed'|'failed'|'pending', amount, currency, raw }
async function collectStatus(id) {
  const r = await call("GET", "/transactions/" + encodeURIComponent(id));
  if (r.status === 404) return { found: false, status: "pending" };
  if (r.status >= 400) throw new Error("FedaPay " + r.status);
  const t = one(r.data, "transaction") || {}; const s = String(t.status || "").toLowerCase();
  const st = s === "approved" || s === "transferred" ? "completed" : s === "declined" || s === "canceled" || s === "cancelled" || s === "refunded" ? "failed" : "pending";
  return { found: true, status: st, amount: Number(t.amount), currency: t.currency && (t.currency.iso || t.currency), raw: s };
}
module.exports = { collect, collectStatus, collectMode,  payout, status, ready, env, ensure, cap, _mapStatus: mapStatus, _first: first };
