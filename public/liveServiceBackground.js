"use strict";

/* OMNIPAY - Fond d'ecran adaptatif selon les services reellement operationnels.
 * Frontend only. Lit les routes publiques disponibles et n'affiche jamais un
 * service comme actif sur la seule base du catalogue marketing.
 */

(function () {
  const THEMES = {
    pispi: {
      key: "pispi",
      label: "PI-SPI",
      gradient: "linear-gradient(135deg,#031525 0%,#063d47 42%,#0b7b5c 100%)",
      glow: "rgba(23,199,132,.24)"
    },
    mobile: {
      key: "mobile",
      label: "Mobile Money",
      gradient: "linear-gradient(135deg,#08162b 0%,#173d76 45%,#0a8c8c 100%)",
      glow: "rgba(35,151,255,.22)"
    },
    crypto: {
      key: "crypto",
      label: "Crypto",
      gradient: "linear-gradient(135deg,#100d25 0%,#34235f 45%,#a46b16 100%)",
      glow: "rgba(245,181,57,.22)"
    },
    omnipay: {
      key: "omnipay",
      label: "OMNIPAY",
      gradient: "linear-gradient(135deg,#07111f 0%,#102843 52%,#0b5d62 100%)",
      glow: "rgba(31,188,176,.18)"
    }
  };

  const state = { services: new Set(), index: 0, timer: null };

  function root() {
    return document.documentElement;
  }

  function setTheme(theme) {
    const t = THEMES[theme] || THEMES.omnipay;
    root().style.setProperty("--omni-live-bg", t.gradient);
    root().style.setProperty("--omni-live-glow", t.glow);
    document.body.dataset.omniTheme = t.key;
    window.dispatchEvent(new CustomEvent("omnipay:theme", { detail: t }));
  }

  function chooseThemes() {
    const names = [...state.services];
    if (!names.length) return ["omnipay"];
    const themes = [];
    if (names.includes("pispi")) themes.push("pispi");
    if (["mtn", "moov", "celtiis", "merchant_sim"].some(x => names.includes(x))) themes.push("mobile");
    if (["binance", "coingate", "crypto", "metamask"].some(x => names.includes(x))) themes.push("crypto");
    return themes.length ? themes : ["omnipay"];
  }

  async function readJson(url) {
    const response = await fetch(url, { credentials: "same-origin", headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(String(response.status));
    return response.json();
  }

  async function detect() {
    const operational = new Set();

    const checks = await Promise.allSettled([
      readJson("/api/services"),
      readJson("/api/treasury").catch(() => null)
    ]);

    const catalog = checks[0].status === "fulfilled" ? checks[0].value : null;
    const treasury = checks[1].status === "fulfilled" ? checks[1].value : null;

    if (catalog && Array.isArray(catalog.services)) {
      for (const item of catalog.services) {
        if (["active", "supervised", "operational", "ready"].includes(String(item.status || "").toLowerCase())) {
          operational.add(String(item.code || "").toLowerCase());
        }
      }
    }

    if (treasury && treasury.pispi && treasury.pispi.alias) operational.add("pispi");

    state.services = operational;
    return [...operational];
  }

  function startRotation() {
    if (state.timer) clearInterval(state.timer);
    const themes = chooseThemes();
    state.index = 0;
    setTheme(themes[0]);
    if (themes.length < 2 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    state.timer = setInterval(() => {
      state.index = (state.index + 1) % themes.length;
      setTheme(themes[state.index]);
    }, 9000);
  }

  async function init() {
    try { await detect(); } catch (_) { state.services = new Set(); }
    startRotation();
  }

  window.OMNIPAY_LIVE_THEME = {
    init,
    refresh: async () => { await detect(); startRotation(); },
    activeServices: () => [...state.services],
    setTheme
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
