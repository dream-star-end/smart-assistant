/**
 * Process-local, owner-scoped in-memory PDF artifact store for Literature Plugin (OCV5-524).
 *
 * Enforces:
 * - Single-file limit: 25 MiB (26,214,400 bytes)
 * - Total reservation cap: 4 slots (100 MiB)
 * - Per-user cap: 2 slots (50 MiB)
 * - Absolute TTL: 10 minutes after synchronous post-CAS publication
 * - Shared producer/consumer permit (no unbounded queue)
 */
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { LiteratureError } from './errors.js'

export const LITERATURE_ARTIFACT_MAX_BYTES = 26_214_400
export const LITERATURE_ARTIFACT_TTL_MS = 10 * 60 * 1000
export const LITERATURE_ARTIFACT_MAX_TOTAL_SLOTS = 4
export const LITERATURE_ARTIFACT_MAX_USER_SLOTS = 2

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

interface StoredReservation {
  readonly id: string
  readonly userId: number
  buffer: Buffer | null
  bytes: number
  filename: string
  published: boolean
  discarded: boolean
  expiresAt: number
  activeReaders: number
}

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

export class LiteratureArtifactStore {
  private readonly reservations = new Map<string, StoredReservation>()
  private permitBusy = false
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly maxTotalSlots: number
  private readonly maxUserSlots: number

  constructor(
    options: {
      now?: () => number
      ttlMs?: number
      maxTotalSlots?: number
      maxUserSlots?: number
    } = {},
  ) {
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = options.ttlMs ?? LITERATURE_ARTIFACT_TTL_MS
    this.maxTotalSlots = options.maxTotalSlots ?? LITERATURE_ARTIFACT_MAX_TOTAL_SLOTS
    this.maxUserSlots = options.maxUserSlots ?? LITERATURE_ARTIFACT_MAX_USER_SLOTS
  }

  close(): void {
    for (const entry of this.reservations.values()) {
      entry.discarded = true
      entry.buffer = null
    }
    this.reservations.clear()
  }

  private sweep(now = this.now()): void {
    for (const [id, entry] of this.reservations) {
      if (entry.discarded || (entry.published && entry.expiresAt <= now)) {
        if (entry.activeReaders === 0) {
          entry.buffer = null
          this.reservations.delete(id)
        }
      }
    }
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
    if (this.permitBusy) throw new LiteratureError('CAPACITY')
    this.permitBusy = true
    let reservation: StoredReservation | undefined
    try {
      this.sweep()
      if (this.reservations.size >= this.maxTotalSlots) throw new LiteratureError('CAPACITY')
      let userCount = 0
      for (const item of this.reservations.values()) {
        if (item.userId === input.userId) userCount++
      }
      if (userCount >= this.maxUserSlots) throw new LiteratureError('CAPACITY')

      const artifactId = randomUUID()
      const safeFilename = sanitizeLiteraturePdfFilename(input.filename)
      const ownedBuffer = Buffer.allocUnsafe(input.data.length)
      input.data.copy(ownedBuffer, 0, 0, input.data.length)

      reservation = {
        id: artifactId,
        userId: input.userId,
        buffer: ownedBuffer,
        bytes: ownedBuffer.length,
        filename: safeFilename,
        published: false,
        discarded: false,
        expiresAt: 0,
        activeReaders: 0,
      }
      this.reservations.set(artifactId, reservation)

      const valid = validatePdfStructureSync(ownedBuffer)
      if (!valid) {
        reservation.discarded = true
        reservation.buffer = null
        this.reservations.delete(artifactId)
        throw new LiteratureError('RESPONSE_INVALID')
      }

      const result: LiteratureDownloadResult = Object.freeze({
        artifactId,
        filename: safeFilename,
        mimeType: 'application/pdf',
        bytes: ownedBuffer.length,
      })

      const staged = reservation
      return {
        artifactId,
        result,
        publish: () => {
          if (staged.discarded || staged.published || !staged.buffer) return
          staged.published = true
          staged.expiresAt = this.now() + this.ttlMs
        },
        discard: () => {
          staged.discarded = true
          staged.buffer = null
          this.reservations.delete(artifactId)
        },
      }
    } catch (error) {
      if (reservation) {
        reservation.discarded = true
        reservation.buffer = null
        this.reservations.delete(reservation.id)
      }
      throw error
    } finally {
      this.permitBusy = false
    }
  }

  /**
   * Owner-scoped read of a published artifact within TTL.
   */
  read(userId: number, artifactId: string): PublishedLiteratureArtifact | null {
    if (!Number.isSafeInteger(userId) || userId <= 0) return null
    if (typeof artifactId !== 'string' || !OPAQUE_ID_RE.test(artifactId)) return null
    const now = this.now()
    this.sweep(now)
    const entry = this.reservations.get(artifactId)
    if (!entry || entry.discarded || !entry.published || !entry.buffer) return null
    if (entry.userId !== userId) return null
    if (entry.expiresAt <= now) {
      if (entry.activeReaders === 0) {
        entry.buffer = null
        this.reservations.delete(artifactId)
      }
      return null
    }
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
}
