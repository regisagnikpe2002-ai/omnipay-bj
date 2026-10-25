"use strict";
// OMNIPAY — GARDE OMNICASH (fichier AJOUTÉ). Le « pilote » qui encadre l'argent automatique :
//  • interrupteur de pause (OMNICASH_PAUSE=on, ou bouton dans OMNICHECK) : plus aucun envoi automatique, les demandes restent en attente ;
//  • WITHDRAW_REQUIRE_LINKED=on : un retrait n'est accepté que vers un compte Mobile Money relié ET validé par l'équipe.
const { neon } = require("@neondatabase/serverless");
const sql = () => neon(process.env.DATABASE_URL);
const on = (v) => ["on", "true", "1", "yes"].includes(String(v || "off").toLowerCase());
const localDigits = (p) => { let d = String(p || "").replace(/\D/g, ""); if (d.startsWith("00")) d = d.slice(2); if (d.startsWith("229") && d.length > 10) d = d.slice(3); return d; };

let ready = null;
async function ensure() {
  if (!ready) ready = sql()`CREATE TABLE IF NOT EXISTS omnicash_flags (key varchar(40) PRIMARY KEY, value varchar(200) NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`.catch((e) => { ready = null; throw e; });
  return ready;
}
async function isPaused() {
  if (on(process.env.OMNICASH_PAUSE)) return true;
  try { await ensure(); const r = await sql()`SELECT value FROM omnicash_flags WHERE key = 'pause'`; return r[0]?.value === "on"; } catch (_) { return false; }
}
async function setPaused(v) {
  await ensure();
  await sql()`INSERT INTO omnicash_flags (key, value) VALUES ('pause', ${v ? "on" : "off"}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}
const requireLinked = () => on(process.env.WITHDRAW_REQUIRE_LINKED);

async function ensureLinked() { try { await require("../routes/linkedAccounts.js")._ensure(); } catch (_) { /* module absent */ } }
// Compte Mobile Money relié et validé d'un client (par id) ou par opérateur + numéro.
async function verifiedMobile(userId, { linkedId, operator, phone }) {
  await ensureLinked();
  const q = sql();
  try {
    if (linkedId) {
      const r = await q`SELECT provider AS operator, detail AS phone FROM linked_accounts WHERE id = ${linkedId}::uuid AND user_id = ${userId}::uuid AND kind = 'mobile' AND status = 'verified'`;
      return r[0] || null;
    }
    const r = await q`SELECT provider AS operator, detail AS phone FROM linked_accounts WHERE user_id = ${userId}::uuid AND kind = 'mobile' AND provider = ${operator} AND detail = ${localDigits(phone)} AND status = 'verified'`;
    return r[0] || null;
  } catch (_) { return null; }
}
module.exports = { isPaused, setPaused, requireLinked, verifiedMobile, localDigits, on };
