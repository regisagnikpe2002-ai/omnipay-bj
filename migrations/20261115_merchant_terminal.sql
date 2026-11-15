-- OMNIPAY Merchant Terminal

CREATE TABLE IF NOT EXISTS omnipay_merchants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL,
  merchant_code VARCHAR(40) NOT NULL UNIQUE,
  legal_name VARCHAR(160) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  country_code VARCHAR(2) NOT NULL DEFAULT 'BJ',
  settlement_currency VARCHAR(8) NOT NULL DEFAULT 'XOF',
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS omnipay_merchants_owner_idx
ON omnipay_merchants(owner_user_id);


CREATE TABLE IF NOT EXISTS omnipay_merchant_terminals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL
    REFERENCES omnipay_merchants(id)
    ON DELETE CASCADE,
  terminal_code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(10  name VARCHAR(10 nnel VARCHAR(24) NOT NULL DEFAULT 'api',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMP  updated_at TIMESTAMP  updated_EATE INDEX IF NOT EXISTS omnipay_terminals_merchant_idx
ON omnipay_merchant_terminals(merchant_id);


CREATE TABLE IF NOT EXISTS omnipayCREATE TABLE IF NOT EXISTS omnipayCREATE TABLE IF NOT EraCREATE TABLE IF NOT EXISTS omnipayCREATE TABLE FERENCES omnipay_merchants(id)
    ON DELETE CASCADE,
  terminal_id UUID
    REFERENCES omnipay_me    REFERENCES omnipay_me    REFERENCES omnipa k y_prefix VARCHAR(24) NOT NULL,
  key_hash VARCHAR(64) NOT   key_hash VARCHAR(64) NOT   key NOT NULL,
  environment VARCHAR(12) NOT NULL DEFAULT 'live',
  permissions JSONB NOT NULL DEFAULT
    '["payments:create","payments:read"]'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS omnipay_api_keys_merchant_idx
ON omnipay_merchant_api_keys(merchant_id);
