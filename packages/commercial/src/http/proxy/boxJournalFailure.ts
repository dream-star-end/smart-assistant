import { unsentResumeChildClaimSql } from "./boxOrphanRecovery.js";
/** Journal failure persistence and candidate selection. This module has no
 * runtime dependency on BoxDurableJournal. The caller retains the single
 * transaction/session lock and the complete prepared/owner-chain binder. */
import { isBoxApiModel } from "@openclaude/protocol";
import type { Pool, PoolClient } from "pg";
import type { ProxyBody } from "./shared.js";
import type { BoxCallFingerprint } from "./boxCallFingerprint.js";
import type { AuthorityProjection, PreparedContinuation } from "./boxPreparedContinuation.js";
import type { BoxReplayIdentity } from "./boxDurableJournal.js";
import { parseBoxTerminalProof } from "./boxTerminalProof.js";
import { parseBoxFirstFailure, type BoxFailureInput, type BoxFirstFailure,
  type BoxFallbackFailure } from "./boxFailureEvidence.js";

type JournalErrorConstructor = new (code: string) => Error;
export interface BoxFailureLookupInput {
  uid: bigint; canonicalModel: string; canonicalBody: ProxyBody;
  trustedAuthority?: AuthorityProjection; prepared?: PreparedContinuation;
}
export type BoxFirstFailureRecordInput = BoxFailureInput & {
  requestId: string; uid: bigint; accountId: bigint; runNonce: string;
  leaseEpoch: string; ownerRequestId?: string;
};
export type BoxReadOnlyFallbackOutcome =
  | { kind: "identity"; identity: BoxReplayIdentity }
  | { kind: "failure"; failure: BoxFallbackFailure };
export type BoxFailureReadOnlyIdentity = BoxReplayIdentity & { firstFailure?: BoxFirstFailure };

