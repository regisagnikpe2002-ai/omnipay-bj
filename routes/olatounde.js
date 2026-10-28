"use strict";
// OMNIPAY — OLATOUNDE : intelligence et accompagnement client (fichier AJOUTÉ).
// Règle absolue : OLATOUNDE n'exécute JAMAIS d'opération d'argent. Il explique, oriente, lit l'état réel des opérations du client
// (solde, derniers mouvements, demandes en attente) et, s'il ne sait pas répondre, ouvre un ticket que l'administrateur voit dans OMNICHECK.
// Réponses par règles (aucun service externe, aucune donnée envoyée à un tiers). Un modèle de langage pourra être branché plus tard à la place de answer().
//   POST /api/olatounde/ask         (client connecté) {message}            → {reply, intent, escalated?}
//   GET  /api/olatounde/admin/tickets   (admin)                           → tickets ouverts
//   POST /api/olatounde/admin/tickets/:id/close (admin) {note}
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." }));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);
const f = (n) => new Intl.NumberFormat("fr-FR").format(Math.round(Number(n) || 0));

let ready = null;
function ensure() {
  if (!ready) ready = sql()`CREATE TABLE IF NOT EXISTS olatounde_tickets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, message varchar(600) NOT NULL, status varchar(10) NOT NULL DEFAULT 'open',
    note varchar(300), created_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz)`.catch((e) => { ready = null; throw e; });
  return ready;
}

// Limite simple : 20 questions par minute et par client.
const hits = new Map();
function limited(uid) {
  const now = Date.now(), arr = (hits.get(uid) || []).filter((t) => now - t < 60000);
  arr.push(now); hits.set(uid, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60000)) hits.delete(k);
  return arr.length > 20;
}

const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const INTENTS = [
  ["otp", /\b(otp|code|sms|mail|e-?mail|courriel)\b.*\b(recu|recois|arrive|vient|envoy)|\b(pas|aucun)\b.*\bcode\b|verification/],
  ["statut", /statut|ou en est|en attente|pending|bloque|toujours pas|pas arrive|delai|combien de temps|pas recu|toujours en cours/],
  ["depot", /depot|deposer|recharg|alimenter|crediter|mettre de l.?argent/],
  ["retrait", /retrait|retirer|envoyer vers|sortir|cash ?out/],
  ["solde", /solde|combien (j.?ai|il me reste)|mon argent|balance/],
  ["frais", /frais|commission|tarif|cout|combien ca coute/],
  ["identifiant", /identifiant|alias|mon id|numero om|\bom\d|recevoir de l.?argent|qr/],
  ["carte", /carte|visa|mastercard|virtuelle/],
  ["agent", /agent|omnicash|point de vente|revendeur/],
  ["securite", /securite|arnaque|fraude|pirat|mot de passe|piratage|vol|suspect/],
  ["humain", /humain|conseiller|agent humain|parler a|appeler|reclamation|plainte|probleme/],
  ["salut", /^(bonjour|bonsoir|salut|hello|hi|coucou|bjr)\b/],
];
const detect = (m) => { const t = norm(m); const hit = INTENTS.find(([, re]) => re.test(t)); return hit ? hit[0] : null; };

async function snapshot(userId) {
  const q = sql();
  const w = await q`SELECT id, balance::float AS balance FROM wallets WHERE user_id = ${userId}::uuid`;
  if (!w.length) return { balance: null, recent: [], pendingDeposits: 0, pendingPayouts: 0 };
  const recent = await q`SELECT type, amount::float AS amount, status, provider, created_at FROM transactions WHERE wallet_id = ${w[0].id}::uuid ORDER BY created_at DESC LIMIT 5`;
  let pd = 0, pp = 0;
  try {
    pd = (await q`SELECT count(*)::int AS n FROM manual_deposits WHERE user_id = ${userId}::uuid AND status = 'pending'`)[0].n;
    pp = (await q`SELECT count(*)::int AS n FROM manual_payouts WHERE user_id = ${userId}::uuid AND status = 'pending'`)[0].n;
  } catch (_) { /* tables manuelles absentes : ignoré */ }
  return { balance: w[0].balance, recent, pendingDeposits: pd, pendingPayouts: pp };
}
const TYPE = { deposit: "Dépôt", withdrawal: "Retrait", transfer_in: "Réception", transfer_out: "Envoi", commission: "Frais", refund: "Remboursement" };
const STATE = { completed: "terminé", pending: "en attente", failed: "échoué", refused: "refusé", refunded: "remboursé" };
const line = (t) => `${TYPE[t.type] || t.type} de ${f(t.amount)} F : ${STATE[t.status] || t.status} (${new Date(t.created_at).toLocaleDateString("fr-FR")})`;

