/**
 * Media studio task queue (OCV5-591 A1; plan §3). Same lease + epoch shape as the turn tape jobs:
 *
 *   claimable  status='queued' AND run_after<=NOW(), or status='leased' AND lease_until<NOW()
 *   claim      FOR UPDATE SKIP LOCKED; lease_owner=<instance>, lease_epoch+1, attempts+1, 90 s lease
 *   finish     owner + epoch CAS; a stale worker's writes match no row
 *
 * Both A/B masters run workers. A task with affinity='muse' is claimed only by a process whose Muse
 * bridge is online (the hub lives in that process's memory) — until its affinity_deadline passes;
 * after that any worker may claim it, but only to fail it over (`failover: true`), so a project never
 * waits forever on an offline bridge.
 *
 * exec_request_id (`studio:<task id>`) is fixed at enqueue and never changes across re-claims: every
 * provider call is keyed on it so a re-claimed task cannot pay twice.
 */
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'

export const STUDIO_LEASE_SECONDS = 90
export const STUDIO_AFFINITY_GRACE_SECONDS = 180

type Db = Pool | PoolClient

export interface StudioTaskLease {
  id: string
  owner: string
  epoch: number
}

export interface StudioTask extends StudioTaskLease {
  projectId: string
  kind: string
  payload: Record<string, unknown>
  attempts: number
  execRequestId: string
  affinity: 'muse' | null
  providerJobRef: Record<string, unknown> | null
  reservedCredits: bigint
  /** Claimed past its affinity deadline by a process that cannot serve it: fail over only. */
  failover: boolean
}

export interface EnqueueInput {
  projectId: string
  kind: string
  payload?: Record<string, unknown>
  /** Unique per logical step; a duplicate enqueue returns the existing task. */
  idempotencyKey: string
  affinity?: 'muse'
  runAfterSeconds?: number
  reservedCredits?: bigint
}

const KIND_RE = /^[a-z][a-z0-9_.]{0,63}$/

