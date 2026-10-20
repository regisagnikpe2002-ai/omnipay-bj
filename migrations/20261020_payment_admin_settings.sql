CREATE TABLE IF NOT EXISTS payment_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_name TEXT NOT NULL UNIQUE,
  value_text TEXT,
  value_json JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO payment_settings (key_name, value_text)
VALUES
  ('PAYMENT_ALERTS_ENABLED', 'true'),
  ('FRAUD_REVIEW_ENABLED', 'true'),
  ('TPE_IBAN_ENABLED', 'true'),
  ('CARD_AUTO_DEBIT_ENABLED', 'true'),
  ('REQUIRE_3DS', 'true'),
  ('KYC_REQUIRED', 'true'),
  ('DAILY_DEBIT_LIMIT_XOF', '500000'),
  ('MONTHLY_DEBIT_LIMIT_XOF', '1500000')
ON CONFLICT (key_name) DO NOTHING;
