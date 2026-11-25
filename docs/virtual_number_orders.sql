BEGIN;

CREATE TABLE IF NOT EXISTS virtual_number_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  provider varchar(32) NOT NULL DEFAULT 'smscodes',
  provider_order_id varchar(160) UNIQUE,
  country_iso varchar(3) NOT NULL,
  service_id varchar(120) NOT NULL,
  service_name varchar(160),
  number varchar(40),
  security_id varchar(180),
  currency varchar(10) NOT NULL DEFAULT 'XOF',
  customer_price numeric(18,2) NOT NULL CHECK (customer_price >= 0),
  provider_price numeric(18,2),
  commission numeric(18,2) NOT NULL DEFAULT 0 CHECK (commission >= 0),
  status varchar(24) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','ordering','active','failed','expired','cancelled')),
  auto_renew boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS virtual_number_orders_user_idx
ON virtual_number_orders (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS virtual_number_orders_status_idx
ON virtual_number_orders (status, updated_at DESC);

COMMIT;
