import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'

export interface CoreMemoryDocument {
  path: string
  label: string
  size: number
  content: string
}

export interface CoreMemoryChunk {
  id: string
  path: string
  start: number
  text: string
}

export interface CoreMemorySemanticFile {
  path: string
  score: number
  start: number
}

interface RemoteRank {
  id: string
  score: number
}

const CHUNK_LENGTH = 320
const CHUNK_OVERLAP = 48
const LABEL_LENGTH = 120
const BATCH_SIZE = 48
const REQUEST_TIMEOUT_MS = 45_000

function endAtNaturalBoundary(content: string, start: number): number {
  const hardEnd = Math.min(content.length, start + CHUNK_LENGTH)
  if (hardEnd === content.length) return hardEnd
  const minEnd = start + Math.floor(CHUNK_LENGTH * 0.55)
  const window = content.slice(minEnd, hardEnd)
  let relative = -1
  for (const boundary of ['\n\n', '\n', '。', '！', '？', '. ', '! ', '? ']) {
    relative = Math.max(relative, window.lastIndexOf(boundary))
  }
  let end = relative >= 0 ? minEnd + relative + 1 : hardEnd
  if (end > start && /[\uD800-\uDBFF]/u.test(content[end - 1] ?? '')) end--
  return end
}

/** Natural-boundary overlapping chunks, without a total file/chunk cap. */
export function chunkCoreMemoryDocuments(documents: CoreMemoryDocument[]): CoreMemoryChunk[] {
  const chunks: CoreMemoryChunk[] = []
  for (const document of documents) {
    if (!document.content.trim()) continue
    let start = 0
    while (start < document.content.length) {
      const end = endAtNaturalBoundary(document.content, start)
      const body = document.content.slice(start, end).trim()
      if (body) {
        chunks.push({
          id: String(chunks.length),
          path: document.path,
          start,
          text: `${document.label.slice(0, LABEL_LENGTH)}\n${body}`,
        })
      }
      if (end >= document.content.length) break
      start = Math.max(start + 1, end - CHUNK_OVERLAP)
    }
  }
  return chunks
}

function hasCjk(query: string): boolean {
  return /[\u3400-\u9fff]/u.test(query)
}

/**
 * Calibrated q8 no-match gate. Margin is computed only after aggregation by
 * different files, so a single file or two overlapping chunks in one file do
 * not manufacture ambiguity.
 */
export function selectSemanticFiles(
  query: string,
  chunks: CoreMemoryChunk[],
  rankedChunks: RemoteRank[],
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
  const second = files[1]
  const cjk = hasCjk(query)
  if (!second) return top.score >= (cjk ? 0.87 : 0.82) ? [top] : []

  const margin = top.score - second.score
  if (cjk) {
    // Very strong independent matches may legitimately span multiple Core
    // files. The lower calibrated band is accepted only when it clearly wins,
    // and returns just that winning file rather than adding weak neighbors.
    if (top.score >= 0.89) return files.filter((file) => file.score >= 0.89)
    return top.score >= 0.865 && margin >= 0.015 ? [top] : []
  }
  return top.score >= 0.82 && margin >= 0.015 ? [top] : []
}

function readContainerToken(): string {
  const file = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN_FILE?.trim()
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim()
    } catch {
      // Match other in-container clients: an unreadable file falls back to the
      // direct execve env rather than disabling a valid authenticated route.
    }
  }
  return process.env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim() ?? ''
}

function postJson(
  url: string,
  token: string,
  body: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk as Buffer))
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('core memory semantic rank timeout'))
    })
    req.end(body)
  })
}

