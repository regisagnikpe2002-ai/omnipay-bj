"""
Adapter skeleton for GoCardless (SEPA) - stubbed for sandbox simulation.
In production, implement the HTTP calls, auth, webhooks verification, and idempotency handling.
"""
import os
import uuid

class GoCardlessAdapter:
    def __init__(self):
        self.api_key = os.getenv('GOCARDLESS_API_KEY')
        self.sandbox = os.getenv('GOCARDLESS_SANDBOX', 'true').lower() == 'true'

    def create_mandate(self, bank_account_id: str, params: dict) -> dict:
        return {'status': 'created', 'provider_mandate_id': f'GC-M-{uuid.uuid4().hex[:12]}'}

    def create_payment(self, subscription_id: str, amount: str, currency: str) -> dict:
        return {'status': 'success', 'provider_tx_id': f'GCPAY-{uuid.uuid4().hex[:12]}'}

    def verify_webhook(self, headers: dict, body: bytes) -> bool:
        return True
