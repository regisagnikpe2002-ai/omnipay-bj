#!/bin/bash
# OMNIPAY — applique la mise à jour (MoMo, OMNICASH, PI-SPI, e-mails, accueil à boutons ronds) puis l'envoie sur GitHub.
# À lancer DEPUIS le dossier du projet (omnipay-bj) :   bash ~/Downloads/omnipay-update/appliquer.sh
set -e
SRC="$(cd "$(dirname "$0")" && pwd)/files"
if [ ! -f server.js ] || [ ! -d routes ] || [ ! -d public ]; then echo "ERREUR : lancez ce script depuis le dossier omnipay-bj (celui qui contient server.js)."; exit 1; fi
echo "1/5 Synchronisation avec GitHub…"
git pull --rebase --autostash origin main
echo "2/5 Copie des fichiers au bon endroit…"
cp -R "$SRC/." .
git rm -q --ignore-unmatch "routes/momo (1).js" || rm -f "routes/momo (1).js"
echo "3/5 Vérifications…"
bad=0
chk(){ if grep -q "$2" "$1" 2>/dev/null; then echo "   OK    $1"; else echo "   ERREUR $1 ne contient pas « $2 »"; bad=1; fi; }
chk server.js 'api/momo'
chk routes/momo.js 'requestToPay'
chk routes/omnicash.js 'floatLoad'
chk routes/walletOps.js 'AUTO_PAYOUT_DAY_MAX'
chk routes/ledger.js 'MTN_MOMO'
chk routes/channels.js '"/record"'
chk routes/p2p.js 'BINANCE_P2P_API_KEY'
chk providers/payoutRouter.js 'momoPing'
chk services/emailService.js 'BREVO_API_KEY'
chk lib/mailer.js 'BREVO_API_KEY'
chk public/index.html 'class="rb"'
chk public/omnicheck.html 'loadRoutes'
if command -v node >/dev/null 2>&1; then for f in server.js routes/momo.js routes/omnicash.js routes/walletOps.js routes/channels.js routes/ledger.js routes/p2p.js providers/payoutRouter.js services/emailService.js lib/mailer.js; do node --check "$f" || bad=1; done; echo "   OK    syntaxe JavaScript"; fi
if [ "$bad" = 1 ]; then echo "ARRÊT : une vérification a échoué, rien n'a été envoyé."; exit 1; fi
echo "4/5 Enregistrement (commit)…"
git add server.js routes/momo.js routes/omnicash.js routes/walletOps.js routes/ledger.js routes/channels.js routes/p2p.js providers/payoutRouter.js services/emailService.js lib/mailer.js public/index.html public/omnicheck.html
git commit -m "OMNIPAY : MoMo direct, OMNICASH, PI-SPI, e-mails via API, accueil à boutons ronds" || echo "   (rien de nouveau à enregistrer)"
echo "5/5 Envoi vers GitHub (Render redéploie tout seul)…"
git push origin main
echo "TERMINÉ. Surveillez les logs Render : « MTN MoMo (dépôts et suivi des retraits) chargées »."
