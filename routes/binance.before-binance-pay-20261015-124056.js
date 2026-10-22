const axios = require('axios');
const express = require('express');
const router = express.Router();

router.get('/binance/balance', async (req, res) => {
  try {
    const response = await axios.get('https://api.binance.com/sapi/v1/capital/config/getall', {
      headers: { 'X-MBX-APIKEY': process.env.BINANCE_API_KEY }
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
