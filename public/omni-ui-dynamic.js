"use strict";
(()=>{
  if(window.__OMNI_UI_DYNAMIC__) return; window.__OMNI_UI_DYNAMIC__=true;
  const root=document;
  const $=id=>root.getElementById(id);
  function toast(msg){let t=$("om-ui-toast");if(!t){t=document.createElement("div");t.id="om-ui-toast";t.className="om-toast";t.setAttribute("aria-live","polite");document.body.appendChild(t)}t.textContent=msg;t.classList.add("show");clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove("show"),2200)}
  function clickText(rx){const all=[...root.querySelectorAll("button,.tile,.opt,[role=button],a")];const el=all.find(x=>rx.test((x.textContent||"").trim())&&!x.disabled&&!x.classList.contains("off"));if(el){el.click();return true}return false}
  const actions=[
    {label:"Envoyer",icon:"↗",primary:true,rx:/envoyer|transf[eé]rer/i},
    {label:"Recevoir",icon:"↙",rx:/recevoir|mon qr|qr.*rece/i},
    {label:"Déposer",icon:"＋",rx:/d[eé]poser|d[eé]p[oô]t/i},
    {label:"Retirer",icon:"−",rx:/retirer|retrait/i}
  ];
  function mount(){
    if($("om-quick-actions")) return;
    const anchor=$("home")||$("dashboard")||root.querySelector(".bal")||root.querySelector("main")||root.body.firstElementChild;
    if(!anchor) return;
    const shell=document.createElement("section");shell.id="om-quick-actions";shell.className="om-quick-shell";shell.innerHTML=`<div class="om-quick-head"><div><strong>Actions rapides</strong><br><small>Les fonctions essentielles OMNIPAY</small></div><span class="om-live-pill">Services</span></div><div class="om-quick-grid"></div>`;
    const grid=shell.querySelector(".om-quick-grid");
    actions.forEach(a=>{const b=document.createElement("button");b.type="button";b.className="om-quick"+(a.primary?" primary":"");b.innerHTML=`<span class="om-icon" aria-hidden="true">${a.icon}</span><span>${a.label}</span>`;b.addEventListener("click",()=>{if(!clickText(a.rx)) toast(`${a.label} : option bientôt reliée à cet écran.`)});grid.appendChild(b)});
    if(anchor.parentNode) anchor.parentNode.insertBefore(shell,anchor.nextSibling);
  }
  function enhance(){root.querySelectorAll("button,.tile,.opt,[role=button]").forEach(el=>{if(!el.hasAttribute("type")&&el.tagName==="BUTTON")el.type="button";if(!el.hasAttribute("aria-label")){const t=(el.textContent||"").trim();if(t)el.setAttribute("aria-label",t.slice(0,80))}})}
  document.addEventListener("DOMContentLoaded",()=>{mount();enhance();new MutationObserver(enhance).observe(document.body,{subtree:true,childList:true})});
})();
