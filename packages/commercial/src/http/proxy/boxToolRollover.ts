/** One bounded physical invocation may retire into another invocation of the same logical turn.
 * Claims contain hashes/identity only. No tool result is published by this module. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { BoxDurableJournalError, lock } from "./boxDurableJournal.js";
import { parseBoxBillingContext } from "./boxBillingContext.js";
import { parseBoxStoredToolHandoff, type BoxStoredToolHandoff } from "./boxStoredToolHandoff.js";
import { parseBoxTerminalProof } from "./boxTerminalProof.js";
import { BOX_TOOL_MAX_ROUNDS, BOX_TOOL_MAX_WALL_MS, BOX_TOOL_SPOOL_MAX_BYTES,
  BOX_TOOL_MESSAGE_STREAM_MAX_BYTES, BOX_TOOL_POST_ECHO_RESERVE_BYTES,
  reserveBoxToolEcho } from "./boxToolCapacity.js";

import { parseToolRollover, unadmittedToolRollover, unadmittedToolRolloverFieldsSql,
  type BoxToolRolloverReceipt, type BoxToolRolloverClaim } from "../../billing/boxToolRolloverIdentity.js";
export { parseToolRollover, unadmittedToolRollover,
  type BoxToolRolloverReceipt, type BoxToolRolloverClaim } from "../../billing/boxToolRolloverIdentity.js";
const UNADMITTED_SQL = unadmittedToolRolloverFieldsSql();
type Db = Pick<Pool,"connect"|"query">;
type Hash = { modelToolUseId: string; contentHash: string; isError: boolean };
export class BoxToolRolloverRequired extends Error {
  readonly code = "BOX_TOOL_ROLLOVER_REQUIRED";
  constructor(readonly claim: BoxToolRolloverClaim) { super("BOX_TOOL_ROLLOVER_REQUIRED"); }
}
function fail(): never { throw new BoxDurableJournalError("BOX_TOOL_ROLLOVER_FENCE_LOST"); }
function receiptOf(claim: BoxToolRolloverClaim): BoxToolRolloverReceipt {
  return { ...claim, accountId: claim.accountId.toString() };
}
async function activeDispatch(client: PoolClient, uid: bigint, ctx: Record<string,unknown>): Promise<void> {
  const billing = parseBoxBillingContext(ctx.boxBillingContext);
  if (!billing) fail();
  if (billing.dispatchId === null) return;
  const dispatch = await client.query<{ status: string; attempt_no: number; session_id: string }>(
    `SELECT status,attempt_no,session_id FROM turn_dispatches
      WHERE user_id=$1 AND dispatch_id=$2::uuid FOR SHARE`,[uid.toString(),billing.dispatchId]);
  const row = dispatch.rows[0];
  if (dispatch.rowCount !== 1 || !row || !["admitted","accepted"].includes(row.status)
    || row.attempt_no !== billing.attemptNo || row.session_id !== billing.sessionId) fail();
}

export function toolRolloverReason(roundNo: number, ageMs: number, spoolOffset: number,
  lastUserMessage: unknown): BoxToolRolloverReceipt["reason"] | null {
  if (!Number.isSafeInteger(roundNo) || roundNo < 1 || roundNo > BOX_TOOL_MAX_ROUNDS
    || !Number.isSafeInteger(ageMs) || ageMs < 0
    || !Number.isSafeInteger(spoolOffset) || spoolOffset < 1 || spoolOffset > BOX_TOOL_SPOOL_MAX_BYTES) fail();
  const echo = reserveBoxToolEcho(0,lastUserMessage);
  return roundNo >= BOX_TOOL_MAX_ROUNDS ? "rounds"
    : ageMs >= BOX_TOOL_MAX_WALL_MS - 30 * 60_000 ? "wall"
    : spoolOffset + echo + BOX_TOOL_MESSAGE_STREAM_MAX_BYTES
      + BOX_TOOL_POST_ECHO_RESERVE_BYTES > BOX_TOOL_SPOOL_MAX_BYTES ? "spool" : null;
}

/** Called only after the normal continuation has validated the complete exchange and billing identity. */
export async function claimToolRollover(client: PoolClient, input: { uid: bigint; requestId: string;
  ownerRequestId: string; ctx: Record<string,unknown>; childCtx: Record<string,unknown>;
  handoff: BoxStoredToolHandoff; nextContextHash: string; resultHashes: readonly Hash[];
  lastUserMessage: unknown }): Promise<BoxToolRolloverClaim | null> {
  const { ctx,handoff } = input;
  const roots = await client.query<{ age_ms: string }>(
    `SELECT (EXTRACT(EPOCH FROM (NOW()-created_at))*1000)::bigint::text AS age_ms
      FROM request_finalize_journal WHERE user_id=$1 AND ctx->>'boxRunNonce'=$2
        AND ctx->>'boxLeaseEpoch'=$3 AND ctx->>'boxAccountId'=$4
        AND ctx->>'boxInvocationMode'='detached_tool' AND NOT (ctx ? 'boxOwnerRequestId') LIMIT 2`,
    [input.uid.toString(),ctx.boxRunNonce,ctx.boxLeaseEpoch,ctx.boxAccountId]);
  if (roots.rowCount !== 1) fail();
  const age = Number(roots.rows[0]!.age_ms);
  if (!Number.isSafeInteger(age) || age < 0) fail();
  const reason = toolRolloverReason(handoff.roundNo,age,handoff.spoolOffset,input.lastUserMessage);
  if (!reason) return null;
  await activeDispatch(client,input.uid,input.childCtx);
  const receipt: BoxToolRolloverReceipt = { v: 1,requestId: input.requestId,
    ownerRequestId: input.ownerRequestId,accountId: String(ctx.boxAccountId),
    runNonce: String(ctx.boxRunNonce),leaseEpoch: String(ctx.boxLeaseEpoch),durableRevision: randomUUID(),
    reason,sessionId: String(ctx.boxSessionId),turnKey: String(ctx.boxTurnKey),model: String(ctx.model),
    nextContextHash: input.nextContextHash,resultHashes: input.resultHashes,roundNo: handoff.roundNo,
    catalogHash: handoff.catalogHash,detachedRunnerHash: handoff.detachedRunnerHash };
  if (!parseToolRollover(receipt)) fail();
  const owner = await client.query(`UPDATE request_finalize_journal SET ctx=ctx || $4::jsonb,updated_at=NOW()
    WHERE request_id=$1 AND user_id=$2 AND ctx->>'boxHandoffRevision'=$3
      AND ctx->>'boxState'='handoff' AND state IN ('inflight','finalizing','committed')
      AND NOT (ctx ? 'boxCancelIntent') AND NOT (ctx ? 'boxRecoveredBy')`,
    [input.ownerRequestId,input.uid.toString(),ctx.boxHandoffRevision,
      JSON.stringify({ boxRecoveredBy: input.requestId,boxRolloverTo: receipt })]);
  const child = await client.query(`UPDATE request_finalize_journal SET ctx=ctx || $3::jsonb,updated_at=NOW()
    WHERE request_id=$1 AND user_id=$2 AND state='inflight'
      AND ctx->>'model'=$4 AND ctx->>'boxInvocationRecovery'='v1'
      AND ctx ? 'billingPricing' AND ctx ? 'boxBillingContext'
      AND NOT (ctx ? 'boxState') AND NOT (ctx ? 'boxRolloverFrom')`,
    [input.requestId,input.uid.toString(),JSON.stringify({ boxRolloverFrom: receipt,
      boxSessionId: receipt.sessionId,boxTurnKey: receipt.turnKey }),receipt.model]);
  if (owner.rowCount !== 1 || child.rowCount !== 1) fail();
  return { ...receipt,accountId: BigInt(receipt.accountId) };
}

