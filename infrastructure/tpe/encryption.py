"""
Encryption helpers for TPE IBAN handling.
Reads OMNIPAY_TPE_KEY from environment and provides encrypt/decrypt utilities.
"""
import os
from cryptography.fernet import Fernet, InvalidToken

OMNIPAY_TPE_KEY = os.getenv('OMNIPAY_TPE_KEY')
if not OMNIPAY_TPE_KEY:
    raise RuntimeError('OMNIPAY_TPE_KEY is not set in environment')

FERNET_KEY = OMNIPAY_TPE_KEY.encode() if isinstance(OMNIPAY_TPE_KEY, str) else OMNIPAY_TPE_KEY
fernet = Fernet(FERNET_KEY)


def encrypt_iban(plain_iban: str) -> str:
    """Return a string safe for DB storage (base64 token)."""
    return fernet.encrypt(plain_iban.encode()).decode()


def decrypt_iban(token: str) -> str:
    try:
        return fernet.decrypt(token.encode()).decode()
    except InvalidToken:
        raise RuntimeError('Invalid encryption token or wrong OMNIPAY_TPE_KEY')
