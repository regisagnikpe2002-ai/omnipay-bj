"use strict";
module.exports=function connectorErrors(err,req,res,next){
  console.error("[OMNIPAY_CONNECTOR]",err.message,err.details||"");
  res.status(err.status||500).json({ok:false,message:err.message||"Erreur interne",details:process.env.NODE_ENV==="production"?undefined:err.details});
};
