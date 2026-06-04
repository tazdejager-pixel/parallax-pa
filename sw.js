/* Parallax PA - service worker (offline shell + push) */
const CACHE = "parallax-pa-v4";
const SHELL = [
  "./", "./index.html", "./styles.css", "./app.js", "./config.js",
  "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Network-first for API/webhook calls; cache-first for the app shell.
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request).catch(() => caches.match("./index.html")))
  );
});

/* Web Push - executor decision notifications */
self.addEventListener("push", (e) => {
  let payload = { title: "Parallax PA", body: "You have a new message." };
  try { if (e.data) payload = e.data.json(); } catch (_) {}
  e.waitUntil(
    self.registration.showNotification(payload.title || "Parallax PA", {
      body: payload.body || "",
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      data: payload.data || {},
      tag: payload.tag || "pa-message",
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow("./index.html#inbox");
    })
  );
});
