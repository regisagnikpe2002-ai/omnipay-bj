#!/usr/bin/env python3
from pathlib import Path
from datetime import datetime
import re, shutil

p = Path('public/index.html')
if not p.exists():
    raise SystemExit('ERREUR: public/index.html introuvable')

stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
bak = p.with_name(f'index.html.interface-fix-{stamp}.bak')
shutil.copy2(p, bak)
s = p.read_text(encoding='utf-8')

# Corriger les espaces perdus dans certaines balises/fonctions.
fixes = {
    'divclass=': 'div class=',
    'svgviewBox=': 'svg viewBox=',
    'functionswitchTab': 'function switchTab',
    'functionshowError': 'function showError',
    'functionhideError': 'function hideError',
    'functionsoon': 'function soon',
    'functionlogout': 'function logout',
    'functionrenderTx': 'function renderTx',
    'functiondeposit': 'function deposit',
    'functionwithdraw': 'function withdraw',
    'functiontransferMoney': 'function transferMoney',
    'constres=': 'const res=',
    "Authorization:'Bearer'+token": "Authorization:'Bearer '+token",
    'Sedéconnecter': 'Se déconnecter',
    'Dépôtimpossible': 'Dépôt impossible',
    'OMNIPAYintrouvable': 'OMNIPAY introuvable',
}
for a, b in fixes.items():
    s = s.replace(a, b)

modals = '''
  <!-- OMNIPAY V2 ACTION MODALS -->
  <div class="modal-backdrop" id="deposit-modal" onclick="backdropClose(event)">
    <div class="modal-box">
      <div class="modal-head"><h3>Déposer</h3><button type="button" class="modal-close" onclick="closeModal('deposit-modal')">×</button></div>
      <form onsubmit="deposit(event)">
        <label>Montant en FCFA</label>
        <input id="deposit-amount" type="number" min="200" step="1" placeholder="Ex. 5 000" required>
        <button class="modal-submit" type="submit">Continuer vers le paiement</button>
        <p class="modal-note">Le paiement sera lancé uniquement après ta validation.</p>
      </form>
    </div>
  </div>

  <div class="modal-backdrop" id="withdraw-modal" onclick="backdropClose(event)">
    <div class="modal-box">
      <div class="modal-head"><h3>Retirer</h3><button type="button" class="modal-close" onclick="closeModal('withdraw-modal')">×</button></div>
      <form onsubmit="withdraw(event)">
        <label>Montant en FCFA</label><input id="withdraw-amount" type="number" min="1" step="1" required>
        <label>Numéro Mobile Money</label><input id="withdraw-phone" type="tel" placeholder="Ex. 90000000" required>
        <label>Opérateur</label>
        <select id="withdraw-operator" required><option value="">Choisir</option><option value="mtn">MTN Bénin</option><option value="moov">Moov Bénin</option><option value="celtiis">Celtiis Cash</option></select>
        <button class="modal-submit" type="submit">Demander le retrait</button>
      </form>
    </div>
  </div>

  <div class="modal-backdrop" id="transfer-modal" onclick="backdropClose(event)">
    <div class="modal-box">
      <div class="modal-head"><h3>Envoyer</h3><button type="button" class="modal-close" onclick="closeModal('transfer-modal')">×</button></div>
      <form onsubmit="transferMoney(event)">
        <label>Téléphone du bénéficiaire OMNIPAY</label><input id="transfer-phone" type="tel" placeholder="Ex. 22990000000" required>
        <label>Montant en FCFA</label><input id="transfer-amount" type="number" min="1" step="1" required>
        <div class="modal-result" id="recipient-result"></div>
        <button class="modal-submit" type="submit">Vérifier et envoyer</button>
      </form>
    </div>
  </div>

  <div class="modal-backdrop" id="card-modal" onclick="backdropClose(event)">
    <div class="modal-box">
      <div class="modal-head"><h3>Carte virtuelle</h3><button type="button" class="modal-close" onclick="closeModal('card-modal')">×</button></div>
      <div class="soon-card">Bientôt disponible sur OMNIPAY</div>
    </div>
  </div>
'''

# Ajouter les fenêtres juste avant le premier script si elles ne sont pas déjà présentes.
if 'id="deposit-modal"' not in s:
    s, n = re.subn(r'(<script\b[^>]*>)', modals + r'\n\1', s, count=1, flags=re.I)
    if n != 1:
        raise SystemExit('ERREUR: aucune balise script trouvée; sauvegarde=' + str(bak))

p.write_text(s, encoding='utf-8')
print('INTERFACE_V2_REPAREE')
print('SAUVEGARDE=' + str(bak))
