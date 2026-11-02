# Omnipay

Passerelle de paiement et portefeuille pour l'e-commerce en Afrique : mobile money (MTN, Moov, Celtiis, PayDunya), crypto (CoinGate, Binance, MetaMask) et cartes cadeaux.

**Etat : squelette MVP (sandbox).** Fonctionnel : inscription/connexion, portefeuille a registre comptable, transferts entre clients Omnipay, recharge avec confirmation par webhook. A faire : connecteurs reels, KYC, retraits, crypto, cartes, tests, audit de securite.

## Demarrage local
```bash
npm install
cp .env.example .env        # puis remplir DATABASE_URL et JWT_SECRET
npm run migrate
npm run dev
```

## Tester le parcours (fournisseur "mock")
```bash
# inscription + connexion
curl -X POST localhost:3000/auth/register -H 'content-type: application/json' -d '{"phone":"+22900000001","name":"Ami","password":"motdepasse123"}'
curl -X POST localhost:3000/auth/login    -H 'content-type: application/json' -d '{"phone":"+22900000001","password":"motdepasse123"}'
# recharge puis confirmation simulee
curl -X POST localhost:3000/topup -H "authorization: Bearer TOKEN" -H 'content-type: application/json' -d '{"provider":"mock","phone":"+22900000001","amount":5000,"idempotencyKey":"a1"}'
curl -X POST localhost:3000/dev/confirm/mock_ID_DE_LA_TRANSACTION
curl localhost:3000/wallet -H "authorization: Bearer TOKEN"
```

## GitHub et deploiement
```bash
git init && git add . && git commit -m "Omnipay MVP"
git remote add origin git@github.com:VOTRE_COMPTE/omnipay.git
git push -u origin main
```
Deploiement : un hebergeur Node.js avec PostgreSQL gere (Render, Railway, Fly.io). Variables d'environnement a renseigner dans l'hebergeur (pas dans le code) ; commande de build `npm install`, de demarrage `npm start`, et `npm run migrate` une fois.

## Securite
- Ne jamais commiter `.env` ni partager de cles API, tokens GitHub ou phrases MetaMask.
- Binance : droits lecture + trading seulement, jamais retrait, IP du serveur autorisee.
- Avant tout lancement public : audit de securite et avis juridique (agrement, KYC/LCB-FT).
