"use strict";

const BaseProvider = require("./BaseProvider");

class PayDunyaProvider extends BaseProvider {
  constructor({ config, createInvoice, confirmInvoice }) {
    super(config);

    if (typeof createInvoice !== "function") {
      throw new Error("PayDunyaProvider: createInvoice est requis.");
    }

    this.createInvoice = createInvoice;
    this.confirmInvoice = confirmInvoice;
  }

  async healthCheck() {
    const requiredKeys = [
      "PAYDUNYA_MASTER_KEY",
      "PAYDUNYA_PRIVATE_KEY",
      "PAYDUNYA_PUBLIC_KEY",
      "PAYDUNYA_TOKEN",
    ];

    const missingEnvironmentVariables = requiredKeys.filter(
      (key) => !process.env[key]
    );

    return {
      provider: this.name,
      enabled: this.enabled,
      capabilities: this.capabilities,
      mode: process.env.PAYDUNYA_MODE || "undefined",
      status:
        !this.enabled
          ? "disabled"
          : missingEnvironmentVariables.length === 0
            ? "configured"
            : "misconfigured",
      missingEnvironmentVariables,
    };
  }

  async collect(request) {
    this.assertCapability("collections");

    const invoice = await this.createInvoice({
      amount: request.amount,
      description:
        request.metadata?.description ||
        `Dépôt OMNIPAY - ${request.amount} ${request.currency}`,
      userId: request.userId,
      callbackUrl: request.callbackUrl,
      returnUrl: request.metadata?.returnUrl,
      cancelUrl: request.metadata?.cancelUrl,
      customData: {
        operationId: request.operationId,
        idempotencyKey: request.idempotencyKey,
        provider: this.name,
        ...(request.metadata?.customData || {}),
      },
    });

    const paymentUrl =
      invoice?.paymentUrl ||
      invoice?.response_text ||
      invoice?.responseText ||
      invoice?.receipt_url ||
      invoice?.url;

    const providerReference =
      invoice?.token ||
      invoice?.invoiceToken ||
      invoice?.providerReference;

    if (!paymentUrl || !providerReference) {
      throw new Error(
        "PayDunya: réponse de création de facture incomplète."
      );
    }

    return {
      status: "pending",
      paymentUrl,
      providerReference,
      rawStatus: invoice.status || null,
    };
  }

  async getCollectionStatus(providerReference) {
    this.assertCapability("collections");

    if (typeof this.confirmInvoice !== "function") {
      throw new Error(
        "PayDunyaProvider: confirmInvoice est requis pour vérifier le statut."
      );
    }

    if (!providerReference) {
      throw new Error("PayDunya: référence fournisseur manquante.");
    }

    const confirmation = await this.confirmInvoice(providerReference);
    const rawStatus = String(
      confirmation?.status || confirmation?.invoice?.status || "pending"
    ).toLowerCase();

    const statusMap = {
      completed: "completed",
      success: "completed",
      pending: "pending",
      cancelled: "cancelled",
      canceled: "cancelled",
      failed: "failed",
    };

    return {
      status: statusMap[rawStatus] || "pending",
      providerReference,
      rawStatus,
      confirmation,
    };
  }

  async handleWebhook(payload) {
    const providerReference =
      payload?.data?.invoice?.token ||
      payload?.data?.token ||
      payload?.token;

    if (!providerReference) {
      throw new Error("PayDunya webhook: token manquant.");
    }

    return this.getCollectionStatus(providerReference);
  }
}

module.exports = PayDunyaProvider;
