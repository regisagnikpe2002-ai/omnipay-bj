<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>OMNICHECK — Administration</title>
<style>
:root{--bg:#070b14;--card:#0e1628;--line:#22304d;--txt:#f2f6fc;--mut:#8fa0bf;--mint:#34e8b0;--warn:#ffcc4d;--err:#ff6b6b}
*{box-sizing:border-box;margin:0}body{background:var(--bg);color:var(--txt);font:15px/1.5 system-ui,sans-serif;padding:20px}
.w{max-width:760px;margin:0 auto}h1{font-size:22px;margin-bottom:4px}h2{font-size:16px;margin:0 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin-top:14px}
input{width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);background:#f4f7fb;color:#0b1426;font-size:15px}
button{cursor:pointer;border:0;border-radius:10px;padding:12px 16px;font-weight:700;background:var(--mint);color:#05261c;margin:10px 8px 0 0}
.sec{background:#131d33;color:var(--txt);border:1px solid var(--line)}.mut{color:var(--mut);font-size:13px}
.k{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.k div{background:#131d33;border-radius:12px;padding:12px}.k b{display:block;font-size:20px}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:6px 4px;border-bottom:1px solid var(--line);text-align:left}
.ok{color:var(--mint)}.bad{color:var(--warn)}.hide{display:none}
</style><script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script></head><body><div class="w">
<h1>OMNICHECK — Administration</h1><p class="mut">Inventaire, opérations non abouties, avis clients. La clé n'est jamais enregistrée.</p>
<div class="card"><input id="key" type="password" placeholder="Clé administrateur (ADMIN_KEY)" autocomplete="off">
<button onclick="load()">Afficher le rapport</button><button class="sec" onclick="run()">Lancer l'inventaire maintenant</button><div id="err" class="bad"></div></div>
<div id="out" class="hide">
<div class="card"><h2>Tableau de bord</h2>
<div class="k" id="dk"></div>
<p class="mut" style="margin-top:12px">Entrées (dépôts) en vert, sorties (retraits) en jaune, par jour.</p><div id="ch"></div>
<div class="mut" id="chl"></div>
<button onclick="exportXlsx()">Exporter en Excel</button><button class="sec" onclick="backfillIds()">Attribuer un identifiant OM à tous les clients</button><button class="sec" onclick="loadDash()">Actualiser</button></div>
<div class="card"><h2>Demandes à traiter</h2><div class="k" id="rq"></div></div>
<div class="card"><h2>Alertes et vulnérabilités</h2><div id="an" class="bad"></div><table id="sec"></table><h2 style="margin-top:14px">Écarts solde / journal</h2><table id="gp"></table></div>
<div class="card"><h2>Clients : entrées, sorties, transferts</h2><div style="overflow-x:auto"><table id="tp"></table></div></div>
<div class="card"><h2>Mes comptes de réception (adresses publiques)</h2><p class="mut">Affichés aux clients dans « Dépôt &amp; retrait directs ». Aucune clé privée n'est stockée : pour modifier, changez OMNIPAY_PAYIN_ACCOUNTS dans Render.</p><table id="ac"></table></div>
<div class="card"><h2>État : <span id="st"></span></h2><div id="al" class="bad"></div><div class="k" id="kp"></div><p class="mut" id="gen" style="margin-top:8px"></p></div>
<div class="card"><h2>Mouvements des dernières 24 h</h2><table id="fl"></table></div>
<div class="card"><h2>Opérations non abouties (&gt; 30 min)</h2><p class="mut">Signalées pour vérification : OMNICHECK n'exécute aucun paiement automatiquement.</p><table id="nc"></table></div>
<div class="card"><h2>Dépôts à valider</h2><p class="mut">Vérifiez la réception réelle (relevé, MetaMask, Mobile Money) avant de créditer. Un seul crédit possible par demande.</p><table id="md"></table></div>
<div class="card"><h2>Retraits à exécuter</h2><p class="mut">Le solde du client est déjà réservé. Payez, puis cliquez « Payé » ; ou « Refuser » pour rembourser.</p><table id="mp"></table></div>
<div class="card"><h2>Retraits bloqués (ancien système inclus)</h2><p class="mut">Argent débité au client mais jamais livré. <b>Vérifiez d'abord dans votre Mobile Money si vous l'avez déjà payé</b> : « Déjà payé » ferme la ligne sans rembourser ; « Rembourser » recrédite le client (montant + commission) une seule fois.</p>
<div id="auto" class="mut"></div><table id="sk"></table>
<button onclick="refundSel()">Rembourser la sélection</button><button class="sec" onclick="selAll()">Tout sélectionner</button><button class="sec" onclick="reverify()">Re-vérifier les dépôts PayDunya</button></div>
<div class="card"><h2>Avis, critiques et limites des clients</h2><table id="fb"></table></div>
</div>
<script>
const $=i=>document.getElementById(i),f=n=>new Intl.NumberFormat('fr-FR').format(Math.round(n||0));
const esc=t=>String(t==null?'':t).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function call(p,m){const r=await fetch(p,{method:m||'GET',headers:{'x-admin-key':$('key').value}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Erreur');return d}
function show(r){$('out').classList.remove('hide');$('st').textContent=r.status;$('st').className=r.status==='OK'?'ok':'bad';
$('al').innerHTML=(r.alerts||[]).map(a=>'⚠ '+esc(a)).join('<br>');
$('kp').innerHTML=[['Clients',r.users.total],['Nouveaux 24 h',r.users.new_24h],['Soldes cumulés (FCFA)',f(r.wallets.total_balance)],['Commissions 24 h',f(r.commissions.commissions_24h)],['Commissions totales',f(r.commissions.commissions_total)],['Avis reçus',r.feedback.total+' (moy. '+r.feedback.avg_rating+')']].map(x=>'<div>'+x[0]+'<b>'+esc(x[1])+'</b></div>').join('');
$('gen').textContent='Généré le '+new Date(r.generatedAt).toLocaleString('fr-FR');
$('fl').innerHTML='<tr><th>Type</th><th>Statut</th><th>Nb</th><th>Total</th></tr>'+(r.flows24h||[]).map(x=>`<tr><td>${esc(x.type)}</td><td>${esc(x.status)}</td><td>${x.n}</td><td>${f(x.total)}</td></tr>`).join('');
$('nc').innerHTML='<tr><th>Type</th><th>Montant</th><th>Fournisseur</th><th>Statut</th><th>Âge</th></tr>'+((r.notCompleted||[]).map(x=>`<tr><td>${esc(x.type)}</td><td>${f(x.amount)}</td><td>${esc(x.provider)}</td><td>${esc(x.status)}</td><td>${x.age_minutes} min</td></tr>`).join('')||'<tr><td colspan=5 class="ok">Aucune</td></tr>')}
async function load(){$('err').textContent='';try{const d=await call('/api/omnicheck/report');show(d.live);await loadDash();await loadManual();await loadStuck();const fb=await call('/api/omnicheck/feedback');
$('fb').innerHTML='<tr><th>Date</th><th>Type</th><th>Note</th><th>Message</th><th>Contact</th></tr>'+(fb.feedback.map(x=>`<tr><td>${new Date(x.created_at).toLocaleDateString('fr-FR')}</td><td>${esc(x.category)}</td><td>${esc(x.rating)}</td><td>${esc(x.message)}</td><td>${esc(x.contact)}</td></tr>`).join('')||'<tr><td colspan=5 class="mut">Aucun avis pour le moment</td></tr>')}catch(e){$('err').textContent=e.message}}

async function post(p,b){const r=await fetch(p,{method:'POST',headers:{'x-admin-key':$('key').value,'content-type':'application/json'},body:JSON.stringify(b||{})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Erreur');return d}
const LV={ok:'<span class="ok">✔ OK</span>',warn:'<span class="bad">⚠ À voir</span>',bad:'<span style="color:var(--err)">✖ À corriger</span>'};
function chart(sr){const W=640,H=180,pad=24,n=sr.length,max=Math.max(1,...sr.map(x=>Math.max(x.entrees,x.sorties))),bw=(W-pad)/n;
 let g='';sr.forEach((x,i)=>{const x0=pad+i*bw,h1=x.entrees/max*(H-30),h2=x.sorties/max*(H-30);
  g+=`<rect x="${x0+bw*.1}" y="${H-20-h1}" width="${bw*.38}" height="${h1}" fill="#34e8b0"><title>${x.day} entrées ${f(x.entrees)}</title></rect><rect x="${x0+bw*.5}" y="${H-20-h2}" width="${bw*.38}" height="${h2}" fill="#ffcc4d"><title>${x.day} sorties ${f(x.sorties)}</title></rect>`});
 return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;background:#0b1426;border-radius:10px"><text x="4" y="12" fill="#8fa0bf" font-size="10">${f(max)}</text><line x1="${pad}" x2="${W}" y1="${H-20}" y2="${H-20}" stroke="#22304d"/>${g}<text x="${pad}" y="${H-4}" fill="#8fa0bf" font-size="10">${sr[0].day}</text><text x="${W-60}" y="${H-4}" fill="#8fa0bf" font-size="10">${sr[n-1].day}</text></svg>`}
async function loadDash(){const d=await call('/api/admin/dash?days=30');const k=d.kpi;
 $('dk').innerHTML=[['Clients',k.clients],['Soldes cumulés',f(k.soldes)+' F'],['Entrées totales',f(k.entrees_total)+' F'],['Sorties totales',f(k.sorties_total)+' F'],['Commissions',f(k.commissions_total)+' F']].map(x=>`<div>${x[0]}<b>${x[1]}</b></div>`).join('');
 $('ch').innerHTML=chart(d.series);const t=d.series.reduce((a,x)=>({e:a.e+x.entrees,s:a.s+x.sorties,t:a.t+x.transferts,c:a.c+x.commissions}),{e:0,s:0,t:0,c:0});
 $('chl').textContent=`30 jours : entrées ${f(t.e)} F · sorties ${f(t.s)} F · transferts internes ${f(t.t)} F · commissions ${f(t.c)} F`;
 const r=d.requests;$('rq').innerHTML=[['Retraits bloqués',r.stuckWithdrawals],['Dépôts PayDunya en attente',r.pendingDeposits],['Dépôts directs à valider',r.manualDeposits],['Retraits directs à payer',r.manualPayouts]].map(x=>`<div>${x[0]}<b class="${x[1]?'bad':'ok'}">${x[1]}</b></div>`).join('');
 $('an').innerHTML=(d.anomalies.length?d.anomalies.map(a=>'⚠ '+esc(a)).join('<br>'):'<span class="ok">Aucune anomalie détectée.</span>')+(d.accountsWithoutId?'<br>⚠ '+d.accountsWithoutId+' client(s) sans identifiant OM (bouton ci-dessus).':'');
 $('sec').innerHTML='<tr><th>Contrôle</th><th>État</th><th>Détail</th></tr>'+d.security.map(x=>`<tr><td>${esc(x.item)}</td><td>${LV[x.level]||''}</td><td class="mut">${esc(x.note)}</td></tr>`).join('');
 $('gp').innerHTML=d.gaps.length?'<tr><th>Client</th><th>Solde</th><th>Attendu (journal)</th></tr>'+d.gaps.map(g=>`<tr><td>${esc(g.email)}</td><td>${f(g.solde)}</td><td>${f(g.attendu)}</td></tr>`).join(''):'<tr><td class="ok">Aucun écart.</td></tr>';
 $('tp').innerHTML='<tr><th>Client</th><th>Solde</th><th>Entrées</th><th>Sorties</th><th>Envoyés</th><th>Reçus</th><th>Op.</th></tr>'+d.top.map(x=>`<tr><td>${esc(x.email)}</td><td>${f(x.solde)}</td><td>${f(x.entrees)}</td><td>${f(x.sorties)}</td><td>${f(x.envoyes)}</td><td>${f(x.recus)}</td><td>${x.operations}</td></tr>`).join('');
 $('ac').innerHTML=d.accounts.length?'<tr><th>Compte</th><th>Réseau</th><th>Adresse / numéro</th></tr>'+d.accounts.map(a=>`<tr><td>${esc(a.label)}</td><td>${esc(a.network)}</td><td style="word-break:break-all">${esc(a.detail)}</td></tr>`).join(''):'<tr><td class="bad">Aucun compte défini.</td></tr>'}
async function backfillIds(){try{const d=await post('/api/id/backfill');alert(d.created+' identifiant(s) créé(s).');await loadDash()}catch(x){$('err').textContent=x.message}}
async function exportXlsx(){try{const d=await call('/api/admin/export?days=90');if(!window.XLSX)return alert('Bibliothèque Excel non chargée (connexion ?).');
 const wb=XLSX.utils.book_new(),add=(n,a)=>XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(a.length?a:[{info:'aucune donnée'}]),n);
 add('Transactions',d.transactions);add('Clients',d.clients);add('Depots directs',d.deposits);add('Retraits directs',d.payouts);
 XLSX.writeFile(wb,'omnipay-export-'+new Date().toISOString().slice(0,10)+'.xlsx')}catch(x){$('err').textContent=x.message}}
async function loadStuck(){const d=await call('/api/ops/stuck');$('auto').textContent='Envoi automatique PayDunya : '+(d.autoPayout?'ACTIVÉ':'désactivé (traitement manuel)');
 $('sk').innerHTML='<tr><th></th><th>Client</th><th>Opérateur</th><th>Numéro</th><th>FCFA</th><th>Statut</th><th>Âge</th><th></th></tr>'+(d.withdrawals.length?d.withdrawals.map(x=>`<tr><td><input type="checkbox" class="sel" value="${esc(x.id)}" style="width:auto"></td><td>${esc(x.email)}</td><td>${esc(x.operator)}</td><td>${esc(x.phone)}</td><td>${f(x.amount)}+${f(x.fee)}</td><td>${esc(x.status)}</td><td>${Math.round((Date.now()-new Date(x.created_at))/86400000)} j</td><td><button class="sec" data-a="wpaid" data-id="${esc(x.id)}">Déjà payé</button></td></tr>`).join(''):'<tr><td colspan="8" class="ok">Aucun retrait bloqué.</td></tr>');}
function selAll(){document.querySelectorAll('.sel').forEach(c=>c.checked=true)}
async function refundSel(){const ids=[...document.querySelectorAll('.sel:checked')].map(c=>c.value);if(!ids.length)return alert('Sélectionnez au moins une ligne.');
 if(!confirm(`Rembourser ${ids.length} retrait(s) ? Chaque client est recrédité (montant + commission) UNE seule fois. Vérifiez que vous ne les avez pas déjà payés.`))return;
 try{const d=await post('/api/ops/refund',{ids,includeFee:true,note:'Remboursement administrateur'});alert(`${d.refundedCount} remboursé(s), total ${f(d.totalRefunded)} FCFA. Ignorés : ${d.skipped.length}.`);await loadStuck()}catch(x){$('err').textContent=x.message}}
async function reverify(){try{const d=await post('/api/ops/deposits/reverify');alert(`Vérifiés : ${d.checked}, crédités : ${d.credited}, non payés : ${d.unpaid}, erreurs : ${d.errors}.`)}catch(x){$('err').textContent=x.message}}
async function loadManual(){const d=await call('/api/manual/admin/pending');
 $('md').innerHTML='<tr><th>Réf.</th><th>Client</th><th>Moyen</th><th>Montant</th><th>Preuve</th><th></th></tr>'+(d.deposits.map(x=>`<tr><td>${esc(x.reference)}</td><td>${esc(x.email||x.phone)}</td><td>${esc(x.method)}</td><td>${esc(x.amount)} ${esc(x.currency)}</td><td style="word-break:break-all">${esc(x.tx_ref)}</td><td><button class="sec" data-a="credit" data-id="${esc(x.id)}" data-cur="${esc(x.currency)}" data-amt="${esc(x.amount)}">Créditer</button><button class="sec" data-a="drej" data-id="${esc(x.id)}">Refuser</button></td></tr>`).join('')||'<tr><td colspan=6 class="ok">Aucun dépôt en attente</td></tr>');
 $('mp').innerHTML='<tr><th>Réf.</th><th>Client</th><th>Moyen</th><th>Destination</th><th>FCFA</th><th></th></tr>'+(d.payouts.map(x=>`<tr><td>${esc(x.reference)}</td><td>${esc(x.email||x.phone)}</td><td>${esc(x.method)}</td><td style="word-break:break-all">${esc(x.destination)}</td><td>${f(x.amount)}</td><td><button class="sec" data-a="paid" data-id="${esc(x.id)}">Payé</button><button class="sec" data-a="prej" data-id="${esc(x.id)}">Refuser</button></td></tr>`).join('')||'<tr><td colspan=6 class="ok">Aucun retrait en attente</td></tr>')}
document.addEventListener('click',async e=>{const b=e.target.closest('button[data-a]');if(!b)return;const id=b.dataset.id,a=b.dataset.a;$('err').textContent='';
 try{
  if(a==='credit'){const v=prompt(`Montant en FCFA à créditer (le client a déclaré ${b.dataset.amt} ${b.dataset.cur}) :`);if(!v)return;if(!confirm(`Créditer ${v} FCFA ? Cette action ne peut pas être répétée.`))return;await post(`/api/manual/admin/deposit/${id}/credit`,{amountXof:Number(v)})}
  else if(a==='drej'){const n=prompt('Motif du refus (facultatif) :');if(n===null)return;await post(`/api/manual/admin/deposit/${id}/reject`,{note:n})}
  else if(a==='wpaid'){if(!confirm('Confirmez-vous avoir déjà payé ce retrait ? La ligne sera fermée sans remboursement.'))return;await post(`/api/ops/withdraw/${id}/paid`);await loadStuck();return}
  else if(a==='paid'){if(!confirm('Confirmez-vous avoir effectué ce paiement ?'))return;await post(`/api/manual/admin/payout/${id}/paid`)}
  else if(a==='prej'){const n=prompt('Motif du refus (facultatif) : le client sera remboursé.');if(n===null)return;await post(`/api/manual/admin/payout/${id}/reject`,{note:n})}
  await loadManual()}catch(x){$('err').textContent=x.message}});
async function run(){$('err').textContent='';try{const d=await call('/api/omnicheck/run','POST');show(d.report)}catch(e){$('err').textContent=e.message}}
</script></div></body></html>
