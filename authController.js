const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { findUserByEmail, createUser } = require('../models/userModel');

// Inscription
async function register(req, res) {
  const { email, mot_de_passe, nom, role } = req.body;

  try {
    const userExists = await findUserByEmail(email);
    if (userExists) {
      return res.status(400).json({ message: 'Email déjà utilisé' });
    }

    const mot_de_passe_hash = await bcrypt.hash(mot_de_passe, 10);

    const newUser = await createUser({
      email,
      mot_de_passe_hash,
      nom,
      role: role || 'client'
    });

    res.status(201).json({
      message: 'Utilisateur créé avec succès',
      user: newUser
    });
  } catch (error) {
    console.error('Erreur register:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Connexion
async function login(req, res) {
  const { email, mot_de_passe } = req.body;

  try {
    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(400).json({ message: 'Utilisateur introuvable' });
    }

    const isMatch = await bcrypt.compare(mot_de_passe, user.mot_de_passe);
    if (!isMatch) {
      return res.status(400).json({ message: 'Mot de passe incorrect' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET || 'secret123',
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Connexion réussie',
      token,
      user
    });
  } catch (error) {
    console.error('Erreur login:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Profil utilisateur
async function me(req, res) {
  res.json({
    message: 'Profil utilisateur',
    user: req.user
  });
}

module.exports = { register, login, me };
