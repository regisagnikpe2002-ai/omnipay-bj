"use strict";

function configured() { return Boolean(process.env.CELTIIS_API_BASE_URL && process.env.CELTIIS_API_KEY); }
async function airtime() { throw new Error("Celtiis airtime non active: acces API marchand requis."); }
async function bundle() { throw new Error("Celtiis forfait non active: acces API marchand requis."); }
module.exports = { configured, airtime, bundle };
