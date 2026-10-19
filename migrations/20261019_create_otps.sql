-- Migration: create OTP table for login links and receipts

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS otps (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID,
  order_id TEXT,
  otp_code VARCHAR(16) NOT NULL,
  purpose TEXT,
  expires_at TIMESTAMPTZ,
  used BOOLEAN DEFAULT FALSE,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otps_client_id ON otps(client_id);
CREATE INDEX IF NOT EXISTS idx_otps_order_id ON otps(order_id);
CREATE INDEX IF NOT EXISTS idx_otps_otp_code ON otps(otp_code);

