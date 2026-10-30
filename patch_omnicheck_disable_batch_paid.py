from pathlib import Path

p = Path('public/omnicheck.html')
s = p.read_text(encoding='utf-8')

button = '<button class="sec" onclick="paidSel()">Marquer la selection comme payee</button>'
button_fr = '<button class="sec" onclick="paidSel()">Marquer la sélection comme payée</button>'

if button_fr in s:
    s = s.replace(button_fr, '', 1)
elif button in s:
    s = s.replace(button, '', 1)
else:
    raise SystemExit('ERREUR: bouton paidSel introuvable')

start = s.find('async function paidSel(){')
end = s.find('\nfunction selAll()', start)
if start < 0 or end < 0:
    raise SystemExit('ERREUR: fonction paidSel introuvable')

s = s[:start] + s[end + 1:]
p.write_text(s, encoding='utf-8')
print('OK: paiement en lot retire de OMNICHECK')
