#!/usr/bin/env npx tsx
/**
 * Requeue failed/held lossless tape jobs after display-path repairs.
 *
 * Default is dry-run. Stage 1 only requeues the materialization job.
 * Stage 2 runs only when tape.settlement_verified_at is set: inside a
 * transaction it compares the settlement job's requestId / billingAnchorId /
 * engineBillings with the tape canonical settlement authority. Equal →
 * kind-precise requeue with rowCount assertion. Mismatch → stop and leave
 * `manual_reconcile`. Never blindly SET failed/held → queued.
 *
 *   npx tsx scripts/ops/requeue-failed-tape-jobs.ts --tape <id> [--tape <id> ...]
 *   npx tsx scripts/ops/requeue-failed-tape-jobs.ts --plan-tapes
 *   npx tsx scripts/ops/requeue-failed-tape-jobs.ts --tape <id> --execute --allow-production
 *
 * Uses DATABASE_URL / COMMERCIAL_DATABASE_URL. Refuses production database
 * openclaude_v5_selfhost unless --allow-production is also set.
 */
import pg from "pg";
import {
  enqueueMaterializationJob,
  requeueFailedSettlementJob,
  type Queryable,
} from "../../packages/commercial/src/db/turnTapeJobs.ts";
import { settlementPayloadEqual } from "../../packages/commercial/src/db/visibleFinalize.ts";

/** Tapes / sessions named in the display-hardening plan. */
export const PLAN_TAPES = [
  "843f251cf159ebeaa7475ddbe310ff8a965ed9ba6f1d23ef195402cec7d88f2b",
] as const;
export const PLAN_SESSIONS = [
  "webmsz3o93liz36ps",
  "webmt05xkjgp6pnoo",
  "webmt07iy5pmcg4pc",
] as const;

export type RequeueDecision =
  | { tapeId: string; action: "skip"; reason: string; detail?: Record<string, unknown> }
  | { tapeId: string; action: "requeue_materialization"; sessionId: string; userId: string }
  | {
      tapeId: string;
      action: "requeue_settlement";
      sessionId: string;
      userId: string;
      kind: "billing" | "waiver";
    }
  | { tapeId: string; action: "manual_reconcile"; reason: string; detail?: Record<string, unknown> };

export type TapeJobSnapshot = {
  tapeId: string;
  sessionId: string;
  userId: string;
  materializationStatus: string | null;
  materializationError: string | null;
  settlementVerifiedAt: string | null;
  billingAnchorId: string | null;
  requestId: string | null;
  engineBillings: unknown;
  settlementHash: string | null;
  matJob: { jobId: string; status: string; lastError: string | null } | null;
  settlementJobs: Array<{
    jobId: string;
    kind: "billing" | "waiver";
    status: string;
    lastError: string | null;
    billingAnchorId: string | null;
    requestId: string | null;
    payload: unknown;
    settlementHash: string | null;
  }>;
};

export function parseRequeueArgs(argv: string[]): {
  tapes: string[];
  execute: boolean;
  allowProduction: boolean;
  planTapes: boolean;
  sessionId?: string;
} {
  const tapes: string[] = [];
  let execute = false;
  let allowProduction = false;
  let planTapes = false;
  let sessionId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--execute" || token === "--apply") execute = true;
    else if (token === "--allow-production") allowProduction = true;
    else if (token === "--plan-tapes") planTapes = true;
    else if (token === "--tape" && argv[i + 1]) {
      tapes.push(argv[++i]!);
    } else if (token === "--session" && argv[i + 1]) {
      sessionId = argv[++i];
    }
  }
  return { tapes, execute, allowProduction, planTapes, sessionId };
}

export function jobAuthorityFromSettlement(job: TapeJobSnapshot["settlementJobs"][number]): {
  billingAnchorId: string | null;
  requestId: string | null;
  engineBillings: unknown;
} {
  const payload = job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
    ? job.payload as Record<string, unknown>
    : {};
  const payloadAnchor = typeof payload.billingAnchorId === "string" ? payload.billingAnchorId : null;
  const payloadRequest = typeof payload.requestId === "string" ? payload.requestId : null;
  return {
    billingAnchorId: job.billingAnchorId ?? payloadAnchor,
    requestId: job.requestId ?? payloadRequest,
    engineBillings: payload.engineBillings ?? payload.engine_billings ?? [],
  };
}

export function settlementJobMatchesTapeAuthority(
  job: TapeJobSnapshot["settlementJobs"][number],
  tape: Pick<TapeJobSnapshot, "billingAnchorId" | "requestId" | "engineBillings">,
): boolean {
  const jobAuth = jobAuthorityFromSettlement(job);
  const tapeAuth = {
    billingAnchorId: tape.billingAnchorId,
    requestId: tape.requestId,
    engineBillings: tape.engineBillings ?? [],
  };
  if (job.kind === "billing") {
    return settlementPayloadEqual(jobAuth, tapeAuth);
  }
  return jobAuth.billingAnchorId === tape.billingAnchorId;
}

