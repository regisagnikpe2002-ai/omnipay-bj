import os
from decimal import Decimal
import uuid

# Quick sample test logic for gift card redemption

DATABASE_URL = os.getenv('DATABASE_URL')


def simulate_purchase_and_redeem():
    offer_id = '2f9f0ff6-5a2f-4e9e-94d4-ce0be5a7dc5f'
    user_id = str(uuid.uuid4())
    code = 'OMNIGIFT-50-EUR-TEST-001'
    return {
        'offer_id': offer_id,
        'user_id': user_id,
        'code': code,
        'expected_credit': '50.00',
        'currency': 'EUR',
        'status': 'simulated_success'
    }


if __name__ == '__main__':
    print(simulate_purchase_and_redeem())
