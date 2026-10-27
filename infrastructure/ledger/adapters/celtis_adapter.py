"""
Celtis adapter skeleton for Omnipay operators integration.

This file is a placeholder. Implement the operator's API details when available.
"""
import os
import hmac
import hashlib

class CeltisAdapter:
    def __init__(self, config=None):
        self.config = config or {}
        self.api_base = self.config.get('api_base', os.getenv('CELTIS_API_BASE', ''))
        self.api_key = os.getenv('CELTIS_API_KEY')
        self.webhook_secret = os.getenv('CELTIS_WEBHOOK_SECRET')
        self.display_name = self.config.get('display_name', 'Omnipay')

    def create_payment_instruction(self, order_id, amount, phone, callback_url, metadata=None):
        instruction = {
            'provider': self.display_name,
            'instruction': f'Envoyez {amount} XOF via Celtis au {phone}. Référence {order_id}',
            'provider_payload': {'order_id': order_id, 'amount': amount}
        }
        return instruction

    def verify_webhook(self, payload_bytes, signature_header):
        if not self.webhook_secret:
            return False
        computed = hmac.new(self.webhook_secret.encode(), payload_bytes, hashlib.sha256).hexdigest()
        return hmac.compare_digest(computed, signature_header)

    def fetch_payment_status(self, provider_tx_id):
        return {'status': 'unknown', 'amount': None}