async function answer(intent, snap) {
  switch (intent) {
    case "salut": return "Bonjour, je suis OLATOUNDE, l'assistante d'OMNIPAY. Je peux vous expliquer un dépôt, un retrait, vos frais ou l'état de vos opérations. Je ne déplace jamais d'argent moi-même.";
    case "solde": return snap.balance == null ? "Je ne trouve pas votre portefeuille. Je transmets votre demande à l'équipe." : `Votre solde est de ${f(snap.balance)} F CFA.`;
    case "statut": {
      const parts = [];
      if (snap.pendingDeposits) parts.push(`${snap.pendingDeposits} dépôt(s) en attente de vérification par l'équipe`);
      if (snap.pendingPayouts) parts.push(`${snap.pendingPayouts} retrait(s) en attente de paiement`);
      const head = parts.length ? "En attente : " + parts.join(", ") + ". " : "Aucune demande en attente de mon côté. ";
      return head + (snap.recent.length ? "Vos dernières opérations : " + snap.recent.slice(0, 3).map(line).join(" ; ") + "." : "Vous n'avez pas encore d'opération.") + " Si une opération dépasse 30 minutes, dites « parler à un conseiller ».";
    }
    case "depot": return "Pour déposer : ouvrez Dépôt, choisissez MTN MoMo ou le virement PI-SPI, puis suivez les consignes. Un dépôt MoMo est crédité dès la confirmation de MTN ; un dépôt PI-SPI ou manuel est crédité après vérification par l'équipe. Indiquez toujours votre identifiant OM comme référence.";
    case "retrait": return "Pour retirer : ouvrez Retrait, choisissez l'opérateur et saisissez le numéro. Le montant est réservé tout de suite sur votre solde. Selon le montant, le paiement est automatique ou validé par l'équipe. En cas d'échec, vous êtes remboursé.";
    case "frais": return "Les frais s'affichent avant chaque confirmation, avec le montant exact que vous recevez. Rien n'est prélevé sans votre accord.";
    case "identifiant": return "Votre identifiant OM et votre alias sont dans la rubrique « Ma carte ». Donnez-les à la personne qui veut vous envoyer de l'argent : il arrive directement sur votre portefeuille OMNIPAY.";
    case "carte": return "Votre carte OMNIPAY est pour l'instant une carte d'identité de paiement entre clients. La carte bancaire virtuelle (Visa/Mastercard) demande un partenaire émetteur : demandez-la dans « Ma carte » et vous serez prévenu à son ouverture.";
    case "agent": return "Les agents OMNICASH rechargent et retirent l'argent des clients en espèces. Si vous voulez en devenir un, dites « parler à un conseiller ».";
    case "otp": return "Si le code n'arrive pas : vérifiez l'adresse saisie, regardez les courriers indésirables (spam), attendez 2 minutes puis redemandez UN seul code (plusieurs demandes rapprochées bloquent l'envoi). Toujours rien ? Dites « parler à un conseiller ».";
    case "securite": return "Règles d'or : personne chez OMNIPAY ne vous demandera jamais votre mot de passe, votre code reçu par SMS/e-mail ou vos clés crypto. Ne partagez rien de tout cela. Si vous pensez être victime d'une fraude, dites « parler à un conseiller » : l'équipe bloque et vérifie.";
    default: return null;
  }
}

