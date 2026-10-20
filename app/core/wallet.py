from decimal import Decimal
from dataclasses import dataclass, field
import uuid


@dataclass
class Wallet:
    user_id: str
    currency: str = "XOF"
    balance: Decimal = Decimal("0.00")
    status: str = "active"
    id: str = field(default_factory=lambda: str(uuid.uuid4()))

    def credit(self, amount: Decimal):
        if amount <= 0:
            raise ValueError("amount must be > 0")
        self.balance += amount

    def debit(self, amount: Decimal):
        if amount <= 0:
            raise ValueError("amount must be > 0")
        if amount > self.balance:
            raise ValueError("insufficient funds")
        self.balance -= amount
