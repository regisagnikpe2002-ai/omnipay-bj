"use strict";
const {listConnectors,getConnector}=require("../connectors/registry");
const paymentRouter=require("../services/paymentRouter");

const run=fn=>async(req,res,next)=>{try{const result=await fn(req);res.status(result.status||200).json({ok:true,...result.data});}catch(e){next(e);}};
exports.list=async(req,res)=>res.json({ok:true,connectors:listConnectors()});
exports.health=run(async req=>({status:200,data:await getConnector(req.params.provider).health()}));
exports.receive=run(req=>paymentRouter.receive(req.body));
exports.pay=run(req=>paymentRouter.pay(req.body));
exports.piRequestToPay=run(req=>getConnector("pi-spi").requestToPay(req.body));
exports.piResolveAlias=run(req=>getConnector("pi-spi").resolveAlias(req.body));
exports.piStatus=run(req=>getConnector("pi-spi").paymentStatus(req.params.id));
