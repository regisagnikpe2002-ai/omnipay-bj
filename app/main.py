from fastapi import FastAPI
from app.admin.payment_admin import router as payment_admin_router

app = FastAPI(title="Omnipay")
app.include_router(payment_admin_router, prefix="/api")
