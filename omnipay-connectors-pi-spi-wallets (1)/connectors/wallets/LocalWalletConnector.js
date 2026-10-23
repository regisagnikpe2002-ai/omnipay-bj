"use strict";
const crypto=require("crypto");
const BaseConnector=require("../core/BaseConnector");
const {request}=require("../core/httpClient");

class LocalWalletConnector extends BaseConnector {
  constructor(id,config,timeoutMs) { super({id,enabled:config.enabled}); this.config=config; this.timeoutMs=timeoutMs; }
  async execute(action,payload) {
    this.assertEnabled();
    const amount=this.normalizeAmount(payload.amount);
    const body={...payload,amount,currency:payload.currency||"XOF",reference:payload.reference||crypto.randomUUID()};
    if (!this.config.baseUrl) return { status:202,data:{connector:this.id,action,state:"PENDING",mock:true,...body} };
    return request(`${this.config.baseUrl}/${action}`,{method:"POST",timeoutMs:this.timeoutMs,headers:{"Content-Type":"application/json","X-API-Key":this.config.apiKey},body});
  }
  collect(payload){ return this.execute("collect",payload); }
  disburse(payload){ return this.execute("disburse",payload); }
}
module.exports=LocalWalletConnector;
