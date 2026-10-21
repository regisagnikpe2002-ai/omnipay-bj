#!/usr/bin/env python3
from pathlib import Path
from datetime import datetime
import re
import shutil

path = Path('public/index.html')
if not path.exists():
    raise SystemExit('ERREUR: lance le script depuis le dossier omnipay-bj')

stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
backup = Path(f'public/index.html.v2-ui-{stamp}.bak')
shutil.copy2(path, backup)
text = path.read_text(encoding='utf-8')

css = '''
  /* OMNIPAY V2 ACTION MODALS */
  .modal-backdrop{display:none;position:fixed;inset:0;z-index:999;background:rgba(5,11,22,.72);backdrop-filter:blur(7px);padding:18px;align-items:center;justify-content:center}
  .modal-backdrop.open{display:flex}.modal-box{width:min(460px,100%);max-height:92vh;overflow:auto;background:#fffdf7;border-radius:24px;padding:24px;box-shadow:0 28px 80px rgba(0,0,0,.35)}
  .modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}.modal-head h3{margin:0;color:var(--indigo);font-family:'Fraunces',serif;font-size:24px}
  .modal-close{width:38px;height:38px;border:0;border-radius:12px;background:#eef1f7;color:#172554;font-size:22px;cursor:pointer}.modal-box label{display:block;margin:13px 0 6px;font-size:12px;font-weight:700;color:var(--ink-soft);text-transform:uppercase}
  .modal-box input,.modal-box select{width:100%;padding:13px 14px;border:1px solid #d7dce8;border-radius:13px;background:#fff;color:#111827;font:inherit;outline:none}.modal-submit{width:100%;margin-top:18px;padding:14px;border:0;border-radius:14px;background:linear-gradient(135deg,#162a69,#2849ad);color:#fff;font-weight:800;cursor:pointer}
  .modal-note{margin:12px 0 0;font-size:12px;line-height:1.55;color:#6b7280}.modal-result{display:none;margin-top:14px;padding:12px;border-radius:13px;background:#eef9f4;color:#166534;font-size:13px}.soon-card{padding:16px;border-radius:16px;background:#f4f1e8;color:#6b6252;text-align:center;font-weight:700}
  .tx-main{min-width:0}.tx-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.tx-ref{margin-top:4px;color:#8a8f9b;font-size:11px;font-family:monospace}.status-badge{display:inline-flex;padding:4px 8px;border-radius:999px;font-size:10px;font-weight:800;text-transform:uppercase}.status-pending{background:#fff4d6;color:#9a6700}.status-completed{background:#dcfce7;color:#166534}.status-failed,.status-cancelled{background:#fee2e2;color:#991b1b}.tx-receipt{margin-top:5px;border:0;background:transparent;color:#1e3a8a;font-size:11px;font-weight:800;padding:0;cursor:pointer;text-decoration:underline}
  @media(max-width:560px){.modal-box{padding:20px}.actions{grid-template-columns:repeat(2,1fr)}}
'''
if '/* OMNIPAY V2 ACTION MODALS */' not in text:
    text = text.replace('</style>', css + '\n</style>', 1)

old_actions = re.compile(r'<div class="actions">.*?</div>\s*<p class="error" id="dash-err">', re.S)
new_actions = '''<div class="actions">
        <button class="action-btn on" onclick="openModal('deposit-modal')"><span class="ic">↓</span>Déposer</button>
        <button class="action-btn on2" onclick="openModal('withdraw-modal')"><span class="ic">↑</span>Retirer</button>
        <button class="action-btn on2" onclick="openModal('transfer-modal')"><span class="ic">⇄</span>Envoyer</button>
        <button class="action-btn off" onclick="openModal('card-modal')"><span class="ic">▤</span>Carte virtuelle<span class="tag">Bientôt</span></button>
      </div>
      <p class="error" id="dash-err">'''
text, n = old_actions.subn(new_actions, text, count=1)
if n != 1:
    raise SystemExit('ERREUR: bloc actions introuvable. Sauvegarde: ' + str(backup))