export function planTapeRequeue(snapshot: TapeJobSnapshot): RequeueDecision[] {
  const out: RequeueDecision[] = [];
  if (!snapshot.matJob) {
    out.push({ tapeId: snapshot.tapeId, action: "skip", reason: "no_materialization_job" });
  } else if (snapshot.matJob.status === "complete") {
    out.push({
      tapeId: snapshot.tapeId,
      action: "skip",
      reason: "materialization_complete",
      detail: { status: snapshot.matJob.status },
    });
  } else {
    out.push({
      tapeId: snapshot.tapeId,
      action: "requeue_materialization",
      sessionId: snapshot.sessionId,
      userId: snapshot.userId,
    });
  }

  if (!snapshot.settlementVerifiedAt) {
    out.push({
      tapeId: snapshot.tapeId,
      action: "skip",
      reason: "settlement_not_verified",
      detail: {
        settlementVerifiedAt: snapshot.settlementVerifiedAt,
        jobs: snapshot.settlementJobs.map((job) => ({
          kind: job.kind,
          status: job.status,
          lastError: job.lastError,
        })),
      },
    });
    return out;
  }

  if (snapshot.settlementJobs.length === 0) {
    out.push({ tapeId: snapshot.tapeId, action: "skip", reason: "no_settlement_job" });
    return out;
  }

  for (const job of snapshot.settlementJobs) {
    if (job.status === "complete" || job.status === "queued" || job.status === "leased") {
      out.push({
        tapeId: snapshot.tapeId,
        action: "skip",
        reason: `settlement_${job.status}`,
        detail: { kind: job.kind },
      });
      continue;
    }
    if (job.lastError === "late_tape_after_fence") {
      out.push({
        tapeId: snapshot.tapeId,
        action: "manual_reconcile",
        reason: "late_tape_after_fence",
        detail: { kind: job.kind },
      });
      continue;
    }
    if (!settlementJobMatchesTapeAuthority(job, snapshot)) {
      out.push({
        tapeId: snapshot.tapeId,
        action: "manual_reconcile",
        reason: "settlement_authority_mismatch",
        detail: {
          kind: job.kind,
          job: jobAuthorityFromSettlement(job),
          tape: {
            billingAnchorId: snapshot.billingAnchorId,
            requestId: snapshot.requestId,
            engineBillings: snapshot.engineBillings,
          },
        },
      });
      continue;
    }
    out.push({
      tapeId: snapshot.tapeId,
      action: "requeue_settlement",
      sessionId: snapshot.sessionId,
      userId: snapshot.userId,
      kind: job.kind,
    });
  }
  return out;
}

export async function loadTapeJobSnapshot(
  q: Queryable,
  tapeId: string,
): Promise<TapeJobSnapshot | null> {
  const tape = (
    await q.query<{
      tape_id: string;
      session_id: string;
      user_id: string;
      materialization_status: string | null;
      materialization_error: string | null;
      settlement_verified_at: string | null;
      billing_anchor_id: string | null;
      request_id: string | null;
      engine_billings: unknown;
      settlement_hash: string | null;
    }>(
      `SELECT t.tape_id, t.session_id, t.user_id,
              t.materialization_status, t.materialization_error,
              t.settlement_verified_at::text, t.billing_anchor_id,
              t.settlement_hash,
              t.engine_billings,
              (
                SELECT j.request_id
                  FROM turn_tape_settlement_jobs j
                 WHERE j.session_id=t.session_id AND j.user_id=t.user_id AND j.tape_id=t.tape_id
                   AND j.kind='billing'
                 LIMIT 1
              ) AS request_id
         FROM client_session_turn_tapes t
        WHERE t.tape_id=$1
        LIMIT 1`,
      [tapeId],
    )
  ).rows[0];
  if (!tape) return null;

  const mat = (
    await q.query<{ job_id: string; status: string; last_error: string | null }>(
      `SELECT job_id::text, status, last_error
         FROM turn_tape_materialization_jobs
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
        LIMIT 1`,
      [tape.session_id, tape.user_id, tape.tape_id],
    )
  ).rows[0] ?? null;

  const settlements = (
    await q.query<{
      job_id: string;
      kind: "billing" | "waiver";
      status: string;
      last_error: string | null;
      billing_anchor_id: string | null;
      request_id: string | null;
      payload: unknown;
      settlement_hash: string | null;
    }>(
      `SELECT job_id::text, kind, status, last_error, billing_anchor_id, request_id,
              payload, settlement_hash
         FROM turn_tape_settlement_jobs
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
        ORDER BY kind`,
      [tape.session_id, tape.user_id, tape.tape_id],
    )
  ).rows;

  return {
    tapeId: tape.tape_id,
    sessionId: tape.session_id,
    userId: tape.user_id,
    materializationStatus: tape.materialization_status,
    materializationError: tape.materialization_error,
    settlementVerifiedAt: tape.settlement_verified_at,
    billingAnchorId: tape.billing_anchor_id,
    requestId: tape.request_id,
    engineBillings: tape.engine_billings,
    settlementHash: tape.settlement_hash,
    matJob: mat
      ? { jobId: mat.job_id, status: mat.status, lastError: mat.last_error }
      : null,
    settlementJobs: settlements.map((job) => ({
      jobId: job.job_id,
      kind: job.kind,
      status: job.status,
      lastError: job.last_error,
      billingAnchorId: job.billing_anchor_id,
      requestId: job.request_id,
      payload: job.payload,
      settlementHash: job.settlement_hash,
    })),
  };
}

