// OpenClaude Service Worker
// App-shell caching only. Never intercept /ws, /api/*, or external CDN requests.
const VERSION = 'openclaude-v92'
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/style.css?v=60', // versioned URL used in index.html
  '/manifest.json',
  '/icon.svg',
  // ES modules
  '/modules/main.js',
  '/modules/main.js?v=72', // versioned URL used in index.html
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
  '/modules/oauth.js',
  '/modules/proxy.js',
  '/modules/proxy.js?v=1',
  '/modules/memory.js',
  '/modules/tasks.js',
  '/modules/agents.js',
  '/modules/agents.js?v=7',
  '/modules/effortMode.js',
  '/modules/effortMode.js?v=2',
  '/modules/modelMode.js',
  '/modules/modelMode.js?v=1',
  '/modules/planMode.js',
  '/modules/planMode.js?v=4',
  '/modules/sessions.js',
  '/modules/sessions.js?v=10',
  '/modules/sync.js',
  '/modules/sync.js?v=9',
  '/modules/messages.js',
  '/modules/messages.js?v=46',
  '/modules/planPanel.js',
  '/modules/planPanel.js?v=3',
  '/modules/websocket.js',
  '/modules/websocket.js?v=48',
  '/modules/commands.js',
  '/modules/commands.js?v=8',
  '/modules/goalControl.js',
  '/modules/goalControl.js?v=3',
  '/modules/goalMode.js',
  '/modules/goalMode.js?v=3',
  '/modules/wechat.js',
  '/modules/officialTerminal.js',
  '/modules/officialTerminal.js?v=16',
  '/modules/export-docx.js',
  '/modules/export-tex.js',
  // Vendored dependencies
  '/vendor/marked.min.js',
  '/vendor/highlight.min.js',
  '/vendor/purify.min.js',
  '/vendor/qrcode.min.js',
  '/vendor/chart.umd.min.js',
  '/vendor/github-dark.min.css',
  '/vendor/github.min.css',
  '/vendor/xterm/xterm.css?v=1',
  '/vendor/xterm/xterm.js',
  '/vendor/xterm/addon-fit.js',
  '/vendor/katex/katex.min.js',
  '/vendor/katex/katex.min.css',
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

  // Network-first for HTML shell so updates are picked up quickly.
  // Use pathname-only key for documents to avoid cache proliferation from query params.
  if (
    req.destination === 'document' ||
    req.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname.endsWith('.html')
  ) {
    const docKey = new Request(url.pathname, { headers: req.headers })
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches
            .open(VERSION)
            .then((c) => c.put(docKey, copy))
            .catch(() => {})
          return res
        })
        .catch(() => caches.match(docKey).then((m) => m || caches.match('/index.html'))),
    )
    return
  }

  // App modules (/modules/*.js) use network-first so code updates take effect immediately.
  // Vendor libs and CSS use cache-first since they rarely change.
  const isAppModule = url.pathname.startsWith('/modules/') && url.pathname.endsWith('.js')

  if (isAppModule) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.status === 200) {
            const copy = res.clone()
            caches
              .open(VERSION)
              .then((c) => c.put(req, copy))
              .catch(() => {})
          }
          return res
        })
        .catch(() => caches.match(req)),
    )
    return
  }

  // Cache-first for vendor assets (JS/CSS libs that rarely change)
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached
      return fetch(req).then((res) => {
        if (res.status === 200) {
          const copy = res.clone()
          caches
            .open(VERSION)
            .then((c) => c.put(req, copy))
            .catch(() => {})
        }
        return res
      })
    }),
  )
})
