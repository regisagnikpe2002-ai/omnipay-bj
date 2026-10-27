#!/bin/bash
# OMNIPAY — applique la mise à jour (MoMo, OMNICASH, PI-SPI, e-mails, accueil à boutons ronds) puis l'envoie sur GitHub.
# À lancer DEPUIS le dossier du projet (omnipay-bj) :   bash ~/Downloads/omnipay-update/appliquer.sh
set -e
echo "OMNIPAY — paquet v14 (QR PI-SPI officiel ETS OMNIPAY, logo agrandi, envoi de TOUS les fichiers du paquet, Bureau Cash OMNIXPAY : retraits espèces sous séquestre, pilote OMNICASH : retraits vers comptes reliés validés, pause, supervision, comptes reliés par les clients, compte de dépôt + ID OM, lecture des messages PI-SPI, nettoyage PayDunya, Trésorerie PI-SPI, Bureau P2P, OLATOUNDE, thème jour/nuit)"
SRC="$(cd "$(dirname "$0")" && pwd)/files"
if [ ! -f server.js ] || [ ! -d routes ] || [ ! -d public ]; then echo "ERREUR : lancez ce script depuis le dossier omnipay-bj (celui qui contient server.js)."; exit 1; fi
echo "1/5 Synchronisation avec GitHub…"
git pull --rebase --autostash origin main
echo "2/5 Copie des fichiers au bon endroit…"
BK="_sauvegarde_avant_v14"; mkdir -p "$BK"; (cd "$SRC" && find . -type f) | while read -r f; do [ -f "$f" ] && { mkdir -p "$BK/$(dirname "$f")"; cp "$f" "$BK/$f"; }; done
grep -qx "$BK/" .git/info/exclude 2>/dev/null || echo "$BK/" >> .git/info/exclude
echo "   (anciennes versions gardées dans $BK/ sur votre ordinateur, jamais envoyées sur GitHub)"
cp -R "$SRC/." .
git rm -q --ignore-unmatch "routes/momo (1).js" || rm -f "routes/momo (1).js"
git rm -rq --ignore-unmatch "omnipay-update 6" 2>/dev/null || true
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
chk routes/treasury.js 'PISPI_ECOBANK'
chk routes/walletOps.js 'expire-stale'
chk routes/channels.js 'parse-text'
chk public/omnicheck.html 'pparse'
chk public/omnicheck.html 'expireStale'
chk routes/manualPayments.js 'omId'
chk public/index.html 'Référence obligatoire'
chk routes/linkedAccounts.js 'linked_accounts'
chk server.js 'api/linked'
chk public/index.html 'lkAdd'
chk public/index.html 'width="64"'
chk public/index.html 'pispi-qr.png'
[ -f public/pispi-qr.png ] || { echo "   ERREUR public/pispi-qr.png manquant"; bad=1; }
chk public/omnicheck.html 'loadLinked'
chk routes/manualPayments.js 'omId'
chk lib/omnicashGuard.js 'omnicash_flags'
chk routes/walletOps.js 'verifiedMobile'
chk routes/omnicash.js 'admin/supervision'
chk public/omnicheck.html 'supPause'
chk public/index.html 'linkedId'
chk routes/cashdesk.js 'cash_orders'
chk server.js 'api/cashdesk'
chk public/omnicheck.html 'cdFund'
chk public/index.html 'openCash'
chk routes/olatounde.js 'OLATOUNDE'
chk server.js 'api/olatounde'
chk routes/p2pdesk.js 'p2p_desk'
chk routes/olatounde.js 'olatounde_tickets'
chk public/index.html 'openOlat'
chk public/omnicheck.html 'loadOlat'
[ -f authMiddleware.js ] || { echo "   ERREUR authMiddleware.js introuvable"; bad=1; }
chk server.js 'api/p2pdesk'
chk public/omnicheck.html 'loadP2p'
chk server.js 'api/treasury'
chk public/index.html 'data-theme'
chk public/omnicheck.html 'loadTreasury'
if command -v node >/dev/null 2>&1; then for f in server.js routes/treasury.js routes/p2pdesk.js routes/olatounde.js routes/momo.js routes/omnicash.js routes/walletOps.js routes/channels.js routes/ledger.js routes/p2p.js providers/payoutRouter.js services/emailService.js lib/mailer.js; do node --check "$f" || bad=1; done; echo "   OK    syntaxe JavaScript"; fi
if [ "$bad" = 1 ]; then echo "ARRÊT : une vérification a échoué, rien n'a été envoyé."; exit 1; fi
echo "4/5 Enregistrement (commit)…"
git add server.js routes/treasury.js routes/p2pdesk.js routes/olatounde.js routes/momo.js routes/omnicash.js routes/walletOps.js routes/ledger.js routes/channels.js routes/p2p.js providers/payoutRouter.js services/emailService.js lib/mailer.js public/index.html public/omnicheck.html
(cd "$SRC" && find . -type f) | while read -r f; do git add -- "${f#./}"; done
git commit -m "OMNIPAY : MoMo direct, OMNICASH, PI-SPI, e-mails via API, accueil à boutons ronds, thème jour/nuit, trésorerie PI-SPI + MetaMask, carte client, Bureau P2P, OLATOUNDE" || echo "   (rien de nouveau à enregistrer)"
echo "5/5 Envoi vers GitHub (Render redéploie tout seul)…"
git push origin main
echo "TERMINÉ. Surveillez les logs Render : « MTN MoMo (dépôts et suivi des retraits) chargées »."
