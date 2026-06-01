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
// **2026-05-18 v1.0.159 架构修复**(d1193355375 华为浏览器 case):服务端
// `handleMediaSign` 现 cookie-first + Bearer 兜底 + dual verify。前端**双带**:
//   - `credentials: 'same-origin'` —— 浏览器自动带 HttpOnly `oc_session` cookie
//     (权威源,生命周期跟 access JWT 绑死,通过 mintSessionCookie 自动续)
//   - `Authorization: Bearer ${state.token}`(if state.token 非空)—— 兜底通道,
//     给"cookie 还没 mint 到位 / 浏览器丢 cookie"窄窗口
//
// 任一通过即放行。这消除了之前 "state.token 在内存里漂移导致 75min Bearer 全
// stale" 的 split-brain(`/api/file` 是 cookie 直链,本来就免疫;现在 media-sign
// 也跟过来,走同一份浏览器权威 auth state)。
//
// **不再做** silentRefresh 兜底 / 401 retry —— cookie 是浏览器原生,JS 救不了
// 它失效;cookie 真过期了说明 access JWT 也过期,其他高频 API(WS / refreshBalance /
// syncSessionsFromServer)会先触发全局 silentRefresh,cookie 跟着更新。
// media-sign 自己 retry 救不了"全局都没 refresh"的 case,fail-silent + toast
// 提示用户重试即可。
//
// 单 path → URL 的 dedupe 在 pending queue 里做:同一 path 在被 flush 之前的
// 50ms 窗口内不会发两次请求。已 flush 进 inflight 的 batch 不再合并新 caller,
// 后者会另起下一批 —— 这是 batching 的边界,不是 bug。
//
// `signMediaPath(absPath, opts)` 的 `opts.interactive` 参数**保留但 inert**:
// 历史上(v1.0.156)用来区分背景预签 vs 用户点击,以便后者触发 silentRefresh
// 兜底。v1.0.159 改双带 cookie 后两路逻辑一致,但接口签名保留以避免 call-site
// (main.js doc-card / markdown 渲染)同步改动。下个版本可清理。
//
// **2026-05-18 v1.0.158 step diag**(保留):每个 batch 生成 `diagId`,以
// `x-oc-diag-id` header 传到服务端,服务端 `media_sign_auth_fail` log 用同一 ID
// join。本地写 `_lastFlushDiag` LRU(瘦身字段:`diag_id` / `outcome` /
// `http_status` / `failure_path`),main.js doc-card click handler 通过
// `getLastFlushDiagForPath(absPath)` 取快照,连同 device 字段打 `trace('media_sign_fail')`。
//
// **不变量**:diag 快照必须在 `resolve(null)` / `resolve(url)` 调用**之前**
// 同步落 `_lastFlushDiag`。这样 click handler 紧跟 await 恢复就能读到这一批
// 自己的快照,不会赌 race。

import { state } from './state.js?v=6266b107'
import { silentRefresh } from './api.js?v=6266b107'

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
// pending: Map<absPath, Array<{ resolve, interactive }>>
// 同一 path 多 caller dedupe — resolve 同一份 URL,不重复打 RTT。
// `interactive` 标志记每个 waiter 的来源,批次内 OR(只要 1 个 interactive 就升级
// 该批为"值得 refresh"路径)。注意 dedupe 仅在同一 pending 窗口(本次 flush 前)
// 内成立 —— 跨已 flush 的 inflight 不合并,会另起下一批。
const _pending = new Map()
let _flushTimer = null
let _inflightCount = 0
const _MAX_INFLIGHT_BATCHES = 4 // 同时最多 4 个批次飞,避免突发"100 张图"压塌

// ── 诊断快照 (v1.0.158 step diag, v1.0.159 字段瘦身) ──
// _lastFlushDiag: Map<absPath, DiagSnapshot> — 一个 batch 完成时把该 batch 的
// 步骤快照 link 到所有 paths(同一引用),按 LRU 保留最近 _MAX_DIAG_HISTORY 个
// path 的快照。供 main.js doc-card click 失败分支查询。
//
// **不存 token / claims / 任何 PII** —— 只存 outcome / http_status / failure_path。
// path 本身不入快照(已经是 key)。
//
// **容量 = 2 × MAX_BATCH_PATHS(32)= 64**:单批 32 path 写入后立刻 prune 到 16
// 会自驱逐本批前半 path 的快照,click handler 读到 no_snapshot。容量必须 ≥ batch
// 上限,加倍兜下"用户点击发生在下一批 flush 完之后"的窄窗。
//
// **v1.0.159 字段变更**:cookie-first 架构落地后,initial_token_present /
// preflight_refresh_* / retry_* 等字段语义消失(没有 silentRefresh / retry 路径
// 了),删掉。保留 diag_id / outcome / http_status / failure_path 四元组,与
// 服务端 media_sign_auth_fail 日志通过 diag_id join 仍有效。
const _MAX_DIAG_HISTORY = 64
const _lastFlushDiag = new Map()

function _newDiagId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {}
  // 老 Chromium 内核(华为浏览器 / 小程序 webview 等)可能没有 randomUUID。
  // 不写"伪 UUID"形态,显式 `f-` 前缀让日志一眼看出这是 fallback,避免诊断时
  // 误以为是真 UUID。
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function _saveDiagForBatch(batch, snapshot) {
  for (const path of batch) {
    if (_lastFlushDiag.has(path)) _lastFlushDiag.delete(path)
    _lastFlushDiag.set(path, snapshot)
  }
  while (_lastFlushDiag.size > _MAX_DIAG_HISTORY) {
    const oldestKey = _lastFlushDiag.keys().next().value
    if (oldestKey === undefined) break
    _lastFlushDiag.delete(oldestKey)
  }
}

