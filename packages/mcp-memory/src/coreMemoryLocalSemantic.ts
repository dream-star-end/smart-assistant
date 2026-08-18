/**
 * Personal-edition Core memory semantic rank (no commercial master).
 *
 * Opt-in only — unset flags mean "semantic layer unavailable" so lexical
 * evals stay reproducible. Failures (missing creds, timeout, bad payload)
 * return null; this module must never throw into the search hot path.
 *
 * Enable:
 *   OPENCLAUDE_CORE_MEMORY_LOCAL_SEMANTIC=1  + EMBEDDING_* (preferred)
 *   OPENCLAUDE_CORE_MEMORY_LLM_RERANK=1      + OPENCLAUDE_CORE_MEMORY_LLM_*
 */
import {
  OpenAIEmbeddingProvider,
  configFromEnv,
  cosineSim,
} from '@openclaude/storage'

import {
  type CoreMemoryChunk,
  type CoreMemoryDocument,
  type CoreMemorySemanticFile,
  type CoreMemorySemanticOptions,
} from './coreMemorySemantic.js'

export const LOCAL_SEMANTIC_ENV = 'OPENCLAUDE_CORE_MEMORY_LOCAL_SEMANTIC'
export const LLM_RERANK_ENV = 'OPENCLAUDE_CORE_MEMORY_LLM_RERANK'
export const LLM_BASE_URL_ENV = 'OPENCLAUDE_CORE_MEMORY_LLM_BASE_URL'
export const LLM_API_KEY_ENV = 'OPENCLAUDE_CORE_MEMORY_LLM_API_KEY'
export const LLM_MODEL_ENV = 'OPENCLAUDE_CORE_MEMORY_LLM_MODEL'
export const LOCAL_TIMEOUT_ENV = 'OPENCLAUDE_CORE_MEMORY_SEMANTIC_TIMEOUT_MS'

/**
 * Budget for the personal-edition local semantic pass.
 *
 * handleCoreSearch only invokes this pass when BM25 strong hits are empty,
 * so a timeout is a false No match rather than extra latency. oc-memory is
 * a one-shot CLI, and the gate makes calls sparse, so almost every run pays
 * a cold TLS handshake to DashScope text-embedding-v4. Default covers the
 * measured cold-start tail (~3.5s plus jitter); env may raise it up to MAX
 * but is still clamped so a hung upstream cannot stall the search path.
 */
export const DEFAULT_LOCAL_TIMEOUT_MS = 3_800
export const MAX_LOCAL_TIMEOUT_MS = 5_000
export const MIN_LOCAL_TIMEOUT_MS = 200
const FILE_PREVIEW_CHARS = 500
const LLM_PREVIEW_CHARS = 400
const LLM_MAX_DOCS = 24
const LABEL_LENGTH = 120

interface RankedChunk {
  id: string
  score: number
}

function envFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

function hasCjk(query: string): boolean {
  return /[\u3400-\u9fff]/u.test(query)
}

function clampTimeoutMs(raw: number | undefined): number {
  if (!Number.isFinite(raw) || raw === undefined) return DEFAULT_LOCAL_TIMEOUT_MS
  return Math.min(MAX_LOCAL_TIMEOUT_MS, Math.max(MIN_LOCAL_TIMEOUT_MS, Math.floor(raw)))
}

export function localSemanticTimeoutMs(override?: number): number {
  if (override !== undefined) return clampTimeoutMs(override)
  const env = process.env[LOCAL_TIMEOUT_ENV]?.trim()
  if (!env || !/^\d+$/.test(env)) return DEFAULT_LOCAL_TIMEOUT_MS
  return clampTimeoutMs(Number(env))
}

/**
 * DashScope text-embedding-v4 cosine on short Chinese Core notes sits in a
 * compressed band (~0.28–0.45). The commercial q8 e5 gate (0.82+) would
 * no-match everything. Admit a file only when it is a relative outlier.
 */
