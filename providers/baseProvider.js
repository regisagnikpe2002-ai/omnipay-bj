"use strict";

function officialOnly(name) {
  return {
    name,

    isEnabled: () => false,

    capabilities: [],

    async initiate() {
      throw new Error(
        `${name}: accès officiel requis.`
      );
    },

    async verifyWebhook() {
      throw new Error(
        `${name}: vérification webhook non configurée.`
      );
    },
  };
}

module.exports = {
  officialOnly,
};
