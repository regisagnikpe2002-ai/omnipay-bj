const axios = require("axios");

const BASE_URL =
  process.env.PAYDUNYA_MODE === "live"
    ? "https://app.paydunya.com/api/v1"
    : "https://app.paydunya.com/sandbox-api/v1";

function getHeaders() {
  return {
    "Content-Type": "application/json",
    "PAYDUNYA-MASTER-KEY": process.env.PAYDUNYA_MASTER_KEY,
    "PAYDUNYA-PRIVATE-KEY": process.env.PAYDUNYA_PRIVATE_KEY,
    "PAYDUNYA-PUBLIC-KEY": process.env.PAYDUNYA_PUBLIC_KEY,
    "PAYDUNYA-TOKEN": process.env.PAYDUNYA_TOKEN,
  };
}

async function createInvoice({ amount, description, userId, callbackUrl, returnUrl }) {
  const payload = {
    invoice: {
      total_amount: amount,
      description: description || "Dépôt OMNIPAY",
    },
    store: {
      name: "OMNIPAY",
    },
    actions: {
      callback_url: callbackUrl,
      return_url: returnUrl,
    },
    custom_data: {
      userId,
    },
  };

  const response = await axios.post(
    `${BASE_URL}/checkout-invoice/create`,
    payload,
    { headers: getHeaders() }
  );

  return response.data;
}

async function confirmInvoice(token) {
  const response = await axios.get(
    `${BASE_URL}/checkout-invoice/confirm/${token}`,
    { headers: getHeaders() }
  );
  return response.data;
}

module.exports = { createInvoice, confirmInvoice };