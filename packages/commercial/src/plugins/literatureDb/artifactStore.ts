/**
 * Process-local, owner-scoped in-memory PDF artifact store for Literature Plugin (OCV5-524).
 *
 * Budget (OCV5-585; was 2 slots per user / 4 per process regardless of size):
 * - Single-file limit: 25 MiB (26,214,400 bytes)
 * - Real-byte budgets: 160 MiB per process, 80 MiB and 16 files per user, 128 files per process
 * - Absolute TTL: 30 minutes after synchronous post-CAS publication (refreshed on reuse)
 * - When a new PDF does not fit, files the owner already saved (successful owner GET) are evicted
 *   first, then the same user's own oldest unsaved file. Another user's unsaved file is never
 *   evicted; if nothing evictable remains the stage fails with LITERATURE_ARTIFACT_CAPACITY.
 * - The same owner + reuse key (account instance + paper) reuses the verified file instead of
 *   downloading it again and taking more budget.
 * - Shared producer/consumer permit (no unbounded queue)
 *
 * Files live in this process only: a restart or a request served by another slot does not see
 * them, and the owner is told to download again.
 */
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { LiteratureError } from './errors.js'
import type { LiteratureArtifactEvent } from './observability.js'

export const LITERATURE_ARTIFACT_MAX_BYTES = 26_214_400
export const LITERATURE_ARTIFACT_TTL_MS = 30 * 60 * 1000
export const LITERATURE_ARTIFACT_MAX_TOTAL_BYTES = 160 * 1024 * 1024
export const LITERATURE_ARTIFACT_MAX_USER_BYTES = 80 * 1024 * 1024
export const LITERATURE_ARTIFACT_MAX_USER_FILES = 16
export const LITERATURE_ARTIFACT_MAX_TOTAL_FILES = 128

const OPAQUE_ID_RE = /^[A-Za-z0-9-]{16,128}$/

/**
 * Rejects dangerous executable/script/external-launch dictionary entries in PDF objects.
 */
const DANGEROUS_PDF_TOKEN_RE = /\/(?:JS|JavaScript|Launch)(?![A-Za-z])/

export interface LiteratureDownloadResult {
  readonly artifactId: string
  readonly filename: string
  readonly mimeType: 'application/pdf'
  readonly bytes: number
}

export interface StagedLiteratureArtifact {
  readonly artifactId: string
  readonly result: LiteratureDownloadResult
  /** True when an earlier verified file of the same paper was handed out again. */
  readonly reused: boolean
  /** Expiry the file gets (or got) on publish(); 0 before publication of a fresh stage. */
  readonly expiresAt: number
  publish(): void
  discard(): void
}

export interface PublishedLiteratureArtifact {
  readonly artifactId: string
  readonly userId: number
  readonly filename: string
  readonly mimeType: 'application/pdf'
  readonly bytes: number
  readonly data: Buffer
  readonly expiresAt: number
}

export interface LiteratureArtifactMeta {
  readonly filename: string
  readonly bytes: number
  readonly expiresAt: number
  /** The owner already fetched the file once (it is evicted first under pressure). */
  readonly saved: boolean
}

interface StoredReservation {
  readonly id: string
  readonly userId: number
  readonly reuseKey: string | null
  readonly createdAt: number
  buffer: Buffer | null
  bytes: number
  filename: string
  published: boolean
  discarded: boolean
  expiresAt: number
  savedAt: number | null
  activeReaders: number
  /** Reuse handles waiting for the account commit; pinned files are never evicted or swept. */
  pins: number
  pinnedUntil: number
}

/** Upper bound on a reuse pin (the download action times out at 120 s) so a lost handle cannot hold memory forever. */
const REUSE_PIN_MAX_MS = 5 * 60 * 1000

