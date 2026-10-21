#!/usr/bin/env python3
from pathlib import Path
from datetime import datetime
import shutil

root = Path.cwd()
public = root / 'public'
if not (root / 'server.js').exists() or not public.exists():
    raise SystemExit('ERREUR: lance ce fichier depuis le dossier omnipay-bj')

stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
for name in ('index.html','omnipay-v2.css','omnipay-v2.js'):
    p = public / name
    if p.exists():
        shutil.copy2(p, public / f'{name}.{stamp}.bak')

html = r'''<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#071c43">
  <title>OMNIPAY V2 Multirail</title>
  <link rel="stylesheet" href="/omnipay-v2.css?v=1">
</head>
<body>
<div id="toast" class="toast"></div>
<header class="topbar">
  <div class="brand"><span class="brandmark">O</span><div><b>OMNIPAY</b><small>Wallet multirail</small></div></div>
  <div class="api-pill">API <span id="api-state">vérification</span></div>
</header>

<main class="shell">
  <section id="auth" class="auth-card">
    <div class="auth-copy"><span class="eyebrow">OMNIPAY V2</span><h1>La finance locale et crypto, dans une seule interface.</h1><p>Connexion sécurisée à ton wallet OMNIPAY existant.</p></div>
    <form id="login-form" class="form-card">
      <label>Email ou téléphone</label><input id="identifier" autocomplete="username" required>
      <label>Mot de passe</label><input id="password" type="password" autocomplete="current-password" required>
      <button class="primary" type="submit">Se connecter</button>
      <a href="/forgot-password.html">Mot de passe oublié ?</a>
      <p id="login-error" class="error"></p>
    </form>
  </section>

  <section id="dashboard" class="dashboard hidden">
    <div class="hero-grid">
      <article class="balance-card">
        <span>SOLDE DISPONIBLE</span><h1 id="balance">0 XOF</h1>
        <div class="chips"><i>Compte actif</i><i>Transactions sécurisées</i></div>
      </article>
      <article class="qr-card">
        <div><b>QR OMNIPAY</b><p>Un identifiant, plusieurs rails</p></div>
        <button class="qr-preview" data-action="qr"><span>OMP</span><small>QR multirail</small></button>
      </article>
    </div>

    <div class="actions">
      <button class="action deposit" data-action="deposit"><span>↓</span><b>Déposer</b><small>Crypto ou Mobile Money</small></button>
      <button class="action withdraw" data-action="withdraw"><span>↑</span><b>Retirer</b><small>Vers un rail disponible</small></button>
      <button class="action send" data-action="send"><span>⇄</span><b>Envoyer</b><small>OMNIPAY ou rail externe</small></button>
      <button class="action qr" data-action="qr"><span>⌗</span><b>QR Code</b><small>Recevoir multirail</small></button>
    </div>

    <section class="rail-strip">
      <span>Rails présentés</span><b>Binance Pay</b><b>MTN MoMo</b><b>Moov Money</b><b>Celtiis Cash</b>
      <small>Interface uniquement, activation backend à vérifier rail par rail.</small>
    </section>

    <div class="content-grid">
      <section class="panel"><div class="panel-head"><div><h2>Dernières transactions</h2><p>Données réelles du wallet</p></div><button id="refresh" class="ghost">Actualiser</button></div><div id="tx-list" class="tx-list"></div></section>
      <aside class="flow-card"><h2>Schéma transaction</h2><ol><li>Création ID OMP</li><li>Rail sélectionné</li><li>Transaction pending</li><li>Confirmation du rail</li><li>completed</li><li>Mise à jour du solde</li><li>Reçu OMNIPAY</li></ol></aside>
    </div>
    <button id="logout" class="logout">Se déconnecter</button>
  </section>
</main>

<div id="modal" class="modal hidden" role="dialog" aria-modal="true">
  <div class="modal-box">
    <div class="modal-head"><div><span class="eyebrow">OMNIPAY MULTIRAIL</span><h2 id="modal-title">Opération</h2></div><button id="modal-close" class="close">×</button></div>
    <div id="modal-body"></div>
  </div>
</div>
<script src="/omnipay-v2.js?v=1"></script>
</body></html>'''

