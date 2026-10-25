// Muse media bridge — in-process job hub (OCV5-561).
//
// One master process owns the hub (selfhost runs a single master). The bridge runs one job at
// a time, so the hub keeps at most one active job plus a short FIFO queue.
//
// Job states (memory): queued → dispatched → running → done.
//   - `dispatched` means "handed to a poll response, not yet acked". It is never persisted:
//     the audit row stays `queued` until the ack, then becomes `running`.
//   - The ack is an execution barrier: the bridge only starts media-generation after the
//     master answered 200 to the ack for this exact nonce. A dispatched job without an ack
//     within ACK_TIMEOUT_MS is requeued with a fresh nonce, so a late ack for the old nonce
//     gets 410 and the bridge drops it. At most one generation can therefore run per job.

import { type Hash, createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { type Logger, rootLogger } from '../logging/logger.js'
import {
  ACK_TIMEOUT_MS,
  BRIDGE_ONLINE_MS,
  DONE_RETAIN_MS,
  HEARTBEAT_LOST_MS,
  JOB_ID_RE,
  MAX_DISPATCH_ATTEMPTS,
  MIME_EXT,
  MUSE_LIMITS,
  MuseError,
  type MuseJobSpec,
  type MuseKind,
  type MuseSourceRef,
  QUEUE_MAX,
  QUEUE_WAIT_MS,
  SNAPSHOT_ID_RE,
  jobDeadlineMs,
  mimeAllowed,
  normalizeBridgeFailure,
  perFileLimit,
  sniffMime,
  supportsSourceRefs,
} from './protocol.js'
import type { MuseJobStatus, MuseStore } from './store.js'

export interface MuseFileView {
  idx: number
  filename: string
  mime: string
  bytes: number
  sha256: string
}

type Outcome =
  | { ok: true; files: MuseFileView[]; snapshotId: string | null; artifactIds: string[] }
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
  sources: Array<{ data: Buffer; ref: MuseSourceRef }>
  claimResponseBytes: number
  state: 'queued' | 'dispatched' | 'running' | 'done'
  nonce: string
  queuedAt: number
  dispatchedAt: number
  lastBeatAt: number
  deadlineAt: number
  dispatchCount: number
  credentialId: string | null
  uploads: Map<number, UploadState>
  uploadBusy: boolean
  outcome: Outcome | null
  finishedAt: number
  waiters: Set<() => void>
}

export interface MuseJobView {
  job_id: string
  kind: MuseKind
  status: MuseJobStatus
  queue_position?: number
  error?: { code: string; message: string; retryable: boolean; upstream_error_code: string | null }
  files?: MuseFileView[]
  snapshot_id?: string | null
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
  source_images?: Array<{ base64: string }> | null
  source_refs?: MuseSourceRef[]
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
  allowedUids: ReadonlySet<string>
  rate: MuseRateLimits
  cliTimeoutSec: Readonly<Record<MuseKind, number>>
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

export class MuseBridgeHub {
  private readonly store: MuseStore
  private readonly root: string
  private readonly allowed: ReadonlySet<string>
  private readonly rate: MuseRateLimits
  private readonly cliTimeoutSec: Readonly<Record<MuseKind, number>>
  private readonly now: () => number
  private readonly log: Logger
  private session: Session | null = null
  private readonly superseded: string[] = []
  private waiter: PollWaiter | null = null
  private active: HubJob | null = null
  private readonly queue: HubJob[] = []
  private readonly jobs = new Map<string, HubJob>()
  private timer: NodeJS.Timeout | null = null
  /** Submissions between their checks and their enqueue (they await the DB). */
  private reservedTotal = 0
  private readonly reserved = new Map<string, number>()

  constructor(opts: MuseBridgeHubOptions) {
    this.store = opts.store
    this.root = opts.stateRoot
    this.allowed = opts.allowedUids
    this.rate = opts.rate
    this.cliTimeoutSec = opts.cliTimeoutSec
    this.now = opts.now ?? Date.now
    this.log = (opts.logger ?? rootLogger).child({ subsys: 'museBridge' })
  }

