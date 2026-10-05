const express = require("express");
const {
  requestEmailOtp,
  verifyEmailOtp,
} = require("../controllers/emailOtpController");

const router = express.Router();

router.post("/request", requestEmailOtp);
router.post("/verify", verifyEmailOtp);

module.exports = router;
