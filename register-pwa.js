"use strict";
(() => {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", async () => {
    try { await navigator.serviceWorker.register("/sw.js", { scope: "/" }); }
    catch (err) { console.warn("PWA_SERVICE_WORKER", err?.message || err); }
  });
})();
