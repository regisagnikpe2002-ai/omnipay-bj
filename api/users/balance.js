const { sql } = require('@vercel/postgres');

module.exports = async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId requis' });

    const result = await sql`SELECT id, email, name, role, balance FROM users WHERE id = ${userId}`;
    if (result.rows.length === 0) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const user = result.rows[0];
    return res.status(200).json({
      success: true,
      user: { ...user, balance: parseFloat(user.balance) }
    });
  } catch (error) {
    return res.status(500).json({ error: 'Erreur', details: error.message });
  }
};
