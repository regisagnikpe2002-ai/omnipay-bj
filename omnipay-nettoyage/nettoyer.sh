#!/bin/bash
# OMNIPAY — nettoyage du dépôt : retire les fichiers inutiles (zips, sauvegardes, pages web enregistrées, vieux installateurs).
# Rien n'est perdu : GitHub garde tout l'historique. À lancer DEPUIS le dossier omnipay-bj.
set -e
D="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f server.js ] || [ ! -d routes ] || [ ! -d lib ]; then echo "ERREUR : lancez ce script depuis le dossier omnipay-bj."; exit 1; fi
echo "1/4 Synchronisation avec GitHub…"; git pull --rebase --autostash origin main
echo "2/4 Fichiers qui seront retirés :"
n=0; LIST=()
while IFS= read -r f; do [ -z "$f" ] && continue; if git ls-files --error-unmatch -- "$f" >/dev/null 2>&1; then LIST+=("$f"); n=$((n+1)); echo "   - $f"; fi; done < "$D/a_supprimer.txt"
echo
echo "   Aussi : OMNIPAY_PAYIN_ACCOUNTS.txt sort de GitHub (adresses de dépôt) mais reste sur votre Mac ; liveServiceBackground.js passe dans public/."
echo "   Total : $n fichier(s). Le serveur n'utilise AUCUN d'entre eux (vérifié)."
if [ "$n" = 0 ]; then echo "Rien à nettoyer."; exit 0; fi
read -r -p "Tapez OUI pour continuer (autre chose = annuler) : " ok
if [ "$ok" != "OUI" ]; then echo "Annulé. Rien n'a été modifié."; exit 0; fi
echo "3/4 Retrait…"
for f in "${LIST[@]}"; do git rm -q -r -f -- "$f"; done
PATHS=("${LIST[@]}")
if git ls-files --error-unmatch OMNIPAY_PAYIN_ACCOUNTS.txt >/dev/null 2>&1; then git rm -q --cached OMNIPAY_PAYIN_ACCOUNTS.txt; PATHS+=("OMNIPAY_PAYIN_ACCOUNTS.txt"); fi
if [ -f liveServiceBackground.js ] && [ ! -f public/liveServiceBackground.js ] && git ls-files --error-unmatch liveServiceBackground.js >/dev/null 2>&1; then git mv liveServiceBackground.js public/liveServiceBackground.js; PATHS+=("liveServiceBackground.js" "public/liveServiceBackground.js"); fi
for pat in ".DS_Store" "*.zip" "_sauvegarde_avant_*/" "OMNIPAY_PAYIN_ACCOUNTS.txt" "saved_resource*"; do grep -qxF "$pat" .gitignore 2>/dev/null || echo "$pat" >> .gitignore; done
git add .gitignore; PATHS+=(".gitignore")
echo "4/4 Enregistrement et envoi…"
printf '%s\0' "${PATHS[@]}" | xargs -0 git commit -m "OMNIPAY : nettoyage du dépôt (zips, sauvegardes, pages web enregistrées, anciens installateurs)" --
git push origin main
echo "TERMINÉ. Vos autres fichiers préparés (git add) n'ont pas été enregistrés."
