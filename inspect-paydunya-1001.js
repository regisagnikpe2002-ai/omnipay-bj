require("dotenv").config({ path: ".env.local" });

const axios = require("axios");

const token = "FxOc6FHerRnJPJeBfsV4";

const baseUrl =
  process.env.PAYDUNYA_MODE === "live"
    ? "https://app.paydunya.com/api/v1"
    : "https://app.paydunya.com/sandbox-api/v1";

const headers = {
  "Content-Type": "application/json",
  "PAYDUNYA-MASTER-KEY": (process.env.PAYDUNYA_MASTER_KEY || "").trim(),
  "PAYDUNYA-PRIVATE-KEY": (process.env.PAYDUNYA_PRIVATE_KEY || "").trim(),
  "PAYDUNYA-PUBLIC-KEY": (process.env.PAYDUNYA_PUBLIC_KEY || "").trim(),
  "PAYDUNYA-TOKEN": (process.env.PAYDUNYA_TOKEN || "").trim(),
};

(async () => {
  try {
    const response = await axios.get(
      `${baseUrl}/checkout-invoice/confirm/${token}`,
      { headers }
    );

    console.log({
      response_code: response.data?.response_code,
      response_text: response.data?.response_text,
      description: response.data?.description,
      status: response.data?.status,
    });
  } catch (error) {
    console.log({
      httpStatus: error.response?.status,
      response_code: error.response?.data?.response_code,
      response_text: error.response?.data?.response_text,
      description: error.response?.data?.description,
      message: error.message,
    });
  }
})();