async function lockedChild(client: PoolClient, uid: bigint, requestId: string): Promise<Record<string,unknown>> {
  const peek = await client.query<{ ctx: Record<string,unknown> }>(
    "SELECT ctx FROM request_finalize_journal WHERE user_id=$1 AND request_id=$2",[uid.toString(),requestId]);
  const receipt = parseToolRollover(peek.rows[0]?.ctx.boxRolloverFrom);
  if (!receipt) fail();
  await lock(client,[`box:session:${uid}:${receipt.sessionId}`]);
  const row = await client.query<{ ctx: Record<string,unknown>; state: string }>(
    "SELECT ctx,state FROM request_finalize_journal WHERE user_id=$1 AND request_id=$2 FOR UPDATE",
    [uid.toString(),requestId]);
  if (row.rowCount !== 1 || row.rows[0]!.state !== "inflight") fail();
  return row.rows[0]!.ctx;
}

/** Proof has already closed every physical ancestor through the original stop coordinator. */
export async function finishToolRollover(pool: Db, input: { uid: bigint; requestId: string;
  claim: BoxToolRolloverClaim }): Promise<void> {
  const client = await pool.connect(); let done = false;
  try {
    await client.query("BEGIN");
    const child = await lockedChild(client,input.uid,input.requestId);
    const receipt = parseToolRollover(child.boxRolloverFrom);
    if (!receipt || receipt.requestId !== input.requestId || child.boxRolloverCancelled !== undefined
      || child.boxCancelIntent !== undefined || child.boxState !== undefined
      || !isDeepStrictEqual(receipt,receiptOf(input.claim))) fail();
    await activeDispatch(client,input.uid,child);
    const old = await client.query<{ request_id: string; state: string; ctx: Record<string,unknown> }>(
      `SELECT request_id,state,ctx FROM request_finalize_journal WHERE user_id=$1
        AND ctx->>'boxRunNonce'=$2 AND ctx->>'boxLeaseEpoch'=$3
        AND ctx->>'boxInvocationMode'='detached_tool' ORDER BY request_id FOR UPDATE`,
      [input.uid.toString(),receipt.runNonce,receipt.leaseEpoch]);
    if (old.rows.length !== receipt.roundNo || old.rows.length > BOX_TOOL_MAX_ROUNDS) fail();
    const byId = new Map(old.rows.map((row) => [row.request_id,row]));
    const leaf = byId.get(receipt.ownerRequestId);
    if (!leaf || leaf.ctx.boxRecoveredBy !== input.requestId
      || !isDeepStrictEqual(leaf.ctx.boxRolloverTo,receipt)) fail();
    const proof = parseBoxTerminalProof(`${JSON.stringify(leaf.ctx.boxTerminalProof)}\n`,
      { runNonce: receipt.runNonce,leaseEpoch: receipt.leaseEpoch });
    if (proof.reason === "worker_complete") fail();
    let cursor: string | undefined = receipt.ownerRequestId;
    let expected = receipt.roundNo;
    const seen = new Set<string>();
    while (cursor) {
      const row = byId.get(cursor);
      if (!row || seen.has(cursor) || !["inflight","finalizing","committed"].includes(row.state)
        || row.ctx.boxState !== "failed_stopped" || row.ctx.boxAccountId !== receipt.accountId
        || row.ctx.boxSessionId !== receipt.sessionId || row.ctx.boxTurnKey !== receipt.turnKey
        || row.ctx.model !== receipt.model) fail();
      seen.add(cursor);
      const handoff = parseBoxStoredToolHandoff(row.ctx.boxToolHandoff);
      if (!handoff || handoff.roundNo !== expected-- || handoff.catalogHash !== receipt.catalogHash
        || handoff.detachedRunnerHash !== receipt.detachedRunnerHash) fail();
      const parentId = row.ctx.boxOwnerRequestId;
      if (parentId !== undefined) {
        if (typeof parentId !== "string") fail();
        const parent = byId.get(parentId);
        if (!parent || parent.ctx.boxResumeRequestId !== cursor
          || parent.ctx.boxResumeRevision !== row.ctx.boxParentResumeRevision) fail();
      }
      cursor = parentId as string | undefined;
    }
    if (seen.size !== old.rows.length || expected !== 0) fail();
    await client.query(`UPDATE request_finalize_journal SET ctx=ctx || $4::jsonb,updated_at=NOW()
      WHERE user_id=$1 AND ctx->>'boxRunNonce'=$2 AND ctx->>'boxLeaseEpoch'=$3
        AND ctx->>'boxInvocationMode'='detached_tool' AND ctx->>'boxState'='failed_stopped'`,
      [input.uid.toString(),receipt.runNonce,receipt.leaseEpoch,JSON.stringify({ boxRolloverRetired: receipt })]);
    const ready = await client.query(`UPDATE request_finalize_journal SET ctx=ctx || $3::jsonb,updated_at=NOW()
      WHERE user_id=$1 AND request_id=$2 AND state='inflight'
        AND NOT (ctx ? 'boxRolloverCancelled') AND NOT (ctx ? 'boxCancelIntent') AND NOT (ctx ? 'boxState')`,
      [input.uid.toString(),input.requestId,JSON.stringify({ boxRolloverReady: receipt.durableRevision })]);
    if (ready.rowCount !== 1) fail();
    await client.query("COMMIT"); done = true;
  } finally { if (!done) await client.query("ROLLBACK").catch(() => {}); client.release(); }
}

