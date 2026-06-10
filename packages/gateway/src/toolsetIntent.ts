import type { OpenClaudeConfig } from '@openclaude/storage'

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

export function detectBrowserToolsetIntent(text: string): boolean {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (!raw) return false
  const userText = raw.split('【OpenClaude 论文任务系统提示】')[0].trim()
  if (!userText) return false
  return BROWSER_INTENT_PATTERNS.some((pattern) => pattern.test(userText))
}

export function detectWebContextToolsetIntent(text: string): boolean {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (!raw) return false
  const userText = raw.split('【OpenClaude 论文任务系统提示】')[0].trim()
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