export async function applyTapeRequeue(
  q: Queryable,
  decisions: RequeueDecision[],
): Promise<Array<RequeueDecision & { rowCount?: number }>> {
  const applied: Array<RequeueDecision & { rowCount?: number }> = [];
  for (const decision of decisions) {
    if (decision.action === "requeue_materialization") {
      await enqueueMaterializationJob(q, {
        sessionId: decision.sessionId,
        userId: decision.userId,
        tapeId: decision.tapeId,
      });
      applied.push({ ...decision, rowCount: 1 });
      continue;
    }
    if (decision.action === "requeue_settlement") {
      const rowCount = await requeueFailedSettlementJob(q, {
        sessionId: decision.sessionId,
        userId: decision.userId,
        tapeId: decision.tapeId,
        kind: decision.kind,
      });
      if (rowCount !== 1) {
        throw new Error(
          `settlement requeue rowCount=${rowCount} expected 1 for ${decision.tapeId} kind=${decision.kind}`,
        );
      }
      applied.push({ ...decision, rowCount });
      continue;
    }
    applied.push(decision);
  }
  return applied;
}

async function main(): Promise<void> {
  const args = parseRequeueArgs(process.argv.slice(2));
  const tapes = [...args.tapes];
  if (args.planTapes) tapes.push(...PLAN_TAPES);
  if (tapes.length === 0 && !args.sessionId) {
    console.error(
      "usage: requeue-failed-tape-jobs.ts --tape <id> [--tape <id> ...] [--execute] [--allow-production]\n" +
        "       requeue-failed-tape-jobs.ts --plan-tapes [--execute] [--allow-production]",
    );
    process.exit(2);
  }
  const url = process.env.COMMERCIAL_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("COMMERCIAL_DATABASE_URL or DATABASE_URL required");
    process.exit(2);
  }
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    const db = await pool.query<{ current_database: string }>("SELECT current_database()");
    const dbName = db.rows[0]?.current_database ?? "";
    if (dbName === "openclaude_v5_selfhost" && !allowProductionFlag(args.allowProduction, args.execute)) {
      console.error(`refusing production database ${dbName} (pass --allow-production to override)`);
      process.exit(3);
    }
    const ids = [...tapes];
    if (args.planTapes) {
      const extra = await pool.query<{ tape_id: string }>(
        `SELECT tape_id FROM client_session_turn_tapes
          WHERE session_id=ANY($1::text[])
            AND (
              materialization_status IN ('failed','pending','running')
              OR materialization_error IS NOT NULL
            )
          ORDER BY session_id, created_at`,
        [PLAN_SESSIONS],
      );
      for (const row of extra.rows) ids.push(row.tape_id);
    }
    if (args.sessionId) {
      const extra = await pool.query<{ tape_id: string }>(
        `SELECT tape_id FROM client_session_turn_tapes
          WHERE session_id=$1
            AND (
              materialization_status IN ('failed','pending','running')
              OR materialization_error IS NOT NULL
            )
          ORDER BY created_at`,
        [args.sessionId],
      );
      for (const row of extra.rows) ids.push(row.tape_id);
    }
    const unique = [...new Set(ids.filter((id) => id.length > 0))];
    const report: unknown[] = [];
    for (const tapeId of unique) {
      const snapshot = await loadTapeJobSnapshot(pool, tapeId);
      if (!snapshot) {
        report.push({ tapeId, action: "skip", reason: "tape_not_found" });
        continue;
      }
      const decisions = planTapeRequeue(snapshot);
      if (!args.execute) {
        report.push({
          tapeId,
          dryRun: true,
          snapshot: {
            sessionId: snapshot.sessionId,
            materializationStatus: snapshot.materializationStatus,
            materializationError: snapshot.materializationError,
            settlementVerifiedAt: snapshot.settlementVerifiedAt,
            matJob: snapshot.matJob,
            settlementJobs: snapshot.settlementJobs.map((job) => ({
              kind: job.kind,
              status: job.status,
              lastError: job.lastError,
            })),
          },
          decisions,
        });
        continue;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const applied = await applyTapeRequeue(client, decisions);
        await client.query("COMMIT");
        report.push({ tapeId, dryRun: false, applied });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
    console.log(JSON.stringify({
      dryRun: !args.execute,
      database: dbName,
      tapes: unique,
      report,
    }, null, 2));
    if (!args.execute) {
      console.log("dry-run: pass --execute to apply materialization/settlement requeues");
    }
  } finally {
    await pool.end();
  }
}

function allowProductionFlag(allowProduction: boolean, execute: boolean): boolean {
  return allowProduction || !execute;
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith("requeue-failed-tape-jobs.ts")
  || process.argv[1].includes("requeue-failed-tape-jobs")
);
if (isMain) {
  void main();
}
