/**
 * "活跃内容" MIME 判定 —— 单一权威(批D D5)。
 *
 * 「活跃内容」= 浏览器 inline 渲染时可执行脚本、因而必须强制下载
 * (Content-Disposition: attachment)、绝不 inline 的 MIME(html/svg/xml/js 等)。
 *
 * 此前该集合在**三处并行定义**,任一处漏改都会让某类活跃内容在某条链路被 inline
 * 渲染(存储型 XSS 面):
 *   - gateway `server.ts`:ACTIVE_CONTENT_TYPES 集合 + shouldServeInline;
 *   - commercial `containerFileProxy.ts`:ACTIVE_TYPES 集合 + isSafeInlineType 里的
 *     `image/svg+xml` 特判。
 * 收敛到本模块后,两侧对"活跃内容"的判定由同一常量驱动,不可能再漂移;两侧对 PDF 等
 * 非活跃类型的 inline 差异是各自链路的既有设计(契约测试只锁"活跃内容两侧一致")。
 *
 * 依赖方向:gateway 与 commercial 都依赖 @openclaude/protocol,protocol 不反向依赖任一者
 * → 放这里是唯一无环的单一权威落点。
 */

/** 浏览器可执行脚本、必须强制 attachment、绝不 inline 的 MIME 基类型集合。 */
export const ACTIVE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'text/html',
  'image/svg+xml',
  'text/xml',
  'application/xml',
  'application/xhtml+xml',
  // JavaScript 同样浏览器可执行,绝不 inline
  'application/javascript',
  'text/javascript',
])

/**
 * base MIME(剥离 charset 后)是否为活跃内容。
 * 剥 charset 后再匹配(如 "text/html; charset=utf-8" → "text/html")。
 */
export function isActiveContentType(mime: string): boolean {
  const base = mime.split(';')[0].trim().toLowerCase()
  return ACTIVE_CONTENT_TYPES.has(base)
}

/**
 * gateway 静态/文件服务的 inline 判定(单一权威):仅 <img>/<audio>/<video> 可 inline,
 * 活跃内容一律 attachment。
 *
 * **有意差异**:本函数不把 PDF 判为 inline(gateway 侧 PDF 走 attachment),而 commercial
 * 容器代理的 isSafeInlineType 会 inline PDF —— 这是两条链路各自的既有设计。契约测试只断言
 * 两侧对**活跃内容**的判定逐字一致(都 attachment),不要求非活跃类型一致。
 */
export function shouldServeInline(mime: string): boolean {
  const base = mime.split(';')[0].trim().toLowerCase()
  if (ACTIVE_CONTENT_TYPES.has(base)) return false
  return base.startsWith('image/') || base.startsWith('audio/') || base.startsWith('video/')
}
