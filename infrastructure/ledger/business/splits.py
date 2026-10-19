"""
Business logic: apply commission and create splits for a confirmed transaction.

Default commission rule: fixed 50 XOF + 2.0% if no specific rule found.
This module uses the transactions table and inserts rows into splits table.
"""
import os
from decimal import Decimal, ROUND_DOWN
import psycopg2
from psycopg2.extras import RealDictCursor

DEFAULT_FIXED = Decimal(os.getenv('DEFAULT_COMMISSION_FIXED', '50'))
DEFAULT_PCT = Decimal(os.getenv('DEFAULT_COMMISSION_PCT', '0.02'))


def get_commission_rule(conn, provider):
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("SELECT * FROM commission_rules WHERE provider = %s ORDER BY id DESC LIMIT 1", (provider,))
    row = cur.fetchone()
    if row:
        return Decimal(row.get('fixed') or 0), Decimal(row.get('pct') or 0)
    # fallback to default
    cur.execute("SELECT * FROM commission_rules WHERE provider = 'default' ORDER BY id DESC LIMIT 1")
    row = cur.fetchone()
    if row:
        return Decimal(row.get('fixed') or DEFAULT_FIXED), Decimal(row.get('pct') or DEFAULT_PCT)
    return DEFAULT_FIXED, DEFAULT_PCT


def quantize_amount(value):
    return value.quantize(Decimal('0.01'), rounding=ROUND_DOWN)


def apply_commission_and_create_splits(conn, transaction_id):
    """Read transaction by id, compute commission and insert splits."""
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute('SELECT * FROM transactions WHERE id = %s', (transaction_id,))
    tx = cur.fetchone()
    if not tx:
        raise ValueError('transaction not found')

    if tx.get('status') != 'confirmed':
        raise ValueError('transaction not confirmed')

    gross = Decimal(tx.get('gross_amount') or 0)
    currency = tx.get('currency') or 'XOF'
    provider = tx.get('provider') or 'default'

    fixed, pct = get_commission_rule(conn, provider)
    commission = fixed + (gross * pct)
    commission = quantize_amount(commission)
    net = gross - commission
    net = quantize_amount(net)

    # create commission split
    cur.execute(
        "INSERT INTO splits (transaction_id, split_type, amount, currency, account_id, status, metadata, created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,now()) RETURNING id",
        (transaction_id, 'commission', commission, currency, None, 'pending', {'note':'auto generated commission'})
    )
    commission_split_id = cur.fetchone()[0]

    # create merchant split
    cur.execute(
        "INSERT INTO splits (transaction_id, split_type, amount, currency, account_id, status, metadata, created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,now()) RETURNING id",
        (transaction_id, 'merchant', net, currency, None, 'pending', {'note':'merchant share'})
    )
    merchant_split_id = cur.fetchone()[0]

    # Optionally update transaction status to reconciled
    cur.execute("UPDATE transactions SET status = 'reconciled', updated_at = now() WHERE id = %s", (transaction_id,))

    conn.commit()
    return {'commission_split_id': str(commission_split_id), 'merchant_split_id': str(merchant_split_id), 'commission': str(commission), 'net': str(net)}

