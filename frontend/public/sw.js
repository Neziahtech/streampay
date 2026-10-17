/**
 * StreamPay Service Worker
 *
 * Caching Strategies:
 * 1. Static Assets & App Shell: Cache-first with network fallback.
 * 2. Navigations: Network-first with offline.html fallback.
 * 3. Account & Stream Data: Stale-While-Revalidate (SWR) for offline field reads.
 * 4. Versioned Cache Invalidation: Purges all contract data caches whenever
 *    the contract ID changes or app version bumps.
 */

// Extract contractId and version from SW query string: /sw.js?contractId=...&v=...
const swUrl = new URL(self.location.href);
const contractIdParam = swUrl.searchParams.get("contractId") || "default";
const versionParam = swUrl.searchParams.get("v") || "1";

const STATIC_CACHE = `streampay-static-v${versionParam}`;
const DATA_CACHE = `streampay-data-${contractIdParam}-v${versionParam}`;

const PRECACHE_ASSETS = [
  "/",
  "/manifest.webmanifest",
  "/offline.html",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable.png",
];

// Install: precache essential shell assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate: purge obsolete static caches and old contract caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          // Invalidate any data cache from older contract IDs or versions
          if (key.startsWith("streampay-data-") && key !== DATA_CACHE) {
            return caches.delete(key);
          }
          // Invalidate obsolete static caches
          if (key.startsWith("streampay-static-") && key !== STATIC_CACHE) {
            return caches.delete(key);
          }
          return Promise.resolve(false);
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Message handling: allows client to trigger immediate cache invalidation on contract-id switch
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (event.data && event.data.type === "INVALIDATE_CONTRACT_CACHE") {
    const targetContractId = event.data.contractId;
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((k) => k.startsWith("streampay-data-") && !k.includes(targetContractId))
          .map((k) => caches.delete(k))
      );
    });
  }
});

// Helper: Determine request category
function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".svg") ||
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".woff2")
  );
}

function isDataRequest(request, url) {
  // RPC queries, indexer events, or API routes
  return (
    url.hostname.includes("stellar.org") ||
    url.pathname.startsWith("/api/") ||
    request.headers.get("accept")?.includes("application/json")
  );
}

// Fetch handler
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Non-GET requests (e.g. POST to RPC) cannot be cached by the Cache API
  if (request.method !== "GET") {
    return;
  }

  // 1. Navigation requests (HTML pages)
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          const fallback = await caches.match("/offline.html");
          return fallback || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
        })
    );
    return;
  }

  // 2. Static Assets: Cache-first
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const copy = networkRes.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
          }
          return networkRes;
        });
      })
    );
    return;
  }

  // 3. Account / Stream Data: Stale-While-Revalidate (SWR)
  if (isDataRequest(request, url)) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async (cache) => {
        const cachedResponse = await cache.match(request);

        const networkFetch = fetch(request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              cache.put(request, networkResponse.clone());
            }
            return networkResponse;
          })
          .catch(() => {
            // Network failure: return cached if available, else JSON error
            return cachedResponse || new Response(
              JSON.stringify({ error: "Offline: Network unavailable", offline: true }),
              { status: 503, headers: { "Content-Type": "application/json" } }
            );
          });

        // Return cached immediately if available (stale), revalidate in background
        return cachedResponse || networkFetch;
      })
    );
    return;
  }

  // Default: Network with cache fallback
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});
