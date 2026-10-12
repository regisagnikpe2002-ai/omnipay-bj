"use strict";

const express = require("express");
const { requireAuth } = require("../../authMiddleware");
const { requireGatewayAccess } = require("./authGuard");

const router = express.Router();

router.get(
  "/status",
  requireAuth,
  requireGatewayAccess,
  async (req, res) => {
    return res.json({
      success: true,
      authenticated: true,
      gateway: "enabled",
      user: {
        id: req.user?.id,
        email: req.user?.email,
        kycStatus: req.user?.kycStatus
      }
    });
  }
);

module.exports = router;
