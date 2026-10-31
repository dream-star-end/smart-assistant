/** Container-local SQLite is not the managed deployment's session authority.
 * This private read hydrates exact master records, including deferred bodies. */
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { COMPACTION_TIMELINE_PATH } from '@openclaude/protocol'
import {
  decodeClientTimelineCursor,
  readClientTimelinePage,
  readTapeRecordPayload,
  readUserMessagePayload,
  type MessageLike,
} from '@openclaude/storage'
import { ContainerIdentityError, verifyContainerIdentity, type ContainerIdentityRepo } from '../auth/containerIdentity.js'
import { setSecurityHeaders } from './util.js'

export { COMPACTION_TIMELINE_PATH }
export const COMPACTION_TIMELINE_PAGE_MAX_BYTES = 64 * 1024 * 1024

type Deps = {
  identityRepo: ContainerIdentityRepo
  readPage?: typeof readClientTimelinePage
  readTapePayload?: typeof readTapeRecordPayload
  readUserPayload?: typeof readUserMessagePayload
  maxResponseBytes?: number
}
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

async function hydrateOriginal(record: MessageLike, sessionId: string, owner: string, deps: Deps): Promise<MessageLike> {
  if (record._displayDegraded === true || record._displayDegradeReason !== undefined) {
    throw new Error('TIMELINE_ORIGINAL_UNAVAILABLE')
  }
  if (record._payloadDeferred !== true) return record
  if (typeof record.id !== 'string') throw new Error('DEFERRED_RECORD_ID')
  const read = (offset: number, length: number) => record._userPayloadDeferred === true
    ? (deps.readUserPayload ?? readUserMessagePayload)(sessionId, owner, record.id as string, offset, length)
    : typeof record._turnTapeId === 'string' && Number.isSafeInteger(record._recordOrdinal)
      ? (deps.readTapePayload ?? readTapeRecordPayload)(sessionId, owner, record._turnTapeId, record._recordOrdinal as number, offset, length)
      : Promise.resolve(null)
  const head = await read(0, 1)
  if (!head || head.offset !== 0 || head.msgId !== record.id || !Number.isSafeInteger(head.totalBytes) || head.totalBytes < 0 ||
      (typeof record._payloadBytes === 'number' && record._payloadBytes !== head.totalBytes) ||
      (typeof record._payloadSha256 === 'string' && head.contentSha256 !== record._payloadSha256) ||
      ('tapeSha256' in head && head.tapeSha256 !== record._turnTapeSha256)) {
    throw new Error('DEFERRED_RECORD_INTEGRITY')
  }
  if (head.totalBytes > (deps.maxResponseBytes ?? COMPACTION_TIMELINE_PAGE_MAX_BYTES)) {
    throw new Error('COMPACTION_TIMELINE_PAGE_TOO_LARGE')
  }
  const chunks: Buffer[] = []
  for (let offset = 0; offset < head.totalBytes;) {
    const length = Math.min(256 * 1024, head.totalBytes - offset)
    const part = await read(offset, length)
    if (!part || part.offset !== offset || part.payload.length === 0 || part.payload.length > length ||
        part.msgId !== head.msgId || part.role !== head.role || part.totalBytes !== head.totalBytes ||
        part.contentSha256 !== head.contentSha256 ||
        ('tapeSha256' in part && part.tapeSha256 !== record._turnTapeSha256)) throw new Error('DEFERRED_RECORD_INTEGRITY')
    chunks.push(part.payload)
    offset += part.payload.length
  }
  const payload = Buffer.concat(chunks)
  if (digest(payload) !== head.contentSha256) throw new Error('DEFERRED_RECORD_INTEGRITY')
  const original: unknown = JSON.parse(payload.toString('utf8'))
  if (!original || typeof original !== 'object' || Array.isArray(original) ||
      (original as MessageLike).id !== record.id) throw new Error('DEFERRED_RECORD_INVALID')
  // Retain the server's immutable ordering/locator metadata, restore every
  // original content field, and keep mutable billing overlays server-owned.
  return {
    ...record, ...original,
    ...(record.usage !== undefined ? { usage: record.usage } : {}),
    _seq: record._seq, _orderSeq: record._orderSeq,
    _turnTapeOrdinal: record._turnTapeOrdinal,
    _timelineUnitKey: record._timelineUnitKey,
    _payloadDeferred: false, _userPayloadDeferred: false,
  }
}

