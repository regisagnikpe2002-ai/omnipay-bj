#!/bin/bash
# OMNIPAY v22 (CUMULATIF : contient v20 + v21) — Ordres de paiement (l'IA rédige, des marchands humains exécutent), mode DÉMO séparé,
# gestionnaire de fonds & risque, Marchés, Défis, Objectif du mois. À lancer DEPUIS le dossier omnipay-bj.
set -e
echo "OMNIPAY — paquet v22 (ordres de paiement + mode démo + fonds & risque + Marchés/Défis/Objectif + prix par crypto)"
SRC="$(cd "$(dirname "$0")" && pwd)/files"
if [ ! -f server.js ] || [ ! -d routes ] || [ ! -d public ] || [ ! -d lib ] || [ ! -d services ]; then echo "ERREUR : lancez ce script depuis le dossier omnipay-bj."; exit 1; fi
echo "1/5 Synchronisation avec GitHub…"; git pull --rebase --autostash origin main
echo "2/5 Contrôle des fichiers locaux…"
bad=0
chkhash(){ cur="$(git hash-object "$1" 2>/dev/null || echo absent)"; if [ "$cur" = "$2" ]; then echo "   OK    $1"; else echo "   DIFFÉRENT $1 (modifié depuis la préparation de ce paquet)"; bad=1; fi; }
chkhash server.js bccb949ec3f5024cbffae3f39ab309bdc929de83
chkhash routes/walletOps.js 3d5dfdb28b0df7b50b0514926bf8ff05e50374ce
chkhash public/index.html 4164b9e47da9ddd7e87d6f496684062deb508e47
chkhash public/omnicheck.html 25052e4132c618514fedbfe6d12f704561656292
chkhash lib/mailer.js 616793eb855ab9a6e760917df9b41333f76fb4cf
chkhash services/emailService.js 1099980c69260209c1b1fc3daa884b9b98dc0a5f
if [ "$bad" = 1 ]; then echo "ARRÊT : un fichier a changé. Rien n'a été copié : envoyez-moi cet écran pour que je fusionne sans rien écraser."; exit 1; fi
echo "3/5 Copie des fichiers…"
BK="_sauvegarde_avant_v22"; mkdir -p "$BK"
(cd "$SRC" && find . -type f) | while read -r f; do if [ -f "$f" ]; then mkdir -p "$BK/$(dirname "$f")"; cp "$f" "$BK/$f"; fi; done
grep -qx "$BK/" .git/info/exclude 2>/dev/null || echo "$BK/" >> .git/info/exclude
cp -R "$SRC/." .
echo "4/5 Vérifications…"; bad=0
chk(){ if grep -q "$2" "$1" 2>/dev/null; then echo "   OK    $1"; else echo "   ERREUR $1 ne contient pas « $2 »"; bad=1; fi; }
chk server.js 'api/orders'
chk server.js 'api/fund'
chk server.js 'api/markets'
chk server.js 'api/challenges'
chk server.js 'api/goals'
chk server.js 'api/mode'
chk server.js 'demoGuard'
chk server.js 'api/email-diag'
chk server.js 'api/services'
chk routes/orders.js 'timingSafeEqual'
chk routes/orders.js 'propre numéro'
chk routes/walletOps.js 'FUND_ROUTER'
chk routes/walletOps.js 'paymentSafetyGate'
chk routes/walletOps.js 'activeOrderFor'
chk routes/markets.js 'sparklines'
chk routes/challenges.js 'crypto_deposit'
chk lib/demoGuard.js 'MODE DÉMO'
chk lib/mailer.js 'isDemo'
chk services/emailService.js 'isDemo'
chk scripts/seedDemo.js 'DEMO_SEED'
chk public/index.html 'ordLoad'
chk public/index.html 'demoBand'
chk public/index.html 'openMk'
chk public/index.html 'mkConv'
chk public/index.html 'loadNet'
chk public/omnicheck.html 'orLoad'
chk public/omnicheck.html 'goalLoad'
chk public/omnicheck.html 'fmLoad'
chk public/omnicheck.html 'mdStatus'
chk public/omnicheck.html 'paymentRef'
chk public/omnicheck.html 'rcT'
if command -v node >/dev/null 2>&1; then for f in server.js lib/appMode.js lib/demoGuard.js lib/mailer.js lib/fundManager.js services/emailService.js routes/orders.js routes/fundManager.js routes/walletOps.js routes/markets.js routes/challenges.js routes/goals.js scripts/seedDemo.js; do node --check "$f" || bad=1; done; echo "   OK    syntaxe JavaScript"; fi
if [ "$bad" = 1 ]; then echo "ARRÊT : une vérification a échoué, rien n'a été envoyé."; exit 1; fi
echo "5/5 Enregistrement et envoi…"
(cd "$SRC" && find . -type f) | while read -r f; do git add "$f"; done
git rm -q --ignore-unmatch omnipay-update-v20.zip "omnipay-update-v20 (1).zip" omnipay-update-v21.zip "omnipay-update-v21 (1).zip" omnipay-update-v22.zip "omnipay-update-v22 (1).zip" 2>/dev/null || true
git commit -m "OMNIPAY v22 : ordres de paiement (IA rédige, marchands exécutent), mode démo séparé, fonds et risque, Marchés, Défis, Objectif du mois" || echo "   (rien de nouveau)"
git push origin main
echo "TERMINÉ. Attendez 2-3 minutes (Render), puis rechargez le site et OMNICHECK avec Cmd+Maj+R."
echo "Le site DÉMO : suivez README-DEMO.md (site et base séparés)."
