"""
Admin panel backend endpoints for giftcards.

This file provides minimal endpoints to manage gift card offers and inventory.
It is intentionally lightweight and can be integrated into the existing FastAPI app.
"""
import os
import json
import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request, Header
from pydantic import BaseModel
import psycopg2
from psycopg2.extras import RealDictCursor

router = APIRouter()
DATABASE_URL = os.getenv('DATABASE_URL')
ADMIN_TOKEN = os.getenv('ADMIN_TOKEN', 'change_me_admin')
BASE_URL = os.getenv('BASE_URL', 'https://www.omnipay-bj.com')


def get_conn():
    return psycopg2.connect(DATABASE_URL)


def enforce_admin(x_admin_token: str = Header(None)):
    if x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail='Forbidden')


class OfferCreateRequest(BaseModel):
    provider: str
    provider_label: str
    nominal_value: float
    currency: str = 'EUR'
    sale_price: float
    markup_pct: float = 0.0
    active: bool = True
    metadata: dict = {}


@router.get('/admin/offers')
def list_offers(x_admin_token: str = Header(None)):
    if x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail='Forbidden')
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute('SELECT * FROM gift_card_offers ORDER BY created_at DESC')
        return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.post('/admin/offers/create')
def create_offer(req: OfferCreateRequest, x_admin_token: str = Header(None)):
    if x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail='Forbidden')
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


@router.get('/admin/inventory')
def list_inventory(status: str | None = None, x_admin_token: str = Header(None)):
    if x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail='Forbidden')
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        if status:
            cur.execute('SELECT * FROM gift_card_inventory WHERE status = %s ORDER BY created_at DESC', (status,))
        else:
            cur.execute('SELECT * FROM gift_card_inventory ORDER BY created_at DESC')
        return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.post('/admin/inventory/upload')
def upload_inventory(payload: dict, x_admin_token: str = Header(None)):
    if x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail='Forbidden')
    rows = payload.get('rows', [])
    conn = get_conn()
    try:
        cur = conn.cursor()
        for row in rows:
            offer_id = row.get('offer_id')
            code = row.get('code')
            status = row.get('status', 'available')
            expires_at = row.get('expires_at')
            meta = row.get('metadata', {})
            cur.execute(
                "INSERT INTO gift_card_inventory (id, offer_id, code, status, expires_at, metadata, created_at) VALUES (%s,%s,%s,%s,%s,%s,now()) ON CONFLICT (code) DO NOTHING",
                (str(uuid.uuid4()), offer_id, code, status, expires_at, json.dumps(meta))
            )
        conn.commit()
        return {'status': 'ok', 'count': len(rows)}
    finally:
        conn.close()


@router.get('/admin/sales')
def list_sales(x_admin_token: str = Header(None)):
    if x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail='Forbidden')
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute('SELECT * FROM gift_card_sales ORDER BY created_at DESC LIMIT 200')
        return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.post('/admin/sales/{sale_id}/status')
def change_sale_status(sale_id: str, payload: dict, x_admin_token: str = Header(None)):
    if x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail='Forbidden')
    status = payload.get('status')
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute("UPDATE gift_card_sales SET status = %s, delivered_at = now() WHERE id = %s", (status, sale_id))
        conn.commit()
        return {'status': status}
    finally:
        conn.close()