  async start(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    for (const name of await readdir(this.root)) {
      if (JOB_ID_RE.test(name)) await rm(join(this.root, name), { recursive: true, force: true })
    }
    try {
      const n = await this.store.failOrphans()
      if (n > 0) this.log.warn('muse_jobs_orphaned_on_start', { count: n })
    } catch (err) {
      this.log.error('muse_fail_orphans_failed', { err: (err as Error).message })
    }
    this.timer = setInterval(() => this.tick(), 1000)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.clearWaiter()
  }

  isAllowed(userId: string): boolean {
    return this.allowed.has(userId)
  }

  bridgeOnline(): boolean {
    return this.session !== null && this.now() - this.session.lastSeen <= BRIDGE_ONLINE_MS
  }

  // ── bridge side ──────────────────────────────────────────────────────────

  hello(credentialId: string, version: string | null): string {
    if (this.session) {
      this.superseded.push(this.session.id)
      if (this.superseded.length > 32) this.superseded.shift()
    }
    this.clearWaiter()
    const a = this.active
    if (a?.state === 'dispatched') this.requeue(a)
    else if (a?.state === 'running') {
      this.finish(a, fail('MUSE_BRIDGE_LOST', 'the bridge reconnected while the job was running'))
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

  /** Long-poll for the next job. Resolves null on timeout, cancel, or a newer poll. */
  poll(sessionId: string, holdMs: number): Promise<MuseWireJob | null> {
    const ready = this.takeNext()
    if (ready) return Promise.resolve(this.wire(ready))
    this.clearWaiter()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiter?.timer === timer) this.waiter = null
        resolve(null)
      }, holdMs)
      timer.unref()
      this.waiter = {
        sessionId,
        timer,
        resolve: (job) => resolve(job ? this.wire(job) : null),
      }
    })
  }

  /** The poll's client went away before a response was written. */
  cancelPoll(sessionId: string): void {
    if (this.waiter?.sessionId === sessionId) this.clearWaiter()
  }

  /** A dispatched job could not be written to its poll response: it was never seen. */
  undeliverable(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (job && job === this.active && job.state === 'dispatched') {
      this.log.warn('muse_job_undeliverable_requeued', {
        jobId,
        claimResponseBytes: job.claimResponseBytes,
      })
      this.requeue(job)
    }
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
    }
    job.lastBeatAt = now
    return { cancel: false }
  }

  /** Source bytes are available only after the ack barrier, for this dispatch nonce. */
  sourceFor(jobId: string, nonce: string, n: number): { data: Buffer; ref: MuseSourceRef } {
    const job = this.requireRunning(jobId, nonce)
    const source = Number.isSafeInteger(n) && n >= 0 ? job.sources[n] : undefined
    if (!source) throw new MuseError(404, 'SOURCE_NOT_FOUND', 'source index out of range')
    return source
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
    // Hold the upload lock across verification so no chunk can change what was checked.
    job.uploadBusy = true
    let files: MuseFileView[]
    try {
      files = await this.verifyUploads(job, body.files)
    } catch (err) {
      const message = err instanceof MuseError ? err.message : 'result verification failed'
      this.finish(job, fail('MUSE_BAD_OUTPUT', message))
      throw new MuseError(400, 'BAD_RESULT', message)
    } finally {
      job.uploadBusy = false
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
    this.finish(job, { ok: true, files, snapshotId: snapshot, artifactIds })
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
        filename: `muse-${job.spec.kind}-${job.id.slice(3, 11)}-${i + 1}.${MIME_EXT[mime]}`,
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

  async submit(userId: string, containerId: string | null, spec: MuseJobSpec): Promise<string> {
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
    // Reserve the queue slot and the rate count synchronously, before any await, so
    // concurrent submissions cannot all pass the checks and overfill the queue / limits.
    if (this.queue.length + this.reservedTotal >= QUEUE_MAX) {
      throw new MuseError(503, 'MUSE_BUSY', 'the Muse channel is busy; try again shortly', true)
    }
    const key = `${userId}:${spec.kind}`
    const pending = this.reserved.get(key) ?? 0
    this.reservedTotal += 1
    this.reserved.set(key, pending + 1)
    try {
      return await this.admit(userId, containerId, spec, pending)
    } finally {
      this.reservedTotal -= 1
      const left = (this.reserved.get(key) ?? 1) - 1
      if (left > 0) this.reserved.set(key, left)
      else this.reserved.delete(key)
    }
  }

  private async admit(
    userId: string,
    containerId: string | null,
    spec: MuseJobSpec,
    pending: number,
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
    const id = `mj_${randomUUID()}`
    await this.store.insertJob({
      id,
      userId,
      containerId,
      kind: spec.kind,
      promptSha256: createHash('sha256').update(spec.prompt).digest(),
      promptPreview: spec.prompt.slice(0, 500),
      params: {
        orientation: spec.orientation ?? null,
        aspect_ratio: spec.aspect_ratio ?? null,
        image_format: spec.image_format ?? null,
        source_count: spec.source_images?.length ?? 0,
        resumed: Boolean(spec.resume_snapshot_id),
      },
    })
    const now = this.now()
    const job: HubJob = {
      id,
      userId,
      containerId,
      spec: { ...spec },
      sources: (spec.source_images ?? []).map((base64, n) => {
        const data = Buffer.from(base64, 'base64')
        return {
          data,
          ref: {
            n,
            bytes: data.length,
            sha256: createHash('sha256').update(data).digest('hex'),
            mime: sniffMime(data)!,
          },
        }
      }),
      claimResponseBytes: 0,
      state: 'queued',
      nonce: randomUUID(),
      queuedAt: now,
      dispatchedAt: 0,
      lastBeatAt: 0,
      deadlineAt: 0,
      dispatchCount: 0,
      credentialId: null,
      uploads: new Map(),
      uploadBusy: false,
      outcome: null,
      finishedAt: 0,
      waiters: new Set(),
    }
    this.jobs.set(id, job)
    this.queue.push(job)
    this.log.info('muse_media_job_queued', { jobId: id, userId, kind: spec.kind })
    this.pump()
    return id
  }

  /** Status for the owner; waits up to waitMs for a terminal state. Null = not found. */
  async view(userId: string, jobId: string, waitMs: number): Promise<MuseJobView | null> {
    const job = this.jobs.get(jobId)
    if (!job || job.userId !== userId) {
      const rec = await this.store.findJob(userId, jobId)
      if (!rec) return null
      return {
        job_id: rec.id,
        kind: rec.kind,
        status: rec.status,
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
  fileFor(userId: string, jobId: string, idx: number): { path: string; file: MuseFileView } | null {
    const job = this.jobs.get(jobId)
    if (!job || job.userId !== userId || !job.outcome?.ok) return null
    const file = job.outcome.files.find((f) => f.idx === idx)
    if (!file) return null
    return { path: join(this.root, job.id, `${idx}.bin`), file }
  }

  // ── internals ────────────────────────────────────────────────────────────

  tick(): void {
    const now = this.now()
    if (!this.bridgeOnline()) {
      for (const job of [...this.queue]) {
        this.finish(job, fail('MUSE_BRIDGE_OFFLINE', 'the Muse bridge disconnected'))
      }
    }
    const a = this.active
    if (a?.state === 'dispatched' && now - a.dispatchedAt > ACK_TIMEOUT_MS) {
      if (a.dispatchCount >= MAX_DISPATCH_ATTEMPTS) {
        this.log.warn('muse_job_ack_timeout_failed', {
          jobId: a.id,
          attempt: a.dispatchCount,
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
    } else if (a?.state === 'running') {
      if (now - a.lastBeatAt > HEARTBEAT_LOST_MS) {
        this.finish(a, fail('MUSE_BRIDGE_LOST', 'lost contact with the bridge during the job'))
      } else if (now > a.deadlineAt) {
        this.finish(a, fail('MUSE_TIMEOUT', 'the job exceeded its deadline', true))
      }
    }
    for (const job of [...this.queue]) {
      if (now - job.queuedAt > QUEUE_WAIT_MS) {
        this.finish(job, fail('MUSE_BUSY', 'waited too long in the Muse queue', true))
      }
    }
    for (const [id, job] of this.jobs) {
      if (job.state === 'done' && now - job.finishedAt > DONE_RETAIN_MS) {
        this.jobs.delete(id)
        void rm(join(this.root, id), { recursive: true, force: true })
      }
    }
  }

  private takeNext(): HubJob | null {
    if (this.active || this.queue.length === 0) return null
    const job = this.queue.shift()!
    const now = this.now()
    job.state = 'dispatched'
    job.nonce = randomUUID()
    job.dispatchedAt = now
    job.deadlineAt = now + jobDeadlineMs(job.spec)
    job.dispatchCount += 1
    this.active = job
    return job
  }

  private pump(): void {
    if (!this.waiter) return
    const job = this.takeNext()
    if (!job) return
    const w = this.waiter
    this.waiter = null
    clearTimeout(w.timer)
    w.resolve(job)
  }

  private requeue(job: HubJob): void {
    if (job.state !== 'dispatched') return
    if (this.active === job) this.active = null
    job.state = 'queued'
    job.nonce = randomUUID()
    this.queue.unshift(job)
    this.pump()
  }

  private clearWaiter(): void {
    const w = this.waiter
    if (!w) return
    this.waiter = null
    clearTimeout(w.timer)
    w.resolve(null)
  }

  private requireActive(jobId: string, nonce: string): HubJob {
    const job = this.jobs.get(jobId)
    if (!job || job !== this.active || job.state === 'done' || !nonce || job.nonce !== nonce) {
      throw new MuseError(410, 'JOB_GONE', 'unknown, finished or reassigned job')
    }
    return job
  }

  private requireRunning(jobId: string, nonce: string): HubJob {
    const job = this.requireActive(jobId, nonce)
    if (job.state !== 'running') throw new MuseError(410, 'JOB_GONE', 'job was not acknowledged')
    return job
  }

  private finish(job: HubJob, outcome: Outcome): void {
    if (job.state === 'done') return
    job.state = 'done'
    job.outcome = outcome
    job.finishedAt = this.now()
    job.spec = { ...job.spec, source_images: undefined }
    job.sources = []
    if (this.active === job) this.active = null
    const qi = this.queue.indexOf(job)
    if (qi >= 0) this.queue.splice(qi, 1)
    for (const w of [...job.waiters]) w()
    this.store
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
    if (!outcome.ok) void rm(join(this.root, job.id), { recursive: true, force: true })
    this.log.info('muse_media_job_finished', {
      jobId: job.id,
      kind: job.spec.kind,
      ok: outcome.ok,
      code: outcome.ok ? null : outcome.code,
      bytes: outcome.ok ? outcome.files.reduce((s, f) => s + f.bytes, 0) : 0,
    })
    this.pump()
  }

  private viewOf(job: HubJob): MuseJobView {
    const base = { job_id: job.id, kind: job.spec.kind }
    if (job.state === 'queued' || job.state === 'dispatched') {
      const pos = this.queue.indexOf(job)
      return { ...base, status: 'queued', queue_position: pos < 0 ? 0 : pos + 1 }
    }
    if (job.state === 'running') return { ...base, status: 'running' }
    const o = job.outcome!
    if (o.ok) return { ...base, status: 'succeeded', files: o.files, snapshot_id: o.snapshotId }
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
    const wire: MuseWireJob = {
      id: job.id,
      nonce: job.nonce,
      kind: s.kind,
      prompt: s.prompt,
      orientation: s.orientation ?? null,
      aspect_ratio: s.aspect_ratio ?? null,
      image_format: s.kind === 'image' ? (s.image_format ?? null) : null,
      timeout_secs: this.cliTimeoutSec[s.kind],
      ...(supportsSourceRefs(this.session?.version ?? null)
        ? { source_refs: job.sources.map(({ ref }) => ref) }
        : {
            source_images: s.source_images?.length
              ? s.source_images.map((b) => ({ base64: b }))
              : null,
          }),
      resume_snapshot_id: s.resume_snapshot_id ?? null,
      deadline_at: new Date(job.deadlineAt).toISOString(),
    }
    job.claimResponseBytes = Buffer.byteLength(JSON.stringify({ job: wire }))
    return wire
  }
}

function fail(code: string, message: string, retryable = false): Outcome {
  return { ok: false, status: 'failed', code, message, retryable, upstreamCode: null }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v))
}