router.post("/ask", requireAuth, async (req, res) => {
  try {
    const uid = req.user && req.user.userId;
    if (!uid) return res.status(401).json({ error: "Connexion requise." });
    if (limited(uid)) return res.status(429).json({ error: "Trop de messages. Réessayez dans une minute." });
    const message = clean(req.body && req.body.message, 600);
    if (message.length < 2) return res.status(400).json({ error: "Écrivez votre question." });
    await ensure();
    const intent = detect(message);
    let reply = null, escalate = intent === "humain" || /fraude|arnaque|pirat|vol\b/.test(norm(message));
    if (intent && intent !== "humain") reply = await answer(intent, await snapshot(uid));
    if (!reply) escalate = true;
    let ticket = null;
    if (escalate) {
      const open = (await sql()`SELECT count(*)::int AS n FROM olatounde_tickets WHERE user_id = ${uid}::uuid AND status = 'open'`)[0].n;
      if (open < 3) ticket = (await sql()`INSERT INTO olatounde_tickets (user_id, message) VALUES (${uid}::uuid, ${message}) RETURNING id`)[0].id;
      const base = reply ? reply + " " : "Je n'ai pas la réponse exacte. ";
      reply = base + (ticket ? "J'ai transmis votre demande à l'équipe OMNIPAY, qui vous répondra." : "Vous avez déjà des demandes ouvertes : l'équipe les traite, merci de patienter.");
    }
    res.json({ reply, intent: intent || "inconnu", escalated: Boolean(ticket) });
  } catch (e) { console.error("OLATOUNDE_ASK", e.message); res.status(500).json({ error: "Service momentanément indisponible." }); }
});

async function adminBriefing() {
  await ensure();
  const q = sql();

  const safe = async (fn, fallback) => {
    try {
      return await fn();
    } catch (_) {
      return fallback;
    }
  };

  const activity = await safe(async () => {
    const rows = await q`
      SELECT
        coalesce(sum(CASE
          WHEN type = 'deposit' AND status = 'completed'
          THEN amount ELSE 0
        END), 0)::float AS deposits_24h,

        coalesce(sum(CASE
          WHEN type = 'withdrawal' AND status = 'completed'
          THEN amount ELSE 0
        END), 0)::float AS withdrawals_24h,

        count(*) FILTER (
          WHERE status IN ('pending', 'processing')
        )::int AS pending_operations,

        count(*) FILTER (
          WHERE status IN ('failed', 'refused')
        )::int AS failed_operations

      FROM transactions
      WHERE created_at > now() - interval '24 hours'
    `;
    return rows[0];
  }, {
    deposits_24h: 0,
    withdrawals_24h: 0,
    pending_operations: 0,
    failed_operations: 0
  });

  const linked = await safe(async () => {
    const rows = await q`
      SELECT
        count(*) FILTER (
          WHERE status = 'pending'
        )::int AS pending,

        count(*) FILTER (
          WHERE status = 'verified'
        )::int AS verified,

        count(*) FILTER (
          WHERE status = 'rejected'
        )::int AS rejected

      FROM linked_accounts
    `;
    return rows[0];
  }, {
    pending: 0,
    verified: 0,
    rejected: 0
  });

  const support = await safe(async () => {
    const rows = await q`
      SELECT
        count(*) FILTER (
          WHERE status = 'open'
        )::int AS open,

        count(*) FILTER (
          WHERE status = 'open'
          AND created_at < now() - interval '24 hours'
        )::int AS older_than_24h

      FROM olatounde_tickets
    `;
    return rows[0];
  }, {
    open: 0,
    older_than_24h: 0
  });

  const wallets = await safe(async () => {
    const rows = await q`
      SELECT
        coalesce(sum(balance), 0)::float AS clients_due
      FROM wallets
    `;
    return rows[0];
  }, {
    clients_due: 0
  });

  const agents = await safe(async () => {
    const rows = await q`
      SELECT
        coalesce(sum(float_xof), 0)::float AS agents_float,
        count(*) FILTER (
          WHERE status = 'active' AND float_xof < 20000
        )::int AS low_float_agents
      FROM omnicash_agents
    `;
    return rows[0];
  }, {
    agents_float: 0,
    low_float_agents: 0
  });

  const reserves = await safe(async () => {
    const rows = await q`
      SELECT
        f.code,
        coalesce(b.balance_xof, 0)::float AS balance_xof
      FROM fund_accounts f
      LEFT JOIN LATERAL (
        SELECT balance_xof
        FROM fund_balances
        WHERE code = f.code
        ORDER BY id DESC
        LIMIT 1
      ) b ON true
      WHERE f.active = true
    `;

    const byCode = Object.fromEntries(
      rows.map((row) => [row.code, Number(row.balance_xof) || 0])
    );

    const strategic =
      byCode.STRATEGIC_RESERVE_XOF || 0;

    const operational = rows
      .filter((row) => row.code !== "STRATEGIC_RESERVE_XOF")
      .reduce(
        (sum, row) => sum + (Number(row.balance_xof) || 0),
        0
      );

    return {
      byCode,
      operational,
      strategic,
      total: operational + strategic
    };
  }, {
    byCode: {},
    operational: 0,
    strategic: 0,
    total: 0
  });

  const due =
    Number(wallets.clients_due || 0) +
    Number(agents.agents_float || 0);

  const freeReserve =
    Number(reserves.operational || 0) - due;

  const alerts = [];
  const recommendations = [];

  if (linked.pending > 0) {
    alerts.push(
      `${linked.pending} compte(s) relié(s) attendent une vérification.`
    );
    recommendations.push(
      "Vérifier les comptes reliés avant d'autoriser leurs retraits."
    );
  }

  if (support.open > 0) {
    alerts.push(
      `${support.open} demande(s) client OLATOUNDE sont ouvertes.`
    );
  }

  if (support.older_than_24h > 0) {
    alerts.push(
      `${support.older_than_24h} demande(s) client dépassent 24 heures.`
    );
    recommendations.push(
      "Traiter en priorité les tickets OLATOUNDE les plus anciens."
    );
  }

  if (agents.low_float_agents > 0) {
    alerts.push(
      `${agents.low_float_agents} agent(s) OMNICASH ont une trésorerie faible.`
    );
    recommendations.push(
      "Examiner le float des agents avant les prochains retraits cash."
    );
  }

  if (due > 0 && reserves.operational < due) {
    alerts.push(
      `Couverture opérationnelle insuffisante : ${f(
        reserves.operational
      )} F détenus pour ${f(due)} F dus.`
    );
    recommendations.push(
      "Suspendre les sorties automatiques et renforcer la liquidité opérationnelle."
    );
  }

  if (activity.failed_operations > 0) {
    alerts.push(
      `${activity.failed_operations} opération(s) ont échoué ou été refusées sur 24 heures.`
    );
    recommendations.push(
      "Contrôler les opérations échouées avant toute nouvelle tentative."
    );
  }

  const level =
    due > 0 && reserves.operational < due
      ? "critical"
      : alerts.length
        ? "attention"
        : "normal";

  const greeting =
    level === "normal"
      ? "Bonjour Regis. La situation opérationnelle ne présente aucune alerte prioritaire."
      : `Bonjour Regis. J'ai identifié ${alerts.length} point(s) qui demandent ton attention.`;

  return {
    generatedAt: new Date().toISOString(),
    greeting,
    level,
    activity,
    linked,
    support,
    treasury: {
      operationalReserve: reserves.operational,
      strategicReserve: reserves.strategic,
      totalReserve: reserves.total,
      clientsDue: Number(wallets.clients_due || 0),
      agentsFloat: Number(agents.agents_float || 0),
      due,
      freeReserve,
      coverageRatio:
        due > 0 ? reserves.operational / due : null,
      accounts: reserves.byCode
    },
    alerts,
    recommendations,
    permissions: {
      readOnly: true,
      canMoveMoney: false,
      canApproveWithdrawal: false,
      canModifyReserve: false
    }
  };
}

