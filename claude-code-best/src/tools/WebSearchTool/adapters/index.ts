/**
 * Search adapter factory for the built-in WebSearch tool.
 *
 * Priority:
 *   1. WEB_SEARCH_ADAPTER=minimax|bing|api — explicit override.
 *   2. MiniMax (commercial container) when its master search-proxy wiring is
 *      present — Chinese-strong; the adapter itself falls back to Bing on error.
 *   3. Bing HTML scraper — default fallback (personal/dev, no MiniMax wiring).
 */

import { ApiSearchAdapter } from './apiAdapter.js'
import { BingSearchAdapter } from './bingAdapter.js'
import { MiniMaxSearchAdapter, minimaxSearchConfigured } from './minimaxAdapter.js'
import type { WebSearchAdapter } from './types.js'

export type { SearchResult, SearchOptions, SearchProgress, WebSearchAdapter } from './types.js'

let cachedAdapter: WebSearchAdapter | null = null

export function createAdapter(): WebSearchAdapter {
  // Adapter is stateless — safe to reuse across calls within a session.
  if (cachedAdapter) return cachedAdapter

  const envAdapter = process.env.WEB_SEARCH_ADAPTER
  if (envAdapter === 'bing') {
    cachedAdapter = new BingSearchAdapter()
  } else if (envAdapter === 'api') {
    cachedAdapter = new ApiSearchAdapter()
  } else if (envAdapter === 'minimax' || minimaxSearchConfigured()) {
    // MiniMax is the default in commercial containers (wiring present); it
    // degrades to Bing internally on any non-abort failure.
    cachedAdapter = new MiniMaxSearchAdapter()
  } else {
    cachedAdapter = new BingSearchAdapter()
  }
  return cachedAdapter
}
