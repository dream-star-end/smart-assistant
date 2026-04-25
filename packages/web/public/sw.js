// OpenClaude Service Worker
// App-shell caching only. Never intercept /ws, /api/*, or external CDN requests.
const VERSION = 'openclaude-5241d45'
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/style.css?v=5241d45',  // versioned URL used in index.html
  '/manifest.json',
  '/icon.svg',
  // ES modules
  '/modules/main.js',
  '/modules/main.js?v=5241d45',  // versioned URL used in index.html
  '/modules/auth.js',
  '/modules/auth.js?v=5241d45',  // versioned URL used in main.js import (session cookie mint/clear)
  '/modules/billing.js',
  '/modules/billing.js?v=5241d45',  // versioned URL used in main.js import (mobile H5 pay + 积分 formatter)
  '/modules/userPrefs.js',
  '/modules/userPrefs.js?v=5241d45',  // versioned URL used in main.js import (prefs modal redesign)
  '/modules/usageStats.js',
  '/modules/usageStats.js?v=5241d45',  // 版本化 URL(main.js import 带 ?v=)
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
  '/modules/memory.js',
  '/modules/tasks.js',
  '/modules/agents.js',
  '/modules/agents.js?v=5241d45',  // 版本化 URL(main.js import 带 ?v=)
  '/modules/effortMode.js',
  '/modules/sessions.js',
  '/modules/sync.js',
  '/modules/messages.js',
  '/modules/websocket.js',
  '/modules/commands.js',
  '/modules/wechat.js',
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
      url.pathname === '/healthz' ||
      url.pathname === '/version'
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
    // 2026-04-22 bug-fix:ES module `import './api.js'` 不带 ?v=,走 bare path。
    // 如果不加 `cache: 'no-store'`,SW 的 fetch(req) 会命中浏览器自己的 http cache
    // (Cache-Control: max-age=14400 来自 Caddy/CF),拿回的仍是旧版 —— 然后
    // SW 把旧版 put 进 caches storage,后续所有 fetch 继续吃旧。现象:deploy 后
    // 新 main.js 带新 ?v= 会拉新,但新 main.js 里 `import './api.js'` 走 bare path,
    // 命中旧 api.js → "module does not provide an export named X" 崩溃。
    // no-store 只影响浏览器 http cache;CF edge 仍会命中缓存(4h max-age),但
    // deploy 后我们主动 rsync + 浏览器 request 直接到 CF,CF miss 后回源 Caddy
    // 拿到新版 —— 整条链路最多一次 round-trip 就对齐了。
    event.respondWith(
      fetch(req, { cache: 'no-store' })
        .then((res) => {
          if (res.status === 200) {
            const copy = res.clone()
            caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {})
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
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {})
        }
        return res
      })
    }),
  )
})