export async function enqueueStudioTask(
  db: Db,
  input: EnqueueInput,
): Promise<{ id: string; created: boolean }> {
  if (!KIND_RE.test(input.kind)) throw new Error('invalid studio task kind')
  if (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 200)
    throw new Error('invalid studio task idempotency key')
  const id = randomUUID()
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO studio_tasks(id, project_id, kind, payload, idempotency_key, run_after,
                              affinity, affinity_deadline, exec_request_id, reserved_credits)
     VALUES ($1, $2, $3, $4::jsonb, $5, NOW() + make_interval(secs => $6),
             $7, CASE WHEN $7::text IS NULL THEN NULL ELSE NOW() + make_interval(secs => $8) END,
             $10, $9)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id::text AS id`,
    [
      id,
      input.projectId,
      input.kind,
      JSON.stringify(input.payload ?? {}),
      input.idempotencyKey,
      Math.max(0, input.runAfterSeconds ?? 0),
      input.affinity ?? null,
      STUDIO_AFFINITY_GRACE_SECONDS + Math.max(0, input.runAfterSeconds ?? 0),
      (input.reservedCredits ?? 0n).toString(),
      `studio:${id}`,
    ],
  )
  if (inserted.rowCount === 1) return { id, created: true }
  const existing = await db.query<{ id: string; project_id: string }>(
    'SELECT id::text AS id, project_id::text AS project_id FROM studio_tasks WHERE idempotency_key=$1',
    [input.idempotencyKey],
  )
  const row = existing.rows[0]
  if (!row || row.project_id !== input.projectId)
    throw new Error('studio task idempotency key belongs to another project')
  return { id: row.id, created: false }
}

export async function claimStudioTasks(
  pool: Pool,
  input: { owner: string; limit?: number; museOnline: boolean; leaseSeconds?: number },
): Promise<StudioTask[]> {
  const limit = Math.max(1, Math.min(16, Math.trunc(input.limit ?? 4)))
  const lease = Math.max(15, Math.trunc(input.leaseSeconds ?? STUDIO_LEASE_SECONDS))
  const result = await pool.query<{
    id: string
    project_id: string
    kind: string
    payload: Record<string, unknown>
    attempts: number
    lease_epoch: number
    exec_request_id: string
    affinity: 'muse' | null
    provider_job_ref: Record<string, unknown> | null
    reserved_credits: string
    failover: boolean
  }>(
    `WITH due AS (
       SELECT id FROM studio_tasks
        WHERE ((status='queued' AND run_after<=NOW()) OR (status='leased' AND lease_until<NOW()))
          AND (affinity IS NULL OR $3::boolean OR affinity_deadline<=NOW())
        ORDER BY run_after, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $4
     )
     UPDATE studio_tasks t
        SET status='leased', lease_owner=$1, lease_epoch=t.lease_epoch+1,
            lease_until=NOW() + make_interval(secs => $2), attempts=t.attempts+1, updated_at=NOW()
       FROM due WHERE t.id=due.id
     RETURNING t.id::text AS id, t.project_id::text AS project_id, t.kind, t.payload, t.attempts,
               t.lease_epoch, t.exec_request_id, t.affinity, t.provider_job_ref,
               t.reserved_credits::text AS reserved_credits,
               (t.affinity IS NOT NULL AND NOT $3::boolean) AS failover`,
    [input.owner, lease, input.museOnline, limit],
  )
  return result.rows.map((row) => ({
    id: row.id,
    owner: input.owner,
    epoch: row.lease_epoch,
    projectId: row.project_id,
    kind: row.kind,
    payload: row.payload,
    attempts: row.attempts,
    execRequestId: row.exec_request_id,
    affinity: row.affinity,
    providerJobRef: row.provider_job_ref,
    reservedCredits: BigInt(row.reserved_credits),
    failover: row.failover,
  }))
}

const OWNED = "id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND status='leased'"

function leaseArgs(lease: StudioTaskLease): [string, string, number] {
  return [lease.id, lease.owner, lease.epoch]
}

/** Extends a live lease; false when it was lost (the worker must stop without side effects). */
export async function renewStudioTask(
  db: Db,
  lease: StudioTaskLease,
  leaseSeconds = STUDIO_LEASE_SECONDS,
): Promise<boolean> {
  const r = await db.query(
    `UPDATE studio_tasks SET lease_until=NOW() + make_interval(secs => $4), updated_at=NOW()
     WHERE ${OWNED}`,
    [...leaseArgs(lease), leaseSeconds],
  )
  return r.rowCount === 1
}

/** Caches a provider job reference (e.g. a Muse job id). Never the correctness anchor. */
export async function setStudioTaskJobRef(
  db: Db,
  lease: StudioTaskLease,
  ref: Record<string, unknown>,
): Promise<boolean> {
  const r = await db.query(
    `UPDATE studio_tasks SET provider_job_ref=$4::jsonb, updated_at=NOW() WHERE ${OWNED}`,
    [...leaseArgs(lease), JSON.stringify(ref)],
  )
  return r.rowCount === 1
}

export async function finishStudioTask(
  db: Db,
  lease: StudioTaskLease,
  outcome: { status: 'done' | 'failed' | 'canceled'; error?: string },
): Promise<boolean> {
  const r = await db.query(
    `UPDATE studio_tasks
        SET status=$4, last_error=$5, lease_owner=NULL, lease_until=NULL, updated_at=NOW()
      WHERE ${OWNED}`,
    [...leaseArgs(lease), outcome.status, outcome.error?.slice(0, 500) ?? null],
  )
  return r.rowCount === 1
}

/** Puts the task back with a delay (retryable provider failure). */
export async function retryStudioTask(
  db: Db,
  lease: StudioTaskLease,
  input: { delaySeconds: number; error: string },
): Promise<boolean> {
  const r = await db.query(
    `UPDATE studio_tasks
        SET status='queued', run_after=NOW() + make_interval(secs => $4), last_error=$5,
            lease_owner=NULL, lease_until=NULL, updated_at=NOW()
      WHERE ${OWNED}`,
    [...leaseArgs(lease), Math.max(0, input.delaySeconds), input.error.slice(0, 500)],
  )
  return r.rowCount === 1
}

/**
 * Cancels a project's queued tasks. Leased ones finish their in-flight upstream call (plan §4).
 * Their budget reservations are released and their bound takes canceled in the same statement
 * (OCV5-591 A2-1); any charge an earlier attempt still makes is booked by the reconciler.
 */
export async function cancelQueuedStudioTasks(db: Db, projectId: string): Promise<number> {
  const r = await db.query<{ n: string }>(
    `WITH old AS (
       SELECT id, reserved_credits AS held, payload->>'takeId' AS take_id
         FROM studio_tasks WHERE project_id=$1 AND status='queued' FOR UPDATE
     ), c AS (
       UPDATE studio_tasks t SET status='canceled', reserved_credits=0, updated_at=NOW()
         FROM old WHERE t.id=old.id RETURNING old.held, old.take_id
     ), tk AS (
       UPDATE studio_takes SET status='canceled', finished_at=NOW()
        WHERE project_id=$1 AND status='queued'
          AND id::text IN (SELECT take_id FROM c WHERE take_id IS NOT NULL)
       RETURNING id
     ), p AS (
       UPDATE studio_projects
          SET reserved_credits = GREATEST(0, reserved_credits - (SELECT COALESCE(SUM(held), 0) FROM c))
        WHERE id=$1
       RETURNING id
     )
     SELECT (SELECT COUNT(*) FROM c)::text AS n`,
    [projectId],
  )
  return Number(r.rows[0]?.n ?? 0)
}
