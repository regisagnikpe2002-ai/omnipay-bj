# Module OLATOUNDE pour OMNIPAY

## Fichiers
- `services/olatoundeService.js` : moteur de recommandations.
- `routes/olatounde.js` : endpoints authentifiés.

## Installation
Copiez les deux fichiers dans les dossiers correspondants du dépôt OMNIPAY.

Ajoutez ensuite dans `server.js`, avec les autres appels `mount` :

```js
mount("/api/olatounde", "./routes/olatounde", "OLATOUNDE");
```

## Vérifications

```bash
node --check services/olatoundeService.js
node --check routes/olatounde.js
node --check server.js
git diff --check
```

## Endpoints
- `GET /api/olatounde/health`
- `GET /api/olatounde/summary`

Les deux endpoints nécessitent le jeton client via `requireAuth`.

## Sécurité
OLATOUNDE fonctionne en mode conseil uniquement. Le module ne déplace pas de fonds, ne stocke pas de PIN, ne stocke pas d’OTP et ne déclenche aucun transfert automatique.
