#!/bin/bash
# OMNIPAY v24 — fiches services derrière chaque bouton (bouton « i »). À lancer DEPUIS le dossier omnipay-bj.
set -e
echo "OMNIPAY — paquet v24 (fiches services)"
SRC="$(cd "$(dirname "$0")" && pwd)/files"
if [ ! -f server.js ] || [ ! -d public ]; then echo "ERREUR : lancez ce script depuis le dossier omnipay-bj."; exit 1; fi
BR="$(git branch --show-current)"
if [ "$BR" != "main" ]; then echo "ARRÊT : vous êtes sur la branche « $BR ». Tapez d'abord : git checkout main"; exit 1; fi
echo "1/4 Synchronisation avec GitHub…"; git pull --rebase --autostash origin main
echo "2/4 Contrôle du fichier local…"
cur="$(git hash-object public/index.html 2>/dev/null || echo absent)"
if [ "$cur" = "bff81d2e1ca0484810f7c0faba3b4c370d28e3e2" ]; then echo "   OK    public/index.html"; else echo "ARRÊT : public/index.html a changé depuis la préparation de ce paquet ($cur). Rien n'a été copié : envoyez-moi cet écran."; exit 1; fi
echo "3/4 Copie et vérifications…"
BK="_sauvegarde_avant_v24"; mkdir -p "$BK/public"; cp public/index.html "$BK/public/"
grep -qx "$BK/" .git/info/exclude 2>/dev/null || echo "$BK/" >> .git/info/exclude
cp -R "$SRC/." .
grep -q 'svcSheet' public/index.html && grep -q 'function svcAttach' public/index.html || { echo "ERREUR : copie incomplète."; exit 1; }
echo "   OK    fiches services présentes"
echo "4/4 Enregistrement et envoi…"
git add public/index.html
git commit -m "OMNIPAY v24 : fiches services derrière chaque bouton" -- public/index.html || echo "   (rien de nouveau)"
git push origin main
echo "TERMINÉ. Attendez 2-3 minutes (Render), puis touchez le petit « i » sur un bouton."
