const axios = require("axios");

const BASE_URL =
  process.env.PAYDUNYA_MODE === "live"
    ? "https://app.paydunya.com/api/v1"
    : "https://app.paydunya.com/sandbox-api/v1";

const DISBURSE_BASE_URL = "https://app.paydunya.com/api/v2/disburse";

function getHeaders() {
  return {
    "Content-Type": "application/json",
    "PAYDUNYA-MASTER-KEY": (process.env.PAYDUNYA_MASTER_KEY || "").trim(),
    "PAYDUNYA-PRIVATE-KEY": (process.env.PAYDUNYA_PRIVATE_KEY || "").trim(),
    "PAYDUNYA-PUBLIC-KEY": (process.env.PAYDUNYA_PUBLIC_KEY || "").trim(),
    "PAYDUNYA-TOKEN": (process.env.PAYDUNYA_TOKEN || "").trim(),
  };
}

async function createInvoice({ amount, description, userId, callbackUrl, returnUrl }) {
  const payload = {
    invoice: { total_amount: amount, description: description || "Dépôt OMNIPAY" },
    store: { name: "OMNIPAY" },
    actions: { callback_url: callbackUrl, return_url: returnUrl },
    custom_data: { userId },
  };
  const response = await axios.post(`${BASE_URL}/checkout-invoice/create`, payload, { headers: getHeaders() });
  return response.data;
}

async function confirmInvoice(token) {
  const response = await axios.get(`${BASE_URL}/checkout-invoice/confirm/${token}`, { headers: getHeaders() });
  return response.data;
}

async function createDisburseToken({ accountAlias, amount, withdrawMode, callbackUrl }) {
  const response = await axios.post(
    `${DISBURSE_BASE_URL}/get-invoice`,
    { account_alias: accountAlias, amount, withdraw_mode: withdrawMode, callback_url: callbackUrl },
    { headers: getHeaders() }
  );
  return response.data;
}

async function submitDisburse({ disburseInvoice, disburseId }) {
  const body = { disburse_invoice: disburseInvoice };
  if (disburseId) body.disburse_id = disburseId;
  const response = await axios.post(`${DISBURSE_BASE_URL}/submit-invoice`, body, { headers: getHeaders() });
  return response.data;
}

module.exports = { createInvoice, confirmInvoice, createDisburseToken, submitDisburse };
