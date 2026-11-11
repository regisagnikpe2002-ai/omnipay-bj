'use strict';
const express = require('express');
const router = express.Router();

router.get('/status', (req, res) => {
  res.json({
    ok: true,
    fund: {
      code: 'OMNI_RESERVE_500M',
      currency: 'XOF',
      targetAmount: 500000000,
      realBalance: 0,
      committedBalance: 0,
      availableBalance: 0,
      remainingToTarget: 500000000,
      accountingMode: 'REAL_FUNDS_ONLY'
    }
  });
});

module.exports = router;
