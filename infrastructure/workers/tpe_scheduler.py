"""
Worker scheduler for TPE scheduled charges.
This module implements a simple, single-process processor intended to be called by cron, a worker or manually.
"""
import os
import uuid
from datetime import datetime, timedelta
import json

import psycopg2
from psycopg2.extras import RealDictCursor

from adapters.gocardless_adapter import GoCardlessAdapter

DATABASE_URL = os.getenv('DATABASE_URL')


def get_conn():
    return psycopg2.connect(DATABASE_URL)


MAX_RETRIES = 3
RETRY_DELAYS = [1, 3, 7]


def process_scheduled_charges(limit: int = 50):
    now = datetime.utcnow()
    processed = 0
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("SELECT sc.*, s.amount, s.currency, s.user_id, s.interval FROM scheduled_charges sc JOIN subscriptions s ON sc.subscription_id = s.id WHERE sc.status = 'pending' AND sc.scheduled_at <= now() ORDER BY sc.scheduled_at ASC LIMIT %s", (limit,))
        rows = cur.fetchall()
        adapter = GoCardlessAdapter()
        for sc in rows:
            try:
                res = adapter.create_payment(subscription_id=sc['subscription_id'], amount=str(sc['amount']), currency=sc['currency'])
                pa_id = str(uuid.uuid4())
                cur.execute("INSERT INTO payment_attempts (id, scheduled_charge_id, provider_tx_id, status, amount, currency, response, created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,now())",
                            (pa_id, sc['id'], res.get('provider_tx_id'), res.get('status'), sc['amount'], sc['currency'], json.dumps(res)))
                status = 'success' if res.get('status') == 'success' else 'failed'
                cur.execute("UPDATE scheduled_charges SET status=%s, attempt_count = attempt_count + 1, last_attempt_at = now(), provider_response = %s WHERE id = %s",
                            (status, json.dumps(res), sc['id']))
                if status == 'success':
                    cur.execute('SELECT interval, next_charge_at FROM subscriptions WHERE id = %s', (sc['subscription_id'],))
                    sub = cur.fetchone()
                    if sub:
                        interval = sub['interval']
                        next_dt = datetime.utcnow()
                        if interval == 'monthly':
                            next_dt = datetime.utcnow() + timedelta(days=30)
                        elif interval == 'yearly':
                            next_dt = datetime.utcnow() + timedelta(days=365)
                        else:
                            next_dt = datetime.utcnow() + timedelta(days=30)
                        cur.execute('UPDATE subscriptions SET next_charge_at = %s WHERE id = %s', (next_dt, sc['subscription_id']))
                else:
                    attempts = sc['attempt_count'] + 1
                    if attempts < MAX_RETRIES:
                        delay_days = RETRY_DELAYS[min(attempts-1, len(RETRY_DELAYS)-1)]
                        next_try = datetime.utcnow() + timedelta(days=delay_days)
                        cur.execute('INSERT INTO scheduled_charges (id, subscription_id, scheduled_at, status, created_at) VALUES (%s,%s,%s,%s,now())',
                                    (str(uuid.uuid4()), sc['subscription_id'], next_try, 'pending'))
                conn.commit()
            except Exception as e:
                conn.rollback()
                cur.execute("UPDATE scheduled_charges SET status=%s, attempt_count = attempt_count + 1, last_attempt_at = now(), provider_response = %s WHERE id = %s",
                            ('failed', json.dumps({'error': str(e)}), sc['id']))
                conn.commit()
            processed += 1
    finally:
        conn.close()
    return processed


if __name__ == '__main__':
    print('Processing scheduled charges...')
    n = process_scheduled_charges()
    print('Processed', n)
