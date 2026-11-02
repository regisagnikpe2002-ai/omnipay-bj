-- Omnipay : schema du portefeuille (registre comptable en partie double)
-- Montants en entiers (XOF n'a pas de decimales). Solde = somme des ecritures.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         text UNIQUE NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  kyc_status    text NOT NULL DEFAULT 'none',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Comptes clients (user_id renseigne) et comptes systeme (user_id NULL, ex: external_mtn)
CREATE TABLE IF NOT EXISTS accounts (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id  uuid REFERENCES users(id),
  kind     text NOT NULL DEFAULT 'wallet',
  currency char(3) NOT NULL DEFAULT 'XOF'
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_user_uq   ON accounts(user_id, kind, currency) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_system_uq ON accounts(kind, currency) WHERE user_id IS NULL;

CREATE TABLE IF NOT EXISTS transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type            text NOT NULL,                       -- transfer | topup | withdraw
  status          text NOT NULL DEFAULT 'pending',     -- pending | success | failed
  idempotency_key text UNIQUE NOT NULL,
  account_id      uuid REFERENCES accounts(id),
  amount          bigint,
  provider        text,
  provider_ref    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tx_provider_ref ON transactions(provider, provider_ref);

-- Ecritures : la somme des montants d'une transaction vaut toujours 0
CREATE TABLE IF NOT EXISTS ledger_entries (
  id             bigserial PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES transactions(id),
  account_id     uuid NOT NULL REFERENCES accounts(id),
  amount         bigint NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entries_account ON ledger_entries(account_id);
