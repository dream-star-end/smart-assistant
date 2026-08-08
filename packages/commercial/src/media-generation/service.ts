import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { basename, extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type {
  MediaGenerationJob,
  VideoProject,
  VideoProjectShot,
} from '@openclaude/protocol/mediaGeneration'
import { rootLogger } from '../logging/logger.js'
import {
  type CreateProjectInput,
  type MediaInputRow,
  type MediaJobRow,
  acceptStaleShot,
  cancelProject,
  claimNextJob,
  completeJob,
  createComposeJob,
  createMediaJob,
  createProject,
  failJob,
  getInput,
  getJob,
  getProject,
  insertInput,
  listAckPendingJobs,
  listJobInputs,
  listJobs,
  listProjectShots,
  listProjects,
  listRecoverableJobs,
  markSubmitStarted,
  markWorkerAcked,
  markWorkerStagingStarted,
  queuePosition,
  regenerateShot,
  requestCancel,
  rotateRecoverableAttempt,
  startProject,
  updateActiveJob,
  updateDraftProject,
  userStoredInputBytes,
  withJobExecutionLease,
  withMediaInputLease,
} from './store.js'
import {
  MediaWorkerClient,
  MediaWorkerHttpError,
  type WorkerStatus,
  type WorkerUpload,
} from './workerClient.js'

const TERMINAL = new Set(['completed', 'failed', 'canceled'])
const INPUT_KINDS = new Set<MediaInputRow['kind']>([
  'first_frame',
  'last_frame',
  'reference_image',
  'clip',
  'subtitle',
  'music',
])
const DEFAULT_MAX_INPUT_BYTES = 512 * 1024 * 1024
const DEFAULT_MAX_USER_STORED_INPUT_BYTES = 10 * 1024 * 1024 * 1024
const mediaLogger = rootLogger.child({ component: 'media-generation' })

type Broadcast = (
  userId: bigint,
  frame: { type: 'sys.media_job'; job: MediaGenerationJob; ts: number },
) => void

export interface MediaGenerationServiceOptions {
  workerUrl?: string
  workerToken?: string
  stateRoot?: string
  allowUserIds?: readonly string[]
  maxInputBytes?: number
  maxUserStoredInputBytes?: number
  broadcast?: Broadcast
}

export interface MediaGenerationSchedulerHandle {
  stop(): Promise<void> | void
  runNow(): Promise<void>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function positiveInteger(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (Number.isSafeInteger(value) && Number(value) > 0) return Number(value)
  throw new Error('invalid_steps')
}

function durationSeconds(options: Record<string, unknown>): 5 | 10 | 15 {
  const value = Number(options.durationSeconds ?? 5)
  if (value !== 5 && value !== 10 && value !== 15) throw new Error('invalid_duration')
  return value
}

function canvas(options: Record<string, unknown>): {
  aspect: string
  width: number
  height: number
} {
  const aspect = String(options.aspect ?? '16:9')
  if (aspect === '16:9') return { aspect, width: 608, height: 352 }
  if (aspect === '9:16') return { aspect, width: 352, height: 608 }
  if (aspect === '1:1') return { aspect, width: 480, height: 480 }
  throw new Error('invalid_aspect')
}

function frameCount(duration: 5 | 10 | 15): number {
  return duration === 5 ? 124 : duration === 10 ? 243 : 362
}

function projectDraft(body: Record<string, unknown>): {
  shots: CreateProjectInput['shots']
  options: Record<string, unknown>
  inputIds: string[] | undefined
} {
  const shots = Array.isArray(body.shots) ? body.shots.map((value) => asRecord(value)) : []
  if (shots.length === 0) throw new Error('project_shots_required')
  const parsedShots: CreateProjectInput['shots'] = shots.map((shot) => {
    const prompt = typeof shot.prompt === 'string' ? shot.prompt.trim() : ''
    const duration = Number(shot.durationSeconds ?? 5)
    if (!prompt || (duration !== 5 && duration !== 10 && duration !== 15))
      throw new Error('invalid_project_shot')
    return {
      prompt,
      durationSeconds: duration,
      options: asRecord(shot.options),
    } as CreateProjectInput['shots'][number]
  })
  const options = asRecord(body.options)
  canvas(options)
  positiveInteger(options.steps, 20)
  for (const shot of parsedShots) {
    const merged: Record<string, unknown> = {
      ...options,
      ...(shot.options ?? {}),
      durationSeconds: shot.durationSeconds,
    }
    canvas(merged)
    const steps = positiveInteger(merged.steps, 20)
    if (steps > 1000) throw new Error('steps_exceed_worker_contract')
  }
  const inputIds = Array.isArray(body.inputIds)
    ? body.inputIds.filter((value): value is string => typeof value === 'string')
    : undefined
  return { shots: parsedShots, options, inputIds }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

export class MediaGenerationService {
  private readonly root: string
  private readonly worker: MediaWorkerClient | null
  private readonly allowed: Set<string>
  private readonly maxInputBytes: number
  private readonly maxUserStoredInputBytes: number
  private readonly broadcast?: Broadcast
  private readonly running = new Map<string, Promise<void>>()
  private schedulerAbort: AbortController | null = null
  private stopped = false

  constructor(options: MediaGenerationServiceOptions) {
    this.root = options.stateRoot ?? '/var/lib/openclaude-v5/media-generation'
    this.worker =
      options.workerUrl && options.workerToken
        ? new MediaWorkerClient(options.workerUrl.replace(/\/$/, ''), options.workerToken)
        : null
    this.allowed = new Set(options.allowUserIds ?? [])
    this.maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES
    this.maxUserStoredInputBytes =
      options.maxUserStoredInputBytes ?? DEFAULT_MAX_USER_STORED_INPUT_BYTES
    if (
      !Number.isSafeInteger(this.maxInputBytes) ||
      this.maxInputBytes < 1 ||
      !Number.isSafeInteger(this.maxUserStoredInputBytes) ||
      this.maxUserStoredInputBytes < this.maxInputBytes
    )
      throw new Error('invalid_media_storage_limits')
    this.broadcast = options.broadcast
  }

  configured(): boolean {
    return this.worker !== null
  }

  availableTo(userId: string): boolean {
    return this.worker !== null && this.allowed.has(userId)
  }

  assertAvailable(userId: string): void {
    if (!this.worker) throw new Error('media_generation_not_configured')
    if (!this.allowed.has(userId)) throw new Error('media_generation_not_enabled')
  }

  async capabilities(userId: string): Promise<Record<string, unknown>> {
    if (!this.availableTo(userId)) return { available: false }
    try {
      return {
        available: true,
        limits: {
          maxInputBytes: this.maxInputBytes,
          maxUserStoredInputBytes: this.maxUserStoredInputBytes,
        },
        worker: (await this.worker!.capabilities()) as Record<string, unknown>,
      }
    } catch {
      return {
        available: true,
        workerReachable: false,
        limits: {
          maxInputBytes: this.maxInputBytes,
          maxUserStoredInputBytes: this.maxUserStoredInputBytes,
        },
      }
    }
  }

  async ingestInput(
    userId: string,
    req: IncomingMessage,
    metadata: { kind: string; filename: string; mime: string; sha256: string; size: number },
  ): Promise<MediaInputRow> {
    this.assertAvailable(userId)
    if (!INPUT_KINDS.has(metadata.kind as MediaInputRow['kind']))
      throw new Error('invalid_input_kind')
    if (
      !/^[0-9a-f]{64}$/.test(metadata.sha256) ||
      !Number.isSafeInteger(metadata.size) ||
      metadata.size < 0
    ) {
      throw new Error('invalid_input_manifest')
    }
    if (
      ['first_frame', 'last_frame', 'reference_image'].includes(metadata.kind) &&
      !metadata.mime.startsWith('image/')
    ) {
      throw new Error('invalid_image_input_mime')
    }
    if (metadata.kind === 'clip' && !metadata.mime.startsWith('video/'))
      throw new Error('invalid_video_input_mime')
    if (metadata.size > this.maxInputBytes) throw new Error('media_input_file_quota_exceeded')
    return withMediaInputLease(userId, async () => {
      const stored = await userStoredInputBytes(userId)
      if (stored + metadata.size > this.maxUserStoredInputBytes)
        throw new Error('media_input_user_quota_exceeded')
      const filename = basename(metadata.filename).replace(/[^A-Za-z0-9._-]/g, '_') || 'input.bin'
      const extension = extname(filename).slice(0, 16)
      const id = randomUUID()
      const workerFilename = `${id}-${metadata.sha256.slice(0, 12)}${extension}`
      const directory = join(this.root, 'inputs', userId)
      await mkdir(directory, { recursive: true })
      const target = join(directory, id)
      const temporary = `${target}.part`
      const handle = await open(temporary, 'wx')
      const hash = createHash('sha256')
      let written = 0
      try {
        for await (const chunk of req) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          if (written + bytes.length > metadata.size) throw new Error('input_size_exceeded')
          written += bytes.length
          hash.update(bytes)
          await handle.write(bytes)
        }
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      } finally {
        await handle.close()
      }
      if (written !== metadata.size || hash.digest('hex') !== metadata.sha256) {
        await rm(temporary, { force: true })
        throw new Error('input_integrity_mismatch')
      }
      await open(temporary, 'r').then(async (file) => {
        await file.sync()
        await file.close()
      })
      await rename(temporary, target)
      const input: MediaInputRow = {
        id,
        userId,
        sha256: metadata.sha256,
        sizeBytes: metadata.size,
        mime: metadata.mime,
        filename,
        workerFilename,
        kind: metadata.kind as MediaInputRow['kind'],
        storagePath: target,
      }
      try {
        await insertInput(input)
      } catch (error) {
        await rm(target, { force: true })
        throw error
      }
      return input
    })
  }

  async createJob(userId: string, body: Record<string, unknown>): Promise<MediaGenerationJob> {
    this.assertAvailable(userId)
    const requestId =
      typeof body.requestId === 'string' && body.requestId ? body.requestId : randomUUID()
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt) throw new Error('prompt_required')
    const options = asRecord(body.options)
    durationSeconds(options)
    canvas(options)
    if (positiveInteger(options.steps, 20) > 1000) throw new Error('steps_exceed_worker_contract')
    const inputIds = Array.isArray(body.inputIds)
      ? body.inputIds.filter((value): value is string => typeof value === 'string')
      : []
    await this.validateConditioningInputs(userId, inputIds)
    const job = await createMediaJob({
      userId,
      requestId,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
      prompt,
      options,
      inputIds,
    })
    await this.emit(job)
    return this.dto(job)
  }

  async createVideoProject(userId: string, body: Record<string, unknown>): Promise<VideoProject> {
    this.assertAvailable(userId)
    const draft = projectDraft(body)
    const inputIds = draft.inputIds ?? []
    await this.validateConditioningInputs(userId, inputIds)
    const projectId = await createProject({
      userId,
      requestId:
        typeof body.requestId === 'string' && body.requestId ? body.requestId : randomUUID(),
      title:
        typeof body.title === 'string' && body.title.trim() ? body.title.trim() : '未命名视频项目',
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
      inputIds,
      options: draft.options,
      shots: draft.shots,
    })
    const project = await this.projectDto(userId, projectId)
    if (!project) throw new Error('project_create_failed')
    return project
  }

  async editVideoProject(
    userId: string,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<VideoProject> {
    this.assertAvailable(userId)
    const expectedRev = Number(body.expectedRev)
    if (!Number.isSafeInteger(expectedRev) || expectedRev < 1)
      throw new Error('expected_rev_required')
    const draft = projectDraft(body)
    if (draft.inputIds) await this.validateConditioningInputs(userId, draft.inputIds)
    const title =
      typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined
    await updateDraftProject({
      userId,
      projectId,
      expectedRev,
      title,
      inputIds: draft.inputIds,
      options: draft.options,
      shots: draft.shots,
    })
    const project = await this.projectDto(userId, projectId)
    if (!project) throw new Error('project_not_found')
    return project
  }

  async startVideoProject(
    userId: string,
    projectId: string,
    expectedRev: number,
  ): Promise<VideoProject> {
    this.assertAvailable(userId)
    if (!Number.isSafeInteger(expectedRev) || expectedRev < 1)
      throw new Error('expected_rev_required')
    const jobs = await startProject(userId, projectId, expectedRev)
    for (const job of jobs) await this.emit(job)
    const project = await this.projectDto(userId, projectId)
    if (!project) throw new Error('project_not_found')
    return project
  }

  async getJobDto(userId: string, jobId: string): Promise<MediaGenerationJob | null> {
    this.assertAvailable(userId)
    const job = await getJob(userId, jobId)
    return job ? this.dto(job) : null
  }

  async listJobDtos(
    userId: string,
    cursor?: string,
    pageSize?: number,
  ): Promise<{
    jobs: MediaGenerationJob[]
    nextCursor: string | null
  }> {
    this.assertAvailable(userId)
    const size = pageSize === undefined ? 50 : pageSize
    if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw new Error('invalid_page_size')
    const page = await listJobs(userId, cursor, size)
    return {
      jobs: await Promise.all(page.jobs.map((job) => this.dto(job))),
      nextCursor: page.nextCursor,
    }
  }

  async listProjectDtos(
    userId: string,
    cursor?: string,
    pageSize?: number,
  ): Promise<{
    projects: VideoProject[]
    nextCursor: string | null
  }> {
    this.assertAvailable(userId)
    const size = pageSize === undefined ? 20 : pageSize
    if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw new Error('invalid_page_size')
    const page = await listProjects(userId, cursor, size)
    const values = await Promise.all(
      page.projects.map((project) => this.projectDto(userId, project.id)),
    )
    return {
      projects: values.filter((value): value is VideoProject => value !== null),
      nextCursor: page.nextCursor,
    }
  }

  async projectDto(userId: string, projectId: string): Promise<VideoProject | null> {
    this.assertAvailable(userId)
    const project = await getProject(userId, projectId)
    if (!project) return null
    const shotRows = await listProjectShots(userId, projectId)
    const shots: VideoProjectShot[] = await Promise.all(
      shotRows.map(async (shot) => {
        const active = shot.active_media_job_id
          ? await getJob(userId, shot.active_media_job_id)
          : null
        return {
          id: shot.id,
          ordinal: shot.ordinal,
          prompt: shot.prompt,
          durationSeconds: shot.duration_seconds,
          activeJobId: shot.active_media_job_id,
          activeJob: active ? await this.dto(active) : null,
          stale: Boolean(shot.stale_at),
        }
      }),
    )
    const compose = project.current_compose_job_id
      ? await getJob(userId, project.current_compose_job_id)
      : null
    const activeStatuses = new Set(['queued', 'dispatching', 'running', 'reconnecting'])
    let status: VideoProject['status'] = 'draft'
    if (project.canceled_at) status = 'canceled'
    else if (compose?.status === 'completed') status = 'completed'
    else if (compose && activeStatuses.has(compose.status)) status = 'rendering'
    else if (compose?.status === 'failed') status = 'failed'
    else if (shots.some((shot) => shot.activeJob && activeStatuses.has(shot.activeJob.status)))
      status = 'generating'
    else if (shots.some((shot) => shot.activeJob?.status === 'failed')) status = 'failed'
    else if (shots.some((shot) => shot.stale)) status = 'needs_review'
    else if (shots.length > 0 && shots.every((shot) => shot.activeJob?.status === 'completed'))
      status = 'ready'
    return {
      id: project.id,
      title: project.title,
      rev: project.rev,
      status,
      currentComposeJobId: project.current_compose_job_id,
      shots,
      createdAt: project.created_at.toISOString(),
      updatedAt: project.updated_at.toISOString(),
    }
  }

  async renderProject(
    userId: string,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<MediaGenerationJob> {
    this.assertAvailable(userId)
    const expectedRev = Number(body.expectedRev)
    if (!Number.isSafeInteger(expectedRev) || expectedRev < 1)
      throw new Error('expected_rev_required')
    const options = asRecord(body.options)
    if (Object.keys(options).some((key) => key !== 'mode'))
      throw new Error('unsupported_compose_option')
    if (options.mode !== undefined && options.mode !== 'normalize' && options.mode !== 'copy')
      throw new Error('unsupported_compose_mode')
    const job = await createComposeJob(
      userId,
      projectId,
      expectedRev,
      typeof body.requestId === 'string' && body.requestId ? body.requestId : randomUUID(),
      options,
    )
    await this.emit(job)
    return this.dto(job)
  }

  async regenerateProjectShot(
    userId: string,
    projectId: string,
    shotId: string,
    body: Record<string, unknown>,
  ): Promise<MediaGenerationJob> {
    this.assertAvailable(userId)
    const expectedRev = Number(body.expectedRev)
    if (!Number.isSafeInteger(expectedRev) || expectedRev < 1)
      throw new Error('expected_rev_required')
    const job = await regenerateShot(
      userId,
      projectId,
      shotId,
      expectedRev,
      typeof body.requestId === 'string' && body.requestId ? body.requestId : randomUUID(),
    )
    await this.emit(job)
    return this.dto(job)
  }

  async acceptProjectShot(
    userId: string,
    projectId: string,
    shotId: string,
    expectedRev: number,
  ): Promise<void> {
    this.assertAvailable(userId)
    await acceptStaleShot(userId, projectId, shotId, expectedRev)
  }

  async cancelJob(userId: string, jobId: string): Promise<MediaGenerationJob | null> {
    this.assertAvailable(userId)
    const job = await requestCancel(userId, jobId)
    if (job) await this.emit(job)
    return job ? this.dto(job) : null
  }

  async cancelVideoProject(userId: string, projectId: string, expectedRev: number): Promise<void> {
    this.assertAvailable(userId)
    if (!Number.isSafeInteger(expectedRev) || expectedRev < 1)
      throw new Error('expected_rev_required')
    await cancelProject(userId, projectId, expectedRev)
  }

  async result(
    userId: string,
    jobId: string,
  ): Promise<{ path: string; sha256: string; size: number } | null> {
    this.assertAvailable(userId)
    const job = await getJob(userId, jobId)
    if (
      !job ||
      job.status !== 'completed' ||
      !job.resultPath ||
      !job.resultSha256 ||
      job.resultSize === null
    )
      return null
    return { path: job.resultPath, sha256: job.resultSha256, size: job.resultSize }
  }

  start(intervalMs = 2_000): MediaGenerationSchedulerHandle {
    if (!this.worker) return { stop() {}, runNow: async () => {} }
    this.stopped = false
    const schedulerAbort = new AbortController()
    this.schedulerAbort = schedulerAbort
    let activeTick: Promise<void> | null = null
    const runNow = async () => {
      if (activeTick) return activeTick
      if (this.stopped) return
      const tick = (async () => {
        await this.recover(schedulerAbort.signal)
        if (this.stopped) return
        await this.reconcileAcks(schedulerAbort.signal)
        if (this.stopped) return
        for (const resource of ['gpu-h3', 'cpu-compose'] as const) {
          const job = await claimNextJob(resource)
          if (job) this.launch(job, schedulerAbort.signal)
        }
      })()
      activeTick = tick
      try {
        await tick
      } finally {
        if (activeTick === tick) activeTick = null
      }
    }
    const runScheduled = (): void => {
      void runNow().catch((error) => this.reportSchedulerError('tick', error))
    }
    const timer = setInterval(runScheduled, Math.max(1_000, intervalMs))
    timer.unref?.()
    runScheduled()
    return {
      stop: async () => {
        this.stopped = true
        clearInterval(timer)
        schedulerAbort.abort()
        await activeTick
        await Promise.all(this.running.values())
        if (this.schedulerAbort === schedulerAbort) this.schedulerAbort = null
      },
      runNow,
    }
  }

  private launch(job: MediaJobRow, signal: AbortSignal): void {
    if (this.running.has(job.id)) return
    const run = withJobExecutionLease(job, () => this.runJob(job, signal))
      .then(() => undefined)
      .catch((error) => this.reportSchedulerError('job', error, job.id))
      .finally(() => this.running.delete(job.id))
    this.running.set(job.id, run)
  }

  private async recover(signal: AbortSignal): Promise<void> {
    for (const job of await listRecoverableJobs()) this.launch(job, signal)
  }

  private async reconcileAcks(signal: AbortSignal): Promise<void> {
    for (const job of await listAckPendingJobs()) {
      if (this.running.has(job.id)) continue
      const run = withJobExecutionLease(job, () => this.ackWorkerResult(job, signal))
        .then(() => undefined)
        .catch((error) => this.reportSchedulerError('ack', error, job.id))
        .finally(() => this.running.delete(job.id))
      this.running.set(job.id, run)
    }
  }

  private async ackWorkerResult(job: MediaJobRow, signal: AbortSignal): Promise<void> {
    if (!this.worker || !job.attemptId || this.stopped) return
    try {
      await this.worker.ack(job, signal)
      await markWorkerAcked(job.id, job.attemptId)
    } catch (error) {
      if (error instanceof MediaWorkerHttpError && error.status === 404) {
        // A plain 404 does not prove the exact attempt tombstone was released;
        // keep the durable ACK outbox pending for reconciliation.
        return
      }
      if (
        !(error instanceof MediaWorkerHttpError) ||
        error.status !== 409 ||
        error.code !== 'attempt_not_terminal'
      )
        return
      try {
        const canceled = await this.worker.cancel(job, signal)
        if (!TERMINAL.has(canceled.status)) return
        await this.worker.ack(job, signal)
        await markWorkerAcked(job.id, job.attemptId)
      } catch (cancelError) {
        if (cancelError instanceof MediaWorkerHttpError && cancelError.status === 404) return
      }
    }
  }

  private async terminalizeJob(
    job: MediaJobRow,
    status: 'failed' | 'canceled',
    code: string,
    message: string,
    signal: AbortSignal,
  ): Promise<void> {
    const terminal = await failJob(job, status, code, message)
    if (!terminal) return
    await this.emit(terminal)
    if (terminal.workerAckPending) await this.ackWorkerResult(terminal, signal)
  }

  private reportSchedulerError(stage: string, error: unknown, jobId?: string): void {
    mediaLogger.error('media generation scheduler operation failed', {
      stage,
      jobId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  private async runJob(initial: MediaJobRow, signal: AbortSignal): Promise<void> {
    if (!this.worker || !initial.attemptId) return
    let job = initial
    await this.emit(job)
    let request: Record<string, unknown>
    let uploads: WorkerUpload[]
    try {
      if (job.kind === 'h3_generate') {
        const inputs = await listJobInputs(job.userId, job.id)
        uploads = inputs.map((input) => ({
          storagePath: input.storagePath,
          sha256: input.sha256,
          sizeBytes: input.sizeBytes,
          mime: input.mime,
          kind: input.kind,
          workerFilename: input.workerFilename,
        }))
        let continuity = false
        if (job.predecessorJobId) {
          const predecessor = await getJob(job.userId, job.predecessorJobId)
          if (
            !predecessor?.resultPath ||
            !predecessor.resultSha256 ||
            predecessor.resultSize === null ||
            predecessor.resultSha256 !== job.predecessorArtifactSha256
          ) {
            throw new Error('predecessor_artifact_changed')
          }
          uploads.push({
            storagePath: predecessor.resultPath,
            sha256: predecessor.resultSha256,
            sizeBytes: predecessor.resultSize,
            mime: 'video/mp4',
            kind: 'clip',
            workerFilename: 'continuity-source.mp4',
          })
          continuity = true
        }
        request = { prompt: this.buildH3Prompt(job, inputs, continuity) }
      } else {
        const manifest = Array.isArray(job.composeManifest) ? job.composeManifest.map(asRecord) : []
        uploads = manifest.map((item, ordinal) => ({
          storagePath: String(item.path),
          sha256: String(item.sha256),
          sizeBytes: Number(item.size),
          mime: 'video/mp4',
          kind: 'clip',
          workerFilename: `shot-${String(ordinal).padStart(4, '0')}.mp4`,
        }))
        request = {
          mode: 'normalize',
          manifest: manifest.map((item) => ({
            shotId: item.shotId,
            jobId: item.jobId,
            sha256: item.sha256,
          })),
          ...job.options,
        }
      }
    } catch (error) {
      await this.terminalizeJob(job, 'failed', 'invalid_job_contract', String(error), signal)
      return
    }

    let submitted = false
    let workerKnown = false
    for (;;) {
      if (this.stopped) return
      const fresh = await getJob(job.userId, job.id)
      if (!fresh || fresh.attemptId !== job.attemptId || TERMINAL.has(fresh.status)) return
      job = fresh
      try {
        if (job.cancelRequestedAt) {
          if (!job.workerStagingStartedAt && !job.submitStartedAt && !job.requestDigest) {
            await this.terminalizeJob(job, 'canceled', 'user_canceled', 'canceled by user', signal)
            return
          }
          let canceled: WorkerStatus
          try {
            canceled = await this.worker.cancel(job, signal)
          } catch (error) {
            if (error instanceof MediaWorkerHttpError && error.status === 404) {
              const unknown = await updateActiveJob(job.id, job.attemptId!, {
                status: 'reconnecting',
                phase: 'worker_cancel_state_unknown',
              })
              if (unknown) {
                job = unknown
                await this.emit(unknown)
              }
              await new Promise((resolve) => setTimeout(resolve, 3_000))
              continue
            }
            throw error
          }
          if (canceled.status === 'canceled') {
            await this.terminalizeJob(job, 'canceled', 'user_canceled', 'canceled by user', signal)
            return
          }
        }
        if (!workerKnown) {
          try {
            const status = await this.worker.status(job, signal)
            workerKnown = true
            if (job.requestDigest && status.request_digest !== job.requestDigest) {
              await this.terminalizeJob(
                job,
                'failed',
                'worker_contract_mismatch',
                'worker request digest changed',
                signal,
              )
              return
            }
            submitted = status.status !== 'staging'
            if (status.request_digest && status.request_digest !== job.requestDigest) {
              const attached = await updateActiveJob(job.id, job.attemptId!, {
                requestDigest: status.request_digest,
              })
              if (attached) job = attached
            }
            const updated = await this.syncWorkerStatus(job, status)
            if (updated) job = updated
          } catch (error) {
            if (
              error instanceof MediaWorkerHttpError &&
              error.status === 404 &&
              !job.requestDigest &&
              !job.submitStartedAt
            ) {
              workerKnown = true
            } else {
              throw error
            }
          }
        }
        if (!submitted) {
          const staging = await markWorkerStagingStarted(job.id, job.attemptId!)
          if (!staging) return
          job = staging
          for (const [ordinal, upload] of uploads.entries())
            await this.worker.upload(job, ordinal, upload, signal)
          const marked = await markSubmitStarted(job.id, job.attemptId!)
          if (!marked) return
          job = marked
          const accepted = await this.worker.submit(job, request, signal)
          submitted = true
          const updated = await updateActiveJob(job.id, job.attemptId!, {
            status: accepted.status === 'running' ? 'running' : 'dispatching',
            phase: accepted.phase,
            requestDigest: accepted.request_digest,
            currentStep: accepted.current_step,
            totalSteps: accepted.total_steps,
          })
          if (updated) {
            job = updated
            await this.emit(updated)
          }
        }
        const worker = await this.worker.status(job, signal)
        const updated = await this.syncWorkerStatus(job, worker)
        if (updated) job = updated
        if (worker.status === 'completed') {
          const target = join(this.root, 'results', job.userId, `${job.id}.mp4`)
          try {
            const result = await this.worker.download(job, target, signal)
            const actual = await stat(target)
            const digest = await sha256File(target)
            if (actual.size !== result.size || digest !== result.sha256) {
              await rm(target, { force: true })
              throw new Error('downloaded_result_integrity_mismatch')
            }
            const completed = await completeJob(job, {
              path: target,
              sha256: digest,
              size: actual.size,
            })
            if (!completed) return
            await this.emit(completed)
            try {
              await this.worker.ack(job, signal)
              await markWorkerAcked(completed.id, completed.attemptId!)
            } catch {
              /* worker_ack_pending remains durable and the scheduler reconciles it */
            }
            return
          } catch (error) {
            // completeJob may have committed even if the client observed a
            // connection failure. Reconcile before deleting the local result;
            // a committed DB row is the sole authority that permits ACK.
            let durable: MediaJobRow | null = null
            try {
              durable = await getJob(job.userId, job.id)
            } catch {
              mediaLogger.warn('could not reconcile media completion after persistence error', {
                jobId: job.id,
              })
              await new Promise((resolve) => setTimeout(resolve, 1_000))
              continue
            }
            if (durable?.status === 'completed') {
              await this.emit(durable)
              try {
                await this.worker.ack(durable, signal)
                await markWorkerAcked(durable.id, durable.attemptId!)
              } catch {
                /* durable ACK outbox will reconcile */
              }
              return
            }
            await rm(target, { force: true }).catch(() => {})
            const pending = await updateActiveJob(job.id, job.attemptId!, {
              status: 'reconnecting',
              phase: 'result_pending',
            })
            if (pending) {
              job = pending
              await this.emit(pending)
            }
            mediaLogger.warn('worker result remains pending after local persistence failure', {
              jobId: job.id,
              error: error instanceof Error ? error.message : String(error),
            })
            await new Promise((resolve) => setTimeout(resolve, 1_000))
            continue
          }
        }
        if (worker.status === 'failed' || worker.status === 'canceled') {
          if (
            worker.status === 'failed' &&
            worker.error_code === 'worker_lost' &&
            worker.recovery_disposition === 'definitive_retry_safe' &&
            Boolean(worker.cleanup_proven) &&
            Boolean(job.requestDigest) &&
            worker.request_digest === job.requestDigest &&
            worker.attempt_id === job.attemptId &&
            worker.fence_version === job.fenceVersion &&
            typeof worker.origin_release === 'string' &&
            worker.origin_release.length > 0
          ) {
            try {
              await this.worker.ack(job, signal)
              const rotated = await rotateRecoverableAttempt(job)
              if (rotated) await this.emit(rotated)
            } catch (error) {
              const reconnecting = await updateActiveJob(job.id, job.attemptId!, {
                status: 'reconnecting',
                phase: 'worker_retry_proof_pending',
              })
              if (reconnecting) await this.emit(reconnecting)
              mediaLogger.warn('definitive worker retry proof remains pending', {
                jobId: job.id,
                error: error instanceof Error ? error.message : String(error),
              })
            }
            // The old attempt lease must be released before the scheduler
            // claims the rotated attempt; never recurse in this stack.
            return
          }
          await this.terminalizeJob(
            job,
            worker.status === 'canceled' ? 'canceled' : 'failed',
            worker.error_code ?? worker.status,
            worker.error_message ?? worker.status,
            signal,
          )
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      } catch (error) {
        if (this.stopped || signal.aborted) return
        if (
          error instanceof MediaWorkerHttpError &&
          error.status === 404 &&
          (submitted || job.requestDigest || job.submitStartedAt)
        ) {
          workerKnown = false
          const unknown = await updateActiveJob(job.id, job.attemptId!, {
            status: 'reconnecting',
            phase: 'worker_state_unknown',
          })
          if (unknown) {
            job = unknown
            await this.emit(unknown)
          }
          await new Promise((resolve) => setTimeout(resolve, 3_000))
          continue
        }
        if (
          (error instanceof MediaWorkerHttpError && error.status >= 400 && error.status < 500) ||
          (!(error instanceof MediaWorkerHttpError) &&
            !(error instanceof TypeError) &&
            !(error instanceof DOMException))
        ) {
          await this.terminalizeJob(
            job,
            'failed',
            'media_job_execution_failed',
            String(error),
            signal,
          )
          return
        }
        if (!submitted && job.submitStartedAt) workerKnown = false
        const reconnecting = await updateActiveJob(job.id, job.attemptId!, {
          status: 'reconnecting',
          phase: 'reconnecting',
        })
        if (reconnecting) {
          job = reconnecting
          await this.emit(reconnecting)
        }
        await new Promise((resolve) => setTimeout(resolve, 3_000))
      }
    }
  }

  private async syncWorkerStatus(
    job: MediaJobRow,
    worker: WorkerStatus,
  ): Promise<MediaJobRow | null> {
    if (worker.status === 'completed' || worker.status === 'failed' || worker.status === 'canceled')
      return null
    const status = worker.status === 'running' ? 'running' : 'dispatching'
    const updated = await updateActiveJob(job.id, job.attemptId!, {
      status,
      phase: worker.phase,
      currentStep: worker.current_step,
      totalSteps: worker.total_steps,
    })
    if (
      updated &&
      (updated.phase !== job.phase ||
        updated.currentStep !== job.currentStep ||
        updated.status !== job.status)
    )
      await this.emit(updated)
    return updated
  }

  private buildH3Prompt(
    job: MediaJobRow,
    inputs: MediaInputRow[],
    continuity: boolean,
  ): Record<string, unknown> {
    const duration = durationSeconds(job.options)
    const { width, height } = canvas(job.options)
    const steps = positiveInteger(job.options.steps, 20)
    if (steps > 1000) throw new Error('steps_exceed_worker_contract')
    const seed =
      typeof job.options.seed === 'number' && Number.isSafeInteger(job.options.seed)
        ? job.options.seed
        : Number(
            BigInt(`0x${createHash('sha256').update(job.id).digest('hex').slice(0, 16)}`) &
              0x1fffffffffffffn,
          )
    const nodes: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
      '1': {
        class_type: 'UNETLoader',
        inputs: {
          unet_name: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
          weight_dtype: 'default',
        },
      },
      '2': {
        class_type: 'CLIPLoader',
        inputs: {
          clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
          type: 'minimax',
          device: 'default',
        },
      },
      '3': {
        class_type: 'VAELoader',
        inputs: { vae_name: 'minimax_h3_video_vae_fp16.safetensors' },
      },
      '4': {
        class_type: 'VAELoader',
        inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' },
      },
      '6': { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
      '7': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
      '8': {
        class_type: 'BasicScheduler',
        inputs: { model: ['1', 0], scheduler: 'simple', steps, denoise: 1.0 },
      },
      '9': { class_type: 'BasicGuider', inputs: { model: ['1', 0], conditioning: ['5', 0] } },
      '10': {
        class_type: 'SamplerCustomAdvanced',
        inputs: {
          noise: ['6', 0],
          guider: ['9', 0],
          sampler: ['7', 0],
          sigmas: ['8', 0],
          latent_image: ['5', 1],
        },
      },
      '11': { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['3', 0] } },
      '12': { class_type: 'VAEDecodeAudio', inputs: { samples: ['10', 0], vae: ['4', 0] } },
      '13': {
        class_type: 'CreateVideo',
        inputs: { images: ['11', 0], audio: ['12', 0], fps: 24.0, bit_depth: 8 },
      },
      '14': {
        class_type: 'SaveVideo',
        inputs: {
          video: ['13', 0],
          filename_prefix: `video/${job.id}`,
          format: 'mp4',
          codec: 'auto',
        },
      },
    }
    const references = inputs.filter((input) => input.kind === 'reference_image')
    const first = inputs.find((input) => input.kind === 'first_frame')
    const last = inputs.find((input) => input.kind === 'last_frame')
    let nextId = 20
    const load = (filename: string): [string, number] => {
      const id = String(nextId++)
      nodes[id] = { class_type: 'LoadImage', inputs: { image: filename } }
      return [id, 0]
    }
    const firstRef = first
      ? load(first.workerFilename)
      : continuity
        ? load('continuity-last.png')
        : undefined
    const lastRef = last ? load(last.workerFilename) : undefined
    const referenceRefs = references.map((input) => load(input.workerFilename))
    if (references.length > 0) {
      const refImages = Object.fromEntries(
        referenceRefs.map((ref, index) => [`ref_image_${index}`, ref]),
      )
      const keyframeOffset = references.length
      const guidance = [
        references.length
          ? `Preserve the identity and style from ${references.map((_, index) => `<Picture ${index + 1}>`).join(', ')}.`
          : '',
        firstRef ? `Begin from <Picture ${keyframeOffset + 1}>.` : '',
        lastRef ? `End at <Picture ${keyframeOffset + (firstRef ? 2 : 1)}>.` : '',
      ]
        .filter(Boolean)
        .join(' ')
      nodes['5'] = {
        class_type: 'MiniMaxH3ReferenceToVideo',
        inputs: {
          clip: ['2', 0],
          vae: ['3', 0],
          audio_vae: ['4', 0],
          prompt: `${guidance} ${job.prompt}`.trim(),
          width,
          height,
          length: frameCount(duration),
          ref_image_size: 'match',
          ref_images: refImages,
          ...(firstRef ? { first_frame: firstRef } : {}),
          ...(lastRef ? { last_frame: lastRef } : {}),
        },
      }
    } else {
      nodes['5'] = {
        class_type: 'MiniMaxH3ImageToVideo',
        inputs: {
          clip: ['2', 0],
          vae: ['3', 0],
          prompt: job.prompt,
          width,
          height,
          length: frameCount(duration),
          ...(firstRef ? { first_frame: firstRef } : {}),
          ...(lastRef ? { last_frame: lastRef } : {}),
        },
      }
    }
    return nodes
  }

  private async dto(job: MediaJobRow): Promise<MediaGenerationJob> {
    const options = job.options ?? {}
    let duration: number | undefined
    let aspect: string | undefined
    if (job.kind === 'h3_generate') {
      try {
        duration = durationSeconds(options)
        aspect = canvas(options).aspect
      } catch {
        /* historic bad row */
      }
    }
    return {
      id: job.id,
      requestId: job.requestId,
      kind: job.kind,
      resourceClass: job.resourceClass,
      status: job.status,
      phase: job.phase,
      ...(job.prompt ? { prompt: job.prompt } : {}),
      sessionId: job.sessionId,
      projectId: job.projectId,
      projectShotId: job.projectShotId,
      ...(duration ? { durationSeconds: duration } : {}),
      ...(aspect ? { aspect } : {}),
      currentStep: job.currentStep,
      totalSteps: job.totalSteps,
      queuePosition: await queuePosition(job),
      resultUrl: null,
      resultSha256: job.resultSha256,
      resultSize: job.resultSize,
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    }
  }

  private async emit(job: MediaJobRow): Promise<void> {
    if (!this.broadcast) return
    this.broadcast(BigInt(job.userId), {
      type: 'sys.media_job',
      job: await this.dto(job),
      ts: Date.now(),
    })
  }

  private async validateConditioningInputs(userId: string, inputIds: string[]): Promise<void> {
    if (new Set(inputIds).size !== inputIds.length) throw new Error('duplicate_media_input')
    const values = await Promise.all(inputIds.map((inputId) => getInput(userId, inputId)))
    if (values.some((value) => !value)) throw new Error('media_input_not_found')
    const inputs = values.filter((value): value is MediaInputRow => value !== null)
    if (
      inputs.some((input) => !['first_frame', 'last_frame', 'reference_image'].includes(input.kind))
    ) {
      throw new Error('invalid_conditioning_input_kind')
    }
    if (inputs.filter((input) => input.kind === 'reference_image').length > 9)
      throw new Error('invalid_reference_image_count')
    if (
      inputs.filter((input) => input.kind === 'first_frame').length > 1 ||
      inputs.filter((input) => input.kind === 'last_frame').length > 1
    )
      throw new Error('duplicate_keyframe_input')
  }
}