router.get("/admin/briefing", adminOnly, async (req, res) => {
  try {
    res.json(await adminBriefing());
  } catch (e) {
    console.error("OLATOUNDE_ADMIN_BRIEFING", e.message);
    res.status(500).json({
      error: "Briefing OLATOUNDE momentanément indisponible."
    });
  }
});

router.get("/admin/tickets", adminOnly, async (req, res) => {
  try {
    await ensure();
    const rows = await sql()`SELECT t.id, t.message, t.created_at, u.phone, u.email FROM olatounde_tickets t LEFT JOIN users u ON u.id = t.user_id WHERE t.status = 'open' ORDER BY t.created_at ASC LIMIT 100`;
    res.json({ tickets: rows });
  } catch (e) { console.error("OLATOUNDE_TICKETS", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/admin/tickets/:id/close", adminOnly, async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!UUID.test(id)) return res.status(400).json({ error: "Identifiant invalide." });
    await ensure();
    const r = await sql()`UPDATE olatounde_tickets SET status = 'closed', note = ${clean(req.body && req.body.note, 300)}, closed_at = now() WHERE id = ${id}::uuid AND status = 'open' RETURNING id`;
    if (!r.length) return res.status(409).json({ error: "Ticket introuvable ou déjà clos." });
    res.json({ message: "Ticket clos." });
  } catch (e) { console.error("OLATOUNDE_CLOSE", e.message); res.status(500).json({ error: "Erreur serveur." }); }
});

router._test = { detect };
module.exports = router;
