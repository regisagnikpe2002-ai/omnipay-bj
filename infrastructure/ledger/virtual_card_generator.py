"""
Prototype: générateur de carte virtuelle Omnipay (prototype local)

Notes importantes :
- Ceci est un prototype pour usage interne & demo. Pour émettre de vraies cartes (PAN) et accepter paiements via réseau de cartes (Visa/Mastercard), vous devez intégrer un fournisseur d'issuance (ex : Stripe Issuing, Marqeta, Railsbank, Treezor) et respecter PCI DSS.
- Ici, on crée des "cartes virtuelles" tokenisées dans la base et fournissant un identifiant unique utilisable par vos partenaires et par vos API internes.

Fonctions :
- créer une carte virtuelle liée à un client
- renvoyer les informations masked (display) et token
- ne stocke PAS de PAN réels
"""

import os
import uuid
import psycopg2
from datetime import datetime, timedelta

DATABASE_URL = os.getenv('DATABASE_URL')


def mask_number(number):
    return '**** **** **** ' + number[-4:]


def generate_token():
    return uuid.uuid4().hex


def create_virtual_card(conn, client_id, currency='EUR', initial_balance=0):
    # generate a pseudo-card reference (NOT a PAN). For demo only.
    card_ref = f'OMN-{uuid.uuid4().hex[:12].upper()}'
    token = generate_token()
    display = f"{card_ref[-4:]}"  # minimal display

    cur = conn.cursor()
    cur.execute(
        "INSERT INTO virtual_cards (client_id, card_reference, card_display, card_token, currency, balance, status, created_at, updated_at, metadata) VALUES (%s,%s,%s,%s,%s,%s,%s,now(),now(),%s) RETURNING id",
        (client_id, card_ref, display, token, currency, initial_balance, 'active', {'proto': 'local_token'})
    )
    new_id = cur.fetchone()[0]
    conn.commit()
    cur.close()
    return {
        'id': str(new_id),
        'card_reference': card_ref,
        'card_token': token,
        'card_display': display,
        'currency': currency,
        'balance': str(initial_balance)
    }


if __name__ == '__main__':
    if DATABASE_URL is None:
        print('DATABASE_URL not set')
        exit(1)
    conn = psycopg2.connect(DATABASE_URL)
    try:
        # exemple: créer une carte pour un client existant (sinon créer un client test)
        client_id = os.getenv('TEST_CLIENT_ID')
        if not client_id:
            # create test client
            cur = conn.cursor()
            cur.execute("INSERT INTO clients (external_id, name, email, metadata) VALUES (%s,%s,%s,%s) RETURNING id",
                        ('test-ext-1', 'Client Demo', 'demo@omnipay.bj', {'note':'test client'}))
            client_id = cur.fetchone()[0]
            conn.commit()
            cur.close()
        card = create_virtual_card(conn, client_id, 'XOF', 0)
        print('Virtual card created:', card)
    finally:
        conn.close()