export function selectLocalSemanticFiles(
  query: string,
  chunks: CoreMemoryChunk[],
  rankedChunks: RankedChunk[],
): CoreMemorySemanticFile[] {
  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]))
  const byFile = new Map<string, CoreMemorySemanticFile>()
  for (const ranked of rankedChunks) {
    if (!Number.isFinite(ranked.score)) continue
    const chunk = chunkById.get(ranked.id)
    if (!chunk) continue
    const current = byFile.get(chunk.path)
    if (!current || ranked.score > current.score) {
      byFile.set(chunk.path, {
        path: chunk.path,
        score: ranked.score,
        start: chunk.start,
      })
    }
  }
  const files = [...byFile.values()].sort(
    (a, b) => b.score - a.score || a.path.localeCompare(b.path),
  )
  const top = files[0]
  if (!top) return []
  const cjk = hasCjk(query)
  const floor = cjk ? 0.34 : 0.30
  if (top.score < floor) return []
  const second = files[1]
  if (!second) return [top]
  const margin = top.score - second.score
  const restMean =
    files.slice(1).reduce((sum, file) => sum + file.score, 0) / (files.length - 1)
  const outlier = top.score - restMean
  if (margin >= 0.025 || (outlier >= 0.04 && margin >= 0.02)) return [top]
  return []
}

async function raceTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guarded = work.then(
    (value) => value,
    () => null,
  )
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  try {
    return await Promise.race([guarded, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function toFloat32(vector: ArrayLike<number>): Float32Array {
  return vector instanceof Float32Array ? vector : Float32Array.from(vector)
}

function rankChunksByVectors(
  queryVec: ArrayLike<number>,
  chunks: CoreMemoryChunk[],
  docVecs: ArrayLike<number>[],
): RankedChunk[] | null {
  if (docVecs.length !== chunks.length) return null
  const ranked: RankedChunk[] = []
  for (let i = 0; i < chunks.length; i++) {
    const score = cosineSim(queryVec, docVecs[i])
    if (!Number.isFinite(score)) return null
    ranked.push({ id: chunks[i].id, score })
  }
  return ranked
}

function previewChunks(documents: CoreMemoryDocument[]): CoreMemoryChunk[] {
  const chunks: CoreMemoryChunk[] = []
  for (const document of documents) {
    if (!document.content.trim()) continue
    chunks.push({
      id: String(chunks.length),
      path: document.path,
      start: 0,
      text: `${document.label.slice(0, LABEL_LENGTH)}\n${document.content.slice(0, FILE_PREVIEW_CHARS)}`,
    })
  }
  return chunks
}

function parseLlmRanked(text: string): RankedChunk[] | null {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fenced ? fenced[1] : trimmed
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { ranked?: unknown }
    if (!Array.isArray(parsed.ranked)) return null
    const ranked: RankedChunk[] = []
    const seen = new Set<string>()
    for (const item of parsed.ranked) {
      if (!item || typeof item !== 'object') return null
      const row = item as Record<string, unknown>
      if (typeof row.id !== 'string' || typeof row.score !== 'number' || !Number.isFinite(row.score)) {
        return null
      }
      if (seen.has(row.id)) return null
      seen.add(row.id)
      ranked.push({ id: row.id, score: row.score })
    }
    return ranked.length > 0 ? ranked : null
  } catch {
    return null
  }
}

async function embedViaProvider(
  texts: string[],
  timeoutMs: number,
): Promise<Float32Array[] | null> {
  try {
    const cfg = configFromEnv()
    if (!(cfg.apiKey ?? '').length) return null
    const provider = new OpenAIEmbeddingProvider({
      ...cfg,
      timeoutMs,
    })
    const batchSize = cfg.batchSize ?? 10
    const tasks: Promise<Float32Array[]>[] = []
    for (let i = 0; i < texts.length; i += batchSize) {
      tasks.push(provider.embed(texts.slice(i, i + batchSize)))
    }
    const parts = await Promise.all(tasks)
    const vectors: Float32Array[] = []
    for (const part of parts) vectors.push(...part)
    if (vectors.length !== texts.length) return null
    return vectors
  } catch {
    return null
  }
}

async function llmRerankViaChat(
  query: string,
  documents: Array<{ id: string; text: string }>,
  timeoutMs: number,
): Promise<RankedChunk[] | null> {
  const baseUrl = process.env[LLM_BASE_URL_ENV]?.trim()
  const model = process.env[LLM_MODEL_ENV]?.trim()
  const apiKey =
    process.env[LLM_API_KEY_ENV]?.trim() ||
    process.env.EMBEDDING_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    ''
  if (!baseUrl || !model || !apiKey || documents.length === 0) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 800,
        messages: [
          {
            role: 'system',
            content:
              'You rank Core memory notes for retrieval. Score each document from 0 to 1 by semantic relevance to the query, including synonyms and paraphrases. Ignore shared boilerplate unless it is the query focus. Return JSON only: {"ranked":[{"id":"0","score":0.0}]}',
          },
          {
            role: 'user',
            content: `Query: ${query}\n\nDocuments:\n${documents
              .map((doc) => `[id=${doc.id}] ${doc.text}`)
              .join('\n')}`,
          },
        ],
      }),
      signal: controller.signal,
    })
    if (!resp.ok) return null
    const json = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = json.choices?.[0]?.message?.content
    if (typeof content !== 'string') return null
    return parseLlmRanked(content)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function rankByEmbeddings(
  query: string,
  chunks: CoreMemoryChunk[],
  options: CoreMemorySemanticOptions,
  timeoutMs: number,
): Promise<CoreMemorySemanticFile[] | null> {
  const texts = [query, ...chunks.map((chunk) => chunk.text)]
  const embed = options.localEmbed
    ? async (input: string[]) => (await options.localEmbed!(input)).map(toFloat32)
    : (input: string[]) => embedViaProvider(input, timeoutMs)
  const vectors = await raceTimeout(embed(texts), timeoutMs)
  if (!vectors || vectors.length !== texts.length) return null
  const ranked = rankChunksByVectors(vectors[0], chunks, vectors.slice(1))
  if (!ranked) return null
  return selectLocalSemanticFiles(query, chunks, ranked)
}

