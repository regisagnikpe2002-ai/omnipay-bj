const express = require('express');
const router = express.Router();
const { login } = require('../controllers/authController');

router.post('/login', login);

module.exports = router;
const express = require('express');
const router = express.Router();

const { register, login, me } = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

router.post('/register', register);
router.post('/login', login);
router.get('/me', protect, me);

module.exports = router;
const express = require('express');
const router = express.Router();

const { register, login, me } = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

router.post('/register', register);
router.post('/login', login);
router.get('/me', protect, me);

module.exports = router;

