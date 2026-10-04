/** OCV5-312: operator close of stop-probe rows pinned to a disabled Box
 * account. The resolver can never reach that account, so the keeper's terminal
 * proof is unreadable and the cleanup worker retried every two minutes forever.
 * No Box call and no invented proof: only ctx.boxState and an audit marker on
 * exact, expired rows. state, credits, usage and ancestors are not changed. */
import type { PoolClient } from "pg";
import { BOX_RUN_EXPIRED_AFTER_MS } from
  "../../packages/commercial/src/http/proxy/boxDurableJournal.js";

/** Not ACTIVE, not failed_stopped: nothing was proven about the remote run. */
export const BOX_UNREACHABLE_CLOSED_STATE = "operator_unreachable_closed";
const MODEL = "box-api-claude-opus-5-5";

export interface BoxUnreachableRun { readonly requestId: string; readonly runNonce: string }
export interface BoxUnreachableCloseResult {
  readonly requestId: string;
  readonly shape: "unbilled_leaf" | "billed_handoff";
  readonly action: "closed" | "would_close" | "already_closed";
  readonly priorBoxState: string;
}
export class BoxUnreachableCloseError extends Error {
  constructor(readonly code: string, readonly requestId?: string) {
    super(code); this.name = "BoxUnreachableCloseError";
  }
}
type Row = { request_id: string; state: string; final_credits: string | null;
  expired: boolean; usage: number; ctx: Record<string, unknown> };

/** Only the exact marker this tool writes counts as already closed. */
function closedPriorState(raw: unknown, ticket: string): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const marker = raw as Record<string, unknown>;
  return Object.keys(marker).sort().join(",")
      === "accountStatus,atMs,priorBoxState,remoteCleanup,terminalProof,ticket,v"
    && marker.v === 1 && marker.ticket === ticket && marker.accountStatus === "disabled"
    && marker.terminalProof === false && marker.remoteCleanup === false
    && Number.isSafeInteger(marker.atMs) && /^[0-9]{13}$/.test(String(marker.atMs))
    && typeof marker.priorBoxState === "string" ? marker.priorBoxState : null;
}

function classify(row: Row, accountId: string, runNonce: string, ticket: string):
  { shape: BoxUnreachableCloseResult["shape"]; prior: string; closed: boolean } {
  const ctx = row.ctx, id = row.request_id;
  if (!ctx || ctx.boxInvocationRecovery !== "v1" || ctx.boxInvocationMode !== "detached_tool"
    || ctx.model !== MODEL || ctx.boxAccountId !== accountId || ctx.boxRunNonce !== runNonce
    || typeof ctx.boxLeaseEpoch !== "string" || !/^[a-f0-9]{32}$/.test(ctx.boxLeaseEpoch)) {
    throw new BoxUnreachableCloseError("BOX_UNREACHABLE_IDENTITY_MISMATCH", id);
  }
  if (ctx.boxTerminalProof !== undefined || ctx.boxResumeRequestId !== undefined
    || ctx.settlementClaimId !== undefined) {
    throw new BoxUnreachableCloseError("BOX_UNREACHABLE_EVIDENCE_PRESENT", id);
  }
  const closed = ctx.boxState === BOX_UNREACHABLE_CLOSED_STATE;
  const closedPrior = closedPriorState(ctx.boxOperatorUnreachableClose, ticket);
  if (closed ? closedPrior === null : ctx.boxOperatorUnreachableClose !== undefined) {
    throw new BoxUnreachableCloseError("BOX_UNREACHABLE_SHAPE_INVALID", id);
  }
  const prior = closed ? closedPrior : ctx.boxState;
  const handoff = ctx.boxToolHandoff !== undefined;
  const shape = !handoff && row.state === "inflight" && row.final_credits === null
    && row.usage === 0 && ["unknown", "linked", "running"].includes(String(prior))
    ? "unbilled_leaf"
    : handoff && row.state === "committed" && row.final_credits !== null
      && row.usage >= 1 && ["handoff", "unknown"].includes(String(prior))
      ? "billed_handoff" : null;
  if (!shape) throw new BoxUnreachableCloseError("BOX_UNREACHABLE_SHAPE_INVALID", id);
  if (!row.expired) throw new BoxUnreachableCloseError("BOX_UNREACHABLE_RUN_NOT_EXPIRED", id);
  return { shape, prior: String(prior), closed };
}

