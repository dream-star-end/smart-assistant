import type { AgentDef, OpenClaudeConfig } from '@openclaude/storage'

export const BROWSER_TOOLSET_ID = 'browser'
export const WEB_CONTEXT_TOOLSET_ID = 'web_context'
export const RESEARCH_TOOLSET_ID = 'research'

const BROWSER_INTENT_PATTERNS = [
  /\b(browser|navigate|screenshot)\b/i,
  /\bopen\s+(?:a\s+)?(?:web\s+)?page\b/i,
  /\bopen\s+https?:\/\//i,
  /\bclick\b/i,
  /\bfill\s+(?:out\s+)?(?:a\s+)?form\b/i,
  /\blog\s*in\b|\blogin\b/i,
  /浏览器|用浏览器|打开网页|打开页面|打开链接|打开\s*https?:\/\/|访问网页|网页截图|网页截屏|操作网页|操作页面|点击|填表|登录/,
]

const WEB_CONTEXT_INTENT_PATTERNS = [
  /https?:\/\/[^\s<>"']+/i,
  /\b(?:extract|scrape|crawl|fetch|read|parse|summari[sz]e)\s+(?:this\s+)?(?:web\s+)?(?:page|url|link|site|article|pdf|document)\b/i,
  /\b(?:web|url|link|site|article|pdf|document)\s+(?:extract|scrape|crawl|fetch|parse|reader)\b/i,
  /抓取|爬取|提取网页|读取网页|解析网页|总结网页|网页内容|网页资料|读取链接|解析链接|提取链接|抓数据|爬数据|下载资料|解析PDF|解析\s*PDF|读取\s*PDF/,
]

function normalizeToolsetList(toolsets: string[] | undefined): string[] | undefined {
  if (!Array.isArray(toolsets) || toolsets.length === 0) return undefined
  const out: string[] = []
  for (const value of toolsets) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed || out.includes(trimmed)) continue
    out.push(trimmed)
  }
  return out.length > 0 ? out : undefined
}

function stripPaperSystemHint(text: string): string {
  return text.split('【OpenClaude 论文任务系统提示】')[0].trim()
}

export function extractToolsetIntentText(text: string): string {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (!raw) return ''
  if (/^# Agent Team Run\b/.test(raw)) {
    const match = raw.match(/\n## 用户目标\n([\s\S]*)$/)
    if (match) return stripPaperSystemHint(match[1] || '')
  }
  return stripPaperSystemHint(raw)
}

export function detectBrowserToolsetIntent(text: string): boolean {
  const userText = extractToolsetIntentText(text)
  if (!userText) return false
  return BROWSER_INTENT_PATTERNS.some((pattern) => pattern.test(userText))
}

export function detectWebContextToolsetIntent(text: string): boolean {
  const userText = extractToolsetIntentText(text)
  if (!userText) return false
  return WEB_CONTEXT_INTENT_PATTERNS.some((pattern) => pattern.test(userText))
}

export function mergeOnDemandToolsets(
  baseToolsets: string[] | undefined,
  config: Pick<OpenClaudeConfig, 'toolsets'>,
  text: string,
): string[] | undefined {
  const base = normalizeToolsetList(baseToolsets)
  // Preserve legacy gateway behavior: if no default/agent toolsets are
  // configured, SubprocessRunner intentionally mounts all global MCP servers.
  if (!base) return undefined
  let next = base
  const browserIntent = detectBrowserToolsetIntent(text)
  if (browserIntent) {
    const browserIds = config.toolsets?.[BROWSER_TOOLSET_ID]
    if (Array.isArray(browserIds) && browserIds.length > 0 && !next.includes(BROWSER_TOOLSET_ID)) {
      next = [...next, BROWSER_TOOLSET_ID]
    }
  }
  if (!browserIntent && detectWebContextToolsetIntent(text)) {
    const preferred = Array.isArray(config.toolsets?.[WEB_CONTEXT_TOOLSET_ID])
      ? WEB_CONTEXT_TOOLSET_ID
      : RESEARCH_TOOLSET_ID
    const ids = config.toolsets?.[preferred]
    if (Array.isArray(ids) && ids.length > 0 && !next.includes(preferred)) {
      next = [...next, preferred]
    }
  }
  return next
}

// Normalize a leader-supplied delegate `toolsets` request: keep only non-empty,
// de-duplicated strings. Returns null if the input isn't an array at all.
export function normalizeDelegateToolsetList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || out.includes(trimmed)) continue
    out.push(trimmed)
  }
  return out
}

