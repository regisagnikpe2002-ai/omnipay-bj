"""
Webhook handlers for operator confirmations and routing to split logic.

This module exposes utility functions; the routes are expected to be integrated into your API (infrastructure/ledger/api.py or payments_api).
"""
import os
import hmac
import hashlib
import json
import logging
from psycopg2.extras import RealDictCursor
import psycopg2

from .business.splits import apply_commission_and_create_splits
from .adapters.mtn_adapter import MTNAdapter
from .adapters.moov_adapter import MoovAdapter
from .adapters.celtis_adapter import CeltisAdapter

logging.basicConfig(level=logging.INFO)

ADAPTER_MAP = {
    'mtn': MTNAdapter,
    'moov': MoovAdapter,
    'celtis': CeltisAdapter
}


def verify_signature(adapter, body_bytes, signature_header):
    try:
        return adapter.verify_webhook(body_bytes, signature_header)
    except Exception as e:
        logging.exception('verify_signature error')
        return False


def handle_operator_webhook(conn, operator, body_bytes, headers):
    """
    Generic webhook handler:
    - verify signature
    - parse payload (provider dependent)
    - update transaction row
    - call apply_commission_and_create_splits
    - return result
    """
    AdapterClass = ADAPTER_MAP.get(operator)
    if not AdapterClass:
        raise ValueError('unknown operator')
    adapter = AdapterClass()
    signature = headers.get('X-Signature') or headers.get('x-signature')
    if not verify_signature(adapter, body_bytes, signature):
        raise ValueError('invalid signature')

    payload = json.loads(body_bytes.decode('utf-8'))
    # Expected minimal fields: order_id, tx_id, amount, fees
    order_id = payload.get('order_id') or payload.get('reference')
    provider_tx_id = payload.get('tx_id') or payload.get('transaction_id')
    amount = payload.get('amount')
    fees = payload.get('fees', 0)

    cur = conn.cursor(cursor_factory=RealDictCursor)
    # find transaction by order_id
    cur.execute('SELECT * FROM transactions WHERE order_id = %s', (order_id,))
    tx = cur.fetchone()
    if not tx:
        # create transaction if not exists (webhook from operator with no prior create)
        cur.execute(
            "INSERT INTO transactions (order_id, provider, provider_tx_id, type, direction, gross_amount, currency, provider_fees, net_amount, status, metadata, created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now()) RETURNING id",
            (order_id, operator, provider_tx_id, 'issuance_fee', 'in', amount, payload.get('currency','XOF'), fees, amount - fees if amount else None, 'confirmed', json.dumps({'from_webhook': True, 'raw': payload}))
        )
        tx_id = cur.fetchone()[0]
        conn.commit()
    else:
        # idempotence: if already confirmed skip
        if tx.get('status') == 'confirmed' or tx.get('status') == 'reconciled':
            return {'status': 'already_processed', 'transaction_id': str(tx.get('id'))}
        # update existing
        cur.execute("UPDATE transactions SET provider_tx_id=%s, provider_fees=%s, net_amount=%s, status='confirmed', metadata = jsonb_set(coalesce(metadata,'{}'::jsonb), '{provider_response}', to_jsonb(%s::json)), updated_at=now() WHERE order_id=%s",
                    (provider_tx_id, fees, amount - fees if amount else None, json.dumps(payload), order_id))
        conn.commit()
        cur.execute('SELECT * FROM transactions WHERE order_id = %s', (order_id,))
        tx = cur.fetchone()
        tx_id = tx.get('id')

    # apply commission and create splits
    res = apply_commission_and_create_splits(conn, tx_id)
    return {'status': 'ok', 'splits': res}
