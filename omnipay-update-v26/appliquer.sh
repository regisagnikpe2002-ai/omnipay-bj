#!/bin/bash
# OMNIPAY v26 — fond clair le jour / bleu nuit la nuit, page de connexion épurée (logo + lien), logo dans l'e-mail OTP et les reçus. À lancer DEPUIS le dossier omnipay-bj.
set -e
echo "OMNIPAY — paquet v26"
SRC="$(cd "$(dirname "$0")" && pwd)/files"
if [ ! -f server.js ] || [ ! -d services ] || [ ! -d public ]; then echo "ERREUR : lancez ce script depuis le dossier omnipay-bj."; exit 1; fi
BR="$(git branch --show-current)"
if [ "$BR" != "main" ]; then echo "ARRÊT : vous êtes sur la branche « $BR ». Tapez d'abord : git checkout main"; exit 1; fi
echo "1/4 Synchronisation avec GitHub…"; git pull --rebase --autostash origin main
echo "2/4 Contrôle des fichiers locaux…"
bad=0
chkhash(){ cur="$(git hash-object "$1" 2>/dev/null || echo absent)"; if [ "$cur" = "$2" ] || [ "$cur" = "$3" ]; then echo "   OK    $1"; else echo "   DIFFÉRENT $1 ($cur)"; bad=1; fi; }
chkhash public/index.html 2ad9552d187b5e79281aaeb33907c18c08be0a4c
chkhash services/emailService.js 43637ebae1cc3b4786c86614b57e490fbcd72387
if [ "$bad" = 1 ]; then echo "ARRÊT : un fichier a changé. Rien n'a été copié : envoyez-moi cet écran."; exit 1; fi
echo "3/4 Copie et vérifications…"
BK="_sauvegarde_avant_v26"; mkdir -p "$BK/public" "$BK/services"; cp public/index.html "$BK/public/"; cp services/emailService.js "$BK/services/"
grep -qx "$BK/" .git/info/exclude 2>/dev/null || echo "$BK/" >> .git/info/exclude
cp -R "$SRC/." .
grep -q 'logo-mail.png' services/emailService.js && grep -q 'lg1' public/index.html && [ -f public/logo-mail.png ] || { echo "ERREUR : copie incomplète."; exit 1; }
node --check services/emailService.js && echo "   OK    syntaxe JavaScript"
echo "4/4 Enregistrement et envoi…"
git add public/index.html public/logo-mail.png public/apple-touch-icon.png services/emailService.js
git commit -m "OMNIPAY v26 : theme jour/bleu nuit, connexion epuree, logo dans e-mail OTP et recus" -- public/index.html public/logo-mail.png public/apple-touch-icon.png services/emailService.js || echo "   (rien de nouveau)"
git push origin main
echo "TERMINÉ. Attendez 2-3 minutes (Render)."
