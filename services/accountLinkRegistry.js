"use strict";

const PROVIDERS = Object.freeze({
  mtn:{code:"mtn",name:"MTN MoMo",kind:"mobile",identifierType:"phone",canDeposit:true,canWithdraw:true,requiresOtp:true,requiresAdminReview:true},
  moov:{code:"moov",name:"Moov Money",kind:"mobile",identifierType:"phone",canDeposit:true,canWithdraw:true,requiresOtp:true,requiresAdminReview:true},
  celtiis:{code:"celtiis",name:"Celtiis Cash",kind:"mobile",identifierType:"phone",canDeposit:true,canWithdraw:true,requiresOtp:true,requiresAdminReview:true},
  ecobank:{code:"ecobank",name:"Ecobank / PI-SPI",kind:"bank",identifierType:"account_or_alias",canDeposit:true,canWithdraw:true,requiresOtp:true,requiresAdminReview:true},
  orabank:{code:"orabank",name:"Orabank / PI-SPI",kind:"bank",identifierType:"account_or_alias",canDeposit:true,canWithdraw:true,requiresOtp:true,requiresAdminReview:true},
  biic:{code:"biic",name:"BIIC",kind:"bank",identifierType:"account_or_alias",canDeposit:true,canWithdraw:true,requiresOtp:true,requiresAdminReview:true},
  paypal:{code:"paypal",name:"PayPal",kind:"paypal",identifierType:"email_or_public_id",canDeposit:true,canWithdraw:true,requiresOtp:true,requiresAdminReview:true},
  binance:{code:"binance",name:"Binance",kind:"crypto",identifierType:"public_address",canDeposit:true,canWithdraw:true,requiresOtp:true,requiresAdminReview:true,requiresNetwork:true},
  metamask:{code:"metamask",name:"MetaMask",kind:"crypto",identifierType:"public_address",canDeposit:true,canWithdraw:true,requiresOtp:true,requiresAdminReview:true,requiresNetwork:true},
  wallet:{code:"wallet",name:"Portefeuille électronique",kind:"wallet",identifierType:"public_identifier",canDeposit:true,canWithdraw:true,requiresOtp:true,requiresAdminReview:true},
  western_union:{code:"western_union",name:"Western Union",kind:"wallet",identifierType:"public_identifier",canDeposit:false,canWithdraw:false,requiresOtp:true,requiresAdminReview:true,partnershipRequired:true},
  ria:{code:"ria",name:"Ria Money Transfer",kind:"wallet",identifierType:"public_identifier",canDeposit:false,canWithdraw:false,requiresOtp:true,requiresAdminReview:true,partnershipRequired:true},
  autre:{code:"autre",name:"Autre compte ou portefeuille",kind:"wallet",identifierType:"public_identifier",canDeposit:false,canWithdraw:false,requiresOtp:true,requiresAdminReview:true}
});

function getProvider(code){return PROVIDERS[String(code||"").trim().toLowerCase()]||null;}
function publicProviders(){return Object.values(PROVIDERS).map(p=>({code:p.code,name:p.name,kind:p.kind,identifierType:p.identifierType,canDeposit:p.canDeposit,canWithdraw:p.canWithdraw,requiresOtp:p.requiresOtp,requiresAdminReview:p.requiresAdminReview,requiresNetwork:Boolean(p.requiresNetwork),partnershipRequired:Boolean(p.partnershipRequired)}));}
module.exports={getProvider,publicProviders};