export function sanitizeLiteraturePdfFilename(raw: string): string {
  const cleaned = raw
    .replace(/[\p{Cc}/\\:*?"<>|]+/gu, '_')
    .replace(/\s+/g, ' ')
    .trim()
  const base = cleaned.replace(/\.pdf$/i, '').trim() || 'literature-document'
  const truncated = Array.from(base).slice(0, 200).join('')
  return `${truncated}.pdf`
}

function normalizePdfNames(text: string): string {
  return text.replace(/\/[^\s()<>\[\]{}/%]+/g, (nameToken) =>
    nameToken.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    ),
  )
}

/**
 * Lightweight 4-item PDF validation for official publisher downloads:
 * 1) Size within [64B, 25MiB]
 * 2) %PDF-1.x / %PDF-2.x magic in first 1024B and not an HTML error page
 * 3) %%EOF marker in last 64KiB (rejects truncated transfers)
 * 4) No dangerous executable actions (/JS, /JavaScript, /Launch) in object/trailer dictionaries
 */
export function validatePdfStructureSync(data: Buffer): boolean {
  if (!Buffer.isBuffer(data) || data.length < 64 || data.length > LITERATURE_ARTIFACT_MAX_BYTES)
    return false
  const head = data.subarray(0, Math.min(data.length, 1024)).toString('latin1')
  if (!/%PDF-[12]\.\d/.test(head)) return false
  if (/<(?:!doctype|html|head|body|script|iframe)\b/i.test(head)) return false

  const tailLen = Math.min(data.length, 65536)
  const tail = data.subarray(data.length - tailLen).toString('latin1')
  if (!tail.includes('%%EOF')) return false
  for (const tm of tail.matchAll(/\btrailer(?:\s|<<)([\s\S]*?)(?:\bstartxref\b|%%EOF|$)/g)) {
    if (tm[1] && DANGEROUS_PDF_TOKEN_RE.test(normalizePdfNames(tm[1]))) return false
  }

  const fullStr = data.toString('latin1')
  const allObjRe = /\b\d+\s+\d+\s+obj\b([\s\S]*?)\bendobj\b/g
  let om: RegExpExecArray | null
  let hasObject = false
  while ((om = allObjRe.exec(fullStr)) !== null) {
    hasObject = true
    const fullBody = om[1]!
    const streamMatch = /(?:^|[^A-Za-z0-9_/])(stream[\r\n])/.exec(fullBody)
    const dictOnly = normalizePdfNames(
      streamMatch?.[1]
        ? fullBody.slice(0, streamMatch.index + streamMatch[0].length - streamMatch[1].length)
        : fullBody,
    )
    if (DANGEROUS_PDF_TOKEN_RE.test(dictOnly)) return false
    if (/\/Type\s*\/ObjStm(?![A-Za-z])/.test(dictOnly)) {
      const streamIdx = fullBody.indexOf('stream')
      const endstreamIdx = fullBody.lastIndexOf('endstream')
      if (streamIdx < 0 || endstreamIdx <= streamIdx) return false
      let rawPos = om.index + om[0].indexOf('stream') + 6
      if (data[rawPos] === 13 && data[rawPos + 1] === 10) rawPos += 2
      else if (data[rawPos] === 10 || data[rawPos] === 13) rawPos += 1
      let rawEnd = om.index + om[0].lastIndexOf('endstream')
      while (rawEnd > rawPos && (data[rawEnd - 1] === 10 || data[rawEnd - 1] === 13)) {
        rawEnd--
      }
      if (rawEnd <= rawPos) return false
      const rawSlice = data.subarray(rawPos, rawEnd)
      if (!/\/Filter\b/.test(dictOnly)) {
        if (DANGEROUS_PDF_TOKEN_RE.test(normalizePdfNames(rawSlice.toString('latin1')))) {
          return false
        }
      } else {
        try {
          const inflated = zlib.inflateSync(rawSlice, {
            maxOutputLength: 8 * 1024 * 1024,
          })
          if (DANGEROUS_PDF_TOKEN_RE.test(normalizePdfNames(inflated.toString('latin1')))) {
            return false
          }
        } catch {
          return false
        }
      }
    }
  }
  return hasObject
}

export async function validatePdfInIsolatedWorker(
  data: Buffer,
  signal: AbortSignal,
  _timeoutMs = 5_000,
): Promise<boolean> {
  if (signal.aborted) throw new LiteratureError('CANCELLED')
  return validatePdfStructureSync(data)
}

export interface LiteratureArtifactStoreOptions {
  now?: () => number
  ttlMs?: number
  maxTotalBytes?: number
  maxUserBytes?: number
  maxUserFiles?: number
  maxTotalFiles?: number
  /** Lifecycle events for observability; must not throw (errors are swallowed). */
  onEvent?: (event: LiteratureArtifactEvent) => void
}

export class LiteratureArtifactStore {
  private readonly reservations = new Map<string, StoredReservation>()
  private permitBusy = false
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly maxTotalBytes: number
  private readonly maxUserBytes: number
  private readonly maxUserFiles: number
  private readonly maxTotalFiles: number
  private readonly onEvent: ((event: LiteratureArtifactEvent) => void) | undefined

  constructor(options: LiteratureArtifactStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = options.ttlMs ?? LITERATURE_ARTIFACT_TTL_MS
    this.maxTotalBytes = options.maxTotalBytes ?? LITERATURE_ARTIFACT_MAX_TOTAL_BYTES
    this.maxUserBytes = options.maxUserBytes ?? LITERATURE_ARTIFACT_MAX_USER_BYTES
    this.maxUserFiles = options.maxUserFiles ?? LITERATURE_ARTIFACT_MAX_USER_FILES
    this.maxTotalFiles = options.maxTotalFiles ?? LITERATURE_ARTIFACT_MAX_TOTAL_FILES
    this.onEvent = options.onEvent
  }

  close(): void {
    for (const entry of this.reservations.values()) {
      entry.discarded = true
      entry.buffer = null
    }
    this.reservations.clear()
  }

  private emit(event: LiteratureArtifactEvent): void {
    try {
      this.onEvent?.(event)
    } catch {
      // Observability must never fail a download or a save.
    }
  }

  private drop(entry: StoredReservation): void {
    entry.discarded = true
    entry.buffer = null
    this.reservations.delete(entry.id)
  }

  private pinned(entry: StoredReservation, now = this.now()): boolean {
    return entry.pins > 0 && now < entry.pinnedUntil
  }

  private sweep(now = this.now()): void {
    for (const entry of this.reservations.values()) {
      if (entry.activeReaders !== 0 || this.pinned(entry, now)) continue
      if (entry.discarded) {
        this.drop(entry)
      } else if (entry.published && entry.expiresAt <= now) {
        this.emit({
          event: 'expire',
          reason: entry.savedAt === null ? 'unsaved' : 'saved',
          uid: entry.userId,
        })
        this.drop(entry)
      }
    }
  }

  /**
   * Victims that make room for `bytes` more for `userId`, or null when the budget cannot be met
   * without touching another user's unsaved file or an unpublished stage.
   */
  private planEviction(userId: number, bytes: number): StoredReservation[] | null {
    const now = this.now()
    const live = [...this.reservations.values()].filter((e) => !e.discarded)
    let userBytes = 0
    let userFiles = 0
    let totalBytes = 0
    let totalFiles = 0
    for (const e of live) {
      totalBytes += e.bytes
      totalFiles++
      if (e.userId === userId) {
        userBytes += e.bytes
        userFiles++
      }
    }
    const bySaved = (a: StoredReservation, b: StoredReservation) => a.savedAt! - b.savedAt!
    const byCreated = (a: StoredReservation, b: StoredReservation) => a.createdAt - b.createdAt
    const published = live.filter((e) => e.published && !this.pinned(e, now))
    const anySaved = published.filter((e) => e.savedAt !== null).sort(bySaved)
    const ownSaved = anySaved.filter((e) => e.userId === userId)
    const ownUnsaved = published
      .filter((e) => e.userId === userId && e.savedAt === null)
      .sort(byCreated)
    const victims = new Set<StoredReservation>()
    const take = (queue: StoredReservation[]): boolean => {
      const next = queue.find((e) => !victims.has(e))
      if (!next) return false
      victims.add(next)
      totalBytes -= next.bytes
      totalFiles--
      if (next.userId === userId) {
        userBytes -= next.bytes
        userFiles--
      }
      return true
    }
    const userQueue = [...ownSaved, ...ownUnsaved]
    while (userBytes + bytes > this.maxUserBytes || userFiles + 1 > this.maxUserFiles) {
      if (!take(userQueue)) return null
    }
    const totalQueue = [...anySaved, ...ownUnsaved]
    while (totalBytes + bytes > this.maxTotalBytes || totalFiles + 1 > this.maxTotalFiles) {
      if (!take(totalQueue)) return null
    }
    return [...victims]
  }

  /**
   * Stages a PDF buffer under a reservation slot before DB Cookie CAS.
   * Only calling publish() after CAS makes the artifact visible to owner GET.
   */
  async stagePdf(input: {
    userId: number
    filename: string
    data: Buffer
    signal: AbortSignal
    /** Owner-private key of the paper (account instance + paper id); enables reuse(). */
    reuseKey?: string
    skipWorker?: boolean
  }): Promise<StagedLiteratureArtifact> {
    if (!Number.isSafeInteger(input.userId) || input.userId <= 0)
      throw new LiteratureError('INVALID_INPUT')
    if (input.signal.aborted) throw new LiteratureError('CANCELLED')
    if (
      !Buffer.isBuffer(input.data) ||
      input.data.length < 1 ||
      input.data.length > LITERATURE_ARTIFACT_MAX_BYTES
    )
      throw new LiteratureError('RESPONSE_INVALID')
    if (this.permitBusy) throw new LiteratureError('LITERATURE_ARTIFACT_CAPACITY')
    this.permitBusy = true
    try {
      const now = this.now()
      this.sweep(now)
      const ownedBuffer = Buffer.allocUnsafe(input.data.length)
      input.data.copy(ownedBuffer, 0, 0, input.data.length)
      // Validate before evicting anything: an invalid upstream body must not cost other files.
      if (!validatePdfStructureSync(ownedBuffer)) throw new LiteratureError('RESPONSE_INVALID')

      const victims = this.planEviction(input.userId, ownedBuffer.length)
      if (!victims) throw new LiteratureError('LITERATURE_ARTIFACT_CAPACITY')
      for (const victim of victims) {
        this.emit({
          event: 'evict',
          reason: victim.savedAt === null ? 'own_unsaved' : 'saved',
          uid: victim.userId,
          ageMs: now - victim.createdAt,
        })
        this.drop(victim)
      }

      const artifactId = randomUUID()
      const safeFilename = sanitizeLiteraturePdfFilename(input.filename)
      const reservation: StoredReservation = {
        id: artifactId,
        userId: input.userId,
        reuseKey: input.reuseKey ?? null,
        createdAt: now,
        buffer: ownedBuffer,
        bytes: ownedBuffer.length,
        filename: safeFilename,
        published: false,
        discarded: false,
        expiresAt: 0,
        savedAt: null,
        activeReaders: 0,
        pins: 0,
        pinnedUntil: 0,
      }
      this.reservations.set(artifactId, reservation)

      const result: LiteratureDownloadResult = Object.freeze({
        artifactId,
        filename: safeFilename,
        mimeType: 'application/pdf',
        bytes: ownedBuffer.length,
      })
      return {
        artifactId,
        result,
        reused: false,
        get expiresAt() {
          return reservation.expiresAt
        },
        publish: () => {
          if (reservation.discarded || reservation.published || !reservation.buffer) return
          reservation.published = true
          reservation.expiresAt = this.now() + this.ttlMs
        },
        discard: () => {
          if (!reservation.published) this.drop(reservation)
        },
      }
    } finally {
      this.permitBusy = false
    }
  }

  /**
   * Hands out the owner's already verified, unexpired file for the same paper again. publish()
   * refreshes its expiry and offers it as unsaved; discard() leaves the earlier file untouched.
   */
  reuse(userId: number, reuseKey: string): StagedLiteratureArtifact | null {
    if (!Number.isSafeInteger(userId) || userId <= 0 || !reuseKey) return null
    const now = this.now()
    this.sweep(now)
    let found: StoredReservation | undefined
    for (const entry of this.reservations.values()) {
      if (
        entry.userId === userId &&
        entry.reuseKey === reuseKey &&
        entry.published &&
        !entry.discarded &&
        entry.buffer &&
        entry.expiresAt > now &&
        (!found || entry.createdAt > found.createdAt)
      )
        found = entry
    }
    if (!found) return null
    const entry = found
    const planned = now + this.ttlMs
    let published = false
    let settled = false
    // Pin until publish()/discard(): another user's stage or a sweep must not drop the file while
    // the runtime is still committing the account state, or a success would point at nothing.
    entry.pins++
    entry.pinnedUntil = Math.max(entry.pinnedUntil, now + REUSE_PIN_MAX_MS)
    const unpin = () => {
      if (settled) return
      settled = true
      entry.pins = Math.max(0, entry.pins - 1)
    }
    return {
      artifactId: entry.id,
      result: Object.freeze({
        artifactId: entry.id,
        filename: entry.filename,
        mimeType: 'application/pdf',
        bytes: entry.bytes,
      }),
      reused: true,
      get expiresAt() {
        return published ? entry.expiresAt : planned
      },
      publish: () => {
        if (settled) return
        unpin()
        if (entry.discarded || !entry.buffer) return
        published = true
        entry.expiresAt = Math.max(entry.expiresAt, this.now() + this.ttlMs)
        entry.savedAt = null
        this.emit({ event: 'reuse', uid: entry.userId, ageMs: this.now() - entry.createdAt })
      },
      // Leaves the earlier published file in place; only releases the pin.
      discard: unpin,
    }
  }

  private ownedLive(userId: number, artifactId: string, now: number): StoredReservation | null {
    if (!Number.isSafeInteger(userId) || userId <= 0) return null
    if (typeof artifactId !== 'string' || !OPAQUE_ID_RE.test(artifactId)) return null
    this.sweep(now)
    const entry = this.reservations.get(artifactId)
    if (!entry || entry.discarded || !entry.published || !entry.buffer) return null
    if (entry.userId !== userId || entry.expiresAt <= now) return null
    return entry
  }

  /**
   * Owner-scoped read of a published artifact within TTL. A successful read marks the file as
   * saved, which makes it the first candidate when room is needed.
   */
  read(userId: number, artifactId: string): PublishedLiteratureArtifact | null {
    const now = this.now()
    const entry = this.ownedLive(userId, artifactId, now)
    if (!entry || !entry.buffer) {
      if (Number.isSafeInteger(userId) && userId > 0 && OPAQUE_ID_RE.test(String(artifactId)))
        this.emit({ event: 'get', outcome: 'not_found', uid: userId })
      return null
    }
    if (entry.savedAt === null) entry.savedAt = now
    this.emit({
      event: 'get',
      outcome: 'ok',
      uid: userId,
      ageMs: now - entry.createdAt,
      bytes: entry.bytes,
    })
    return {
      artifactId: entry.id,
      userId: entry.userId,
      filename: entry.filename,
      mimeType: 'application/pdf',
      bytes: entry.bytes,
      data: entry.buffer,
      expiresAt: entry.expiresAt,
    }
  }

  /** Owner-scoped metadata for the save card; never marks the file as saved. */
  describe(userId: number, artifactId: string): LiteratureArtifactMeta | null {
    const entry = this.ownedLive(userId, artifactId, this.now())
    if (!entry) return null
    return {
      filename: entry.filename,
      bytes: entry.bytes,
      expiresAt: entry.expiresAt,
      saved: entry.savedAt !== null,
    }
  }
}
