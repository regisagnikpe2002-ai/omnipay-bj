"use strict";
// OMNIPAY — État des clés API (administrateur seulement). Ne renvoie JAMAIS une valeur : seulement présent / absent.
const express = require("express");
const { status } = require("../lib/apiKeys");

const router = express.Router();
const isAdmin = (req) => { const k = req.headers["x-admin-key"]; return Boolean(k && process.env.ADMIN_KEY && k === process.env.ADMIN_KEY); };

router.get("/status", (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Accès refusé." });
  res.json({ grouped: Boolean(process.env.OMNIPAY_API_KEYS), providers: status() });
});

module.exports = router;
