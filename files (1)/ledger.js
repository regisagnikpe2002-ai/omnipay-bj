const { withTx, httpError } = require('./db');

async function balance(c, accountId) {
  const r = await c.query('SELECT COALESCE(SUM(amount),0)::bigint AS b FROM ledger_entries WHERE account_id=$1', [accountId]);
  return Number(r.rows[0].b);
}

async function systemAccount(c, kind, currency = 'XOF') {
  const r = await c.query(
    `INSERT INTO accounts(kind, currency) VALUES ($1,$2)
     ON CONFLICT (kind, currency) WHERE user_id IS NULL DO UPDATE SET kind = EXCLUDED.kind
     RETURNING id`, [kind, currency]);
  return r.rows[0].id;
}

function checkAmount(amount) {
  if (!Number.isInteger(amount) || amount <= 0) throw httpError(400, 'Montant invalide');
}

// Transfert interne entre deux portefeuilles Omnipay (instantane, atomique, idempotent)
function transfer({ fromAccount, toAccount, amount, key }) {
  checkAmount(amount);
  if (fromAccount === toAccount) throw httpError(400, 'Transfert vers soi-meme impossible');
  return withTx(async (c) => {
    const ins = await c.query(
      `INSERT INTO transactions(type,status,idempotency_key,amount) VALUES ('transfer','success',$1,$2)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`, [key, amount]);
    if (!ins.rowCount) {
      const ex = await c.query('SELECT id, status FROM transactions WHERE idempotency_key=$1', [key]);
      return { id: ex.rows[0].id, status: ex.rows[0].status, duplicate: true };
    }
    const txId = ins.rows[0].id;
    await c.query('SELECT id FROM accounts WHERE id = ANY($1) ORDER BY id FOR UPDATE', [[fromAccount, toAccount]]);
    if ((await balance(c, fromAccount)) < amount) throw httpError(400, 'Solde insuffisant');
    await c.query(
      'INSERT INTO ledger_entries(transaction_id, account_id, amount) VALUES ($1,$2,$3),($1,$4,$5)',
      [txId, fromAccount, -amount, toAccount, amount]);
    return { id: txId, status: 'success' };
  });
}

// Recharge : on cree d'abord une transaction "pending". Le portefeuille n'est credite
// qu'a la confirmation du fournisseur (webhook), jamais avant.
async function createTopup(c, { accountId, amount, provider, key }) {
  checkAmount(amount);
  const r = await c.query(
    `INSERT INTO transactions(type,status,idempotency_key,account_id,amount,provider)
     VALUES ('topup','pending',$1,$2,$3,$4)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`, [key, accountId, amount, provider]);
  return r.rowCount ? r.rows[0].id : null;
}

function settleTopup({ provider, providerRef, success }) {
  return withTx(async (c) => {
    const r = await c.query(
      `SELECT * FROM transactions WHERE provider=$1 AND provider_ref=$2 AND type='topup' FOR UPDATE`,
      [provider, providerRef]);
    const tx = r.rows[0];
    if (!tx) throw httpError(404, 'Transaction inconnue');
    if (tx.status !== 'pending') return { id: tx.id, status: tx.status, duplicate: true };
    if (success) {
      const sys = await systemAccount(c, `external_${provider}`);
      await c.query(
        'INSERT INTO ledger_entries(transaction_id, account_id, amount) VALUES ($1,$2,$3),($1,$4,$5)',
        [tx.id, sys, -tx.amount, tx.account_id, tx.amount]);
    }
    const status = success ? 'success' : 'failed';
    await c.query('UPDATE transactions SET status=$1, updated_at=now() WHERE id=$2', [status, tx.id]);
    return { id: tx.id, status };
  });
}

module.exports = { balance, transfer, createTopup, settleTopup };
