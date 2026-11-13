-- Migration: create splits, payouts, commission_rules, merchant_accounts

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- splits table (per-transaction breakdown)
CREATE TABLE IF NOT EXISTS splits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  split_type TEXT NOT NULL, -- commission | merchant | operator_fee | tax
  amount NUMERIC(30,8) NOT NULL,
  currency VARCHAR(10),
  account_id UUID, -- reference to merchant_accounts or internal omnipay account
  status TEXT DEFAULT 'pending', -- pending | settled
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  settled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_splits_transaction_id ON splits(transaction_id);
CREATE INDEX IF NOT EXISTS idx_splits_status ON splits(status);

-- payouts table (to schedule payouts to merchants/beneficiaries)
CREATE TABLE IF NOT EXISTS payouts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  split_id UUID REFERENCES splits(id) ON DELETE SET NULL,
  payout_method TEXT, -- bank_transfer | momo_transfer | crypto
  to_identifier TEXT, -- account/phone/wallet
  amount NUMERIC(30,8),
  currency VARCHAR(10),
  status TEXT DEFAULT 'requested', -- requested | processing | completed | failed
  provider_response JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status);

-- merchant_accounts table (sub-merchants)
CREATE TABLE IF NOT EXISTS merchant_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  external_id TEXT,
  name TEXT,
  currency VARCHAR(10),
  balance NUMERIC(30,8) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_merchant_external_id ON merchant_accounts(external_id);

-- commission_rules table (configurable)
CREATE TABLE IF NOT EXISTS commission_rules (
  id SERIAL PRIMARY KEY,
  provider TEXT,
  fixed NUMERIC(20,8) DEFAULT 0,
  pct NUMERIC(5,4) DEFAULT 0,
  min_amount NUMERIC(20,8),
  max_amount NUMERIC(20,8),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Insert default commission rule for operators (50 XOF + 2%)
INSERT INTO commission_rules (provider, fixed, pct)
SELECT 'default', 50, 0.02
WHERE NOT EXISTS (SELECT 1 FROM commission_rules WHERE provider = 'default');

-- end migration
