const express = require("express");
const router = express.Router();
const { register, login, resetPassword } = require("../authController.js");

router.post("/register", register);
router.post("/login", login);
router.post("/reset-password", resetPassword);

module.exports = router;