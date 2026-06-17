/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

// Studio PWA service worker.
//
// Goals:
//   - Make the Studio installable (a SW with a fetch handler is required for
//     the install prompt) and give it an offline app shell.
//   - NEVER cache /api/* — those are dynamic and auth-sensitive. Same for any
//     non-GET or cross-origin request: straight to network.
//
// SvelteKit injects `build` (hashed JS/CSS), `files` (static/), and `version`
// via the virtual `$service-worker` module. Hashed assets are immutable, so we
// precache them and serve cache-first; navigations are network-first with a
// cached index.html fallback so the SPA still opens offline.

import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `zveltio-studio-${version}`;
// Static assets safe to precache. Skip source maps and the manifest (small,
// fetched fresh). `files` already carries the /admin base path.
const PRECACHE = [...build, ...files.filter((f) => !f.endsWith('.map'))];

sw.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GETs. API calls, mutations, auth, and anything
  // cross-origin must hit the network untouched.
  if (request.method !== 'GET' || url.origin !== sw.location.origin) return;
  if (url.pathname.includes('/api/')) return;

  // Precached immutable assets → cache-first.
  if (PRECACHE.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
    return;
  }

  // Navigations (SPA routes) → network-first, fall back to the cached shell
  // so the app still launches offline. adapter-static uses index.html as the
  // SPA fallback; it lives in `build`/`files` under the base path.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE);
        return (
          (await cache.match(request)) ??
          (await cache.match(`${sw.location.pathname.replace(/\/[^/]*$/, '')}/index.html`)) ??
          (await cache.match('/admin/index.html')) ??
          new Response('Offline', { status: 503, statusText: 'Offline' })
        );
      }),
    );
  }
});
