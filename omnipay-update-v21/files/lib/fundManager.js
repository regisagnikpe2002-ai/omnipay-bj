"use strict";
// OMNIPAY — GESTIONNAIRE DE FONDS & RISQUE (admin). Il ne déplace JAMAIS d'argent : il mesure, avertit, recommande une voie et propose des rééquilibrages que vous exécutez.
//  1) Santé : couverture (fonds réels déclarés ÷ dû aux clients + agents), concentration par canal, exposition crypto, soldes périmés, jours de réserve par canal.
//  2) Voie : pour un retrait (MTN / Moov / Celtiis / PI-SPI / crypto), compare les canaux capables de payer (liquidité, coût, vitesse, taux de réussite, jours de réserve restants) et explique son choix.
//  3) Rééquilibrage : compare chaque canal à sa cible (jours de retraits à couvrir) et propose des virements entre canaux, du plus excédentaire vers le plus déficitaire.
// Les calculs (assess / chooseRoute / rebalance) sont des fonctions PURES, testables sans base de données. loadState() lit la base en lecture seule.
const DEFAULT_POLICY = Object.freeze({
  floorRatio: 1.0,          // couverture minimale : en dessous, aucun envoi automatique (blocage « dur »)
  bufferRatio: 1.1,         // couverture cible recommandée
  maxChannelShare: 0.6,     // un canal ne devrait pas porter plus de 60 % des fonds
  maxCryptoShare: 0.35,     // exposition aux cryptos (hot + cold) : au plus 35 % des fonds
  staleHours: 24,           // un solde déclaré depuis plus longtemps est jugé périmé
  daysCover: 3,             // jours de retraits à garder dans chaque canal de sortie
  minChannelReserveXof: 20000, // plancher de sécurité par canal de sortie
  primaryFirst: 1,          // 1 = PI-SPI / banque en voie PRINCIPALE, floats Mobile Money (SIM marchands) en SECOURS ; 0 = l'inverse (float dédié d'abord)
});
const RANGES = { floorRatio: [0.8, 3], bufferRatio: [1, 3], maxChannelShare: [0.2, 1], maxCryptoShare: [0, 1], staleHours: [1, 168], daysCover: [0.5, 30], minChannelReserveXof: [0, 100000000], primaryFirst: [0, 1] };
const OPERATORS = ["mtn", "moov", "celtiis"];

function cleanPolicy(input) {
  const p = { ...DEFAULT_POLICY };
  for (const k of Object.keys(RANGES)) {
    if (input && input[k] != null && input[k] !== "") {
      const v = Number(input[k]);
      if (!Number.isFinite(v) || v < RANGES[k][0] || v > RANGES[k][1]) throw new Error(`Paramètre « ${k} » hors limites (${RANGES[k][0]} à ${RANGES[k][1]}).`);
      p[k] = v;
    }
  }
  if (p.bufferRatio < p.floorRatio) throw new Error("bufferRatio doit être ≥ floorRatio.");
  return p;
}

// Profil d'un compte de fonds (déduit du type et du nom) : ce qu'il peut payer, à quel coût, à quelle vitesse.
function profileFor(f) {
  const s = `${f.code || ""} ${f.label || ""}`.toUpperCase();
  const kind = String(f.kind || "").toLowerCase();
  const pays = [];
  let speedMin = 30, feeBps = 0, success = 0.97, crypto = false, role = "reserve", backup = false;
  if (kind === "momo") {
    for (const op of OPERATORS) if (s.includes(op.toUpperCase())) pays.push("mobile:" + op);
    speedMin = 2; role = "sortie"; backup = true;
  } else if (kind === "bank" || /PISPI|PI-SPI|ECOBANK/.test(s)) {
    pays.push("pispi", "bank", ...OPERATORS.map((o) => "mobile:" + o));
    speedMin = 10; role = "sortie";
  } else if (kind === "hot") {
    pays.push("crypto"); crypto = true; speedMin = 15; feeBps = 10; role = "sortie";
  } else if (kind === "cold") { crypto = true; role = "reserve"; }
  else if (kind === "psp") { role = "tiers"; } // fonds chez un prestataire : comptés dans les fonds, jamais utilisés pour payer
  return { pays, speedMin, feeBps, success, crypto, role, backup };
}

const destOf = (operator) => {
  const o = String(operator || "").toLowerCase();
  if (OPERATORS.includes(o)) return "mobile:" + o;
  if (o === "pispi") return "pispi";
  if (o === "bank" || o === "virement") return "bank";
  if (["usdt", "usdc", "crypto", "btc", "eth"].includes(o)) return "crypto";
  return o;
};

