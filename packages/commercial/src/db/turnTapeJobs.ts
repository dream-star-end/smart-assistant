/**
 * Fenced job store for lossless tape materialization + billing/waiver handoff.
 * Claim/complete/fail/requeue copy turnRecoveryStore: due = queued OR leased-with
 * expired lease; owner+epoch CAS; FOR UPDATE SKIP LOCKED.
 */
import type { Pool, PoolClient } from "pg";

export type Queryable = Pick<Pool | PoolClient, "query">;

export const MATERIALIZATION_MAX_ATTEMPTS = 8;
export const SETTLEMENT_HOT_MAX_ATTEMPTS = 30;
export const SETTLEMENT_MAX_ATTEMPTS = SETTLEMENT_HOT_MAX_ATTEMPTS;
export const DEFAULT_LEASE_MS = 120_000;
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
export const SETTLEMENT_COLD_BACKOFF_MS = 60 * 60_000;
export const AWAITING_MATERIALIZATION = "awaiting_materialization";

export function jobBackoffMs(attempt: number): number {
  if (attempt <= 1) return BACKOFF_BASE_MS;
  const exp = Math.min(attempt - 1, 20);
  return Math.min(BACKOFF_BASE_MS * 2 ** exp, BACKOFF_MAX_MS);
}

export interface MaterializationJob {
  jobId: string;
  sessionId: string;
  userId: string;
  tapeId: string;
  dispatchId: string | null;
  attempt: number;
  leaseOwner: string;
  leaseEpoch: number;
}

export interface SettlementJob {
  jobId: string;
  sessionId: string;
  userId: string;
  tapeId: string;
  dispatchId: string | null;
  kind: "billing" | "waiver";
  payload: Record<string, unknown>;
  billingAnchorId: string | null;
  requestId: string | null;
  attempt: number;
  leaseOwner: string;
  leaseEpoch: number;
  status: string;
}

export async function enqueueMaterializationJob(
  q: Queryable,
  input: { sessionId: string; userId: string; tapeId: string; dispatchId?: string | null },
): Promise<void> {
  await q.query(
    `INSERT INTO turn_tape_materialization_jobs
       (session_id, user_id, tape_id, dispatch_id)
     VALUES ($1,$2,$3,$4::uuid)
     ON CONFLICT (session_id, user_id, tape_id) DO UPDATE SET
       status = CASE
         WHEN turn_tape_materialization_jobs.status IN ('complete','failed')
           THEN turn_tape_materialization_jobs.status
         ELSE 'queued'
       END,
       next_attempt_at = CASE
         WHEN turn_tape_materialization_jobs.status IN ('complete','failed')
           THEN turn_tape_materialization_jobs.next_attempt_at
         ELSE LEAST(turn_tape_materialization_jobs.next_attempt_at, NOW())
       END,
       updated_at = NOW()`,
    [input.sessionId, input.userId, input.tapeId, input.dispatchId ?? null],
  );
}

