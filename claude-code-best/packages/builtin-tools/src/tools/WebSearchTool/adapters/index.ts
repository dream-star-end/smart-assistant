/**
 * Search adapter factory — selects the appropriate backend.
 *
 * Priority (highest first):
 *   1. WEB_SEARCH_ADAPTER environment variable (explicit override)
 *   2. settings.webSearchAdapter (user-configurable via /web-tools)
 *   3. MiniMax auto-detect — commercial container wiring present  [v5 定制]
 *   4. Default: bing                                              [v5 定制]
 *
 * ── v5 定制说明(见 claude-code-best/UPSTREAM.md §2 第 3 组)──────────────
 * 上游此处优先级只有 1/2 两级,默认 tavily。我们叠加两点:
 *
 *   ③ MiniMax 自动探测:商业容器里没人会去设 env 或 /web-tools,靠
 *     `minimaxSearchConfigured()` 探测 master search-proxy 接线自动启用 —— 这是
 *     v5 生产的实际路径,不能丢。MiniMax key 只在 master,容器侧永不持有。
 *
 *   ④ 兜底改回 bing:上游默认 tavily 需要 API key,无 key 环境(个人版 / dev /
 *     CI)会硬失败;bing 是无 key 的 HTML scraper,degrade 而非 break。上游新增的
 *     brave / exa / tavily 仍可通过 env 或 settings 显式选用,能力不减。
 * ──────────────────────────────────────────────────────────────────────
 */

import { getSettings_DEPRECATED } from 'src/utils/settings/settings.js'
import { ApiSearchAdapter } from './apiAdapter.js'
import { BingSearchAdapter } from './bingAdapter.js'
import { BraveSearchAdapter } from './braveAdapter.js'
import { ExaSearchAdapter } from './exaAdapter.js'
import { MiniMaxSearchAdapter, minimaxSearchConfigured } from './minimaxAdapter.js'
import { TavilySearchAdapter } from './tavilyAdapter.js'
import type { WebSearchAdapter } from './types.js'

export type {
  SearchResult,
  SearchOptions,
  SearchProgress,
  WebSearchAdapter,
} from './types.js'

export type SearchAdapterKey = 'api' | 'bing' | 'brave' | 'exa' | 'minimax' | 'tavily'

const ADAPTER_KEYS: readonly SearchAdapterKey[] = [
  'api',
  'bing',
  'brave',
  'exa',
  'minimax',
  'tavily',
]

function asAdapterKey(value: unknown): SearchAdapterKey | null {
  return ADAPTER_KEYS.includes(value as SearchAdapterKey) ? (value as SearchAdapterKey) : null
}

let cachedAdapter: WebSearchAdapter | null = null
let cachedAdapterKey: SearchAdapterKey | null = null

export function createAdapter(): WebSearchAdapter {
  // 1. Explicit env override
  // 2. Settings preference (set via /web-tools panel)
  // 3. MiniMax when the commercial container wiring is present  [v5 定制]
  // 4. Default: bing (no API key required)                      [v5 定制]
  const adapterKey: SearchAdapterKey =
    asAdapterKey(process.env.WEB_SEARCH_ADAPTER) ??
    asAdapterKey(getSettings_DEPRECATED().webSearchAdapter) ??
    (minimaxSearchConfigured() ? 'minimax' : 'bing')

  if (cachedAdapter && cachedAdapterKey === adapterKey) return cachedAdapter

  switch (adapterKey) {
    case 'api':
      cachedAdapter = new ApiSearchAdapter()
      break
    case 'brave':
      cachedAdapter = new BraveSearchAdapter()
      break
    case 'exa':
      cachedAdapter = new ExaSearchAdapter()
      break
    case 'minimax':
      // Degrades to the Bing scraper internally on any non-abort failure.
      cachedAdapter = new MiniMaxSearchAdapter()
      break
    case 'tavily':
      cachedAdapter = new TavilySearchAdapter()
      break
    case 'bing':
    default:
      cachedAdapter = new BingSearchAdapter()
      break
  }

  cachedAdapterKey = adapterKey
  return cachedAdapter
}
