import { randomUUID } from 'node:crypto'
import type { MediaJobStatus } from '@openclaude/protocol/mediaGeneration'
import type { PoolClient } from 'pg'
import { getPool } from '../db/index.js'
import { query, tx } from '../db/queries.js'
import { getRuntimeChannel } from '../runtimeChannel.js'

const LOCK_KEY_HI = 0x4d_45_44_49 // MEDI
const LOCK_KEY_LO = 0x41_4a_4f_42 // AJOB

export type MediaJobKind = 'h3_generate' | 'video_compose'
export type MediaResourceClass = 'gpu-h3' | 'cpu-compose'

export interface MediaInputRow {
  id: string
  userId: string
  sha256: string
  sizeBytes: number
  mime: string
  filename: string
  workerFilename: string
  kind: 'first_frame' | 'last_frame' | 'reference_image' | 'clip' | 'subtitle' | 'music'
  storagePath: string
}

export interface MediaJobRow {
  id: string
  requestId: string
  userId: string
  runtimeChannel: string
  sessionId: string | null
  kind: MediaJobKind
  resourceClass: MediaResourceClass
  status: MediaJobStatus
  phase: string
  prompt: string | null
  options: Record<string, unknown>
  attemptId: string | null
  fenceVersion: number
  requestDigest: string | null
  workerStagingStartedAt: Date | null
  submitStartedAt: Date | null
  currentStep: number | null
  totalSteps: number | null
  resultPath: string | null
  resultSha256: string | null
  resultSize: number | null
  workerAckPending: boolean
  workerAckedAt: Date | null
  errorCode: string | null
  errorMessage: string | null
  cancelRequestedAt: Date | null
  predecessorJobId: string | null
  predecessorArtifactSha256: string | null
  projectId: string | null
  projectShotId: string | null
  projectRevAtSubmit: number | null
  composeManifest: unknown
  createdAt: Date
  updatedAt: Date
}

type JobDb = {
  id: string
  request_id: string
  user_id: string
  runtime_channel: string
  session_id: string | null
  kind: MediaJobKind
  resource_class: MediaResourceClass
  status: MediaJobStatus
  phase: string
  prompt: string | null
  options: Record<string, unknown>
  attempt_id: string | null
  fence_version: number
  request_digest: string | null
  worker_staging_started_at: Date | null
  submit_started_at: Date | null
  current_step: number | null
  total_steps: number | null
  result_path: string | null
  result_sha256: string | null
  result_size: string | number | null
  worker_ack_pending: boolean
  worker_acked_at: Date | null
  error_code: string | null
  error_message: string | null
  cancel_requested_at: Date | null
  predecessor_job_id: string | null
  predecessor_artifact_sha256: string | null
  project_id: string | null
  project_shot_id: string | null
  project_rev_at_submit: number | null
  compose_manifest: unknown
  created_at: Date
  updated_at: Date
}

const JOB_COLUMNS = `id, request_id, user_id::text, runtime_channel, session_id, kind,
  resource_class, status, phase, prompt, options, attempt_id, fence_version,
  request_digest, worker_staging_started_at, submit_started_at, current_step, total_steps,
  result_path, result_sha256, result_size,
  worker_ack_pending, worker_acked_at,
  error_code, error_message, cancel_requested_at, predecessor_job_id,
  predecessor_artifact_sha256, project_id, project_shot_id, project_rev_at_submit,
  compose_manifest, created_at, updated_at`

