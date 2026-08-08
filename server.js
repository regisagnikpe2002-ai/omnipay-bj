const express = require('express');
const app = express();
const cors = require('cors');

// Middlewares
app.use(cors());
app.use(express.json());

// Import des routes
const authRoutes = require('./routes/auth');

// Utilisation des routes
app.use('/auth', authRoutes);

// Route de test
app.get('/', (req, res) => {
  res.send('OMNIPAY API fonctionne ✔');
});

// Démarrage du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur OMNIPAY démarré sur le port ${PORT}`);
});
