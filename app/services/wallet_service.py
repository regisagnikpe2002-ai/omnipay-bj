from decimal import Decimal
from app.core.wallet import Wallet
from app.core.ledger import Ledger


class WalletService:
    def __init__(self):
        self.wallets = {}
        self.ledger = Ledger()

    def get_or_create_wallet(self, user_id: str, currency: str = "XOF"):
        if user_id not in self.wallets:
            self.wallets[user_id] = Wallet(user_id=user_id, currency=currency)
        return self.wallets[user_id]

    def credit(self, user_id: str, amount: Decimal, reference: str, metadata=None):
        wallet = self.get_or_create_wallet(user_id)
        wallet.credit(amount)
        self.ledger.add_entry(wallet.id, "credit", amount, wallet.currency, reference, metadata)
        return wallet

    def debit(self, user_id: str, amount: Decimal, reference: str, metadata=None):
        wallet = self.get_or_create_wallet(user_id)
        wallet.debit(amount)
        self.ledger.add_entry(wallet.id, "debit", amount, wallet.currency, reference, metadata)
        return wallet

    def balance(self, user_id: str):
        return self.get_or_create_wallet(user_id).balance
