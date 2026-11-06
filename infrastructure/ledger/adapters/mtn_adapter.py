"""
MTN adapter skeleton for Omnipay operators integration.

This is a minimal scaffold. In production replace env-derived secrets with Vault and implement the real API calls per MTN's API.
"""
import os
import hmac
import hashlib
import json

class MTNAdapter:
    def __init__(self, config=None):
        self.config = config or {}
        self.api_base = self.config.get('api_base', os.getenv('MTN_API_BASE', ''))
        self.api_key = os.getenv('MTN_API_KEY')
        self.webhook_secret = os.getenv('MTN_WEBHOOK_SECRET')
        self.display_name = self.config.get('display_name', 'Omnipay')

    def create_payment_instruction(self, order_id, amount, phone, callback_url, metadata=None):
        """Return a client-safe payment instruction for MTN (placeholder)."""
        # In real integration: call MTN API to create collection request / invoice
        instruction = {
            'provider': self.display_name,
            'instruction': f'Envoyez {amount} XOF au {phone} via MTN Money. Référence {order_id}',
            'provider_payload': {'order_id': order_id, 'amount': amount}
        }
        return instruction

    def verify_webhook(self, payload_bytes, signature_header):
        """Verify HMAC signature using webhook_secret"""
        if not self.webhook_secret:
            return False
        computed = hmac.new(self.webhook_secret.encode(), payload_bytes, hashlib.sha256).hexdigest()
        return hmac.compare_digest(computed, signature_header)

    def fetch_payment_status(self, provider_tx_id):
        """Placeholder to fetch payment status from MTN"""
        # Implement API call to fetch transaction status
        return {'status': 'unknown', 'amount': None}

