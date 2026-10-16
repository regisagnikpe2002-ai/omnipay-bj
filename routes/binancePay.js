const express = require("express");
const router = express.Router();
const { requireAuth } = require("../authMiddleware.js");
const {
  createBinancePayOrder,
  binancePayWebhook,
} = require("../controllers/binancePayController.js");

router.post("/order", requireAuth, createBinancePayOrder);
router.post("/webhook", binancePayWebhook);
module.exports = router;
