from pathlib import Path

p = Path('routes/manualPayments.js')
s = p.read_text(encoding='utf-8')
start = s.find('router.post("/admin/payout/:id/paid", adminOnly, async (req, res) => {')
end = s.find('// Retrait refuse', start)
if end < 0:
    end = s.find('// Retrait refus', start)
if start < 0 or end < 0:
    raise SystemExit('ERREUR: route manual payout paid introuvable')
new = r'''router.post("/admin/payout/:id/paid", adminOnly, async (req, res) => {
  try {
    await ensureTables();
    const paymentRef = clean(req.body?.paymentRef, 160);
    const paymentChannel = clean(req.body?.channel || "pispi", 20).toLowerCase();
    const note = clean(req.body?.note, 300) || null;

    if (paymentRef.length < 6) {
      return res.status(400).json({ error: "Reference reelle requise: txId ou end2endId PI-SPI." });
    }

    const rows = await sql()`
      WITH p AS (
        UPDATE manual_payouts
        SET status = 'paid', decided_at = now(), paid_at = now(),
            decided_note = ${note}, payment_channel = ${paymentChannel}, payment_ref = ${paymentRef}
        WHERE id = ${req.params.id}::uuid AND status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM manual_payouts x
            WHERE x.id <> manual_payouts.id
              AND x.payment_ref IS NOT NULL
              AND lower(x.payment_ref) = lower(${paymentRef})
          )
        RETURNING user_id
      ),
      t AS (
        UPDATE transactions
        SET status = 'completed',
            metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
              'settlement', jsonb_build_object(
                'channel', ${paymentChannel},
                'reference', ${paymentRef},
                'confirmedAt', now()::text,
                'confirmedBy', 'admin'
              )
            )
        WHERE provider = 'manual'
          AND provider_ref = ${req.params.id}
          AND type = 'withdrawal'
          AND EXISTS (SELECT 1 FROM p)
        RETURNING wallet_id, balance_after
      ),
      c AS (
        INSERT INTO transactions (wallet_id, type, amount, balance_after, status, provider, idempotency_key)
        SELECT wallet_id, 'commission', ${COMMISSION}, balance_after, 'completed', 'internal', ${"mpc-" + req.params.id}
        FROM t RETURNING id
      )
      SELECT id FROM c
    `;

    if (!rows.length) {
      return res.status(409).json({ error: "Demande deja traitee ou reference de paiement deja utilisee." });
    }

    res.json({ message: "Paiement reel confirme.", paymentRef, channel: paymentChannel });
  } catch (e) {
    if (e && e.code === '23505') {
      return res.status(409).json({ error: "Cette reference de paiement est deja utilisee." });
    }
    console.error("MANUAL_PAID", e.message);
    res.status(500).json({ error: "Erreur." });
  }
});

'''
p.write_text(s[:start] + new + s[end:], encoding='utf-8')
print('OK: payout manuel securise par reference reelle')
