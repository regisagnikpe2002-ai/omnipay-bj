# Connecteurs OMNIPAY

Socle indépendant pour brancher PI-SPI et des wallets locaux au portefeuille OMNIPAY.

## Routes

- `GET /api/connectors`
- `GET /api/connectors/:provider/health`
- `POST /api/omnipay/payments/receive`
- `POST /api/omnipay/payments/pay`
- `POST /api/omnipay/pi-spi/request-to-pay`
- `POST /api/omnipay/pi-spi/aliases/resolve`
- `GET /api/omnipay/pi-spi/payments/:id`

## Exemples

Réception wallet local :

```json
{"provider":"mtn","amount":2000,"payer":"22997000000","currency":"XOF","reference":"OMNI-001"}
```

Paiement PI-SPI :

```json
{"provider":"pi-spi","amount":5000,"beneficiary":{"alias":"22997000000"},"currency":"XOF","reference":"OMNI-002"}
```

## Installation

1. Copier les dossiers à la racine du projet.
2. Copier les variables utiles de `.env.connectors.example` vers `.env`.
3. Reporter le contenu de `integration/server.mount.example.js` dans `server.js`.
4. Garder `PISPI_MOCK=true` tant que les chemins et identifiants officiels ne sont pas configurés.
5. Tester avec `node --check` avant commit.

## Sécurité

Ne jamais versionner `.env`, les secrets client, certificats ou clés privées. Pour mTLS, injecter ultérieurement un agent HTTPS sécurisé et charger les certificats depuis le gestionnaire de secrets de l'hébergeur.