export interface CoreMemorySemanticOptions {
  baseUrl?: string
  token?: string
  postImpl?: typeof postJson
  /**
   * Personal-edition local rank timeout in ms. Master relay ignores this and
   * keeps its own 45s transport timeout. Local default is 3800ms (clamped
   * 200..5000) so a cold TLS handshake to DashScope can finish; this pass
   * only runs when BM25 strong hits are empty.
   */
  timeoutMs?: number
  /**
   * Test seam for local embedding rank. Production uses EMBEDDING_* only when
   * OPENCLAUDE_CORE_MEMORY_LOCAL_SEMANTIC is explicitly enabled.
   */
  localEmbed?: (texts: string[]) => Promise<ArrayLike<number>[]>
  /**
   * Test seam for local LLM rerank. Production uses OPENCLAUDE_CORE_MEMORY_LLM_*
   * only when OPENCLAUDE_CORE_MEMORY_LLM_RERANK is explicitly enabled.
   */
  localLlmRerank?: (
    query: string,
    documents: Array<{ id: string; text: string }>,
  ) => Promise<Array<{ id: string; score: number }>>
}

async function rankViaMasterRelay(
  query: string,
  documents: CoreMemoryDocument[],
  base: string,
  token: string,
  post: typeof postJson,
): Promise<CoreMemorySemanticFile[] | null> {
  const chunks = chunkCoreMemoryDocuments(documents)
  if (chunks.length === 0) return []
  const rankedChunks: RemoteRank[] = []
  try {
    for (let at = 0; at < chunks.length; at += BATCH_SIZE) {
      const batch = chunks.slice(at, at + BATCH_SIZE)
      const response = await post(
        `${base.replace(/\/+$/, '')}/internal/v3/core-memory-rank`,
        token,
        JSON.stringify({
          query,
          documents: batch.map((chunk) => ({ id: chunk.id, text: chunk.text })),
        }),
      )
      if (response.statusCode < 200 || response.statusCode >= 300) return null
      const parsed = JSON.parse(response.body) as {
        ok?: boolean
        ranked?: unknown
      }
      if (!parsed.ok || !Array.isArray(parsed.ranked) || parsed.ranked.length !== batch.length) {
        return null
      }
      const expected = new Set(batch.map((chunk) => chunk.id))
      for (const raw of parsed.ranked) {
        if (!raw || typeof raw !== 'object') return null
        const item = raw as Record<string, unknown>
        if (
          typeof item.id !== 'string' ||
          typeof item.score !== 'number' ||
          !Number.isFinite(item.score) ||
          !expected.delete(item.id)
        ) {
          return null
        }
        rankedChunks.push({ id: item.id, score: item.score })
      }
      if (expected.size !== 0) return null
    }
    return selectSemanticFiles(query, chunks, rankedChunks)
  } catch {
    return null
  }
}

function envFlagEnabled(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

function localSemanticRequested(options: CoreMemorySemanticOptions): boolean {
  if (options.localEmbed || options.localLlmRerank) return true
  return (
    envFlagEnabled('OPENCLAUDE_CORE_MEMORY_LOCAL_SEMANTIC') ||
    envFlagEnabled('OPENCLAUDE_CORE_MEMORY_LLM_RERANK')
  )
}

/**
 * Rank every current safe chunk through the first-party master. Any failed or
 * malformed batch discards the whole semantic pass so callers use keyword-only
 * results rather than a misleading partial ranking.
 *
 * When master is not configured, an explicit personal-edition local embedding
 * or LLM rerank may run instead. That path is opt-in and fail-closed (null).
 */
export async function rankCoreMemorySemantically(
  query: string,
  documents: CoreMemoryDocument[],
  options: CoreMemorySemanticOptions = {},
): Promise<CoreMemorySemanticFile[] | null> {
  const base = (options.baseUrl ?? process.env.OPENCLAUDE_V3_MASTER_BASE_URL)?.trim()
  const token = options.token ?? readContainerToken()
  if (base && token) {
    return rankViaMasterRelay(query, documents, base, token, options.postImpl ?? postJson)
  }
  if (!localSemanticRequested(options)) return null
  try {
    const { rankCoreMemoryLocally } = await import('./coreMemoryLocalSemantic.js')
    return await rankCoreMemoryLocally(query, documents, options)
  } catch {
    return null
  }
}
