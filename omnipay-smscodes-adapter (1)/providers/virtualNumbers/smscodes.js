"use strict";

const BASE_URL = "https://code.smscodes.io/api/sms";

function apiKey() {
  const key = String(process.env.SMSCODES_API_KEY || "").trim();
  if (!key) throw new Error("SMSCODES_API_KEY manquante.");
  return key;
}

function clean(value, max = 160) {
  return String(value == null ? "" : value).replace(/[<>]/g, "").trim().slice(0, max);
}

function isoCode(value) {
  const iso = clean(value, 3).toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(iso)) throw new Error("Code ISO invalide.");
  return iso;
}

function positiveInt(value, name, max = 1000) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name} invalide.`);
  return n;
}

function phoneNumber(value) {
  const number = clean(value, 32).replace(/[^0-9+]/g, "");
  if (!/^\+?[0-9]{6,20}$/.test(number)) throw new Error("Numéro invalide.");
  return number;
}

async function call(method, params = {}) {
  const url = new URL(`${BASE_URL}/${method}`);
  for (const [name, value] of Object.entries({ ...params, key: apiKey() })) {
    url.searchParams.set(name, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`SMSCodes HTTP ${response.status}`);
    const data = await response.json();
    const error = clean(data.Error ?? data.error, 300);
    if (error && !/^(none|null|0|false)$/i.test(error)) {
      const err = new Error(`SMSCodes: ${error}`);
      err.code = clean(data.Status ?? data.status, 40) || "SMSCODES_ERROR";
      err.details = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

const ready = () => Boolean(String(process.env.SMSCODES_API_KEY || "").trim());
const getRentalCountries = () => call("GetRentalCountries");
const getPremiumCountries = () => call("GetPremiumCountries");
const getRentalCountryFlags = () => call("GetRentalCountryFlags");
const getPremiumCountryFlags = () => call("GetPremiumCountryFlags");
const getServiceCodes = () => call("GetServiceCodes");

function getServiceCodeLogos({ page = 1, pageSize = 20 } = {}) {
  return call("GetServiceCodeLogos", {
    page: positiveInt(page, "Page", 100000),
    pagesize: positiveInt(pageSize, "Taille de page", 100)
  });
}

function searchServiceCodeLogos(search) {
  const term = clean(search, 100);
  if (term.length < 2) throw new Error("Recherche trop courte.");
  return call("SearchServiceCodeLogos", { search: term });
}

function getCountryServiceCodeLogos({ iso, page = 1, pageSize = 20 }) {
  return call("GetCountryServiceCodeLogos", {
    iso: isoCode(iso),
    page: positiveInt(page, "Page", 100000),
    pagesize: positiveInt(pageSize, "Taille de page", 100)
  });
}

function rentNumber({ iso, serviceId }) {
  const service = clean(serviceId, 100);
  if (!service) throw new Error("serviceId requis.");
  return call("RentNumber", { iso: isoCode(iso), serviceId: service });
}

const rentNumberAllServices = ({ iso }) => call("RentNumberAllServices", { iso: isoCode(iso) });
const rentNumberPremium = ({ iso }) => call("RentNumberPremium", { iso: isoCode(iso) });

function checkRentedNumber(orderId) {
  const id = clean(orderId, 120);
  if (!id) throw new Error("OrderId requis.");
  return call("CheckRentedNumber", { orderId: id });
}

const getLiveRentedNumbers = () => call("GetLiveRentedNumbers");
const getRentedNumbers = () => call("GetRentedNumbers");
const renewRentedNumber = (number) => call("RenewRentedNumber", { number: phoneNumber(number) });

function setAutoRenew({ number, auto }) {
  if (typeof auto !== "boolean") throw new Error("auto doit être un booléen.");
  return call("SetAutoRenew", { number: phoneNumber(number), auto: String(auto) });
}

const setRentedNumber = (number) => call("SetRentedNumber", { number: phoneNumber(number) });

function getRentedSms({ sid, number, amount = 1 }) {
  const securityId = clean(sid, 180);
  if (!securityId) throw new Error("SecurityId requis.");
  return call("GetRentedSMSCode", {
    sid: securityId,
    number: phoneNumber(number),
    amount: positiveInt(amount, "Nombre de SMS", 50)
  });
}

module.exports = {
  BASE_URL,
  ready,
  getRentalCountries,
  getPremiumCountries,
  getRentalCountryFlags,
  getPremiumCountryFlags,
  getServiceCodes,
  getServiceCodeLogos,
  searchServiceCodeLogos,
  getCountryServiceCodeLogos,
  rentNumber,
  rentNumberAllServices,
  rentNumberPremium,
  checkRentedNumber,
  getLiveRentedNumbers,
  getRentedNumbers,
  renewRentedNumber,
  setAutoRenew,
  setRentedNumber,
  getRentedSms
};
