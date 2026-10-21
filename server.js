require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, withTx, httpError } = require('./db');
const ledger = require('./ledger');
const connectors = require('./connectors');

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET manquant dans .env');

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

function auth(req, _res, next) {
  const h = req.headers.authorization || '';
  try {
    req.user = jwt.verify(h.replace('Bearer ', ''), process.env.JWT_SECRET);
    next();
  } catch { next(httpError(401, 'Non authentifie')); }
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/auth/register', wrap(async (req, res) => {
  const { phone, name, password } = req.body || {};
  if (!phone || !name || !password || password.length < 8) throw httpError(400, 'Champs invalides');
  const hash = await bcrypt.hash(password, 12);
  const out = await withTx(async (c) => {
    const u = await c.query('INSERT INTO users(phone,name,password_hash) VALUES ($1,$2,$3) RETURNING id', [phone, name, hash]);
    await c.query('INSERT INTO accounts(user_id) VALUES ($1)', [u.rows[0].id]);
    return u.rows[0];
  }).catch((e) => { if (e.code === '23505') throw httpError(409, 'Numero deja inscrit'); throw e; });
  res.status(201).json({ id: out.id });
}));

app.post('/auth/login', wrap(async (req, res) => {
  const { phone, password } = req.body || {};
  const r = await pool.query('SELECT id, password_hash FROM users WHERE phone=$1', [phone]);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(password || '', u.password_hash))) throw httpError(401, 'Identifiants invalides');
  res.json({ token: jwt.sign({ uid: u.id }, process.env.JWT_SECRET, { expiresIn: '12h' }) });
}));

async function walletOf(userId) {
  const r = await pool.query(`SELECT id FROM accounts WHERE user_id=$1 AND kind='wallet' AND currency='XOF'`, [userId]);
  return r.rows[0].id;
}

app.get('/wallet', auth, wrap(async (req, res) => {
  const id = await walletOf(req.user.uid);
  const c = await pool.connect();
  try { res.json({ currency: 'XOF', balance: await ledger.balance(c, id) }); } finally { c.release(); }
}));

app.post('/transfers', auth, wrap(async (req, res) => {
  const { toPhone, amount, idempotencyKey } = req.body || {};
  if (!idempotencyKey) throw httpError(400, 'idempotencyKey requis');
  const to = await pool.query('SELECT id FROM users WHERE phone=$1', [toPhone]);
  if (!to.rowCount) throw httpError(404, 'Destinataire inconnu');
  const out = await ledger.transfer({
    fromAccount: await walletOf(req.user.uid),
    toAccount: await walletOf(to.rows[0].id),
    amount, key: `${req.user.uid}:${idempotencyKey}`,
  });
  res.json(out);
}));

// Recharge du portefeuille depuis un compte mobile money
app.post('/topup', auth, wrap(async (req, res) => {
  const { provider, phone, amount, idempotencyKey } = req.body || {};
  const connector = connectors.get(provider);
  if (!connector) throw httpError(400, 'Fournisseur non supporte');
  if (!idempotencyKey) throw httpError(400, 'idempotencyKey requis');
  const key = `${req.user.uid}:${idempotencyKey}`;
  const accountId = await walletOf(req.user.uid);
  const txId = await withTx((c) => ledger.createTopup(c, { accountId, amount, provider, key }));
  if (!txId) throw httpError(409, 'Requete deja traitee');
  const { providerRef } = await connector.collect({ phone, amount, reference: txId });
  await pool.query('UPDATE transactions SET provider_ref=$1 WHERE id=$2', [providerRef, txId]);
  res.status(202).json({ id: txId, status: 'pending' });
}));

// Webhook : signature HMAC-SHA256 du corps brut (adapter au schema reel de chaque fournisseur)
app.post('/webhooks/:provider', wrap(async (req, res) => {
  const { provider } = req.params;
  const secret = process.env[`WEBHOOK_SECRET_${provider.toUpperCase()}`];
  if (!secret) throw httpError(400, 'Fournisseur inconnu');
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');
  const given = String(req.headers['x-signature'] || '');
  const ok = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) throw httpError(401, 'Signature invalide');
  const { providerRef, status } = req.body;
  res.json(await ledger.settleTopup({ provider, providerRef, success: status === 'success' }));
}));

// Dev uniquement : simule la confirmation d'une recharge "mock"
if (process.env.NODE_ENV !== 'production') {
  app.post('/dev/confirm/:ref', wrap(async (req, res) => {
    res.json(await ledger.settleTopup({ provider: 'mock', providerRef: req.params.ref, success: true }));
  }));
}

app.use((err, _req, res, _next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Erreur interne' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Omnipay API sur le port ${port}`));
