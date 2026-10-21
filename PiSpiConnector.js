"use strict";
const crypto=require("crypto");
const BaseConnector=require("../core/BaseConnector");
const {request}=require("../core/httpClient");

class PiSpiConnector extends BaseConnector {
  constructor(config, timeoutMs) { super({id:"pi-spi",enabled:config.enabled}); this.config=config; this.timeoutMs=timeoutMs; this.token=null; }
  async accessToken() {
    if (this.config.mock) return "sandbox-mock-token";
    if (this.token && this.token.expiresAt>Date.now()+30000) return this.token.value;
    if (!this.config.tokenUrl || !this.config.clientId || !this.config.clientSecret) throw Object.assign(new Error("Configuration OAuth2 PI-SPI incomplète"),{status:503});
    const form=new URLSearchParams({grant_type:"client_credentials",client_id:this.config.clientId,client_secret:this.config.clientSecret});
    if(this.config.scope) form.set("scope",this.config.scope);
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    try {
      const res=await fetch(this.config.tokenUrl,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:form,signal:controller.signal});
      const data=await res.json(); if(!res.ok || !data.access_token) throw Object.assign(new Error("Échec authentification PI-SPI"),{status:502,details:data});
      this.token={value:data.access_token,expiresAt:Date.now()+Number(data.expires_in||300)*1000}; return this.token.value;
    } finally { clearTimeout(timer); }
  }
  path(name,id) { return this.config.paths[name].replace("{id}",encodeURIComponent(id||"")); }
  async call(path,method,body) {
    this.assertEnabled();
    if (this.config.mock) return { status:202, data:{ connector:"pi-spi", transactionId:crypto.randomUUID(), state:"PENDING", mock:true, request:body } };
    const token=await this.accessToken();
    return request(`${this.config.baseUrl}${path}`,{method,timeoutMs:this.timeoutMs,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json","X-Participant-Id":this.config.participantId,"X-Request-Id":crypto.randomUUID()},body});
  }
  pay(input) { return this.call(this.path("pay"),"POST",input); }
  requestToPay(input) { return this.call(this.path("requestToPay"),"POST",input); }
  resolveAlias(input) { return this.call(this.path("alias"),"POST",input); }
  paymentStatus(id) { return this.call(this.path("status",id),"GET"); }
}
module.exports=PiSpiConnector;
