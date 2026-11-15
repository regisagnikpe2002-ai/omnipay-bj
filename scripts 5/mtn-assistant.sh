#!/bin/bash
# OMNIPAY — Assistant MTN : une seule commande, aucune recopie. Lance :  bash scripts/mtn-assistant.sh
# Il lit tes clés dans le presse-papiers, crée les identifiants de test MTN, puis met le bloc final dans le presse-papiers : il ne reste qu'à le coller dans Render.
cd "$(dirname "$0")/.." || exit 1
OUT="$(mktemp)"; trap 'rm -f "$OUT"' EXIT
ask() { # $1 = nom du produit, $2 = variable d'environnement
  echo; echo "➜ Sur le portail MTN, ouvre « $1 », clique « Afficher » et COPIE la clé primaire (Cmd+C)."
  read -r -p "  Puis appuie sur Entrée ici… " _
  KEY="$(pbpaste | tr -d '[:space:]')"
  if [ "${#KEY}" -ne 32 ]; then echo "  ✗ La clé copiée fait ${#KEY} caractères au lieu de 32. Recopie-la en entier et relance."; exit 1; fi
  echo "  ✓ Clé lue (32 caractères)."
  env "$2=$KEY" RAW=1 node scripts/momo-sandbox-setup.js >> "$OUT" || { echo "  ✗ MTN a refusé cette clé : c'est sûrement celle d'un autre produit."; exit 1; }
  echo "  ✓ $1 : identifiants de test créés."
}
ask "Recouvrement" COLL_SUB_KEY
ask "Décaissements" DISB_SUB_KEY
sort -u "$OUT" | pbcopy
echo; echo "✅ Terminé. Les 9 variables sont dans ton presse-papiers."
echo "   Render → ton service → Environment → « Add from .env » → Cmd+V → Save."
echo "   Ne copie rien d'autre avant de coller. Après le redémarrage, tape le test d'état (curl) que je t'ai donné."
