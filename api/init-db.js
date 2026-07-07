const { sql } = require('@vercel/postgres');

module.exports = async (req, res) => {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        phone VARCHAR(50),
        role VARCHAR(20) DEFAULT 'client',
        balance NUMERIC DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        amount NUMERIC NOT NULL,
        currency VARCHAR(10) DEFAULT 'EUR',
        description TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        stripe_session_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `;

    res.status(200).json({ success: true, message: 'Tables créées avec succès' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur création tables', details: error.message });
  }
};
