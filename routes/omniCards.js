"use strict";

const express = require("express");
const { neon } = require("@neondatabase/serverless");
const { requireAuth } = require("../authMiddleware");
const {
  generateOmniCard,
} = require("../services/cards/omniCardGenerator");

const router = express.Router();
const sql = () => neon(process.env.DATABASE_URL);

let ready = null;

async function ensure() {
  if (!ready) {
    ready = sql()`CREATE TABLE IF NOT EXISTS omni_cards (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL,
      card_reference varchar(80) NOT NULL UNIQUE,
      public_number varchar(40) NOT NULL UNIQUE,
      last4 varchar(4) NOT NULL,
      holder_name varchar(40) NOT NULL,
      card_type varchar(12) NOT NULL,
      currency varchar(8) NOT NULL,
      design varchar(20) NOT NULL,
      status varchar(16) NOT NULL
,
      provider varchar(40),
      provider_card_id varchar(120),
      provider_token varchar(255),
      internal_token varchar(255) NOT NULL UNIQUE,
      online_payments boolean NOT NULL DEFAULT false,
      contactless_payments boolean NOT NULL DEFAULT false,
      cash_withdrawal boolean NOT NULL DEFAULT false,
      international_payments boolean NOT NULL DEFAULT false,
      daily_limit_minor bigint NOT NULL DEFAULT 0,
      monthly_limit_minor bigint NOT NULL DEFAULT 0,
      physical_order_status varchar(30),
      shipping_address_id uuid,
      tracking_reference varchar(120),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.catch((e) => {
      ready = null;
      throw e;
    });
  }

  return ready;
}

router.get("/mine", requireAuth, async (req, res) => {
  try {
    await ensure();

    const rows = await sql()`SELECT
      id,
      card_reference,
      last4,
      holder_name,
      card_type,
      currency,
      design,
      status,
      online_payments,
      contactless_payments,
      cash_withdrawal,
      international_payments,
      daily_limit_minor,
      monthly_limit_minor,
      physical_order_status,
      tracking_reference,
      created_at,
      updated_at
    FROM omni_cards
    WHERE user_id = ${req.user.userId}::uuid
    AND status <> 'CANCELLED'
    ORDER BY created_at DESC
    LIMIT 20`;

    return res.json({
      ok: true,
      cards: rows,
    });
  } catch (error) {
    console.error("[CARDS] mine:", error.message);

    return res.status(500).json({
      ok: false,
      error: "Impossible de charger vos cartes.",
    });
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    await ensure();

    const q = sql();
    const uid = req.user.userId;

    const [{ n }] = await q`SELECT count(*)::int AS n
      FROM omni_cards
      WHERE user_id = ${uid}::uuid
      AND status <> 'CANCELLED'`;

    if (n >= 5) {
      return res.status(409).json({
        ok: false,
        error: "Limite de 5 cartes OMNIPAY actives atteinte.",
      });
    }

    const card = generateOmniCard({
      userId: uid,
      holderName: req.body?.holderName,
      type: req.body?.type,
      currency: req.body?.currency || "XOF",
      design: req.body?.design || "MIDNIGHT",
    });

    const rows = await q`INSERT INTO omni_cards (
      id,
      user_id,
      card_reference,
      public_number,
      last4,
      holder_name,
      card_type,
      currency,
      design,
      status,
      provider,
      provider_card_id,
      provider_token,
      internal_token,
      online_payments,
      contactless_payments,
      cash_withdrawal,
      international_payments,
      daily_limit_minor,
      monthly_limit_minor,
      physical_order_status
    ) VALUES (
      ${card.cardId}::uuid,
      ${uid}::uuid,
      ${card.cardReference},
      ${card.publicNumber},
      ${card.last4},
      ${card.holderName},
      ${card.type},
      ${card.currency},
      ${card.design},
      ${card.status},
      ${card.provider},
      ${card.providerCardId},
      ${card.providerToken},
      ${card.internalToken},
      ${card.spendingControls.onlinePayments},
      ${card.spendingControls.contactlessPayments},
      ${card.spendingControls.cashWithdrawal},
      ${card.spendingControls.internationalPayments},
      ${card.spendingControls.dailyLimitMinor},
      ${card.spendingControls.monthlyLimitMinor},
      ${card.physicalOrder?.status || null}
    )
    RETURNING
      id,
      card_reference,
      last4,
      holder_name,
      card_type,
      currency,
      design,
      status,
      online_payments,
      contactless_payments,
      physical_order_status,
      created_at`;

    return res.status(201).json({
      ok: true,
      card: rows[0],
    });
  } catch (error) {
    console.error("[CARDS] create:", error.message);

    return res.status(400).json({
      ok: false,
      error: error.message || "Création de la carte impossible.",
    });
  }
});

module.exports = router;
