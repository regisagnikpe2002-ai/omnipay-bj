"use strict";
const {getConnector}=require("../connectors/registry");

function requireFields(body,fields){
  const missing=fields.filter(k=>body[k]===undefined || body[k]===null || body[k]==="");
  if(missing.length) throw Object.assign(new Error(`Champs requis: ${missing.join(", ")}`),{status:400});
}
async function receive({provider,...payload}) { requireFields(payload,["amount","payer"]); return getConnector(provider).collect(payload); }
async function pay({provider,...payload}) { requireFields(payload,["amount","beneficiary"]); const c=getConnector(provider); return provider==="pi-spi"?c.pay(payload):c.disburse(payload); }
module.exports={receive,pay};