modals = '''
  <div class="modal-backdrop" id="deposit-modal" onclick="backdropClose(event)"><div class="modal-box"><div class="modal-head"><h3>Déposer</h3><button class="modal-close" onclick="closeModal('deposit-modal')">×</button></div><form onsubmit="deposit(event)"><label>Montant en FCFA</label><input id="deposit-amount" type="number" min="200" step="1" placeholder="Ex. 5000" required><button class="modal-submit" type="submit">Continuer vers le paiement</button><p class="modal-note">Le dépôt sera confirmé uniquement après validation sécurisée du prestataire.</p></form></div></div>
  <div class="modal-backdrop" id="withdraw-modal" onclick="backdropClose(event)"><div class="modal-box"><div class="modal-head"><h3>Retirer</h3><button class="modal-close" onclick="closeModal('withdraw-modal')">×</button></div><form onsubmit="withdraw(event)"><label>Montant en FCFA</label><input id="withdraw-amount" type="number" min="1" step="1" required><label>Numéro Mobile Money</label><input id="withdraw-phone" type="tel" placeholder="Ex. 90000000" required><label>Opérateur</label><select id="withdraw-operator" required><option value="">Choisir</option><option value="mtn">MTN Bénin</option><option value="moov">Moov Bénin</option><option value="celtiis">Celtiis Cash</option></select><button class="modal-submit" type="submit">Demander le retrait</button></form></div></div>
  <div class="modal-backdrop" id="transfer-modal" onclick="backdropClose(event)"><div class="modal-box"><div class="modal-head"><h3>Envoyer</h3><button class="modal-close" onclick="closeModal('transfer-modal')">×</button></div><form onsubmit="transferMoney(event)"><label>Téléphone du bénéficiaire OMNIPAY</label><input id="transfer-phone" type="tel" placeholder="Ex. 22990000000" required><label>Montant en FCFA</label><input id="transfer-amount" type="number" min="1" step="1" required><div class="modal-result" id="recipient-result"></div><button class="modal-submit" type="submit">Vérifier et envoyer</button></form></div></div>
  <div class="modal-backdrop" id="card-modal" onclick="backdropClose(event)"><div class="modal-box"><div class="modal-head"><h3>Carte virtuelle</h3><button class="modal-close" onclick="closeModal('card-modal')">×</button></div><div class="soon-card">Bientôt disponible sur OMNIPAY</div></div></div>
'''
if 'id="deposit-modal"' not in text:
    text = text.replace('\n  <script>', '\n' + modals + '\n  <script>', 1)

helpers = '''
    function openModal(id) { document.getElementById(id)?.classList.add('open'); }
    function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }
    function backdropClose(event) { if (event.target === event.currentTarget) event.currentTarget.classList.remove('open'); }
    function formatMoney(value) { return Number(value || 0).toLocaleString('fr-FR') + ' XOF'; }
    function escapeHtml(value) { return String(value ?? '').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c])); }
    function typeLabel(type) { return ({deposit:'Dépôt',withdrawal:'Retrait',transfer_in:'Transfert reçu',transfer_out:'Transfert envoyé',commission:'Commission'})[type] || String(type || 'Transaction').replaceAll('_',' '); }
    function statusLabel(status) { return ({pending:'En attente',completed:'Confirmée',failed:'Échouée',cancelled:'Annulée'})[status] || status; }
    function shortRef(tx) { return 'OMP-' + String(tx.id || tx.idempotencyKey || '').replaceAll('-','').slice(0,12).toUpperCase(); }
'''
if 'function openModal(id)' not in text:
    text = text.replace("let token = localStorage.getItem('omnipay_token');", "let token = localStorage.getItem('omnipay_token');\n" + helpers, 1)

render_re = re.compile(r'function\s*renderTx\s*\(txs\)\s*\{.*?\n\s*\}\s*\n\s*async function\s*deposit', re.S)
render_code = '''function renderTx(txs) {
      const list = document.getElementById('tx-list');
      if (!txs.length) { list.innerHTML = '<p class="empty">Aucune transaction pour l\\'instant.</p>'; return; }
      list.innerHTML = txs.slice(0, 12).map(tx => {
        const isIn = tx.type === 'deposit' || tx.type === 'transfer_in';
        const status = String(tx.status || 'pending').toLowerCase();
        const txJson = encodeURIComponent(JSON.stringify(tx));
        return `<div class="tx-item"><div class="tx-main"><div class="tx-line"><div class="tx-type">${escapeHtml(typeLabel(tx.type))}</div><span class="status-badge status-${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span></div><div class="tx-ref">${shortRef(tx)}</div>${status === 'completed' ? `<button class="tx-receipt" onclick="showReceipt('${txJson}')">Voir le reçu</button>` : ''}</div><div class="tx-amount ${isIn?'in':'out'}">${isIn?'+':'-'}${formatMoney(tx.amount)}</div></div>`;
      }).join('');
    }

    function showReceipt(encoded) {
      const tx = JSON.parse(decodeURIComponent(encoded));
      const ref = shortRef(tx);
      const provider = tx.provider ? `Transaction traitée via ${escapeHtml(tx.provider)}` : 'Transaction OMNIPAY';
      const win = window.open('', '_blank', 'width=500,height=700');
      if (!win) return showError('dash-err', 'Autorise les fenêtres pour afficher le reçu.');
      win.document.write(`<!doctype html><html lang="fr"><meta charset="utf-8"><title>Reçu ${ref}</title><body style="font-family:Arial;padding:32px;color:#111827"><div style="max-width:420px;margin:auto;border:1px solid #dbe2ef;border-radius:22px;padding:28px"><h1 style="color:#162a69;margin:0">OMNIPAY</h1><p style="color:#64748b">Votre quotidien financier</p><hr><h2 style="color:#166534">✓ TRANSACTION CONFIRMÉE</h2><p><b>ID OMNIPAY</b><br>${ref}</p><p><b>Type</b><br>${escapeHtml(typeLabel(tx.type))}</p><p><b>Montant</b><br>${formatMoney(tx.amount)}</p><p><b>Statut</b><br>${escapeHtml(statusLabel(tx.status))}</p><p><b>Date</b><br>${new Date(tx.createdAt).toLocaleString('fr-FR')}</p><hr><p style="font-size:12px;color:#64748b">${provider}</p><button onclick="print()" style="padding:12px 18px;border:0;border-radius:10px;background:#162a69;color:#fff;font-weight:700">Imprimer / PDF</button></div></body></html>`);
      win.document.close();
    }

    async function deposit'''
