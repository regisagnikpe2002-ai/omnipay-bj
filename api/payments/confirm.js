const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { sql } = require('@vercel/postgres');

module.exports = async (req, res) => {
  try {
    const { session_id } = req.query;

    if (!session_id) {
      return res.status(400).json({ error: 'session_id requis' });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status === 'paid') {
      const userId = session.metadata.userId;

      await sql`
        UPDATE transactions
        SET status = 'completed'
        WHERE stripe_session_id = ${session_id}
      `;

      if (userId && userId !== 'guest') {
        const amount = session.amount_total / 100;
        await sql`
          UPDATE users
          SET balance = balance + ${amount}
          WHERE id = ${userId}
        `;
      }

      return res.status(200).json({ success: true, status: 'paid' });
    }

    return res.status(200).json({ success: true, status: session.payment_status });
  } catch (error) {
    return res.status(500).json({ error: 'Erreur confirmation', details: error.message });
  }
};
