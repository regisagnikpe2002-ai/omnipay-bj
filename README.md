# OMNIPAY (ETS OMNIPAY, Bénin)

Plateforme de paiement : Node/Express + Postgres (Neon), déployée sur Render. Site : https://www.omnipay-bj.com

## Démarrer
- `npm install` puis `npm start` (variables dans `.env`, modèle : `.env.example`).
- Les clés (FedaPay, Binance, etc.) ne vont **que** dans les variables d'environnement de Render, jamais dans le code ni dans une conversation.

## Organisation
- `server.js` : branche toutes les routes (fonction `mount`).
- `routes/` : une API par fonction (liste ci-dessous). `providers/` : connexions aux prestataires (FedaPay, MTN, Moov, Celtiis…).
- `public/` : application web (`index.html`) et console d'administration (`omnicheck.html`). `public/logos/` : logos des prestataires.
- `docs/` : documents, procédures et anciens README. `tests/` : tests.

## Routes branchées
| Chemin | Rôle | Fichier |
|---|---|---|
| `/api/v1` | API OMNIPAY v1 (clés API) | `routes/coreApi.js` |
| `/api/notify` | Notifications | `routes/notify.js` |
| `/api/business` | Business | `routes/business.js` |
| `/api/flows` | Entrées/sorties | `routes/flows.js` |
| `/api/pulse` | Vérification dépôts/retraits | `routes/pulse.js` |
| `/api/termcode` | Codes cash (dépôt/retrait espèces) | `routes/termcode.js` |
| `/api/company` | Espace entreprise | `routes/company.js` |
| `/api/subs` | Abonnements TV (Canal+) | `routes/subscriptions.js` |
| `/api/omniwallet` | OMNIWALLET | `routes/omniwallet.js` |
| `/api/otp` | OTP e-mail + SMS | `routes/otp.js` |
| `/api/reserve` | Fonds de réserve | `routes/reserve.js` |
| `/api/fedapay/deposit` | FedaPay (dépôts) | `routes/fedapayDeposit.js` |
| `/api/payments` | Payment Router OMNIPAY (point d'entrée unique) | `routes/payments.js` |
| `/api/profile` | Photo de profil | `routes/profilePhoto.js` |
| `/api/fedapay` | FedaPay (transferts sortants) | `routes/fedapay.js` |
| `/auth` | Auth | `routes/auth.js` |
| `/auth` | Mot de passe oublié | `routes/passwordReset.js` |
| `/` | Opérations portefeuille V2 | `routes/walletOps.js` |
| `/wallet` | Wallet | `routes/wallet.js` |
| `/api/omnicheck` | OMNICHECK | `routes/omnicheck.js` |
| `/api/omnicheck/reserve-fund` | Fonds de réserve OMNIPAY | `routes/reserveFund.js` |
| `/api/manual` | Paiements manuels | `routes/manualPayments.js` |
| `/api/email-otp` | OTP e-mail | `routes/emailOtp.js` |
| `/api/email-diag` | Diagnostic e-mail (admin) | `routes/emailDiag.js` |
| `/api/fund` | Gestionnaire de fonds et risque (admin) | `routes/fundManager.js` |
| `/api/markets` | Marchés crypto (lecture seule) | `routes/markets.js` |
| `/api/challenges` | Défis clients | `routes/challenges.js` |
| `/api/goals` | Objectif du mois (admin) | `routes/goals.js` |
| `/api/orders` | Ordres de paiement (IA rédige, marchands exécutent) | `routes/orders.js` |
| `/api/admin` | Tableau de bord admin | `routes/adminDash.js` |
| `/api/ledger` | Ledger central | `routes/ledger.js` |
| `/api/schema-inspect` | Inspection schéma READ-ONLY | `routes/schemaInspect.js` |
| `/api/services` | Catalogue des services (lecture seule) | `routes/servicesCatalog.js` |
| `/api/compliance` | Conformité | `routes/compliance.js` |
| `/api` | Identifiants et reçus | `routes/accountIds.js` |
| `/api/coingate` | CoinGate | `routes/coingate.js` |
| `/api/binance-pay` | Binance Pay | `routes/binancePay.js` |
| `/api/treasury` | Trésorerie (PI-SPI + MetaMask) | `routes/treasury.js` |
| `/api/treasury-accounts` | Trésoreries externes OMNIPAY | `routes/treasuryAccounts.js` |
| `/api/omnicash` | OMNICASH (agents) | `routes/omnicash.js` |
| `/api/momo` | MTN MoMo (dépôts et suivi des retraits) | `routes/momo.js` |
| `/api/channels` | Canaux entrants indépendants (PI-SPI, Mobile Money) | `routes/channels.js` |
| `/api/pispi` | Brancheur PI-SPI (crédit automatique plafonné) | `routes/pispiBridge.js` |
| `/api/activity` | Clients et activité (admin, lecture seule) | `routes/activity.js` |
| `/api/vn` | Numéros virtuels (SMS) | `routes/virtualNumbers.js` |
| `/api/exchange` | OMNICHANGE (portefeuille crypto) | `routes/exchange.js` |
| `/api/cryptowallets` | OMNIWALLET : 10 adresses crypto par client | `routes/cryptoWallets.js` |
| `/api/cards` | Cartes virtuelles OMNIPAY | `routes/cards.js` |
| `/api/recon` | Réconciliation (fonds suspendus) | `routes/reconcile.js` |
| `/api/daily` | Du jour (cartes quotidiennes) | `routes/daily.js` |
| `/api/omnitrade` | OMNITRADE (bourse des produits locaux) | `routes/omnitrade.js` |
| `/api/keys` | État des clés API (admin) | `routes/keysStatus.js` |
| `/api/pawapay` | PawaPay (Mobile Money MTN et Moov) | `routes/pawapay.js` |
| `/api/p2p` | Binance P2P (lecture) | `routes/p2p.js` |
| `/api/omnigift` | OMNIGIFT (cartes cadeaux) | `routes/omnigift.js` |
| `/api/olatounde` | OLATOUNDE (assistante client) | `routes/olatounde.js` |
| `/api/p2pdesk` | Bureau P2P (garde-fou libération) | `routes/p2pdesk.js` |
| `/api/linked` | Comptes reliés (retraits vers vos comptes) | `routes/linkedAccounts.js` |
| `/api/cashdesk` | Bureau Cash OMNIXPAY (retraits espèces sous séquestre) | `routes/cashdesk.js` |
| `/api/pay` | Demandes de paiement par QR/lien (usage unique, expiration) | `routes/payRequests.js` |
| `/api/web3` | Web3 | `routes/web3.js` |
| `/api` | Binance | `routes/binance.js` |