/**
 * 取这个 path 最近一次 batch flush 的诊断快照(可能为 null 如果 path 没经过
 * flush,或被 LRU 挤掉)。main.js doc-card click 失败分支用此 join trace 上报。
 *
 * 快照字段(v1.0.159 瘦身后,全部 nullable):
 *   - diag_id      `x-oc-diag-id` 同一 ID,与服务端 media_sign_auth_fail log join
 *   - outcome      'ok' | 'http' | 'network_err'
 *   - http_status  HTTP status code(network_err 时 null)
 *   - failure_path 'http_401' | 'http_other' | 'network' | 'bad_json'
 *                  | 'missing_urls' | null(成功)
 */
export function getLastFlushDiagForPath(absPath) {
  if (!absPath || typeof absPath !== 'string') return null
  return _lastFlushDiag.get(absPath) ?? null
}

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
  const waiters = new Map() // path → array of {resolve, interactive}
  for (const [path, list] of _pending) {
    batch.push(path)
    waiters.set(path, list)
    if (batch.length >= MAX_BATCH_PATHS) break
  }
  for (const p of batch) _pending.delete(p)

  // 如果还有剩余在 _pending,排下一批
  if (_pending.size > 0) _scheduleFlush()

  _inflightCount++
  // v1.0.158 step diag(v1.0.159 字段瘦身) —— 整批共享一份快照(同一引用),
  // flush 完成时按 LRU 落到 _lastFlushDiag。失败时填 failure_path,成功留 null。
  const diagId = _newDiagId()
  const diag = {
    diag_id: diagId,
    outcome: null, // 'ok' | 'http' | 'network_err'
    http_status: null,
    failure_path: null,
  }
  let data = null
  let httpErr = null
  try {
    // v1.0.159 双带:cookie(`credentials: 'same-origin'` 自动带 oc_session)+
    // Bearer(if state.token 非空,兜底通道,给"cookie 还没 mint 到位 / 浏览器
    // 丢 cookie"窄窗)。任一过即服务端 200。state.token 即使是 stale,服务端
    // cookie-first 策略会先验 cookie,Bearer 只在 cookie 不通过时兜底。
    const headers = {
      'Content-Type': 'application/json',
      'x-oc-diag-id': diagId,
    }
    const token = state.token || ''
    if (token) headers.Authorization = `Bearer ${token}`
    let res
    try {
      res = await fetch('/api/media-sign', {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: JSON.stringify({ paths: batch }),
      })
      diag.http_status = res.status
      diag.outcome = res.ok ? 'ok' : 'http'
    } catch (e) {
      diag.outcome = 'network_err'
      diag.failure_path = 'network'
      throw e
    }
    if (!res.ok) {
      diag.failure_path = res.status === 401 ? 'http_401' : 'http_other'
      httpErr = new Error(`media-sign HTTP ${res.status}`)
    } else {
      data = await res.json().catch(() => null)
      if (!data || typeof data !== 'object') {
        diag.failure_path = 'bad_json'
      } else if (!data.urls) {
        diag.failure_path = 'missing_urls'
      }
    }
  } catch (e) {
    httpErr = e
    if (!diag.failure_path) diag.failure_path = 'network' // 兜底未分类
  } finally {
    _inflightCount--
  }

  // **不变量(Codex SHOULD)**:diag 必须在 resolve waiters 之前同步落到
  // _lastFlushDiag,这样 click handler `await signMediaPath()` 恢复时按事件
  // 循环顺序保证读到这一批自己的快照。
  _saveDiagForBatch(batch, diag)

  if (httpErr || !data || typeof data !== 'object' || !data.urls) {
    // 全员 resolve(null) — markdown 端把 null 当 fail-silent,保持占位图;
    // interactive caller(main.js doc-card click handler)拿到 null 弹 toast 提示重试
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
 *
 * @param {string} absPath  容器内绝对路径(e.g. `/home/agent/.openclaude/...`)
 * @param {{ interactive?: boolean }} [opts]
 *   `interactive` 参数 **v1.0.159 起 inert**(签名保留,call-site 不动)。
 *   历史上(v1.0.156)区分背景预签 vs 用户点击,后者会触发 silentRefresh 兜底。
 *   v1.0.159 改"cookie 优先 + Bearer 兜底"双带方案后,服务端能直接靠浏览器
 *   权威 cookie 验签,前端不再需要 refresh 兜底,两路逻辑一致。下个版本清理。
 */
export function signMediaPath(absPath, opts) {
  if (!absPath || typeof absPath !== 'string') {
    return Promise.resolve(null)
  }
  const cached = _cacheGet(absPath)
  if (cached) return Promise.resolve(cached)

  // interactive 仍读但不再分叉走 silentRefresh 路径。waiter 上仍记 flag,留给
  // 未来 diag/observability 用(成本 0)。
  const interactive = opts?.interactive === true
  return new Promise((resolve) => {
    let list = _pending.get(absPath)
    if (!list) {
      list = []
      _pending.set(absPath, list)
    }
    list.push({ resolve, interactive })
    _scheduleFlush()
  })
}

/**
 * test helper —— 清空 LRU 缓存(测试或主动 logout 时调用)。
 */
export function _clearCacheForTest() {
  _cache.clear()
}