async function rankByLlm(
  query: string,
  chunks: CoreMemoryChunk[],
  options: CoreMemorySemanticOptions,
  timeoutMs: number,
): Promise<CoreMemorySemanticFile[] | null> {
  const compact = chunks.slice(0, LLM_MAX_DOCS)
  const documents = compact.map((chunk) => ({
    id: chunk.id,
    text: chunk.text.slice(0, LLM_PREVIEW_CHARS),
  }))
  const rank = options.localLlmRerank
    ? options.localLlmRerank
    : (q: string, docs: Array<{ id: string; text: string }>) => llmRerankViaChat(q, docs, timeoutMs)
  const ranked = await raceTimeout(rank(query, documents), timeoutMs)
  if (!ranked) return null
  const allowed = new Set(compact.map((chunk) => chunk.id))
  const filtered = ranked.filter((item) => allowed.has(item.id))
  if (filtered.length === 0) return null
  return selectLocalSemanticFiles(query, compact, filtered)
}

function embeddingPathEnabled(options: CoreMemorySemanticOptions): boolean {
  if (options.localEmbed) return true
  if (!envFlag(LOCAL_SEMANTIC_ENV)) return false
  try {
    return (configFromEnv().apiKey ?? '').length > 0
  } catch {
    return false
  }
}

function llmPathEnabled(options: CoreMemorySemanticOptions): boolean {
  if (options.localLlmRerank) return true
  if (!envFlag(LLM_RERANK_ENV)) return false
  const baseUrl = process.env[LLM_BASE_URL_ENV]?.trim()
  const model = process.env[LLM_MODEL_ENV]?.trim()
  const apiKey =
    process.env[LLM_API_KEY_ENV]?.trim() ||
    process.env.EMBEDDING_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    ''
  return Boolean(baseUrl && model && apiKey)
}

/**
 * Personal-edition semantic rank. Returns null when nothing is opted in or
 * the chosen backend fails — callers then keep pure lexical results.
 */
export async function rankCoreMemoryLocally(
  query: string,
  documents: CoreMemoryDocument[],
  options: CoreMemorySemanticOptions = {},
): Promise<CoreMemorySemanticFile[] | null> {
  const wantEmbed = embeddingPathEnabled(options)
  const wantLlm = llmPathEnabled(options)
  if (!wantEmbed && !wantLlm) return null
  const chunks = previewChunks(documents)
  if (chunks.length === 0) return []
  const timeoutMs = localSemanticTimeoutMs(options.timeoutMs)
  try {
    // Embedding, when opted in, owns the latency budget. A failed embed
    // returns null rather than stacking a second LLM call on the hot path.
    if (wantEmbed) return await rankByEmbeddings(query, chunks, options, timeoutMs)
    return await rankByLlm(query, chunks, options, timeoutMs)
  } catch {
    return null
  }
}
