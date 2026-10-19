# Webhook HMAC example (Python)

Ce document explique comment vérifier la signature HMAC d'un webhook provider (modèle général).

1) Principe
- Le provider envoie le payload JSON et une en-tête (ex: X-Signature) contenant une signature HMAC-SHA256 du payload
- Vous stockez la clé secrète du webhook dans Vault, puis vérifiez la signature avant de traiter le payload

2) Exemple minimal (Flask)

```python
from flask import Flask, request, abort
import hmac
import hashlib
import os

app = Flask(__name__)
WEBHOOK_SECRET = os.getenv('WEBHOOK_SECRET')

@app.route('/webhook', methods=['POST'])
def webhook():
    signature = request.headers.get('X-Signature')
    if signature is None:
        abort(400)
    payload = request.data
    computed = hmac.new(WEBHOOK_SECRET.encode(), payload, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(computed, signature):
        abort(403)
    # traiter le payload
    return '', 204

if __name__ == '__main__':
    app.run(port=8000)
```

3) Bonnes pratiques
- Valider aussi le timestamp pour éviter replay attacks (include timestamp in header and reject old timestamps)
- Limiter la taille du payload
- Loguer les tentatives de signature échouées dans audit_logs
- Ne jamais loguer la clé secrète

