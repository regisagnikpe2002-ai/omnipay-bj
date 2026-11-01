#!/bin/bash
# OMNIPAY v21 (CUMULATIF : contient aussi le v20) — Gestionnaire de fonds & risque, Marchés crypto en direct, Défis clients, Objectif du mois.
# À lancer DEPUIS le dossier omnipay-bj.
set -e
echo "OMNIPAY — paquet v21 (inclut v20 : fonds & risque ; + Marchés, Défis, Objectif du mois)"
SRC="$(cd "$(dirname "$0")" && pwd)/files"
if [ ! -f server.js ] || [ ! -d routes ] || [ ! -d public ] || [ ! -d lib ]; then echo "ERREUR : lancez ce script depuis le dossier omnipay-bj."; exit 1; fi
echo "1/5 Synchronisation avec GitHub…"; git pull --rebase --autostash origin main
echo "2/5 Contrôle des fichiers locaux…"
bad=0
chkhash(){ cur="$(git hash-object "$1" 2>/dev/null || echo absent)"; if [ "$cur" = "$2" ]; then echo "   OK    $1"; else echo "   DIFFÉRENT $1 (modifié depuis la préparation de ce paquet)"; bad=1; fi; }
chkhash server.js bccb949ec3f5024cbffae3f39ab309bdc929de83
chkhash routes/walletOps.js 3d5dfdb28b0df7b50b0514926bf8ff05e50374ce
chkhash public/omnicheck.html 25052e4132c618514fedbfe6d12f704561656292
chkhash public/index.html 4164b9e47da9ddd7e87d6f496684062deb508e47
if [ "$bad" = 1 ]; then echo "ARRÊT : un fichier a changé. Rien n'a été copié : envoyez-moi cet écran pour que je fusionne sans rien écraser."; exit 1; fi
echo "3/5 Copie des fichiers…"
BK="_sauvegarde_avant_v21"; mkdir -p "$BK"
(cd "$SRC" && find . -type f) | while read -r f; do if [ -f "$f" ]; then mkdir -p "$BK/$(dirname "$f")"; cp "$f" "$BK/$f"; fi; done
grep -qx "$BK/" .git/info/exclude 2>/dev/null || echo "$BK/" >> .git/info/exclude
cp -R "$SRC/." .
echo "4/5 Vérifications…"; bad=0
chk(){ if grep -q "$2" "$1" 2>/dev/null; then echo "   OK    $1"; else echo "   ERREUR $1 ne contient pas « $2 »"; bad=1; fi; }
chk server.js 'api/fund'
chk server.js 'api/markets'
chk server.js 'api/challenges'
chk server.js 'api/goals'
chk server.js 'api/email-diag'
chk server.js 'api/services'
chk routes/walletOps.js 'FUND_ROUTER'
chk routes/walletOps.js 'paymentSafetyGate'
chk lib/fundManager.js 'chooseRoute'
chk public/index.html 'openMk'
chk public/index.html 'openChl'
chk public/index.html 'openMan'
chk public/index.html 'loadNet'
chk public/omnicheck.html 'goalLoad'
chk public/omnicheck.html 'fmLoad'
chk public/omnicheck.html 'mdStatus'
chk public/omnicheck.html 'paymentRef'
chk routes/goals.js 'timingSafeEqual'
if command -v node >/dev/null 2>&1; then for f in server.js lib/fundManager.js routes/fundManager.js routes/walletOps.js routes/markets.js routes/challenges.js routes/goals.js; do node --check "$f" || bad=1; done; echo "   OK    syntaxe JavaScript"; fi
if [ "$bad" = 1 ]; then echo "ARRÊT : une vérification a échoué, rien n'a été envoyé."; exit 1; fi
echo "5/5 Enregistrement et envoi…"
(cd "$SRC" && find . -type f) | while read -r f; do git add "$f"; done
git rm -q --ignore-unmatch omnipay-update-v20.zip "omnipay-update-v20 (1).zip" omnipay-update-v21.zip "omnipay-update-v21 (1).zip" 2>/dev/null || true
git commit -m "OMNIPAY v21 : gestionnaire de fonds et risque, Marchés crypto en direct, Défis clients, Objectif du mois" || echo "   (rien de nouveau)"
git push origin main
echo "TERMINÉ. Attendez 2-3 minutes (Render), puis rechargez le site et OMNICHECK avec Cmd+Maj+R."