async function drain(res: ServerResponse): Promise<void> {
  if (res.destroyed) throw new Error('CLOSED')
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { res.off('drain', ready); res.off('close', closed); res.off('error', closed) }
    const ready = () => { cleanup(); resolve() }
    const closed = () => { cleanup(); reject(new Error('CLOSED')) }
    res.once('drain', ready); res.once('close', closed); res.once('error', closed)
  })
}

export function makeCompactionTimelineHandler(deps: Deps) {
  return async (req: IncomingMessage, res: ServerResponse, ctx: { hostUuid: string; boundIp: string }): Promise<void> => {
    setSecurityHeaders(res)
    res.setHeader('Cache-Control', 'no-store')
    const send = (status: number, code: string) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: { code } }))
    }
    if (req.method !== 'GET') return send(405, 'METHOD_NOT_ALLOWED')
    let owner: string
    try {
      const identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
      owner = `c:${identity.userId}`
    } catch (error) {
      if (error instanceof ContainerIdentityError) return send(401, 'UNAUTHORIZED')
      return send(503, 'IDENTITY_UNAVAILABLE')
    }
    const url = new URL(req.url ?? '/', 'http://internal')
    const keys = [...url.searchParams.keys()]
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const rawCursor = url.searchParams.get('cursor')
    const cursor = rawCursor === null ? null : decodeClientTimelineCursor(rawCursor)
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId) || keys.length !== new Set(keys).size ||
        keys.some(key => key !== 'sessionId' && key !== 'cursor') ||
        (rawCursor !== null && !cursor)) return send(400, 'INVALID_TIMELINE_INPUT')
    try {
      const maxBytes = deps.maxResponseBytes ?? COMPACTION_TIMELINE_PAGE_MAX_BYTES
      // Browser pages budget deferred locators, whereas this transport sends
      // full originals. Re-read a smaller genuine page from the SAME cursor;
      // only storage may choose its continuation, never a sliced message list.
      let limit = 200
      for (;;) {
        try {
          const page = await (deps.readPage ?? readClientTimelinePage)(sessionId, owner, cursor, limit)
          if (!page) return send(404, 'SESSION_NOT_FOUND')
          const messages: MessageLike[] = []
          let wireBytes = Buffer.byteLength(JSON.stringify({ ownerUserId: owner, sessionId, page: { ...page, messages: [] } }))
          for (const record of page.messages) {
            const original = await hydrateOriginal(record, sessionId, owner, deps)
            wireBytes += Buffer.byteLength(JSON.stringify(original)) + (messages.length > 0 ? 1 : 0)
            if (wireBytes > maxBytes) throw new Error('COMPACTION_TIMELINE_PAGE_TOO_LARGE')
            messages.push(original)
          }
          const bytes = Buffer.from(JSON.stringify({ ownerUserId: owner, sessionId, page: { ...page, messages } }))
          if (bytes.length > maxBytes) throw new Error('COMPACTION_TIMELINE_PAGE_TOO_LARGE')
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Content-Length', bytes.length)
          res.setHeader('X-OpenClaude-Content-Sha256', digest(bytes))
          for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
            if (res.destroyed) return
            if (!res.write(bytes.subarray(offset, offset + 256 * 1024))) await drain(res)
          }
          res.end()
          return
        } catch (error) {
          if (!(error instanceof Error && error.message === 'COMPACTION_TIMELINE_PAGE_TOO_LARGE') || limit === 1) throw error
          limit = Math.max(1, Math.floor(limit / 2))
        }
      }
    } catch (error) {
      if (res.headersSent) { res.destroy(); return }
      if (error instanceof Error && error.message === 'COMPACTION_TIMELINE_PAGE_TOO_LARGE') {
        return send(413, 'COMPACTION_TIMELINE_PAGE_TOO_LARGE')
      }
      send(error instanceof Error && error.name === 'ClientTimelineCursorStaleError' ? 409 : 503,
        error instanceof Error && error.name === 'ClientTimelineCursorStaleError'
          ? 'TIMELINE_CURSOR_STALE' : 'COMPACTION_TIMELINE_UNAVAILABLE')
    }
  }
}
