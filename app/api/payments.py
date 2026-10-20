from decimal import Decimal
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.wallet_service import WalletService
from app.services.provider_router import ProviderRouter

router = APIRouter()
wallet_service = WalletService()
provider_router = ProviderRouter()


class TopUpRequest(BaseModel):
    user_id: str
    amount: Decimal
    currency: str = "XOF"
    provider: str = "mock"


class WithdrawRequest(BaseModel):
    user_id: str
    amount: Decimal
    currency: str = "XOF"
    provider: str = "mock"


@router.post("/wallet/topup")
def topup(req: TopUpRequest):
    try:
        wallet = wallet_service.credit(req.user_id, req.amount, "topup")
        provider = provider_router.get(req.provider)
        provider_result = provider.cash_in(amount=req.amount, currency=req.currency, user_id=req.user_id)
        return {
            "wallet_balance": str(wallet.balance),
            "provider_result": provider_result,
        }
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/wallet/withdraw")
def withdraw(req: WithdrawRequest):
    try:
        wallet = wallet_service.debit(req.user_id, req.amount, "withdrawal")
        provider = provider_router.get(req.provider)
        provider_result = provider.cash_out(amount=req.amount, currency=req.currency, user_id=req.user_id)
        return {
            "wallet_balance": str(wallet.balance),
            "provider_result": provider_result,
        }
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/wallet/balance/{user_id}")
def get_balance(user_id: str):
    wallet = wallet_service.get_or_create_wallet(user_id)
    return {
        "user_id": user_id,
        "currency": wallet.currency,
        "balance": str(wallet.balance),
    }
