/**
 * Reranker (P1.3)
 *
 * Second-pass reranking of retrieval candidates using cross-encoder models.
 * Improves precision of the top-K results from hybrid search (P1.2).
 *
 * Supports:
 * - API-based reranking (Jina, Cohere, or any rerank API with compatible format)
 * - Configurable via environment variables:
 *     RERANK_PROVIDER   — "jina" | "cohere" (default: "jina")
 *     RERANK_MODEL      — model id (default: "jina-reranker-v2-base-multilingual")
 *     RERANK_API_KEY    — API key
 *     RERANK_BASE_URL   — API base URL
 */

// ── Interface ────────────────────────────────────

export interface RerankResult {
  /** Index into the original documents array */
  index: number
  /** Relevance score (higher = more relevant, typically 0-1) */
  relevanceScore: number
}

export interface Reranker {
  readonly providerId: string
  readonly modelId: string

  /**
   * Rerank documents by relevance to a query.
   * @param query   The search query
   * @param documents  Candidate documents to rerank
   * @param topN    Max results to return (default: all). Must be a positive integer.
   * @returns Reranked results sorted by relevance (highest first)
   */
  rerank(query: string, documents: string[], topN?: number): Promise<RerankResult[]>
}

export interface RerankerConfig {
  provider?: string
  model?: string
  apiKey?: string
  baseUrl?: string
  timeoutMs?: number
}

// ── Shared validation ────────────────────────────

function sanitizeErrorBody(body: string): string {
  return body.slice(0, 200).replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
}

function clampTopN(topN: number | undefined, docCount: number): number {
  if (topN === undefined) return docCount
  if (!Number.isFinite(topN) || topN <= 0) return docCount
  return Math.min(Math.floor(topN), docCount)
}

function validateRerankResponse(
  results: Array<{ index: number; relevance_score: number }> | undefined,
  docCount: number,
): RerankResult[] {
  if (!results || !Array.isArray(results)) {
    throw new Error('Rerank response missing results array')
  }

  const seen = new Set<number>()
  const validated: RerankResult[] = []

  for (const item of results) {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= docCount) {
      throw new Error(`Rerank response has invalid index: ${item.index}`)
    }
    if (seen.has(item.index)) {
      throw new Error(`Rerank response has duplicate index: ${item.index}`)
    }
    seen.add(item.index)

    const score = Number(item.relevance_score)
    if (!Number.isFinite(score)) {
      throw new Error(`Rerank response has non-finite relevance_score at index ${item.index}`)
    }
    validated.push({ index: item.index, relevanceScore: score })
  }

  return validated.sort((a, b) => b.relevanceScore - a.relevanceScore)
}

// ── Jina Reranker ────────────────────────────────

interface JinaRerankResponse {
  results: Array<{ index: number; relevance_score: number }>
}

