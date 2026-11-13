-- Migration: gift cards + redemption + wallet + gift card inventory + offers + sales

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS user_wallets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL UNIQUE,
  currency VARCHAR(10) DEFAULT 'XOF',
  balance NUMERIC(30,8) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gift_card_offers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider TEXT NOT NULL, -- paysafecard | transcash | pcs | omnipay
  provider_label TEXT,
  nominal_value NUMERIC(30,8) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'EUR',
  sale_price NUMERIC(30,8) NOT NULL,
  markup_pct NUMERIC(10,4) DEFAULT 0,
  active BOOLEAN DEFAULT TRUE,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gift_card_inventory (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  offer_id UUID NOT NULL REFERENCES gift_card_offers(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  code_hash TEXT,
  status TEXT NOT NULL DEFAULT 'available', -- available | reserved | redeemed | expired
  redeemed_by UUID,
  redeemed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gift_card_sales (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  offer_id UUID NOT NULL REFERENCES gift_card_offers(id) ON DELETE CASCADE,
  inventory_id UUID REFERENCES gift_card_inventory(id) ON DELETE SET NULL,
  order_id TEXT NOT NULL,
  amount_paid NUMERIC(30,8),
  currency VARCHAR(10),
  status TEXT DEFAULT 'pending', -- pending | confirmed | failed | delivered
  delivered_code TEXT,
  provider_response JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  delivered_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS redemption_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID,
  inventory_id UUID,
  code_masked TEXT,
  attempt_result TEXT,
  details JSONB DEFAULT '{}'::jsonb,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gift_card_inventory_offer ON gift_card_inventory(offer_id);
CREATE INDEX IF NOT EXISTS idx_gift_card_inventory_status ON gift_card_inventory(status);
CREATE INDEX IF NOT EXISTS idx_gift_card_sales_user ON gift_card_sales(user_id);
CREATE INDEX IF NOT EXISTS idx_gift_card_sales_order ON gift_card_sales(order_id);
CREATE INDEX IF NOT EXISTS idx_redemption_logs_user ON redemption_logs(user_id);

-- Seed a default offer for quick demo/dev (50 EUR gift card in EUR)
INSERT INTO gift_card_offers (id, provider, provider_label, nominal_value, currency, sale_price, markup_pct, active, metadata)
VALUES (
  '2f9f0ff6-5a2f-4e9e-94d4-ce0be5a7dc5f',
  'omnipay',
  'Omnigift 50 EUR',
  50,
  'EUR',
  52,
  0.04,
  TRUE,
  '{"usage":"demo"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- default demo inventory code for test
INSERT INTO gift_card_inventory (id, offer_id, code, code_hash, status, expires_at, metadata)
VALUES (
  '0f5d3d66-01d2-4a0c-9f8b-2efec1a8be70',
  '2f9f0ff6-5a2f-4e9e-94d4-ce0be5a7dc5f',
  'OMNIGIFT-50-EUR-TEST-001',
  NULL,
  'available',
  now() + INTERVAL '90 days',
  '{"demo":true}'::jsonb
)
ON CONFLICT (code) DO NOTHING;