function mapJob(row: JobDb): MediaJobRow {
  return {
    id: row.id,
    requestId: row.request_id,
    userId: row.user_id,
    runtimeChannel: row.runtime_channel,
    sessionId: row.session_id,
    kind: row.kind,
    resourceClass: row.resource_class,
    status: row.status,
    phase: row.phase,
    prompt: row.prompt,
    options: row.options ?? {},
    attemptId: row.attempt_id,
    fenceVersion: row.fence_version,
    requestDigest: row.request_digest,
    workerStagingStartedAt: row.worker_staging_started_at,
    submitStartedAt: row.submit_started_at,
    currentStep: row.current_step,
    totalSteps: row.total_steps,
    resultPath: row.result_path,
    resultSha256: row.result_sha256,
    resultSize: row.result_size === null ? null : Number(row.result_size),
    workerAckPending: row.worker_ack_pending,
    workerAckedAt: row.worker_acked_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    cancelRequestedAt: row.cancel_requested_at,
    predecessorJobId: row.predecessor_job_id,
    predecessorArtifactSha256: row.predecessor_artifact_sha256,
    projectId: row.project_id,
    projectShotId: row.project_shot_id,
    projectRevAtSubmit: row.project_rev_at_submit,
    composeManifest: row.compose_manifest,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function insertInput(input: MediaInputRow): Promise<void> {
  await query(
    `INSERT INTO media_generation_inputs
       (id,user_id,sha256,size_bytes,mime,filename,worker_filename,kind,storage_path)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.id,
      input.userId,
      input.sha256,
      input.sizeBytes,
      input.mime,
      input.filename,
      input.workerFilename,
      input.kind,
      input.storagePath,
    ],
  )
}

export async function withMediaInputLease<T>(userId: string, run: () => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  const key = `media-generation-inputs:${userId}`
  let locked = false
  let discard = false
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key])
    locked = true
    return await run()
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key])
      } catch {
        discard = true
      }
    }
    client.release(discard)
  }
}

export async function userStoredInputBytes(userId: string): Promise<number> {
  const result = await query<{ bytes: string }>(
    'SELECT COALESCE(sum(size_bytes),0)::text AS bytes FROM media_generation_inputs WHERE user_id=$1',
    [userId],
  )
  return Number(result.rows[0]?.bytes ?? 0)
}

export async function getInput(userId: string, inputId: string): Promise<MediaInputRow | null> {
  const result = await query<{
    id: string
    user_id: string
    sha256: string
    size_bytes: string | number
    mime: string
    filename: string
    worker_filename: string
    kind: MediaInputRow['kind']
    storage_path: string
  }>(
    `SELECT id,user_id::text,sha256,size_bytes,mime,filename,worker_filename,kind,storage_path
       FROM media_generation_inputs WHERE user_id=$1 AND id=$2`,
    [userId, inputId],
  )
  const row = result.rows[0]
  return row
    ? {
        id: row.id,
        userId: row.user_id,
        sha256: row.sha256,
        sizeBytes: Number(row.size_bytes),
        mime: row.mime,
        filename: row.filename,
        workerFilename: row.worker_filename,
        kind: row.kind,
        storagePath: row.storage_path,
      }
    : null
}

export async function listJobInputs(userId: string, jobId: string): Promise<MediaInputRow[]> {
  const result = await query<{
    id: string
    user_id: string
    sha256: string
    size_bytes: string | number
    mime: string
    filename: string
    worker_filename: string
    kind: MediaInputRow['kind']
    storage_path: string
  }>(
    `SELECT i.id,i.user_id::text,i.sha256,i.size_bytes,i.mime,i.filename,i.worker_filename,i.kind,i.storage_path
       FROM media_generation_job_inputs ji
       JOIN media_generation_inputs i ON i.user_id=ji.user_id AND i.id=ji.input_id
      WHERE ji.user_id=$1 AND ji.job_id=$2 ORDER BY ji.ordinal`,
    [userId, jobId],
  )
  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    mime: row.mime,
    filename: row.filename,
    workerFilename: row.worker_filename,
    kind: row.kind,
    storagePath: row.storage_path,
  }))
}

export interface CreateMediaJobInput {
  userId: string
  requestId: string
  sessionId?: string
  prompt: string
  options: Record<string, unknown>
  inputIds?: string[]
  projectId?: string
  projectShotId?: string
  predecessorJobId?: string
  projectRevAtSubmit?: number
}

async function insertJob(client: PoolClient, input: CreateMediaJobInput): Promise<MediaJobRow> {
  const id = randomUUID()
  const result = await client.query<JobDb>(
    `INSERT INTO media_generation_jobs
       (id,request_id,user_id,runtime_channel,session_id,kind,resource_class,prompt,options,
        project_id,project_shot_id,predecessor_job_id,project_rev_at_submit)
     VALUES ($1,$2,$3,$4,$5,'h3_generate','gpu-h3',$6,$7::jsonb,$8,$9,$10,$11)
     ON CONFLICT (user_id,request_id) DO NOTHING
     RETURNING ${JOB_COLUMNS}`,
    [
      id,
      input.requestId,
      input.userId,
      getRuntimeChannel(),
      input.sessionId ?? null,
      input.prompt,
      JSON.stringify(input.options),
      input.projectId ?? null,
      input.projectShotId ?? null,
      input.predecessorJobId ?? null,
      input.projectRevAtSubmit ?? null,
    ],
  )
  if (!result.rows[0]) {
    const existing = await client.query<JobDb>(
      `SELECT ${JOB_COLUMNS} FROM media_generation_jobs
        WHERE user_id=$1 AND request_id=$2 AND kind='h3_generate'
          AND session_id IS NOT DISTINCT FROM $3
          AND prompt=$4 AND options=$5::jsonb
          AND project_id IS NOT DISTINCT FROM $6
          AND project_shot_id IS NOT DISTINCT FROM $7
          AND predecessor_job_id IS NOT DISTINCT FROM $8
          AND project_rev_at_submit IS NOT DISTINCT FROM $9`,
      [
        input.userId,
        input.requestId,
        input.sessionId ?? null,
        input.prompt,
        JSON.stringify(input.options),
        input.projectId ?? null,
        input.projectShotId ?? null,
        input.predecessorJobId ?? null,
        input.projectRevAtSubmit ?? null,
      ],
    )
    if (!existing.rows[0]) throw new Error('media_job_idempotency_conflict')
    const linked = await client.query<{ input_id: string }>(
      `SELECT input_id FROM media_generation_job_inputs
        WHERE user_id=$1 AND job_id=$2 ORDER BY ordinal`,
      [input.userId, existing.rows[0].id],
    )
    if (
      JSON.stringify(linked.rows.map((row) => row.input_id)) !==
      JSON.stringify(input.inputIds ?? [])
    ) {
      throw new Error('media_job_idempotency_conflict')
    }
    return mapJob(existing.rows[0])
  }
  for (const [ordinal, inputId] of (input.inputIds ?? []).entries()) {
    const linked = await client.query(
      `INSERT INTO media_generation_job_inputs (job_id,input_id,user_id,ordinal)
       SELECT $1,id,user_id,$4 FROM media_generation_inputs WHERE user_id=$2 AND id=$3`,
      [id, input.userId, inputId, ordinal],
    )
    if ((linked.rowCount ?? 0) !== 1) throw new Error(`media input not found: ${inputId}`)
  }
  return mapJob(result.rows[0])
}

export async function createMediaJob(input: CreateMediaJobInput): Promise<MediaJobRow> {
  return tx((client) => insertJob(client, input))
}

export async function getJob(userId: string, jobId: string): Promise<MediaJobRow | null> {
  const result = await query<JobDb>(
    `SELECT ${JOB_COLUMNS} FROM media_generation_jobs WHERE user_id=$1 AND id=$2`,
    [userId, jobId],
  )
  return result.rows[0] ? mapJob(result.rows[0]) : null
}

export interface MediaJobPage {
  jobs: MediaJobRow[]
  nextCursor: string | null
}

function encodeCursor(job: MediaJobRow): string {
  return encodeDateCursor(job.createdAt, job.id)
}

function encodeDateCursor(date: Date, id: string): string {
  return Buffer.from(JSON.stringify([date.toISOString(), id])).toString('base64url')
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'string' &&
      !Number.isNaN(Date.parse(value[0])) &&
      typeof value[1] === 'string'
    )
      return [value[0], value[1]]
  } catch {
    // Mapped to a stable client error below.
  }
  throw new Error('invalid_cursor')
}

export async function listJobs(
  userId: string,
  cursor?: string,
  pageSize = 50,
): Promise<MediaJobPage> {
  const limit = Math.min(100, Math.max(1, pageSize))
  const after = cursor ? decodeCursor(cursor) : null
  const result = await query<JobDb>(
    `SELECT ${JOB_COLUMNS} FROM media_generation_jobs
      WHERE user_id=$1
        AND ($2::timestamptz IS NULL OR (created_at,id) < ($2::timestamptz,$3))
      ORDER BY created_at DESC,id DESC LIMIT $4`,
    [userId, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
  )
  const jobs = result.rows.map(mapJob)
  const hasMore = jobs.length > limit
  if (hasMore) jobs.pop()
  return {
    jobs,
    nextCursor: hasMore && jobs.length > 0 ? encodeCursor(jobs[jobs.length - 1]!) : null,
  }
}

export async function queuePosition(job: MediaJobRow): Promise<number | null> {
  if (job.status !== 'queued') return null
  const result = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM media_generation_jobs
      WHERE runtime_channel=$1 AND resource_class=$2 AND status='queued'
        AND (created_at,id) < ($3,$4)`,
    [job.runtimeChannel, job.resourceClass, job.createdAt, job.id],
  )
  return Number(result.rows[0]?.n ?? 0) + 1
}

export async function claimNextJob(resourceClass: MediaResourceClass): Promise<MediaJobRow | null> {
  return tx(async (client) => {
    const locked = await client.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1::int,$2::int) AS ok',
      [LOCK_KEY_HI, LOCK_KEY_LO + (resourceClass === 'gpu-h3' ? 0 : 1)],
    )
    if (!locked.rows[0]?.ok) return null
    const active = await client.query(
      `SELECT 1 FROM media_generation_jobs
        WHERE runtime_channel=$1 AND resource_class=$2
          AND (status IN ('dispatching','running','reconnecting') OR worker_ack_pending) LIMIT 1`,
      [getRuntimeChannel(), resourceClass],
    )
    if (active.rows[0]) return null
    const selected = await client.query<{ id: string }>(
      `SELECT j.id
         FROM media_generation_jobs j
         LEFT JOIN media_generation_jobs p ON p.id=j.predecessor_job_id
         LEFT JOIN video_project_shots s ON s.id=j.project_shot_id
        WHERE j.runtime_channel=$1 AND j.resource_class=$2 AND j.status='queued'
          AND (j.predecessor_job_id IS NULL OR (
            p.status='completed' AND p.result_sha256=j.predecessor_artifact_sha256
          ))
          AND (s.id IS NULL OR s.stale_at IS NULL OR (
            s.accepted_dependency_job_id=j.predecessor_job_id
            AND s.accepted_dependency_sha256=j.predecessor_artifact_sha256
          ))
        ORDER BY j.created_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,
      [getRuntimeChannel(), resourceClass],
    )
    const id = selected.rows[0]?.id
    if (!id) return null
    const attemptId = randomUUID()
    const updated = await client.query<JobDb>(
      `UPDATE media_generation_jobs
          SET status='dispatching',phase='transferring_inputs',attempt_id=$2,
              fence_version=fence_version+1,locked_at=NOW(),updated_at=NOW()
        WHERE id=$1 AND status='queued' RETURNING ${JOB_COLUMNS}`,
      [id, attemptId],
    )
    return updated.rows[0] ? mapJob(updated.rows[0]) : null
  })
}

export async function withJobExecutionLease<T>(
  job: Pick<MediaJobRow, 'id' | 'attemptId'>,
  run: () => Promise<T>,
): Promise<{ acquired: boolean; value?: T }> {
  if (!job.attemptId) return { acquired: false }
  const client = await getPool().connect()
  const key = `media-generation:${job.id}:${job.attemptId}`
  let acquired = false
  let discard = false
  try {
    const locked = await client.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok',
      [key],
    )
    acquired = Boolean(locked.rows[0]?.ok)
    if (!acquired) return { acquired: false }
    return { acquired: true, value: await run() }
  } finally {
    if (acquired) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key])
      } catch {
        discard = true
      }
    }
    client.release(discard)
  }
}

export async function markSubmitStarted(
  jobId: string,
  attemptId: string,
): Promise<MediaJobRow | null> {
  const result = await query<JobDb>(
    `UPDATE media_generation_jobs
        SET submit_started_at=COALESCE(submit_started_at,NOW()),updated_at=NOW()
      WHERE id=$1 AND attempt_id=$2 AND status IN ('dispatching','running','reconnecting')
      RETURNING ${JOB_COLUMNS}`,
    [jobId, attemptId],
  )
  return result.rows[0] ? mapJob(result.rows[0]) : null
}

export async function markWorkerStagingStarted(
  jobId: string,
  attemptId: string,
): Promise<MediaJobRow | null> {
  const result = await query<JobDb>(
    `UPDATE media_generation_jobs
        SET worker_staging_started_at=COALESCE(worker_staging_started_at,NOW()),updated_at=NOW()
      WHERE id=$1 AND attempt_id=$2 AND status IN ('dispatching','running','reconnecting')
      RETURNING ${JOB_COLUMNS}`,
    [jobId, attemptId],
  )
  return result.rows[0] ? mapJob(result.rows[0]) : null
}

export async function updateActiveJob(
  jobId: string,
  attemptId: string,
  fields: Partial<
    Pick<MediaJobRow, 'status' | 'phase' | 'requestDigest' | 'currentStep' | 'totalSteps'>
  >,
): Promise<MediaJobRow | null> {
  const values: unknown[] = [jobId, attemptId]
  const sets: string[] = []
  const add = (column: string, value: unknown): void => {
    sets.push(`${column}=$${values.push(value)}`)
  }
  if (fields.status !== undefined) add('status', fields.status)
  if (fields.phase !== undefined) add('phase', fields.phase)
  if (fields.requestDigest !== undefined) add('request_digest', fields.requestDigest)
  if (fields.currentStep !== undefined) add('current_step', fields.currentStep)
  if (fields.totalSteps !== undefined) add('total_steps', fields.totalSteps)
  if (sets.length === 0) return null
  const result = await query<JobDb>(
    `UPDATE media_generation_jobs SET ${sets.join(',')},updated_at=NOW()
      WHERE id=$1 AND attempt_id=$2 AND status IN ('dispatching','running','reconnecting')
      RETURNING ${JOB_COLUMNS}`,
    values,
  )
  return result.rows[0] ? mapJob(result.rows[0]) : null
}

/** Rotate only an already fenced attempt for which the worker supplied an
 * exact retry-safe tombstone. The caller must ACK/scrub the old attempt first;
 * a failed CAS leaves the master reconnecting to that durable tombstone. */
export async function rotateRecoverableAttempt(
  job: Pick<MediaJobRow, 'id' | 'attemptId' | 'fenceVersion'>,
): Promise<MediaJobRow | null> {
  if (!job.attemptId) return null
  const nextAttemptId = randomUUID()
  const result = await query<JobDb>(
    `UPDATE media_generation_jobs
        SET status='dispatching',phase='transferring_inputs',attempt_id=$4,
            fence_version=fence_version+1,request_digest=NULL,
            worker_staging_started_at=NULL,submit_started_at=NULL,
            current_step=NULL,total_steps=NULL,error_code=NULL,error_message=NULL,
            worker_ack_pending=FALSE,worker_acked_at=NULL,locked_at=NOW(),updated_at=NOW()
      WHERE id=$1 AND attempt_id=$2 AND fence_version=$3
        AND status IN ('dispatching','running','reconnecting')
        AND cancel_requested_at IS NULL
      RETURNING ${JOB_COLUMNS}`,
    [job.id, job.attemptId, job.fenceVersion, nextAttemptId],
  )
  return result.rows[0] ? mapJob(result.rows[0]) : null
}

export async function completeJob(
  job: MediaJobRow,
  result: { path: string; sha256: string; size: number },
): Promise<MediaJobRow | null> {
  return tx(async (client) => {
    const updated = await client.query<JobDb>(
      `UPDATE media_generation_jobs
          SET status='completed',phase='completed',result_path=$3,result_sha256=$4,
              result_size=$5,worker_ack_pending=TRUE,worker_acked_at=NULL,
              locked_at=NULL,updated_at=NOW()
        WHERE id=$1 AND attempt_id=$2 AND status IN ('dispatching','running','reconnecting')
        RETURNING ${JOB_COLUMNS}`,
      [job.id, job.attemptId, result.path, result.sha256, result.size],
    )
    if (!updated.rows[0]) return null
    await client.query(
      `UPDATE media_generation_jobs
          SET predecessor_artifact_sha256=$2,updated_at=NOW()
        WHERE predecessor_job_id=$1 AND status='queued' AND predecessor_artifact_sha256 IS NULL`,
      [job.id, result.sha256],
    )
    if (job.kind === 'video_compose' && job.projectId && job.projectRevAtSubmit !== null) {
      await client.query(
        `UPDATE video_projects SET updated_at=NOW()
          WHERE id=$1 AND current_compose_job_id=$2 AND rev=$3`,
        [job.projectId, job.id, job.projectRevAtSubmit],
      )
    }
    return mapJob(updated.rows[0])
  })
}

export async function listAckPendingJobs(limit = 100): Promise<MediaJobRow[]> {
  const result = await query<JobDb>(
    `SELECT ${JOB_COLUMNS} FROM media_generation_jobs
      WHERE runtime_channel=$1 AND status IN ('completed','failed','canceled') AND worker_ack_pending
      ORDER BY updated_at,id LIMIT $2`,
    [getRuntimeChannel(), limit],
  )
  return result.rows.map(mapJob)
}

export async function markWorkerAcked(
  jobId: string,
  attemptId: string,
): Promise<MediaJobRow | null> {
  const result = await query<JobDb>(
    `UPDATE media_generation_jobs
        SET worker_ack_pending=FALSE,worker_acked_at=NOW(),updated_at=NOW()
      WHERE id=$1 AND attempt_id=$2 AND status IN ('completed','failed','canceled')
        AND worker_ack_pending
      RETURNING ${JOB_COLUMNS}`,
    [jobId, attemptId],
  )
  return result.rows[0] ? mapJob(result.rows[0]) : null
}

export async function failJob(
  job: MediaJobRow,
  status: 'failed' | 'canceled',
  code: string,
  message: string,
): Promise<MediaJobRow | null> {
  const result = await query<JobDb>(
    `UPDATE media_generation_jobs
        SET status=$3,phase=$3,error_code=$4,error_message=$5,
            worker_ack_pending=(worker_staging_started_at IS NOT NULL OR submit_started_at IS NOT NULL
                                OR request_digest IS NOT NULL),
            locked_at=NULL,updated_at=NOW()
      WHERE id=$1 AND attempt_id=$2 AND status IN ('dispatching','running','reconnecting')
      RETURNING ${JOB_COLUMNS}`,
    [job.id, job.attemptId, status, code, message.slice(0, 2000)],
  )
  return result.rows[0] ? mapJob(result.rows[0]) : null
}

export async function requestCancel(userId: string, jobId: string): Promise<MediaJobRow | null> {
  const result = await query<JobDb>(
    `UPDATE media_generation_jobs SET
       cancel_requested_at=COALESCE(cancel_requested_at,NOW()),
       status=CASE WHEN status='queued' THEN 'canceled' ELSE status END,
       phase=CASE WHEN status='queued' THEN 'canceled' ELSE phase END,
       updated_at=NOW()
     WHERE user_id=$1 AND id=$2 AND status NOT IN ('completed','failed','canceled')
     RETURNING ${JOB_COLUMNS}`,
    [userId, jobId],
  )
  return result.rows[0] ? mapJob(result.rows[0]) : getJob(userId, jobId)
}

export async function listRecoverableJobs(): Promise<MediaJobRow[]> {
  const result = await query<JobDb>(
    `SELECT ${JOB_COLUMNS} FROM media_generation_jobs
      WHERE runtime_channel=$1 AND status IN ('dispatching','running','reconnecting')`,
    [getRuntimeChannel()],
  )
  return result.rows.map(mapJob)
}

export interface CreateProjectInput {
  userId: string
  requestId: string
  title: string
  sessionId?: string
  inputIds?: string[]
  options?: Record<string, unknown>
  shots: Array<{ prompt: string; durationSeconds: 5 | 10 | 15; options?: Record<string, unknown> }>
}

export async function createProject(input: CreateProjectInput): Promise<string> {
  return tx(async (client) => {
    const projectId = randomUUID()
    const creationContract = {
      title: input.title,
      sessionId: input.sessionId ?? null,
      inputIds: input.inputIds ?? [],
      options: input.options ?? {},
      shots: input.shots,
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO video_projects
        (id,user_id,request_id,title,creation_contract,session_id,input_ids)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::text[])
       ON CONFLICT (user_id,request_id) DO NOTHING RETURNING id`,
      [
        projectId,
        input.userId,
        input.requestId,
        input.title,
        JSON.stringify(creationContract),
        input.sessionId ?? null,
        input.inputIds ?? [],
      ],
    )
    if (!inserted.rows[0]) {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM video_projects
          WHERE user_id=$1 AND request_id=$2 AND creation_contract=$3::jsonb`,
        [input.userId, input.requestId, JSON.stringify(creationContract)],
      )
      if (!existing.rows[0]) throw new Error('project_idempotency_conflict')
      return existing.rows[0].id
    }
    const sourceInputs = input.inputIds?.length
      ? await client.query<{
          id: string
          kind: MediaInputRow['kind']
          ordinal: string
        }>(
          `SELECT i.id,i.kind,source.ordinal::text
         FROM unnest($2::text[]) WITH ORDINALITY AS source(id,ordinal)
         JOIN media_generation_inputs i ON i.user_id=$1 AND i.id=source.id
        ORDER BY source.ordinal`,
          [input.userId, input.inputIds],
        )
      : { rows: [] }
    if (sourceInputs.rows.length !== (input.inputIds ?? []).length)
      throw new Error('media_input_not_found')
    let predecessorShotId: string | undefined
    for (const [ordinal, shot] of input.shots.entries()) {
      const shotId = randomUUID()
      await client.query(
        `INSERT INTO video_project_shots
          (id,project_id,user_id,ordinal,prompt,duration_seconds,options,predecessor_shot_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [
          shotId,
          projectId,
          input.userId,
          ordinal,
          shot.prompt,
          shot.durationSeconds,
          JSON.stringify({ ...(input.options ?? {}), ...(shot.options ?? {}) }),
          predecessorShotId ?? null,
        ],
      )
      predecessorShotId = shotId
    }
    return projectId
  })
}

