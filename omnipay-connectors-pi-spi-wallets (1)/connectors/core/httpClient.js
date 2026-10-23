"use strict";

async function request(url, { method="GET", headers={}, body, timeoutMs=15000 }={}) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(), timeoutMs);
  try {
    const res=await fetch(url,{method,headers:{Accept:"application/json",...headers},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});
    const text=await res.text();
    let data=null; try { data=text?JSON.parse(text):null; } catch { data={ raw:text }; }
    if (!res.ok) { const e=new Error(`Erreur connecteur HTTP ${res.status}`); e.status=502; e.details=data; throw e; }
    return { status:res.status, data };
  } finally { clearTimeout(timer); }
}
module.exports={request};
