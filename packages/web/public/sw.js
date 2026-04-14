// OpenClaude Service Worker
// App-shell caching only. Never intercept /ws, /api/*, or external CDN requests.
const VERSION = 'openclaude-v8'
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/manifest.json',
  '/icon.svg',
  // ES modules
  '/modules/main.js',
  '/modules/dom.js',
  '/modules/util.js',
  '/modules/state.js',
  '/modules/api.js',
  '/modules/db.js',
  '/modules/theme.js',
  '/modules/markdown.js',
  '/modules/ui.js',
  '/modules/attachments.js',
  '/modules/speech.js',
  '/modules/notifications.js',
  '/modules/permissions.js',
  '/modules/oauth.js',
  '/modules/memory.js',
  '/modules/tasks.js',
  '/modules/agents.js',
  '/modules/sessions.js',
  '/modules/messages.js',
  '/modules/websocket.js',
  '/modules/commands.js',
  // Vendored dependencies
  '/vendor/marked.min.js',
  '/vendor/highlight.min.js',
  '/vendor/mermaid.min.js',
  '/vendor/purify.min.js',
  '/vendor/chart.umd.min.js',
  '/vendor/github-dark.min.css',
  '/vendor/github.min.css',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
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
    if (
      url.pathname.startsWith('/ws') ||
      url.pathname.startsWith('/api/') ||
      url.pathname === '/healthz'
    ) {
      return
    }
  }

  // Only handle same-origin GETs. Let CDN / cross-origin pass through.
  if (url.origin !== self.location.origin) return

  // Normalize: strip query string for cache matching (e.g. /app.js?v=3 → /app.js)
  const cacheKey = new Request(url.pathname, { headers: req.headers })

  // Network-first for HTML shell so updates are picked up quickly.
  if (
    req.destination === 'document' ||
    req.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname.endsWith('.html')
  ) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches
            .open(VERSION)
            .then((c) => c.put(cacheKey, copy))
            .catch(() => {})
          return res
        })
        .catch(() => caches.match(cacheKey).then((m) => m || caches.match('/index.html'))),
    )
    return
  }

  // Cache-first for other same-origin static assets (JS/CSS/vendor/*)
  event.respondWith(
    caches.match(cacheKey).then((cached) => {
      if (cached) return cached
      return fetch(req).then((res) => {
        if (res.status === 200) {
          const copy = res.clone()
          caches
            .open(VERSION)
            .then((c) => c.put(cacheKey, copy))
            .catch(() => {})
        }
        return res
      })
    }),
  )
})
