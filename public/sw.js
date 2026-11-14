/* GuestLens service worker: app shell offline; uploads live in IndexedDB, not here. */
const VERSION = "gl-v2";
const SHELL = `${VERSION}-shell`;
const STATIC = `${VERSION}-static`;
// album thumbnails (~25 KB each) survive reloads and flaky venue Wi-Fi; not versioned with the app
const THUMBS = "gl-thumbs";
const THUMBS_MAX = 400;
const PRECACHE = ["/offline", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION) && k !== THUMBS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith(".public.blob.vercel-storage.com") && /\/thumb-[^/]+$/.test(url.pathname)) {
    e.respondWith(thumb(req, url));
    return;
  }
  if (url.origin !== self.location.origin) return; // full-size media, fonts: let the browser handle it
  if (url.pathname.startsWith("/api/")) return; // always live

  // hashed build assets never change: cache-first
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    e.respondWith(
      caches.open(STATIC).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  // pages: network-first, so guests always get fresh HTML; fall back to the last copy, then /offline
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && url.pathname.startsWith("/e/")) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(url.pathname, copy));
          }
          return res;
        })
        .catch(async () => (await caches.match(url.pathname)) || (await caches.match("/offline"))),
    );
  }
});

/**
 * Cache-first for thumbnails. We fetch our own CORS copy so the cache holds real (non-opaque)
 * responses: Chrome counts every opaque response as ~7 MB of quota. If the CDN refuses CORS we
 * just pass the original request through uncached. Blob URLs are content-unique, so cache-first
 * can never serve a stale image.
 */
async function thumb(req, url) {
  const cache = await caches.open(THUMBS);
  const hit = await cache.match(url.href);
  if (hit) return hit;
  try {
    const res = await fetch(url.href, { mode: "cors", credentials: "omit" });
    if (res.ok && res.type === "cors") {
      cache.put(url.href, res.clone()).then(() => trim(cache)).catch(() => {});
      return res;
    }
  } catch {}
  return fetch(req);
}

let trimming = false;
async function trim(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys(); // insertion order: oldest first
    for (const k of keys.slice(0, Math.max(0, keys.length - THUMBS_MAX))) await cache.delete(k);
  } finally {
    trimming = false;
  }
}
