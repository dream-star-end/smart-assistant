import { query, tx, type QueryRunner } from '../db/queries.js'

export const TUTORIAL_COMPASS_GROK_MODEL = 'cursor-grok-4.6-high'

export const EVAL_JOB_STATUSES = [
  'queued',
  'running',
  'passed',
  'failed',
  'compass_pending',
  'compass_running',
  'compass_ready',
] as const
export type EvalJobStatus = (typeof EVAL_JOB_STATUSES)[number]

export const DEFAULT_EVAL_LEASE_MS = 15 * 60 * 1000

export class TutorialEvalError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'BAD_SPEC' | 'LEASE_LOST' | 'FORBIDDEN',
    message: string,
  ) {
    super(message)
    this.name = 'TutorialEvalError'
  }
}

export type CaseSpecDraft = {
  publicId: string
  title: string
  sourceUrl: string
  sourcePlatform: string
  collectedAt: string
  frozenPrompt: string
  frozenMaterials: unknown
  authScope: 'synthetic_eval'
  rubric: unknown
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateCaseSpecPayload(draft: CaseSpecDraft): void {
  if (!/^https?:\/\//i.test(draft.sourceUrl)) {
    throw new TutorialEvalError('BAD_SPEC', 'sourceUrl must be http(s)')
  }
  if (!Number.isFinite(Date.parse(draft.collectedAt)) || Date.parse(draft.collectedAt) > Date.now() + 60_000) {
    throw new TutorialEvalError('BAD_SPEC', 'collectedAt must be a real past-or-present timestamp')
  }
  if (!isRecord(draft.frozenMaterials) || !Array.isArray((draft.frozenMaterials as { items?: unknown }).items)) {
    throw new TutorialEvalError('BAD_SPEC', 'frozenMaterials.items must be an array')
  }
  if (!isRecord(draft.rubric) || !Array.isArray((draft.rubric as { checks?: unknown }).checks)) {
    throw new TutorialEvalError('BAD_SPEC', 'rubric.checks must be an array')
  }
  const checks = (draft.rubric as { checks: unknown[] }).checks
  if (checks.length < 1) throw new TutorialEvalError('BAD_SPEC', 'rubric.checks must not be empty')
  for (const [index, check] of checks.entries()) {
    if (!isRecord(check)) throw new TutorialEvalError('BAD_SPEC', `rubric.checks[${index}] invalid`)
    if (typeof check.id !== 'string' || !check.id.trim()) {
      throw new TutorialEvalError('BAD_SPEC', `rubric.checks[${index}].id required`)
    }
    if (!['contains', 'regex', 'min_length'].includes(String(check.method))) {
      throw new TutorialEvalError(
        'BAD_SPEC',
        `rubric.checks[${index}].method must be contains|regex|min_length`,
      )
    }
    if (typeof check.passCriterion !== 'string' || !check.passCriterion.trim()) {
      throw new TutorialEvalError('BAD_SPEC', `rubric.checks[${index}].passCriterion required`)
    }
    if (check.method === 'regex') {
      try {
        new RegExp(check.passCriterion, 'u')
      } catch {
        throw new TutorialEvalError('BAD_SPEC', `rubric.checks[${index}].passCriterion regex invalid`)
      }
    }
    if (
      check.method === 'min_length' &&
      (!/^\d+$/.test(check.passCriterion) || Number(check.passCriterion) < 1)
    ) {
      throw new TutorialEvalError('BAD_SPEC', `rubric.checks[${index}].passCriterion length invalid`)
    }
  }
}

export function evaluateTutorialRubric(
  rubric: unknown,
  finalText: string,
): {
  passed: boolean
  checks: Array<{ id: string; method: string; passCriterion: string; passed: boolean }>
} {
  if (!isRecord(rubric) || !Array.isArray(rubric.checks)) {
    throw new TutorialEvalError('BAD_SPEC', 'rubric.checks must be an array')
  }
  const checks = rubric.checks.map((raw, index) => {
    if (!isRecord(raw)) throw new TutorialEvalError('BAD_SPEC', `rubric.checks[${index}] invalid`)
    const id = String(raw.id ?? '')
    const method = String(raw.method ?? '')
    const passCriterion = String(raw.passCriterion ?? '')
    let passed = false
    if (method === 'contains') passed = finalText.includes(passCriterion)
    else if (method === 'regex') passed = new RegExp(passCriterion, 'u').test(finalText)
    else if (method === 'min_length') passed = finalText.length >= Number(passCriterion)
    else throw new TutorialEvalError('BAD_SPEC', `rubric.checks[${index}].method unsupported`)
    return { id, method, passCriterion, passed }
  })
  return { passed: checks.length > 0 && checks.every((check) => check.passed), checks }
}

export async function insertCaseSpec(
  createdBy: string,
  draft: CaseSpecDraft,
): Promise<{ id: string; publicId: string }> {
  validateCaseSpecPayload(draft)
  try {
    const result = await query<{ id: string; public_id: string }>(
      `INSERT INTO tutorial_case_specs
         (public_id, title, source_url, source_platform, collected_at, frozen_prompt,
          frozen_materials, auth_scope, rubric, created_by)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7::jsonb, $8, $9::jsonb, $10::bigint)
       RETURNING id::text AS id, public_id`,
      [
        draft.publicId,
        draft.title,
        draft.sourceUrl,
        draft.sourcePlatform,
        draft.collectedAt,
        draft.frozenPrompt,
        JSON.stringify(draft.frozenMaterials),
        draft.authScope,
        JSON.stringify(draft.rubric),
        createdBy,
      ],
    )
    const row = result.rows[0]!
    return { id: row.id, publicId: row.public_id }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === '23505') {
      throw new TutorialEvalError('CONFLICT', 'case spec public_id already exists')
    }
    throw error
  }
}

