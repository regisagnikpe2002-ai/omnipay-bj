from app.adapters.provider_adapter import ProviderAdapter


class CeltisAdapter(ProviderAdapter):
    def __init__(self, base_url: str = "https://sandbox.celtis.test", api_key: str = "dummy_key"):
        self.base_url = base_url
        self.api_key = api_key

    def cash_in(self, **kwargs):
        return {
            "status": "success",
            "provider": "celtis",
            "reference": "celtis_mock_001",
            "amount": kwargs.get("amount"),
            "currency": kwargs.get("currency", "XOF"),
            "mode": "sandbox",
        }

    def cash_out(self, **kwargs):
        return {
            "status": "success",
            "provider": "celtis",
            "reference": "celtis_mock_out_001",
            "amount": kwargs.get("amount"),
            "currency": kwargs.get("currency", "XOF"),
            "mode": "sandbox",
        }

    def get_status(self, reference: str):
        return {
            "status": "processed",
            "provider": "celtis",
            "reference": reference,
        }

    def verify_webhook(self, payload: dict, headers: dict) -> bool:
        return True
