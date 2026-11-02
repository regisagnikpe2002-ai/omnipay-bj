"use strict";

function configured() { return Boolean(process.env.MOOV_API_BASE_URL && process.env.MOOV_API_KEY); }
async function airtime() { throw new Error("Moov airtime non active: documentation/API marchand requise."); }
async function bundle() { throw new Error("Moov forfait non active: documentation/API marchand requise."); }
module.exports = { configured, airtime, bundle };