text, n = render_re.subn(render_code, text, count=1)
if n != 1:
    raise SystemExit('ERREUR: renderTx introuvable. Sauvegarde: ' + str(backup))

flow_re = re.compile(r'async function\s*deposit\s*\([^)]*\)\s*\{.*?\n\s*async function\s*withdraw\s*\([^)]*\)\s*\{.*?\n\s*\}\s*\n\s*if\s*\(token\)', re.S)
flow_code = '''async function deposit(event) {
      event?.preventDefault(); hideError('dash-err');
      const amount = Number(document.getElementById('deposit-amount').value);
      if (!Number.isFinite(amount) || amount < 200) return showError('dash-err', 'Le dépôt minimum est de 200 XOF.');
      try { const res = await fetch('/wallet/deposit',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({amount})}); const data = await res.json(); if(!res.ok) return showError('dash-err',data.error||'Dépôt impossible.'); if(!data.paymentUrl) return showError('dash-err','Lien de paiement absent.'); closeModal('deposit-modal'); location.href=data.paymentUrl; } catch(e){ showError('dash-err','Erreur réseau, réessaie.'); }
    }

    async function withdraw(event) {
      event?.preventDefault(); hideError('dash-err');
      const amount=Number(document.getElementById('withdraw-amount').value), phone=document.getElementById('withdraw-phone').value.trim(), operator=document.getElementById('withdraw-operator').value;
      if(!Number.isFinite(amount)||amount<=0||!phone||!operator) return showError('dash-err','Complète correctement le retrait.');
      try { const res=await fetch('/wallet/withdraw',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({amount,phone,operator})}); const data=await res.json(); if(!res.ok) return showError('dash-err',data.error||'Retrait impossible.'); closeModal('withdraw-modal'); alert(data.message||'Demande enregistrée.'); await showDashboard(); } catch(e){ showError('dash-err','Erreur réseau, réessaie.'); }
    }

    async function transferMoney(event) {
      event?.preventDefault(); hideError('dash-err');
      const phone=document.getElementById('transfer-phone').value.trim(), amount=Number(document.getElementById('transfer-amount').value), result=document.getElementById('recipient-result');
      if(!phone||!Number.isFinite(amount)||amount<=0) return showError('dash-err','Téléphone et montant valides requis.');
      try { const lookup=await fetch('/wallet/recipient/'+encodeURIComponent(phone),{headers:{Authorization:'Bearer '+token}}); const recipient=await lookup.json(); if(!lookup.ok) return showError('dash-err',recipient.error||'Bénéficiaire OMNIPAY introuvable.'); const label=recipient.user?.firstName||recipient.firstName||recipient.name||phone; result.style.display='block'; result.textContent='Bénéficiaire : '+label; if(!confirm(`Envoyer ${formatMoney(amount)} à ${label} ?`)) return; const res=await fetch('/wallet/transfer',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({phone,amount})}); const data=await res.json(); if(!res.ok) return showError('dash-err',data.error||'Transfert impossible.'); closeModal('transfer-modal'); alert(data.message||'Transfert effectué.'); await showDashboard(); } catch(e){ showError('dash-err','Erreur réseau, réessaie.'); }
    }

    if (token)'''
text, n = flow_re.subn(flow_code, text, count=1)
if n != 1:
    raise SystemExit('ERREUR: dépôt/retrait introuvables. Sauvegarde: ' + str(backup))

path.write_text(text, encoding='utf-8')
print('OMNIPAY_V2_INTERFACE_OK')
print('SAUVEGARDE=' + str(backup))
