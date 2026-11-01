#!/bin/bash
# OMNIPAY v23b — lecture du SMS réel d'Ecobank (devise devant, solde écarté), liste de SMS à ignorer. À lancer DEPUIS le dossier omnipay-bj.
set -e
echo "OMNIPAY — paquet v23b (relais SMS Ecobank)"
SRC="$(cd "$(dirname "$0")" && pwd)/files"
if [ ! -f server.js ] || [ ! -d routes ]; then echo "ERREUR : lancez ce script depuis le dossier omnipay-bj."; exit 1; fi
BR="$(git branch --show-current)"
if [ "$BR" != "main" ]; then echo "ARRÊT : vous êtes sur la branche « $BR ». Tapez d'abord : git checkout main"; exit 1; fi
echo "1/4 Synchronisation avec GitHub…"; git pull --rebase --autostash origin main
echo "2/4 Contrôle des fichiers locaux…"
bad=0
chkhash(){ cur="$(git hash-object "$1" 2>/dev/null || echo absent)"; if [ "$cur" = "$2" ] || [ "$cur" = "$3" ]; then echo "   OK    $1"; else echo "   DIFFÉRENT $1 (modifié depuis la préparation de ce paquet)"; bad=1; fi; }
chkhash routes/channels.js 8baf171811bcc51bb7eaaba5a547d54e24f622e5
chkhash routes/pispiBridge.js d9cd1554b4c6d7cdace16d969f0f7445dce3167f
chkhash README-PISPI.md 925cbdf3f121c49d16aead81f1c9df2ab2866ea2
if [ "$bad" = 1 ]; then echo "ARRÊT : un fichier a changé. Rien n'a été copié : envoyez-moi cet écran."; exit 1; fi
echo "3/4 Copie et vérifications…"
BK="_sauvegarde_avant_v23b"; mkdir -p "$BK/routes"; cp routes/channels.js routes/pispiBridge.js "$BK/routes/"; cp README-PISPI.md "$BK/"
grep -qx "$BK/" .git/info/exclude 2>/dev/null || echo "$BK/" >> .git/info/exclude
cp -R "$SRC/." .
grep -q 'PISPI_SMS_IGNORE' routes/pispiBridge.js && grep -q 'toInt' routes/channels.js || { echo "ERREUR : copie incomplète."; exit 1; }
node --check routes/channels.js && node --check routes/pispiBridge.js && echo "   OK    syntaxe JavaScript"
echo "4/4 Enregistrement et envoi…"
git add routes/channels.js routes/pispiBridge.js README-PISPI.md
git commit -m "OMNIPAY v23b : lecture du SMS Ecobank, liste de SMS ignorés" -- routes/channels.js routes/pispiBridge.js README-PISPI.md || echo "   (rien de nouveau)"
git push origin main
echo "TERMINÉ. Attendez 2-3 minutes (Render)."
