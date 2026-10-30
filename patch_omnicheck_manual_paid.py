from pathlib import Path

p = Path('public/omnicheck.html')
s = p.read_text(encoding='utf-8')
old = "else if(a==='paid'){if(!confirm('Confirmez-vous avoir effectue ce paiement ?'))return;await post(`/api/manual/admin/payout/${id}/paid`)}"
if old not in s:
    old = "else if(a==='paid'){if(!confirm('Confirmez-vous avoir effectué ce paiement ?'))return;await post(`/api/manual/admin/payout/${id}/paid`)}"
new = "else if(a==='paid'){const ref=prompt('Reference reelle PI-SPI, txId ou end2endId :');if(ref===null)return;const paymentRef=ref.trim();if(paymentRef.length<6)return alert('Reference invalide : 6 caracteres minimum.');if(!confirm('Confirmer le paiement reel avec la reference '+paymentRef+' ?'))return;await post(`/api/manual/admin/payout/${id}/paid`,{paymentRef,channel:'pispi'})}"
if old not in s:
    raise SystemExit('ERREUR: gestionnaire paid introuvable')
p.write_text(s.replace(old,new,1), encoding='utf-8')
print('OK: bouton Paye manuel securise par reference PI-SPI')
