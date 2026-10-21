"use strict";

class BaseConnector {
  constructor({ id, enabled=false }) { this.id=id; this.enabled=enabled; }
  assertEnabled() {
    if (!this.enabled) { const e=new Error(`Connecteur ${this.id} désactivé`); e.status=503; throw e; }
  }
  normalizeAmount(amount) {
    const n=Number(amount);
    if (!Number.isFinite(n) || n <= 0) { const e=new Error("Montant invalide"); e.status=400; throw e; }
    return Math.round(n);
  }
  async health() { return { id:this.id, enabled:this.enabled, status:this.enabled?"ready":"disabled" }; }
}
module.exports=BaseConnector;
