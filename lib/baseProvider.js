"use strict";

function officialOnly(providerName) {
  const name = String(providerName || "Fournisseur");

  return {
    async initiate() {
      return {
        status: "unavailable",
        detail: `${name} : accès officiel non configuré.`
      };
    },

    async verifyWebhook() {
      return {
        valid: false,
        reason: `${name} : vérification officielle non configurée.`
      };
    }
  };
}

module.exports = { officialOnly };
