#!/bin/bash
# OMNIPAY v25 — cours crypto + défis à l'accueil, historique derrière un bouton, Recharges & forfaits. À lancer DEPUIS le dossier omnipay-bj.
set -e
echo "OMNIPAY — paquet v25"
SRC="$(cd "$(dirname "$0")" && pwd)/files"
if [ ! -f server.js ] || [ ! -d routes ] || [ ! -d public ]; then echo "ERREUR : lancez ce script depuis le dossier omnipay-bj."; exit 1; fi
BR="$(git branch --show-current)"
if [ "$BR" != "main" ]; then echo "ARRÊT : vous êtes sur la branche « $BR ». Tapez d'abord : git checkout main"; exit 1; fi
echo "1/4 Synchronisation avec GitHub…"; git pull --rebase --autostash origin main
echo "2/4 Contrôle des fichiers locaux…"
bad=0
chkhash(){ cur="$(git hash-object "$1" 2>/dev/null || echo absent)"; if [ "$cur" = "$2" ] || [ "$cur" = "$3" ]; then echo "   OK    $1"; else echo "   DIFFÉRENT $1 ($cur)"; bad=1; fi; }
chkhash public/index.html f984cef24be909c26ce8deaa92856b63bd555862 bff81d2e1ca0484810f7c0faba3b4c370d28e3e2
chkhash public/omnicheck.html dbf2ded53f1a27f6213fb3b57ce673ec5875d09b
chkhash server.js 41cc05a77851a87c530117ae826c304f46b23920
if [ -e routes/bundles.js ]; then echo "   DÉJÀ PRÉSENT routes/bundles.js"; bad=1; fi
if [ "$bad" = 1 ]; then echo "ARRÊT : un fichier a changé. Rien n'a été copié : envoyez-moi cet écran."; exit 1; fi
echo "3/4 Copie et vérifications…"
BK="_sauvegarde_avant_v25"; mkdir -p "$BK/public"; cp public/index.html public/omnicheck.html "$BK/public/"; cp server.js "$BK/"
grep -qx "$BK/" .git/info/exclude 2>/dev/null || echo "$BK/" >> .git/info/exclude
cp -R "$SRC/." .
grep -q 'api/bundles' server.js && grep -q 'fcfSend' public/index.html && grep -q 'bnLoad' public/omnicheck.html || { echo "ERREUR : copie incomplète."; exit 1; }
node --check server.js && node --check routes/bundles.js && echo "   OK    syntaxe JavaScript"
echo "4/4 Enregistrement et envoi…"
git add public/index.html public/omnicheck.html server.js routes/bundles.js
git commit -m "OMNIPAY v25 : cours crypto et defis a l'accueil, historique, recharges et forfaits" -- public/index.html public/omnicheck.html server.js routes/bundles.js || echo "   (rien de nouveau)"
git push origin main
echo "TERMINÉ. Attendez 2-3 minutes (Render)."