export interface UpdateDraftProjectInput {
  userId: string
  projectId: string
  expectedRev: number
  title?: string
  inputIds?: string[]
  options?: Record<string, unknown>
  shots: CreateProjectInput['shots']
}

export async function updateDraftProject(input: UpdateDraftProjectInput): Promise<void> {
  await tx(async (client) => {
    const projectResult = await client.query<{
      rev: number
      canceled_at: Date | null
      input_ids: string[]
    }>(
      `SELECT rev,canceled_at,input_ids FROM video_projects
        WHERE user_id=$1 AND id=$2 FOR UPDATE`,
      [input.userId, input.projectId],
    )
    const project = projectResult.rows[0]
    if (!project) throw new Error('project_not_found')
    if (project.canceled_at) throw new Error('project_canceled')
    if (project.rev !== input.expectedRev) throw new Error('project_revision_conflict')
    const shots = await client.query<{ active_media_job_id: string | null }>(
      `SELECT active_media_job_id FROM video_project_shots
        WHERE user_id=$1 AND project_id=$2 FOR UPDATE`,
      [input.userId, input.projectId],
    )
    if (shots.rows.some((shot) => shot.active_media_job_id))
      throw new Error('project_already_started')
    const inputIds = input.inputIds ?? project.input_ids
    const sourceInputs = inputIds.length
      ? await client.query<{ id: string }>(
          `SELECT i.id FROM unnest($2::text[]) WITH ORDINALITY AS source(id,ordinal)
             JOIN media_generation_inputs i ON i.user_id=$1 AND i.id=source.id
            ORDER BY source.ordinal`,
          [input.userId, inputIds],
        )
      : { rows: [] }
    if (sourceInputs.rows.length !== inputIds.length) throw new Error('media_input_not_found')
    await client.query('DELETE FROM video_project_shots WHERE user_id=$1 AND project_id=$2', [
      input.userId,
      input.projectId,
    ])
    let predecessorShotId: string | undefined
    for (const [ordinal, shot] of input.shots.entries()) {
      const shotId = randomUUID()
      await client.query(
        `INSERT INTO video_project_shots
          (id,project_id,user_id,ordinal,prompt,duration_seconds,options,predecessor_shot_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [
          shotId,
          input.projectId,
          input.userId,
          ordinal,
          shot.prompt,
          shot.durationSeconds,
          JSON.stringify({ ...(input.options ?? {}), ...(shot.options ?? {}) }),
          predecessorShotId ?? null,
        ],
      )
      predecessorShotId = shotId
    }
    const updated = await client.query(
      `UPDATE video_projects SET title=COALESCE($3,title),input_ids=$4::text[],rev=rev+1,
              updated_at=NOW() WHERE user_id=$1 AND id=$2 AND rev=$5`,
      [input.userId, input.projectId, input.title ?? null, inputIds, input.expectedRev],
    )
    if ((updated.rowCount ?? 0) !== 1) throw new Error('project_revision_conflict')
  })
}

export async function startProject(
  userId: string,
  projectId: string,
  expectedRev: number,
): Promise<MediaJobRow[]> {
  return tx(async (client) => {
    const projectResult = await client.query<{
      rev: number
      canceled_at: Date | null
      session_id: string | null
      input_ids: string[]
    }>(
      `SELECT rev,canceled_at,session_id,input_ids FROM video_projects
        WHERE user_id=$1 AND id=$2 FOR UPDATE`,
      [userId, projectId],
    )
    const project = projectResult.rows[0]
    if (!project) throw new Error('project_not_found')
    if (project.canceled_at) throw new Error('project_canceled')
    const shots = await client.query<{
      id: string
      ordinal: number
      prompt: string
      duration_seconds: 5 | 10 | 15
      options: Record<string, unknown>
      active_media_job_id: string | null
    }>(
      `SELECT id,ordinal,prompt,duration_seconds,options,active_media_job_id
         FROM video_project_shots WHERE user_id=$1 AND project_id=$2
        ORDER BY ordinal FOR UPDATE`,
      [userId, projectId],
    )
    const nextRev = expectedRev + 1
    if (project.rev === nextRev && shots.rows.every((shot) => shot.active_media_job_id)) {
      const existing = await client.query<JobDb>(
        `SELECT ${JOB_COLUMNS} FROM media_generation_jobs
          WHERE user_id=$1 AND project_id=$2 AND project_rev_at_submit=$3
          ORDER BY created_at,id`,
        [userId, projectId, nextRev],
      )
      if (existing.rows.length === shots.rows.length) return existing.rows.map(mapJob)
    }
    if (project.rev !== expectedRev) throw new Error('project_revision_conflict')
    if (shots.rows.length === 0 || shots.rows.some((shot) => shot.active_media_job_id))
      throw new Error('project_already_started')
    const inputIds = project.input_ids
    const sourceInputs = inputIds.length
      ? await client.query<{
          id: string
          kind: MediaInputRow['kind']
        }>(
          `SELECT i.id,i.kind FROM unnest($2::text[]) WITH ORDINALITY AS source(id,ordinal)
             JOIN media_generation_inputs i ON i.user_id=$1 AND i.id=source.id
            ORDER BY source.ordinal`,
          [userId, inputIds],
        )
      : { rows: [] }
    if (sourceInputs.rows.length !== inputIds.length) throw new Error('media_input_not_found')
    const references = sourceInputs.rows
      .filter((input) => input.kind === 'reference_image')
      .map((input) => input.id)
    const firstFrames = sourceInputs.rows
      .filter((input) => input.kind === 'first_frame')
      .map((input) => input.id)
    const lastFrames = sourceInputs.rows
      .filter((input) => input.kind === 'last_frame')
      .map((input) => input.id)
    let predecessorJobId: string | undefined
    const jobs: MediaJobRow[] = []
    for (const shot of shots.rows) {
      const job = await insertJob(client, {
        userId,
        requestId: `project:${projectId}:shot:${shot.id}:rev:${nextRev}`,
        sessionId: project.session_id ?? undefined,
        prompt: shot.prompt,
        options: { ...shot.options, durationSeconds: shot.duration_seconds },
        inputIds: [
          ...references,
          ...(shot.ordinal === 0 ? firstFrames : []),
          ...(shot.ordinal === shots.rows.length - 1 ? lastFrames : []),
        ],
        projectId,
        projectShotId: shot.id,
        predecessorJobId,
        projectRevAtSubmit: nextRev,
      })
      await client.query(
        'UPDATE video_project_shots SET active_media_job_id=$2,updated_at=NOW() WHERE id=$1',
        [shot.id, job.id],
      )
      jobs.push(job)
      predecessorJobId = job.id
    }
    const updated = await client.query(
      `UPDATE video_projects SET rev=$3,updated_at=NOW()
        WHERE user_id=$1 AND id=$2 AND rev=$4`,
      [userId, projectId, nextRev, expectedRev],
    )
    if ((updated.rowCount ?? 0) !== 1) throw new Error('project_revision_conflict')
    return jobs
  })
}

export interface ProjectDbRow {
  id: string
  user_id: string
  request_id: string
  title: string
  rev: number
  render_requested_at: Date | null
  canceled_at: Date | null
  current_compose_job_id: string | null
  created_at: Date
  updated_at: Date
}

export interface ShotDbRow {
  id: string
  project_id: string
  ordinal: number
  prompt: string
  duration_seconds: number
  active_media_job_id: string | null
  stale_at: Date | null
  accepted_dependency_job_id: string | null
  accepted_dependency_sha256: string | null
}

export interface ProjectPage {
  projects: ProjectDbRow[]
  nextCursor: string | null
}

export async function listProjects(
  userId: string,
  cursor?: string,
  pageSize = 20,
): Promise<ProjectPage> {
  const limit = Math.min(100, Math.max(1, pageSize))
  const after = cursor ? decodeCursor(cursor) : null
  const result = await query<ProjectDbRow>(
    `SELECT id,user_id::text,request_id,title,rev,render_requested_at,canceled_at,
            current_compose_job_id,created_at,updated_at
       FROM video_projects WHERE user_id=$1
         AND ($2::timestamptz IS NULL OR (updated_at,id) < ($2::timestamptz,$3))
       ORDER BY updated_at DESC,id DESC LIMIT $4`,
    [userId, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
  )
  const projects = result.rows
  const hasMore = projects.length > limit
  if (hasMore) projects.pop()
  const last = projects[projects.length - 1]
  return {
    projects,
    nextCursor: hasMore && last ? encodeDateCursor(last.updated_at, last.id) : null,
  }
}

export async function getProject(userId: string, projectId: string): Promise<ProjectDbRow | null> {
  const result = await query<ProjectDbRow>(
    `SELECT id,user_id::text,request_id,title,rev,render_requested_at,canceled_at,
            current_compose_job_id,created_at,updated_at
       FROM video_projects WHERE user_id=$1 AND id=$2`,
    [userId, projectId],
  )
  return result.rows[0] ?? null
}

export async function listProjectShots(userId: string, projectId: string): Promise<ShotDbRow[]> {
  const result = await query<ShotDbRow>(
    `SELECT id,project_id,ordinal,prompt,duration_seconds,active_media_job_id,stale_at,
            accepted_dependency_job_id,accepted_dependency_sha256
       FROM video_project_shots WHERE user_id=$1 AND project_id=$2 ORDER BY ordinal`,
    [userId, projectId],
  )
  return result.rows
}

export async function createComposeJob(
  userId: string,
  projectId: string,
  expectedRev: number,
  requestId: string,
  options: Record<string, unknown>,
): Promise<MediaJobRow> {
  return tx(async (client) => {
    const projectResult = await client.query<ProjectDbRow>(
      `SELECT id,user_id::text,request_id,title,rev,render_requested_at,canceled_at,current_compose_job_id,
              created_at,updated_at FROM video_projects
        WHERE user_id=$1 AND id=$2 FOR UPDATE`,
      [userId, projectId],
    )
    const project = projectResult.rows[0]
    if (!project) throw new Error('project_not_found')
    if (project.canceled_at) throw new Error('project_canceled')
    const existingResult = await client.query<JobDb>(
      `SELECT ${JOB_COLUMNS} FROM media_generation_jobs WHERE user_id=$1 AND request_id=$2`,
      [userId, requestId],
    )
    const existing = existingResult.rows[0]
    if (existing) {
      if (
        existing.kind !== 'video_compose' ||
        existing.project_id !== projectId ||
        existing.project_rev_at_submit !== expectedRev + 1
      )
        throw new Error('compose_job_conflict')
      const sameOptions = await client.query(
        'SELECT 1 FROM media_generation_jobs WHERE id=$1 AND options=$2::jsonb',
        [existing.id, JSON.stringify(options)],
      )
      if (!sameOptions.rows[0]) throw new Error('compose_job_conflict')
      return mapJob(existing)
    }
    if (project.rev !== expectedRev) throw new Error('project_revision_conflict')
    const shots = await client.query<{
      shot_id: string
      ordinal: number
      job_id: string | null
      result_path: string | null
      result_sha256: string | null
      result_size: string | number | null
      status: MediaJobStatus | null
      stale_at: Date | null
    }>(
      `SELECT s.id AS shot_id,s.ordinal,s.active_media_job_id AS job_id,s.stale_at,
              j.result_path,j.result_sha256,j.result_size,j.status
         FROM video_project_shots s
         LEFT JOIN media_generation_jobs j ON j.id=s.active_media_job_id
        WHERE s.user_id=$1 AND s.project_id=$2 ORDER BY s.ordinal FOR UPDATE OF s`,
      [userId, projectId],
    )
    if (
      shots.rows.length === 0 ||
      shots.rows.some(
        (shot) =>
          shot.stale_at || shot.status !== 'completed' || !shot.result_path || !shot.result_sha256,
      )
    ) {
      throw new Error('project_not_ready')
    }
    const manifest = shots.rows.map((shot) => ({
      shotId: shot.shot_id,
      ordinal: shot.ordinal,
      jobId: shot.job_id,
      path: shot.result_path,
      sha256: shot.result_sha256,
      size: Number(shot.result_size),
    }))
    const nextRev = project.rev + 1
    const id = randomUUID()
    const inserted = await client.query<JobDb>(
      `INSERT INTO media_generation_jobs
        (id,request_id,user_id,runtime_channel,kind,resource_class,status,phase,options,
         project_id,project_rev_at_submit,compose_manifest)
       VALUES ($1,$2,$3,$4,'video_compose','cpu-compose','queued','queued',$5::jsonb,$6,$7,$8::jsonb)
       RETURNING ${JOB_COLUMNS}`,
      [
        id,
        requestId,
        userId,
        getRuntimeChannel(),
        JSON.stringify(options),
        projectId,
        nextRev,
        JSON.stringify(manifest),
      ],
    )
    const job = inserted.rows[0]
    if (!job) throw new Error('compose_job_conflict')
    const updated = await client.query(
      `UPDATE video_projects SET rev=$3,render_requested_at=NOW(),current_compose_job_id=$4,
              updated_at=NOW() WHERE user_id=$1 AND id=$2 AND rev=$5`,
      [userId, projectId, nextRev, job.id, expectedRev],
    )
    if ((updated.rowCount ?? 0) !== 1) throw new Error('project_revision_conflict')
    return mapJob(job)
  })
}

export async function cancelProject(
  userId: string,
  projectId: string,
  expectedRev: number,
): Promise<void> {
  await tx(async (client) => {
    const project = await client.query<{ rev: number; canceled_at: Date | null }>(
      'SELECT rev,canceled_at FROM video_projects WHERE user_id=$1 AND id=$2 FOR UPDATE',
      [userId, projectId],
    )
    if (!project.rows[0]) throw new Error('project_not_found')
    if (project.rows[0].canceled_at) return
    if (project.rows[0].rev !== expectedRev) throw new Error('project_revision_conflict')
    await client.query(
      `UPDATE media_generation_jobs SET
         cancel_requested_at=COALESCE(cancel_requested_at,NOW()),
         status=CASE WHEN status='queued' THEN 'canceled' ELSE status END,
         phase=CASE WHEN status='queued' THEN 'canceled' ELSE phase END,
         updated_at=NOW()
       WHERE user_id=$1 AND project_id=$2
         AND status IN ('queued','dispatching','running','reconnecting')`,
      [userId, projectId],
    )
    await client.query(
      `UPDATE video_projects SET canceled_at=NOW(),rev=rev+1,updated_at=NOW()
        WHERE user_id=$1 AND id=$2`,
      [userId, projectId],
    )
  })
}

export async function regenerateShot(
  userId: string,
  projectId: string,
  shotId: string,
  expectedRev: number,
  requestId: string,
): Promise<MediaJobRow> {
  return tx(async (client) => {
    const project = await client.query<{ rev: number; canceled_at: Date | null }>(
      'SELECT rev,canceled_at FROM video_projects WHERE user_id=$1 AND id=$2 FOR UPDATE',
      [userId, projectId],
    )
    if (!project.rows[0]) throw new Error('project_not_found')
    if (project.rows[0].canceled_at) throw new Error('project_canceled')
    const retry = await client.query<JobDb>(
      `SELECT ${JOB_COLUMNS} FROM media_generation_jobs WHERE user_id=$1 AND request_id=$2`,
      [userId, requestId],
    )
    if (retry.rows[0]) {
      const row = retry.rows[0]
      if (
        row.kind !== 'h3_generate' ||
        row.project_id !== projectId ||
        row.project_shot_id !== shotId ||
        row.project_rev_at_submit !== expectedRev + 1
      )
        throw new Error('media_job_idempotency_conflict')
      return mapJob(row)
    }
    if (project.rows[0].rev !== expectedRev) throw new Error('project_revision_conflict')
    const shotResult = await client.query<{
      id: string
      prompt: string
      duration_seconds: number
      options: Record<string, unknown>
      predecessor_shot_id: string | null
      active_media_job_id: string | null
    }>(
      `SELECT id,prompt,duration_seconds,options,predecessor_shot_id,active_media_job_id
         FROM video_project_shots WHERE user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
      [userId, projectId, shotId],
    )
    const shot = shotResult.rows[0]
    if (!shot) throw new Error('shot_not_found')
    if (!shot.active_media_job_id) throw new Error('project_not_started')
    let predecessorJobId: string | undefined
    let predecessorSha: string | null = null
    if (shot.predecessor_shot_id) {
      const predecessor = await client.query<{ id: string; result_sha256: string | null }>(
        `SELECT j.id,j.result_sha256 FROM video_project_shots s
          JOIN media_generation_jobs j ON j.id=s.active_media_job_id
         WHERE s.user_id=$1 AND s.id=$2`,
        [userId, shot.predecessor_shot_id],
      )
      predecessorJobId = predecessor.rows[0]?.id
      predecessorSha = predecessor.rows[0]?.result_sha256 ?? null
    }
    const nextRev = expectedRev + 1
    const previousInputs = shot.active_media_job_id
      ? await client.query<{ input_id: string }>(
          `SELECT input_id FROM media_generation_job_inputs
        WHERE user_id=$1 AND job_id=$2 ORDER BY ordinal`,
          [userId, shot.active_media_job_id],
        )
      : { rows: [] }
    if (shot.active_media_job_id) {
      await client.query(
        `UPDATE media_generation_jobs SET
           cancel_requested_at=CASE
             WHEN status IN ('queued','dispatching','running','reconnecting')
             THEN COALESCE(cancel_requested_at,NOW()) ELSE cancel_requested_at END,
           status=CASE WHEN status='queued' THEN 'canceled' ELSE status END,
           phase=CASE WHEN status='queued' THEN 'canceled' ELSE phase END,
           updated_at=NOW()
         WHERE id=$1`,
        [shot.active_media_job_id],
      )
    }
    const job = await insertJob(client, {
      userId,
      requestId,
      prompt: shot.prompt,
      options: { ...shot.options, durationSeconds: shot.duration_seconds },
      inputIds: previousInputs.rows.map((row) => row.input_id),
      projectId,
      projectShotId: shotId,
      predecessorJobId,
      projectRevAtSubmit: nextRev,
    })
    if (predecessorSha) {
      await client.query(
        'UPDATE media_generation_jobs SET predecessor_artifact_sha256=$2 WHERE id=$1',
        [job.id, predecessorSha],
      )
      job.predecessorArtifactSha256 = predecessorSha
    }
    await client.query(
      `UPDATE video_project_shots SET active_media_job_id=$2,stale_at=NULL,
              accepted_dependency_job_id=NULL,accepted_dependency_sha256=NULL,updated_at=NOW()
        WHERE id=$1`,
      [shotId, job.id],
    )
    const child = await client.query<{
      id: string
      active_media_job_id: string | null
      status: MediaJobStatus | null
    }>(
      `SELECT s.id,s.active_media_job_id,j.status
         FROM video_project_shots s
         LEFT JOIN media_generation_jobs j ON j.id=s.active_media_job_id
        WHERE s.user_id=$1 AND s.project_id=$2 AND s.predecessor_shot_id=$3
        FOR UPDATE OF s`,
      [userId, projectId, shotId],
    )
    let childRebound = false
    if (child.rows[0]?.active_media_job_id && child.rows[0].status === 'queued') {
      const rebound = await client.query(
        `UPDATE media_generation_jobs
            SET predecessor_job_id=$2,predecessor_artifact_sha256=NULL,updated_at=NOW()
          WHERE id=$1 AND status='queued'`,
        [child.rows[0].active_media_job_id, job.id],
      )
      childRebound = (rebound.rowCount ?? 0) === 1
      if (childRebound) {
        await client.query(
          `UPDATE video_project_shots
              SET stale_at=NULL,accepted_dependency_job_id=NULL,
                  accepted_dependency_sha256=NULL,updated_at=NOW()
            WHERE id=$1`,
          [child.rows[0].id],
        )
      }
    }
    if (!childRebound) {
      await client.query(
        `WITH RECURSIVE descendants AS (
           SELECT id FROM video_project_shots WHERE predecessor_shot_id=$1
           UNION ALL
           SELECT s.id FROM video_project_shots s JOIN descendants d ON s.predecessor_shot_id=d.id
         ) UPDATE video_project_shots SET stale_at=NOW(),updated_at=NOW()
           WHERE id IN (SELECT id FROM descendants)`,
        [shotId],
      )
    }
    const updatedProject = await client.query(
      `UPDATE video_projects SET rev=$3,current_compose_job_id=NULL,render_requested_at=NULL,
              updated_at=NOW() WHERE user_id=$1 AND id=$2 AND rev=$4`,
      [userId, projectId, nextRev, expectedRev],
    )
    if ((updatedProject.rowCount ?? 0) !== 1) throw new Error('project_revision_conflict')
    return job
  })
}

export async function acceptStaleShot(
  userId: string,
  projectId: string,
  shotId: string,
  expectedRev: number,
): Promise<void> {
  await tx(async (client) => {
    const project = await client.query<{ rev: number; canceled_at: Date | null }>(
      'SELECT rev,canceled_at FROM video_projects WHERE user_id=$1 AND id=$2 FOR UPDATE',
      [userId, projectId],
    )
    if (!project.rows[0]) throw new Error('project_not_found')
    if (project.rows[0].canceled_at) throw new Error('project_canceled')
    if (project.rows[0].rev !== expectedRev) throw new Error('project_revision_conflict')
    const updated = await client.query(
      `UPDATE video_project_shots s
          SET stale_at=NULL,accepted_dependency_job_id=j.predecessor_job_id,
              accepted_dependency_sha256=j.predecessor_artifact_sha256,updated_at=NOW()
         FROM media_generation_jobs j
        WHERE s.user_id=$1 AND s.project_id=$2 AND s.id=$3
          AND j.id=s.active_media_job_id AND s.stale_at IS NOT NULL`,
      [userId, projectId, shotId],
    )
    if ((updated.rowCount ?? 0) !== 1) throw new Error('shot_not_stale')
    await client.query(
      'UPDATE video_projects SET rev=rev+1,updated_at=NOW() WHERE user_id=$1 AND id=$2',
      [userId, projectId],
    )
  })
}
