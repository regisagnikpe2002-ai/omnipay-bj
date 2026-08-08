const express = require('express');
const router = express.Router();

// Import correct des controllers et middleware
const { register, login, me } = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

// Routes d'authentification
router.post('/register', register);
router.post('/login', login);

// Route protégée
router.get('/me', protect, me);

module.exports = router;
