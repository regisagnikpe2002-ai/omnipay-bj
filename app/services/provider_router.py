from app.adapters.mock_provider import MockProviderAdapter
from app.adapters.celtis_adapter import CeltisAdapter


class ProviderRouter:
    def __init__(self):
        self.providers = {
            "mock": MockProviderAdapter(),
            "celtis": CeltisAdapter(),
        }

    def get(self, provider_name: str):
        if provider_name not in self.providers:
            raise ValueError(f"provider {provider_name} not found")
        return self.providers[provider_name]
