"use strict";
// OMNIPAY — catalogue public des services et des fournisseurs reliables (lecture seule, aucune donnée sensible).
const express = require("express");
const catalog = require("../services/serviceCatalog.js");
const registry = require("../services/accountLinkRegistry.js");
const router = express.Router();
router.get("/", (req, res) => res.json({ services: catalog.publicCatalog() }));
router.get("/providers", (req, res) => res.json({ providers: registry.publicProviders() }));
module.exports = router;
