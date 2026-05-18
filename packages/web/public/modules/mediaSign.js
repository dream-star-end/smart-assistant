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
// 单 path → URL 的 dedupe 在 pending queue 里做:同一 path 在被 flush 之前的
// 50ms 窗口内不会发两次请求。已 flush 进 inflight 的 batch 不再合并新 caller,
// 后者会另起下一批 —— 这是 batching 的边界,不是 bug。
//
// 2026-05-17 interactive 双入口:背景预签(默认 interactive=false)沿用 fail-silent;
// 用户点击下载等主动操作传 `{ interactive: true }`,token 缺 / 401 时主动一次
// `silentRefresh()` 兜底,刷新失败再 fail-silent。批次内只要有一个 interactive
// waiter,refresh 路径就启用(同 path 的 non-interactive waiter 搭车成功 —— 良性)。
// 预签**单独**运行时零回归。
//
// 2026-05-18 v1.0.158 step diag(配合服务端 media_sign_auth_fail + 前端
// `/api/web-trace` 上报 device 指纹):每个 batch 生成一个 `diagId`,首次 +
// retry fetch 都以 `x-oc-diag-id` header 传到服务端,服务端 auth-fail log 记录
// 同一 ID。同时 _flushOne 把这一批的步骤状态(initial_token_present /
// preflight_refresh_* / first_media_sign_* / retry_refresh_* /
// retry_media_sign_* / failure_path)写到 `_lastFlushDiag` LRU,key 按 absPath;
// main.js doc-card click handler 失败时通过 `getLastFlushDiagForPath(absPath)`
// 取走快照、连同 device 字段一起打 `trace('media_sign_fail')`。
//
// **不变量**:diag 快照必须在 `resolve(null)` / `resolve(url)` 调用**之前**
// 同步落 `_lastFlushDiag`。这样 click handler 紧跟 await 恢复就能读到这一批
// 自己的快照,不会赌 race。

import { state } from './state.js'
import { silentRefresh } from './api.js?v=cfaa0e5d'

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

