const express = require('express');
const router = express.Router();

const { register, login, me } = require('../controllers/auth');
const { protect } = require('../middleware/auth');

// Inscription
router.post('/register', register);

// Connexion
router.post('/login', login);

// Profil utilisateur (protégé)
router.get('/me', protect, me);

module.exports = router;
