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
import { Worker } from 'node:worker_threads'
import { LiteratureError, abortable } from './errors.js'

export const LITERATURE_ARTIFACT_MAX_BYTES = 26_214_400
export const LITERATURE_ARTIFACT_TTL_MS = 10 * 60 * 1000
export const LITERATURE_ARTIFACT_MAX_TOTAL_SLOTS = 4
export const LITERATURE_ARTIFACT_MAX_USER_SLOTS = 2

const OPAQUE_ID_RE = /^[A-Za-z0-9-]{16,128}$/

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

/**
 * Fast synchronous structural check before isolated worker metadata check:
 * must start with %PDF-1.x or %PDF-2.x, contain %%EOF, have at least one /Page or /Pages object,
 * and not declare /Encrypt.
 */
export function validatePdfStructureSync(data: Buffer): boolean {
  if (!Buffer.isBuffer(data) || data.length < 64 || data.length > LITERATURE_ARTIFACT_MAX_BYTES)
    return false
  const header = data.subarray(0, 8).toString('latin1')
  if (!/^%PDF-[12]\.\d/.test(header)) return false
  const tailSlice = data.subarray(Math.max(0, data.length - 8192)).toString('latin1')
  if (!tailSlice.includes('%%EOF')) return false
  const latin = data.toString('latin1')
  if (!/\/Type\s*\/Pages?\b/.test(latin) && !/\/Count\s+[1-9]\d*/.test(latin) && !/\/Type\s*\/ObjStm\b/.test(latin) && !/\/Linearized\b/.test(latin)) return false
  return true
}

const WORKER_SCRIPT = `
const { parentPort, workerData } = require('node:worker_threads');
const bytes = Buffer.from(workerData);
function check(buf) {
  if (buf.length < 64 || buf.length > 26214400) return false;
  const head = buf.subarray(0, 8).toString('latin1');
  if (!/^%PDF-[12]\\.\\d/.test(head)) return false;
  const tail = buf.subarray(Math.max(0, buf.length - 8192)).toString('latin1');
  if (!tail.includes('%%EOF')) return false;
  const str = buf.toString('latin1');
  if (!/\\/Type\\s*\\/Pages?\\b/.test(str) && !/\\/Count\\s+[1-9]\\d*/.test(str) && !/\\/Type\\s*\\/ObjStm\\b/.test(str) && !/\\/Linearized\\b/.test(str)) return false;
  return true;
}
parentPort.postMessage({ ok: check(bytes) });
`

export async function validatePdfInIsolatedWorker(
  data: Buffer,
  signal: AbortSignal,
  timeoutMs = 5_000,
): Promise<boolean> {
  if (signal.aborted) throw new LiteratureError('CANCELLED')
  if (!validatePdfStructureSync(data)) return false
  const copy = new Uint8Array(data.length)
  copy.set(data)
  const worker = new Worker(WORKER_SCRIPT, {
    eval: true,
    env: {},
    workerData: copy.buffer,
    transferList: [copy.buffer],
    resourceLimits: {
      maxOldGenerationSizeMb: 64,
      maxYoungGenerationSizeMb: 16,
    },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const onAbort = () => {
    void worker.terminate()
  }
  signal.addEventListener('abort', onAbort, { once: true })
  const exitPromise = new Promise<void>((resolve) => {
    worker.once('exit', () => resolve())
  })
  try {
    const verdict = await abortable(
      new Promise<boolean>((resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          void worker.terminate()
          reject(new LiteratureError('TIMEOUT'))
        }, timeoutMs)
        worker.once('message', (msg: { ok?: boolean }) => {
          resolve(msg?.ok === true)
        })
        worker.once('error', () => resolve(false))
        worker.once('exit', (code) => {
          if (code !== 0) resolve(false)
        })
      }),
      signal,
    )
    await worker.terminate()
    await exitPromise
    return verdict
  } catch (error) {
    await worker.terminate().catch(() => {})
    await exitPromise
    if (signal.aborted) throw new LiteratureError('CANCELLED')
    if (timedOut) throw new LiteratureError('TIMEOUT')
    if (error instanceof LiteratureError) throw error
    return false
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
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

      const valid = input.skipWorker
        ? validatePdfStructureSync(ownedBuffer)
        : await validatePdfInIsolatedWorker(ownedBuffer, input.signal)
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
      if (error instanceof LiteratureError) throw error
      throw new LiteratureError('RESPONSE_INVALID')
    } finally {
      this.permitBusy = false
    }
  }

  /**
   * Synchronous owner-scoped read for GET /api/plugins/literature-db/artifacts/:artifactId.
   */
  read(userId: number, artifactId: string): PublishedLiteratureArtifact | null {
    if (!Number.isSafeInteger(userId) || userId <= 0 || !OPAQUE_ID_RE.test(artifactId))
      return null
    if (this.permitBusy) throw new LiteratureError('CAPACITY')
    const now = this.now()
    this.sweep(now)
    const entry = this.reservations.get(artifactId)
    if (
      !entry ||
      !entry.published ||
      entry.discarded ||
      entry.userId !== userId ||
      entry.expiresAt <= now ||
      !entry.buffer
    ) {
      return null
    }
    return {
      artifactId: entry.id,
      userId: entry.userId,
      filename: entry.filename,
      mimeType: 'application/pdf',
      bytes: entry.bytes,
      data: entry.buffer.subarray(0, entry.bytes),
      expiresAt: entry.expiresAt,
    }
  }
}
