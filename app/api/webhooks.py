from fastapi import APIRouter, Request

router = APIRouter()


@router.post("/webhooks/provider")
async def provider_webhook(request: Request):
    payload = await request.json()
    headers = dict(request.headers)
    return {"status": "received", "payload": payload, "headers": headers}