/** Only server-installed, proof-backed retirement receipts leave the current idle set.
 * The receipt fixes the successor; a later proven-stopped orphan recovery may
 * legitimately replace boxRecoveredBy without undoing physical retirement. */
export function retiredToolRolloverSql(alias: string): string {
  const c = `${alias}.ctx`;
  return `COALESCE((${c}->>'boxState'='failed_stopped' AND jsonb_typeof(${c}->'boxRolloverRetired')='object'
    AND ${c}#>>'{boxRolloverRetired,v}'='1'
    AND ${c}#>>'{boxRolloverRetired,runNonce}'=${c}->>'boxRunNonce'
    AND ${c}#>>'{boxRolloverRetired,leaseEpoch}'=${c}->>'boxLeaseEpoch'
    AND ${c}#>>'{boxRolloverRetired,accountId}'=${c}->>'boxAccountId'
    AND EXISTS (SELECT 1 FROM request_finalize_journal retired_leaf
      JOIN request_finalize_journal successor ON successor.request_id=retired_leaf.ctx#>>'{boxRolloverTo,requestId}'
        AND successor.user_id=retired_leaf.user_id
      WHERE retired_leaf.user_id=${alias}.user_id
        AND retired_leaf.request_id=${c}#>>'{boxRolloverRetired,ownerRequestId}'
        AND retired_leaf.ctx->'boxRolloverTo'=${c}->'boxRolloverRetired'
        AND successor.ctx->'boxRolloverFrom'=retired_leaf.ctx->'boxRolloverTo'
        AND successor.ctx->>'boxRolloverReady'=successor.ctx#>>'{boxRolloverFrom,durableRevision}'
        AND retired_leaf.ctx->>'boxState'='failed_stopped'
        AND retired_leaf.ctx#>>'{boxTerminalProof,runNonce}'=${c}->>'boxRunNonce'
        AND retired_leaf.ctx#>>'{boxTerminalProof,leaseEpoch}'=${c}->>'boxLeaseEpoch'
        AND retired_leaf.ctx#>>'{boxTerminalProof,reason}' IN ('keeper_stopped','worker_failed'))),false)`;
}

