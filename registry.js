"use strict";
const config=require("../config/connectors");
const PiSpiConnector=require("./pi-spi/PiSpiConnector");
const LocalWalletConnector=require("./wallets/LocalWalletConnector");

const registry=new Map();
registry.set("pi-spi",new PiSpiConnector(config.piSpi,config.timeoutMs));
for (const [id,cfg] of Object.entries(config.wallets)) registry.set(id,new LocalWalletConnector(id,cfg,config.timeoutMs));

function getConnector(id){
  const connector=registry.get(String(id||"").toLowerCase());
  if(!connector) throw Object.assign(new Error("Connecteur inconnu"),{status:404});
  return connector;
}
function listConnectors(){ return [...registry.values()].map(c=>({id:c.id,enabled:c.enabled})); }
module.exports={getConnector,listConnectors};
