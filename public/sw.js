"use strict";
const CACHE = "omnipay-shell-v1";
const SHELL = [
  "/offline.html",
  "/manifest.webmanifest",
  "/omni-ui-dynamic.css",
  "/omni-ui-dynamic.js",
  "/icons/omnipay-192.png",
  "/icons/omnipay-512.png",
  "/icons/omnipay-maskable-512.png"
];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (req.mode === "navigate") {
    event.respondWith(fetch(req, { cache: "no-store" }).catch(() => caches.match("/offline.html")));
    return;
  }
  if (["style", "script", "image", "font"].includes(req.destination)) {
    event.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(cache => cache.put(req, copy));
      return res;
    })));
  }
});
