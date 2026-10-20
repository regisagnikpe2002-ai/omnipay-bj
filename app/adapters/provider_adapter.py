from abc import ABC, abstractmethod


class ProviderAdapter(ABC):
    @abstractmethod
    def cash_in(self, **kwargs):
        pass

    @abstractmethod
    def cash_out(self, **kwargs):
        pass

    @abstractmethod
    def get_status(self, reference: str):
        pass

    @abstractmethod
    def verify_webhook(self, payload: dict, headers: dict) -> bool:
        pass
