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
  const head = data.subarray(0, Math.min(data.length, 1024)).toString('latin1')
  if (!/^%PDF-[12]\.\d[\r\n]/.test(head)) return false
  if (/<(?:!doctype|html|head|body|script|iframe|div)\b/i.test(head)) return false

  const tailLen = Math.min(data.length, 16384)
  const tail = data.subarray(data.length - tailLen).toString('latin1')
  if (/\/Encrypt\b/.test(tail)) return false

  const startxrefMatches = Array.from(
    tail.matchAll(/\bstartxref[\r\n\s]+(\d+)[\r\n\s]+%%EOF/g),
  )
  if (startxrefMatches.length === 0) return false
  const lastMatch = startxrefMatches[startxrefMatches.length - 1]!
  const xrefOffset = Number.parseInt(lastMatch[1]!, 10)
  if (!Number.isSafeInteger(xrefOffset) || xrefOffset <= 8 || xrefOffset >= data.length - 16) {
    return false
  }

  const atXref = data
    .subarray(xrefOffset, Math.min(data.length, xrefOffset + 8192))
    .toString('latin1')
  const fullStr = data.toString('latin1')

  let rootNum: string | null = null
  if (/^\s*xref[\r\n\s]+\d+\s+\d+/.test(atXref)) {
    const trailerIdx = atXref.indexOf('trailer')
    const trailerSource = trailerIdx >= 0 ? atXref.slice(trailerIdx) : tail
    const rootMatch =
      /\btrailer\b[\s\S]*?<<[\s\S]*?\/Root\s+(\d+)\s+(\d+)\s+R\b/.exec(
        trailerSource,
      ) ?? /\/Root\s+(\d+)\s+(\d+)\s+R\b/.exec(tail)
    if (!rootMatch?.[1]) return false
    rootNum = rootMatch[1]
    const inUseEntries = Array.from(atXref.matchAll(/\b(\d{10})\s+\d{5}\s+n\b/g))
    if (inUseEntries.length === 0) return false
    let verifiedObjAtOffset = 0
    for (const entry of inUseEntries.slice(0, 10)) {
      const off = Number.parseInt(entry[1]!, 10)
      if (off > 0 && off < data.length - 10) {
        const probe = data.subarray(off, Math.min(data.length, off + 64)).toString('latin1')
        if (/^\s*\d+\s+\d+\s+obj\b/.test(probe)) verifiedObjAtOffset++
      }
    }
    if (verifiedObjAtOffset === 0) return false
  } else {
    const xrefObjMatch =
      /^\s*(\d+)\s+(\d+)\s+obj\b[\s\S]{1,4096}?<<([\s\S]{1,4096}?)>>/.exec(atXref)
    if (!xrefObjMatch?.[3]) return false
    const dict = xrefObjMatch[3]
    if (!/\/Type\s*\/XRef\b/.test(dict)) return false
    const rootMatch =
      /\/Root\s+(\d+)\s+(\d+)\s+R\b/.exec(dict) ??
      /\/Root\s+(\d+)\s+(\d+)\s+R\b/.exec(tail)
    if (!rootMatch?.[1]) return false
    rootNum = rootMatch[1]
  }

  const hasObjStm = /\/Type\s*\/ObjStm\b/.test(fullStr) || /\/Linearized\b/.test(fullStr)
  if (!hasObjStm) {
    const rootRe = new RegExp(
      `\\b${rootNum}\\s+\\d+\\s+obj\\b[\\s\\S]{1,2048}?\\/Type\\s*\\/Catalog\\b`,
    )
    if (!rootRe.test(fullStr)) return false
    if (
      !/\/Type\s*\/Pages\b[\s\S]{1,2048}?\/Count\s+[1-9]\d*/.test(fullStr) &&
      !/\/Count\s+[1-9]\d*[\s\S]{1,2048}?\/Type\s*\/Pages\b/.test(fullStr)
    ) {
      return false
    }
    if (!/\/Type\s*\/Page\b(?!s)/.test(fullStr)) return false
  } else {
    const objMatches = fullStr.match(/\b\d+\s+\d+\s+obj\b/g)
    if (!objMatches || objMatches.length < 3) return false
  }
  return true
}