/** Caller holds the session lock and the child row lock through admit/launch. */
export async function assertToolRolloverLaunch(client: PoolClient, uid: bigint,
  requestId: string, ctx: Record<string,unknown>, expected?: {
    model: string; sessionId: string; turnKey: string; contextHash: string | undefined }): Promise<void> {
  if (ctx.boxRolloverFrom === undefined) return;
  const receipt = parseToolRollover(ctx.boxRolloverFrom);
  if (!receipt || receipt.requestId !== requestId || ctx.boxRolloverCancelled !== undefined
    || ctx.boxCancelIntent !== undefined || ctx.boxRolloverReady !== receipt.durableRevision) fail();
  const identity = expected ?? { model: String(ctx.model),sessionId: String(ctx.boxSessionId),
    turnKey: String(ctx.boxTurnKey),contextHash: typeof ctx.boxContextHash === "string" ? ctx.boxContextHash : undefined };
  if (identity.model !== receipt.model || identity.sessionId !== receipt.sessionId
    || identity.turnKey !== receipt.turnKey || identity.contextHash !== receipt.nextContextHash
    || ctx.model !== receipt.model || ctx.boxSessionId !== receipt.sessionId || ctx.boxTurnKey !== receipt.turnKey) fail();
  await activeDispatch(client,uid,ctx);
  const proof = await client.query<{ ctx: Record<string,unknown> }>(
    `SELECT old.ctx FROM request_finalize_journal old WHERE old.user_id=$1 AND old.request_id=$2
      AND ${retiredToolRolloverSql("old")}`,[uid.toString(),receipt.ownerRequestId]);
  if (proof.rowCount !== 1 || !isDeepStrictEqual(proof.rows[0]!.ctx.boxRolloverRetired,receipt)) fail();
}

