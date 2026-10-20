import os
from typing import Optional
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel
import psycopg2
from psycopg2.extras import RealDictCursor

router = APIRouter()

ADMIN_PAYMENT_KEY = os.getenv("ADMIN_PAYMENT_KEY", "change_me_admin")
DATABASE_URL = os.getenv("DATABASE_URL")


def get_conn():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is not set")
    return psycopg2.connect(DATABASE_URL)


class PaymentConfig(BaseModel):
    payment_alerts_enabled: bool = True
    fraud_review_enabled: bool = True
    tpe_iban_enabled: bool = True
    card_auto_debit_enabled: bool = True
    require_3ds: bool = True
    kyc_required: bool = True
    daily_debit_limit_xof: int = 500000
    monthly_debit_limit_xof: int = 1500000


def require_admin(x_admin_key: Optional[str] = Header(None)):
    if x_admin_key != ADMIN_PAYMENT_KEY:
        raise HTTPException(status_code=403, detail="Forbidden")


@router.get("/admin/payments/config")
def get_payment_config(x_admin_key: Optional[str] = Header(None)):
    require_admin(x_admin_key)
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("SELECT key_name, value_text, value_json FROM payment_settings ORDER BY key_name")
        rows = cur.fetchall()
        data = {}
        for row in rows:
            data[row["key_name"]] = row["value_text"] if row["value_text"] is not None else row["value_json"]
        return data
    finally:
        conn.close()


@router.post("/admin/payments/config")
def save_payment_config(config: PaymentConfig, x_admin_key: Optional[str] = Header(None)):
    require_admin(x_admin_key)
    conn = get_conn()
    try:
        cur = conn.cursor()

        mapping = {
            "PAYMENT_ALERTS_ENABLED": str(config.payment_alerts_enabled).lower(),
            "FRAUD_REVIEW_ENABLED": str(config.fraud_review_enabled).lower(),
            "TPE_IBAN_ENABLED": str(config.tpe_iban_enabled).lower(),
            "CARD_AUTO_DEBIT_ENABLED": str(config.card_auto_debit_enabled).lower(),
            "REQUIRE_3DS": str(config.require_3ds).lower(),
            "KYC_REQUIRED": str(config.kyc_required).lower(),
            "DAILY_DEBIT_LIMIT_XOF": str(config.daily_debit_limit_xof),
            "MONTHLY_DEBIT_LIMIT_XOF": str(config.monthly_debit_limit_xof),
        }

        for key, value in mapping.items():
            cur.execute(
                """
                INSERT INTO payment_settings (key_name, value_text, updated_at)
                VALUES (%s, %s, now())
                ON CONFLICT (key_name)
                DO UPDATE SET value_text = EXCLUDED.value_text, updated_at = now()
                """,
                (key, value),
            )

        conn.commit()
        return {
            "status": "ok",
            "config": config.dict(),
        }
    finally:
        conn.close()
