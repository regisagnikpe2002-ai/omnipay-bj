"""
TPE / IBAN FastAPI endpoints (skeleton).
- add bank account (stores encrypted IBAN)
- verify bank account (micro-deposits simulation)
- create mandate (provider flow stub)
- create subscription
- admin endpoints: list and force-run scheduler

Security: endpoints expect an admin token in header X-Admin-Token for admin routes.
"""
import os
import uuid
import json
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel
import psycopg2
from psycopg2.extras import RealDictCursor

from .encryption import encrypt_iban, decrypt_iban

router = APIRouter()
DATABASE_URL = os.getenv('DATABASE_URL')
ADMIN_TOKEN = os.getenv('ADMIN_TOKEN', 'change_me_admin')


def get_conn():
    return psycopg2.connect(DATABASE_URL)


class AddBankAccountReq(BaseModel):
    user_id: str
    iban: str
    bic: Optional[str] = None
    country: Optional[str] = None


class VerifyReq(BaseModel):
    bank_account_id: str
    code1: Optional[float] = None
    code2: Optional[float] = None


class CreateSubscriptionReq(BaseModel):
    user_id: str
    mandate_id: str
    amount: float
    currency: Optional[str] = 'XOF'
    interval: Optional[str] = 'monthly'


def enforce_admin(x_admin_token: str = Header(None)):
    if x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail='Forbidden')


@router.post('/tpe/bank_accounts/add')
def add_bank_account(req: AddBankAccountReq):
    conn = get_conn()
    try:
        cur = conn.cursor()
        encrypted = encrypt_iban(req.iban.strip())
        cur.execute(
            "INSERT INTO customer_bank_accounts (id, user_id, iban_encrypted, bic, country, status, created_at) VALUES (%s,%s,%s,%s,%s,%s,now()) RETURNING id",
            (str(uuid.uuid4()), req.user_id, encrypted, req.bic, req.country, 'pending')
        )
        row = cur.fetchone()
        conn.commit()
        return {'id': row[0], 'status': 'pending'}
    finally:
        conn.close()


@router.post('/tpe/bank_accounts/verify')
def verify_bank_account(req: VerifyReq):
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute('SELECT * FROM customer_bank_accounts WHERE id = %s', (req.bank_account_id,))
        acc = cur.fetchone()
        if not acc:
            raise HTTPException(status_code=404, detail='bank account not found')

        cur.execute('UPDATE customer_bank_accounts SET status = %s, verification_method = %s, updated_at = now() WHERE id = %s',
                    ('verified', 'micro_deposits', req.bank_account_id))
        conn.commit()
        return {'id': req.bank_account_id, 'status': 'verified'}
    finally:
        conn.close()


@router.post('/tpe/mandates/create')
def create_mandate(payload: dict):
    bank_account_id = payload.get('bank_account_id')
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute('SELECT * FROM customer_bank_accounts WHERE id = %s', (bank_account_id,))
        acc = cur.fetchone()
        if not acc:
            raise HTTPException(status_code=404, detail='bank account missing')

        provider_mandate_id = f'PM-{uuid.uuid4().hex[:12]}'
        cur.execute('INSERT INTO mandates (id, bank_account_id, provider_mandate_id, mandate_type, signed_at, status, raw_proof, created_at) VALUES (%s,%s,%s,%s,now(),%s,%s,now())',
                    (str(uuid.uuid4()), bank_account_id, provider_mandate_id, payload.get('mandate_type','SEPA_CORE'), 'active', json.dumps({'simulated': True})))
        conn.commit()
        return {'provider_mandate_id': provider_mandate_id, 'status': 'active'}
    finally:
        conn.close()


@router.post('/tpe/subscriptions/create')
def create_subscription(req: CreateSubscriptionReq):
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute('SELECT * FROM mandates WHERE id = %s', (req.mandate_id,))
        m = cur.fetchone()
        if not m:
            raise HTTPException(status_code=404, detail='mandate not found')

        next_charge = datetime.utcnow() + timedelta(days=30)
        cur.execute('INSERT INTO subscriptions (id, user_id, mandate_id, amount, currency, interval, next_charge_at, status, metadata, created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,now())',
                    (str(uuid.uuid4()), req.user_id, req.mandate_id, req.amount, req.currency, req.interval, next_charge, 'active', json.dumps({})))
        cur.execute('SELECT id FROM subscriptions WHERE user_id=%s ORDER BY created_at DESC LIMIT 1', (req.user_id,))
        sid = cur.fetchone()['id']
        cur.execute('INSERT INTO scheduled_charges (id, subscription_id, scheduled_at, status, created_at) VALUES (%s,%s,%s,%s,now())',
                    (str(uuid.uuid4()), sid, next_charge, 'pending'))
        conn.commit()
        return {'subscription_id': sid, 'next_charge_at': next_charge.isoformat()}
    finally:
        conn.close()


@router.post('/tpe/scheduler/run')
def run_scheduler(x_admin_token: str = Header(None)):
    enforce_admin(x_admin_token)
    from infrastructure.workers.tpe_scheduler import process_scheduled_charges
    return {'processed': process_scheduled_charges()}


@router.get('/tpe/admin/subscriptions')
def admin_list_subscriptions(x_admin_token: str = Header(None)):
    enforce_admin(x_admin_token)
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute('SELECT * FROM subscriptions ORDER BY created_at DESC LIMIT 200')
        return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()