// state = { funds:[{code,label,kind,balance,declaredAt}], due, out7:{mtn,moov,celtiis,pispi,crypto,bank}, success:{mtn:0.98,…}, now }
function enrich(state, policy) {
  const now = state.now ? new Date(state.now).getTime() : Date.now();
  const channels = state.funds.map((f) => {
    const p = profileFor(f);
    const age = f.declaredAt ? (now - new Date(f.declaredAt).getTime()) / 36e5 : null;
    return { code: f.code, label: f.label || f.code, kind: f.kind, balance: f.balance == null ? null : Number(f.balance), declaredAt: f.declaredAt || null,
      ageHours: age, stale: f.balance == null ? false : age == null || age > policy.staleHours, ...p };
  });
  // demande quotidienne par canal : la demande de chaque destination est partagée entre les canaux capables de la payer
  for (const c of channels) c.dailyOut = 0;
  const dests = new Set([...OPERATORS.map((o) => "mobile:" + o), "pispi", "bank", "crypto"]);
  for (const d of dests) {
    const key = d.startsWith("mobile:") ? d.slice(7) : d;
    const demand = Number((state.out7 || {})[key] || 0) / 7;
    const capable = channels.filter((c) => c.pays.includes(d));
    if (demand > 0 && capable.length) for (const c of capable) c.dailyOut += demand / capable.length;
  }
  const held = channels.reduce((s, c) => s + (c.balance || 0), 0);
  for (const c of channels) {
    c.share = held > 0 && c.balance != null ? c.balance / held : null;
    c.daysCover = c.balance == null ? null : c.dailyOut > 0 ? c.balance / c.dailyOut : null; // null = pas de retrait récent à couvrir
    c.target = c.role === "sortie" ? Math.max(policy.minChannelReserveXof, Math.ceil(policy.daysCover * c.dailyOut)) : 0;
  }
  return { channels, held, due: Number(state.due || 0) };
}

function assess(state, policy = DEFAULT_POLICY) {
  const { channels, held, due } = enrich(state, policy);
  const flags = [];
  const add = (level, code, text) => flags.push({ level, code, text });
  const declared = channels.filter((c) => c.balance != null);
  const ratio = due > 0 ? held / due : null;
  let score = 100;
  if (!declared.length) { add("crit", "NO_FUNDS_DECLARED", "Aucun solde réel déclaré : la couverture ne peut pas être vérifiée."); score -= 40; }
  else if (ratio != null && ratio < policy.floorRatio) { add("crit", "COVERAGE_BELOW_FLOOR", `Couverture ${(ratio * 100).toFixed(0)} % : en dessous du plancher ${(policy.floorRatio * 100).toFixed(0)} %. Envois automatiques à suspendre.`); score -= 40; }
  else if (ratio != null && ratio < policy.bufferRatio) { add("warn", "COVERAGE_LOW_BUFFER", `Couverture ${(ratio * 100).toFixed(0)} % : sous la cible ${(policy.bufferRatio * 100).toFixed(0)} %.`); score -= 15; }
  for (const c of channels) {
    if (c.share != null && c.share > policy.maxChannelShare && declared.length > 1) { add("warn", "CONCENTRATION", `${c.label} porte ${(c.share * 100).toFixed(0)} % des fonds (limite ${(policy.maxChannelShare * 100).toFixed(0)} %).`); score -= 10; }
    if (c.stale) { add("warn", "STALE_BALANCE", `Solde de ${c.label} déclaré il y a ${Math.round(c.ageHours)} h : à actualiser.`); score -= 5; }
    if (c.role === "sortie" && c.balance != null && c.balance < c.target) { add("warn", "BELOW_TARGET", `${c.label} : ${Math.round(c.balance)} F pour une cible de ${c.target} F (${c.daysCover == null ? "—" : c.daysCover.toFixed(1)} jours de retraits).`); score -= 5; }
    if (c.role === "sortie" && c.balance == null) add("info", "NOT_DECLARED", `${c.label} : solde non déclaré.`);
    if (c.role === "tiers" && c.balance > 0) { add("info", "THIRD_PARTY", `${Math.round(c.balance)} F détenus chez un prestataire (${c.label}) : comptés dans les fonds mais non utilisables pour payer.`); }
  }
  const crypto = channels.filter((c) => c.crypto).reduce((s, c) => s + (c.balance || 0), 0);
  const cryptoShare = held > 0 ? crypto / held : 0;
  if (cryptoShare > policy.maxCryptoShare) { add("warn", "CRYPTO_EXPOSURE", `Exposition crypto ${(cryptoShare * 100).toFixed(0)} % des fonds (limite ${(policy.maxCryptoShare * 100).toFixed(0)} %) : risque de variation de prix.`); score -= 10; }
  for (const op of OPERATORS) {
    if (Number((state.out7 || {})[op] || 0) > 0 && !channels.some((c) => c.pays.includes("mobile:" + op) && (c.balance || 0) > 0)) { add("crit", "NO_LIQUIDITY_" + op.toUpperCase(), `Retraits ${op.toUpperCase()} demandés mais aucun canal de sortie approvisionné.`); score -= 10; }
  }
  const order = { crit: 0, warn: 1, info: 2 };
  flags.sort((a, b) => order[a.level] - order[b.level]);
  return { score: Math.max(0, score), status: flags.some((f) => f.level === "crit") ? "CRITIQUE" : flags.some((f) => f.level === "warn") ? "ATTENTION" : "OK",
    coverage: { due, held, ratio }, cryptoShare, channels: channels.map(pubChannel), flags };
}
const pubChannel = (c) => ({ code: c.code, label: c.label, kind: c.kind, role: c.role, balance: c.balance, share: c.share, dailyOut: Math.round(c.dailyOut), daysCover: c.daysCover, target: c.target, stale: c.stale, ageHours: c.ageHours == null ? null : Math.round(c.ageHours), pays: c.pays });

