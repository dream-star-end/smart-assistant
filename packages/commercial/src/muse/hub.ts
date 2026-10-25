// Muse media bridge — in-process job hub (OCV5-561, multi-slot and billing OCV5-574).
//
// One master process owns the hub. The personal edition runs one bridge slot (one job at a time)
// with a short FIFO queue; commercial configures up to `concurrency` jobs at once, per-account
// caps, a longer queue and per-job credits (see MuseBridgeHubOptions).
//
// Job states (memory): queued → dispatched → running → done.
//   - `dispatched` means "handed to a poll response, not yet acked". It is never persisted:
//     the audit row stays `queued` until the ack, then becomes `running`.
//   - The ack is an execution barrier: the bridge only starts media-generation after the
//     master answered 200 to the ack for this exact nonce. A dispatched job without an ack
//     within ACK_TIMEOUT_MS is requeued with a fresh nonce, so a late ack for the old nonce
//     gets 410 and the bridge drops it. At most one generation can therefore run per job.
//   - Credits are charged only for a job that succeeded, in the same transaction that records the
//     success (MuseBilling.settle). Anything else — failure, cancel, timeout, lost bridge, restart —
//     charges nothing.

import { type Hash, createHash, randomUUID } from 'node:crypto'
import { access, appendFile, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { type Logger, rootLogger } from '../logging/logger.js'
import type { MuseBilling } from './billing.js'
import {
  ACK_TIMEOUT_MS,
  BRIDGE_ONLINE_MS,
  DONE_RETAIN_MS,
  HEARTBEAT_LOST_MS,
  INLINE_SOURCE_MAX_BYTES,
  JOB_DEADLINE_MS,
  JOB_ID_RE,
  MAX_DISPATCH_ATTEMPTS,
  MIME_EXT,
  MUSE_LIMITS,
  type MuseAllowlist,
  MuseError,
  type MuseJobSpec,
  type MuseKind,
  QUEUE_MAX,
  QUEUE_WAIT_MS,
  SNAPSHOT_ID_RE,
  SOURCE_UPLOAD_EXTRA_MS,
  base64DecodedBytes,
  bridgeFetchesSources,
  jobDeadlineMs,
  mimeAllowed,
  normalizeBridgeFailure,
  perFileLimit,
  sniffMime,
} from './protocol.js'
import type { MuseJobRecord, MuseJobStatus, MuseStore } from './store.js'

export interface MuseFileView {
  idx: number
  filename: string
  mime: string
  bytes: number
  sha256: string
}

type Outcome =
  | {
      ok: true
      files: MuseFileView[]
      snapshotId: string | null
      artifactIds: string[]
      chargedCredits: bigint | null
    }
  | {
      ok: false
      status: 'failed' | 'cancelled'
      code: string
      message: string
      retryable: boolean
      upstreamCode: string | null
    }

interface UploadState {
  chunks: number
  bytes: number
  hash: Hash
  lastChunkSha: string | null
}

interface HubJob {
  id: string
  userId: string
  containerId: string | null
  spec: MuseJobSpec
  state: 'queued' | 'dispatched' | 'running' | 'done'
  nonce: string
  queuedAt: number
  dispatchedAt: number
  lastBeatAt: number
  deadlineAt: number
  dispatchCount: number
  credentialId: string | null
  /** Credits this job will cost on success (0n when not billed); held against the balance check. */
  price: bigint
  /** The success is being recorded and charged; only result() may finish the job meanwhile. */
  settling: boolean
  uploads: Map<number, UploadState>
  uploadBusy: boolean
  outcome: Outcome | null
  finishedAt: number
  waiters: Set<() => void>
  /** Decoded source images, built on the first by-reference dispatch; dropped at finish. */
  sources: MuseSource[] | null
  /** Size of the last poll response that carried this job (logged when it is never acked). */
  claimResponseBytes: number
}

/** A source image as a bridge >= 0.5 downloads it. */
export interface MuseSource {
  data: Buffer
  sha256: string
  mime: string
}

export interface MuseJobView {
  job_id: string
  kind: MuseKind
  status: MuseJobStatus
  queue_position?: number
  queue_length?: number
  error?: { code: string; message: string; retryable: boolean; upstream_error_code: string | null }
  files?: MuseFileView[]
  snapshot_id?: string | null
  charged_credits?: string
}

/** What the bridge receives from /poll. */
export interface MuseWireJob {
  id: string
  nonce: string
  kind: MuseKind
  prompt: string
  orientation: string | null
  aspect_ratio: string | null
  image_format: string | null
  timeout_secs: number
  /** Inline sources, for bridges older than 0.5 (null when there are none or they go by reference). */
  source_images: Array<{ base64: string }> | null
  /** Bridges >= 0.5: download each with GET /jobs/:id/sources/:n after the ack. */
  source_refs?: Array<{ n: number; bytes: number; sha256: string; mime: string }>
  resume_snapshot_id: string | null
  deadline_at: string
}

export interface MuseRateLimits {
  imagePerHour: number
  imagePerDay: number
  videoPerHour: number
  videoPerDay: number
}

export interface MuseBridgeHubOptions {
  store: MuseStore
  stateRoot: string
  allowedUids: MuseAllowlist
  rate: MuseRateLimits
  cliTimeoutSec: Readonly<Record<MuseKind, number>>
  /** Jobs running at once (bridge slots). Default 1. */
  concurrency?: number
  /** Jobs waiting across all accounts. Default QUEUE_MAX. */
  queueMax?: number
  /** Longest wait in the queue, per kind. Default QUEUE_WAIT_MS for both. */
  queueWaitMs?: Readonly<Record<MuseKind, number>>
  /** Per account: queued + running jobs. Default: no cap. */
  userInflightMax?: number
  /** Per account: running jobs. Default: no cap beyond `concurrency`. */
  userRunningMax?: number
  /** Whole-site jobs per day, per kind. Missing kind = no cap. */
  globalPerDay?: Readonly<Partial<Record<MuseKind, number>>>
  /** Per-job credits. Absent = not billed (personal edition). */
  billing?: MuseBilling
  /** Open rows from another process are closed only once older than this. 0 = at start. */
  orphanGraceMs?: number
  now?: () => number
  logger?: Logger
}

interface Session {
  id: string
  credentialId: string
  version: string | null
  lastSeen: number
}

interface PollWaiter {
  sessionId: string
  resolve: (job: HubJob | null) => void
  timer: NodeJS.Timeout
}

export type SessionCheck = 'ok' | 'superseded' | 'unknown'

const ORPHAN_SWEEP_MS = 60_000

/**
 * Deterministic Muse job id for an idempotent caller (media studio, OCV5-591): a UUIDv5-shaped id
 * derived from a stable execution key, so a retried submission maps to the same job.
 */
export function deterministicMuseJobId(executionKey: string): string {
  const h = createHash('sha1').update('oc-studio-muse\0').update(executionKey).digest()
  h[6] = (h[6]! & 0x0f) | 0x50
  h[8] = (h[8]! & 0x3f) | 0x80
  const x = h.subarray(0, 16).toString('hex')
  return `mj_${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`
}

export class MuseBridgeHub {
  private readonly store: MuseStore
  private readonly root: string
  private readonly allowed: MuseAllowlist
  private readonly rate: MuseRateLimits
  private readonly cliTimeoutSec: Readonly<Record<MuseKind, number>>
  private readonly concurrency: number
  private readonly queueMax: number
  private readonly queueWaitMs: Readonly<Record<MuseKind, number>>
  private readonly userInflightMax: number
  private readonly userRunningMax: number
  private readonly globalPerDay: Readonly<Partial<Record<MuseKind, number>>>
  private readonly billing: MuseBilling | undefined
  private readonly orphanGraceMs: number
  private readonly now: () => number
  private readonly log: Logger
  private session: Session | null = null
  private readonly superseded: string[] = []
  private readonly waiters: PollWaiter[] = []
  /** Dispatched and running jobs (at most `concurrency`). */
  private readonly active = new Map<string, HubJob>()
  private readonly queue: HubJob[] = []
  private readonly jobs = new Map<string, HubJob>()
  private timer: NodeJS.Timeout | null = null
  private lastOrphanSweep = 0
  /** The audit-row write of each finished job, so stop() can wait for them. */
  private readonly persisted = new Map<string, Promise<void>>()
  /** Submissions between their checks and their enqueue (they await the DB). */
  private reservedTotal = 0
  private readonly reserved = new Map<string, number>()
  private readonly reservedByUser = new Map<string, { count: number; credits: bigint }>()

  constructor(opts: MuseBridgeHubOptions) {
    this.store = opts.store
    this.root = opts.stateRoot
    this.allowed = opts.allowedUids
    this.rate = opts.rate
    this.cliTimeoutSec = opts.cliTimeoutSec
    this.concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1))
    this.queueMax = Math.max(1, Math.floor(opts.queueMax ?? QUEUE_MAX))
    this.queueWaitMs = opts.queueWaitMs ?? { image: QUEUE_WAIT_MS, video: QUEUE_WAIT_MS }
    this.userInflightMax = opts.userInflightMax ?? Number.POSITIVE_INFINITY
    this.userRunningMax = opts.userRunningMax ?? Number.POSITIVE_INFINITY
    this.globalPerDay = opts.globalPerDay ?? {}
    this.billing = opts.billing
    this.orphanGraceMs = Math.max(0, opts.orphanGraceMs ?? 0)
    this.now = opts.now ?? Date.now
    this.log = (opts.logger ?? rootLogger).child({ subsys: 'museBridge' })
  }

  /** Longest a job of this process can stay open: queue wait + deadline (with source upload) + acks. */
  maxJobLifetimeMs(): number {
    const kinds: MuseKind[] = ['image', 'video']
    return Math.max(
      ...kinds.map(
        (k) =>
          this.queueWaitMs[k] +
          JOB_DEADLINE_MS[k] +
          SOURCE_UPLOAD_EXTRA_MS +
          MAX_DISPATCH_ATTEMPTS * ACK_TIMEOUT_MS,
      ),
    )
  }

  async start(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    // One master (no grace): every leftover is from a dead process. A/B slots share the directory:
    // only job directories older than any live job of either slot can go.
    const cutoff = Date.now() - this.orphanGraceMs - DONE_RETAIN_MS
    for (const name of await readdir(this.root)) {
      if (!JOB_ID_RE.test(name)) continue
      const dir = join(this.root, name)
      if (this.orphanGraceMs > 0) {
        const st = await stat(dir).catch(() => null)
        if (!st || st.mtimeMs >= cutoff) continue
      }
      await rm(dir, { recursive: true, force: true })
    }
    await this.sweepOrphans()
    this.timer = setInterval(() => this.tick(), 1000)
    this.timer.unref()
  }

  /** Graceful stop: jobs still open in this process can never finish, so close them now. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.clearWaiters()
    const open = [...this.jobs.values()].filter((j) => j.state !== 'done')
    for (const job of open) {
      this.finish(job, fail('MUSE_MASTER_RESTARTED', 'the master restarted during the job', true))
    }
    await Promise.allSettled(open.map((job) => this.persisted.get(job.id)))
  }

  isAllowed(userId: string): boolean {
    return this.allowed === 'all' || this.allowed.has(userId)
  }

  bridgeOnline(): boolean {
    return this.session !== null && this.now() - this.session.lastSeen <= BRIDGE_ONLINE_MS
  }

  /** Sent to the bridge in /hello: how many jobs it may run at once. */
  bridgeConcurrency(): number {
    return this.concurrency
  }

  // ── bridge side ──────────────────────────────────────────────────────────

  hello(credentialId: string, version: string | null): string {
    if (this.session) {
      this.superseded.push(this.session.id)
      if (this.superseded.length > 32) this.superseded.shift()
    }
    this.clearWaiters()
    for (const a of [...this.active.values()]) {
      if (a.state === 'dispatched') this.requeue(a)
      else if (a.state === 'running') {
        this.finish(a, fail('MUSE_BRIDGE_LOST', 'the bridge reconnected while the job was running'))
      }
    }
    this.session = { id: randomUUID(), credentialId, version, lastSeen: this.now() }
    this.log.info('muse_bridge_hello', { credentialId, version })
    return this.session.id
  }

  checkSession(sessionId: string | undefined): SessionCheck {
    if (sessionId && this.session?.id === sessionId) {
      this.session.lastSeen = this.now()
      return 'ok'
    }
    if (sessionId && this.superseded.includes(sessionId)) return 'superseded'
    return 'unknown'
  }

  /**
   * Long-poll for the next job. Resolves null on timeout or when `signal` aborts (the poll's
   * client went away before a response was written). The bridge keeps one poll per free slot.
   */
  poll(sessionId: string, holdMs: number, signal?: AbortSignal): Promise<MuseWireJob | null> {
    const ready = this.takeNext()
    if (ready) return Promise.resolve(this.wire(ready))
    if (signal?.aborted) return Promise.resolve(null)
    // More polls than slots means stale ones from a restarted bridge thread: drop the oldest.
    while (this.waiters.length >= this.concurrency) this.dropWaiter(this.waiters[0]!)
    return new Promise((resolve) => {
      const waiter: PollWaiter = {
        sessionId,
        timer: setTimeout(() => {
          this.removeWaiter(waiter)
          resolve(null)
        }, holdMs),
        resolve: (job) => resolve(job ? this.wire(job) : null),
      }
      waiter.timer.unref()
      this.waiters.push(waiter)
      signal?.addEventListener('abort', () => this.dropWaiter(waiter), { once: true })
    })
  }

  /** A dispatched job could not be written to its poll response: it was never seen. */
  undeliverable(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (job && this.active.get(jobId) === job && job.state === 'dispatched') this.requeue(job)
  }

  /**
   * One source image of an acked job, for a bridge >= 0.5 (GET /jobs/:id/sources/:n). Counts as a
   * sign of life, like a heartbeat. Throws 410 when the job/nonce is stale or not acked yet.
   */
  source(jobId: string, nonce: string, n: number): MuseSource {
    const job = this.requireRunning(jobId, nonce)
    const all = this.sourcesOf(job)
    const src = Number.isInteger(n) && n >= 0 ? all[n] : undefined
    if (!src) throw new MuseError(404, 'NOT_FOUND', 'no such source image')
    job.lastBeatAt = this.now()
    return src
  }

  /** Ack (first heartbeat) and keep-alive. Throws 410 when the job/nonce is stale. */
  heartbeat(jobId: string, nonce: string): { cancel: boolean } {
    const job = this.requireActive(jobId, nonce)
    const now = this.now()
    if (job.state === 'dispatched') {
      job.state = 'running'
      job.credentialId = this.session?.credentialId ?? null
      if (job.credentialId) {
        this.store.markRunning(job.id, job.credentialId).catch((err) => {
          this.log.warn('muse_mark_running_failed', { jobId: job.id, err: (err as Error).message })
        })
      }
      this.log.info('muse_media_job_started', { jobId: job.id, kind: job.spec.kind })
      this.wake(job)
    }
    job.lastBeatAt = now
    return { cancel: false }
  }

  async putChunk(
    jobId: string,
    nonce: string,
    idx: number,
    n: number,
    data: Buffer,
    sha256: string,
  ): Promise<void> {
    const job = this.requireRunning(jobId, nonce)
    if (!Number.isInteger(idx) || idx < 0 || idx >= MUSE_LIMITS.max_files) {
      throw new MuseError(400, 'BAD_FILE_INDEX', 'file index out of range')
    }
    if (!Number.isInteger(n) || n < 0)
      throw new MuseError(400, 'BAD_CHUNK_INDEX', 'bad chunk index')
    if (data.length > MUSE_LIMITS.chunk_bytes) {
      throw new MuseError(413, 'CHUNK_TOO_LARGE', 'chunk exceeds the chunk size limit')
    }
    if (createHash('sha256').update(data).digest('hex') !== sha256) {
      throw new MuseError(400, 'CHUNK_SHA_MISMATCH', 'chunk sha256 does not match')
    }
    if (job.uploadBusy) throw new MuseError(429, 'UPLOAD_BUSY', 'another chunk is being written')
    let up = job.uploads.get(idx)
    if (!up) {
      up = { chunks: 0, bytes: 0, hash: createHash('sha256'), lastChunkSha: null }
      job.uploads.set(idx, up)
    }
    // A retried PUT whose response was lost: same index, same content → already stored.
    if (n === up.chunks - 1 && up.lastChunkSha === sha256) return
    if (n !== up.chunks) throw new MuseError(400, 'CHUNK_OUT_OF_ORDER', 'chunks must be sequential')
    if (data.length === 0 && n > 0) throw new MuseError(400, 'EMPTY_CHUNK', 'empty chunk')
    let total = data.length
    for (const u of job.uploads.values()) total += u.bytes
    if (up.bytes + data.length > perFileLimit(job.spec.kind) || total > MUSE_LIMITS.job_max_bytes) {
      this.finish(job, fail('MUSE_FILE_TOO_LARGE', 'the generated file exceeds the size limit'))
      throw new MuseError(410, 'JOB_GONE', 'file too large; job failed')
    }
    job.uploadBusy = true
    try {
      const dir = join(this.root, job.id)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await appendFile(join(dir, `${idx}.part`), data, { mode: 0o600 })
    } finally {
      job.uploadBusy = false
    }
    if (job.state !== 'running') throw new MuseError(410, 'JOB_GONE', 'job is no longer running')
    up.hash.update(data)
    up.chunks += 1
    up.bytes += data.length
    up.lastChunkSha = sha256
    job.lastBeatAt = this.now()
  }

  async result(jobId: string, nonce: string, body: Record<string, unknown>): Promise<void> {
    const job = this.requireRunning(jobId, nonce)
    if (body.ok !== true) {
      const f = normalizeBridgeFailure(body)
      this.finish(job, {
        ok: false,
        status: f.code === 'MUSE_CANCELLED' ? 'cancelled' : 'failed',
        code: f.code,
        message: f.message,
        retryable: f.retryable,
        upstreamCode: f.upstreamCode,
      })
      return
    }
    if (job.uploadBusy) throw new MuseError(429, 'UPLOAD_BUSY', 'a chunk is still being written')
    // Hold the upload lock across verification (and the charge) so nothing can change what was
    // checked, and a second result for the same job cannot run concurrently.
    job.uploadBusy = true
    let files: MuseFileView[]
    let chargedCredits: bigint | null = null
    try {
      try {
        files = await this.verifyUploads(job, body.files)
      } catch (err) {
        const message = err instanceof MuseError ? err.message : 'result verification failed'
        this.finish(job, fail('MUSE_BAD_OUTPUT', message))
        throw new MuseError(400, 'BAD_RESULT', message)
      }
      if (job.state !== 'running') throw new MuseError(410, 'JOB_GONE', 'job is no longer running')
      const meta = isObj(body.meta) ? body.meta : {}
      const snapshot =
        typeof meta.snapshot_id === 'string' && SNAPSHOT_ID_RE.test(meta.snapshot_id)
          ? meta.snapshot_id
          : null
      const artifactIds = Array.isArray(meta.artifact_ids)
        ? meta.artifact_ids
            .filter((v): v is string => typeof v === 'string' && v.length <= 200)
            .slice(0, 8)
        : []
      if (this.billing && job.price > 0n) {
        // Records the success and charges in one transaction; a job the database no longer
        // holds as running (closed by a sweep) is neither delivered nor charged. While it runs,
        // nothing else (deadline, heartbeat loss, cancel, bridge reconnect) may finish the job:
        // a charged job must be delivered.
        job.settling = true
        try {
          const settled = await this.billing.settle({
            jobId: job.id,
            userId: job.userId,
            kind: job.spec.kind,
            price: job.price,
            files: files.map((f) => ({ mime: f.mime, bytes: f.bytes, sha256: f.sha256 })),
            artifactIds,
            snapshotId: snapshot,
          })
          chargedCredits = settled.debitedCredits ?? 0n
        } catch (err) {
          // The transaction may have committed before the error (a lost COMMIT reply): ask the
          // database what happened instead of assuming nothing was charged.
          this.log.error('muse_billing_settle_failed', {
            jobId: job.id,
            err: (err as Error).message,
          })
          let outcome: { charged: boolean; debitedCredits: bigint | null } | null = null
          try {
            outcome = await this.billing.outcome(job.id)
          } catch (lookupErr) {
            this.log.error('muse_billing_outcome_unknown', {
              jobId: job.id,
              err: (lookupErr as Error).message,
            })
          }
          if (outcome && !outcome.charged) {
            this.finish(
              job,
              fail(
                'MUSE_BILLING_FAILED',
                'the result could not be recorded; nothing was charged',
                true,
              ),
              true,
            )
            return
          }
          // Charged, or unknown: deliver. A charge must never go undelivered; an unknown outcome
          // at worst delivers one job uncharged (the row stays open and is never billed later).
          chargedCredits = outcome ? (outcome.debitedCredits ?? job.price) : null
        }
      }
      this.finish(job, { ok: true, files, snapshotId: snapshot, artifactIds, chargedCredits }, true)
    } finally {
      job.uploadBusy = false
    }
  }

  private async verifyUploads(job: HubJob, raw: unknown): Promise<MuseFileView[]> {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MUSE_LIMITS.max_files) {
      throw new MuseError(400, 'BAD_RESULT', 'result must list 1-4 files')
    }
    if (job.uploads.size !== raw.length) {
      throw new MuseError(400, 'BAD_RESULT', 'uploaded files and result files differ')
    }
    const out: MuseFileView[] = []
    for (const [i, f] of raw.entries()) {
      const up = job.uploads.get(i)
      if (!isObj(f) || f.idx !== i || !up)
        throw new MuseError(400, 'BAD_RESULT', 'file index mismatch')
      if (f.chunks !== up.chunks || f.bytes !== up.bytes) {
        throw new MuseError(400, 'BAD_RESULT', `file ${i} size or chunk count mismatch`)
      }
      const digest = up.hash.copy().digest('hex')
      if (f.sha256 !== digest) throw new MuseError(400, 'BAD_RESULT', `file ${i} sha256 mismatch`)
      const part = join(this.root, job.id, `${i}.part`)
      const fh = await open(part, 'r')
      let head: Buffer
      try {
        const buf = Buffer.alloc(16)
        const { bytesRead } = await fh.read(buf, 0, 16, 0)
        head = buf.subarray(0, bytesRead)
      } finally {
        await fh.close()
      }
      const mime = sniffMime(head)
      if (!mime || !mimeAllowed(job.spec.kind, mime) || f.mime !== mime) {
        throw new MuseError(400, 'BAD_RESULT', `file ${i} is not an allowed ${job.spec.kind} type`)
      }
      out.push({
        idx: i,
        // Never trust the bridge-supplied name; derive it.
        filename: museFileName(job.spec.kind, job.id, i, mime),
        mime,
        bytes: up.bytes,
        sha256: digest,
      })
    }
    for (const f of out) {
      await rename(
        join(this.root, job.id, `${f.idx}.part`),
        join(this.root, job.id, `${f.idx}.bin`),
      )
    }
    return out
  }

  // ── container side ───────────────────────────────────────────────────────

  async submit(
    userId: string,
    containerId: string | null,
    spec: MuseJobSpec,
    opts: { jobId?: string } = {},
  ): Promise<string> {
    // Idempotent submission (OCV5-591 A0): a caller-chosen deterministic id that already exists for
    // this user returns that job — never a second queue entry, never a second charge.
    if (opts.jobId !== undefined) {
      if (!/^mj_[0-9a-f-]{36}$/.test(opts.jobId)) {
        throw new MuseError(400, 'MUSE_INVALID_INPUT', 'invalid job id')
      }
      const live = this.jobs.get(opts.jobId)
      if (live) {
        if (live.userId !== userId)
          throw new MuseError(409, 'MUSE_JOB_ID_TAKEN', 'job id belongs to another account')
        return live.id
      }
      if (await this.store.findJob(userId, opts.jobId)) return opts.jobId
    }
    if (!this.isAllowed(userId)) {
      throw new MuseError(
        403,
        'MUSE_NOT_ENABLED',
        'Muse media tools are not enabled for this account',
      )
    }
    if (!this.bridgeOnline()) {
      throw new MuseError(503, 'MUSE_BRIDGE_OFFLINE', 'the Muse bridge is not connected')
    }
    const version = this.session?.version ?? null
    if (spec.source_images?.length && !bridgeFetchesSources(version)) {
      // An older bridge only receives sources inline in the poll response, and large ones never
      // get through to it: refuse now instead of failing a minute later as MUSE_BRIDGE_LOST.
      const total = spec.source_images.reduce((n, b) => n + base64DecodedBytes(b), 0)
      if (total > INLINE_SOURCE_MAX_BYTES) {
        throw new MuseError(
          413,
          'MUSE_SOURCE_TOO_LARGE',
          `source images total ${Math.ceil(total / 1024)} KiB; the connected Muse bridge (${version ?? 'unknown version'}) takes at most ${INLINE_SOURCE_MAX_BYTES / 1024} KiB until it is upgraded to 0.5`,
        )
      }
    }
    // Reserve the queue slot, the per-account slot, the rate count and the credits synchronously,
    // before any await, so concurrent submissions cannot all pass the checks.
    if (this.queue.length + this.reservedTotal >= this.queueMax) {
      throw new MuseError(503, 'MUSE_BUSY', 'the Muse channel is busy; try again shortly', true)
    }
    const mine = this.userLoad(userId)
    if (mine.count >= this.userInflightMax) {
      throw new MuseError(
        429,
        'MUSE_USER_BUSY',
        `at most ${this.userInflightMax} Muse jobs per account can wait or run at once`,
        true,
      )
    }
    const price = this.billing?.price(spec.kind) ?? 0n
    const key = `${userId}:${spec.kind}`
    const pending = this.reserved.get(key) ?? 0
    this.reservedTotal += 1
    this.reserved.set(key, pending + 1)
    const own = this.reservedByUser.get(userId) ?? { count: 0, credits: 0n }
    this.reservedByUser.set(userId, { count: own.count + 1, credits: own.credits + price })
    try {
      // Other admissions of this account in this process, not yet in the database.
      return await this.admit(userId, containerId, spec, pending, price, own.credits, opts.jobId)
    } finally {
      this.reservedTotal -= 1
      const left = (this.reserved.get(key) ?? 1) - 1
      if (left > 0) this.reserved.set(key, left)
      else this.reserved.delete(key)
      const cur = this.reservedByUser.get(userId)
      if (cur && cur.count > 1) {
        this.reservedByUser.set(userId, { count: cur.count - 1, credits: cur.credits - price })
      } else this.reservedByUser.delete(userId)
    }
  }

  /** This account's open jobs in this process (queued, dispatched, running, or being admitted). */
  private userLoad(userId: string): { count: number } {
    let count = 0
    for (const job of this.queue) if (job.userId === userId) count += 1
    for (const job of this.active.values()) if (job.userId === userId) count += 1
    return { count: count + (this.reservedByUser.get(userId)?.count ?? 0) }
  }

  private async admit(
    userId: string,
    containerId: string | null,
    spec: MuseJobSpec,
    pending: number,
    price: bigint,
    admittingCredits: bigint,
    fixedId?: string,
  ): Promise<string> {
    const counts = await this.store.countRecent(userId, spec.kind)
    const [perHour, perDay] =
      spec.kind === 'video'
        ? [this.rate.videoPerHour, this.rate.videoPerDay]
        : [this.rate.imagePerHour, this.rate.imagePerDay]
    // `pending` = this user's earlier submissions of this kind still in flight (not yet counted).
    if (counts.hour + pending >= perHour || counts.day + pending >= perDay) {
      throw new MuseError(429, 'MUSE_RATE_LIMITED', `${spec.kind} rate limit reached`)
    }
    const siteCap = this.globalPerDay[spec.kind]
    if (siteCap !== undefined) {
      const site = await this.store.countSiteToday(spec.kind)
      const sitePending = [...this.reserved.entries()]
        .filter(([k]) => k.endsWith(`:${spec.kind}`))
        .reduce((sum, [, n]) => sum + n, 0)
      if (site + sitePending - 1 >= siteCap) {
        throw new MuseError(
          429,
          'MUSE_DAILY_CAP',
          `the site's daily ${spec.kind} limit is reached`,
          true,
        )
      }
    }
    if (this.billing && price > 0n) {
      // Room for this job plus every other open job of this account (none is charged yet). The
      // database holds the quote of every open job, including the other A/B slot's.
      const open = await this.store.openCredits(userId)
      await this.billing.ensureBalance(userId, price + open + admittingCredits)
    }
    const id = fixedId ?? `mj_${randomUUID()}`
    try {
      await this.store.insertJob({
        id,
        userId,
        containerId,
        kind: spec.kind,
        promptSha256: createHash('sha256').update(spec.prompt).digest(),
        promptPreview: spec.prompt.slice(0, 500),
        priceCredits: price,
        params: {
          orientation: spec.orientation ?? null,
          aspect_ratio: spec.aspect_ratio ?? null,
          image_format: spec.image_format ?? null,
          source_count: spec.source_images?.length ?? 0,
          resumed: Boolean(spec.resume_snapshot_id),
        },
      })
    } catch (err) {
      // A concurrent submission of the same deterministic id (the other A/B slot, a retry) won the
      // insert: hand back that job instead of queuing a duplicate.
      if (fixedId && (err as { code?: string }).code === '23505') {
        if (await this.store.findJob(userId, fixedId)) return fixedId
        throw new MuseError(409, 'MUSE_JOB_ID_TAKEN', 'job id belongs to another account')
      }
      throw err
    }
    const now = this.now()
    const job: HubJob = {
      id,
      userId,
      containerId,
      spec,
      state: 'queued',
      nonce: randomUUID(),
      queuedAt: now,
      dispatchedAt: 0,
      lastBeatAt: 0,
      deadlineAt: 0,
      dispatchCount: 0,
      credentialId: null,
      price,
      settling: false,
      uploads: new Map(),
      uploadBusy: false,
      outcome: null,
      finishedAt: 0,
      waiters: new Set(),
      sources: null,
      claimResponseBytes: 0,
    }
    this.jobs.set(id, job)
    this.queue.push(job)
    this.log.info('muse_media_job_queued', { jobId: id, userId, kind: spec.kind })
    this.pump()
    return id
  }

  /** Status for the owner; waits up to waitMs for the job to change (dispatched, running, a new
   * queue position, done). Null = not found. */
  async view(userId: string, jobId: string, waitMs: number): Promise<MuseJobView | null> {
    const job = this.jobs.get(jobId)
    if (!job || job.userId !== userId) {
      const rec = await this.store.findJob(userId, jobId)
      if (!rec) return null
      // Finished in another process (a restart, the other A/B slot): its files are in the shared
      // state directory for as long as they exist.
      const files = rec.status === 'succeeded' ? await this.storedFiles(rec) : null
      return {
        job_id: rec.id,
        kind: rec.kind,
        status: rec.status,
        ...(files ? { files, snapshot_id: rec.snapshotId } : {}),
        ...(files && rec.debitedCredits !== null ? { charged_credits: rec.debitedCredits } : {}),
        ...(rec.errorCode
          ? {
              error: {
                code: rec.errorCode,
                message: rec.errorCode,
                retryable: rec.errorCode === 'MUSE_MASTER_RESTARTED',
                upstream_error_code: null,
              },
            }
          : {}),
      }
    }
    if (job.state !== 'done' && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          job.waiters.delete(done)
          resolve()
        }
        const timer = setTimeout(done, waitMs)
        timer.unref()
        job.waiters.add(done)
      })
    }
    return this.viewOf(job)
  }

  cancel(userId: string, jobId: string): MuseJobView | null {
    const job = this.jobs.get(jobId)
    if (!job || job.userId !== userId) return null
    if (job.state !== 'done') {
      this.finish(job, {
        ok: false,
        status: 'cancelled',
        code: 'MUSE_CANCELLED',
        message: 'cancelled by the caller',
        retryable: false,
        upstreamCode: null,
      })
    }
    return this.viewOf(job)
  }

  /** Path of a finished file, for the owner only. */
  async fileFor(
    userId: string,
    jobId: string,
    idx: number,
  ): Promise<{ path: string; file: MuseFileView } | null> {
    const job = this.jobs.get(jobId)
    let files: MuseFileView[] | null = null
    if (job && job.userId === userId) {
      files = job.outcome?.ok ? job.outcome.files : null
    } else {
      const rec = await this.store.findJob(userId, jobId)
      files = rec?.status === 'succeeded' ? await this.storedFiles(rec) : null
    }
    const file = files?.find((f) => f.idx === idx)
    return file ? { path: join(this.root, jobId, `${idx}.bin`), file } : null
  }

  /** A succeeded row's files, when every one is still in the state directory. */
  private async storedFiles(rec: MuseJobRecord): Promise<MuseFileView[] | null> {
    if (!rec.files?.length) return null
    const out: MuseFileView[] = []
    for (const [idx, f] of rec.files.entries()) {
      if (!MIME_EXT[f.mime]) return null
      try {
        await access(join(this.root, rec.id, `${idx}.bin`))
      } catch {
        return null
      }
      out.push({ idx, filename: museFileName(rec.kind, rec.id, idx, f.mime), ...f })
    }
    return out
  }

  // ── internals ────────────────────────────────────────────────────────────

  tick(): void {
    const now = this.now()
    if (!this.bridgeOnline()) {
      for (const job of [...this.queue]) {
        this.finish(job, fail('MUSE_BRIDGE_OFFLINE', 'the Muse bridge disconnected'))
      }
    }
    for (const a of [...this.active.values()]) {
      if (a.state === 'dispatched' && now - a.dispatchedAt > ACK_TIMEOUT_MS) {
        if (a.dispatchCount >= MAX_DISPATCH_ATTEMPTS) {
          this.log.warn('muse_job_never_acked', {
            jobId: a.id,
            attempts: a.dispatchCount,
            claimResponseBytes: a.claimResponseBytes,
          })
          this.finish(a, fail('MUSE_BRIDGE_LOST', 'the bridge never acknowledged the job'))
        } else {
          this.log.warn('muse_job_ack_timeout_requeued', {
            jobId: a.id,
            attempt: a.dispatchCount,
            claimResponseBytes: a.claimResponseBytes,
          })
          this.requeue(a)
        }
      } else if (a.state === 'running') {
        if (now - a.lastBeatAt > HEARTBEAT_LOST_MS) {
          this.finish(a, fail('MUSE_BRIDGE_LOST', 'lost contact with the bridge during the job'))
        } else if (now > a.deadlineAt) {
          this.finish(a, fail('MUSE_TIMEOUT', 'the job exceeded its deadline', true))
        }
      }
    }
    for (const job of [...this.queue]) {
      if (now - job.queuedAt > this.queueWaitMs[job.spec.kind]) {
        this.finish(job, fail('MUSE_BUSY', 'waited too long in the Muse queue', true))
      }
    }
    for (const [id, job] of this.jobs) {
      if (job.state === 'done' && now - job.finishedAt > DONE_RETAIN_MS) {
        this.jobs.delete(id)
        void rm(join(this.root, id), { recursive: true, force: true })
      }
    }
    if (this.orphanGraceMs > 0 && now - this.lastOrphanSweep >= ORPHAN_SWEEP_MS) {
      void this.sweepOrphans()
    }
  }

  /** Close rows no live process will finish. With a grace (A/B slots share the database), only
   * rows older than any job of a live process can be, and never this process's own jobs. */
  private async sweepOrphans(): Promise<void> {
    this.lastOrphanSweep = this.now()
    try {
      const own = [...this.jobs.values()].filter((j) => j.state !== 'done').map((j) => j.id)
      const n = await this.store.failOrphans(this.orphanGraceMs, own)
      if (n > 0) this.log.warn('muse_jobs_orphaned', { count: n })
    } catch (err) {
      this.log.error('muse_fail_orphans_failed', { err: (err as Error).message })
    }
  }

  private runningFor(userId: string): number {
    let n = 0
    for (const job of this.active.values()) if (job.userId === userId) n += 1
    return n
  }

  private takeNext(): HubJob | null {
    if (this.active.size >= this.concurrency) return null
    const at = this.queue.findIndex((job) => this.runningFor(job.userId) < this.userRunningMax)
    if (at < 0) return null
    const [job] = this.queue.splice(at, 1)
    const now = this.now()
    job!.state = 'dispatched'
    job!.nonce = randomUUID()
    job!.dispatchedAt = now
    job!.deadlineAt = now + jobDeadlineMs(job!.spec)
    job!.dispatchCount += 1
    this.active.set(job!.id, job!)
    this.wakeQueued()
    return job!
  }

  /** Answer the owner's pending status request: the job changed. */
  private wake(job: HubJob): void {
    for (const w of [...job.waiters]) w()
  }

  /** Every queued job's position may have moved. */
  private wakeQueued(): void {
    for (const job of this.queue) this.wake(job)
  }

  private pump(): void {
    while (this.waiters.length > 0) {
      const job = this.takeNext()
      if (!job) return
      const w = this.waiters.shift()!
      clearTimeout(w.timer)
      w.resolve(job)
    }
  }

  private requeue(job: HubJob): void {
    if (job.state !== 'dispatched') return
    this.active.delete(job.id)
    job.state = 'queued'
    job.nonce = randomUUID()
    this.queue.unshift(job)
    this.pump()
  }

  private removeWaiter(w: PollWaiter): boolean {
    const i = this.waiters.indexOf(w)
    if (i < 0) return false
    this.waiters.splice(i, 1)
    clearTimeout(w.timer)
    return true
  }

  private dropWaiter(w: PollWaiter): void {
    if (this.removeWaiter(w)) w.resolve(null)
  }

  private clearWaiters(): void {
    for (const w of [...this.waiters]) this.dropWaiter(w)
  }

  private requireActive(jobId: string, nonce: string): HubJob {
    const job = this.jobs.get(jobId)
    if (
      !job ||
      this.active.get(jobId) !== job ||
      job.state === 'done' ||
      !nonce ||
      job.nonce !== nonce
    ) {
      throw new MuseError(410, 'JOB_GONE', 'unknown, finished or reassigned job')
    }
    return job
  }

  private requireRunning(jobId: string, nonce: string): HubJob {
    const job = this.requireActive(jobId, nonce)
    if (job.state !== 'running') throw new MuseError(410, 'JOB_GONE', 'job was not acknowledged')
    return job
  }

  /** `force`: result() itself, the only caller allowed to finish a job while it is settling. */
  private finish(job: HubJob, outcome: Outcome, force = false): void {
    if (job.state === 'done') return
    if (job.settling && !force) return
    job.settling = false
    job.state = 'done'
    job.outcome = outcome
    job.finishedAt = this.now()
    job.spec = { ...job.spec, source_images: undefined }
    job.sources = null
    this.active.delete(job.id)
    const qi = this.queue.indexOf(job)
    if (qi >= 0) {
      this.queue.splice(qi, 1)
      this.wakeQueued()
    }
    this.wake(job)
    const write = this.store
      .finishJob(job.id, {
        status: outcome.ok ? 'succeeded' : outcome.status,
        errorCode: outcome.ok ? null : outcome.code,
        upstreamErrorCode: outcome.ok ? null : outcome.upstreamCode,
        files: outcome.ok
          ? outcome.files.map((f) => ({ mime: f.mime, bytes: f.bytes, sha256: f.sha256 }))
          : null,
        artifactIds: outcome.ok ? outcome.artifactIds : null,
        snapshotId: outcome.ok ? outcome.snapshotId : null,
      })
      .catch((err) => {
        this.log.warn('muse_finish_persist_failed', { jobId: job.id, err: (err as Error).message })
      })
      .finally(() => this.persisted.delete(job.id))
    this.persisted.set(job.id, write)
    if (!outcome.ok) void rm(join(this.root, job.id), { recursive: true, force: true })
    this.log.info('muse_media_job_finished', {
      jobId: job.id,
      kind: job.spec.kind,
      ok: outcome.ok,
      code: outcome.ok ? null : outcome.code,
      bytes: outcome.ok ? outcome.files.reduce((s, f) => s + f.bytes, 0) : 0,
      charged:
        outcome.ok && outcome.chargedCredits !== null ? outcome.chargedCredits.toString() : null,
    })
    this.pump()
  }

  private viewOf(job: HubJob): MuseJobView {
    const base = { job_id: job.id, kind: job.spec.kind }
    if (job.state === 'queued' || job.state === 'dispatched') {
      const pos = this.queue.indexOf(job)
      return {
        ...base,
        status: 'queued',
        queue_position: pos < 0 ? 0 : pos + 1,
        queue_length: this.queue.length,
      }
    }
    if (job.state === 'running') return { ...base, status: 'running' }
    const o = job.outcome!
    if (o.ok) {
      return {
        ...base,
        status: 'succeeded',
        files: o.files,
        snapshot_id: o.snapshotId,
        ...(o.chargedCredits !== null ? { charged_credits: o.chargedCredits.toString() } : {}),
      }
    }
    return {
      ...base,
      status: o.status,
      error: {
        code: o.code,
        message: o.message,
        retryable: o.retryable,
        upstream_error_code: o.upstreamCode,
      },
    }
  }

  private wire(job: HubJob): MuseWireJob {
    const s = job.spec
    const byRef =
      Boolean(s.source_images?.length) && bridgeFetchesSources(this.session?.version ?? null)
    const w: MuseWireJob = {
      id: job.id,
      nonce: job.nonce,
      kind: s.kind,
      prompt: s.prompt,
      orientation: s.orientation ?? null,
      aspect_ratio: s.aspect_ratio ?? null,
      image_format: s.kind === 'image' ? (s.image_format ?? null) : null,
      timeout_secs: this.cliTimeoutSec[s.kind],
      source_images:
        s.source_images?.length && !byRef ? s.source_images.map((b) => ({ base64: b })) : null,
      ...(byRef
        ? {
            source_refs: this.sourcesOf(job).map((src, n) => ({
              n,
              bytes: src.data.length,
              sha256: src.sha256,
              mime: src.mime,
            })),
          }
        : {}),
      resume_snapshot_id: s.resume_snapshot_id ?? null,
      deadline_at: new Date(job.deadlineAt).toISOString(),
    }
    job.claimResponseBytes = Buffer.byteLength(JSON.stringify({ job: w }))
    return w
  }

  /** The job's source images, decoded once (submissions were validated as png/jpeg/webp). */
  private sourcesOf(job: HubJob): MuseSource[] {
    if (!job.sources) {
      job.sources = (job.spec.source_images ?? []).map((b64) => {
        const data = Buffer.from(b64, 'base64')
        return {
          data,
          sha256: createHash('sha256').update(data).digest('hex'),
          mime: sniffMime(data.subarray(0, 16)) ?? 'application/octet-stream',
        }
      })
    }
    return job.sources
  }
}

function museFileName(kind: MuseKind, jobId: string, idx: number, mime: string): string {
  return `muse-${kind}-${jobId.slice(3, 11)}-${idx + 1}.${MIME_EXT[mime]}`
}

function fail(code: string, message: string, retryable = false): Outcome {
  return { ok: false, status: 'failed', code, message, retryable, upstreamCode: null }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v))
}
