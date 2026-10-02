const express = require('express');
const cors = require('cors');
const path = require('path');

require('dotenv').config();

const app = express();

// =========================
// Middlewares
// =========================

app.use(cors());

app.use(express.json());

app.use(express.urlencoded({
  extended: true
}));

// =========================
// Fichiers statiques
// =========================

app.use(express.static(path.join(__dirname, 'public')));

// =========================
// Dashboard
// =========================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// =========================
// Routes Auth
// =========================

try {
  const authRoutes = require('./routes/auth');
  app.use('/auth', authRoutes);
} catch (err) {
  console.log('Auth routes non chargées');
}

// =========================
// Routes Wallet
// =========================

try {
  const walletRoutes = require('./routes/wallet');
  app.use('/wallet', walletRoutes);
} catch (err) {
  console.log('Wallet routes non chargées');
}

// =========================
// Routes Binance
// =========================

try {
  const binanceRoutes = require('./routes/binance');
  app.use('/api', binanceRoutes);
} catch (err) {
  console.log('Binance routes non chargées');
}

// =========================
// Test API
// =========================

app.get('/api/status', (req, res) => {

  res.json({
    success: true,
    application: 'OMNIPAY',
    status: 'ONLINE',
    message: 'Votre quotidien financier tout-en-un'
  });

});

// =========================
// Gestion erreurs
// =========================

app.use((req, res) => {

  res.status(404).json({
    success: false,
    message: 'Route introuvable'
  });

});

// =========================
// Port
// =========================

const PORT = process.env.PORT || 3000;
console.log("PAYDUNYA_MASTER_KEY:", !!process.env.PAYDUNYA_MASTER_KEY);
console.log("PAYDUNYA_PRIVATE_KEY:", !!process.env.PAYDUNYA_PRIVATE_KEY);
console.log("PAYDUNYA_TOKEN:", !!process.env.PAYDUNYA_TOKEN);
console.log("ADMIN_KEY:", !!process.env.ADMIN_KEY);

app.listen(PORT, () => {

  console.log('');
  console.log('================================');
  console.log('OMNIPAY BACKEND DEMARRE');
  console.log(`PORT : ${PORT}`);
  console.log('================================');
  console.log('');

});