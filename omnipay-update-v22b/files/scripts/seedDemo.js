"use strict";
// OMNIPAY — DONNÉES FICTIVES pour le SITE DÉMO uniquement. Lancement (depuis votre ordinateur, base de DÉMO) :
//   APP_MODE=demo DEMO_SEED=yes DATABASE_URL='<adresse de la base DÉMO>' node scripts/seedDemo.js
// Garde-fous : refuse de tourner si APP_MODE n'est pas « demo », si DEMO_SEED n'est pas « yes », ou si la base contient le moindre utilisateur qui n'est pas @demo.omnipay.test
// (donc impossible de l'exécuter par erreur sur la base LIVE ou sur une copie de la base LIVE).
const fs = require("fs");
const path = require("path");
const DOMAIN = "@demo.omnipay.test";

async function assertSafe(q) {
  if (String(process.env.APP_MODE || "").toLowerCase() !== "demo") throw new Error("Refusé : APP_MODE doit valoir « demo ».");
  if (process.env.DEMO_SEED !== "yes") throw new Error("Refusé : DEMO_SEED=yes requis (confirmation volontaire).");
  let real = 0;
  try { real = (await q`SELECT count(*)::int AS n FROM users WHERE email NOT LIKE ${"%" + DOMAIN}`)[0].n; } catch (_) { real = 0; } // table absente : base vide
  if (real > 0) throw new Error(`Refusé : cette base contient ${real} utilisateur(s) réel(s). Le jeu de démonstration ne s'écrit que dans une base de démo VIDE.`);
}

async function ensureSchema(q) {
  const exists = (await q`SELECT to_regclass('public.users') AS t, to_regclass('public.wallets') AS w, to_regclass('public.transactions') AS x`)[0];
  if (exists.t && exists.w && exists.x) return;
  const file = path.join(__dirname, "..", "db", "migrations", "0000_whole_hellion.sql");
  const parts = fs.readFileSync(file, "utf8").split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
  for (const p of parts) await q.query(p);
}

const PEOPLE = [
  { key: "awa", first: "Awa", last: "Démo", phone: "+22960000001", dep: [[200000, 25], [100000, 10]], out: [{ amt: 30000, op: "mtn", days: 8, status: "completed" }, { amt: 25000, op: "mtn", days: 0, status: "pending" }] },
  { key: "kofi", first: "Kofi", last: "Démo", phone: "+22960000002", dep: [[150000, 20]], out: [{ amt: 40000, op: "moov", days: 0, status: "pending" }] },
  { key: "mariam", first: "Mariam", last: "Démo", phone: "+22960000003", dep: [[400000, 12]], out: [{ amt: 250000, op: "celtiis", days: 0, status: "pending" }] },
  { key: "marchand1", first: "Point", last: "Cotonou", phone: "+22960000011", dep: [[50000, 15]], out: [], agent: { name: "Point Cotonou (démo)", city: "Cotonou", float: 500000 } },
  { key: "marchand2", first: "Point", last: "Calavi", phone: "+22960000012", dep: [[50000, 15]], out: [], agent: { name: "Point Calavi (démo)", city: "Abomey-Calavi", float: 300000 } },
];

async function seed(q) {
  await assertSafe(q);
  await ensureSchema(q);
  const bcrypt = require("bcryptjs");
  const hash = await bcrypt.hash(process.env.DEMO_PASSWORD || "Demo-2026!", 10);
  const already = (await q`SELECT count(*)::int AS n FROM users WHERE email LIKE ${"%" + DOMAIN}`)[0].n;
  if (already > 0) return { created: 0, note: "La base de démo contient déjà des comptes de démonstration." };
  await q`CREATE TABLE IF NOT EXISTS omnicash_agents (user_id uuid PRIMARY KEY, name varchar(80), city varchar(80), status varchar(12) NOT NULL DEFAULT 'pending',
    float_xof numeric(18,2) NOT NULL DEFAULT 0 CHECK (float_xof >= 0), float_limit numeric(18,2) NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now())`;
  let n = 0;
  for (const p of PEOPLE) {
    const u = (await q`INSERT INTO users (email, phone, password_hash, first_name, last_name, kyc_status) VALUES (${"demo." + p.key + DOMAIN}, ${p.phone}, ${hash}, ${p.first}, ${p.last}, 'verified') RETURNING id`)[0];
    const w = (await q`INSERT INTO wallets (user_id, balance) VALUES (${u.id}::uuid, 0) RETURNING id`)[0];
    let bal = 0, k = 0;
    const add = async (type, amount, status, days, provider, ref, sign) => {
      bal += sign * amount; k++;
      await q`INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, provider_ref, idempotency_key, created_at)
        VALUES (${w.id}::uuid, ${type}, ${amount}, ${bal}, ${status}, ${provider}, ${ref}, ${"demo-" + p.key + "-" + k}, now() - make_interval(days => ${days}::int))`;
    };
    for (const [amt, days] of p.dep) await add("deposit", amt, "completed", days, "manual", "DEMO-DEP", +1);
    for (const o of p.out) {
      await add("withdrawal", o.amt, o.status, o.days, o.op, "0160000099", -1);
      await add("commission", 50, "completed", o.days, "internal", null, -1);
    }
    await q`UPDATE wallets SET balance = ${bal} WHERE id = ${w.id}::uuid`;
    if (p.agent) await q`INSERT INTO omnicash_agents (user_id, name, city, status, float_xof, float_limit) VALUES (${u.id}::uuid, ${p.agent.name}, ${p.agent.city}, 'active', ${p.agent.float}, ${p.agent.float * 2})`;
    n++;
  }
  return { created: n, note: "Comptes de démonstration créés (mot de passe : celui de DEMO_PASSWORD, ou Demo-2026! par défaut). Tout est fictif." };
}

module.exports = { seed, assertSafe, PEOPLE, DOMAIN };

if (require.main === module) {
  (async () => {
    require("dotenv").config();
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL manquant.");
    const { neon } = require("@neondatabase/serverless");
    const q = neon(process.env.DATABASE_URL);
    const host = (() => { try { return new URL(process.env.DATABASE_URL).hostname; } catch (_) { return "?"; } })();
    console.log("Base ciblée :", host);
    console.log(await seed(q));
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
