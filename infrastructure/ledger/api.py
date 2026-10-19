"""
Updated API: adds SMS delivery of OTP via Twilio when client has phone and no email.

No secrets are stored here. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER in env to enable SMS.
"""

from fastapi import FastAPI, Request, HTTPException, Header
from pydantic import BaseModel
import os
import hmac
import hashlib
import json
import uuid
import random
from datetime import datetime, timedelta
import psycopg2
from psycopg2.extras import RealDictCursor
import logging

# import the local virtual card creator utility
from .virtual_card_generator import create_virtual_card

app = FastAPI()

DATABASE_URL = os.getenv('DATABASE_URL')
WEBHOOK_SECRET = os.getenv('WEBHOOK_SECRET')
ADMIN_TOKEN = os.getenv('ADMIN_TOKEN')
BASE_URL = os.getenv('BASE_URL', 'https://www.omnipay-bj.com')
ISSUANCE_PRICE = float(os.getenv('ISSUANCE_PRICE', '500'))
CURRENCY = os.getenv('CURRENCY', 'XOF')

# Twilio envs
TWILIO_ACCOUNT_SID = os.getenv('TWILIO_ACCOUNT_SID')
TWILIO_AUTH_TOKEN = os.getenv('TWILIO_AUTH_TOKEN')
TWILIO_FROM_NUMBER = os.getenv('TWILIO_FROM_NUMBER')

if DATABASE_URL is None:
    raise RuntimeError('DATABASE_URL must be set in environment')

logging.basicConfig(level=logging.INFO)


def get_conn():
    return psycopg2.connect(DATABASE_URL)


def generate_order_id():
    return f'ORD-{uuid.uuid4().hex[:12].upper()}'


def create_payment_instruction(provider, amount, currency, order_id):
    # Placeholder: adapt to real provider integration
    if provider == 'paydunya':
        return {
            'provider': 'paydunya',
            'invoice_url': f'https://paydunya.example.com/invoice/{order_id}',
            'instructions': f'Pay {amount} {currency} via PayDunya, invoice {order_id}'
        }
    # default internal instruction (bank transfer placeholder)
    return {
        'provider': 'bank_transfer',
        'instructions': f'Transfer {amount} {currency} to our account with reference {order_id}'
    }


def send_sms(to_number, message):
    if not (TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER):
        logging.info('Twilio credentials not set, skipping SMS send (to=%s, message=%s)', to_number, message)
        return False
    try:
        from twilio.rest import Client
        client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
        msg = client.messages.create(body=message, from_=TWILIO_FROM_NUMBER, to=to_number)
        logging.info('SMS sent sid=%s to=%s', getattr(msg, 'sid', None), to_number)
        return True
    except Exception as e:
        logging.exception('Failed to send SMS')
        return False


def create_otp(conn, client_id, order_id, purpose='login', ttl_minutes=10):
    code = '{:06d}'.format(random.randint(0, 999999))
    expires = datetime.utcnow() + timedelta(minutes=ttl_minutes)
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO otps (client_id, order_id, otp_code, purpose, expires_at, metadata, created_at) VALUES (%s,%s,%s,%s,%s,%s,now()) RETURNING id",
        (client_id, order_id, code, purpose, expires, json.dumps({'generated_via':'api'}))
    )
    new_id = cur.fetchone()[0]
    conn.commit()
    cur.close()
    login_url = f"{BASE_URL}/login?otp={code}&client_id={client_id}"
    receipt_url = f"{BASE_URL}/receipt?order_id={order_id}"

    # Attempt to send SMS if client has phone and no email
    try:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute('SELECT * FROM clients WHERE id = %s', (client_id,))
        client = cur.fetchone()
        phone = None
        email = None
        if client:
            email = client.get('email')
            meta = client.get('metadata') or {}
            if isinstance(meta, dict):
                phone = meta.get('phone') or meta.get('telephone')
        # If client has phone and no email, send SMS with OTP and links
        if phone and not email:
            sms_message = f"Omnipay: votre code OTP {code}. Accedez: {login_url}"
            send_sms(phone, sms_message)
    except Exception:
        logging.exception('Failed to lookup client for SMS send')

    return code, login_url, receipt_url


class PurchaseRequest(BaseModel):
    client_id: str
    provider: str = 'paydunya'


@app.post('/virtual-cards/purchase')
def purchase_card(req: PurchaseRequest):
    conn = get_conn()
    try:
        order_id = generate_order_id()
        # insert pending transaction
        cur = conn.cursor()
        metadata = {'client_id': req.client_id}
        cur.execute(
            "INSERT INTO transactions (order_id, provider, type, direction, gross_amount, currency, status, metadata, created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,now()) RETURNING id",
            (order_id, req.provider, 'issuance_fee', 'in', ISSUANCE_PRICE, CURRENCY, 'pending', json.dumps(metadata))
        )
        tx_id = cur.fetchone()[0]
        conn.commit()
        cur.close()

        # payment instruction
        payment_instruction = create_payment_instruction(req.provider, ISSUANCE_PRICE, CURRENCY, order_id)

        # generate OTP for quick login/receipt link and include base URL
        code, login_url, receipt_url = create_otp(conn, req.client_id, order_id)

        return {
            'order_id': order_id,
            'transaction_id': str(tx_id),
            'amount': ISSUANCE_PRICE,
            'currency': CURRENCY,
            'payment_instruction': payment_instruction,
            'otp_code': code,  # in prod, send via SMS/Email instead of returning
            'login_url': login_url,
            'receipt_url': receipt_url,
            'note': 'Après confirmation du paiement via le provider, la carte virtuelle sera émise et vous serez notifié.'
        }
    finally:
        conn.close()


