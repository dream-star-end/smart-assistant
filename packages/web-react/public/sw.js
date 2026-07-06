// Aurora (v5) Service Worker —— 手写、零依赖。
//
// ─────────────────────────────────────────────────────────────────────────────
// 策略（红线：v5 与 v3 同源共存于 Caddy 的 cookie/secret 闸之后）：
//   1. 导航请求(mode==='navigate')：**network-first**。永远先请求网络拿最新 index，
//      仅当 fetch 失败(离线)才回落缓存的 shell。→ 保证在线路由永远由服务端(Caddy 闸)
//      裁决，SW 绝不把某一侧(v3/v5)的 shell 钉死给另一侧。
//   2. /assets/*：**cache-first**。vite 产物是内容哈希文件名(immutable)，缓存即正确；
//      新发版 = 新哈希 = 新请求，老哈希留在缓存里对运行中的旧页面仍可用(降低发版抖动)。
//   3. /api/ 与 /ws 及任何**非 GET** 请求：**一律不拦截**(直接 return，不 respondWith)。
//      数据面 / 实时面 / 写操作永远走网络，SW 不介入。
//   4. 跨源请求不拦截(交给浏览器默认)。
//
// 与 v3 vanilla sw.js 共存安全性：两者导航都 network-first(在线路由永远正确)，
// 资产命名空间不相交(v5=/assets/*，v3=/modules/* + /vendor/*)，v5 资产哈希 immutable
// 可被任一 SW 安全 cache-first；谁后注册谁控 scope '/'，但因上述不变式，不会错服。
//
// 更新策略：注册侧 updateViaCache:'none'(sw.js 本身不吃 HTTP 缓存)；本文件 install
// skipWaiting + activate clientsClaim → 新版本即时接管；改动 sw.js 时 bump SW_VERSION
// 触发 activate 清理旧 cache(便于强刷)。
// ─────────────────────────────────────────────────────────────────────────────

const SW_VERSION = 'aurora-sw-v1';
const CACHE = SW_VERSION;
// 离线导航回落用的 app-shell 键。SPA 下所有导航路由都返回同一份 index，故统一存此键。
const OFFLINE_SHELL = '/index.html';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // 预缓存 shell：首次安装后即便立刻离线也能开壳(再由前端做在线态兜底)。
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.add(new Request(OFFLINE_SHELL, { cache: 'reload' })))
      .catch(() => {}),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 导航：network-first，失败(离线)回落缓存 shell。成功时顺手刷新缓存的 shell。
async function networkFirstNav(request) {
  try {
    const res = await fetch(request);
    // 只缓存正常 HTML shell（200）；把它存到统一 shell 键供离线回落。
    if (res && res.status === 200) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(OFFLINE_SHELL, copy)).catch(() => {});
    }
    return res;
  } catch {
    const cached = await caches.match(OFFLINE_SHELL);
    if (cached) return cached;
    return new Response('离线：暂时无法加载页面。', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

// /assets/*：cache-first（内容哈希 immutable）。命中即返回；未命中拉网络并缓存。
async function cacheFirstAsset(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res && res.status === 200) {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // 非 GET(写操作)一律不拦

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨源交给浏览器

  // 数据面 / 实时面永不拦截。
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  // 导航：network-first。
  if (req.mode === 'navigate') {
    event.respondWith(networkFirstNav(req));
    return;
  }

  // 哈希资产：cache-first。
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirstAsset(req));
    return;
  }

  // 其余(图标 / manifest / 字体等)：不拦截，走浏览器默认(gateway 已给 no-cache + ETag)。
});
