from decimal import Decimal
from datetime import datetime
import uuid


class LedgerEntry:
    def __init__(self, wallet_id: str, entry_type: str, amount: Decimal, currency: str, reference: str, metadata=None):
        self.id = str(uuid.uuid4())
        self.wallet_id = wallet_id
        self.entry_type = entry_type
        self.amount = amount
        self.currency = currency
        self.reference = reference
        self.metadata = metadata or {}
        self.created_at = datetime.utcnow()


class Ledger:
    def __init__(self):
        self.entries = []

    def add_entry(self, wallet_id: str, entry_type: str, amount: Decimal, currency: str, reference: str, metadata=None):
        entry = LedgerEntry(wallet_id, entry_type, amount, currency, reference, metadata)
        self.entries.append(entry)
        return entry
