/**
 * Media studio access, blob tickets and ranged blob responses (OCV5-591 A1).
 *
 * Access (D13, 2026-10-23): off unless OC_STUDIO_ENABLED=1; then admins plus the uids in
 * OC_STUDIO_ALLOWED_UIDS. uid 4 is never let in through the list.
 *
 * Tickets let an <img>/<video> element fetch a blob without an Authorization header. A ticket is
 * an HMAC over {userId, sha, expiresAt} with its own domain tag, so a media-generation result
 * ticket can never be replayed here and vice versa.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { HttpError } from '../http/util.js'

export interface StudioAccessConfig {
  OC_STUDIO_ENABLED?: boolean
  OC_STUDIO_ALLOWED_UIDS?: readonly string[]
}

export interface StudioAccess {
  enabled: boolean
  allows(user: { id: string; role?: string }): boolean
}

export function studioAccess(
  cfg: StudioAccessConfig,
  warn: (msg: string, meta: Record<string, unknown>) => void = () => {},
): StudioAccess {
  const raw = cfg.OC_STUDIO_ALLOWED_UIDS ?? []
  const all = raw.length === 1 && raw[0] === 'all'
  const uids = new Set<string>()
  if (!all) {
    for (const uid of raw) {
      if (uid === '4') {
        warn('studio_allowlist_uid_ignored', { uid })
        continue
      }
      uids.add(uid)
    }
  }
  const enabled = cfg.OC_STUDIO_ENABLED === true
  return {
    enabled,
    allows: (user) => enabled && (user.role === 'admin' || all || uids.has(user.id)),
  }
}

export const BLOB_TICKET_TTL_SECONDS = 15 * 60
const TICKET_DOMAIN = 'openclaude-studio-blob'
const SHA_RE = /^[0-9a-f]{64}$/

type TicketPayload = { u: string; s: string; e: number }

function sign(secret: string | Uint8Array, payload: string): string {
  return createHmac('sha256', secret).update(`${TICKET_DOMAIN}:${payload}`).digest('base64url')
}

export function createBlobTicket(
  secret: string | Uint8Array,
  userId: string,
  sha: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  if (!SHA_RE.test(sha)) throw new Error('invalid blob sha')
  const payload = Buffer.from(
    JSON.stringify({ u: userId, s: sha, e: nowSeconds + BLOB_TICKET_TTL_SECONDS }),
  ).toString('base64url')
  return `${payload}.${sign(secret, payload)}`
}

/** Returns the ticket's user id, or throws 401. */
export function verifyBlobTicket(
  secret: string | Uint8Array,
  token: string,
  sha: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const invalid = () => new HttpError(401, 'INVALID_BLOB_TICKET', 'invalid blob ticket')
  if (token.length > 1024) throw invalid()
  const [payload, signature, extra] = token.split('.')
  if (!payload || !signature || extra !== undefined) throw invalid()
  const supplied = Buffer.from(signature, 'utf8')
  const expected = Buffer.from(sign(secret, payload), 'utf8')
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw invalid()
  let value: TicketPayload
  try {
    value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TicketPayload
  } catch {
    throw invalid()
  }
  if (
    typeof value.u !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(value.u) ||
    value.s !== sha ||
    !Number.isSafeInteger(value.e) ||
    value.e <= nowSeconds
  )
    throw invalid()
  return value.u
}

/** Parses a single `bytes=` range against a file size. null = whole file; throws 416. */
export function parseByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (header === undefined) return null
  const unsatisfiable = () => new HttpError(416, 'INVALID_RANGE', 'invalid byte range')
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (!match[1] && !match[2]) || size === 0) throw unsatisfiable()
  let start: number
  let end: number
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix === 0) throw unsatisfiable()
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size)
    throw unsatisfiable()
  return { start, end }
}

/** Streams a stored blob with Range support: 200, 206, or 416 with an unsatisfied Content-Range. */
export async function sendBlobFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: { path: string; bytes: number; mime: string; sha: string },
): Promise<void> {
  const info = await stat(file.path)
  if (!info.isFile() || info.size !== file.bytes)
    throw new HttpError(409, 'BLOB_INTEGRITY_FAILED', 'blob is unavailable')
  let range: { start: number; end: number } | null
  try {
    range = parseByteRange(
      typeof req.headers.range === 'string' ? req.headers.range : undefined,
      info.size,
    )
  } catch (err) {
    res.setHeader('Content-Range', `bytes */${info.size}`)
    throw err
  }
  const start = range?.start ?? 0
  const end = range?.end ?? info.size - 1
  res.statusCode = range ? 206 : 200
  if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`)
  res.setHeader('Content-Type', file.mime)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Length', String(info.size === 0 ? 0 : end - start + 1))
  res.setHeader('Cache-Control', 'private, max-age=86400, immutable')
  res.setHeader('ETag', `"${file.sha}"`)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (info.size === 0) {
    res.end()
    return
  }
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file.path, { start, end })
    stream.on('error', reject)
    res.on('close', () => {
      stream.destroy()
      resolve()
    })
    res.on('finish', resolve)
    stream.pipe(res)
  })
}
