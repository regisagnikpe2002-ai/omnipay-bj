# Règle d'or : les prestataires agissent en backend

1. Les clients ne voient jamais le nom d'un prestataire technique (FedaPay, FeexPay, PawaPay, PayDunya, KKiaPay…). Ils voient seulement des opérateurs (MTN, Moov, Celtiis) et la marque OMNIPAY.
2. Le choix du prestataire se fait uniquement côté serveur (Payment Router, variables `PAYOUT_ROUTE_<OPERATEUR>`, clés dans Render). Changer de prestataire ne change rien pour le client.
3. Les adresses publiques sont neutres : `/api/cashin` (encaissement). Les anciennes adresses restent pour les webhooks et l'administration.
4. Les noms de prestataires ne sont autorisés que dans la console admin (OMNICHECK).
5. Les webhooks des prestataires ne font qu'enregistrer, sauf validation explicite ; aucun crédit automatique sans signature vérifiée.
6. Contrôle automatique : `npm run check:providers` échoue si un nom de prestataire apparaît dans les pages clients.
