const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// Routes
const authRoutes = require('./routes/auth');
app.use('/auth', authRoutes);

// Route test
app.get('/', (req, res) => {
  res.send('OMNIPAY API fonctionnel');
});

// Render impose son propre port
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`OMNIPAY backend running on port ${PORT}`);
});
