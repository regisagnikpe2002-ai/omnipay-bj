"use strict";

const express = require("express");
const sms = require("../providers/virtualNumbers/smscodes");
const store = require("../services/virtualNumberStore");

const router = express.Router();

function clean(v, n = 160) {
  return String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);
}
function currentUserId(req) {
  return clean(req.user?.userId || req.user?.id || "", 80);
}
function requireUser(req, res, next) {
  if (!currentUserId(req)) return res.status(401).json({ error: "Authentification requise." });
  next();
}
function errorResponse(res, e) {
  console.error("VIRTUAL_NUMBERS", e?.message || e);
  const m = String(e?.message || "Erreur fournisseur.");
  return res.status(/requis|invalide/i.test(m) ? 400 : 502).json({ error: m });
}
function customerPrice() {
  const n = Math.round(Number(process.env.VIRTUAL_NUMBER_PRICE_XOF || 500));
  return Number.isSafeInteger(n) && n > 0 ? n : 500;
}

router.get("/status", (req, res) => {
  res.json({ provider: "smscodes", configured: sms.ready(), enabled: true, priceXof: customerPrice(), purchasesEnabled: false });
});

router.get("/countries", async (req, res) => {
  try { res.json(await sms.getRentalCountries()); }
  catch (e) { errorResponse(res, e); }
});

router.get("/services", async (req, res) => {
  try {
    const iso = clean(req.query.iso, 3).toUpperCase();
    const search = clean(req.query.search, 100);
    if (search) return res.json(await sms.searchServiceCodeLogos(search));
    if (iso) return res.json(await sms.getCountryServiceCodeLogos({ iso, page: Number(req.query.page || 1), pageSize: Number(req.query.pageSize || 20) }));
    return res.json(await sms.getServiceCodeLogos({ page: Number(req.query.page || 1), pageSize: Number(req.query.pageSize || 20) }));
  } catch (e) { errorResponse(res, e); }
});

router.post("/orders/preview", requireUser, async (req, res) => {
  try {
    const iso = clean(req.body?.iso, 3).toUpperCase();
    const serviceId = clean(req.body?.serviceId, 120);
    const serviceName = clean(req.body?.serviceName, 160);
    if (!iso || !serviceId) return res.status(400).json({ error: "Pays et service requis." });
    const order = await store.createPreview({
      userId: currentUserId(req), countryIso: iso, serviceId, serviceName,
      customerPrice: customerPrice(), currency: "XOF"
    });
    res.status(201).json({ order, purchaseExecuted: false });
  } catch (e) { errorResponse(res, e); }
});

router.get("/orders", requireUser, async (req, res) => {
  try { res.json({ orders: await store.listForUser(currentUserId(req)) }); }
  catch (e) { errorResponse(res, e); }
});

router.get("/orders/:id", requireUser, async (req, res) => {
  try {
    const order = await store.getForUser(currentUserId(req), req.params.id);
    if (!order) return res.status(404).json({ error: "Commande introuvable." });
    const safe = { ...order };
    delete safe.security_id;
    res.json(safe);
  } catch (e) { errorResponse(res, e); }
});

// Garde-fou: pas d'achat fournisseur tant que la reservation Secure Ledger
// n'est pas branchee atomiquement autour de RentNumber.
router.post("/orders/:id/purchase", requireUser, async (req, res) => {
  res.status(503).json({
    error: "Achat reel verrouille jusqu'au branchement Secure Ledger.",
    flow: ["reserve", "rentNumber", "settle_or_release"]
  });
});

module.exports = router;