export async function enqueueSettlementJob(
  q: Queryable,
  input: {
    sessionId: string;
    userId: string;
    tapeId: string;
    dispatchId?: string | null;
    kind: "billing" | "waiver";
    payload: Record<string, unknown>;
    billingAnchorId?: string | null;
    requestId?: string | null;
    settlementHash?: string | null;
    held?: boolean;
    holdReason?: string;
  },
): Promise<void> {
  const status = input.held === false ? "queued" : "held";
  const holdReason = input.holdReason ?? (status === "held" ? AWAITING_MATERIALIZATION : null);
  await q.query(
    `INSERT INTO turn_tape_settlement_jobs
       (session_id, user_id, tape_id, dispatch_id, kind, payload, billing_anchor_id, request_id, status, last_error, settlement_hash)
     VALUES ($1,$2,$3,$4::uuid,$5,$6::jsonb,$7,$8,$9,$10,$11)
     ON CONFLICT (session_id, user_id, tape_id, kind) DO UPDATE SET
       payload = CASE
         WHEN turn_tape_settlement_jobs.status = 'complete'
           THEN turn_tape_settlement_jobs.payload
         WHEN turn_tape_settlement_jobs.settlement_hash IS NOT NULL
           AND EXCLUDED.settlement_hash IS NOT NULL
           AND turn_tape_settlement_jobs.settlement_hash <> EXCLUDED.settlement_hash
           THEN turn_tape_settlement_jobs.payload
         ELSE turn_tape_settlement_jobs.payload
       END,
       billing_anchor_id = COALESCE(turn_tape_settlement_jobs.billing_anchor_id, EXCLUDED.billing_anchor_id),
       request_id = COALESCE(turn_tape_settlement_jobs.request_id, EXCLUDED.request_id),
       settlement_hash = COALESCE(turn_tape_settlement_jobs.settlement_hash, EXCLUDED.settlement_hash),
       status = CASE
         WHEN turn_tape_settlement_jobs.status = 'complete' THEN 'complete'
         WHEN turn_tape_settlement_jobs.status = 'held'
           AND turn_tape_settlement_jobs.last_error IN ('late_tape_after_fence')
           THEN 'held'
         ELSE turn_tape_settlement_jobs.status
       END,
       updated_at = NOW()
     WHERE turn_tape_settlement_jobs.settlement_hash IS NULL
        OR EXCLUDED.settlement_hash IS NULL
        OR turn_tape_settlement_jobs.settlement_hash = EXCLUDED.settlement_hash`,
    [
      input.sessionId,
      input.userId,
      input.tapeId,
      input.dispatchId ?? null,
      input.kind,
      JSON.stringify(input.payload),
      input.billingAnchorId ?? null,
      input.requestId ?? null,
      status,
      holdReason,
      input.settlementHash ?? null,
    ],
  );
}

export async function holdSettlementJobsForTape(
  q: Queryable,
  input: { sessionId: string; userId: string; tapeId: string; reason: string },
): Promise<void> {
  await q.query(
    `UPDATE turn_tape_settlement_jobs
        SET status='held', last_error=$4, updated_at=NOW()
      WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
        AND status IN ('queued','leased','failed')`,
    [input.sessionId, input.userId, input.tapeId, input.reason],
  );
}

export async function releaseSettlementJobsAfterVerify(
  q: Queryable,
  input: { sessionId: string; userId: string; tapeId: string },
): Promise<void> {
  await q.query(
    `UPDATE turn_tape_settlement_jobs
        SET status='queued', last_error=NULL, next_attempt_at=NOW(), updated_at=NOW()
      WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
        AND status='held'
        AND last_error=$4`,
    [input.sessionId, input.userId, input.tapeId, AWAITING_MATERIALIZATION],
  );
}

export async function requeueFailedSettlementJob(
  q: Queryable,
  input: { sessionId: string; userId: string; tapeId: string; kind?: "billing" | "waiver" },
): Promise<number> {
  const result = await q.query(
    `UPDATE turn_tape_settlement_jobs
        SET status='queued', next_attempt_at=NOW(), updated_at=NOW()
      WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
        AND status IN ('failed','held')
        AND last_error IS DISTINCT FROM 'late_tape_after_fence'
        AND ($4::text IS NULL OR kind=$4)`,
    [input.sessionId, input.userId, input.tapeId, input.kind ?? null],
  );
  return result.rowCount ?? 0;
}

export async function claimDueMaterializationJobs(
  pool: Pool,
  input: { ownerId: string; leaseMs?: number; limit?: number },
): Promise<MaterializationJob[]> {
  const limit = Math.max(1, Math.min(4, Math.trunc(input.limit ?? 1)));
  const leaseMs = Math.max(5_000, Math.trunc(input.leaseMs ?? DEFAULT_LEASE_MS));
  const result = await pool.query<{
    job_id: string;
    session_id: string;
    user_id: string;
    tape_id: string;
    dispatch_id: string | null;
    attempt: number;
    lease_epoch: string;
  }>(
    `WITH due AS (
       SELECT job_id
         FROM turn_tape_materialization_jobs
        WHERE status IN ('queued','leased','failed')
          AND next_attempt_at<=NOW()
          AND (status IN ('queued','failed') OR lease_until<NOW())
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $3
     )
     UPDATE turn_tape_materialization_jobs j
        SET status='leased', lease_owner=$1, lease_epoch=j.lease_epoch+1,
            lease_until=NOW()+($2::bigint * INTERVAL '1 millisecond'),
            attempt=j.attempt+1, updated_at=NOW()
       FROM due WHERE j.job_id=due.job_id
     RETURNING j.job_id, j.session_id, j.user_id, j.tape_id, j.dispatch_id::text,
               j.attempt, j.lease_epoch::text`,
    [input.ownerId, leaseMs, limit],
  );
  return result.rows.map((row) => ({
    jobId: row.job_id,
    sessionId: row.session_id,
    userId: row.user_id,
    tapeId: row.tape_id,
    dispatchId: row.dispatch_id,
    attempt: row.attempt,
    leaseOwner: input.ownerId,
    leaseEpoch: Number(row.lease_epoch),
  }));
}

