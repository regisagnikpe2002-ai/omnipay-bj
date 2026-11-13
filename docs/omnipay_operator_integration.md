# Omnipay operators integration guide

This document explains how to integrate operators (MTN, Moov, Celtis) with Omnipay.

Contents
- Required credentials
- Webhook format and verification
- Create payment flow
- Commission rules and reconciliation

Required credentials
- For each operator you must provide:
  - API base URL (sandbox/production)
  - API key or client credentials
  - Webhook secret (for HMAC signature validation)

Webhook format & verification
- Omnipay expects operator webhooks to contain at least:
  - order_id (our order id)
  - tx_id or transaction_id (operator transaction id)
  - amount
  - fees (optional)
  - currency (optional)
- Webhooks must be signed with HMAC-SHA256 using the operator-specific webhook secret and included in header X-Signature.
- Omnipay will verify signature, store raw payload in transactions.metadata.provider_response and then mark transaction confirmed.

Create payment flow
1. Client calls POST /payments/create with {client_id, operator, amount, phone}
2. Omnipay creates a pending transaction and calls the operator adapter to create instructions.
3. Adapter returns instructions (brand redacted as Omnipay) and Omnipay stores provider instruction in transactions.metadata.
4. Client follows the instruction and operator sends webhook to Omnipay when payment completes.
5. Omnipay updates transaction, calculates commission (via commission_rules) and creates splits.

Commission rules
- commission_rules table allows provider-specific or default rules.
- Default installed rule: fixed 50 XOF + 2.0%.
- Splits are created as rows in splits table: commission (Omnipay revenue) and merchant (net to beneficiary).

Testing
- Use the provided scripts to create payments and simulate webhooks with a correctly computed HMAC signature.

Security
- Do not commit operator keys to repo. Use Vault or environment variables for secrets.
- Protect admin endpoints with ADMIN_TOKEN + IP restrictions.

