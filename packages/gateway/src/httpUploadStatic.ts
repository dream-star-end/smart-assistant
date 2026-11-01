/**
 * Gateway HTTP upload limits, MIME lookup, static cache-control and access-log filter
 *
 * Moved verbatim out of server.ts (FINDINGS §7.6, OCV5-533); server.ts re-exports
 * these names, so importers are unchanged.
 */
import { realpathSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { MIME_MAP } from './gatewayFilePolicy.js'

// ── Upload constants — single source of truth ──
// 2026-05-18:从 200MB → 100MB。前端 attachments.js 同步;Cloudflare Free/Pro
// request body cap = 100MB,后端写 200MB 是个永远摸不到的虚上限。前后端对齐到
// CF 现实让 413 在前端直接拦,而不是被 CF 边缘 HTML 错误页吞掉。
// Numbers live in @openclaude/protocol so the composer and this process share one cap.
export {
  MAX_INLINE_TEXT_BYTES,
  MAX_UPLOAD_SINGLE_BYTES as MAX_UPLOAD_SINGLE,
  MAX_UPLOAD_TOTAL_BYTES as MAX_UPLOAD_TOTAL,
} from '@openclaude/protocol'

export const SAFE_UPLOAD_EXTENSION_RE = /^[a-z0-9]{1,32}$/

export function mimeFor(p: string): string {
  return MIME_MAP[extname(p).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 静态 web UI 资产的 Cache-Control —— 缓存规则的单一权威(见 GatewayDeps.staticMode)。
 * `safePath` 已把 `/` 归一为 `/index.html`。抽为纯函数便于单测锁定、避免规则在测试里被
 * 重新实现而漂移。
 *   - 'spa'(v5 Aurora,bundler dist): 内容哈希资产 `/assets/*` → immutable 1 年;
 *     其余(含 index.html / public 透传文件)→ no-cache,借 ETag 廉价重校验。
 *   - 'vanilla'(默认,v3/personal,web/public): 沿用 ?v=hash cache-bust →
 *     普通资产 1 小时;sw.js 永不被边缘缓存(CF 默认 4h TTL 会把用户钉在陈旧 SW 上)。
 */
export function staticCacheControl(safePath: string, mode: 'vanilla' | 'spa' | undefined): string {
  if (mode === 'spa') {
    return safePath.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache'
  }
  return safePath === '/sw.js' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600'
}

/**
 * 静态请求在磁盘上的候选文件(按顺序试),或 null = 必须 404(OCV5-632,X-P1-1 PR-a)。
 *   - webRoot 永远第一个:当前版本的文件是权威,命中路径与旧逻辑逐字一致(含原有的前缀包含判断)。
 *   - 'spa' 且配了资产池(`<pool>/assets/…`,与商业 union 池同布局)时,`/assets/*` 再查池:发版后
 *     仍开着的旧标签页懒加载上一版的哈希 chunk 不再 404。池只出 `/assets/` 下的文件:字符串包含之外
 *     还按真实路径(跟随符号链接后)再判一次,池里的符号链接带不出池外文件。
 *   - 'spa' 下任何 `.map` 一律 null:源码映射不出站(商业版在 Caddy 拦,个人版 master 直服,这里补上)。
 *     先把路径归一(去 `..`、尾斜杠)再判,`/assets/x.js.map/` 这类写法绕不过去;map 仍留在 release
 *     目录,本机排障照读。
 *   - 'vanilla'(v3)不认池、不拦 .map,行为不变。
 */
export function staticFileCandidates(
  safePath: string,
  opts: { webRoot: string; staticMode?: 'vanilla' | 'spa'; assetsPool?: string },
): string[] | null {
  const spa = opts.staticMode === 'spa'
  const normalized = resolve('/', `.${safePath}`)
  if (spa && normalized.toLowerCase().endsWith('.map')) return null
  const out: string[] = []
  const root = resolve(opts.webRoot)
  const primary = resolve(root, `.${safePath}`)
  if (primary.startsWith(root)) out.push(primary)
  if (spa && opts.assetsPool && normalized.startsWith('/assets/')) {
    const poolAssets = resolve(opts.assetsPool, 'assets')
    const pooled = resolve(opts.assetsPool, `.${normalized}`)
    if (pooled.startsWith(poolAssets + sep) && withinRealDir(pooled, poolAssets)) out.push(pooled)
  }
  return out
}

/** 跟随符号链接后 file 仍落在 dir 内;任一方不存在/读不到 → false(池回落按未命中处理)。 */
function withinRealDir(file: string, dir: string): boolean {
  try {
    return realpathSync(file).startsWith(realpathSync(dir) + sep)
  } catch {
    return false
  }
}

/**
 * Access-log filter for the gateway HTTP server. Static assets are never logged.
 * Probe paths (/healthz, /metrics) are hit every few seconds by the watch timer
 * and monitors: a healthy probe is not logged (it was ~16% of the selfhost
 * master log on 2026-10-16, OCV5-461); a failing or slow one still is. The
 * request metrics count every request regardless.
 */
export function shouldLogHttpAccess(path: string, status: number, durationMs: number): boolean {
  if (path === '/healthz' || path === '/metrics') return status !== 200 || durationMs >= 1000
  return path.startsWith('/api/') || path.startsWith('/v1/')
}
