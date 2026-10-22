"use strict";
// OMNIPAY — tableau de bord administrateur (lecture seule, fichier AJOUTÉ). Clé : en-tête x-admin-key.
// Aucune écriture, aucun secret renvoyé : seules des indications « présent / absent / trop court » sont données.
const express = require("express");
const { neon } = require("@neondatabase/serverless");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
router.use((req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." })));

const safe = async (fn, fallback) => { try { return await fn(); } catch (e) { return fallback; } };

// Solde attendu d'un portefeuille d'après le journal (sert à repérer les écarts, pas à corriger).
const LEDGER = `coalesce(sum(CASE
  WHEN t.type IN ('deposit','transfer_in','refund') AND t.status = 'completed' THEN t.amount
  WHEN t.type = 'withdrawal' AND t.status <> 'cancelled' THEN -t.amount
  WHEN t.type = 'transfer_out' AND t.status = 'completed' THEN -t.amount
  WHEN t.type = 'commission' THEN -t.amount ELSE 0 END), 0)`;

function audit() {
  const e = process.env, out = [];
  const add = (item, level, note) => out.push({ item, level, note });
  const len = (k) => String(e[k] || "").length;
  len("ADMIN_KEY") >= 24 ? add("Clé administrateur", "ok", "Longueur suffisante.") : add("Clé administrateur", "bad", "Absente ou trop courte (24 caractères minimum conseillés).");
  len("OTP_SECRET") >= 32 ? add("Secret des codes e-mail (OTP)", "ok", "Longueur suffisante.") : add("Secret des codes e-mail (OTP)", "bad", "Absent ou inférieur à 32 caractères.");
  const jwt = Object.keys(e).filter((k) => k.startsWith("JWT_"));
  jwt.length ? add("Secrets de connexion (JWT)", "ok", `${jwt.length} variable(s) définie(s).`) : add("Secrets de connexion (JWT)", "bad", "Aucune variable JWT_* trouvée.");
  e.PAYDUNYA_MODE === "live" ? add("PayDunya", "ok", "Mode réel (live).") : add("PayDunya", "warn", "Mode test : les paiements ne sont pas réels.");
  e.AUTO_PAYOUT === "on" ? add("Retraits automatiques", "warn", "Activés : surveillez les retraits « en cours ».") : add("Retraits automatiques", "ok", "Désactivés : validation manuelle.");
  e.COINGATE_API_TOKEN ? add("CoinGate", e.COINGATE_ENV === "live" ? "ok" : "warn", e.COINGATE_ENV === "live" ? "Clé présente, mode réel." : "Clé présente, mode test (sandbox).") : add("CoinGate", "warn", "Non configuré.");
  const bn = e.BINANCE_PAY_API_KEY || e.BINANCE_API_KEY;
  bn ? add("Binance Pay", Number(e.USDT_XOF_RATE) >= 100 ? "ok" : "warn", Number(e.USDT_XOF_RATE) >= 100 ? "Clés et taux USDT/FCFA présents." : "Clés présentes mais USDT_XOF_RATE absent : dépôts USDT refusés.") : add("Binance Pay", "warn", "Non configuré.");
  e.PUBLIC_BASE_URL ? add("Adresse publique", "ok", "PUBLIC_BASE_URL définie.") : add("Adresse publique", "warn", "PUBLIC_BASE_URL absente (valeur par défaut utilisée).");
  (e.EMAIL_USER && e.EMAIL_PASS) ? add("E-mail (SMTP)", "ok", "Configuré.") : add("E-mail (SMTP)", "bad", "Non configuré : codes de connexion/réinitialisation impossibles.");
  let n = 0; try { n = JSON.parse(e.OMNIPAY_PAYIN_ACCOUNTS || "[]").length; } catch (_) { n = -1; }
  n > 0 ? add("Comptes de réception affichés aux clients", "ok", `${n} compte(s).`) : add("Comptes de réception affichés aux clients", n < 0 ? "bad" : "warn", n < 0 ? "OMNIPAY_PAYIN_ACCOUNTS n'est pas un JSON valide." : "Aucun compte défini.");
  add("Clés privées de portefeuilles", "ok", "Jamais stockées par le serveur (adresses publiques seulement).");
  return out;
}

router.get("/dash", async (req, res) => {
  try {
    const q = sql();
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 90);
    const series = await q`
      SELECT to_char(g.d, 'YYYY-MM-DD') AS day,
        coalesce(sum(t.amount) FILTER (WHERE t.type = 'deposit' AND t.status = 'completed'), 0)::float AS entrees,
        coalesce(sum(t.amount) FILTER (WHERE t.type = 'withdrawal' AND t.status NOT IN ('cancelled','refunded')), 0)::float AS sorties,
        coalesce(sum(t.amount) FILTER (WHERE t.type = 'transfer_out' AND t.status = 'completed'), 0)::float AS transferts,
        coalesce(sum(t.amount) FILTER (WHERE t.type = 'commission' AND t.status = 'completed'), 0)::float AS commissions
      FROM generate_series(date_trunc('day', now()) - make_interval(days => ${days - 1}::int), date_trunc('day', now()), interval '1 day') AS g(d)
      LEFT JOIN transactions t ON date_trunc('day', t.created_at) = g.d
      GROUP BY g.d ORDER BY g.d`;
    const kpi = (await q`SELECT
        (SELECT count(*)::int FROM users) AS clients,
        (SELECT coalesce(sum(balance),0)::float FROM wallets) AS soldes,
        (SELECT coalesce(sum(amount),0)::float FROM transactions WHERE type='commission' AND status='completed') AS commissions_total,
        (SELECT coalesce(sum(amount),0)::float FROM transactions WHERE type='deposit' AND status='completed') AS entrees_total,
        (SELECT coalesce(sum(amount),0)::float FROM transactions WHERE type='withdrawal' AND status NOT IN ('cancelled','refunded')) AS sorties_total`)[0];
    const statuses = await q`SELECT type, status, count(*)::int AS n, coalesce(sum(amount),0)::float AS total FROM transactions GROUP BY type, status ORDER BY type, status`;
    const top = await q`
      SELECT u.email, u.first_name, u.last_name, w.balance::float AS solde,
        coalesce(sum(t.amount) FILTER (WHERE t.type='deposit' AND t.status='completed'),0)::float AS entrees,
        coalesce(sum(t.amount) FILTER (WHERE t.type='withdrawal' AND t.status NOT IN ('cancelled','refunded')),0)::float AS sorties,
        coalesce(sum(t.amount) FILTER (WHERE t.type='transfer_out' AND t.status='completed'),0)::float AS envoyes,
        coalesce(sum(t.amount) FILTER (WHERE t.type='transfer_in' AND t.status='completed'),0)::float AS recus,
        count(t.id)::int AS operations
      FROM wallets w JOIN users u ON u.id = w.user_id LEFT JOIN transactions t ON t.wallet_id = w.id
      GROUP BY u.email, u.first_name, u.last_name, w.balance ORDER BY (coalesce(sum(t.amount),0)) DESC LIMIT 20`;
    const requests = {
      stuckWithdrawals: await safe(async () => (await q`SELECT count(*)::int AS n FROM transactions WHERE type='withdrawal' AND status IN ('pending','failed','processing')`)[0].n, 0),
      pendingDeposits: await safe(async () => (await q`SELECT count(*)::int AS n FROM transactions WHERE type='deposit' AND status='pending'`)[0].n, 0),
      manualDeposits: await safe(async () => (await q`SELECT count(*)::int AS n FROM manual_deposits WHERE status='pending'`)[0].n, 0),
      manualPayouts: await safe(async () => (await q`SELECT count(*)::int AS n FROM manual_payouts WHERE status='pending'`)[0].n, 0),
    };
    // Anomalies : écarts solde/journal et dépôts crédités plusieurs fois avec la même référence.
    const gaps = typeof q.query === "function"
      ? await q.query(`SELECT u.email, w.balance::float AS solde, ${LEDGER}::float AS attendu FROM wallets w JOIN users u ON u.id = w.user_id LEFT JOIN transactions t ON t.wallet_id = w.id GROUP BY u.email, w.balance HAVING abs(w.balance - ${LEDGER}) > 0.5 ORDER BY abs(w.balance - ${LEDGER}) DESC LIMIT 15`)
      : [];
    const dup = await q`SELECT provider_ref, count(*)::int AS n FROM transactions WHERE type='deposit' AND status='completed' AND provider_ref IS NOT NULL GROUP BY provider_ref HAVING count(*) > 1 LIMIT 10`;
    const negative = await q`SELECT count(*)::int AS n FROM wallets WHERE balance < 0`;
    const noWallet = await q`SELECT count(*)::int AS n FROM users u LEFT JOIN wallets w ON w.user_id = u.id WHERE w.id IS NULL`;
    const noId = await safe(async () => (await q`SELECT count(*)::int AS n FROM users u LEFT JOIN account_ids a ON a.user_id = u.id WHERE a.user_id IS NULL`)[0].n, null);
    let accounts = [];
    try { accounts = JSON.parse(process.env.OMNIPAY_PAYIN_ACCOUNTS || "[]").slice(0, 12).map((a) => ({ label: a.label, network: a.network || a.type || "", detail: a.detail || a.address || "" })); } catch (_) { /* JSON invalide signalé par l'audit */ }
    const anomalies = [];
    if (negative[0].n) anomalies.push(`${negative[0].n} portefeuille(s) avec un solde négatif.`);
    if (noWallet[0].n) anomalies.push(`${noWallet[0].n} client(s) sans portefeuille.`);
    if (dup.length) anomalies.push(`${dup.length} référence(s) de dépôt créditée(s) plusieurs fois.`);
    if (gaps.length) anomalies.push(`${gaps.length} portefeuille(s) dont le solde diffère du journal (à examiner : anciens ajustements possibles).`);
    res.json({ generatedAt: new Date().toISOString(), days, kpi, series, statuses, top, requests, gaps, duplicates: dup, anomalies, accountsWithoutId: noId, security: audit(), accounts });
  } catch (e) { console.error("ADMIN_DASH", e.message); res.status(500).json({ error: "Erreur du tableau de bord." }); }
});

// Données brutes pour l'export Excel (le fichier .xlsx est construit dans le navigateur de l'administrateur).
router.get("/export", async (req, res) => {
  try {
    const q = sql();
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 365);
    const transactions = await q`
      SELECT 'OMP-R' || upper(substr(replace(t.id::text,'-',''),1,10)) AS reference, t.created_at AS date, u.email, t.type, t.status, t.amount::float AS montant,
             t.balance_after::float AS solde_apres, t.provider AS canal
      FROM transactions t JOIN wallets w ON w.id = t.wallet_id JOIN users u ON u.id = w.user_id
      WHERE t.created_at > now() - make_interval(days => ${days}::int) ORDER BY t.created_at DESC LIMIT 5000`;
    const clients = await q`
      SELECT u.email, u.first_name AS prenom, u.last_name AS nom, u.created_at AS inscription, w.balance::float AS solde
      FROM users u LEFT JOIN wallets w ON w.user_id = u.id ORDER BY u.created_at`;
    const deposits = await safe(() => q`SELECT reference, method, currency, declared_amount::float AS montant_declare, status, credited_xof::float AS credite_fcfa, created_at AS date FROM manual_deposits ORDER BY created_at DESC LIMIT 2000`, []);
    const payouts = await safe(() => q`SELECT reference, method, destination, amount_xof::float AS montant_fcfa, status, created_at AS date FROM manual_payouts ORDER BY created_at DESC LIMIT 2000`, []);
    res.json({ days, transactions, clients, deposits, payouts });
  } catch (e) { console.error("ADMIN_EXPORT", e.message); res.status(500).json({ error: "Erreur d'export." }); }
});

module.exports = router;