export class JinaReranker implements Reranker {
  readonly providerId = 'jina'
  readonly modelId: string

  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(config: RerankerConfig = {}) {
    this.modelId = config.model ?? 'jina-reranker-v2-base-multilingual'
    this.apiKey = config.apiKey ?? ''
    this.baseUrl = (config.baseUrl ?? 'https://api.jina.ai/v1').replace(/\/+$/, '')
    this.timeoutMs = config.timeoutMs ?? 30_000

    if (!this.apiKey) {
      throw new Error('JinaReranker: apiKey is required (set RERANK_API_KEY)')
    }
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || !Number.isInteger(this.timeoutMs)) {
      throw new Error(`JinaReranker: timeoutMs must be a positive integer, got ${this.timeoutMs}`)
    }
  }

  async rerank(query: string, documents: string[], topN?: number): Promise<RerankResult[]> {
    if (documents.length === 0) return []
    const effectiveTopN = clampTopN(topN, documents.length)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const resp = await fetch(`${this.baseUrl}/rerank`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.modelId,
          query,
          documents,
          top_n: effectiveTopN,
        }),
        signal: controller.signal,
      })

      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        throw new Error(`Rerank API error ${resp.status}: ${sanitizeErrorBody(body)}`)
      }

      const json = (await resp.json()) as JinaRerankResponse
      return validateRerankResponse(json.results, documents.length)
    } catch (err) {
      if (err instanceof TypeError || (err instanceof DOMException && err.name === 'AbortError')) {
        const kind = err instanceof DOMException ? 'timeout' : 'network'
        throw new Error(`Rerank ${kind} error [${this.providerId}/${this.modelId}]: ${err.message}`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
}

// ── Cohere Reranker ──────────────────────────────

interface CohereRerankResponse {
  results: Array<{ index: number; relevance_score: number }>
}

export class CohereReranker implements Reranker {
  readonly providerId = 'cohere'
  readonly modelId: string

  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(config: RerankerConfig = {}) {
    this.modelId = config.model ?? 'rerank-multilingual-v3.0'
    this.apiKey = config.apiKey ?? ''
    this.baseUrl = (config.baseUrl ?? 'https://api.cohere.com/v2').replace(/\/+$/, '')
    this.timeoutMs = config.timeoutMs ?? 30_000

    if (!this.apiKey) {
      throw new Error('CohereReranker: apiKey is required (set RERANK_API_KEY)')
    }
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || !Number.isInteger(this.timeoutMs)) {
      throw new Error(`CohereReranker: timeoutMs must be a positive integer, got ${this.timeoutMs}`)
    }
  }

  async rerank(query: string, documents: string[], topN?: number): Promise<RerankResult[]> {
    if (documents.length === 0) return []
    const effectiveTopN = clampTopN(topN, documents.length)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const resp = await fetch(`${this.baseUrl}/rerank`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.modelId,
          query,
          // Cohere v2 /rerank accepts a list of strings
          documents,
          top_n: effectiveTopN,
        }),
        signal: controller.signal,
      })

      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        throw new Error(`Rerank API error ${resp.status}: ${sanitizeErrorBody(body)}`)
      }

      const json = (await resp.json()) as CohereRerankResponse
      return validateRerankResponse(json.results, documents.length)
    } catch (err) {
      if (err instanceof TypeError || (err instanceof DOMException && err.name === 'AbortError')) {
        const kind = err instanceof DOMException ? 'timeout' : 'network'
        throw new Error(`Rerank ${kind} error [${this.providerId}/${this.modelId}]: ${err.message}`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
}

// ── Factory ──────────────────────────────────────

let _reranker: Reranker | null = null

export function rerankerConfigFromEnv(): RerankerConfig {
  return {
    provider: process.env.RERANK_PROVIDER ?? 'jina',
    model: process.env.RERANK_MODEL,
    apiKey: process.env.RERANK_API_KEY ?? '',
    baseUrl: process.env.RERANK_BASE_URL,
  }
}

export function getReranker(config?: RerankerConfig): Reranker {
  if (_reranker) return _reranker

  const cfg = config ?? rerankerConfigFromEnv()
  const providerType = cfg.provider ?? 'jina'

  switch (providerType) {
    case 'jina':
      _reranker = new JinaReranker(cfg)
      break
    case 'cohere':
      _reranker = new CohereReranker(cfg)
      break
    default:
      throw new Error(`Unknown reranker provider: ${providerType}`)
  }

  return _reranker
}

export function isRerankerAvailable(): boolean {
  try {
    const cfg = rerankerConfigFromEnv()
    const providerType = cfg.provider ?? 'jina'
    switch (providerType) {
      case 'jina':
      case 'cohere':
        return (cfg.apiKey ?? '').length > 0
      default:
        return false
    }
  } catch {
    return false
  }
}

export function resetReranker(): void {
  _reranker = null
}

// ── Integration with Hybrid Search ───────────────

/**
 * Apply reranking to hybrid search results.
 * Takes the fused candidates and reranks them using the cross-encoder.
 * Falls back to original ordering if reranking fails.
 *
 * @param query     Search query
 * @param results   Hybrid search results with content
 * @param reranker  Reranker instance (null to skip)
 * @param topN      Max results to return after reranking (positive integer)
 * @returns Reranked results (or original if reranker unavailable)
 */
export async function rerankResults<T extends { content?: string; snippet?: string }>(
  query: string,
  results: T[],
  reranker: Reranker | null,
  topN?: number,
): Promise<T[]> {
  const effectiveTopN = clampTopN(topN, results.length)
  if (!reranker || results.length === 0) return results.slice(0, effectiveTopN)

  // Extract text for reranking — prefer content, fall back to snippet
  const documents = results.map(r => (r.content ?? r.snippet ?? '').slice(0, 1000))

  try {
    const ranked = await reranker.rerank(query, documents, effectiveTopN)
    return ranked
      .filter(r => Number.isInteger(r.index) && r.index >= 0 && r.index < results.length)
      .map(r => results[r.index])
      .slice(0, effectiveTopN)
  } catch {
    // Fall back to original ordering on rerank failure
    return results.slice(0, effectiveTopN)
  }
}
