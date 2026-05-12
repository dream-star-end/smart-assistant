// v3 media URL signing — 客户端配合 /api/media-sign 与 /api/media-signed。
//
// 背景:`<img src="/api/file?path=...">` 在 iOS Safari + Cloudflare CDN 多跳场景下
// 偶发丢 `oc_session` cookie,导致 `[?]` 破图。后端实现 S3 风格 HMAC signed URL
// (mediaSign.ts),前端这里负责:
//
//   1. 把本地绝对路径批量送给 `POST /api/media-sign`,拿到一组短期有效 signed URL
//   2. 维护一个进程内 LRU 缓存(TTL 4min,后端默认签 5min,客户端略短避免边界 race)
//   3. 提供同步 `getCachedSignedUrl(absPath)` 和异步 `signMediaPath(absPath)`,
//      markdown.js 渲染时先查缓存,命中直接用 signed URL 当 src(无闪烁),
//      未命中标记 `data-pending-sign-path` 由 main.js MutationObserver 解析
//   4. 单飞批处理:`debounceMs=50` 内的请求合并,单次 ≤ MAX_BATCH_PATHS=32
//   5. `invalidateSignCache(absPath)` 用于 `<img onerror>` 路径检测到签名过期时
//      主动失效,触发重签
//
// **不依赖 `apiFetch`**:故意走原生 `fetch` + `Authorization: Bearer`,避免 401
// retry/refresh 这条复杂路径污染图片签名 — 签名失败就 fail-silent(签不到原样
// 透明占位),而不是触发"会话过期"全屏跳转。会话过期由其他正常 API 调用先触发。
//
// 单 path → URL 的 dedupe 在 in-flight queue 里做(同一 path 不会发两次请求)。

import { state } from './state.js'

/** 服务端 batch 上限(packages/commercial/src/http/mediaSign.ts MEDIA_SIGN_BATCH_MAX) */
const MAX_BATCH_PATHS = 32
/** debounce ms,把同步发出的多次签名请求并到一次 RTT */
const BATCH_DEBOUNCE_MS = 50
/** 客户端缓存 TTL —— 比服务端 5min 略短,避免 URL 刚好在飞行中 expire */
const CACHE_TTL_MS = 4 * 60 * 1000
/** LRU 上限,会话里偶发产生 1000+ 媒体很正常,这里给宽裕缓冲 */
const CACHE_MAX_ENTRIES = 4096

/** 透明 1×1 PNG —— 未命中缓存时的"占位 src",避免空 src 触发 GET 当前页 */
export const TRANSPARENT_PIXEL_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

/**
 * LRU cache: path → { url, expMs, insertedAt }.
 *
 * 用 Map 顺序 = 访问顺序(get/set 时 delete+set 重新插到尾部);超过 cap 弹首部。
 * expMs ≤ now 直接当作 miss(也顺手 delete)。
 */
const _cache = new Map()

function _cacheGet(path) {
  const entry = _cache.get(path)
  if (!entry) return null
  const now = Date.now()
  if (entry.expMs <= now) {
    _cache.delete(path)
    return null
  }
  // refresh recency
  _cache.delete(path)
  _cache.set(path, entry)
  return entry.url
}

function _cacheSet(path, url, expMs) {
  if (_cache.has(path)) _cache.delete(path)
  _cache.set(path, { url, expMs, insertedAt: Date.now() })
  while (_cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = _cache.keys().next().value
    if (oldestKey === undefined) break
    _cache.delete(oldestKey)
  }
}

/**
 * 同步查缓存,命中返回 signed URL,未命中返回 null。
 *
 * markdown.js 在 `_renderLocalMedia` 里用这个:命中 → 初始 src 直接是签名 URL,
 * 无任何闪烁;未命中 → 初始 src = 1x1 PNG + `data-pending-sign-path`,等
 * MutationObserver 异步替换。
 */
export function getCachedSignedUrl(absPath) {
  if (!absPath || typeof absPath !== 'string') return null
  return _cacheGet(absPath)
}

