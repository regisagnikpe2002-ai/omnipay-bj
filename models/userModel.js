const db = require('../config/db');

async function findUserByEmail(email) {
  const result = await db`SELECT * FROM utilisateurs WHERE email=${email}`;
  return result.rows[0];
}

module.exports = { findUserByEmail };
const db = require('../config/db');

async function findUserByEmail(email) {
  const result = await db`SELECT * FROM utilisateurs WHERE email=${email}`;
  return result.rows[0];
}

async function createUser({ email, mot_de_passe_hash, nom, role }) {
  const result = await db`
    INSERT INTO utilisateurs (email, mot_de_passe, nom, rôle)
    VALUES (${email}, ${mot_de_passe_hash}, ${nom}, ${role})
    RETURNING *;
  `;
  return result.rows[0];
}

module.exports = { findUserByEmail, createUser };