function chooseRoute(state, { operator, amount }, policy = DEFAULT_POLICY) {
  const amt = Math.floor(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, hard: false, reasons: ["Montant invalide."], alternatives: [] };
  const dest = destOf(operator);
  const { channels, held, due } = enrich(state, policy);
  const capable = channels.filter((c) => c.pays.includes(dest));
  const reasonsAll = [];
  const hardBreach = held > 0 && due > 0 && (held - amt) / due < policy.floorRatio;
  if (hardBreach) reasonsAll.push(`Après ce paiement la couverture passerait à ${(((held - amt) / due) * 100).toFixed(0)} % (plancher ${(policy.floorRatio * 100).toFixed(0)} %).`);
  const scored = capable.map((c) => {
    const why = [];
    if (c.balance == null) why.push("solde non déclaré");
    else if (c.balance < amt) why.push(`solde insuffisant (${Math.round(c.balance)} F)`);
    else if (c.balance - amt < policy.minChannelReserveXof) why.push(`laisserait moins que la réserve minimale (${policy.minChannelReserveXof} F)`);
    if (c.stale) why.push("solde périmé (à actualiser)");
    const left = c.balance == null ? 0 : c.balance - amt;
    const headroom = c.dailyOut > 0 ? Math.min(10, left / c.dailyOut) : 10;
    // Priorité des voies. primaryFirst=1 (défaut) : PI-SPI / banque = voie principale (+20), floats Mobile Money = secours (-10) ; le secours ne passe que si le principal est impossible.
    // primaryFirst=0 : un canal dédié (float d'un opérateur, hot wallet) passe avant le compte bancaire général.
    const dedicated = policy.primaryFirst >= 1 ? (c.backup ? -10 : c.pays.length > 2 ? 20 : 0) : (c.pays.length <= 2 ? 8 : 0);
    const score = Math.round(50 + c.success * 20 - c.feeBps * 0.1 - c.speedMin * 0.3 + headroom + dedicated - (c.stale ? 15 : 0));
    return { code: c.code, label: c.label, backup: c.backup, score, feasible: why.length === 0, reasons: why, speedMin: c.speedMin, feeBps: c.feeBps, balanceAfter: c.balance == null ? null : left };
  }).sort((a, b) => Number(b.feasible) - Number(a.feasible) || b.score - a.score);
  const best = scored.find((s) => s.feasible);
  if (hardBreach) return { ok: false, hard: true, dest, choice: null, reasons: reasonsAll, alternatives: scored };
  if (!capable.length) return { ok: false, hard: false, dest, choice: null, reasons: ["Aucun canal déclaré ne sait payer cette destination : traitement manuel."], alternatives: [] };
  if (!best) {
    const short = capable.some((c) => c.balance != null && c.balance - amt < policy.minChannelReserveXof);
    return { ok: false, hard: false, dest, choice: null, reasons: [short ? "Aucun canal n'a assez de liquidité : rééquilibrer d'abord (voir le plan)." : "Aucun canal utilisable automatiquement (soldes à déclarer ou à actualiser)."], alternatives: scored };
  }
  return { ok: true, hard: false, dest, choice: best, reasons: [], alternatives: scored.filter((s) => s !== best) };
}

