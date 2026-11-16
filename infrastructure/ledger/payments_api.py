"""
Payments API for Omnipay operators: create payment, simulate webhook examples, payout requests.

This is a minimal FastAPI module that complements the existing api.py.
"""
from fastapi import APIRouter, Request, HTTPException, Header
from pydantic import BaseModel
import os
import json
import uuid
import psycopg2
from psycopg2.extras import RealDictCursor

from .adapters.mtn_adapter import MTNAdapter
from .adapters.moov_adapter import MoovAdapter
from .adapters.celtis_adapter import CeltisAdapter
from .webhooks import handle_operator_webhook

router = APIRouter()

ADAPTERS = {
    'mtn': MTNAdapter,
    'moov': MoovAdapter,
    'celtis': CeltisAdapter
}

DATABASE_URL = os.getenv('DATABASE_URL')

class CreatePaymentRequest(BaseModel):
    client_id: str
    operator: str
    amount: float
    phone: str
    metadata: dict = {}


@router.post('/payments/create')
def create_payment(req: CreatePaymentRequest):
    AdapterClass = ADAPTERS.get(req.operator)
    if not AdapterClass:
        raise HTTPException(status_code=400, detail='unsupported operator')

    conn = psycopg2.connect(DATABASE_URL)
    try:
        order_id = f'ORD-{uuid.uuid4().hex[:12].upper()}'
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO transactions (order_id, provider, type, direction, gross_amount, currency, status, metadata, created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,now()) RETURNING id",
            (order_id, req.operator, 'payment', 'in', req.amount, 'XOF', 'pending', json.dumps({'client_id': req.client_id, 'metadata': req.metadata}))
        )
        tx_id = cur.fetchone()[0]
        conn.commit()

        adapter = AdapterClass()
        callback_url = f"{os.getenv('BASE_URL','https://www.omnipay-bj.com')}/webhooks/{req.operator}"
        instruction = adapter.create_payment_instruction(order_id, req.amount, req.phone, callback_url, metadata=req.metadata)

        # store provider instruction in metadata
        cur.execute("UPDATE transactions SET metadata = jsonb_set(coalesce(metadata,'{}'::jsonb), '{provider_instruction}', to_jsonb(%s::json)) WHERE id = %s", (json.dumps(instruction), tx_id))
        conn.commit()

        client_safe = {'provider': 'Omnipay', 'instruction': instruction.get('instruction')}
        return {'order_id': order_id, 'transaction_id': str(tx_id), 'instruction': client_safe}
    finally:
        conn.close()


@router.post('/webhooks/{operator}')
async def operator_webhook(operator: str, request: Request, x_signature: str = Header(None)):
    body = await request.body()
    conn = psycopg2.connect(DATABASE_URL)
    try:
        res = handle_operator_webhook(conn, operator, body, {'X-Signature': x_signature})
        return res
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        conn.close()


@router.post('/payouts/request')
def request_payout(payload: dict):
    # minimal: create payout record for a split
    split_id = payload.get('split_id')
    method = payload.get('method')
    to_identifier = payload.get('to')
    conn = psycopg2.connect(DATABASE_URL)
    try:
        cur = conn.cursor()
        cur.execute("SELECT * FROM splits WHERE id = %s", (split_id,))
        split = cur.fetchone()
        if not split:
            raise HTTPException(status_code=404, detail='split not found')
        cur.execute("INSERT INTO payouts (split_id, payout_method, to_identifier, amount, currency, status, created_at) VALUES (%s,%s,%s,%s,%s,%s,now()) RETURNING id",
                    (split_id, method, to_identifier, split[3], split[4], 'requested'))
        payout_id = cur.fetchone()[0]
        conn.commit()
        return {'payout_id': str(payout_id), 'status': 'requested'}
    finally:
        conn.close()


@router.post('/payouts/approve')
def approve_payout(payload: dict, x_admin_token: str = Header(None)):
    # admin approves and marks payout processing; real processing to be implemented
    ADMIN_TOKEN = os.getenv('ADMIN_TOKEN')
    if ADMIN_TOKEN is None or x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail='forbidden')
    payout_id = payload.get('payout_id')
    conn = psycopg2.connect(DATABASE_URL)
    try:
        cur = conn.cursor()
        cur.execute("UPDATE payouts SET status = 'processing', updated_at = now() WHERE id = %s RETURNING id", (payout_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail='payout not found')
        conn.commit()
        return {'payout_id': payout_id, 'status': 'processing'}
    finally:
        conn.close()
