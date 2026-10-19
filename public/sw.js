// v2 — the previous service worker (CACHE = "asciiweb-v1", never bumped)
// used a cache-first strategy: once a file was cached, it was served from
// cache forever and never re-checked against the network, because the
// cache name never changed between deploys, so the old cache was never
// evicted by the activate handler either. Combined with opportunistic
// caching of every successful GET (including /wasm/*.js, /wasm/*.wasm and
// the app's JS bundle), the practical effect was: whichever version of the
// app a browser first loaded is the version it kept forever, regardless of
// how many fixes were pushed afterwards.
//
// This version bumps the cache name (so old caches get cleaned up on
// activate) and switches to network-first for everything, falling back to
// cache only when the network is unreachable (offline). That keeps the
// "works offline" property while making sure a browser that *can* reach
// the network always gets the latest deploy.
const CACHE = "asciiweb-v3";

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(["/", "/index.html"])).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok && res.status < 400) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() =>
      caches.match(e.request).then(cached => cached ?? caches.match("/").then(r => r ?? new Response("Offline")))
    )
  );
});