// ── 诊断快照 (v1.0.158 step diag) ──
// _lastFlushDiag: Map<absPath, DiagSnapshot> — 一个 batch 完成时把该 batch 的
// 步骤快照 link 到所有 paths(同一引用),按 LRU 保留最近 _MAX_DIAG_HISTORY 个
// path 的快照。供 main.js doc-card click 失败分支查询。
//
// **不存 token / claims / 任何 PII** —— 只存 outcome / http_status / boolean。
// path 本身不入快照(已经是 key)。
//
// **容量 = 2 × MAX_BATCH_PATHS(32)= 64**:Codex round-2 BLOCKING 指出单批 32
// path 写入后立刻 prune 到 16 会自驱逐本批前半 path 的快照,click handler 读到
// no_snapshot。容量必须 ≥ batch 上限,加倍兜下"用户点击发生在下一批 flush 完
// 之后"的窄窗。
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
 * 快照字段(全部 nullable):
 *   - diag_id              `x-oc-diag-id` 同一 ID,与服务端 auth-fail log join
 *   - initial_token_present  flush 起始时 state.token 是否非空
 *   - preflight_refresh_attempted / preflight_refresh_ok
 *                           interactive 且 initial token 缺时是否调 silentRefresh + 结果
 *   - first_media_sign_outcome 'ok' | 'http' | 'network_err' | 'no_token_skip'
 *   - first_media_sign_http_status  status code(network_err / no_token_skip 时 null)
 *   - retry_refresh_attempted / retry_refresh_ok
 *                           首次 401 + interactive 时是否再调 silentRefresh + 结果
 *   - retry_media_sign_outcome  同上,'skipped' 表示没进 retry 路径
 *   - retry_media_sign_http_status  status code 或 null
 *   - failure_path           'no_token' | 'http_401' | 'http_other' | 'network'
 *                            | 'bad_json' | 'missing_urls' | null(成功)
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
  let batchInteractive = false
  for (const [path, list] of _pending) {
    batch.push(path)
    waiters.set(path, list)
    for (const w of list) {
      if (w.interactive) {
        batchInteractive = true
        break
      }
    }
    if (batch.length >= MAX_BATCH_PATHS) break
  }
  for (const p of batch) _pending.delete(p)

  // 如果还有剩余在 _pending,排下一批
  if (_pending.size > 0) _scheduleFlush()

  _inflightCount++
  // v1.0.158 step diag —— 整批共享一份快照(同一引用),flush 完成时按 LRU 落到
  // _lastFlushDiag。所有字段默认 null/false,执行到对应分支再填,这样 jq/grep
  // 时缺失字段语义清晰。
  const diagId = _newDiagId()
  const diag = {
    diag_id: diagId,
    initial_token_present: false,
    preflight_refresh_attempted: false,
    preflight_refresh_ok: null,
    first_media_sign_outcome: null,
    first_media_sign_http_status: null,
    retry_refresh_attempted: false,
    retry_refresh_ok: null,
    retry_media_sign_outcome: 'skipped',
    retry_media_sign_http_status: null,
    failure_path: null,
  }
  let data = null
  let httpErr = null
  try {
    let token = state.token || ''
    diag.initial_token_present = !!token
    // interactive 路径:token 缺 → 主动一次 silentRefresh 兜底。background 路径
    // 保持原行为(token 缺直接 fail-silent,会话过期由其他 API 触发)。
    if (!token && batchInteractive) {
      diag.preflight_refresh_attempted = true
      try {
        const ok = await silentRefresh()
        diag.preflight_refresh_ok = !!ok
        if (ok) token = state.token || ''
      } catch {
        diag.preflight_refresh_ok = false
      }
    }
    if (!token) {
      // 仍无 token — 真未登录或 refresh 失败,fail-silent
      diag.first_media_sign_outcome = 'no_token_skip'
      diag.failure_path = 'no_token'
      throw new Error('no-token')
    }
    let res
    try {
      res = await fetch('/api/media-sign', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'x-oc-diag-id': diagId,
        },
        body: JSON.stringify({ paths: batch }),
      })
      diag.first_media_sign_http_status = res.status
      diag.first_media_sign_outcome = res.ok ? 'ok' : 'http'
    } catch (e) {
      diag.first_media_sign_outcome = 'network_err'
      diag.failure_path = 'network'
      throw e
    }
    // interactive 路径:401 → silentRefresh + 重试一次。仍 401 / 失败 → fail-silent。
    // 网络异常不重试(refresh 救不了链路;用户重点一下行为一致)。
    if (res.status === 401 && batchInteractive) {
      diag.retry_refresh_attempted = true
      let refreshOk = false
      try {
        refreshOk = !!(await silentRefresh())
        diag.retry_refresh_ok = refreshOk
      } catch {
        diag.retry_refresh_ok = false
      }
      if (refreshOk) {
        const newToken = state.token || ''
        if (newToken) {
          // 2026-05-17 诊断埋点(v1.0.158):retry-after-refresh 的标记 header。
          // 服务端 handleMediaSign 在 verify 失败时把这个 flag 跟 token claims
          // 一起写到结构化日志,用来区分 "首次 401" vs "interactive retry 后
          // 仍 401" 两条路径 —— 后者是当前 d1193355375 case 的根因待诊断点。
          // diag_id 跟首次保持一致,服务端 join 用。
          try {
            res = await fetch('/api/media-sign', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${newToken}`,
                'Content-Type': 'application/json',
                'x-oc-debug-retry': '1',
                'x-oc-diag-id': diagId,
              },
              body: JSON.stringify({ paths: batch }),
            })
            diag.retry_media_sign_http_status = res.status
            diag.retry_media_sign_outcome = res.ok ? 'ok' : 'http'
          } catch (e) {
            diag.retry_media_sign_outcome = 'network_err'
            // failure_path 在外层 if (!res.ok) 之后再覆盖会丢这条;直接定 'network'
            diag.failure_path = 'network'
            throw e
          }
        }
        // refreshOk 但 newToken 仍空 —— state.token 没及时 commit;retry 跳过,
        // outcome 维持 'skipped',res 继续是首次 401 的那个,下面走 http_401 分支。
      }
    }
    if (!res.ok) {
      // 优先沿用 retry 设的 failure_path('network');否则按 status 归类
      if (!diag.failure_path) {
        diag.failure_path = res.status === 401 ? 'http_401' : 'http_other'
      }
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
 *   - `interactive=false`(默认):背景预签,token 缺 / 401 → fail-silent
 *   - `interactive=true`:用户主动操作(如 doc-card click),token 缺 / 401 时
 *     主动一次 `silentRefresh()` 兜底再重试;批次内只要有 1 个 interactive
 *     waiter,refresh 路径就启用(同 path 的 non-interactive waiter 搭车成功)。
 */
export function signMediaPath(absPath, opts) {
  if (!absPath || typeof absPath !== 'string') {
    return Promise.resolve(null)
  }
  const cached = _cacheGet(absPath)
  if (cached) return Promise.resolve(cached)

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
