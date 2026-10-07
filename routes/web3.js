const express = require("express");
const { requireAuth } = require("../authMiddleware.js");

const {
  createWalletChallenge,
} = require("../controllers/web3Controller.js");

const router = express.Router();

router.post(
  "/challenge",
  requireAuth,
  createWalletChallenge
);

module.exports = router;
``