// Resolve the toolset list for a delegated member. Unifies the two historical
// authority sources for "what tools does a delegated member get" into ONE model,
// identical in spirit to the normal message path (`mergeOnDemandToolsets` at the
// WS entry):
//   - The member's configured toolsets are a BASELINE, not a hard cap. Post the
//     core-only seed migration (entrypoint), researcher/scientist/coder are
//     `["core"]`; browser/research are mounted on demand, never pre-mounted.
//   - Toolsets DEFINED in config.toolsets (core/browser/research) are grantable
//     on demand to any member, via (a) task intent on the goal+context, AND
//     (b) the leader's explicit `toolsets` request. BOTH are ADDITIVE and capped
//     to defined toolsets — so a delegation can never escalate to "all tools"
//     (the old #5 over-reach guard still holds) and an unknown/empty request can
//     never abort the delegation (the old empty-intersection hard-400 is gone).
//
// Returns the resolved toolset list, or undefined meaning "inherit / mount all"
// — preserved only for the legacy case where neither the member nor defaults
// configure any toolsets (SubprocessRunner then mounts all global MCP servers).
/**
 * Cap an agent's effective toolsets to its manifest declaration when it is a
 * MARKETPLACE agent (security ceiling, RFC D2): on-demand intent expansion must
 * never grant a capability the vetted manifest didn't declare. Returns `effective`
 * unchanged for platform/user agents (no source marker), which keep on-demand grow.
 */
export function capMarketplaceToolsets(
  source: string | undefined,
  manifestToolsets: readonly string[] | undefined,
  effective: string[] | undefined,
): string[] | undefined {
  if (source !== 'marketplace' || !Array.isArray(manifestToolsets)) return effective
  const cap = new Set(manifestToolsets)
  return (effective ?? manifestToolsets).filter((t) => cap.has(t))
}

export function resolveDelegateToolsets(
  targetAgent: AgentDef,
  config: Pick<OpenClaudeConfig, 'toolsets' | 'defaults'>,
  requestedRaw: unknown,
  intentText: string,
  /**
   * The CALLER (leader)'s effective toolsets. Security cap (RFC D2.7 / Codex
   * BLOCKER#2): a delegation can never grant the sub-agent a capability the
   * caller itself doesn't have — `effective(sub) ⊆ effective(caller)`. Pass
   * `undefined` when the caller declares no toolsets (the trusted platform
   * default, e.g. main / 全能助手, full access) → no cap. A marketplace agent
   * always declares a finite, vetted toolset, so it is always capped.
   */
  callerToolsets?: readonly string[],
): string[] | undefined {
  const callerCap = Array.isArray(callerToolsets) ? new Set(callerToolsets) : null
  const base = Array.isArray(targetAgent.toolsets)
    ? targetAgent.toolsets
    : Array.isArray(config.defaults?.toolsets)
      ? config.defaults.toolsets
      : undefined
  // No baseline configured → legacy "mount all" semantics, UNLESS the caller is
  // capped, in which case the sub-agent is bounded by the caller's toolsets
  // (mount-all must never bypass the cap → otherwise a capped agent could escalate
  // by delegating to a no-toolset agent).
  if (!base || base.length === 0) return callerCap ? [...callerCap] : undefined

  // (a) Intent-based on-demand grant — same call the normal message path makes,
  //     so a delegated researcher gets browser/research from the task text just
  //     like a directly-prompted one would. Symmetry: delegate path == WS path.
  //     mergeOnDemandToolsets always returns a fresh array for a non-empty base,
  //     so `resolved` is safe to extend in place below.
  const resolved = mergeOnDemandToolsets(base, config, intentText) ?? [...base]

  // (b) Explicit leader request — additive grant, but ONLY for toolsets that are
  //     actually DEFINED in config.toolsets. Unknown names are ignored (never
  //     fatal); defined-but-absent names are appended. This demotes the leader's
  //     `toolsets` from a hard-failing intersection to a grant hint consistent
  //     with intent-merge.
  const requested = normalizeDelegateToolsetList(requestedRaw)
  if (requested && requested.length > 0 && config.toolsets) {
    for (const toolset of requested) {
      if (
        Object.prototype.hasOwnProperty.call(config.toolsets, toolset) &&
        !resolved.includes(toolset)
      ) {
        resolved.push(toolset)
      }
    }
  }

  // (c) Caller cap — the hard security ceiling. Intersect the resolved grant with
  //     the caller's effective toolsets so the sub-agent can never exceed the
  //     caller's own authority. No-op when the caller is uncapped (platform default).
  if (callerCap) return resolved.filter((t) => callerCap.has(t))
  return resolved
}
