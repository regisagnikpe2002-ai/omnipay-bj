const db = require('../config/db');

async function findUserByEmail(email) {
  const result = await db`SELECT * FROM utilisateurs WHERE email=${email}`;
  return result.rows[0];
}

module.exports = { findUserByEmail };