export async function listCaseSpecs(): Promise<Array<Record<string, unknown>>> {
  const result = await query<{
    id: string
    public_id: string
    title: string
    source_url: string
    source_platform: string
    collected_at: Date | string
    frozen_prompt: string
    frozen_materials: unknown
    auth_scope: string
    rubric: unknown
    created_at: Date | string
  }>(
    `SELECT id::text AS id, public_id, title, source_url, source_platform, collected_at,
            frozen_prompt, frozen_materials, auth_scope, rubric, created_at
       FROM tutorial_case_specs
      ORDER BY created_at DESC, id DESC`,
  )
  return result.rows.map((row) => ({
    id: row.id,
    publicId: row.public_id,
    title: row.title,
    sourceUrl: row.source_url,
    sourcePlatform: row.source_platform,
    collectedAt: iso(row.collected_at),
    frozenPrompt: row.frozen_prompt,
    frozenMaterials: row.frozen_materials,
    authScope: row.auth_scope,
    rubric: row.rubric,
    createdAt: iso(row.created_at),
  }))
}

export async function enqueueEvalJob(args: {
  specId: string
  idempotencyKey: string
  publicationId?: string | null
  evalUserId?: string | null
}): Promise<{ id: string; status: EvalJobStatus; created: boolean }> {
  if (!args.evalUserId || !/^[1-9]\d*$/.test(args.evalUserId)) {
    throw new TutorialEvalError('BAD_SPEC', 'evalUserId must be an explicit synthetic user id')
  }
  try {
    const result = await query<{ id: string; status: EvalJobStatus; inserted: boolean }>(
      `INSERT INTO tutorial_eval_jobs (spec_id, publication_id, idempotency_key, eval_user_id)
       VALUES ($1::bigint, $2::bigint, $3, $4::bigint)
       ON CONFLICT (idempotency_key) DO UPDATE
         SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING id::text AS id, status, (xmax = 0) AS inserted`,
      [args.specId, args.publicationId ?? null, args.idempotencyKey, args.evalUserId],
    )
    const row = result.rows[0]!
    return { id: row.id, status: row.status, created: row.inserted }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === '23503') {
      throw new TutorialEvalError('NOT_FOUND', 'case spec not found')
    }
    throw error
  }
}

