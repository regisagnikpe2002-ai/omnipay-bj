# Gift cards E2E simulator

This module creates a small simulation flow for testing Omnipay gift card redemption without real providers.

Flow:
1. Create offer in gift_card_offers
2. Seed demo code in gift_card_inventory
3. User redeems code via /giftcards/redeem
4. System creates wallet credit and logs success

Usage example:
- export DATABASE_URL=postgres://user:pass@localhost:5432/omnipaydb
- uvicorn infrastructure.ledger.giftcards_api:router or include app
- call POST /giftcards/offers/create with a sample offer
- call POST /giftcards/redeem with a valid code

