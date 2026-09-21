const { eq, desc } = require("drizzle-orm");
const crypto = require("crypto");
const { db } = require("./db/index.js");
const { wallets, transactions, users } = require("./db/schema.js");
const { createInvoice, confirmInvoice } = require("./providers/paydunya.js");

async function getMyWallet(req, res) {
  try {
    const wallet = await db.query.wallets.findFirst({
      where: eq(wallets.userId, req.user.userId),
    });
    if (!wallet) {
      return res.status(404).json({ error: "Wallet introuvable." });
    }
    return res.status(200).json({ wallet });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erreur serveur." });
  }
}

async function getMyTransactions(req, res) {
  try {
    const wallet = await db.query.wallets.findFirst({
      where: eq(wallets.userId, req.user.userId),
    });
    if (!wallet) {
      return res.status(404).json({ error: "Wallet introuvable." });
    }
    const txs = await db.query.transactions.findMany({
      where: eq(transactions.walletId, wallet.id),
      orderBy: [desc(transactions.createdAt)],
      limit: 50,
    });
    return res.status(200).json({ transactions: txs });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erreur serveur." });
  }
}

async function transfer(req, res) {
  try {
    const { recipientPhone, amount } = req.body;
    const numericAmount = Number(amount);

    if (!recipientPhone || !numericAmount || numericAmount <= 0) {
      return res.status(400).json({ error: "recipientPhone et amount (> 0) sont requis." });
    }

    const senderWallet = await db.query.wallets.findFirst({
      where: eq(wallets.userId, req.user.userId),
    });
    if (!senderWallet) {
      return res.status(404).json({ error: "Wallet expéditeur introuvable." });
    }

    if (Number(senderWallet.balance) < numericAmount) {
      return res.status(400).json({ error: "Solde insuffisant." });
    }

    const recipientUser = await db.query.users.findFirst({
      where: eq(users.phone, recipientPhone),
    });
    if (!recipientUser) {
      return res.status(404).json({ error: "Destinataire introuvable." });
    }

    const recipientWallet = await db.query.wallets.findFirst({
      where: eq(wallets.userId, recipientUser.id),
    });
    if (!recipientWallet) {
      return res.status(404).json({ error: "Wallet destinataire introuvable." });
    }

    const idempotencyKey = crypto.randomUUID();
    const newSenderBalance = (Number(senderWallet.balance) - numericAmount).toFixed(2);
    const newRecipientBalance = (Number(recipientWallet.balance) + numericAmount).toFixed(2);

    await db.update(wallets).set({ balance: newSenderBalance }).where(eq(wallets.id, senderWallet.id));
    await db.update(wallets).set({ balance: newRecipientBalance }).where(eq(wallets.id, recipientWallet.id));

    await db.insert(transactions).values({
      walletId: senderWallet.id,
      type: "transfer_out",
      amount: numericAmount.toFixed(2),
      balanceAfter: newSenderBalance,
      status: "completed",
      provider: "internal",
      idempotencyKey: idempotencyKey + "-out",
      counterpartyUserId: recipientUser.id,
    });

    await db.insert(transactions).values({
      walletId: recipientWallet.id,
      type: "transfer_in",
      amount: numericAmount.toFixed(2),
      balanceAfter: newRecipientBalance,
      status: "completed",
      provider: "internal",
      idempotencyKey: idempotencyKey + "-in",
      counterpartyUserId: req.user.userId,
    });

    return res.status(200).json({
      message: "Transfert effectué avec succès.",
      newBalance: newSenderBalance,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erreur serveur lors du transfert." });
  }
}

async function initiateDeposit(req, res) {
  try {
    const { amount } = req.body;
    const numericAmount = Number(amount);
    if (!numericAmount || numericAmount <= 0) {
      return res.status(400).json({ error: "amount (> 0) est requis." });
    }

    const wallet = await db.query.wallets.findFirst({
      where: eq(wallets.userId, req.user.userId),
    });
    if (!wallet) {
      return res.status(404).json({ error: "Wallet introuvable." });
    }

    const idempotencyKey = crypto.randomUUID();

    const invoice = await createInvoice({
      amount: numericAmount,
      description: `Dépôt OMNIPAY - ${numericAmount} XOF`,
      userId: req.user.userId,
      callbackUrl: "https://omnipay-bj.onrender.com/wallet/deposit/callback",
      returnUrl: "https://omnipay-bj.onrender.com",
    });

    await db.insert(transactions).values({
      walletId: wallet.id,
      type: "deposit",
      amount: numericAmount.toFixed(2),
      balanceAfter: wallet.balance,
      status: "pending",
      provider: "paydunya",
      providerRef: invoice.token,
      idempotencyKey,
    });

    return res.status(200).json({
      message: "Dépôt initié, complète le paiement via le lien.",
      paymentUrl: invoice.response_text ? invoice.response_text : invoice.receipt_url,
      invoiceToken: invoice.token,
    });
  } catch (err) {
    console.error(err.response?.data || err);
    return res.status(500).json({ error: "Erreur lors de l'initiation du dépôt." });
  }
}

async function depositCallback(req, res) {
  try {
    const { token } = req.body.data || req.body;
    const confirmation = await confirmInvoice(token);

    if (confirmation.status !== "completed") {
      return res.status(200).json({ message: "Paiement non confirmé." });
    }

    const tx = await db.query.transactions.findFirst({
      where: eq(transactions.providerRef, token),
    });
    if (!tx || tx.status === "completed") {
      return res.status(200).json({ message: "Déjà traité ou introuvable." });
    }

    const wallet = await db.query.wallets.findFirst({
      where: eq(wallets.id, tx.walletId),
    });

    const newBalance = (Number(wallet.balance) + Number(tx.amount)).toFixed(2);

    await db.update(wallets).set({ balance: newBalance }).where(eq(wallets.id, wallet.id));
    await db.update(transactions).set({ status: "completed", balanceAfter: newBalance }).where(eq(transactions.id, tx.id));

    return res.status(200).json({ message: "Dépôt confirmé et crédité." });
  } catch (err) {
    console.error(err.response?.data || err);
    return res.status(500).json({ error: "Erreur lors de la confirmation du dépôt." });
  }
}

module.exports = {
  getMyWallet,
  getMyTransactions,
  transfer,
  initiateDeposit,
  depositCallback,
};