export type ClaimedEvalJob = {
  id: string
  specId: string
  publicationId: string | null
  evalUserId: string
  fencingToken: string
  attempt: number
  status: 'running'
  evidence: unknown
  result: string | null
  spec: {
    publicId: string
    title: string
    sourceUrl: string
    sourcePlatform: string
    collectedAt: string
    frozenPrompt: string
    frozenMaterials: unknown
    rubric: unknown
    createdBy: string
  }
}

export async function claimEvalJob(args: {
  ownerId: string
  leaseMs?: number
}): Promise<ClaimedEvalJob | null> {
  const leaseMs = Math.max(5_000, args.leaseMs ?? DEFAULT_EVAL_LEASE_MS)
  const fencingToken = `${args.ownerId}:${Date.now()}:${Math.random().toString(16).slice(2)}`
  return tx(async (client) => {
    const due = await client.query<{ id: string }>(
      `SELECT id::text AS id
         FROM tutorial_eval_jobs
        WHERE status = 'queued'
           OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < NOW()))
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
    )
    const id = due.rows[0]?.id
    if (!id) return null
    const updated = await client.query<{
      id: string
      spec_id: string
      publication_id: string | null
      eval_user_id: string | null
      fencing_token: string
      attempt: number
      evidence_json: unknown
      result: string | null
    }>(
      `UPDATE tutorial_eval_jobs
          SET status = 'running',
              attempt = attempt + 1,
              lease_owner = $2,
              fencing_token = $3,
              lease_expires_at = NOW() + ($4::bigint * INTERVAL '1 millisecond'),
              updated_at = NOW()
        WHERE id = $1::bigint
        RETURNING id::text AS id, spec_id::text AS spec_id,
                  publication_id::text AS publication_id, eval_user_id::text AS eval_user_id,
                  fencing_token, attempt, evidence_json, result`,
      [id, args.ownerId, fencingToken, leaseMs],
    )
    const row = updated.rows[0]
    if (!row) return null
    if (!row.eval_user_id) throw new TutorialEvalError('BAD_SPEC', 'eval job lacks synthetic user')
    const specResult = await client.query<{
      public_id: string
      title: string
      source_url: string
      source_platform: string
      collected_at: Date | string
      frozen_prompt: string
      frozen_materials: unknown
      rubric: unknown
      created_by: string
    }>(
      `SELECT public_id, title, source_url, source_platform, collected_at, frozen_prompt,
              frozen_materials, rubric, created_by::text AS created_by
         FROM tutorial_case_specs
        WHERE id = $1::bigint`,
      [row.spec_id],
    )
    const spec = specResult.rows[0]
    if (!spec) throw new TutorialEvalError('NOT_FOUND', 'case spec not found')
    const evalUser = await client.query<{ signal_traffic_class: string | null; status: string }>(
      `SELECT signal_traffic_class, status FROM users WHERE id = $1::bigint`,
      [row.eval_user_id],
    )
    const evalIdentity = evalUser.rows[0]
    if (
      !evalIdentity ||
      evalIdentity.status !== 'active' ||
      !['synthetic_canary', 'e2e'].includes(evalIdentity.signal_traffic_class ?? '')
    ) {
      throw new TutorialEvalError('BAD_SPEC', 'eval user is not an active synthetic account')
    }
    return {
      id: row.id,
      specId: row.spec_id,
      publicationId: row.publication_id,
      evalUserId: row.eval_user_id,
      fencingToken: row.fencing_token,
      attempt: row.attempt,
      status: 'running',
      evidence: row.evidence_json,
      result: row.result,
      spec: {
        publicId: spec.public_id,
        title: spec.title,
        sourceUrl: spec.source_url,
        sourcePlatform: spec.source_platform,
        collectedAt: iso(spec.collected_at)!,
        frozenPrompt: spec.frozen_prompt,
        frozenMaterials: spec.frozen_materials,
        rubric: spec.rubric,
        createdBy: spec.created_by,
      },
    }
  })
}

export async function finishEvalJob(args: {
  jobId: string
  fencingToken: string
  result: 'passed' | 'failed'
  evidence: unknown
  errorCode?: string | null
  publicationId?: string | null
}): Promise<{ status: EvalJobStatus }> {
  const next: EvalJobStatus = args.result === 'passed' ? 'passed' : 'compass_pending'
  const result = await query<{ status: EvalJobStatus }>(
    `UPDATE tutorial_eval_jobs
        SET status = $3,
            evidence_json = $4::jsonb,
            result = $5,
            error_code = $6,
            publication_id = COALESCE($7::bigint, publication_id),
            lease_expires_at = NULL,
            updated_at = NOW()
      WHERE id = $1::bigint AND fencing_token = $2 AND status = 'running'
      RETURNING status`,
    [
      args.jobId,
      args.fencingToken,
      next,
      JSON.stringify(args.evidence ?? null),
      args.result,
      args.errorCode ?? null,
      args.publicationId ?? null,
    ],
  )
  const row = result.rows[0]
  if (!row) throw new TutorialEvalError('LEASE_LOST', 'eval job fencing token mismatch or not running')
  return { status: row.status }
}

export async function stageEvalPublication(args: {
  jobId: string
  fencingToken: string
  publicationId: string
  evidence: unknown
}): Promise<void> {
  const result = await query(
    `UPDATE tutorial_eval_jobs
        SET publication_id = $3::bigint,
            evidence_json = $4::jsonb,
            result = 'passed_staged',
            updated_at = NOW()
      WHERE id = $1::bigint AND fencing_token = $2 AND status = 'running'`,
    [args.jobId, args.fencingToken, args.publicationId, JSON.stringify(args.evidence)],
  )
  if ((result.rowCount ?? 0) !== 1) {
    throw new TutorialEvalError('LEASE_LOST', 'eval job fencing token mismatch while staging')
  }
}

export async function recoverExpiredEvalLeases(): Promise<number> {
  const result = await query(
    `UPDATE tutorial_eval_jobs
        SET status = CASE
              WHEN status = 'compass_running' THEN 'compass_pending'
              ELSE 'queued'
            END,
            lease_owner = NULL,
            fencing_token = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
      WHERE status IN ('running', 'compass_running') AND lease_expires_at < NOW()`,
  )
  return result.rowCount ?? 0
}

export async function attachEvalEvidence(args: {
  jobId: string
  evidence: unknown
  result: 'passed' | 'failed'
}): Promise<{ status: EvalJobStatus }> {
  const next: EvalJobStatus = args.result === 'passed' ? 'passed' : 'compass_pending'
  const result = await query<{ status: EvalJobStatus }>(
    `UPDATE tutorial_eval_jobs
        SET status = $2,
            evidence_json = $3::jsonb,
            result = $4,
            lease_expires_at = NULL,
            updated_at = NOW()
      WHERE id = $1::bigint AND status IN ('queued', 'running', 'failed', 'compass_pending')
      RETURNING status`,
    [args.jobId, next, JSON.stringify(args.evidence), args.result],
  )
  const row = result.rows[0]
  if (!row) throw new TutorialEvalError('NOT_FOUND', 'eval job not found or not attachable')
  return { status: row.status }
}

export type ClaimedCompassJob = {
  id: string
  fencingToken: string
  specTitle: string
  errorCode: string | null
  evidence: unknown
}

export async function claimCompassJob(args: {
  ownerId: string
  leaseMs?: number
}): Promise<ClaimedCompassJob | null> {
  const leaseMs = Math.max(5_000, args.leaseMs ?? DEFAULT_EVAL_LEASE_MS)
  const fencingToken = `${args.ownerId}:${Date.now()}:${Math.random().toString(16).slice(2)}`
  return tx(async (client) => {
    const due = await client.query<{ id: string }>(
      `SELECT id::text AS id
         FROM tutorial_eval_jobs
        WHERE status = 'compass_pending'
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
    )
    const id = due.rows[0]?.id
    if (!id) return null
    const updated = await client.query<{
      id: string
      evidence_json: unknown
      error_code: string | null
      title: string
      fencing_token: string
    }>(
      `UPDATE tutorial_eval_jobs j
          SET status = 'compass_running',
              lease_owner = $2,
              fencing_token = $3,
              lease_expires_at = NOW() + ($4::bigint * INTERVAL '1 millisecond'),
              updated_at = NOW()
         FROM tutorial_case_specs s
        WHERE j.id = $1::bigint AND s.id = j.spec_id AND j.status = 'compass_pending'
        RETURNING j.id::text AS id, j.evidence_json, j.error_code, s.title, j.fencing_token`,
      [id, args.ownerId, fencingToken, leaseMs],
    )
    const row = updated.rows[0]
    return row
      ? {
          id: row.id,
          fencingToken: row.fencing_token,
          specTitle: row.title,
          errorCode: row.error_code,
          evidence: row.evidence_json,
        }
      : null
  })
}

