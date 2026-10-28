#!/bin/bash
# OMNIPAY v15 — Rapprochement Mobile Money (MTN · Moov · Celtiis · PI-SPI). À lancer DEPUIS le dossier omnipay-bj.
set -e
echo "OMNIPAY — paquet v15 (rapprochement par lot MTN/Moov/Celtiis/PI-SPI)"
SRC="$(cd "$(dirname "$0")" && pwd)/files"
if [ ! -f server.js ] || [ ! -d routes ] || [ ! -d public ]; then echo "ERREUR : lancez ce script depuis le dossier omnipay-bj."; exit 1; fi
echo "1/5 Synchronisation avec GitHub…"; git pull --rebase --autostash origin main
echo "2/5 Copie des fichiers…"
BK="_sauvegarde_avant_v15"; mkdir -p "$BK"; (cd "$SRC" && find . -type f) | while read -r f; do [ -f "$f" ] && { mkdir -p "$BK/$(dirname "$f")"; cp "$f" "$BK/$f"; }; done
grep -qx "$BK/" .git/info/exclude 2>/dev/null || echo "$BK/" >> .git/info/exclude
cp -R "$SRC/." .
echo "3/5 Vérifications…"; bad=0
chk(){ if grep -q "$2" "$1" 2>/dev/null; then echo "   OK    $1"; else echo "   ERREUR $1 ne contient pas « $2 »"; bad=1; fi; }
chk routes/channels.js '/record-batch'
chk routes/channels.js '"/reconcile"'
chk public/omnicheck.html 'rcRead'
chk public/omnicheck.html 'loadSup'
chk public/omnicheck.html 'openCash\|loadCash'
if command -v node >/dev/null 2>&1; then node --check routes/channels.js || bad=1; echo "   OK    syntaxe JavaScript"; fi
if [ "$bad" = 1 ]; then echo "ARRÊT : une vérification a échoué, rien n'a été envoyé."; exit 1; fi
echo "4/5 Enregistrement…"
(cd "$SRC" && find . -type f) | while read -r f; do git add "$f"; done
git commit -m "OMNIPAY v15 : rapprochement par lot MTN/Moov/Celtiis/PI-SPI" || echo "   (rien de nouveau)"
echo "5/5 Envoi vers GitHub…"; git push origin main
echo "TERMINÉ. Ouvrez OMNICHECK : carte « Rapprochement Mobile Money »."
