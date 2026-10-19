-- Migration: Create Omnipay Ledger schema + virtual cards

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- transactions ledger
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_tx_id TEXT,
  type TEXT NOT NULL, -- payment | refund | conversion | payout | fee
  direction TEXT NOT NULL, -- in | out
  gross_amount NUMERIC(30,8),
  net_amount NUMERIC(30,8),
  currency VARCHAR(10),
  provider_fees NUMERIC(30,8),
  status TEXT DEFAULT 'pending', -- pending | confirmed | failed | reconciled
  blockchain TEXT,
  tx_hash TEXT,
  confirmations INT DEFAULT 0,
  wallet_id UUID,
  payout_id TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  detected_anomaly BOOLEAN DEFAULT FALSE,
  anomaly_score DOUBLE PRECISION,
  created_at TIMESTAMPTZ DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transactions_order_id ON transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_transactions_provider_tx ON transactions(provider, provider_tx_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_detected_anomaly ON transactions(detected_anomaly);
CREATE INDEX IF NOT EXISTS idx_transactions_currency ON transactions(currency);
CREATE INDEX IF NOT EXISTS idx_transactions_wallet_id ON transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_tx_hash ON transactions(tx_hash);

CREATE INDEX IF NOT EXISTS idx_transactions_metadata_gin ON transactions USING gin(metadata);

-- wallets
CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT,
  wallet_type TEXT, -- hot | cold | custodial
  currency VARCHAR(10),
  address TEXT,
  status TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- providers
CREATE TABLE IF NOT EXISTS providers (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE,
  config JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- reconciliations
CREATE TABLE IF NOT EXISTS reconciliations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  provider_statement_id TEXT,
  reconciled BOOLEAN DEFAULT FALSE,
  note TEXT,
  reconciled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- audit logs (append-only)
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor TEXT,
  action TEXT,
  target_type TEXT,
  target_id TEXT,
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- approvals (payout gating)
CREATE TABLE IF NOT EXISTS approvals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payout_id TEXT,
  amount NUMERIC(30,8),
  currency VARCHAR(10),
  requested_by TEXT,
  status TEXT DEFAULT 'requested', -- requested/approved/rejected
  approvers JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- virtual cards table (pour cartes virtuelles Omnipay)
CREATE TABLE IF NOT EXISTS virtual_cards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL,
  card_reference TEXT UNIQUE NOT NULL, -- identifiant interne (masked)
  card_display TEXT, -- masked number pour affichage
  card_token TEXT, -- tokenisé (ne pas stocker PAN si non PCI compliant)
  currency VARCHAR(10) DEFAULT 'EUR',
  balance NUMERIC(30,8) DEFAULT 0,
  status TEXT DEFAULT 'active', -- active | blocked | closed
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_virtual_cards_client_id ON virtual_cards(client_id);
CREATE INDEX IF NOT EXISTS idx_virtual_cards_card_ref ON virtual_cards(card_reference);

-- small helper table for clients (if absent)
CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  external_id TEXT,
  name TEXT,
  email TEXT,
  kyc_status TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clients_external_id ON clients(external_id);

-- end of migration
