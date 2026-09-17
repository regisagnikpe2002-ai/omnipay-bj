const express = require("express");
const router = express.Router();
const { requireAuth } = require("../authMiddleware.js");
const {
  getMyWallet,
  getMyTransactions,
  transfer,
  initiateDeposit,
  depositCallback,
} = require("../walletController.js");

router.get("/me", requireAuth, getMyWallet);
router.get("/transactions", requireAuth, getMyTransactions);
router.post("/transfer", requireAuth, transfer);
router.post("/deposit", requireAuth, initiateDeposit);
router.post("/deposit/callback", depositCallback);

module.exports = router;