export async function cancelToolRollovers(pool: Db, input: { uid: bigint; containerId: bigint;
  sessionId: string; turnKey: string }): Promise<boolean> {
  const client = await pool.connect(); let done = false;
  try {
    await client.query("BEGIN"); await lock(client,[`box:session:${input.uid}:${input.sessionId}`]);
    // admit and armGuardedLaunch use this same session/row fence. With no
    // admission state or physical identity, this successor never reached any
    // remote stage/paid launch. Close it through the existing prestart state,
    // without inventing a keeper proof or rewriting prior settled generations.
    // Admitted/unknown successors retain their physical stop-proof path.
    const cancelled = await client.query<{ request_id: string; state: string; ctx: Record<string,unknown> }>(
      `UPDATE request_finalize_journal
      SET ctx=ctx || '{"boxRolloverCancelled":true}'::jsonb ||
        CASE WHEN NOT (ctx ? 'boxState') AND ${UNADMITTED_SQL}
        THEN '{"boxState":"prestart_stopped"}'::jsonb ELSE '{}'::jsonb END,updated_at=NOW()
      WHERE user_id=$1 AND container_id=$2 AND ctx->>'boxSessionId'=$3 AND ctx->>'boxTurnKey'=$4
        AND (state='inflight' OR (state='aborted' AND final_credits=0 AND ${UNADMITTED_SQL}
          AND (NOT (ctx ? 'boxState') OR (ctx->>'boxState'='prestart_stopped'
            AND ctx->>'boxRolloverCancelled'='true'))))
        AND jsonb_typeof(ctx->'boxRolloverFrom')='object'
        AND ctx#>>'{boxRolloverFrom,requestId}'=request_id
        AND ctx#>>'{boxRolloverFrom,v}'='1'
        AND ctx#>>'{boxRolloverFrom,sessionId}'=$3 AND ctx#>>'{boxRolloverFrom,turnKey}'=$4
        AND ctx#>>'{boxRolloverFrom,model}'=ctx->>'model'
      RETURNING request_id,state,ctx`,
      [input.uid.toString(),input.containerId.toString(),input.sessionId,input.turnKey]);
    // Validate before COMMIT: the SQL has locked each returned row, and an
    // HTTP abort racing this transaction preserves ctx and zeroes this request
    // only. finalizing/committed financial ownership is never closed here.
    for (const row of cancelled.rows) {
      const receipt = parseToolRollover(row.ctx.boxRolloverFrom);
      if (!receipt || receipt.requestId !== row.request_id || receipt.model !== row.ctx.model
        || row.ctx.boxInvocationRecovery !== "v1"
        || receipt.sessionId !== input.sessionId || receipt.turnKey !== input.turnKey
        || (row.state === "aborted" && !unadmittedToolRollover(row.ctx,row.request_id))) fail();
    }
    await client.query("COMMIT"); done = true; return (cancelled.rowCount ?? 0) > 0;
  } finally { if (!done) await client.query("ROLLBACK").catch(() => {}); client.release(); }
}

/** Serialize the successor launch with the same durable row used by gap cancellation. */
export async function withToolRolloverLaunchFence(pool: Db, uid: bigint, requestId: string,
  run: (query: PoolClient["query"]) => Promise<void>): Promise<void> {
  const peek = await pool.query<{ ctx: Record<string,unknown> }>(
    "SELECT ctx FROM request_finalize_journal WHERE user_id=$1 AND request_id=$2",[uid.toString(),requestId]);
  if (peek.rows[0]?.ctx.boxRolloverFrom === undefined) { await run(pool.query.bind(pool)); return; }
  const client = await pool.connect(); let done = false;
  try {
    await client.query("BEGIN");
    const ctx = await lockedChild(client,uid,requestId);
    await assertToolRolloverLaunch(client,uid,requestId,ctx);
    await run(client.query.bind(client)); await client.query("COMMIT"); done = true;
  } finally { if (!done) await client.query("ROLLBACK").catch(() => {}); client.release(); }
}
