// Greek Reader service worker: offline-first app shell + data shards.
//
// Strategy: stale-while-revalidate for same-origin GET requests
//   - answer from cache immediately, refresh in the background
//   - /api/* is NEVER cached (live endpoints must hit the network)
//   - cache entries are versioned by URL inside one named cache; a simple
//     insertion-order trim keeps it around 300 entries (LRU-ish)
//   - navigation requests fall back to the cached shell when offline

const CACHE = "greek-reader-v2";
const MAX_ENTRIES = 300;

// TTS payload is grc-only (ancient Greek, reconstructed) — dist/espeak-ng.wasm ~1.1MB raw (≤5MB target).
// Precached at install for offline use; fetched lazily in-app only on first 🔊 click (dynamic import + fetch).
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(["/", "/index.html", "/espeak-ng.wasm"]).catch(() => {}))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_ENTRIES) return;
  // keys() returns insertion order — delete the oldest beyond the cap
  for (const req of keys.slice(0, keys.length - MAX_ENTRIES)) {
    await cache.delete(req);
  }
}

function isCacheable(response) {
  return response && response.ok && response.type === "basic";
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // live endpoints only

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: false });

    const refresh = fetch(req).then((response) => {
      if (isCacheable(response)) {
        cache.put(req, response.clone()).then(() => trim(cache));
      }
      return response;
    }).catch(() => null);

    if (cached) {
      event.waitUntil(refresh);
      return cached;
    }

    const fresh = await refresh;
    if (fresh) return fresh;

    // offline miss: navigation → cached shell; else generic failure
    if (req.mode === "navigate") {
      const shell = await cache.match("/index.html");
      if (shell) return shell;
    }
    return new Response("offline", { status: 503, statusText: "offline" });
  })());
});
