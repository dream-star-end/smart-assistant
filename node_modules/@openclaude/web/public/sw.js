// OpenClaude Service Worker
// App-shell caching only. Never intercept /ws, /api/*, or external CDN requests.
const VERSION = 'openclaude-v3'
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/manifest.json', '/icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)

  // Never cache same-origin dynamic endpoints
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/ws') || url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
      return
    }
  }

  // Only handle same-origin GETs. Let CDN / cross-origin pass through.
  if (url.origin !== self.location.origin) return

  // Network-first for HTML shell so updates are picked up quickly.
  if (req.destination === 'document' || req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {})
          return res
        })
        .catch(() => caches.match(req).then((m) => m || caches.match('/index.html'))),
    )
    return
  }

  // Cache-first for other same-origin static assets
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached
      return fetch(req).then((res) => {
        if (res.status === 200) {
          const copy = res.clone()
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {})
        }
        return res
      })
    }),
  )
})
