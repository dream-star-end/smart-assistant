import type { OpenClaudeConfig } from '@openclaude/storage'

export const BROWSER_TOOLSET_ID = 'browser'

const BROWSER_INTENT_PATTERNS = [
  /\b(browser|navigate|screenshot)\b/i,
  /\bopen\s+(?:a\s+)?(?:web\s+)?page\b/i,
  /\bopen\s+https?:\/\//i,
  /\bclick\b/i,
  /\bfill\s+(?:out\s+)?(?:a\s+)?form\b/i,
  /\blog\s*in\b|\blogin\b/i,
  /浏览器|用浏览器|打开网页|打开页面|打开链接|打开\s*https?:\/\/|访问网页|网页截图|网页截屏|操作网页|操作页面|点击|填表|登录/,
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

export function mergeOnDemandToolsets(
  baseToolsets: string[] | undefined,
  config: Pick<OpenClaudeConfig, 'toolsets'>,
  text: string,
): string[] | undefined {
  const base = normalizeToolsetList(baseToolsets)
  // Preserve legacy gateway behavior: if no default/agent toolsets are
  // configured, SubprocessRunner intentionally mounts all global MCP servers.
  if (!base) return undefined
  if (!detectBrowserToolsetIntent(text)) return base
  const browserIds = config.toolsets?.[BROWSER_TOOLSET_ID]
  if (!Array.isArray(browserIds) || browserIds.length === 0) return base
  if (base.includes(BROWSER_TOOLSET_ID)) return base
  return [...base, BROWSER_TOOLSET_ID]
}
