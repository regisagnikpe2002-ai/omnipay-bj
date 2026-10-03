cat > walletController.js << 'EOF'
const { eq, desc } = require("drizzle-orm");
const crypto = require("crypto");
const { db } = require("./db/index.js");
const { wallets, transactions, users } = require("./db/schema.js");
const { createInvoice, confirmInvoice, createDisburseToken, submitDisburse } = require("./providers/paydunya.js");

const COMMISSION = 50;
const WITHDRAW_MODES = { mtn: "mtn-benin", moov: "moov-benin", celtiis: "celtiis-cash" };

async function getMyWallet(req, res) {
  try {
    const wallet = await db.query.wallets.findFirst({ where: eq(wallets.userId, req.user.userId) });
    if (!wallet) return res.status(404).json({ error: "Wallet introuvable." });
    return res.status(200).json({ wallet });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erreur serveur." });
  }
}

async function getMyTransactions(req, res) {
  try {
    const wallet = await db.query.wallets.findFirst({ where: eq(wallets.userId, req.user.userId) });
    if (!wallet) return res.status(404).json({ error: "Wallet introuvable." });
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

async function lookupRecipient(req, res) {
  try {
    const { phone } = req.params;
    if (!phone) return res.status(400).json({ error: "Numéro requis." });
    const user = await db.query.users.findFirst({ where: eq(users.phone, phone) });
    if (!user) return res.status(404).json({ error: "Aucun utilisateur avec ce numéro." });
    return res.status(200).json({ firstName: user.firstName || "", lastName: user.lastName || "" });
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

    const senderWallet = await db.query.wallets.findFirst({ where: eq(wallets.userId, req.user.userId) });
    if (!senderWallet) return res.status(404).json({ error: "Wallet expéditeur introuvable." });

    const totalDebit = numericAmount + COMMISSION;
    if (Number(senderWallet.balance) < totalDebit) {
      return res.status(400).json({ error: `Solde insuffisant (montant + ${COMMISSION} FCFA de commission).` });
    }

    const recipientUser = await db.query.users.findFirst({ where: eq(users.phone, recipientPhone) });
    if (!recipientUser) return res.status(404).json({ error: "Destinataire introuvable." });

    const recipientWallet = await db.query.wallets.findFirst({ where: eq(wallets.userId, recipientUser.id) });
    if (!recipientWallet) return res.status(404).json({ error: "Wallet destinataire introuvable." });

    const idempotencyKey = crypto.randomUUID();
    const newSenderBalance = (Number(senderWallet.balance) - totalDebit).toFixed(2);
    const newRecipientBalance = (Number(recipientWallet.balance) + numericAmount).toFixed(2);

    await db.update(wallets).set({ balance: newSenderBalance }).where(eq(wallets.id, senderWallet.id));
    await db.update(wallets).set({ balance: newRecipientBalance }).where(eq(wallets.id, recipientWallet.id));

    await db.insert(transactions).values({
      walletId: senderWallet.id, type: "transfer_out", amount: numericAmount.toFixed(2),
      balanceAfter: newSenderBalance, status: "completed", provider: "internal",
      idempotencyKey: idempotencyKey + "-out", counterpartyUserId: recipientUser.id,
    });
    await db.insert(transactions).values({
      walletId: recipientWallet.id, type: "transfer_in", amount: numericAmount.toFixed(2),
      balanceAfter: newRecipientBalance, status: "completed", provider: "internal",
      idempotencyKey: idempotencyKey + "-in", counterpartyUserId: req.user.userId,
    });
    await db.insert(transactions).values({
      walletId: senderWallet.id, type: "commission", amount: COMMISSION.toFixed(2),
      balanceAfter: newSenderBalance, status: "completed", provider: "internal",
      idempotencyKey: idempotencyKey + "-fee",
    });

    return res.status(200).json({ message: "Transfert effectué avec succès.", newBalance: newSenderBalance });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erreur serveur lors du transfert." });
  }
}

async function initiateDeposit(req, res) {
  try {
    const { amount } = req.body;
    const numericAmount = Number(amount);
    if (!numericAmount || numericAmount <= 0) return res.status(400).json({ error: "amount (> 0) est requis." });

    const wallet = await db.query.wallets.findFirst({ where: eq(wallets.userId, req.user.userId) });
    if (!wallet) return res.status(404).json({ error: "Wallet introuvable." });

    const idempotencyKey = crypto.randomUUID();
    const invoice = await createInvoice({
      amount: numericAmount,
      description: `Dépôt OMNIPAY - ${numericAmount} XOF`,
      userId: req.user.userId,
      callbackUrl: "https://www.omnipay-bj.com/wallet/deposit/callback",
      returnUrl: "https://www.omnipay-bj.com",
    });

    await db.insert(transactions).values({
      walletId: wallet.id, type: "deposit", amount: numericAmount.toFixed(2),
      balanceAfter: wallet.balance, status: "pending", provider: "paydunya",
      providerRef: invoice.token, idempotencyKey,
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
  console.log("=== CALLBACK PAYDUNYA REÇU ===", JSON.stringify(req.body));
  try {
    const token = req.body.data?.invoice?.token || req.body.data?.token || req.body.token;
    if (!token) return res.status(400).json({ error: "Token manquant." });

    const confirmation = await confirmInvoice(token);
    if (confirmation.status !== "completed") return res.status(200).json({ message: "Paiement non confirmé." });

    const tx = await db.query.transactions.findFirst({ where: eq(transactions.providerRef, token) });
    if (!tx || tx.status === "completed") return res.status(200).json({ message: "Déjà traité ou introuvable." });

    const wallet = await db.query.wallets.findFirst({ where: eq(wallets.id, tx.walletId) });
    const newBalance = (Number(wallet.balance) + Number(tx.amount)).toFixed(2);

    await db.update(wallets).set({ balance: newBalance }).where(eq(wallets.id, wallet.id));
    await db.update(transactions).set({ status: "completed", balanceAfter: newBalance }).where(eq(transactions.id, tx.id));

    return res.status(200).json({ message: "Dépôt confirmé et crédité." });
  } catch (err) {
    console.error(err.response?.data || err);
    return res.status(500).json({ error: "Erreur lors de la confirmation du dépôt." });
  }
}

async function requestWithdrawal(req, res) {
  try {
    const { amount, phone, operator } = req.body;
    const numericAmount = Number(amount);

    if (!numericAmount || numericAmount <= 0 || !phone || !operator) {
      return res.status(400).json({ error: "amount (> 0), phone et operator (mtn, moov, celtiis) sont requis." });
    }

    const withdrawMode = WITHDRAW_MODES[operator.toLowerCase()];
    if (!withdrawMode) {
      return res.status(400).json({ error: "operator invalide. Utilise: mtn, moov ou celtiis." });
    }

    const wallet = await db.query.wallets.findFirst({ where: eq(wallets.userId, req.user.userId) });
    if (!wallet) return res.status(404).json({ error: "Wallet introuvable." });

    const totalDebit = numericAmount + COMMISSION;
    if (Number(wallet.balance) < totalDebit) {
      return res.status(400).json({ error: `Solde insuffisant (montant + ${COMMISSION} FCFA de commission).` });
    }

    const idempotencyKey = crypto.randomUUID();
    const newBalance = (Number(wallet.balance) - totalDebit).toFixed(2);
    await db.update(wallets).set({ balance: newBalance }).where(eq(wallets.id, wallet.id));

    const [tx] = await db.insert(transactions).values({
      walletId: wallet.id, type: "withdrawal", amount: numericAmount.toFixed(2),
      balanceAfter: newBalance, status: "pending", provider: withdrawMode,
      providerRef: phone, idempotencyKey,
    }).returning();

    await db.insert(transactions).values({
      walletId: wallet.id, type: "commission", amount: COMMISSION.toFixed(2),
      balanceAfter: newBalance, status: "completed", provider: "internal",
      idempotencyKey: idempotencyKey + "-fee",
    });

    try {
      const disburse = await createDisburseToken({
        accountAlias: phone,
        amount: Math.round(numericAmount),
        withdrawMode,
        callbackUrl: "https://www.omnipay-bj.com/wallet/withdraw/callback",
      });

      console.log("=== DISBURSE TOKEN RESPONSE ===", JSON.stringify(disburse));

      const result = await submitDisburse({
        disburseInvoice: disburse.disburse_token,
        disburseId: tx.id,
      });

      console.log("=== DISBURSE SUBMIT RESPONSE ===", JSON.stringify(result));

      const finalStatus = result.status === "pending" ? "pending" : (result.response_code === "00" ? "completed" : "failed");

      await db.update(transactions).set({
        status: finalStatus,
        providerRef: result.transaction_id || phone,
      }).where(eq(transactions.id, tx.id));

      if (finalStatus === "failed") {
        const refunded = (Number(newBalance) + numericAmount + COMMISSION).toFixed(2);
        await db.update(wallets).set({ balance: refunded }).where(eq(wallets.id, wallet.id));
        return res.status(400).json({ error: "Le décaissement a échoué. Montant remboursé.", detail: result.response_text });
      }

      return res.status(200).json({
        message: finalStatus === "completed" ? "Retrait envoyé avec succès." : "Retrait en cours de traitement.",
        newBalance,
      });
    } catch (apiErr) {
      console.error("Erreur API décaissement:", apiErr.response?.data || apiErr);
      const refunded = (Number(newBalance) + numericAmount + COMMISSION).toFixed(2);
      await db.update(wallets).set({ balance: refunded }).where(eq(wallets.id, wallet.id));
      await db.update(transactions).set({ status: "failed" }).where(eq(transactions.id, tx.id));
      return res.status(500).json({ error: "Erreur lors du décaissement. Montant remboursé." });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erreur serveur lors du retrait." });
  }
}

async function withdrawCallback(req, res) {
  console.log("=== CALLBACK RETRAIT PAYDUNYA ===", JSON.stringify(req.body));
  try {
    const { status, transaction_id, disburse_id } = req.body;
    if (disburse_id) {
      await db.update(transactions).set({
        status: status === "success" ? "completed" : status === "failed" ? "failed" : "pending",
      }).where(eq(transactions.id, disburse_id));
    }
    return res.status(200).json({ message: "OK" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erreur callback retrait." });
  }
}

async function getCommissionsSummary(req, res) {
  try {
    const key = req.headers["x-admin-key"];
    if (!key || key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Accès refusé." });
    const rows = await db.query.transactions.findMany({ where: eq(transactions.type, "commission") });
    const total = rows.reduce((sum, tx) => sum + Number(tx.amount), 0);
    return res.status(200).json({ totalCommissions: total, count: rows.length, currency: "XOF" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erreur serveur." });
  }
}

module.exports = {
  getMyWallet, getMyTransactions, transfer, initiateDeposit, depositCallback,
  requestWithdrawal, withdrawCallback, getCommissionsSummary, lookupRecipient,
};
EOF
wc -l walletController.js 