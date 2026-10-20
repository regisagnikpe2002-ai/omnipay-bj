-- Migrations: TPE / IBAN / mandates / subscriptions / scheduled charges / payment attempts

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS customer_bank_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  iban_encrypted TEXT NOT NULL,
  bic TEXT,
  country VARCHAR(8),
  status VARCHAR(32) DEFAULT 'pending', -- pending | verified | rejected
  verification_method VARCHAR(32), -- micro_deposits | provider
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mandates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bank_account_id UUID NOT NULL REFERENCES customer_bank_accounts(id) ON DELETE CASCADE,
  provider_mandate_id TEXT,
  mandate_type VARCHAR(32) DEFAULT 'SEPA_CORE',
  signed_at TIMESTAMPTZ,
  status VARCHAR(32) DEFAULT 'active', -- active | cancelled | pending
  raw_proof JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  mandate_id UUID NOT NULL REFERENCES mandates(id) ON DELETE SET NULL,
  amount NUMERIC(30,8) NOT NULL,
  currency VARCHAR(8) DEFAULT 'XOF',
  interval VARCHAR(16) DEFAULT 'monthly', -- monthly | yearly | custom
  next_charge_at TIMESTAMPTZ,
  status VARCHAR(32) DEFAULT 'active', -- active | paused | cancelled
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scheduled_charges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  scheduled_at TIMESTAMPTZ NOT NULL,
  attempt_count INTEGER DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  status VARCHAR(32) DEFAULT 'pending', -- pending | success | failed
  provider_response JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_attempts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  scheduled_charge_id UUID NOT NULL REFERENCES scheduled_charges(id) ON DELETE CASCADE,
  provider_tx_id TEXT,
  status VARCHAR(32) DEFAULT 'pending', -- pending | success | failed
  amount NUMERIC(30,8),
  currency VARCHAR(8),
  response JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_sched_pending ON scheduled_charges(status, scheduled_at);
