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
 * Resilience: a MiniMax failure tries `/internal/v3/grok-search` (master holds the
 * Grok subscription token and calls xAI web_search). Bing remains only the last
 * resort, so a MiniMax outage does not immediately serve the scraper.
 */

import axios from 'axios'
import { AbortError } from 'src/utils/errors.js'
import { BingSearchAdapter } from './bingAdapter.js'
import type { SearchOptions, SearchResult, WebSearchAdapter } from './types.js'

const FETCH_TIMEOUT_MS = 30_000
const MINIMAX_SEARCH_PATH = '/internal/v3/minimax-search'
const GROK_SEARCH_PATH = '/internal/v3/grok-search'

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

function mapOrganic(
  data: unknown,
  allowedDomains?: string[],
  blockedDomains?: string[],
): SearchResult[] {
  const organic =
    data && typeof data === 'object' && Array.isArray((data as { organic?: unknown }).organic)
      ? ((data as { organic: unknown[] }).organic as Array<Record<string, unknown>>)
      : []
  const mapped: SearchResult[] = organic
    .map((r) => {
      const snippet = typeof r.snippet === 'string' && r.snippet ? r.snippet : undefined
      const date = typeof r.date === 'string' && r.date ? r.date : undefined
      return {
        title: typeof r.title === 'string' ? r.title : '',
        url: typeof r.url === 'string' ? r.url : '',
        snippet: date ? `(${date}) ${snippet ?? ''}`.trim() : snippet,
      }
    })
    .filter((r) => r.url)
  return filterByDomain(mapped, allowedDomains, blockedDomains)
}

type ProxyOutcome = SearchResult[] | 'fail' | 'abort'

export class MiniMaxSearchAdapter implements WebSearchAdapter {
  private readonly fallback = new BingSearchAdapter()

  private async postProxy(
    base: string,
    token: string,
    path: string,
    query: string,
    signal: AbortSignal | undefined,
    abortController: AbortController,
    allowedDomains?: string[],
    blockedDomains?: string[],
  ): Promise<ProxyOutcome> {
    try {
      const res = await axios.post(
        `${base}${path}`,
        { q: query },
        {
          signal: abortController.signal,
          timeout: FETCH_TIMEOUT_MS,
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        },
      )
      if (abortController.signal.aborted || signal?.aborted) return 'abort'
      return mapOrganic(res.data, allowedDomains, blockedDomains)
    } catch (e) {
      if (axios.isCancel(e) || abortController.signal.aborted || signal?.aborted) return 'abort'
      return 'fail'
    }
  }

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const { signal, onProgress, allowedDomains, blockedDomains } = options
    if (signal?.aborted) throw new AbortError()
    onProgress?.({ type: 'query_update', query })

    const base = process.env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim().replace(/\/+$/, '')
    const token = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
    if (!base || !token) {
      return this.fallback.search(query, options)
    }

    const abortController = new AbortController()
    if (signal) {
      signal.addEventListener('abort', () => abortController.abort(), { once: true })
    }

    const paths = [MINIMAX_SEARCH_PATH, GROK_SEARCH_PATH]
    for (const path of paths) {
      const outcome = await this.postProxy(
        base,
        token,
        path,
        query,
        signal,
        abortController,
        allowedDomains,
        blockedDomains,
      )
      if (outcome === 'abort') throw new AbortError()
      if (outcome !== 'fail') {
        onProgress?.({ type: 'search_results_received', resultCount: outcome.length, query })
        return outcome
      }
    }
    return this.fallback.search(query, options)
  }
}
