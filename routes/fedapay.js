"use strict";
// OMNIPAY — SUIVI DES TRANSFERTS SORTANTS FEDAPAY. FICHIER AJOUTÉ. Sépare du fonds de réserve.
// FedaPay ne publie pas d'événement de webhook pour les retraits : le statut est relu chez FedaPay toutes les 60 s (filet automatique).
//   GET  /api/fedapay/admin/status   configuration (sans clé), retraits en cours
//   POST /api/fedapay/admin/run      lance un suivi tout de suite
// FEDAPAY_AUTO_REFUND=on : un retrait refusé par FedaPay est remboursé automatiquement au client. FEDAPAY_WATCH=off coupe le suivi.
const express = require("express");
const { neon } = require("@neondatabase/serverless");
const fp = require("../providers/fedapay");
const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);
const on = (k) => ["on", "true", "1", "yes"].includes(String(process.env[k] || "").toLowerCase());
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: "Accès refusé." }));

async function settle(row) {
  if (!row.payout_id) return "pending";
  let s; try { s = await fp.status(row.payout_id); } catch (e) { return "pending"; }
  if (s.status === "pending") { await sql()`UPDATE fedapay_payouts SET updated_at = now() WHERE tx_id = ${row.tx_id}::uuid`; return "pending"; }
  const q = sql();
  if (s.status === "completed") {
    await q`UPDATE fedapay_payouts SET status = 'sent', updated_at = now() WHERE tx_id = ${row.tx_id}::uuid`;
    await q`UPDATE transactions SET status = 'completed' WHERE id = ${row.tx_id}::uuid AND type = 'withdrawal' AND status = 'processing'`;
    return "completed";
  }
  await q`UPDATE fedapay_payouts SET status = 'failed', detail = ${String(s.reason || s.raw).slice(0, 150)}, updated_at = now() WHERE tx_id = ${row.tx_id}::uuid`;
  const u = await q`UPDATE transactions SET status = 'failed', metadata = coalesce(metadata,'{}'::jsonb) || ${JSON.stringify({ fedapayReason: String(s.reason || s.raw).slice(0, 60) })}::jsonb WHERE id = ${row.tx_id}::uuid AND type = 'withdrawal' AND status = 'processing' RETURNING id`;
  if (u.length && on("FEDAPAY_AUTO_REFUND")) { try { await require("./walletOps").refundOne(row.tx_id, true, "Mobile Money : transfert échoué (remboursement automatique)"); } catch (e) { console.error("FEDAPAY_AUTOREFUND", e.message); } }
  return "failed";
}
async function tick() {
  const out = { checked: 0, completed: 0, failed: 0 }; if (!fp.ready()) return out;
  await fp.ensure();
  const rows = await sql()`SELECT tx_id, payout_id FROM fedapay_payouts WHERE status IN ('created','started') AND payout_id IS NOT NULL AND created_at > now() - interval '5 days' ORDER BY created_at LIMIT 40`;
  for (const r of rows) { out.checked++; try { const s = await settle(r); if (s === "completed") out.completed++; if (s === "failed") out.failed++; } catch (e) { console.error("FEDAPAY_TICK", e.message); } }
  return out;
}
router.get("/admin/status", adminOnly, async (req, res) => {
  try {
    await fp.ensure(); const [c] = await sql()`SELECT count(*) FILTER (WHERE status IN ('created','started'))::int AS en_cours, count(*) FILTER (WHERE status = 'unknown')::int AS incertains, count(*) FILTER (WHERE status = 'sent')::int AS reussis, count(*) FILTER (WHERE status = 'failed')::int AS echoues FROM fedapay_payouts`;
    res.json({ configured: fp.ready(), env: fp.env(), autoRefund: on("FEDAPAY_AUTO_REFUND"), capXof: fp.cap(), payouts: c, note: "Séparé du fonds de réserve. Active avec PAYOUT_ROUTE_<OPÉRATEUR>=fedapay." });
  } catch (e) { console.error("FEDAPAY_ADM", e.message); res.status(500).json({ error: "Erreur." }); }
});
router.post("/admin/run", adminOnly, async (req, res) => { try { res.json({ ok: true, ...(await tick()) }); } catch (e) { console.error("FEDAPAY_RUN", e.message); res.status(500).json({ error: "Erreur." }); } });
let timer = null;
function start() { if (timer || !fp.ready() || String(process.env.FEDAPAY_WATCH || "on").toLowerCase() === "off" || !process.env.DATABASE_URL) return; timer = setInterval(() => { tick().catch((e) => console.error("FEDAPAY_WATCH", e.message)); }, 60000); if (timer.unref) timer.unref(); console.log("[FEDAPAY] suivi des retraits actif (toutes les 60 s)"); }
start();
module.exports = router; module.exports._tick = tick;
