const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { findUserByEmail, createUser } = require('../models/userModel');

const JWT_SECRET = process.env.JWT_SECRET || 'omnipay-secret-key';
const JWT_EXPIRES_IN = '7d';

function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.rôle
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

exports.register = async (req, res) => {
  try {
    const { email, password, nom } = req.body;

    if (!email || !password || !nom)
      return res.status(400).json({ erreur: 'Email, mot de passe et nom requis' });

    const existing = await findUserByEmail(email);
    if (existing)
      return res.status(409).json({ erreur: 'Un compte existe déjà avec cet email' });

    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);

    const user = await createUser({
      email,
      mot_de_passe_hash: hash,
      nom,
      role: 'client'
    });

    const token = generateToken(user);

    return res.status(201).json({
      succès: true,
      token,
      utilisateur: {
        id: user.id,
        email: user.email,
        nom: user.nom,
        rôle: user.rôle
      }
    });
  } catch (err) {
    console.error('Erreur register:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur' });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ erreur: 'Email et mot de passe requis' });

    const user = await findUserByEmail(email);
    if (!user)
      return res.status(401).json({ erreur: 'Email ou mot de passe invalide' });

    const valid = await bcrypt.compare(password, user.mot_de_passe);
    if (!valid)
      return res.status(401).json({ erreur: 'Email ou mot de passe invalide' });

    const token = generateToken(user);

    return res.status(200).json({
      succès: true,
      token,
      utilisateur: {
        id: user.id,
        email: user.email,
        nom: user.nom,
        rôle: user.rôle
      }
    });
  } catch (err) {
    console.error('Erreur login:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur' });
  }
};

exports.me = async (req, res) => {
  return res.status(200).json({
    succès: true,
    utilisateur: req.user
  });
};
