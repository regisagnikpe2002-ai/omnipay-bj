require("dotenv").config({ path: ".env.local" });

const {
  verifyEmailTransport,
  sendOtpEmail,
} = require("../services/emailService");

(async () => {
  try {
    console.log("SMTP_TEST_START");

    await verifyEmailTransport();

    console.log("SMTP_CONNECTION_OK");

    const result = await sendOtpEmail({
      email: "regisagnikpe2002@gmail.com",
      code: "123456",
      expiresInMinutes: 5,
    });

    console.log("SMTP_SEND_RESULT", {
      messageId: result.messageId,
      accepted: result.accepted,
      rejected: result.rejected,
    });
  } catch (error) {
    console.error("SMTP_TEST_ERROR", {
      message: error.message,
      code: error.code,
      command: error.command,
      response: error.response,
      responseCode: error.responseCode,
    });

    process.exitCode = 1;
  }
})();
