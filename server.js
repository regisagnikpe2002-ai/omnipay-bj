const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
const authRoutes = require('./routes/auth');
app.use('/auth', authRoutes);

const walletRoutes = require('./routes/wallet');
app.use('/wallet', walletRoutes);

// Route par défaut (test)
app.get('/', (req, res) => {
  res.send('OMNIPAY API fonctionne ✓');
});

// Render impose son propre port
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`OMNIPAY backend running on port ${PORT}`);
});