const WORKER_SCRIPT = `
const { parentPort, workerData } = require('node:worker_threads');
const data = Buffer.from(workerData);
function check(buf) {
  if (buf.length < 64 || buf.length > 26214400) return false;
  const head = buf.subarray(0, Math.min(buf.length, 1024)).toString('latin1');
  if (!/^%PDF-[12]\\.\\d[\\r\\n]/.test(head)) return false;
  if (/<(?:!doctype|html|head|body|script|iframe|div)\\b/i.test(head)) return false;

  const tailLen = Math.min(buf.length, 16384);
  const tail = buf.subarray(buf.length - tailLen).toString('latin1');
  if (/\\/Encrypt\\b/.test(tail)) return false;

  const startxrefMatches = Array.from(tail.matchAll(/\\bstartxref[\\r\\n\\s]+(\\d+)[\\r\\n\\s]+%%EOF/g));
  if (startxrefMatches.length === 0) return false;
  const lastMatch = startxrefMatches[startxrefMatches.length - 1];
  const xrefOffset = Number.parseInt(lastMatch[1], 10);
  if (!Number.isSafeInteger(xrefOffset) || xrefOffset <= 8 || xrefOffset >= buf.length - 16) return false;

  const atXref = buf.subarray(xrefOffset, Math.min(buf.length, xrefOffset + 8192)).toString('latin1');
  const fullStr = buf.toString('latin1');

  let rootNum = null;
  if (/^\\s*xref[\\r\\n\\s]+\\d+\\s+\\d+/.test(atXref)) {
    const trailerIdx = atXref.indexOf('trailer');
    const trailerSource = trailerIdx >= 0 ? atXref.slice(trailerIdx) : tail;
    const rootMatch = /\\btrailer\\b[\\s\\S]*?<<[\\s\\S]*?\\/Root\\s+(\\d+)\\s+(\\d+)\\s+R\\b/.exec(trailerSource) || /\\/Root\\s+(\\d+)\\s+(\\d+)\\s+R\\b/.exec(tail);
    if (!rootMatch || !rootMatch[1]) return false;
    rootNum = rootMatch[1];
    const inUseEntries = Array.from(atXref.matchAll(/\\b(\\d{10})\\s+\\d{5}\\s+n\\b/g));
    if (inUseEntries.length === 0) return false;
    let verifiedObjAtOffset = 0;
    for (const entry of inUseEntries.slice(0, 10)) {
      const off = Number.parseInt(entry[1], 10);
      if (off > 0 && off < buf.length - 10) {
        const probe = buf.subarray(off, Math.min(buf.length, off + 64)).toString('latin1');
        if (/^\\s*\\d+\\s+\\d+\\s+obj\\b/.test(probe)) verifiedObjAtOffset++;
      }
    }
    if (verifiedObjAtOffset === 0) return false;
  } else {
    const xrefObjMatch = /^\\s*(\\d+)\\s+(\\d+)\\s+obj\\b[\\s\\S]{1,4096}?<<([\\s\\S]{1,4096}?)>>/.exec(atXref);
    if (!xrefObjMatch || !xrefObjMatch[3]) return false;
    const dict = xrefObjMatch[3];
    if (!/\\/Type\\s*\\/XRef\\b/.test(dict)) return false;
    const rootMatch = /\\/Root\\s+(\\d+)\\s+(\\d+)\\s+R\\b/.exec(dict) || /\\/Root\\s+(\\d+)\\s+(\\d+)\\s+R\\b/.exec(tail);
    if (!rootMatch || !rootMatch[1]) return false;
    rootNum = rootMatch[1];
  }

  const hasObjStm = /\\/Type\\s*\\/ObjStm\\b/.test(fullStr) || /\\/Linearized\\b/.test(fullStr);
  if (!hasObjStm) {
    const rootRe = new RegExp('\\\\b' + rootNum + '\\\\s+\\\\d+\\\\s+obj\\\\b[\\\\s\\\\S]{1,2048}?\\/Type\\\\s*\\/Catalog\\\\b');
    if (!rootRe.test(fullStr)) return false;
    if (!/\\/Type\\s*\\/Pages\\b[\\s\\S]{1,2048}?\\/Count\\s+[1-9]\\d*/.test(fullStr) &&
        !/\\/Count\\s+[1-9]\\d*[\\s\\S]{1,2048}?\\/Type\\s*\\/Pages\\b/.test(fullStr)) {
      return false;
    }
    if (!/\\/Type\\s*\\/Page\\b(?!s)/.test(fullStr)) return false;
  } else {
    const objMatches = fullStr.match(/\\b\\d+\\s+\\d+\\s+obj\\b/g);
    if (!objMatches || objMatches.length < 3) return false;
  }
  return true;
}
parentPort.postMessage({ ok: check(data) });
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