export async function finishCompassJob(args: {
  jobId: string
  fencingToken: string
  clusterKey: string
  severity: 'P0' | 'P1' | 'P2'
  summary: string
  reusableFix?: string | null
  grokModel?: string | null
  taskboardTicket?: string | null
}): Promise<{ id: string }> {
  return tx(async (client) => {
    const locked = await client.query<{ id: string }>(
      `SELECT id::text AS id
         FROM tutorial_eval_jobs
        WHERE id = $1::bigint AND status = 'compass_running' AND fencing_token = $2
        FOR UPDATE`,
      [args.jobId, args.fencingToken],
    )
    if (!locked.rows[0]) throw new TutorialEvalError('LEASE_LOST', 'compass fencing token mismatch')
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO tutorial_compass_notes
         (eval_job_id, cluster_key, severity, summary, reusable_fix, grok_model, taskboard_ticket)
       VALUES ($1::bigint, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (eval_job_id) DO UPDATE
         SET cluster_key = EXCLUDED.cluster_key,
             severity = EXCLUDED.severity,
             summary = EXCLUDED.summary,
             reusable_fix = EXCLUDED.reusable_fix,
             grok_model = EXCLUDED.grok_model,
             taskboard_ticket = EXCLUDED.taskboard_ticket
       RETURNING id::text AS id`,
      [
        args.jobId,
        args.clusterKey,
        args.severity,
        args.summary,
        args.reusableFix ?? null,
        args.grokModel ?? TUTORIAL_COMPASS_GROK_MODEL,
        args.taskboardTicket ?? null,
      ],
    )
    await client.query(
      `UPDATE tutorial_eval_jobs
          SET status = 'compass_ready', lease_owner = NULL, fencing_token = NULL,
              lease_expires_at = NULL, updated_at = NOW()
        WHERE id = $1::bigint`,
      [args.jobId],
    )
    return { id: inserted.rows[0]!.id }
  })
}

export async function insertCompassNote(args: {
  evalJobId: string
  clusterKey: string
  severity: 'P0' | 'P1' | 'P2'
  summary: string
  reusableFix?: string | null
  grokModel?: string | null
  taskboardTicket?: string | null
}): Promise<{ id: string }> {
  return tx(async (client) => {
    const job = await client.query<{ status: EvalJobStatus }>(
      `SELECT status FROM tutorial_eval_jobs WHERE id = $1::bigint FOR UPDATE`,
      [args.evalJobId],
    )
    const status = job.rows[0]?.status
    if (!status) throw new TutorialEvalError('NOT_FOUND', 'eval job not found')
    if (status !== 'compass_pending' && status !== 'failed' && status !== 'compass_ready') {
      throw new TutorialEvalError('CONFLICT', 'eval job is not waiting for compass')
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO tutorial_compass_notes
         (eval_job_id, cluster_key, severity, summary, reusable_fix, grok_model, taskboard_ticket)
       VALUES ($1::bigint, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (eval_job_id) DO UPDATE
         SET cluster_key = EXCLUDED.cluster_key,
             severity = EXCLUDED.severity,
             summary = EXCLUDED.summary,
             reusable_fix = EXCLUDED.reusable_fix,
             grok_model = EXCLUDED.grok_model,
             taskboard_ticket = EXCLUDED.taskboard_ticket
       RETURNING id::text AS id`,
      [
        args.evalJobId,
        args.clusterKey,
        args.severity,
        args.summary,
        args.reusableFix ?? null,
        args.grokModel ?? TUTORIAL_COMPASS_GROK_MODEL,
        args.taskboardTicket ?? null,
      ],
    )
    await client.query(
      `UPDATE tutorial_eval_jobs
          SET status = 'compass_ready', updated_at = NOW()
        WHERE id = $1::bigint`,
      [args.evalJobId],
    )
    return { id: inserted.rows[0]!.id }
  })
}

