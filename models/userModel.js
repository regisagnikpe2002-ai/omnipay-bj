const db = require('../config/db');

// Trouver un utilisateur par email
async function findUserByEmail(email) {
  const result = await db`SELECT * FROM utilisateurs WHERE email = ${email}`;
  return result.rows[0];
}

// Créer un utilisateur
async function createUser({ email, mot_de_passe }) {
  const result = await db`
    INSERT INTO utilisateurs (email, mot_de_passe)
    VALUES (${email}, ${mot_de_passe})
    RETURNING *;
  `;
  return result.rows[0];
}

module.exports = { findUserByEmail, createUser };
