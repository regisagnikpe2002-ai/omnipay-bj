"use strict";

const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");

const sql = () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL manquante.");
  return neon(process.env.DATABASE_URL);
};

const money = (value, name) => {
  const amount = Math.round(Number(value));
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`${name} invalide.`);
  }
  return amount;
};

const feeValue = (value) => {
  const fee = Math.round(Number(value));
  if (!Number.isSafeInteger(fee) || fee < 0) throw new Error("Frais invalides.");
  return fee;
};

const cleanRef = (value) => String(value || "").replace(/[<>]/g, "").trim().slice(0, 160);

async function creditPayin({ userId, amount, provider, providerRef, idempotencyKey }) {
  const q = sql();
  const value = money(amount, "Montant");
  const key = cleanRef(idempotencyKey);
  if (!key) throw new Error("Cle d'idempotence requise.");

  const rows = await q`
    WITH existing AS (
      SELECT id FROM transactions WHERE idempotency_key = ${key} LIMIT 1
    ),
    w AS (
      UPDATE wallets
      SET balance = balance + ${value}, updated_at = now()
      WHERE user_id = ${userId}::uuid
        AND NOT EXISTS (SELECT 1 FROM existing)
      RETURNING id, balance
    ),
    t AS (
      INSERT INTO transactions (
        wallet_id, type, amount, balance_after, status,
        provider, provider_ref, idempotency_key, metadata
      )
      SELECT id, 'deposit', ${value}, balance, 'completed',
             ${cleanRef(provider) || 'supervised'}, ${cleanRef(providerRef) || null},
             ${key}, jsonb_build_object('ledgerType','PAYIN','mirrored',true)
      FROM w
      RETURNING id
    )
    SELECT t.id, w.balance FROM t JOIN w ON true
  `;

  if (!rows.length) throw new Error("Depot deja traite ou wallet introuvable.");
  return { transactionId: rows[0].id, balance: Number(rows[0].balance) };
}

async function reserveWithdrawal({ userId, amount, fee, provider, destination, idempotencyKey }) {
  const q = sql();
  const payout = money(amount, "Montant");
  const commission = feeValue(fee);
  const total = payout + commission;
  const key = cleanRef(idempotencyKey) || `wd-${crypto.randomUUID()}`;

  const rows = await q`
    WITH w AS (
      UPDATE wallets
      SET reserved_balance = reserved_balance + ${total}, updated_at = now()
      WHERE user_id = ${userId}::uuid
        AND balance - reserved_balance >= ${total}
        AND NOT EXISTS (
          SELECT 1 FROM transactions WHERE idempotency_key = ${key}
        )
      RETURNING id, balance, reserved_balance
    ),
    t AS (
      INSERT INTO transactions (
        wallet_id, type, amount, balance_after, status,
        provider, provider_ref, idempotency_key, metadata
      )
      SELECT id, 'withdrawal', ${payout}, balance, 'pending',
             ${cleanRef(provider) || 'manual'}, ${cleanRef(destination)}, ${key},
             jsonb_build_object(
               'fee', ${commission},
               'reservedTotal', ${total},
               'ledgerType', 'PAYOUT_RESERVED'
             )
      FROM w
      RETURNING id, wallet_id
    ),
    r AS (
      INSERT INTO withdrawal_reservations (wallet_id, transaction_id, amount, fee)
      SELECT wallet_id, id, ${payout}, ${commission} FROM t
      RETURNING id
    )
    SELECT t.id AS transaction_id, r.id AS reservation_id,
           w.balance, w.reserved_balance
    FROM t JOIN r ON true JOIN w ON true
  `;

  if (!rows.length) throw new Error("Solde disponible insuffisant ou retrait deja cree.");
  return {
    transactionId: rows[0].transaction_id,
    reservationId: rows[0].reservation_id,
    balance: Number(rows[0].balance),
    reservedBalance: Number(rows[0].reserved_balance),
    availableBalance: Number(rows[0].balance) - Number(rows[0].reserved_balance)
  };
}

