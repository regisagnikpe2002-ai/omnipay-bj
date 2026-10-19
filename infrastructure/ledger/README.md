# Omnipay Ledger — README

Ce dossier contient la migration et les scripts de base pour le ledger central d'Omnipay-bj.

Objectifs :
- Ledger centralisé (table `transactions`) pour traçabilité complète.
- Tables annexes : wallets, providers, reconciliations, audit_logs, approvals.
- Support de cartes virtuelles Omnipay (table `virtual_cards`) — cartes tokenisées à usage client.
- Prototype de scoring d'anomalies pour détection d'intrusions/fraudes.

Sécurité & bonnes pratiques
- NE PAS stocker de PAN (numéros complets de cartes) en clair dans le repo. Utiliser un provider de tokenisation (ex: Stripe Issuing, Marqeta) ou un HSM.
- Stocker les secrets/API keys dans un coffre (HashiCorp Vault, AWS Secrets Manager) et injecter en CI/CD.
- Webhooks : signer (HMAC) et vérifiez la signature côté serveur.
- Multisig/Hardware wallets pour fonds crypto importants.

Déploiement
1. Vérifier que Postgres dispose de l'extension uuid-ossp.
2. Exécuter la migration : psql -f migrations/20261019_create_omnipay_ledger.sql -h <host> -U <user> -d <db>
3. Configurer les secrets (DB URL, SLACK_WEBHOOK_URL, VAULT config) hors repo.

Fichiers clés
- migrations/20261019_create_omnipay_ledger.sql : migration complète
- infrastructure/ledger/scoring_basic.py : prototype IsolationForest pour détecter anomalies
- infrastructure/ledger/webhook_example_python.md : comment vérifier HMAC des webhooks
- infrastructure/ledger/virtual_card_generator.py : générateur de carte virtuelle (tokenisée localement pour prototype)
- infrastructure/ledger/binance_wallet_integration.md : notes sur integration Binance / custody

IA & détection d'anomalies (plan résumé)
- Features initiales : montant, ratio frais/gross, délai création->paiement, fréquence par IP, entropie metadata.
- Modèles proposés : règles (thresholds) + IsolationForest (scikit-learn). Pour gros volumes : Autoencoder temporel.
- Pipeline : batch training (24h) + online scoring à l'insertion.
- Action : si anomaly_score > seuil, block payout et créer ticket/alerte Slack.

Conformité
- KYC/AML obligatoire selon juridiction. Consulte un conseiller légal.
- Ne PAS utiliser ce repo pour contourner règles ou sanctions.

