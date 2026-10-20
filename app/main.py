from fastapi import FastAPI
from app.api.payments import router as payments_router
from app.api.webhooks import router as webhooks_router

app = FastAPI(title="Omnipay Core")

app.include_router(payments_router, prefix="/api")
app.include_router(webhooks_router, prefix="/api")
