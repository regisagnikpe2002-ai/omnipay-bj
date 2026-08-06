const bcrypt = require('bcryptjs');
const { findUserByEmail } = require('../models/userModel');

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ erreur: 'Email et mot de passe requis' });

    const user = await findUserByEmail(email);
    if (!user)
      return res.status(401).json({ erreur: 'Email non trouvé' });

    const valid = await bcrypt.compare(password, user.mot_de_passe);
    if (!valid)
      return res.status(401).json({ erreur: 'Email ou mot de passe invalide' });

    return res.status(200).json({
      succès: true,
      utilisateur: {
        id: user.id,
        email: user.email,
        nom: user.nom,
        rôle: user.rôle,
        équilibre: parseFloat(user.équilibre)
      }
    });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur interne du serveur' });
  }
};