async function completeWithdrawal({ transactionId, settlementRef, channel = "pispi" }) {
  const q = sql();
  const ref = cleanRef(settlementRef);
  if (ref.length < 6) throw new Error("Reference reelle requise.");

  const rows = await q`
    WITH r AS (
      UPDATE withdrawal_reservations
      SET status = 'completed', settlement_ref = ${ref}, completed_at = now()
      WHERE transaction_id = ${transactionId}::uuid
        AND status = 'reserved'
        AND NOT EXISTS (
          SELECT 1 FROM withdrawal_reservations x
          WHERE x.settlement_ref IS NOT NULL
            AND lower(x.settlement_ref) = lower(${ref})
        )
      RETURNING wallet_id, amount, fee
    ),
    w AS (
      UPDATE wallets
      SET balance = balance - (r.amount + r.fee),
          reserved_balance = reserved_balance - (r.amount + r.fee),
          updated_at = now()
      FROM r
      WHERE wallets.id = r.wallet_id
      RETURNING wallets.id, wallets.balance, wallets.reserved_balance, r.fee
    ),
    t AS (
      UPDATE transactions
      SET status = 'completed', balance_after = w.balance,
          metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
            'settlement', jsonb_build_object(
              'channel', ${cleanRef(channel)},
              'reference', ${ref},
              'confirmedAt', now()::text
            )
          )
      FROM w
      WHERE transactions.id = ${transactionId}::uuid
        AND transactions.status IN ('pending','processing','failed')
      RETURNING transactions.id, transactions.wallet_id, transactions.idempotency_key
    ),
    c AS (
      UPDATE platform_accounts
      SET balance = balance + w.fee, updated_at = now()
      FROM w
      WHERE code = 'COMMISSION_XOF'
      RETURNING balance
    ),
    ct AS (
      INSERT INTO transactions (
        wallet_id, type, amount, balance_after, status,
        provider, provider_ref, idempotency_key, metadata
      )
      SELECT t.wallet_id, 'commission', w.fee, w.balance, 'completed',
             'internal', ${ref}, t.idempotency_key || '-fee',
             jsonb_build_object('ledgerType','COMMISSION_ACQUIRED')
      FROM t JOIN w ON true
      RETURNING id
    )
    SELECT t.id, w.balance, w.reserved_balance,
           c.balance AS commission_balance
    FROM t JOIN w ON true JOIN c ON true JOIN ct ON true
  `;

  if (!rows.length) throw new Error("Retrait deja traite, introuvable ou reference deja utilisee.");
  return {
    transactionId: rows[0].id,
    balance: Number(rows[0].balance),
    reservedBalance: Number(rows[0].reserved_balance),
    commissionBalance: Number(rows[0].commission_balance)
  };
}

async function releaseWithdrawal({ transactionId, note = "Retrait annule" }) {
  const q = sql();
  const rows = await q`
    WITH r AS (
      UPDATE withdrawal_reservations
      SET status = 'released', released_at = now()
      WHERE transaction_id = ${transactionId}::uuid AND status = 'reserved'
      RETURNING wallet_id, amount, fee
    ),
    w AS (
      UPDATE wallets
      SET reserved_balance = reserved_balance - (r.amount + r.fee), updated_at = now()
      FROM r WHERE wallets.id = r.wallet_id
      RETURNING wallets.balance, wallets.reserved_balance
    ),
    t AS (
      UPDATE transactions
      SET status = 'failed',
          metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
            'releaseNote', ${cleanRef(note)}, 'releasedAt', now()::text
          )
      WHERE id = ${transactionId}::uuid
        AND EXISTS (SELECT 1 FROM r)
      RETURNING id
    )
    SELECT t.id, w.balance, w.reserved_balance FROM t JOIN w ON true
  `;

  if (!rows.length) throw new Error("Reservation introuvable ou deja liberee.");
  return {
    transactionId: rows[0].id,
    balance: Number(rows[0].balance),
    reservedBalance: Number(rows[0].reserved_balance)
  };
}

module.exports = {
  creditPayin,
  reserveWithdrawal,
  completeWithdrawal,
  releaseWithdrawal
};
