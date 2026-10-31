import { createHash } from 'node:crypto'
import { request } from 'undici'
import { COMPACTION_TIMELINE_PATH } from '@openclaude/protocol'
import {
  ClientTimelineCursorStaleError,
  decodeClientTimelineCursor,
  encodeClientTimelineCursor,
  readClientTimelinePage,
  type ClientTimelinePage,
} from '@openclaude/storage'

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024

/** Credentials select master authority. Remote errors must never fall back to
 * the container's empty/stale SQLite or the model's historical input window. */
export function createCompactionTimelineReader(deps: {
  env?: NodeJS.ProcessEnv
  fetcher?: typeof request
  localReadPage?: typeof readClientTimelinePage
  maxResponseBytes?: number
} = {}): typeof readClientTimelinePage {
  return async (sessionId, ownerUserId, cursor = null, limit = 200) => {
    const env = deps.env ?? process.env
    const base = env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim().replace(/\/+$/, '')
    const bearer = env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
    if (!base && !bearer) return (deps.localReadPage ?? readClientTimelinePage)(sessionId, ownerUserId, cursor, limit)
    if (!base || !bearer) throw new Error('COMPACTION_TIMELINE_MASTER_CONFIG_INCOMPLETE')
    const query = new URLSearchParams({ sessionId })
    if (cursor) query.set('cursor', encodeClientTimelineCursor(cursor))
    let response: Awaited<ReturnType<typeof request>>
    try {
      response = await (deps.fetcher ?? request)(`${base}${COMPACTION_TIMELINE_PATH}?${query}`, {
        method: 'GET', headers: { authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(120_000), headersTimeout: 15_000, bodyTimeout: 120_000,
      })
    } catch { throw new Error('COMPACTION_TIMELINE_REMOTE_UNAVAILABLE') }
    // Drain small error bodies: destroying them aborts the request, and undici
    // then raises an unobserved AbortError after this read has returned.
    if (response.statusCode !== 200) await response.body.dump().catch(() => {})
    if (response.statusCode === 404) return null
    if (response.statusCode === 409) throw new ClientTimelineCursorStaleError()
    if (response.statusCode !== 200) throw new Error(`COMPACTION_TIMELINE_REMOTE_STATUS_${response.statusCode}`)
    const chunks: Buffer[] = []
    let bytes = 0
    try {
      for await (const raw of response.body) {
        const chunk = Buffer.from(raw)
        bytes += chunk.length
        if (bytes > (deps.maxResponseBytes ?? MAX_RESPONSE_BYTES)) {
          response.body.destroy()
          throw new Error('COMPACTION_TIMELINE_RESPONSE_TOO_LARGE')
        }
        chunks.push(chunk)
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'COMPACTION_TIMELINE_RESPONSE_TOO_LARGE') throw error
      throw new Error('COMPACTION_TIMELINE_INCOMPLETE_RESPONSE')
    }
    const content = Buffer.concat(chunks)
    const expectedSha = response.headers['x-openclaude-content-sha256']
    if (typeof expectedSha !== 'string' || createHash('sha256').update(content).digest('hex') !== expectedSha) {
      throw new Error('COMPACTION_TIMELINE_RESPONSE_INTEGRITY')
    }
    let result: { ownerUserId?: unknown; sessionId?: unknown; page?: ClientTimelinePage }
    try { result = JSON.parse(content.toString('utf8')) } catch { throw new Error('COMPACTION_TIMELINE_RESPONSE_INVALID') }
    const next = result?.page?.nextCursor
    const validCursor = next === null || (next && typeof next === 'object' &&
      decodeClientTimelineCursor(encodeClientTimelineCursor(next)) !== null)
    if (result?.ownerUserId !== ownerUserId || result.sessionId !== sessionId ||
        !result.page || !Array.isArray(result.page.messages) ||
        result.page.messages.some(message => !message || typeof message !== 'object' || Array.isArray(message) ||
          message._payloadDeferred === true) ||
        !Number.isSafeInteger(result.page.timelineGeneration) || result.page.timelineGeneration < 1 ||
        !Number.isSafeInteger(result.page.historyRevision) || result.page.historyRevision < 0 ||
        !Number.isSafeInteger(result.page.snapshotMaxSeq) || result.page.snapshotMaxSeq < 0 ||
        typeof result.page.hasMore !== 'boolean' || !validCursor ||
        (result.page.hasMore ? next === null : next !== null)) {
      throw new Error('COMPACTION_TIMELINE_RESPONSE_INVALID')
    }
    return result.page
  }
}

export const readCompactionTimelinePage: typeof readClientTimelinePage = (...args) =>
  createCompactionTimelineReader()(...args)
