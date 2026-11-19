import { createHmac } from 'node:crypto'
import { Transform } from 'node:stream'

export const MAX_CODEX_MODELS_CACHE_ENTRIES = 64
export const MAX_CODEX_MODELS_CACHE_BYTES = 4 * 1024 * 1024
export const CODEX_MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000

const CLIENT_VERSION_RE = /^[A-Za-z0-9._-]{1,64}$/
const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/

function parseClientVersionSegment(search: string): string | null {
  if (!search) return 'missing'
  let versions: string[]
  try {
    versions = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).getAll('client_version')
  } catch {
    return null
  }
  if (versions.length === 0) return 'missing'
  if (versions.length > 1) return null
  const v = versions[0] ?? ''
  if (!CLIENT_VERSION_RE.test(v)) return null
  return `v:${v}`
}

/**
 * Builds a strict cache key binding verified upstream auth credential digest, workspace,
 * bound DB account (if any), and normalized client_version. Returns null whenever identity
 * or version parameters are missing, malformed, or ambiguous (fail-closed passthrough).
 */
export function buildCodexModelsCacheKey(opts: {
  hmacKey: Buffer
  authHeader: string | null | undefined
  workspaceId?: string | null
  accountId?: bigint | string | null
  usedFallbackToken?: boolean
  search: string
}): string | null {
  const versionSeg = parseClientVersionSegment(opts.search)
  if (!versionSeg) return null
  const auth = typeof opts.authHeader === 'string' ? opts.authHeader.trim() : ''
  if (!auth) return null
  const wsRaw = typeof opts.workspaceId === 'string' ? opts.workspaceId.trim() : ''
  if (wsRaw && !WORKSPACE_ID_RE.test(wsRaw)) return null
  const accStr = opts.accountId !== null && opts.accountId !== undefined ? String(opts.accountId).trim() : ''
  if (!accStr) return null
  const authDigest = createHmac('sha256', opts.hmacKey).update(auth, 'utf8').digest('hex')
  const wsDigest = createHmac('sha256', opts.hmacKey).update(wsRaw, 'utf8').digest('hex').slice(0, 24)
  const provenance = opts.usedFallbackToken ? 'fb' : 'ctr'
  return `${provenance}:${accStr}:${authDigest}:${wsDigest}:${versionSeg}`
}

interface CacheEntry {
  body: Buffer
  storedAtMs: number
}

function isValidModelsCatalogPayload(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const models = (parsed as { models?: unknown }).models
  if (!Array.isArray(models) || models.length === 0) return false
  let hasUsableSlug = false
  for (const item of models) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const slug = (item as { slug?: unknown }).slug
    if (typeof slug === 'string' && slug.trim().length > 0) hasUsableSlug = true
  }
  return hasUsableSlug
}

/**
 * Bounded LRU + TTL cache holding the last structurally valid upstream 200 `/backend-api/codex/models`
 * JSON payload per verified identity/workspace/client_version.
 */
export class CodexModelsFallbackCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly maxEntries: number
  private readonly maxBodyBytes: number
  private readonly ttlMs: number

  constructor(opts?: { maxEntries?: number; maxBodyBytes?: number; ttlMs?: number }) {
    this.maxEntries = opts?.maxEntries ?? MAX_CODEX_MODELS_CACHE_ENTRIES
    this.maxBodyBytes = opts?.maxBodyBytes ?? MAX_CODEX_MODELS_CACHE_BYTES
    this.ttlMs = opts?.ttlMs ?? CODEX_MODELS_CACHE_TTL_MS
  }

  get size(): number {
    return this.entries.size
  }

  putIfValid(key: string | null, body: Buffer, nowMs = Date.now()): boolean {
    if (!key || body.byteLength === 0 || body.byteLength > this.maxBodyBytes) return false
    let parsed: unknown
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      return false
    }
    if (!isValidModelsCatalogPayload(parsed)) return false
    const copy = Buffer.from(body)
    this.entries.delete(key)
    this.entries.set(key, { body: copy, storedAtMs: nowMs })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    return true
  }

  get(key: string | null, nowMs = Date.now()): Buffer | null {
    if (!key) return null
    const entry = this.entries.get(key)
    if (!entry) return null
    if (nowMs - entry.storedAtMs > this.ttlMs) {
      this.entries.delete(key)
      return null
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.body
  }
}

/**
 * Pass-through Transform that buffers up to `maxBytes` for cache population on normal EOF.
 * Downstream bytes are always forwarded unchanged even if the payload exceeds `maxBytes`.
 */
export function createModelsCacheTap(
  maxBytes: number,
  onComplete: (body: Buffer) => void,
): Transform {
  let chunks: Buffer[] = []
  let size = 0
  let overflow = false
  return new Transform({
    transform(chunk: Buffer | Uint8Array | string, _encoding, callback) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (!overflow) {
        size += buf.length
        if (size > maxBytes) {
          overflow = true
          chunks = []
        } else if (buf.length > 0) {
          chunks.push(Buffer.from(buf))
        }
      }
      callback(null, chunk)
    },
    flush(callback) {
      try {
        if (!overflow && size > 0) {
          onComplete(Buffer.concat(chunks))
        }
      } catch {
        /* cache population failure must never fail downstream delivery */
      } finally {
        chunks = []
      }
      callback()
    },
  })
}
