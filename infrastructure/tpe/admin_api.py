"""
Admin API extension for TPE admin actions. Minimal and protected by X-Admin-Token header.
"""
from fastapi import APIRouter, HTTPException, Header
from psycopg2.extras import RealDictCursor
import os
import psycopg2

router = APIRouter()
DATABASE_URL = os.getenv('DATABASE_URL')
ADMIN_TOKEN = os.getenv('ADMIN_TOKEN', 'change_me_admin')


def get_conn():
    return psycopg2.connect(DATABASE_URL)


def enforce_admin(x_admin_token: str = Header(None)):
    if x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail='Forbidden')


@router.get('/admin/tpe/mandates')
def list_mandates(x_admin_token: str = Header(None)):
    enforce_admin(x_admin_token)
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute('SELECT * FROM mandates ORDER BY created_at DESC LIMIT 200')
        return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.get('/admin/tpe/scheduled_charges')
def list_scheduled_charges(x_admin_token: str = Header(None)):
    enforce_admin(x_admin_token)
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute('SELECT sc.*, s.user_id, s.amount FROM scheduled_charges sc JOIN subscriptions s ON sc.subscription_id = s.id ORDER BY sc.scheduled_at DESC LIMIT 200')
        return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.post('/admin/tpe/force_charge/{scheduled_id}')
def force_charge(scheduled_id: str, x_admin_token: str = Header(None)):
    enforce_admin(x_admin_token)
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute("UPDATE scheduled_charges SET scheduled_at = now(), status = 'pending' WHERE id = %s", (scheduled_id,))
        conn.commit()
        return {'status': 'ok'}
    finally:
        conn.close()
