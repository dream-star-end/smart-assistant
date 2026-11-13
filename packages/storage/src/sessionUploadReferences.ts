/** Complete, bounded message reads for upload garbage collection. No SQL lives here. */
import { createHash } from 'node:crypto'
import type { MessageLike } from './sessionsDb.js'

export const UPLOAD_REFERENCE_MAX_BYTES = 64 * 1024 * 1024
export const UPLOAD_REFERENCE_MAX_ROWS = 10000
export const UPLOAD_REFERENCE_MAX_MS = 30000
export type UploadReferenceOptions = {
  userId: string | null
  sinceMs: number
  sessionsDb?: string
  maxBytes?: number
  maxRows?: number
  maxMs?: number
}
export type UploadReferenceRow = { sessionId: string; userId: string; messages: string | null }
export type UploadReferenceHydrator = (row: UploadReferenceRow, messages: MessageLike[], bytes: number, ms: number) => Promise<MessageLike[]>

function bounded(value: number | undefined, cap: number): number {
  if (value === undefined) return cap
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid upload reference budget')
  return Math.min(cap, value)
}
function unresolved(message: MessageLike): boolean {
  return message._payloadDeferred === true || message._userPayloadDeferred === true ||
    ((message._turnTapeId !== undefined || message._turnTapeSha256 !== undefined) && message._turnTapeExpanded !== true)
}
export async function scanUploadReferenceRows(
  rows: Iterable<UploadReferenceRow> | AsyncIterable<UploadReferenceRow>,
  visit: (body: string) => void,
  opts: UploadReferenceOptions,
  hydrate?: UploadReferenceHydrator,
): Promise<boolean> {
  try {
    let bytes = bounded(opts.maxBytes, UPLOAD_REFERENCE_MAX_BYTES)
    const maxRows = bounded(opts.maxRows, UPLOAD_REFERENCE_MAX_ROWS)
    const deadline = Date.now() + bounded(opts.maxMs, UPLOAD_REFERENCE_MAX_MS)
    let count = 0
    for await (const row of rows) {
      if (++count > maxRows || Date.now() >= deadline || typeof row.messages !== 'string') return false
      bytes -= Buffer.byteLength(row.messages)
      if (bytes <= 0) return false
      const parsed: unknown = JSON.parse(row.messages)
      if (!Array.isArray(parsed) || parsed.some(m => !m || typeof m !== 'object' || Array.isArray(m))) return false
      const messages = parsed as MessageLike[]
      for (const message of messages) {
        const hasTape = message._turnTapeId !== undefined || message._turnTapeSha256 !== undefined
        if (hasTape && (typeof message._turnTapeId !== 'string' || typeof message._turnTapeSha256 !== 'string' || message._turnTapeComplete !== true)) return false
      }
      const exact = hydrate ? await hydrate(row, messages, bytes, deadline - Date.now()) : messages
      if (exact.some(unresolved)) return false
      const body = JSON.stringify(exact)
      bytes -= Buffer.byteLength(body)
      if (bytes <= 0 || Date.now() >= deadline) return false
      visit(row.messages)
      visit(body)
    }
    return Date.now() < deadline
  } catch {
    return false
  }
}

export type UploadDeferredPayload = {
  payload: Buffer; totalBytes: number; offset: number; msgId: string; role: 'user'; contentSha256: string
}
export async function hydrateUploadReferenceMessages(
  messages: MessageLike[],
  maxBytes: number,
  readers: {
    tapeBytes: (ids: string[]) => Promise<number[]>
    tapes: (messages: MessageLike[], bytes: number) => Promise<MessageLike[]>
    user: (id: string, bytes: number) => Promise<UploadDeferredPayload | null>
  },
): Promise<MessageLike[]> {
  const ids = [...new Set(messages.flatMap(m => typeof m._turnTapeId === 'string' ? [m._turnTapeId] : []))]
  if (ids.length) {
    const sizes = await readers.tapeBytes(ids)
    if (sizes.length !== ids.length || sizes.some(n => !Number.isSafeInteger(n) || n <= 0) || sizes.reduce((a, b) => a + b, 0) >= maxBytes) {
      throw new Error('upload reference tape budget or metadata incomplete')
    }
  }
  const exact = ids.length ? await readers.tapes(messages, maxBytes) : messages
  let remaining = maxBytes - Buffer.byteLength(JSON.stringify(exact))
  const result: MessageLike[] = []
  for (const message of exact) {
    if (message._userPayloadDeferred !== true) { result.push(message); continue }
    if (typeof message.id !== 'string' || remaining <= 0) throw new Error('upload reference user anchor invalid')
    const payload = await readers.user(message.id, remaining + 1)
    if (!payload || payload.offset !== 0 || payload.totalBytes !== payload.payload.length || payload.totalBytes >= remaining ||
      payload.msgId !== message.id || payload.role !== 'user' ||
      createHash('sha256').update(payload.payload).digest('hex') !== payload.contentSha256 ||
      (typeof message._payloadSha256 === 'string' && message._payloadSha256 !== payload.contentSha256)) {
      throw new Error('upload reference user payload incomplete')
    }
    const full: unknown = JSON.parse(payload.payload.toString('utf8'))
    if (!full || typeof full !== 'object' || Array.isArray(full) ||
      (full as MessageLike).id !== message.id || (full as MessageLike).role !== 'user') throw new Error('upload reference user identity invalid')
    remaining -= payload.payload.length
    result.push(full as MessageLike)
  }
  return result
}
