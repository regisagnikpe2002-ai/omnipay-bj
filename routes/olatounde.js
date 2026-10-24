"use strict";

const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");
const { buildAdvice, money } = require("../services/olatoundeService");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);

router.get("/health", requireAuth, (req, res) => {
  res.json({
    success: true,
    assistant: "OLATOUNDE",
    status: "active",
    mode: "advisory",
    canMoveFunds: false
  });
});

router.get("/summary", requireAuth, async (req, res) => {
  try {
    if (!process.env.DATABASE_URL) {
      return res.status(503).json({ success: false, error: "Base de données indisponible." });
    }

    const rows = await sql()`
      SELECT
        w.balance::float AS balance,
        coalesce(sum(t.amount) FILTER (
          WHERE t.type = 'deposit'
            AND t.status = 'completed'
            AND t.created_at > now() - interval '30 days'
        ), 0)::float AS deposits30,
        coalesce(sum(t.amount) FILTER (
          WHERE t.type = 'withdrawal'
            AND t.status IN ('completed', 'processing', 'pending')
            AND t.created_at > now() - interval '30 days'
        ), 0)::float AS withdrawals30,
        coalesce(sum(t.amount) FILTER (
          WHERE t.type = 'commission'
            AND t.status = 'completed'
            AND t.created_at > now() - interval '30 days'
        ), 0)::float AS commissions30,
        count(t.id)::int AS transaction_count
      FROM wallets w
      LEFT JOIN transactions t ON t.wallet_id = w.id
      WHERE w.user_id = ${req.user.userId}::uuid
      GROUP BY w.id, w.balance
      LIMIT 1
    `;

    if (!rows.length) {
      return res.status(404).json({ success: false, error: "Wallet OMNIPAY introuvable." });
    }

    const row = rows[0];
    const snapshot = {
      balance: money(row.balance),
      deposits30: money(row.deposits30),
      withdrawals30: money(row.withdrawals30),
      commissions30: money(row.commissions30),
      transactionCount: Number(row.transaction_count || 0)
    };

    res.json({
      success: true,
      assistant: {
        name: "OLATOUNDE",
        role: "Assistant financier OMNIPAY",
        mode: "advisory",
        canMoveFunds: false
      },
      snapshot,
      advice: buildAdvice(snapshot),
      security: {
        requiresConfirmation: true,
        storesPin: false,
        storesOtp: false,
        automaticTransfers: false
      }
    });
  } catch (error) {
    console.error("OLATOUNDE_SUMMARY_ERROR:", error.message);
    res.status(500).json({
      success: false,
      error: "OLATOUNDE ne peut pas analyser le compte pour le moment."
    });
  }
});

module.exports = router;
