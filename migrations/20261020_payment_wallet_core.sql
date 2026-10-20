CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  currency VARCHAR(8) NOT NULL DEFAULT 'XOF',
  balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL,
  entry_type VARCHAR(32) NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  currency VARCHAR(8) NOT NULL DEFAULT 'XOF',
  reference VARCHAR(255) NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_name VARCHAR(64) NOT NULL,
  provider_reference VARCHAR(255),
  user_id UUID,
  amount NUMERIC(18,2) NOT NULL,
  currency VARCHAR(8) NOT NULL DEFAULT 'XOF',
  direction VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