css = r''':root{--navy:#071c43;--blue:#0c3c8a;--ink:#101828;--muted:#667085;--line:#e4e9f2;--bg:#f4f7fb;--green:#087a54;--orange:#ef6c2f;--purple:#6d43d9}*{box-sizing:border-box}body{margin:0;background:var(--bg);font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink)}button,input,select{font:inherit}.hidden{display:none!important}.topbar{height:76px;background:linear-gradient(100deg,#061735,#0a357b);color:white;display:flex;align-items:center;justify-content:space-between;padding:0 max(24px,5vw);box-shadow:0 8px 26px #071c4322}.brand{display:flex;gap:12px;align-items:center}.brandmark{width:43px;height:43px;border-radius:50%;display:grid;place-items:center;font-weight:900;background:conic-gradient(#2e7df6,#6c3fd4,#ef6c2f,#ffd43b,#2e7df6);border:7px solid #ffffff22}.brand b{font-size:23px}.brand small{display:block;color:#bcd0f3}.api-pill{background:#ffffff18;border:1px solid #ffffff20;border-radius:999px;padding:9px 15px}.shell{max-width:1280px;margin:auto;padding:28px}.auth-card{min-height:610px;display:grid;grid-template-columns:1.1fr .9fr;overflow:hidden;border-radius:30px;background:linear-gradient(130deg,#071c43,#0c4ba8);box-shadow:0 30px 80px #16336d20}.auth-copy{padding:70px;color:white}.auth-copy h1{font-size:54px;line-height:1.02;max-width:700px}.auth-copy p{font-size:18px;color:#d6e5ff}.eyebrow{font-size:11px;font-weight:900;letter-spacing:.12em;color:#58d4ff}.form-card{margin:42px;background:white;border-radius:25px;padding:36px;display:flex;flex-direction:column;align-self:center;box-shadow:0 22px 50px #0003}.form-card label,.field label{font-size:12px;font-weight:800;color:#475467;margin:13px 0 6px}.form-card input,.field input,.field select{width:100%;border:1px solid var(--line);border-radius:14px;padding:14px;outline:none}.form-card input:focus,.field input:focus,.field select:focus{border-color:#2e7df6;box-shadow:0 0 0 4px #2e7df611}.primary{border:0;border-radius:14px;padding:15px;color:white;font-weight:900;background:linear-gradient(130deg,#0c3c8a,#2d7ff9);margin:20px 0 12px;cursor:pointer}.form-card a{text-align:center;color:#174d9f}.error{color:#b42318}.hero-grid{display:grid;grid-template-columns:1.4fr .6fr;gap:20px}.balance-card,.qr-card,.panel{background:white;border:1px solid var(--line);border-radius:28px;padding:27px;box-shadow:0 12px 35px #19386d0a}.balance-card{background:linear-gradient(135deg,#071c43,#0d54bb);color:white}.balance-card>span{font-size:12px;color:#cce0ff}.balance-card h1{font-size:46px;margin:8px 0 24px}.chips{display:flex;gap:8px;flex-wrap:wrap}.chips i{font-size:12px;font-style:normal;background:#ffffff13;border-radius:999px;padding:8px 10px}.qr-card{display:flex;justify-content:space-between;align-items:center}.qr-card p{color:var(--muted);margin:5px 0}.qr-preview{width:145px;aspect-ratio:1;border:0;border-radius:22px;background:repeating-conic-gradient(#071c43 0 25%,#fff 0 50%) 50%/22px 22px;box-shadow:inset 0 0 0 12px white;position:relative;cursor:pointer}.qr-preview span,.qr-preview small{background:white;padding:5px;position:absolute;left:50%;transform:translateX(-50%)}.qr-preview span{top:42%;font-weight:900}.qr-preview small{top:57%;white-space:nowrap}.actions{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:20px 0}.action{min-height:155px;border:1px solid var(--line);border-radius:25px;background:white;padding:22px;text-align:left;cursor:pointer;transition:.2s}.action:hover{transform:translateY(-3px);box-shadow:0 16px 30px #19386d14}.action span{display:grid;place-items:center;width:48px;height:48px;border-radius:16px;color:white;font-size:25px;margin-bottom:18px}.action b,.action small{display:block}.action b{font-size:18px}.action small{color:var(--muted);margin-top:5px}.deposit span{background:var(--green)}.withdraw span{background:var(--orange)}.send span{background:#2875e8}.qr span{background:var(--purple)}.rail-strip{display:flex;align-items:center;gap:18px;flex-wrap:wrap;background:white;border:1px solid var(--line);border-radius:20px;padding:15px 20px;margin-bottom:20px}.rail-strip span{color:var(--muted)}.rail-strip small{margin-left:auto;color:#98a2b3}.content-grid{display:grid;grid-template-columns:1.4fr .6fr;gap:20px}.panel-head{display:flex;justify-content:space-between;align-items:center}.panel-head h2,.flow-card h2{margin:0}.panel-head p{color:var(--muted);margin:5px 0}.ghost{border:1px solid var(--line);background:white;border-radius:12px;padding:10px 13px;cursor:pointer}.tx-list{display:grid;gap:10px;margin-top:18px}.tx{display:grid;grid-template-columns:1.3fr 1fr .7fr .7fr;align-items:center;gap:10px;padding:14px;border-radius:16px;background:#f8fafc}.tx small{color:var(--muted)}.amount.in{color:#087a54}.amount.out{color:#d92d20}.status{justify-self:start;border-radius:999px;padding:6px 9px;font-size:11px;font-weight:800;background:#fff0d7;color:#a15c00}.status.completed{background:#dbf9eb;color:#087a54}.flow-card{border-radius:28px;padding:27px;color:white;background:linear-gradient(145deg,#071c43,#113d84)}.flow-card ol{padding:0;list-style:none;counter-reset:steps}.flow-card li{counter-increment:steps;margin:14px 0;display:flex;align-items:center;gap:10px}.flow-card li:before{content:counter(steps);display:grid;place-items:center;width:27px;height:27px;border-radius:50%;background:#ffffff14}.logout{margin-top:20px;border:0;background:transparent;color:#b42318;font-weight:800;cursor:pointer}.modal{position:fixed;inset:0;z-index:99;background:#020817aa;backdrop-filter:blur(7px);display:grid;place-items:center;padding:18px}.modal-box{width:min(620px,100%);max-height:92vh;overflow:auto;background:white;border-radius:28px;padding:27px;box-shadow:0 30px 90px #0008}.modal-head{display:flex;justify-content:space-between}.modal-head h2{margin:6px 0}.close{border:0;background:#f2f4f7;border-radius:12px;width:40px;height:40px;font-size:25px;cursor:pointer}.rail-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.rail{border:1px solid var(--line);border-radius:18px;padding:16px;text-align:left;background:white;cursor:pointer}.rail.active{border-color:#2e7df6;box-shadow:0 0 0 3px #2e7df615}.rail b,.rail small{display:block}.rail small{color:var(--muted);margin-top:4px}.field{margin-top:15px}.summary{margin-top:16px;padding:15px;border-radius:17px;background:#f8fafc;color:#475467}.warning{color:#b54708}.toast{position:fixed;top:90px;right:25px;z-index:120;background:#071c43;color:white;border-radius:15px;padding:13px 17px;opacity:0;transform:translateY(-8px);transition:.2s;pointer-events:none}.toast.show{opacity:1;transform:none}@media(max-width:850px){.auth-card,.hero-grid,.content-grid{grid-template-columns:1fr}.auth-copy{padding:40px}.auth-copy h1{font-size:38px}.actions{grid-template-columns:repeat(2,1fr)}.qr-card{flex-direction:column;gap:15px}.rail-strip small{margin-left:0}.tx{grid-template-columns:1fr auto}.tx .rail-name,.tx .date{display:none}}@media(max-width:520px){.shell{padding:14px}.topbar{padding:0 15px}.api-pill{display:none}.form-card{margin:15px;padding:24px}.auth-copy{padding:28px}.actions{gap:10px}.action{min-height:140px;padding:16px}.rail-grid{grid-template-columns:1fr}.balance-card h1{font-size:38px}}'''