/** One transaction, all rows or none. apply=false runs the same path and rolls back. */
export async function closeUnreachableBoxRows(
  pool: { connect(): Promise<Pick<PoolClient, "query" | "release">> },
  input: { uid: bigint; accountId: bigint; runs: readonly BoxUnreachableRun[];
    ticket: string; apply: boolean }): Promise<BoxUnreachableCloseResult[]> {
  const ids = input.runs.map((run) => run.requestId);
  if (input.uid <= 0n || input.accountId <= 0n || ids.length < 1 || ids.length > 8
    || new Set(ids).size !== ids.length || !/^OCV5-[0-9]{1,6}$/.test(input.ticket)
    || input.runs.some((run) => !/^[A-Za-z0-9_-]{1,64}$/.test(run.requestId)
      || !/^[a-f0-9]{24}$/.test(run.runNonce))) {
    throw new BoxUnreachableCloseError("BOX_UNREACHABLE_INPUT_INVALID");
  }
  const uid = input.uid.toString(), accountId = input.accountId.toString();
  const expirySec = BOX_RUN_EXPIRED_AFTER_MS / 1000;
  const client = await pool.connect();
  let finished = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    const peek = await client.query<{ request_id: string; session_id: string | null }>(
      `SELECT request_id,ctx->>'boxSessionId' AS session_id FROM request_finalize_journal
        WHERE request_id=ANY($1::text[]) AND user_id=$2`, [ids, uid]);
    const sessions = new Map(peek.rows.map((row) => [row.request_id, row.session_id]));
    for (const id of ids) {
      const session = sessions.get(id);
      if (typeof session !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(session)) {
        throw new BoxUnreachableCloseError("BOX_UNREACHABLE_ROW_MISSING", id);
      }
    }
    // Same keys, order and hash as the journal's own lock() helper.
    for (const key of [...new Set([`box:account:${accountId}`,
      ...ids.map((id) => `box:session:${uid}:${sessions.get(id)}`)])].sort()) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [key]);
    }
    // FOR SHARE: the account cannot be re-enabled before this commits.
    const account = await client.query<{ provider: string; status: string }>(
      "SELECT provider,status FROM claude_accounts WHERE id=$1 FOR SHARE", [accountId]);
    if (account.rowCount !== 1 || account.rows[0]?.provider !== "cursor"
      || account.rows[0]?.status !== "disabled") {
      throw new BoxUnreachableCloseError("BOX_UNREACHABLE_ACCOUNT_NOT_DISABLED");
    }
    const locked = await client.query<Omit<Row, "usage">>(
      `SELECT request_id,state,final_credits::text AS final_credits,ctx,
          created_at <= NOW() - make_interval(secs => $3::double precision) AS expired
         FROM request_finalize_journal
        WHERE request_id=ANY($1::text[]) AND user_id=$2 ORDER BY request_id FOR UPDATE`,
      [ids, uid, expirySec]);
    const byId = new Map(locked.rows.map((row) => [row.request_id, row]));
    const results: BoxUnreachableCloseResult[] = [];
    for (const run of input.runs) {
      const found = byId.get(run.requestId);
      if (!found || found.ctx?.boxSessionId !== sessions.get(run.requestId)) {
        throw new BoxUnreachableCloseError("BOX_UNREACHABLE_ROW_MISSING", run.requestId);
      }
      const usage = await client.query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM usage_records WHERE request_id=$1 AND user_id=$2",
        [run.requestId, uid]);
      const row: Row = { ...found, usage: usage.rows[0]?.n ?? -1 };
      const { shape, prior, closed } = classify(row, accountId, run.runNonce, input.ticket);
      if (closed) {
        results.push({ requestId: run.requestId, shape, action: "already_closed",
          priorBoxState: prior });
        continue;
      }
      const changed = await client.query(
        `UPDATE request_finalize_journal
            SET ctx=ctx || jsonb_build_object('boxState',$9::text,
              'boxOperatorUnreachableClose',jsonb_build_object('v',1,'ticket',$10::text,
                'atMs',(EXTRACT(EPOCH FROM NOW())*1000)::bigint,'priorBoxState',$4::text,
                'accountStatus','disabled','terminalProof',false,'remoteCleanup',false))
          WHERE request_id=$1 AND user_id=$2 AND state=$3 AND ctx->>'boxState'=$4
            AND ctx->>'boxAccountId'=$5 AND ctx->>'boxRunNonce'=$6
            AND ctx->>'boxLeaseEpoch'=$7
            AND ctx->>'boxInvocationRecovery'='v1'
            AND ctx->>'boxInvocationMode'='detached_tool'
            AND NOT (ctx ? 'boxTerminalProof') AND NOT (ctx ? 'boxResumeRequestId')
            AND NOT (ctx ? 'settlementClaimId')
            AND NOT (ctx ? 'boxOperatorUnreachableClose')
            AND (ctx ? 'boxToolHandoff')=$8::boolean
            AND (final_credits IS NOT NULL)=$8::boolean
            AND created_at <= NOW() - make_interval(secs => $11::double precision)`,
        [run.requestId, uid, row.state, prior, accountId, run.runNonce,
          row.ctx.boxLeaseEpoch, shape === "billed_handoff",
          BOX_UNREACHABLE_CLOSED_STATE, input.ticket, expirySec]);
      if (changed.rowCount !== 1) {
        throw new BoxUnreachableCloseError("BOX_UNREACHABLE_FENCE_LOST", run.requestId);
      }
      results.push({ requestId: run.requestId, shape,
        action: input.apply ? "closed" : "would_close", priorBoxState: prior });
    }
    await client.query(input.apply ? "COMMIT" : "ROLLBACK");
    finished = true;
    return results;
  } finally {
    if (!finished) await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}
