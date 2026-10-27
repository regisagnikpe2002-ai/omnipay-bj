"""
Gift card + coupon redemption service for Omnipay.

This module supports:
- list offers
- create purchase by gift card offer
- redeem gift card code (coupon) to user wallet
- log redemption attempts
- maintain wallet balance and transaction history

IMPORTANT: keep codes private. In production do not return plain codes in JSON after sell-delivery.
"""
import os
import uuid
import json
import hashlib
from datetime import datetime
from decimal import Decimal

from fastapi import APIRouter, HTTPException, Request, Header
from pydantic import BaseModel
import psycopg2
from psycopg2.extras import RealDictCursor

router = APIRouter()
DATABASE_URL = os.getenv('DATABASE_URL')
BASE_URL = os.getenv('BASE_URL', 'https://www.omnipay-bj.com')


def get_conn():
    return psycopg2.connect(DATABASE_URL)


def mask_code(code: str) -> str:
    if not code:
        return ''
    if len(code) <= 8:
        return code[:2] + '****' + code[-2:]
    return code[:4] + '****' + code[-4:]


class CreateOfferRequest(BaseModel):
    provider: str
    provider_label: str
    nominal_value: float
    currency: str = 'EUR'
    sale_price: float
    markup_pct: float = 0.0
    active: bool = True
    metadata: dict = {}


class PurchaseRequest(BaseModel):
    user_id: str
    offer_id: str
    amount_paid: float | None = None


class RedeemRequest(BaseModel):
    user_id: str
    code: str
    ip: str | None = None
    user_agent: str | None = None


@router.get('/giftcards/offers')
def list_offers():
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute('SELECT * FROM gift_card_offers WHERE active = TRUE ORDER BY created_at DESC')
        rows = cur.fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.post('/giftcards/offers/create')
def create_offer(req: CreateOfferRequest):
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO gift_card_offers (id, provider, provider_label, nominal_value, currency, sale_price, markup_pct, active, metadata, created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,now())",
            (str(uuid.uuid4()), req.provider, req.provider_label, req.nominal_value, req.currency, req.sale_price, req.markup_pct, req.active, json.dumps(req.metadata))
        )
        conn.commit()
        return {'status': 'created'}
    finally:
        conn.close()


@router.post('/giftcards/purchase')
def purchase_giftcard(req: PurchaseRequest):
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute('SELECT * FROM gift_card_offers WHERE id = %s AND active = TRUE', (req.offer_id,))
        offer = cur.fetchone()
        if not offer:
            raise HTTPException(status_code=404, detail='offer not found')

        order_id = f'GIFT-{uuid.uuid4().hex[:12].upper()}'
        amount_paid = req.amount_paid if req.amount_paid is not None else float(offer['sale_price'])
        cur.execute(
            "INSERT INTO gift_card_sales (id, user_id, offer_id, order_id, amount_paid, currency, status, created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,now())",
            (str(uuid.uuid4()), req.user_id, req.offer_id, order_id, amount_paid, offer['currency'], 'pending')
        )
        conn.commit()
        return {
            'order_id': order_id,
            'offer_id': req.offer_id,
            'amount_paid': amount_paid,
            'currency': offer['currency'],
            'note': 'Le client doit maintenant utiliser le code pour recharger son compte Omnipay.'
        }
    finally:
        conn.close()


@router.post('/giftcards/redeem')
def redeem_code(req: RedeemRequest, request: Request):
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        code = req.code.strip()
        ip = req.ip or request.client.host if request.client else None
        user_agent = req.user_agent or request.headers.get('user-agent')

        # Lock inventory row for safe redemption
        cur.execute("SELECT * FROM gift_card_inventory WHERE code = %s FOR UPDATE", (code,))
        inv = cur.fetchone()
        if not inv:
            cur.execute("INSERT INTO redemption_logs (user_id, inventory_id, code_masked, attempt_result, details, ip, user_agent, created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,now())",
                        (req.user_id, None, mask_code(code), 'invalid', json.dumps({'reason': 'code not found'}), ip, user_agent))
            conn.commit()
            raise HTTPException(status_code=400, detail='Code invalide')

        if inv['status'] != 'available':
            cur.execute("INSERT INTO redemption_logs (user_id, inventory_id, code_masked, attempt_result, details, ip, user_agent, created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,now())",
                        (req.user_id, inv['id'], mask_code(code), 'already_redeemed', json.dumps({'status': inv['status']}), ip, user_agent))
            conn.commit()
            raise HTTPException(status_code=400, detail='Code déjà utilisé')

        # Acquire offer value for this inventory row
        cur.execute('SELECT * FROM gift_card_offers WHERE id = %s', (inv['offer_id'],))
        offer = cur.fetchone()
        if not offer:
            raise HTTPException(status_code=404, detail='offer missing')

        nominal = Decimal(str(offer['nominal_value']))
        currency = offer['currency']

        # Set redeemed status and lock inventory row
        cur.execute("UPDATE gift_card_inventory SET status = 'redeemed', redeemed_by = %s, redeemed_at = now() WHERE id = %s", (req.user_id, inv['id']))

        # Create wallet if needed
        cur.execute("INSERT INTO user_wallets (user_id, currency, balance) VALUES (%s,%s,%s) ON CONFLICT (user_id) DO NOTHING", (req.user_id, currency, 0))

        # Grant credited amount to user wallet
        cur.execute("UPDATE user_wallets SET balance = balance + %s, updated_at = now() WHERE user_id = %s", (nominal, req.user_id))

        # Create transaction row for redemption
        tx_id = str(uuid.uuid4())
        cur.execute(
            "INSERT INTO transactions (id, order_id, provider, type, direction, gross_amount, currency, status, metadata, created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,now())",
            (tx_id, f'GIFT-{uuid.uuid4().hex[:12].upper()}', 'omnigift', 'gift_redeem', 'in', str(nominal), currency, 'confirmed', json.dumps({'inventory_id': str(inv['id']), 'code_masked': mask_code(code), 'offer_id': str(offer['id'])}), )
        )

        # Create gift_card_sales row as delivered
        cur.execute(
            "INSERT INTO gift_card_sales (id, user_id, offer_id, inventory_id, order_id, amount_paid, currency, status, delivered_code, created_at, delivered_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,now(),now())",
            (str(uuid.uuid4()), req.user_id, offer['id'], inv['id'], f'GIFT-{uuid.uuid4().hex[:12].upper()}', nominal, currency, 'delivered', mask_code(code))
        )

        # Audit log
        cur.execute(
            "INSERT INTO redemption_logs (user_id, inventory_id, code_masked, attempt_result, details, ip, user_agent, created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,now())",
            (req.user_id, inv['id'], mask_code(code), 'success', json.dumps({'credited_amount': str(nominal), 'currency': currency}), ip, user_agent)
        )

        conn.commit()
        return {
            'status': 'success',
            'currency': currency,
            'credited_amount': str(nominal),
            'message': 'Votre compte Omnipay a été crédité avec succès.',
            'receipt_link': f"{BASE_URL}/receipt?code={mask_code(code)}"
        }
    finally:
        conn.close()


@router.get('/giftcards/my-wallet/{user_id}')
def get_wallet(user_id: str):
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute('SELECT * FROM user_wallets WHERE user_id = %s', (user_id,))
        row = cur.fetchone()
        if not row:
            return {'balance': '0', 'currency': 'XOF'}
        return {'balance': str(row['balance']), 'currency': row['currency']}
    finally:
        conn.close()
