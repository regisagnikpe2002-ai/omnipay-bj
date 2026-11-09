/* OMNIPAY — service worker.
   Règle d'or : aucune donnée financière n'est jamais mise en cache. Seules les pages et images statiques le sont.
   Toute requête vers l'API (auth, wallet, api/*) va toujours au réseau. */
const VERSION = "omnipay-v1";
const SHELL = ["/", "/offline.html", "/manifest.json", "/logo.svg", "/omnipay-shield.svg", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];
const NEVER = /^\/(auth|wallet|api|admin|healthz|2fa|webhook|pay|transfer)/i;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== location.origin || NEVER.test(u.pathname)) return;   // réseau direct
  if (r.mode === "navigate") {                                                                  // pages : réseau d'abord, repli hors-ligne
    e.respondWith(fetch(r).then((res) => { if (res.ok && u.pathname === "/") { const cp = res.clone(); caches.open(VERSION).then((c) => c.put("/", cp)); } return res; })
      .catch(() => caches.match(r).then((m) => m || caches.match("/") || caches.match("/offline.html"))));
    return;
  }
  e.respondWith(caches.match(r).then((m) => {                                                   // statiques : cache puis mise à jour discrète
    const net = fetch(r).then((res) => { if (res.ok && /\.(png|svg|jpg|jpeg|webp|css|js|json|woff2?)$/i.test(u.pathname)) { const cp = res.clone(); caches.open(VERSION).then((c) => c.put(r, cp)); } return res; }).catch(() => m);
    return m || net;
  }));
});
self.addEventListener("message", (e) => { if (e.data === "skip") self.skipWaiting(); });
