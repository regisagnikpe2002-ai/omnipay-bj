"use strict";
(() => {
  let deferredPrompt = null;
  const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

  function ensureUI() {
    let wrap = document.getElementById("om-pwa-install");
    if (wrap) return wrap;
    wrap = document.createElement("section");
    wrap.id = "om-pwa-install";
    wrap.hidden = true;
    wrap.setAttribute("aria-live", "polite");
    wrap.innerHTML = `
      <div class="om-pwa-install-card">
        <div class="om-pwa-install-icon" aria-hidden="true">📱</div>
        <div class="om-pwa-install-copy">
          <strong>Installer OMNIPAY</strong>
          <span id="om-pwa-install-text">Accédez plus rapidement à votre espace OMNIPAY.</span>
        </div>
        <button type="button" id="om-pwa-install-btn">Installer</button>
        <button type="button" id="om-pwa-install-close" aria-label="Fermer">×</button>
      </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector("#om-pwa-install-close").addEventListener("click", () => { wrap.hidden = true; });
    return wrap;
  }

  async function triggerInstall() {
    const wrap = ensureUI();
    const btn = wrap.querySelector("#om-pwa-install-btn");
    const text = wrap.querySelector("#om-pwa-install-text");

    if (deferredPrompt) {
      btn.disabled = true;
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch (_) {}
      deferredPrompt = null;
      wrap.hidden = true;
      btn.disabled = false;
      return;
    }

    if (isIOS() && !isStandalone()) {
      text.textContent = "Dans Safari : Partager → Ajouter à l’écran d’accueil.";
      btn.hidden = true;
      wrap.hidden = false;
    }
  }

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredPrompt = event;
    if (!isStandalone()) {
      const wrap = ensureUI();
      wrap.hidden = false;
      wrap.querySelector("#om-pwa-install-btn").addEventListener("click", triggerInstall, { once: true });
    }
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    const wrap = document.getElementById("om-pwa-install");
    if (wrap) wrap.hidden = true;
  });

  window.addEventListener("DOMContentLoaded", () => {
    if (isStandalone()) return;
    if (isIOS()) {
      const wrap = ensureUI();
      wrap.hidden = false;
      wrap.querySelector("#om-pwa-install-text").textContent = "Dans Safari : Partager → Ajouter à l’écran d’accueil.";
      wrap.querySelector("#om-pwa-install-btn").hidden = true;
    }
  });
})();
