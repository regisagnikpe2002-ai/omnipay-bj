"use strict";

const SERVICES = Object.freeze({
  pispi: {
    code: "pispi",
    name: "PI-SPI",
    category: "payment",
    capabilities: ["deposit", "withdraw", "transfer"],
    status: "supervised",
    description: "Paiements interopérables via le compte Ecobank OMNIPAY."
  },
  mtn: {
    code: "mtn",
    name: "MTN MoMo",
    category: "mobile_money",
    capabilities: ["deposit", "withdraw"],
    status: "supervised",
    description: "Dépôts et retraits vers un compte MTN relié et vérifié."
  },
  moov: {
    code: "moov",
    name: "Moov Money",
    category: "mobile_money",
    capabilities: ["deposit", "withdraw"],
    status: "supervised",
    description: "Dépôts et retraits vers un compte Moov relié et vérifié."
  },
  celtiis: {
    code: "celtiis",
    name: "Celtiis Cash",
    category: "mobile_money",
    capabilities: ["deposit", "withdraw"],
    status: "supervised",
    description: "Dépôts et retraits vers un compte Celtiis relié et vérifié."
  },
  paypal: {
    code: "paypal",
    name: "PayPal",
    category: "international_payment",
    capabilities: ["deposit", "withdraw"],
    status: "configuration_required",
    description: "Paiements internationaux sous réserve de configuration et de disponibilité."
  },
  binance: {
    code: "binance",
    name: "Binance",
    category: "crypto",
    capabilities: ["deposit", "withdraw"],
    status: "configuration_required",
    description: "Dépôts et retraits crypto sous réserve de configuration."
  },
  western_union: {
    code: "western_union",
    name: "Western Union",
    category: "remittance",
    capabilities: ["cash_pickup"],
    status: "partnership_required",
    description: "Service international après activation du partenariat."
  },
  dhl: {
    code: "dhl",
    name: "DHL",
    category: "logistics",
    capabilities: ["location", "shipping", "tracking", "returns"],
    status: "partnership_required",
    description: "Expédition et suivi des colis OMNIPAY."
  }
});

function publicCatalog() {
  return Object.values(SERVICES).map((service) => ({
    code: service.code,
    name: service.name,
    category: service.category,
    capabilities: [...service.capabilities],
    status: service.status,
    description: service.description
  }));
}

function getService(code) {
  return SERVICES[String(code || "").toLowerCase()] || null;
}

module.exports = { publicCatalog, getService };
