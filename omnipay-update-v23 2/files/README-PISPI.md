# Brancheur PI-SPI — mettre votre compte Ecobank au service de vos clients

**Principe.** Le client paie sur votre alias PI-SPI en écrivant son identifiant OM (ex. `OM12345678901`) dans le motif.
La banque notifie OMNIPAY → le solde du client est crédité automatiquement. Si le montant dépasse le plafond, ou si l'identifiant OM est absent ou inconnu, le paiement attend **votre validation** dans OMNICHECK (« Paiements entrants à rapprocher »). Un même paiement ne peut jamais être crédité deux fois.

## Variables à ajouter sur Render (Environment)
| Variable | Rôle |
|---|---|
| `PISPI_WEBHOOK_SECRET` | Secret de 32 caractères minimum (générez-le au hasard). Sans lui, le brancheur reste éteint. |
| `PISPI_AUTO_MAX_XOF` | Plafond de crédit automatique par paiement (défaut 200000). Au-dessus : validation humaine. |
| `PISPI_OK_STATUS` | Statuts considérés comme « payé » (défaut ACSC, ACCC, ACSP, SETTLED, COMPLETED, SUCCESS, PAID, CONFIRMED). |
| `PISPI_MAP` | (facultatif) JSON qui dit où lire chaque champ dans la notification de la banque. Voir ci-dessous. |
| `PISPI_SMS_ENABLED` | `on` pour activer le relais SMS (désactivé par défaut). |
| `PISPI_SMS_SENDERS` | Noms d'expéditeurs autorisés pour les SMS, séparés par des virgules (ex. `ECOBANK`). Obligatoire si le relais SMS est activé. |
| `PISPI_SMS_AUTO_MAX_XOF` | Plafond de crédit automatique pour les SMS (défaut 50000). |

## Voie 1 — API / webhook de la banque (recommandée)
Adresse à donner à Ecobank / PI-SPI : `https://VOTRE-SITE/api/pispi/notify` (méthode POST, JSON).
Authentification, au choix : en-tête `x-pispi-signature` = HMAC-SHA256 du corps avec `PISPI_WEBHOOK_SECRET`, ou en-tête `x-pispi-token` = le secret.
**Le format exact des notifications d'Ecobank n'est pas supposé.** Demandez à la banque un exemple de notification, collez-le dans OMNICHECK → « Brancheur PI-SPI » → « Tester une notification » : vous voyez ce qui est compris. Si un champ n'est pas reconnu, réglez `PISPI_MAP`, par exemple :
`{"id":["op.ref"],"amount":["op.montant_fcfa"],"reference":["op.libelle"],"status":["op.etat"]}`

## Voie 2 — Relais SMS (si la banque n'offre pas d'API)
Sur le téléphone qui reçoit les SMS de la banque, une application « SMS forwarder » envoie chaque SMS à `https://VOTRE-SITE/api/pispi/sms` (POST JSON `{"sender":"ECOBANK","text":"…"}`, en-tête `x-pispi-token`). Les SMS de débit sont ignorés ; sans référence d'opération lisible, **aucun crédit automatique** n'est fait. Plafond plus bas car un SMS est plus facile à falsifier qu'une API signée.

## Sécurité
- Le secret n'est jamais affiché ni renvoyé. Ne le collez jamais dans une discussion.
- Au début, gardez un plafond bas (ex. `PISPI_AUTO_MAX_XOF=20000`), faites un vrai test de 100 F, comparez avec l'application Ecobank, puis relevez.
- OMNICHECK → « Clients & activité » : registre de tous les clients et de toutes les opérations, export CSV de 30 jours.
