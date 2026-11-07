"use strict";

// OMNIPAY - Numéros virtuels via SMSCodes.io
// Version de consolidation : provider unique + garde-fous + probe admin.
// Aucun secret fournisseur n'est envoyé au navigateur.
// L'achat réel reste verrouillé jusqu'au raccordement atomique au Secure Ledger.

const express = require("express");
const sms = require("../providers/virtualNumbers/smscodes");
const store = require("../services/virtualNumberStore");

let requireAuth = (req, res, next) => next();
try {
  ({ requireAuth } = require("../authMiddleware"));
} catch (_) {
  // Le serveur peut injecter req.user autrement. Les routes client reverifient l'identite.
}

const router = express.Router();
const MAX_PAGE_SIZE = 50;
const MAX_DAY = 20;
const MAX_OPEN = 3;

const clean = (v, n = 160) => String(v == null ? "" : v).replace(/[<>]/g, "").trim().slice(0, n);
const enabled = () => String(process.env.VN_ENABLED || "on").toLowerCase() !== "off";
const price = () => {
  const raw = process.env.VIRTUAL_NUMBER_PRICE_XOF ?? process.env.VN_PRICE_XOF ?? 500;
  const n = Math.round(Number(raw));
  return Number.isSafeInteger(n) && n >= 100 ? n : 500;
};
const blockList = () => String(process.env.VN_BLOCK || "")
  .toLowerCase().split(",").map(s => s.trim()).filter(Boolean);

function userId(req) {
  return clean(req.user?.userId || req.user?.id || "", 80);
}
function requireUser(req, res, next) {
  if (!userId(req)) return res.status(401).json({ error: "Authentification requise." });
  next();
}
function adminOnly(req, res, next) {
  const expected = String(process.env.ADMIN_KEY || "");
  const received = String(req.get("x-admin-key") || "");
  if (!expected || received !== expected) return res.status(403).json({ error: "Accès refusé." });
  next();
}
function safeError(res, err) {
  console.error("VIRTUAL_NUMBERS", err?.message || err);
  const message = String(err?.message || "Erreur fournisseur.");
  const code = /requis|invalide|trop courte|indisponible/i.test(message) ? 400 : 502;
  res.status(code).json({ error: message });
}
function validateService(serviceId, serviceName = "") {
  const haystack = `${serviceId} ${serviceName}`.toLowerCase();
  const blocked = blockList().find(term => term && haystack.includes(term));
  if (blocked) throw new Error("Service indisponible sur OMNIPAY.");
}

router.get("/status", (req, res) => {
  res.json({
    configured: sms.ready(),
    enabled: enabled(),
    price: price(),
    provider: "smscodes",
    purchasesEnabled: false
  });
});

router.get("/countries", async (req, res) => {
  if (!enabled()) return res.status(503).json({ error: "Service temporairement désactivé." });
  try { res.json(await sms.getRentalCountries()); }
  catch (err) { safeError(res, err); }
});

router.get("/services", async (req, res) => {
  if (!enabled()) return res.status(503).json({ error: "Service temporairement désactivé." });
  try {
    const iso = clean(req.query.iso, 3).toUpperCase();
    const search = clean(req.query.search, 100);
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.pageSize || 20)));

    if (search) return res.json(await sms.searchServiceCodeLogos(search));
    if (iso) return res.json(await sms.getCountryServiceCodeLogos({ iso, page, pageSize }));
    return res.json(await sms.getServiceCodeLogos({ page, pageSize }));
  } catch (err) { safeError(res, err); }
});

router.post("/orders/preview", requireAuth, requireUser, async (req, res) => {
  if (!enabled()) return res.status(503).json({ error: "Service temporairement désactivé." });
  try {
    const iso = clean(req.body?.iso, 3).toUpperCase();
    const serviceId = clean(req.body?.serviceId, 120);
    const serviceName = clean(req.body?.serviceName, 160);
    if (!iso || !serviceId) return res.status(400).json({ error: "Pays et service requis." });
    validateService(serviceId, serviceName);

    const existing = await store.listForUser(userId(req));
    const open = existing.filter(o => ["pending", "ordering", "active"].includes(String(o.status))).length;
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const today = existing.filter(o => new Date(o.created_at).getTime() >= since).length;
    if (open >= MAX_OPEN) return res.status(429).json({ error: "Trop de commandes ouvertes." });
    if (today >= MAX_DAY) return res.status(429).json({ error: "Limite quotidienne atteinte." });

    const order = await store.createPreview({
      userId: userId(req),
      countryIso: iso,
      serviceId,
      serviceName,
      customerPrice: price(),
      currency: "XOF"
    });
    res.status(201).json({ order, purchaseExecuted: false });
  } catch (err) { safeError(res, err); }
});

router.get("/orders", requireAuth, requireUser, async (req, res) => {
  try { res.json({ orders: await store.listForUser(userId(req)) }); }
  catch (err) { safeError(res, err); }
});

router.get("/orders/:id", requireAuth, requireUser, async (req, res) => {
  try {
    const order = await store.getForUser(userId(req), req.params.id);
    if (!order) return res.status(404).json({ error: "Commande introuvable." });
    const safe = { ...order };
    delete safe.security_id;
    res.json(safe);
  } catch (err) { safeError(res, err); }
});

// Lecture des SMS uniquement pour une commande active appartenant au client.
router.get("/orders/:id/messages", requireAuth, requireUser, async (req, res) => {
  try {
    const order = await store.getForUser(userId(req), req.params.id);
    if (!order) return res.status(404).json({ error: "Commande introuvable." });
    if (order.status !== "active" || !order.number || !order.security_id) {
      return res.status(409).json({ error: "Numéro pas encore prêt à recevoir des SMS." });
    }
    const amount = Math.min(50, Math.max(1, Number(req.query.amount || 10)));
    res.json(await sms.getRentedSms({ sid: order.security_id, number: order.number, amount }));
  } catch (err) { safeError(res, err); }
});

// Garde-fou financier : activé seulement après connexion au Secure Ledger.
router.post("/orders/:id/purchase", requireAuth, requireUser, async (req, res) => {
  res.status(503).json({
    error: "Achat réel verrouillé jusqu'au raccordement Secure Ledger.",
    flow: ["reserve", "rentNumber", "complete_or_release"]
  });
});

router.get("/admin/probe", adminOnly, async (req, res) => {
  const probe = {};
  async function inspect(name, fn) {
    try {
      const result = await fn();
      probe[name] = {
        ok: true,
        status: result?.Status ?? result?.status ?? null,
        error: result?.Error ?? result?.error ?? null
      };
    } catch (err) {
      probe[name] = { ok: false, error: err?.message || "probe_failed" };
    }
  }

  if (sms.ready()) {
    await Promise.all([
      inspect("GetRentalCountries", () => sms.getRentalCountries()),
      inspect("GetServiceCodes", () => sms.getServiceCodes()),
      inspect("GetLiveRentedNumbers", () => sms.getLiveRentedNumbers())
    ]);
  } else {
    probe.GetRentalCountries = { ok: false, error: "not_configured" };
    probe.GetServiceCodes = { ok: false, error: "not_configured" };
    probe.GetLiveRentedNumbers = { ok: false, error: "not_configured" };
  }

  res.json({ configured: sms.ready(), enabled: enabled(), price: price(), probe });
});

module.exports = router;