export async function claimDueSettlementJobs(
  pool: Pool,
  input: { ownerId: string; leaseMs?: number; limit?: number },
): Promise<SettlementJob[]> {
  const limit = Math.max(1, Math.min(8, Math.trunc(input.limit ?? 4)));
  const leaseMs = Math.max(5_000, Math.trunc(input.leaseMs ?? DEFAULT_LEASE_MS));
  const result = await pool.query<{
    job_id: string;
    session_id: string;
    user_id: string;
    tape_id: string;
    dispatch_id: string | null;
    kind: "billing" | "waiver";
    payload: Record<string, unknown>;
    billing_anchor_id: string | null;
    request_id: string | null;
    attempt: number;
    lease_epoch: string;
    status: string;
  }>(
    `WITH due AS (
       SELECT j.job_id
         FROM turn_tape_settlement_jobs j
         JOIN client_session_turn_tapes t
           ON t.session_id=j.session_id AND t.user_id=j.user_id AND t.tape_id=j.tape_id
        WHERE j.status IN ('queued','leased','failed')
          AND j.next_attempt_at<=NOW()
          AND (j.status IN ('queued','failed') OR j.lease_until<NOW())
          AND (t.settlement_verified_at IS NOT NULL
               OR t.materialization_status='complete'
               OR t.finalized_at IS NOT NULL)
        ORDER BY j.created_at
        FOR UPDATE OF j SKIP LOCKED
        LIMIT $3
     )
     UPDATE turn_tape_settlement_jobs j
        SET status='leased', lease_owner=$1, lease_epoch=j.lease_epoch+1,
            lease_until=NOW()+($2::bigint * INTERVAL '1 millisecond'),
            attempt=j.attempt+1, updated_at=NOW()
       FROM due WHERE j.job_id=due.job_id
     RETURNING j.job_id, j.session_id, j.user_id, j.tape_id, j.dispatch_id::text,
               j.kind, j.payload, j.billing_anchor_id, j.request_id, j.attempt,
               j.lease_epoch::text, j.status`,
    [input.ownerId, leaseMs, limit],
  );
  return result.rows.map((row) => ({
    jobId: row.job_id,
    sessionId: row.session_id,
    userId: row.user_id,
    tapeId: row.tape_id,
    dispatchId: row.dispatch_id,
    kind: row.kind,
    payload: row.payload,
    billingAnchorId: row.billing_anchor_id,
    requestId: row.request_id,
    attempt: row.attempt,
    leaseOwner: input.ownerId,
    leaseEpoch: Number(row.lease_epoch),
    status: row.status,
  }));
}

export async function renewMaterializationLease(
  q: Queryable,
  job: Pick<MaterializationJob, "jobId" | "leaseOwner" | "leaseEpoch">,
  leaseMs = DEFAULT_LEASE_MS,
): Promise<boolean> {
  const result = await q.query(
    `UPDATE turn_tape_materialization_jobs
        SET lease_until=NOW()+($4::bigint * INTERVAL '1 millisecond'), updated_at=NOW()
      WHERE job_id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND status='leased'`,
    [job.jobId, job.leaseOwner, job.leaseEpoch, Math.max(5_000, leaseMs)],
  );
  return (result.rowCount ?? 0) === 1;
}

export async function completeMaterializationJob(
  q: Queryable,
  job: Pick<MaterializationJob, "jobId" | "leaseOwner" | "leaseEpoch">,
): Promise<boolean> {
  const result = await q.query(
    `UPDATE turn_tape_materialization_jobs
        SET status='complete', last_error=NULL, updated_at=NOW()
      WHERE job_id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND status='leased'`,
    [job.jobId, job.leaseOwner, job.leaseEpoch],
  );
  return (result.rowCount ?? 0) === 1;
}

