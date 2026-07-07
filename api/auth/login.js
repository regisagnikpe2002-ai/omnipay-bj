const { sql } = require('@vercel/postgres');
const bcrypt = require('bcryptjs');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }

    const result = await sql`SELECT * FROM users WHERE email = ${email}`;

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    const token = Buffer.from(JSON.stringify({ id: user.id, email: user.email, role: user.role })).toString('base64');

    return res.status(200).json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        balance: parseFloat(user.balance)
      }
    });
  } catch (error) {
    return res.status(500).json({ error: 'Erreur connexion', details: error.message });
  }
};
