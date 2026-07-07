const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { sql } = require('@vercel/postgres');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { amount, description, userId } = req.body || {};

    if (!amount || amount < 1) {
      return res.status(400).json({ error: 'Montant invalide' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: { name: description || 'Paiement OmniPay' },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${req.headers.origin}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin}/payment-cancel.html`,
      metadata: { userId: userId || 'guest' }
    });

    if (userId) {
      await sql`
        INSERT INTO transactions (user_id, amount, currency, description, status, stripe_session_id)
        VALUES (${userId}, ${amount}, 'EUR', ${description || 'Paiement OmniPay'}, 'pending', ${session.id})
      `;
    }

    return res.status(200).json({ success: true, url: session.url });
  } catch (error) {
    return res.status(500).json({ error: 'Erreur Stripe', details: error.message });
  }
};