function rebalance(state, policy = DEFAULT_POLICY) {
  const { channels, held } = enrich(state, policy);
  const exits = channels.filter((c) => c.role === "sortie" && c.balance != null);
  const need = exits.filter((c) => c.balance < c.target).map((c) => ({ c, gap: c.target - c.balance })).sort((a, b) => b.gap - a.gap);
  // excédent : au-dessus de la cible (+ marge) pour un canal de sortie ; tout le solde au-delà de la limite de concentration pour les autres
  const give = channels.filter((c) => c.balance != null && c.role !== "tiers").map((c) => {
    const keep = c.role === "sortie" ? Math.max(c.target * 1.5, policy.minChannelReserveXof) : 0;
    const cap = held > 0 ? policy.maxChannelShare * held : Infinity;
    const surplus = c.role === "sortie" ? c.balance - keep : Math.max(0, c.balance - cap);
    return { c, left: Math.floor(Math.max(0, surplus)) };
  }).filter((g) => g.left > 0).sort((a, b) => b.left - a.left);
  const moves = [];
  for (const n of need) {
    let gap = Math.ceil(n.gap);
    for (const g of give) {
      if (gap <= 0) break;
      if (g.c.code === n.c.code || g.left <= 0) continue;
      const amt = Math.min(gap, g.left);
      const crypto = g.c.crypto || n.c.crypto;
      moves.push({ from: g.c.code, fromLabel: g.c.label, to: n.c.code, toLabel: n.c.label, amountXof: amt,
        how: crypto ? "Conversion via Binance P2P ou échange (frais et écart de prix à prévoir)." : g.c.kind === "bank" || n.c.kind === "bank" ? "Virement PI-SPI / bancaire." : "Transfert via votre compte PI-SPI (aucun accès direct entre opérateurs).",
        estFeeBps: crypto ? 50 : 0 });
      g.left -= amt; gap -= amt;
    }
    if (gap > 0) moves.push({ to: n.c.code, toLabel: n.c.label, shortfallXof: gap, note: "Aucun excédent disponible : il faut encaisser de nouveaux dépôts ou injecter des fonds." });
  }
  return { moves, note: "Plan indicatif : rien n'est exécuté automatiquement. Après chaque virement, redéclarez les soldes." };
}

async function loadState() {
  const { neon } = require("@neondatabase/serverless");
  const q = neon(process.env.DATABASE_URL);
  let funds = [];
  try {
    funds = (await q`SELECT f.code, f.label, f.kind, b.balance_xof::float AS balance, b.declared_at AS "declaredAt"
      FROM fund_accounts f LEFT JOIN LATERAL (SELECT balance_xof, declared_at FROM fund_balances WHERE code = f.code ORDER BY id DESC LIMIT 1) b ON true WHERE f.active ORDER BY f.code`);
  } catch (_) { funds = []; }
  const [w] = await q`SELECT coalesce(sum(balance), 0)::float AS v FROM wallets`;
  let agents = 0; try { agents = (await q`SELECT coalesce(sum(float_xof), 0)::float AS v FROM omnicash_agents`)[0].v; } catch (_) {}
  const out7 = {}, success = {};
  try {
    const r = await q`SELECT provider AS op, coalesce(sum(CASE WHEN status = 'completed' AND created_at > now() - interval '7 days' THEN amount END), 0)::float AS out7,
        count(*) FILTER (WHERE status = 'completed')::int AS ok, count(*) FILTER (WHERE status = 'failed')::int AS ko
      FROM transactions WHERE type = 'withdrawal' AND created_at > now() - interval '14 days' GROUP BY provider`;
    for (const x of r) { out7[String(x.op || "").toLowerCase()] = x.out7; if (x.ok + x.ko >= 5) success[String(x.op).toLowerCase()] = x.ok / (x.ok + x.ko); }
  } catch (_) {}
  return { funds, due: w.v + agents, out7, success, now: new Date().toISOString() };
}

let policyReady = null;
async function getPolicy() {
  const { neon } = require("@neondatabase/serverless");
  const q = neon(process.env.DATABASE_URL);
  try {
    if (!policyReady) policyReady = q`CREATE TABLE IF NOT EXISTS fund_policy (key varchar(40) PRIMARY KEY, value numeric NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`.catch((e) => { policyReady = null; throw e; });
    await policyReady;
    const rows = await q`SELECT key, value::float AS value FROM fund_policy`;
    return cleanPolicy(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  } catch (_) { return { ...DEFAULT_POLICY }; }
}
async function setPolicy(patch) {
  const { neon } = require("@neondatabase/serverless");
  const q = neon(process.env.DATABASE_URL);
  const next = cleanPolicy({ ...(await getPolicy()), ...patch });
  await getPolicy();
  for (const k of Object.keys(RANGES)) if (patch && patch[k] != null && patch[k] !== "") await q`INSERT INTO fund_policy (key, value) VALUES (${k}, ${next[k]}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  return next;
}

// Contrôle appelé avant l'envoi d'un retrait (voir walletOps : FUND_ROUTER=advise | guard). Ne bloque (« hard ») que si des fonds réels sont déclarés ET que la couverture passerait sous le plancher.
async function checkPayout({ operator, amount }) {
  const [state, policy] = [await loadState(), await getPolicy()];
  return chooseRoute(state, { operator, amount }, policy);
}

module.exports = { DEFAULT_POLICY, cleanPolicy, profileFor, destOf, enrich, assess, chooseRoute, rebalance, loadState, getPolicy, setPolicy, checkPayout };