js = r'''let token=localStorage.getItem('omnipay_token');let currentAction=null;let selectedRail='binance';let wallet=null;
const rails=[{id:'binance',name:'Binance Pay',kind:'Crypto'},{id:'mtn',name:'MTN MoMo',kind:'Mobile Money'},{id:'moov',name:'Moov Money',kind:'Mobile Money'},{id:'celtiis',name:'Celtiis Cash',kind:'Mobile Money'}];
const $=s=>document.querySelector(s);const toast=m=>{const t=$('#toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2600)};const money=v=>Number(v||0).toLocaleString('fr-FR')+' XOF';
async function api(path,opt={}){opt.headers={...(opt.headers||{}),...(token?{Authorization:'Bearer '+token}:{})};const r=await fetch(path,opt);let d={};try{d=await r.json()}catch{}if(!r.ok)throw new Error(d.error||'Erreur serveur');return d}
async function checkApi(){try{const r=await fetch('/api/status');$('#api-state').textContent=r.ok?'ONLINE':'ERREUR'}catch{$('#api-state').textContent='HORS LIGNE'}}
function typeLabel(t){return({deposit:'Dépôt',withdrawal:'Retrait',transfer_in:'Transfert reçu',transfer_out:'Transfert envoyé',commission:'Commission'})[t]||String(t||'Transaction').replaceAll('_',' ')}
function statusLabel(s){return({pending:'En attente',completed:'Confirmée',failed:'Échouée',cancelled:'Annulée'})[s]||s}
function shortId(tx){return'OMP-'+String(tx.id||tx.idempotencyKey||'').replaceAll('-','').slice(0,12).toUpperCase()}
function renderTx(list){$('#tx-list').innerHTML=list.length?list.slice(0,12).map(tx=>{const incoming=['deposit','transfer_in'].includes(tx.type);const st=String(tx.status||'pending');return`<div class="tx"><div><b>${typeLabel(tx.type)}</b><small>${shortId(tx)}</small></div><div class="rail-name">${tx.provider||'OMNIPAY'}</div><b class="amount ${incoming?'in':'out'}">${incoming?'+':'-'}${money(tx.amount)}</b><span class="status ${st==='completed'?'completed':''}">${statusLabel(st)}</span></div>`}).join(''):'<p>Aucune transaction.</p>'}
async function loadDashboard(){try{const [w,t]=await Promise.all([api('/wallet/me'),api('/wallet/transactions')]);wallet=w.wallet;$('#balance').textContent=money(wallet.balance);renderTx(t.transactions||[]);$('#auth').classList.add('hidden');$('#dashboard').classList.remove('hidden')}catch(e){localStorage.removeItem('omnipay_token');token=null;$('#dashboard').classList.add('hidden');$('#auth').classList.remove('hidden')}}
$('#login-form').addEventListener('submit',async e=>{e.preventDefault();$('#login-error').textContent='';try{const d=await api('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier:$('#identifier').value.trim(),password:$('#password').value})});token=d.accessToken;localStorage.setItem('omnipay_token',token);await loadDashboard()}catch(err){$('#login-error').textContent=err.message}})
function openAction(action){currentAction=action;selectedRail=action==='send'?'mtn':'binance';$('#modal-title').textContent=action==='deposit'?'Déposer':action==='withdraw'?'Retirer':action==='send'?'Envoyer':'QR OMNIPAY multirail';$('#modal').classList.remove('hidden');renderModal()}
function renderModal(){if(currentAction==='qr'){const account=wallet?.id?shortId({id:wallet.id}):'OMP-WALLET';$('#modal-body').innerHTML=`<div class="qr-preview" style="margin:auto;width:250px"><span>OMP</span><small>${account}</small></div><div class="summary"><b>QR OMNIPAY multirail</b><br>Ce QR sera lié à l'identifiant OMNIPAY. Les rails réels seront branchés après validation du backend.</div>`;return}const railCards=rails.map(r=>`<button class="rail ${r.id===selectedRail?'active':''}" data-rail="${r.id}"><b>${r.name}</b><small>${r.kind}</small></button>`).join('');$('#modal-body').innerHTML=`<p><b>Choisir le rail</b></p><div class="rail-grid">${railCards}</div><div class="field"><label>Montant</label><input id="op-amount" type="number" min="1" placeholder="0"></div>${currentAction!=='deposit'?'<div class="field"><label>Destination</label><input id="op-target" placeholder="Téléphone, email ou identifiant"></div>':''}<div class="summary"><b>Rail :</b> ${rails.find(r=>r.id===selectedRail)?.name}<br><b>Statut initial :</b> pending<br><b>ID :</b> généré côté serveur</div><button id="prepare" class="primary" style="width:100%">Continuer</button><p class="warning">Interface uniquement : aucun paiement n'est déclenché tant que le backend du rail n'est pas vérifié.</p>`;document.querySelectorAll('[data-rail]').forEach(b=>b.onclick=()=>{selectedRail=b.dataset.rail;renderModal()});$('#prepare').onclick=()=>toast('Parcours préparé. Backend paiement non activé.')}
document.querySelectorAll('[data-action]').forEach(b=>b.addEventListener('click',()=>openAction(b.dataset.action)));$('#modal-close').onclick=()=>$('#modal').classList.add('hidden');$('#modal').onclick=e=>{if(e.target===e.currentTarget)$('#modal').classList.add('hidden')};$('#refresh').onclick=loadDashboard;$('#logout').onclick=()=>{localStorage.removeItem('omnipay_token');location.reload()};checkApi();if(token)loadDashboard();'''

(public/'index.html').write_text(html,encoding='utf-8')
(public/'omnipay-v2.css').write_text(css,encoding='utf-8')
(public/'omnipay-v2.js').write_text(js,encoding='utf-8')
print('OMNIPAY_V2_MULTIRAIL_INSTALLE')
print('SAUVEGARDE_SUFFIX=' + stamp)
print('LIEN=http://localhost:3000/?v=multirail')
