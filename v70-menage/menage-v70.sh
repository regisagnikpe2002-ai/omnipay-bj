#!/bin/bash
# Ménage OMNIPAY v70 : supprime les doublons et fichiers vides (aucun fichier utilisé par le serveur).
cd "$(dirname "$0")" || exit 1
n=0
while IFS= read -r f; do
  [ -e "$f" ] && { rm -rf -- "$f"; n=$((n+1)); }
done <<'LISTE'
24px.svg
5670.js
BaseConnector.js
HCaptchaInvisible.5480bac3c3846d971bf8.bundle.js
HCaptchaInvisible.html
HumanSecurity.a62a3ca04c2cebdc4eb1.bundle.js
HumanSecurity.html
LocalWalletConnector.js
NRJS-613107483ed66065813
OMNIPAY_BINANCE_PAY_BACKEND_INSTALLER (1).py
OMNIPAY_BINANCE_PAY_BACKEND_INSTALLER (2).py
OMNIPAY_BINANCE_PAY_BACKEND_INSTALLER.py
OMNIPAY_V2_0_HOLDING_WALLETS_BINANCE_P2P_INSTALLER.py
OMNIPAY_V2_0_READY_TO_PLUG_INSTALLER.py
OMNIPAY_V2_1_COMPLET_INSTALLER.py
OMNIPAY_V2_3_PRO_PARTNER_HUB_INSTALLER (2).py
OMNIPAY_V2_3_PRO_PARTNER_HUB_INSTALLER.py
OMNIPAY_V2_4_IZI_STYLE_INSTALLER (1).py
OMNIPAY_V2_MULTIRAIL_INSTALLER.py
OMNIPAY_V2_reparer_boutons.py
PiSpiConnector.js
affiliateTracking.js
airtimeService.js
api.js
app.57bc55f8a1725377f05d.css
app.d3e6394b58bd3a59542a.css
authController.otp-secure (1).js
b96c449137f00bb6dd6811619f89660f.js
bundleService.js
client.js
connectorErrors.js
connectors.js
connectorsController.js
controller-with-preconnect-0658b1f7fa008196200fc479c0f7b968.html
controller-with-preconnect-8ace2bc10ee320780aac2a7ff532643c.js
db/index.jscode
gtm.js
hcaptcha(1).html
hcaptcha-invisible-e7c6af7c11d084c00b34f81a22c14524.html
hcaptcha.html
httpClient.js
human-security-95880194e4c24544a3f8365dbeca9330.html
index.b23e657673b1af7f64ba.css
inner.html
m-outer-15a2b40a058ddff1cffdb63779fe3de1.js
m-outer-3437aaddcdf6922d623e172c2d6f9278.html
m=el_main_css
main
main.dc809e73de278c475330.js
main.f26f7785adc81a152366.js
main.f29182bd9870f2372957.css
main.min.js
manifest.webmanifest
merchantSimSupervised.js
moov.js
mtn.js
nr-spa-1216.min.js
omni-ui-dynamic.css
omni-ui-dynamic.js
omnipay-admin-session
omnipay-connectors-pi-spi-wallets (1)
omnipay-dashboard-v3
omnipay-maskable-512.png
omnipay-smscodes-adapter (1)
omnipayPayments.js
omnipay_password_reset_patch.py
omnipay_v2_interface_patch.py
otBannerSdk.js
otSDKStub.js
ot_company_logo.png
out-4.5.45.js
password-reset-backup-20261013-113050
patch_walletops_pispi_paid_v2.py
paymentOrchestrator.js
powered_by_logo.svg
privateemail.6e23da986f99c438a924.css
public 10
public 14
public 16
public 18
public 19
public 20
public 8
public/dashboard-v2.backup.html
public/dashboard-v2.html
public/dashboard-v2.js
public/dashboard-v3.html
public/dashboard.html
public/maquette-app.js
public/maquette-fintech.html
publicindex.html
pwa-install.css
pwa-install.js
register-pwa.js
registry.js
routes 2
routes 3
saved_resource(1).html
saved_resource(2).html
saved_resource(3).html
saved_resource(4).html
saved_resource.html
scripts 2
scripts 5
shared-83cb85555c9ff4a13b3a6aa9b118db6f.js
stripe.js
treasuryAccounts.js
treasuryRegistry (1).js
treasuryRegistry.js
tx.status
v30-pawapay (1)
v37-pispi-momo
v39-numeros-virtuels
v46-omnichange
v49-du-jour-crypto
v49-du-jour-crypto (1)
v57-correctif-routes (1)
v58-fedapay-depots
v62-console-paiements (1)
v67-numeros-sim
v69-interface
vendors~AddressAutocomplete~AffirmInContext~AfterpayInContext~AlgoliaSearch~AmazonPayButton~ApplePay~92869408.3de3bad62b1ee4e904eb.bundle.js
vendors~HumanSecurity~SprigV2.cc2396551329233a310a.bundle.js
virtualNumberStore (3).js
virtualNumbers (3).js
virtualNumbers-final.js
wallet.userId
LISTE
echo "Supprimé : $n éléments. Maintenant : git add -A && git commit -m \"v70 menage\" && git push"
rm -- "$0"
