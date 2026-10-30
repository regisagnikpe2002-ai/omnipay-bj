from pathlib import Path

path = Path("routes/walletOps.js")
source = path.read_text(encoding="utf-8")

start_marker = 'router.post("/api/ops/withdraw/:id/paid", adminOnly, async (req, res) => {'
end_marker = '\n\n// Export CSV des retraits a payer'

start = source.find(start_marker)
end = source.find(end_marker, start)

if start < 0:
    raise SystemExit("ERREUR: debut de la route WD_PAID introuvable")
if end < 0:
    raise SystemExit("ERREUR: fin de la route WD_PAID introuvable")

replacement = r'''router.post("/api/ops/withdraw/:id/paid", adminOnly, async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) {
      return res.status(400).json({ error: "Identifiant invalide." });
    }

    const paymentRef = clean(req.body?.paymentRef, 160);
    const channel = clean(req.body?.channel || "pispi", 20).toLowerCase();

    if (paymentRef.length < 6) {
      return res.status(400).json({
        error: "Reference reelle requise: txId ou end2endId PI-SPI."
      });
    }

    const duplicate = await sql()`
      SELECT id
      FROM transactions
      WHERE type = 'withdrawal'
        AND status = 'completed'
        AND metadata->'settlement'->>'reference' = ${paymentRef}
      LIMIT 1
    `;

    if (duplicate.length) {
      return res.status(409).json({
        error: "Cette reference de paiement est deja utilisee."
      });
    }

    const rows = await sql()`
      UPDATE transactions
      SET
        status = 'completed',
        metadata = coalesce(metadata, '{}'::jsonb) ||
          jsonb_build_object(
            'settlement',
            jsonb_build_object(
              'channel', ${channel},
              'reference', ${paymentRef},
              'confirmedAt', now()::text,
              'confirmedBy', 'admin'
            )
          )
      WHERE id = ${req.params.id}::uuid
        AND type = 'withdrawal'
        AND status IN ('pending', 'failed', 'processing')
      RETURNING id
    `;

    if (!rows.length) {
      return res.status(409).json({
        error: "Retrait introuvable ou deja traite."
      });
    }

    res.json({
      message: "Paiement reel confirme et retrait cloture.",
      paymentRef,
      channel
    });
  } catch (e) {
    console.error("WD_PAID", e.message);
    res.status(500).json({ error: "Erreur serveur." });
  }
});'''

updated = source[:start] + replacement + source[end:]
path.write_text(updated, encoding="utf-8")
print("OK: route WD_PAID securisee")
