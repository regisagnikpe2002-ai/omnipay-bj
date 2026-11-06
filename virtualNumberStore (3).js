"use strict";
const { neon } = require("@neondatabase/serverless");
const crypto = require("crypto");

const sql = () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL manquante.");
  return neon(process.env.DATABASE_URL);
};
const clean=(v,n=180)=>String(v==null?"":v).replace(/[<>]/g,"").trim().slice(0,n);

async function createPreview({userId,countryIso,serviceId,serviceName,customerPrice,currency="XOF"}){
  const q=sql(); const id=crypto.randomUUID();
  const price=Math.round(Number(customerPrice));
  if(!Number.isSafeInteger(price)||price<0) throw new Error("Prix client invalide.");
  const rows=await q`INSERT INTO virtual_number_orders
    (id,user_id,country_iso,service_id,service_name,customer_price,currency,status,metadata)
    VALUES (${id}::uuid,${clean(userId,80)}::uuid,${clean(countryIso,3).toUpperCase()},${clean(serviceId,120)},${clean(serviceName,160)||null},${price},${clean(currency,10).toUpperCase()},'pending',${JSON.stringify({purchaseExecuted:false})}::jsonb)
    RETURNING *`;
  return rows[0];
}

async function listForUser(userId){
  return sql()`SELECT id,provider,provider_order_id,country_iso,service_id,service_name,number,currency,customer_price,commission,status,auto_renew,expires_at,created_at,updated_at FROM virtual_number_orders WHERE user_id=${clean(userId,80)}::uuid ORDER BY created_at DESC LIMIT 100`;
}

async function getForUser(userId,id){
  const rows=await sql()`SELECT * FROM virtual_number_orders WHERE id=${clean(id,80)}::uuid AND user_id=${clean(userId,80)}::uuid LIMIT 1`;
  return rows[0]||null;
}

async function markOrdering(id){
  const rows=await sql()`UPDATE virtual_number_orders SET status='ordering',updated_at=now() WHERE id=${clean(id,80)}::uuid AND status='pending' RETURNING *`;
  return rows[0]||null;
}

async function activate({id,providerOrderId,number,securityId,expiresAt,providerPrice,commission}){
  const rows=await sql()`UPDATE virtual_number_orders SET provider_order_id=${clean(providerOrderId,160)||null},number=${clean(number,40)||null},security_id=${clean(securityId,180)||null},expires_at=${expiresAt||null},provider_price=${providerPrice==null?null:Number(providerPrice)},commission=${Number(commission||0)},status='active',metadata=coalesce(metadata,'{}'::jsonb)||${JSON.stringify({purchaseExecuted:true})}::jsonb,updated_at=now() WHERE id=${clean(id,80)}::uuid AND status='ordering' RETURNING *`;
  return rows[0]||null;
}

async function fail(id,reason){
  const rows=await sql()`UPDATE virtual_number_orders SET status='failed',metadata=coalesce(metadata,'{}'::jsonb)||${JSON.stringify({failureReason:clean(reason,300)})}::jsonb,updated_at=now() WHERE id=${clean(id,80)}::uuid AND status IN ('pending','ordering') RETURNING *`;
  return rows[0]||null;
}

module.exports={createPreview,listForUser,getForUser,markOrdering,activate,fail};
