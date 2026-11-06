# OMNIPAY - Adaptateur SMSCodes.io

Ce pack contient uniquement le connecteur serveur `providers/virtualNumbers/smscodes.js`.

## Sécurité obligatoire

1. Révoquer la clé API affichée publiquement.
2. Générer une nouvelle clé.
3. Ajouter uniquement dans Render : `SMSCODES_API_KEY=...`
4. Ne jamais mettre la clé dans GitHub, HTML, JavaScript navigateur ou logs.

## Installation

```bash
cd /workspaces/omnipay-bj
mkdir -p providers/virtualNumbers
cp /chemin/smscodes.js providers/virtualNumbers/smscodes.js
node --check providers/virtualNumbers/smscodes.js
git diff --check
```

## Étape suivante

Avant de générer la boutique complète, inspecter les fichiers d'authentification et le contrat de `secureLedger.js` afin de raccorder les commandes, réservations, remboursements et commissions sans créer un second moteur financier.