export async function failOrRequeueMaterializationJob(
  q: Queryable,
  job: MaterializationJob,
  error: string,
  maxAttempts = MATERIALIZATION_MAX_ATTEMPTS,
): Promise<"failed" | "requeued" | "lost"> {
  if (job.attempt >= maxAttempts) {
    const result = await q.query(
      `UPDATE turn_tape_materialization_jobs
          SET status='failed', last_error=$4,
              next_attempt_at=NOW()+($5::bigint * INTERVAL '1 millisecond'),
              updated_at=NOW()
        WHERE job_id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND status='leased'`,
      [job.jobId, job.leaseOwner, job.leaseEpoch, error.slice(0, 2000), SETTLEMENT_COLD_BACKOFF_MS],
    );
    if ((result.rowCount ?? 0) !== 1) return "lost";
    await q.query(
      `UPDATE client_session_turn_tapes
          SET materialization_status='failed',
              materialization_attempts=$4,
              materialization_error=$5
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
      [job.sessionId, job.userId, job.tapeId, job.attempt, error.slice(0, 2000)],
    );
    return "failed";
  }
  const result = await q.query(
    `UPDATE turn_tape_materialization_jobs
        SET status='queued', last_error=$4,
            next_attempt_at=NOW()+($5::bigint * INTERVAL '1 millisecond'),
            lease_owner=NULL, lease_until=NULL, updated_at=NOW()
      WHERE job_id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND status='leased'`,
    [job.jobId, job.leaseOwner, job.leaseEpoch, error.slice(0, 2000), jobBackoffMs(job.attempt)],
  );
  return (result.rowCount ?? 0) === 1 ? "requeued" : "lost";
}

export async function completeSettlementJob(
  q: Queryable,
  job: Pick<SettlementJob, "jobId" | "leaseOwner" | "leaseEpoch">,
): Promise<boolean> {
  const result = await q.query(
    `UPDATE turn_tape_settlement_jobs
        SET status='complete', last_error=NULL, updated_at=NOW()
      WHERE job_id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND status='leased'`,
    [job.jobId, job.leaseOwner, job.leaseEpoch],
  );
  return (result.rowCount ?? 0) === 1;
}

export async function failOrRequeueSettlementJob(
  q: Queryable,
  job: SettlementJob,
  error: string,
  maxAttempts = SETTLEMENT_HOT_MAX_ATTEMPTS,
): Promise<"failed" | "requeued" | "lost"> {
  const cold = job.attempt >= maxAttempts;
  const backoff = cold ? SETTLEMENT_COLD_BACKOFF_MS : jobBackoffMs(job.attempt);
  const result = await q.query(
    `UPDATE turn_tape_settlement_jobs
        SET status='queued', last_error=$4,
            next_attempt_at=NOW()+($5::bigint * INTERVAL '1 millisecond'),
            cold_attempts=cold_attempts + CASE WHEN $6 THEN 1 ELSE 0 END,
            lease_owner=NULL, lease_until=NULL, updated_at=NOW()
      WHERE job_id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND status='leased'`,
    [job.jobId, job.leaseOwner, job.leaseEpoch, error.slice(0, 2000), backoff, cold],
  );
  if ((result.rowCount ?? 0) !== 1) return "lost";
  return cold ? "failed" : "requeued";
}

export async function settlementHandoffPresent(
  q: Queryable,
  input: { sessionId: string; userId: string; tapeId: string },
): Promise<boolean> {
  const billing = await q.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM turn_tape_settlement_jobs
      WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND kind='billing'`,
    [input.sessionId, input.userId, input.tapeId],
  );
  const waiver = await q.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM turn_tape_settlement_jobs
      WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND kind='waiver'`,
    [input.sessionId, input.userId, input.tapeId],
  );
  const engine = await q.query<{ engine_billings: unknown; waive_reason: string | null }>(
    `SELECT engine_billings, waive_reason FROM client_session_turn_tapes
      WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
    [input.sessionId, input.userId, input.tapeId],
  );
  const header = engine.rows[0];
  if (!header) return false;
  const billings = Array.isArray(header.engine_billings) ? header.engine_billings : [];
  if (billings.length > 0 && Number(billing.rows[0]?.n ?? "0") === 0) return false;
  if (header.waive_reason && Number(waiver.rows[0]?.n ?? "0") === 0) return false;
  return true;
}
