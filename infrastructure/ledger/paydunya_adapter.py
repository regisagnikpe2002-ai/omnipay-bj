"""
PayDunya adapter (white-label) for Omnipay.

- Encapsulates interactions with PayDunya API.
- Reads API credentials from environment or via a Vault integration (placeholder).
- Always records raw provider responses for audit, but returns client-facing responses branded as Omnipay.

USAGE:
- Instantiate PayDunyaAdapter with a provider_config dict (public config only)
- Call create_invoice(order_id, amount, currency, return_url, callback_url, client_info)
- Use verify_webhook(payload_bytes, signature_header) to validate incoming webhooks

SECURITY:
- Do NOT hardcode API keys here. Use Vault / Secrets Manager in production.
- This adapter stores raw responses to be persisted by the caller in the transaction metadata.
"""
import os
import json
import hmac
import hashlib
import requests
from typing import Optional

from .utils.custom_data import build_custom_data


def _get_secret_from_env_or_vault(key: str) -> Optional[str]:
    """
    Placeholder helper: in prod, replace with a Vault client read.
    Falls back to environment variable if present.
    """
    # Example: for PayDunya API key, env var name could be PAYDUNYA_API_KEY
    return os.getenv(key)


class PayDunyaAdapter:
    def __init__(self, provider_config: dict):
        """
        provider_config (public): {
            'api_base': 'https://api.paydunya.example',
            'display_name': 'Omnipay',
            'timeout': 10
        }
        """
        self.public_config = provider_config or {}
        self.api_base = self.public_config.get('api_base', '').rstrip('/')
        self.display_name = self.public_config.get('display_name', 'Omnipay')
        self.timeout = int(self.public_config.get('timeout', 10))
        # Secrets: attempt to read from env (or replace with Vault access)
        self.api_key = _get_secret_from_env_or_vault('PAYDUNYA_API_KEY')
        self.webhook_secret = _get_secret_from_env_or_vault('PAYDUNYA_WEBHOOK_SECRET')

    def create_invoice(self, order_id: str, amount: float, currency: str, return_url: str, callback_url: str, client_info: dict) -> dict:
        """
        Create an invoice on PayDunya. Returns raw provider response as dict.
        The caller MUST persist the raw response into transactions.metadata.provider_response for audit.
        client_info will be used to build custom_data in the expected order.
        """
        if not self.api_base:
            raise RuntimeError('provider api_base not configured')

        # Build custom_data in the required kv_string format
        custom_kv, custom_json = build_custom_data(client_info or {})

        payload = {
            'order_id': order_id,
            'amount': amount,
            'currency': currency,
            'return_url': return_url,
            'callback_url': callback_url,
            # The exact key for custom data depends on PayDunya API; we use 'custom_data' per your spec
            'custom_data': custom_kv,
        }

        headers = {
            'Content-Type': 'application/json',
        }
        if self.api_key:
            headers['Authorization'] = f'Bearer {self.api_key}'

        url = f"{self.api_base}/invoices"
        resp = requests.post(url, json=payload, headers=headers, timeout=self.timeout)
        resp.raise_for_status()
        raw = resp.json()
        # Ensure raw includes custom_data for audit
        raw.setdefault('sent_custom_data', custom_json)
        return raw

    def verify_webhook(self, payload_bytes: bytes, signature_header: str, timestamp_header: Optional[str] = None) -> bool:
        """
        Verify webhook signature using webhook_secret. Also optionally verify timestamp.
        In production, fetch webhook_secret from Vault.
        """
        if not self.webhook_secret:
            # If secret not configured, reject
            return False
        computed = hmac.new(self.webhook_secret.encode(), payload_bytes, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(computed, signature_header):
            return False
        # Optional: verify timestamp_header to prevent replay (provider must send timestamp)
        # if timestamp_header:
        #     verify timestamp skew
        return True

    def mask_provider_response_for_client(self, provider_response: dict) -> dict:
        """
        Build a client-safe response (white-label) from raw provider response.
        Do NOT include provider internal ids or debug fields.
        """
        client_resp = {
            'provider': self.display_name,
            'invoice_url': provider_response.get('invoice_url') or provider_response.get('payment_url') or provider_response.get('url'),
            'instructions': f'Payer via {self.display_name} en suivant ce lien.'
        }
        return client_resp


# Example usage (do not run in production as-is):
if __name__ == '__main__':
    cfg = {'api_base': 'https://sandbox.paydunya.example', 'display_name': 'Omnipay', 'timeout': 10}
    adapter = PayDunyaAdapter(cfg)
    client_info = {
        'activity_type': 'money_transfer',
        'user_name': 'Oumar FALL',
        'user_number': '+221771234567',
        'user_email': 'oumar@customdata.com',
        'user_country_code': 'SN'
    }
    try:
        raw = adapter.create_invoice('ORD-EXAMPLE', 500, 'XOF', 'https://www.omnipay-bj.com/return', 'https://www.omnipay-bj.com/webhook', client_info)
        print('RAW RESPONSE (store this in metadata):', json.dumps(raw, indent=2))
        print('CLIENT SAFE:', adapter.mask_provider_response_for_client(raw))
    except Exception as e:
        print('Error (example run):', e)