def verify_hmac_signature(secret, payload_bytes, signature_header):
    if not signature_header:
        return False
    try:
        computed = hmac.new(secret.encode(), payload_bytes, hashlib.sha256).hexdigest()
        return hmac.compare_digest(computed, signature_header)
    except Exception:
        return False


@app.post('/webhooks/provider')
async def provider_webhook(request: Request, x_signature: str = Header(None)):
    body = await request.body()
    if WEBHOOK_SECRET:
        if not verify_hmac_signature(WEBHOOK_SECRET, body, x_signature):
            raise HTTPException(status_code=403, detail='Invalid signature')

    payload = await request.json()
    # Expected payload minimal fields: order_id, tx_id, amount, fees
    order_id = payload.get('order_id')
    provider_tx_id = payload.get('tx_id')
    amount = float(payload.get('amount', 0))
    fees = float(payload.get('fees', 0)) if payload.get('fees') is not None else 0

    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute('SELECT * FROM transactions WHERE order_id = %s', (order_id,))
        tx = cur.fetchone()
        if not tx:
            # optionally create a transaction record if not exists
            cur.execute(
                "INSERT INTO transactions (order_id, provider, type, direction, gross_amount, currency, status, provider_tx_id, provider_fees, net_amount, metadata, created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now()) RETURNING id",
                (order_id, payload.get('provider','unknown'), 'issuance_fee', 'in', amount, payload.get('currency', CURRENCY), 'confirmed', provider_tx_id, fees, amount - fees, json.dumps({'from_webhook': True}))
            )
            conn.commit()
            tx_id = cur.fetchone()[0]
            cur.close()
            # If created, attempt issue
            # fetch again
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute('SELECT * FROM transactions WHERE order_id = %s', (order_id,))
            tx = cur.fetchone()
        else:
            # update existing tx
            cur.execute(
                "UPDATE transactions SET provider_tx_id=%s, provider_fees=%s, net_amount=%s, status='confirmed', updated_at=now() WHERE order_id=%s",
                (provider_tx_id, fees, amount - fees, order_id)
            )
            conn.commit()

        # after confirmation, issue the virtual card
        issue_result = issue_card_after_payment(order_id, conn)
        return {'status': 'ok', 'issue_result': issue_result}
    finally:
        conn.close()


@app.post('/virtual-cards/issue-manual')
def issue_manual(payload: dict, x_admin_token: str = Header(None)):
    # manual endpoint protected by ADMIN_TOKEN
    if ADMIN_TOKEN is None or x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail='Forbidden')
    order_id = payload.get('order_id')
    if not order_id:
        raise HTTPException(status_code=400, detail='order_id required')
    conn = get_conn()
    try:
        res = issue_card_after_payment(order_id, conn)
        return {'status': 'ok', 'result': res}
    finally:
        conn.close()


def issue_card_after_payment(order_id, conn):
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute('SELECT * FROM transactions WHERE order_id = %s', (order_id,))
    tx = cur.fetchone()
    if not tx:
        return {'error': 'transaction not found'}
    if tx.get('status') != 'confirmed':
        return {'error': 'transaction not confirmed', 'status': tx.get('status')}
    # ensure amount is sufficient
    gross = float(tx.get('gross_amount') or 0)
    if gross < ISSUANCE_PRICE:
        return {'error': 'insufficient amount', 'gross': gross}

    # retrieve client id from metadata
    metadata = tx.get('metadata') or {}
    client_id = metadata.get('client_id') if isinstance(metadata, dict) else None
    if not client_id:
        return {'error': 'client_id missing in transaction metadata'}

    # optional KYC check (placeholder)
    cur.execute('SELECT * FROM clients WHERE id = %s', (client_id,))
    client = cur.fetchone()
    if not client:
        # create minimal client record
        cur2 = conn.cursor()
        cur2.execute("INSERT INTO clients (id, external_id, name, email, metadata, created_at) VALUES (%s,%s,%s,%s,%s,now())", (client_id, None, 'Client', None, json.dumps({'created_via':'issue'})))
        conn.commit()
        cur2.close()

    # call create_virtual_card from generator (this uses the same DB conn inside; pass conn if you refactor)
    card = create_virtual_card(conn, client_id, currency=CURRENCY, initial_balance=0)

    # update transaction metadata with virtual_card_id and mark reconciled
    cur.execute("UPDATE transactions SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{virtual_card_id}', to_jsonb(%s::text)), status='reconciled', updated_at=now() WHERE order_id = %s", (str(card['id']), order_id))
    conn.commit()

    # create internal revenue record (optional)
    cur.execute("INSERT INTO transactions (order_id, provider, type, direction, gross_amount, net_amount, currency, status, metadata, created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,now()) RETURNING id",
                (order_id + '-REV', 'omnipay_internal', 'issuance_revenue', 'in', gross, tx.get('net_amount') or gross, tx.get('currency') or CURRENCY, 'reconciled', json.dumps({'virtual_card_id': card['id']})))
    conn.commit()

    # prepare client-facing response including links to platform (BASE_URL)
    response = {
        'virtual_card': card,
        'receipt_url': f"{BASE_URL}/receipt?order_id={order_id}",
        'login_url': f"{BASE_URL}/login?client_id={client_id}"
    }
    return response