export async function recordBoxFirstFailure(pool: Pick<Pool, "connect">,
  input: BoxFirstFailureRecordInput, ErrorType: JournalErrorConstructor): Promise<BoxFirstFailure | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId) || input.uid <= 0n
    || input.accountId <= 0n || !/^[a-f0-9]{24}$/.test(input.runNonce)
    || !/^[a-f0-9]{32}$/.test(input.leaseEpoch)
    || (input.ownerRequestId !== undefined
      && !/^[A-Za-z0-9_-]{1,64}$/.test(input.ownerRequestId))) {
    throw new ErrorType("BOX_FAILURE_IDENTITY_INVALID");
  }
  const projected = parseBoxFirstFailure({ version: 1, observedAtMs: 1,
    code: input.code, phase: input.phase,
    ...(input.diagnostic !== undefined ? { diagnostic: input.diagnostic } : {}) });
  if (!projected) throw new ErrorType("BOX_FAILURE_EVIDENCE_INVALID");
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    const found = await client.query<{ state: string; failure_code: string | null; ctx: Record<string, unknown>;
      observed_ms: string }>(
      `SELECT state,failure_code,ctx,FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint AS observed_ms
         FROM request_finalize_journal WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
      [input.requestId, input.uid.toString()]);
    const row = found.rows[0], ctx = row?.ctx;
    if (found.rowCount !== 1 || !row || !ctx || ctx.boxInvocationRecovery !== "v1"
      || typeof ctx.model !== "string" || !isBoxApiModel(ctx.model)
      || ctx.boxAccountId !== input.accountId.toString()
      || ctx.boxRunNonce !== input.runNonce || ctx.boxLeaseEpoch !== input.leaseEpoch
      || ctx.boxOwnerRequestId !== input.ownerRequestId
      || typeof ctx.boxSessionId !== "string" || ctx.boxSessionId.length < 1
      || ctx.boxSessionId.length > 256 || typeof ctx.boxTurnKey !== "string"
      || ctx.boxTurnKey.length < 1 || ctx.boxTurnKey.length > 256
      || typeof ctx.boxReplayFingerprint !== "string"
      || !/^[a-f0-9]{64}$/.test(ctx.boxReplayFingerprint)
      || typeof ctx.boxRequestHash !== "string" || !/^[a-f0-9]{64}$/.test(ctx.boxRequestHash)) {
      throw new ErrorType("BOX_FAILURE_IDENTITY_INVALID");
    }
    const successful = ctx.boxReplayMessage !== undefined || ctx.boxToolHandoff !== undefined
      || ctx.boxUsage !== undefined || row.state === "committed";
    const usage = successful ? null : await client.query(
      "SELECT 1 FROM usage_records WHERE request_id=$1 AND user_id=$2 LIMIT 1",
      [input.requestId, input.uid.toString()]);
    if (successful || usage?.rowCount) {
      await client.query("COMMIT"); committed = true; return null;
    }
    if (Object.hasOwn(ctx, "boxFirstFailure")) {
      const first = parseBoxFirstFailure(ctx.boxFirstFailure);
      if (!first) throw new ErrorType("BOX_FAILURE_EVIDENCE_INVALID");
      await client.query("COMMIT"); committed = true; return first;
    }
    // A real Stop already recorded before any failure is not an upstream
    // error. Decoder cleanup may add the same intent after the first error;
    // that path returned its original evidence above and keeps it intact.
    if (Object.hasOwn(ctx, "boxCancelIntent") || row.failure_code === "USER_CANCELLED") {
      await client.query("COMMIT"); committed = true; return null;
    }
    if (!["inflight", "finalizing", "aborted"].includes(row.state)
      || !["reserved", "starting", "running", "resuming", "linked", "unknown",
        "failed_stopped", "prestart_stopped"].includes(String(ctx.boxState))) {
      throw new ErrorType("BOX_FAILURE_FENCE_LOST");
    }
    const evidence = parseBoxFirstFailure({ ...projected, observedAtMs: Number(row.observed_ms) });
    if (!evidence) throw new ErrorType("BOX_FAILURE_EVIDENCE_INVALID");
    const changed = await client.query(
      `UPDATE request_finalize_journal
          SET ctx=ctx || jsonb_build_object('boxFirstFailure',$6::jsonb),updated_at=NOW()
        WHERE request_id=$1 AND user_id=$2 AND ctx->>'boxAccountId'=$3
          AND ctx->>'boxRunNonce'=$4 AND ctx->>'boxLeaseEpoch'=$5
          AND ctx->>'boxOwnerRequestId' IS NOT DISTINCT FROM $7::text
          AND NOT (ctx ? 'boxFirstFailure') AND NOT (ctx ? 'boxReplayMessage')
          AND NOT (ctx ? 'boxToolHandoff') AND NOT (ctx ? 'boxUsage')`,
      [input.requestId, input.uid.toString(), input.accountId.toString(), input.runNonce,
        input.leaseEpoch, JSON.stringify(evidence), input.ownerRequestId ?? null]);
    if (changed.rowCount !== 1) throw new ErrorType("BOX_FAILURE_FENCE_LOST");
    await client.query("COMMIT"); committed = true; return evidence;
  } finally {
    if (!committed) await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

/** Only a non-streaming fallback may observe a stopped failure. Bound live or
 * ready identity wins; callers must not translate that result into missing. */
export async function readBoxFallbackOutcome(input: BoxFailureLookupInput,
  readBound: () => Promise<BoxFailureReadOnlyIdentity | null>, ErrorType: JournalErrorConstructor):
  Promise<BoxReadOnlyFallbackOutcome | null> {
  if ((input.canonicalBody as { stream?: boolean }).stream !== false) {
    throw new ErrorType("BOX_FAILURE_REPLAY_REQUIRES_NONSTREAMING");
  }
  const identity = await readBound();
  if (!identity) return null;
  if (identity.firstFailure) return { kind: "failure", failure: {
    ...identity.firstFailure, requestId: identity.requestId } };
  return { kind: "identity", identity };
}

const STOPPED_FAILURE_CANDIDATE = `state='aborted' AND failure_code IS DISTINCT FROM 'USER_CANCELLED'
            AND ctx->>'boxState'='failed_stopped'
            AND ctx ? 'boxFirstFailure'
            AND NOT (ctx ? 'boxReplayMessage') AND NOT (ctx ? 'boxToolHandoff')
            AND NOT (ctx ? 'boxUsage')
            AND NOT EXISTS (SELECT 1 FROM usage_records u
              WHERE u.request_id=request_finalize_journal.request_id AND u.user_id=$1)
            AND ($7::boolean IS FALSE OR CASE
              WHEN jsonb_typeof(ctx->'boxFirstFailure'->'observedAtMs')='number'
                AND (ctx->'boxFirstFailure'->>'observedAtMs') ~ '^[1-9][0-9]{0,15}$'
              THEN (ctx->'boxFirstFailure'->>'observedAtMs')::bigint
                BETWEEN FLOOR(EXTRACT(EPOCH FROM NOW()-INTERVAL '10 minutes')*1000)::bigint
                AND FLOOR(EXTRACT(EPOCH FROM NOW()+INTERVAL '5 seconds')*1000)::bigint
              ELSE FALSE END)`;
type CandidateRow = { request_id: string; ctx: Record<string, unknown> };
/** The caller already holds its transaction's exact session advisory lock.
 * Recheck normal candidates and only then failures on this SAME client. */
export async function selectBoxReadOnlyCandidate(client: Pick<PoolClient, "query">,
  input: { uid: bigint; canonicalModel: string; fingerprint: BoxCallFingerprint;
    stream: boolean; key: string; legacyUnsigned: boolean; includeFailure: boolean },
  ErrorType: JournalErrorConstructor): Promise<{ row: CandidateRow; failureOnly: boolean } | null> {
  const column = input.stream === false ? "boxFallbackAlias" : "boxReplayFingerprint";
  const params = [input.uid.toString(), input.fingerprint.sessionId,
    input.fingerprint.turnKey, input.canonicalModel, column, input.key];
  const query = (predicate: string, values: unknown[]) => client.query<CandidateRow>(
    `SELECT request_id,ctx FROM request_finalize_journal
      WHERE user_id=$1 AND ctx->>'boxSessionId'=$2
        AND ctx->>'boxTurnKey'=$3 AND ctx->>'model'=$4 AND ctx->>$5=$6
        AND NOT (${unsentResumeChildClaimSql("request_finalize_journal")})
        AND (${predicate}) LIMIT 2`, values);
  const normal = await query(`NOT (state='aborted' AND NOT (ctx ? 'boxReplayMessage')
    AND COALESCE(ctx->>'boxState','') IN ('failed_stopped','prestart_stopped'))`, params);
  if (normal.rows.length > 1) throw new ErrorType("BOX_CALL_AMBIGUOUS");
  if (normal.rows[0]) return { row: normal.rows[0], failureOnly: false };
  if (!input.includeFailure) return null;
  const failed = await query(STOPPED_FAILURE_CANDIDATE, [...params, input.legacyUnsigned]);
  if (failed.rows.length > 1) throw new ErrorType("BOX_CALL_AMBIGUOUS");
  return failed.rows[0] ? { row: failed.rows[0], failureOnly: true } : null;
}

export function requireBoxFirstFailure(raw: unknown, ErrorType: JournalErrorConstructor): BoxFirstFailure {
  const failure = parseBoxFirstFailure(raw);
  if (!failure) throw new ErrorType("BOX_FAILURE_EVIDENCE_INVALID");
  return failure;
}

export function assertBoxFailureTerminal(ctx: Record<string, unknown>,
  expected: { runNonce: string; leaseEpoch: string }, ErrorType: JournalErrorConstructor): void {
  try {
    const proof = parseBoxTerminalProof(JSON.stringify(ctx.boxTerminalProof) + "\n", expected);
    if ((proof.reason === "worker_complete") !== (ctx.boxStopOutcome === "rejected_stream")) {
      throw new Error("unbound failure proof");
    }
  } catch { throw new ErrorType("BOX_FAILURE_EVIDENCE_INVALID"); }
}
