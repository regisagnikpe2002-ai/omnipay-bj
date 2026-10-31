BEGIN;

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS reserved_balance numeric(18,2) NOT NULL DEFAULT 0;

ALTER TABLE wallets
  ADD CONSTRAINT wallets_balance_nonnegative
  CHECK (balance >= 0) NOT VALID;

ALTER TABLE wallets
  ADD CONSTRAINT wallets_reserved_nonnegative
  CHECK (reserved_balance >= 0) NOT VALID;

ALTER TABLE wallets
  ADD CONSTRAINT wallets_reserved_not_above_balance
  CHECK (reserved_balance <= balance) NOT VALID;

CREATE TABLE IF NOT EXISTS platform_accounts (
  code varchar(40) PRIMARY KEY,
  label varchar(120) NOT NULL,
  currency varchar(10) NOT NULL DEFAULT 'XOF',
  balance numeric(18,2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_accounts_balance_nonnegative CHECK (balance >= 0)
);

INSERT INTO platform_accounts (code, label, currency)
VALUES ('COMMISSION_XOF', 'Commissions acquises OMNIPAY', 'XOF')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS withdrawal_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  transaction_id uuid NOT NULL UNIQUE REFERENCES transactions(id),
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  fee numeric(18,2) NOT NULL CHECK (fee >= 0),
  status varchar(16) NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved','completed','released')),
  settlement_ref varchar(160),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  released_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS withdrawal_settlement_ref_uniq
ON withdrawal_reservations (lower(settlement_ref))
WHERE settlement_ref IS NOT NULL;

COMMIT;
