# OMNIPAY Multi-Operator Core

Noyau isolé pour enregistrer, sélectionner et superviser les connecteurs PayDunya, MTN, Moov et Celtiis.

## Sécurité

- Aucun connecteur opérateur réel n'est activé sans contrat et identifiants.
- Aucun fichier existant OMNIPAY n'est remplacé.
- Le module n'est branché à aucune route de production à l'installation.

## Test

```bash
node multi-operator/scripts-test.js
```

## Étape suivante

Créer un adaptateur PayDunya autour du code existant, puis migrer progressivement les appels de dépôt vers l'orchestrateur.
