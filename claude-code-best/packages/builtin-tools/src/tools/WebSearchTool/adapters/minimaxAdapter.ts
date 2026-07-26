/**
 * MiniMax-backed search adapter — the built-in WebSearch tool's primary backend
 * in the commercial container.
 *
 * Why this exists: WebSearch is a highest-priority built-in tool; the agent
 * reaches for it before any Bash skill. The previous Bing-HTML-scraping backend
 * returned brand/official pages for Chinese queries and no deep UGC (and Bing's
 * Search API was retired 2025-08-11). MiniMax Token Plan's /v1/coding_plan/search
 * returns real deep Chinese content (CSDN / 头条 / 知乎-level).
 *
 * Key safety: the MiniMax Token Plan key stays MASTER-side. This adapter POSTs to
 * the master internal proxy (`OPENCLAUDE_V3_MASTER_BASE_URL/internal/v3/minimax-search`)
 * with the container identity token — the same channel/auth CCB already uses for
 * model calls — and master injects the key. The raw key never enters the container.
 *
 * Resilience: on any non-abort failure it falls back to the original Bing scraper,
 * so a MiniMax outage degrades rather than breaking WebSearch entirely.
 */

import axios from 'axios'
import { AbortError } from 'src/utils/errors.js'
import { BingSearchAdapter } from './bingAdapter.js'
import type { SearchOptions, SearchResult, WebSearchAdapter } from './types.js'

const FETCH_TIMEOUT_MS = 30_000
const MINIMAX_SEARCH_PATH = '/internal/v3/minimax-search'

/** True only when the commercial container wiring for the master search proxy is present. */
export function minimaxSearchConfigured(): boolean {
  return Boolean(
    process.env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim() &&
      process.env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim(),
  )
}

function filterByDomain(
  results: SearchResult[],
  allowedDomains?: string[],
  blockedDomains?: string[],
): SearchResult[] {
  return results.filter((r) => {
    if (!r.url) return false
    try {
      const hostname = new URL(r.url).hostname
      if (
        allowedDomains?.length &&
        !allowedDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`))
      ) {
        return false
      }
      if (blockedDomains?.length && blockedDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
        return false
      }
    } catch {
      return false
    }
    return true
  })
}

export class MiniMaxSearchAdapter implements WebSearchAdapter {
  private readonly fallback = new BingSearchAdapter()

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const { signal, onProgress, allowedDomains, blockedDomains } = options
    if (signal?.aborted) throw new AbortError()
    onProgress?.({ type: 'query_update', query })

    const base = process.env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim().replace(/\/+$/, '')
    const token = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
    if (!base || !token) {
      // Not wired for MiniMax (e.g. personal/dev) — use the original scraper.
      return this.fallback.search(query, options)
    }

    const abortController = new AbortController()
    if (signal) {
      signal.addEventListener('abort', () => abortController.abort(), { once: true })
    }

    let data: unknown
    try {
      const res = await axios.post(
        `${base}${MINIMAX_SEARCH_PATH}`,
        { q: query },
        {
          signal: abortController.signal,
          timeout: FETCH_TIMEOUT_MS,
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        },
      )
      data = res.data
    } catch (e) {
      if (axios.isCancel(e) || abortController.signal.aborted || signal?.aborted) {
        throw new AbortError()
      }
      // MiniMax proxy unavailable / upstream error → degrade to Bing rather than fail.
      return this.fallback.search(query, options)
    }
    if (abortController.signal.aborted) throw new AbortError()

    const organic =
      data && typeof data === 'object' && Array.isArray((data as { organic?: unknown }).organic)
        ? ((data as { organic: unknown[] }).organic as Array<Record<string, unknown>>)
        : []
    const mapped: SearchResult[] = organic
      .map((r) => {
        const snippet = typeof r.snippet === 'string' && r.snippet ? r.snippet : undefined
        // Surface upstream recency into the snippet head so the model can weigh
        // freshness (the master proxy already time-reranked; this makes the date
        // visible in the text the model reads). No date → snippet unchanged.
        const date = typeof r.date === 'string' && r.date ? r.date : undefined
        return {
          title: typeof r.title === 'string' ? r.title : '',
          url: typeof r.url === 'string' ? r.url : '',
          snippet: date ? `(${date}) ${snippet ?? ''}`.trim() : snippet,
        }
      })
      .filter((r) => r.url)

    const results = filterByDomain(mapped, allowedDomains, blockedDomains)
    onProgress?.({ type: 'search_results_received', resultCount: results.length, query })
    return results
  }
}
