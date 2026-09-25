const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Page web (public/index.html)
app.use(express.static('public'));

// Routes API
const authRoutes = require('./routes/auth');
app.use('/auth', authRoutes);

const walletRoutes = require('./routes/wallet');
app.use('/wallet', walletRoutes);

// Render impose son propre port
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`OMNIPAY backend running on port ${PORT}`);
});

const binanceRoutes = require('./routes/binance');
app.use('/api', binanceRoutes);
