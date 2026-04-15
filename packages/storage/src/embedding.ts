/**
 * Embedding Provider Abstraction (P1.1)
 *
 * Unified interface for text embedding generation. Supports multiple backends:
 * - OpenAI API (text-embedding-3-small, default)
 * - Extensible to local models (BGE-M3) in future
 *
 * Configuration via environment variables:
 *   EMBEDDING_PROVIDER   — "openai" (default)
 *   EMBEDDING_MODEL      — model id (default: "text-embedding-3-small")
 *   EMBEDDING_DIMENSIONS — output dimensions (default: 1536)
 *   EMBEDDING_API_KEY    — API key (falls back to OPENAI_API_KEY)
 *   EMBEDDING_BASE_URL   — API base URL (default: "https://api.openai.com/v1")
 */

// ── Interface ────────────────────────────────────

/** Embedding purpose — some models produce different vectors for queries vs documents. */
export type EmbeddingKind = 'query' | 'document'

export interface EmbeddingProvider {
  /** Provider identifier (e.g. "openai") */
  readonly providerId: string
  /** Model identifier (e.g. "text-embedding-3-small") */
  readonly modelId: string
  /** Embedding vector dimensions */
  readonly dimensions: number

  /**
   * Generate embeddings for one or more texts.
   * Implementations handle batching internally.
   * @param texts  Input texts to embed.
   * @param kind   Purpose of the embedding — affects prefix/instruction for
   *               models that distinguish query vs document embeddings (e.g. BGE-M3).
   *               OpenAI models ignore this parameter.
   * @returns One Float32Array per input text, each of length `dimensions`.
   */
  embed(texts: string[], kind?: EmbeddingKind): Promise<Float32Array[]>
}

export interface EmbeddingProviderConfig {
  provider?: string
  model?: string
  dimensions?: number
  apiKey?: string
  baseUrl?: string
  /** Max texts per API call (default: 100 for OpenAI) */
  batchSize?: number
  /** Request timeout in ms (default: 30_000) */
  timeoutMs?: number
}

// ── Config validation ────────────────────────────

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  // Strict: reject partial parses like "1536abc" or "1e2"
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`Invalid positive integer: "${value}"`)
  }
  const n = Number(value.trim())
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`Invalid positive integer: "${value}"`)
  }
  return n
}

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(`${name} must be a finite positive integer, got ${value}`)
  }
}

// ── OpenAI Provider ──────────────────────────────

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>
  usage: { prompt_tokens: number; total_tokens: number }
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly providerId = 'openai'
  readonly modelId: string
  readonly dimensions: number

  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly batchSize: number
  private readonly timeoutMs: number

  constructor(config: EmbeddingProviderConfig = {}) {
    this.modelId = config.model ?? 'text-embedding-3-small'
    this.dimensions = config.dimensions ?? 1536
    this.apiKey = config.apiKey ?? ''
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
    this.batchSize = config.batchSize ?? 100
    this.timeoutMs = config.timeoutMs ?? 30_000

    if (!this.apiKey) {
      throw new Error('OpenAIEmbeddingProvider: apiKey is required (set EMBEDDING_API_KEY or OPENAI_API_KEY)')
    }
    assertPositiveInt('dimensions', this.dimensions)
    assertPositiveInt('batchSize', this.batchSize)
    assertPositiveInt('timeoutMs', this.timeoutMs)
  }

  async embed(texts: string[], _kind?: EmbeddingKind): Promise<Float32Array[]> {
    if (texts.length === 0) return []

    // Process in batches (serial to respect API rate limits)
    const results = new Array<Float32Array>(texts.length)
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize)
      const batchResults = await this.embedBatch(batch)
      for (let j = 0; j < batchResults.length; j++) {
        results[i + j] = batchResults[j]
      }
    }
    return results
  }

  private async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const resp = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.modelId,
          input: texts,
          dimensions: this.dimensions,
          encoding_format: 'float',
        }),
        signal: controller.signal,
      })

      if (!resp.ok) {
        const status = resp.status
        const body = await resp.text().catch(() => '')
        // Sanitize body to avoid leaking echoed secrets from proxies
        const safeBody = body.slice(0, 200).replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
        throw new Error(`Embedding API error ${status}: ${safeBody}`)
      }

      const json = (await resp.json()) as OpenAIEmbeddingResponse
      return this.validateAndExtract(json, texts.length)
    } catch (err) {
      // Only wrap fetch/abort errors — let validation and API errors pass through
      if (err instanceof TypeError || (err instanceof DOMException && err.name === 'AbortError')) {
        const kind = err instanceof DOMException ? 'timeout' : 'network'
        throw new Error(
          `Embedding ${kind} error [${this.providerId}/${this.modelId}]: ${err.message}`,
        )
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Validate API response shape and extract Float32Array embeddings.
   * Ensures: correct count, valid indices, correct dimensions.
   */
  private validateAndExtract(json: OpenAIEmbeddingResponse, expectedCount: number): Float32Array[] {
    if (!json.data || json.data.length !== expectedCount) {
      throw new Error(
        `Embedding response count mismatch: expected ${expectedCount}, got ${json.data?.length ?? 0}`,
      )
    }

    const results = new Array<Float32Array>(expectedCount)
    const seen = new Set<number>()

    for (const item of json.data) {
      if (item.index < 0 || item.index >= expectedCount) {
        throw new Error(`Embedding response has out-of-range index: ${item.index}`)
      }
      if (seen.has(item.index)) {
        throw new Error(`Embedding response has duplicate index: ${item.index}`)
      }
      seen.add(item.index)

      if (item.embedding.length !== this.dimensions) {
        throw new Error(
          `Embedding dimension mismatch at index ${item.index}: expected ${this.dimensions}, got ${item.embedding.length}`,
        )
      }

      results[item.index] = new Float32Array(item.embedding)
    }

    return results
  }
}

// ── Factory ──────────────────────────────────────

let _provider: EmbeddingProvider | null = null

/**
 * Build config from environment variables.
 * Throws on invalid numeric values.
 */
export function configFromEnv(): EmbeddingProviderConfig {
  return {
    provider: process.env.EMBEDDING_PROVIDER ?? 'openai',
    model: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
    dimensions: parsePositiveInt(process.env.EMBEDDING_DIMENSIONS, 1536),
    apiKey: process.env.EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
    baseUrl: process.env.EMBEDDING_BASE_URL ?? 'https://api.openai.com/v1',
  }
}

/**
 * Get or create the singleton embedding provider.
 * The singleton is initialized once from the first call's config (or env).
 * Use `resetEmbeddingProvider()` in tests to clear it.
 */
export function getEmbeddingProvider(config?: EmbeddingProviderConfig): EmbeddingProvider {
  if (_provider) return _provider

  const cfg = config ?? configFromEnv()
  const providerType = cfg.provider ?? 'openai'

  switch (providerType) {
    case 'openai':
      _provider = new OpenAIEmbeddingProvider(cfg)
      break
    default:
      throw new Error(`Unknown embedding provider: ${providerType}`)
  }

  return _provider
}

/**
 * Check if an embedding provider can be constructed from current config.
 * Provider-aware: validates that the provider type is known and has required credentials.
 */
export function isEmbeddingAvailable(): boolean {
  try {
    const cfg = configFromEnv()
    const providerType = cfg.provider ?? 'openai'
    switch (providerType) {
      case 'openai':
        return (cfg.apiKey ?? '').length > 0
      default:
        return false
    }
  } catch {
    return false
  }
}

/** Reset the singleton (for testing). */
export function resetEmbeddingProvider(): void {
  _provider = null
}