/**
 * 主动失效一个 path 的缓存条目。
 *
 * 用于 `<img onerror>` 路径:URL 形如 `/api/media-signed?...&e=<expMs>...`,
 * 当 expMs < now 或 server 返回 410 时,失效缓存让下次签名重发。
 */
export function invalidateSignCache(absPath) {
  if (!absPath || typeof absPath !== 'string') return
  _cache.delete(absPath)
}

// ── 批处理 queue ──
// pending: Map<absPath, Array<{ resolve, reject }>>
// 同一 path 多 caller dedupe — resolve 同一份 URL,不重复打 RTT。
const _pending = new Map()
let _flushTimer = null
let _inflightCount = 0
const _MAX_INFLIGHT_BATCHES = 4 // 同时最多 4 个批次飞,避免突发"100 张图"压塌

function _scheduleFlush() {
  if (_flushTimer !== null) return
  _flushTimer = setTimeout(() => {
    _flushTimer = null
    void _flushOne()
  }, BATCH_DEBOUNCE_MS)
}

async function _flushOne() {
  if (_pending.size === 0) return
  if (_inflightCount >= _MAX_INFLIGHT_BATCHES) {
    // 已经有 in-flight 占着 → 等一拍再 flush(下一次 schedule 时再被唤起)
    _scheduleFlush()
    return
  }
  // 取出一批,至多 MAX_BATCH_PATHS
  const batch = []
  const waiters = new Map() // path → array of {resolve,reject}
  for (const [path, list] of _pending) {
    batch.push(path)
    waiters.set(path, list)
    if (batch.length >= MAX_BATCH_PATHS) break
  }
  for (const p of batch) _pending.delete(p)

  // 如果还有剩余在 _pending,排下一批
  if (_pending.size > 0) _scheduleFlush()

  _inflightCount++
  let data = null
  let httpErr = null
  try {
    const token = state.token || ''
    if (!token) {
      // 未登录时签不出来,只能 reject 全部 — markdown 已 fail-silent
      throw new Error('no-token')
    }
    const res = await fetch('/api/media-sign', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paths: batch }),
    })
    if (!res.ok) {
      httpErr = new Error(`media-sign HTTP ${res.status}`)
    } else {
      data = await res.json().catch(() => null)
    }
  } catch (e) {
    httpErr = e
  } finally {
    _inflightCount--
  }

  if (httpErr || !data || typeof data !== 'object' || !data.urls) {
    // 全员 reject(null) — markdown 端把 null 当 fail-silent,保持占位图
    for (const [, list] of waiters) {
      for (const w of list) w.resolve(null)
    }
    return
  }

  const urls = data.urls || {}
  const expMs = Number(data.expMs) || 0
  for (const [path, list] of waiters) {
    const url = typeof urls[path] === 'string' ? urls[path] : null
    if (url && expMs > Date.now()) {
      _cacheSet(path, url, expMs)
    }
    for (const w of list) w.resolve(url)
  }
}

/**
 * 异步获取一个 path 的 signed URL。
 *
 * - 缓存命中:同步返回 resolved Promise<url>(微任务 tick)
 * - 缓存未命中:加入批 queue,50ms 后合并请求,resolve 成 URL 或 null(失败)
 *
 * **永远 resolve,不 reject** — 调用方按返回值判:`url ? 替换 : 保持占位`。
 */
export function signMediaPath(absPath) {
  if (!absPath || typeof absPath !== 'string') {
    return Promise.resolve(null)
  }
  const cached = _cacheGet(absPath)
  if (cached) return Promise.resolve(cached)

  return new Promise((resolve) => {
    let list = _pending.get(absPath)
    if (!list) {
      list = []
      _pending.set(absPath, list)
    }
    list.push({ resolve })
    _scheduleFlush()
  })
}

/**
 * test helper —— 清空 LRU 缓存(测试或主动 logout 时调用)。
 */
export function _clearCacheForTest() {
  _cache.clear()
}
