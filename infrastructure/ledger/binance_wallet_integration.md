# Binance & wallet generation — notes d'intégration

Objectif : évaluer si Binance peut générer des wallets pour vos clients et quelles sont les alternatives.

Résumé
- Binance (exchange) n'expose généralement pas une API publique permettant de créer des adresses custodiales individuelles pour "vos clients" en dehors de solutions spécifiques pour entreprises (custody, institutional solutions, sub-accounts).
- Deux approches principales :
  1. Self-hosted HD wallet (contrôle total) : vous gérez la clé maître et générez adresses via un HD wallet. Besoin de sécurité forte (HSM, multisig).
  2. Fournisseur de custody / issuance : Fireblocks, BitGo, Coinbase Custody, Binance Custody (si éligible). Ces fournisseurs peuvent proposer des API pour créer wallets/address et gérer clés.

Alternatives pratiques
- CoinGate / CoinPayments / Coinify : création d'invoices et adresses par paiement, settlement en fiat possible.
- Binance : vous pouvez utiliser des sub-accounts et l'API pour gérer balances et trading, mais la création d'adresses deposit pour des utilisateurs finals dépend du modèle (souvent vous devez gérer vos propres deposit addresses et mapper).

Recommandations
1. Si vous voulez rapidement fournir des adresses de réception aux clients, utilisez une solution HD wallet (ex: bitcoinlib / ethers.js + HD seed) et conservez seed dans HSM / Vault. Générer une adresse par invoice.
2. Si vous préférez déléguer custody et réduire la charge réglementaire, contactez Binance Custody, Fireblocks ou Coinbase Custody pour connaître leur offre d'issuance d'adresses et requirements KYC/KYB.
3. Ne jamais prétendre générer "wallets Binance" pour vos clients sans accord contractuel — l'affichage d'adresses de dépôt doit clairement indiquer que l'adresse est gérée par Omnipay (custodial) ou fournie par le provider.

Points de conformité
- KYC/KYB renforcé pour services custody
- Sanctions screening
- Reporting fiscal selon juridiction

Exemple d'architecture pour deposits rapides
- Orchestrateur crée invoice -> HD wallet dérive adresse unique -> montrer QR à client -> on-chain watch -> on confirmation -> option: auto-sell via Binance API or send to cold.

Si tu veux, je peux :
- Rédiger un mail template à Binance/Fireblocks pour demander offre custody et API pour issuance.
- Écrire le code d'exemple pour dériver adresses HD Ethereum/BTC et monitorer les dépôts.