export async function listEvalJobs(): Promise<Array<Record<string, unknown>>> {
  const result = await query<{
    id: string
    spec_id: string
    publication_id: string | null
    idempotency_key: string
    status: EvalJobStatus
    attempt: number
    lease_expires_at: Date | string | null
    result: string | null
    created_at: Date | string
  }>(
    `SELECT id::text AS id, spec_id::text AS spec_id, publication_id::text AS publication_id,
            idempotency_key, status, attempt, lease_expires_at, result, created_at
       FROM tutorial_eval_jobs
      ORDER BY id DESC
      LIMIT 100`,
  )
  return result.rows.map((row) => ({
    id: row.id,
    specId: row.spec_id,
    publicationId: row.publication_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempt: row.attempt,
    leaseExpiresAt: iso(row.lease_expires_at),
    result: row.result,
    createdAt: iso(row.created_at),
  }))
}

export async function listCompassNotes(): Promise<Array<Record<string, unknown>>> {
  const result = await query<{
    id: string
    eval_job_id: string
    cluster_key: string
    severity: string
    summary: string
    reusable_fix: string | null
    grok_model: string | null
    created_at: Date | string
  }>(
    `SELECT id::text AS id, eval_job_id::text AS eval_job_id, cluster_key, severity, summary,
            reusable_fix, grok_model, created_at
       FROM tutorial_compass_notes
      ORDER BY created_at DESC, id DESC
      LIMIT 100`,
  )
  return result.rows.map((row) => ({
    id: row.id,
    evalJobId: row.eval_job_id,
    clusterKey: row.cluster_key,
    severity: row.severity,
    summary: row.summary,
    reusableFix: row.reusable_fix,
    grokModel: row.grok_model,
    createdAt: iso(row.created_at),
  }))
}

export function buildCompassDelegatePrompt(pack: {
  jobId: string
  specTitle?: string
  errorCode?: string | null
  evidenceSummary: string
}): string {
  return [
    '分析以下脱敏后的教程评测失败包，输出 JSON：cluster_key、severity(P0|P1|P2)、summary、reusable_fix。',
    '禁止引用绝对路径、UID、token、session/container 身份。',
    `jobId=${pack.jobId}`,
    pack.specTitle ? `spec=${pack.specTitle}` : '',
    pack.errorCode ? `error=${pack.errorCode}` : '',
    pack.evidenceSummary,
  ]
    .filter(Boolean)
    .join('\n')
}
