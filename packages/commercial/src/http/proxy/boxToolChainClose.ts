/**
 * Multi-row chain-closing transactions extracted from `boxDurableJournal.ts`.
 *
 * Pure structural extraction keeping every lock order, validation fence,
 * error code, and billing-store write identical to `BoxDurableJournal`.
 */
import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import { isBoxApiModelPair } from "@openclaude/protocol";
import {
  selectUsageRecordExists,
  updateExpiredUnprovenAncestor,
  updateExpiredUnprovenLeaf,
  updateToolChainAncestorStoppedFailure,
  updateToolChainAncestorTerminal,
  updateToolChainFinalTerminal,
  updateToolChainHandoffStoppedFailure,
  updateToolChainUnbilledStoppedFailure,
} from "../../billing/boxBillingStore.js";
import {
  BoxDurableJournalError,
  lockChainSession,
  validUsageEvidence,
  type BoxExpiredCloseResult,
  type BoxJournalAdmission,
  type BoxUsageEvidence,
} from "./boxDurableJournal.js";
import {
  BOX_ABSENCE_CONFIRM_MS,
  BOX_EXPIRED_UNPROVEN_STATE,
  BOX_OPERATOR_UNREACHABLE_CLOSED_STATE,
  BOX_PROCESS_ABSENT_CAUSE,
  isBoxBootId,
  isBoxExpiredCloseCause,
  parseBoxExpiredClose,
  parseBoxOperatorUnreachableClose,
  parseBoxRunAbsent,
} from "./boxExpiredClose.js";
import { validExpiredChainIds } from "./boxIdleChain.js";
import { parseBoxReplayMessagePointer, type BoxReplayMessagePointer } from "./boxReplayMessageFile.js";
import { parseBoxStoredToolHandoff } from "./boxStoredToolHandoff.js";
import { parseBoxTerminalProof, type BoxTerminalProof } from "./boxTerminalProof.js";
import { BOX_TOOL_MAX_ROUNDS, BOX_TOOL_MAX_WALL_MS } from "./boxToolCapacity.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOX_RUN_EXPIRED_AFTER_MS = BOX_TOOL_MAX_WALL_MS + 15 * 60 * 1000;
const BOX_ABSENCE_LAUNCH_GRACE_SEC = 180;

function stoppedRunMode(ctx: Record<string, unknown>): boolean {
  return ctx.boxInvocationMode === "detached_tool"
    || (ctx.boxInvocationMode === "text" && ctx.boxLaunchPermit === true
      && isBoxApiModelPair(ctx.model, ctx.boxUpstreamModel)
      && typeof ctx.boxDetachedRunnerHash === "string"
      && /^[a-f0-9]{64}$/.test(ctx.boxDetachedRunnerHash));
}

/** A final model message closes every row in its one remote invocation.
 * Earlier HTTP rows retain their own handoff usage for per-round settlement;
 * only the final linked row receives final-message usage and terminal proof.
 * Until this transaction commits, the original owner keeps account capacity. */
export async function completeBoxToolChain(
  pool: Pick<Pool, "connect" | "query">,
  input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch"> & {
    proof: BoxTerminalProof;
    usage: BoxUsageEvidence;
    messagePointer?: BoxReplayMessagePointer;
  },
): Promise<void> {
  const usage = input.usage;
  const pointer = input.messagePointer === undefined ? undefined
    : parseBoxReplayMessagePointer(input.messagePointer);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId) || input.uid <= 0n
    || !/^[a-f0-9]{32}$/.test(input.leaseEpoch)
    || !validUsageEvidence(usage)
    || (input.messagePointer !== undefined && (!pointer
      || pointer.uid !== input.uid.toString()
      || pointer.requestId !== input.requestId
      || pointer.runNonce !== input.proof.runNonce
      || pointer.leaseEpoch !== input.leaseEpoch))) {
    throw new BoxDurableJournalError("BOX_TOOL_CHAIN_EVIDENCE_INVALID");
  }
  try {
    parseBoxTerminalProof(`${JSON.stringify(input.proof)}\n`, {
      runNonce: input.proof.runNonce, leaseEpoch: input.leaseEpoch });
  } catch { throw new BoxDurableJournalError("BOX_TOOL_CHAIN_EVIDENCE_INVALID"); }
  if (input.proof.reason !== "worker_complete") {
    throw new BoxDurableJournalError("BOX_TOOL_CHAIN_EVIDENCE_INVALID");
  }
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    const lockedSessionId = await lockChainSession(client, input.uid, input.requestId);
    type Row = { request_id: string; state: string; ctx: Record<string, unknown> };
    const rows: Row[] = [];
    const seen = new Set<string>();
    let cursor: string | null = input.requestId;
    while (cursor !== null) {
      if (rows.length >= BOX_TOOL_MAX_ROUNDS || seen.has(cursor)) {
        throw new BoxDurableJournalError("BOX_TOOL_CHAIN_INVALID");
      }
      seen.add(cursor);
      const found: { rows: Row[]; rowCount: number | null } = await client.query<Row>(
        `SELECT request_id,state,ctx FROM request_finalize_journal
          WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
        [cursor, input.uid.toString()]);
      const row: Row | undefined = found.rows[0];
      if (found.rowCount !== 1 || !row || !row.ctx
        || row.ctx.boxInvocationRecovery !== "v1"
        || row.ctx.boxInvocationMode !== "detached_tool"
        || row.ctx.boxRunNonce !== input.proof.runNonce
        || row.ctx.boxLeaseEpoch !== input.leaseEpoch) {
        throw new BoxDurableJournalError("BOX_TOOL_CHAIN_INVALID");
      }
      rows.push(row);
      const parent: unknown = row.ctx.boxOwnerRequestId;
      if (parent === undefined) cursor = null;
      else if (typeof parent === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(parent)) {
        cursor = parent;
      } else throw new BoxDurableJournalError("BOX_TOOL_CHAIN_INVALID");
    }
    const current = rows[0]!;
    const basis = current.ctx;
    const roundNo = basis.boxRoundNo;
    if (!Number.isSafeInteger(roundNo) || Number(roundNo) < 2
      || Number(roundNo) > BOX_TOOL_MAX_ROUNDS || rows.length !== roundNo
      || (pointer && pointer.roundNo !== roundNo)
      || (basis.boxReplayRequired === true && !pointer)
      || basis.boxSessionId !== lockedSessionId
      || current.state !== "inflight"
      || !["linked", "unknown"].includes(String(basis.boxState))
      || basis.boxToolHandoff !== undefined
      || typeof basis.boxCatalogHash !== "string"
      || !/^[a-f0-9]{64}$/.test(basis.boxCatalogHash)
      || typeof basis.boxDetachedRunnerHash !== "string"
      || !/^[a-f0-9]{64}$/.test(basis.boxDetachedRunnerHash)) {
      throw new BoxDurableJournalError("BOX_TOOL_CHAIN_INVALID");
    }
    for (let i = 1; i < rows.length; i++) {
      const child = rows[i - 1]!;
      const parent = rows[i]!;
      const ctx = parent.ctx;
      const handoff = parseBoxStoredToolHandoff(ctx.boxToolHandoff);
      if (!handoff || handoff.roundNo !== Number(roundNo) - i
        || handoff.catalogHash !== basis.boxCatalogHash
        || handoff.detachedRunnerHash !== basis.boxDetachedRunnerHash
        || !["inflight", "finalizing", "committed"].includes(parent.state)
        || !["resuming", "unknown"].includes(String(ctx.boxState))
        || ctx.boxResumeRequestId !== child.request_id
        || typeof ctx.boxResumeRevision !== "string"
        || !UUID_V4.test(ctx.boxResumeRevision)
        || typeof child.ctx.boxParentResumeRevision !== "string"
        || !UUID_V4.test(child.ctx.boxParentResumeRevision)
        || ctx.boxResumeRevision !== child.ctx.boxParentResumeRevision
        || ctx.boxAccountId !== basis.boxAccountId
        || ctx.boxSessionId !== basis.boxSessionId
        || ctx.boxTurnKey !== basis.boxTurnKey
        || ctx.model !== basis.model
        || ctx.boxReplayRequired !== basis.boxReplayRequired
        || ctx.boxNativeSessionId !== basis.boxNativeSessionId
        || ctx.boxNativeCliCwd !== basis.boxNativeCliCwd) {
        throw new BoxDurableJournalError("BOX_TOOL_CHAIN_INVALID");
      }
    }
    const final = await updateToolChainFinalTerminal(client, {
      requestId: current.request_id, uid: input.uid, leaseEpoch: input.leaseEpoch,
      patchJson: JSON.stringify({ boxState: "terminal", boxTerminalProof: input.proof,
        boxUsage: usage,
        ...(pointer ? { boxReplayMessage: pointer } : {}) }),
    });
    if (!final) throw new BoxDurableJournalError("BOX_TOOL_CHAIN_FENCE_LOST");
    for (const ancestor of rows.slice(1)) {
      const changed = await updateToolChainAncestorTerminal(client, {
        requestId: ancestor.request_id, uid: input.uid, leaseEpoch: input.leaseEpoch,
      });
      if (!changed) throw new BoxDurableJournalError("BOX_TOOL_CHAIN_FENCE_LOST");
    }
    await client.query("COMMIT");
    committed = true;
  } finally {
    if (!committed) await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

/** A linked final round failed after earlier tool messages were durably
 * handed off. Abort only the unbilled final row. Earlier rows retain their
 * exact handoff usage and billing state, but cease holding remote capacity.
 * No missing model usage is invented and no CLI/tool call is replayed. */
export async function markBoxToolChainStoppedFailure(
  pool: Pick<Pool, "connect" | "query">,
  input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch"> & {
    proof: BoxTerminalProof;
    rejectedStream?: true;
  },
): Promise<void> {
  const rejectedStream = input.rejectedStream === true;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId) || input.uid <= 0n
    || !/^[a-f0-9]{32}$/.test(input.leaseEpoch) || !input.proof
    || (input.proof.reason === "worker_complete") !== rejectedStream) {
    throw new BoxDurableJournalError("BOX_FAILED_STOP_EVIDENCE_INVALID");
  }
  try { parseBoxTerminalProof(`${JSON.stringify(input.proof)}\n`, {
    runNonce: input.proof.runNonce, leaseEpoch: input.leaseEpoch }); }
  catch { throw new BoxDurableJournalError("BOX_FAILED_STOP_EVIDENCE_INVALID"); }
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    const lockedSessionId = await lockChainSession(client, input.uid, input.requestId);
    type Row = { request_id: string; state: string; ctx: Record<string, unknown> };
    const rows: Row[] = [];
    const seen = new Set<string>();
    let cursor: string | null = input.requestId;
    while (cursor !== null) {
      if (rows.length >= BOX_TOOL_MAX_ROUNDS || seen.has(cursor)) {
        throw new BoxDurableJournalError("BOX_FAILED_STOP_CHAIN_INVALID");
      }
      seen.add(cursor);
      const found: { rows: Row[]; rowCount: number | null } = await client.query<Row>(
        `SELECT request_id,state,ctx FROM request_finalize_journal
          WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
        [cursor, input.uid.toString()]);
      const row = found.rows[0];
      if (found.rowCount !== 1 || !row?.ctx
        || row.ctx.boxInvocationRecovery !== "v1"
        || row.ctx.boxInvocationMode !== "detached_tool"
        || row.ctx.boxRunNonce !== input.proof.runNonce
        || row.ctx.boxLeaseEpoch !== input.leaseEpoch) {
        throw new BoxDurableJournalError("BOX_FAILED_STOP_CHAIN_INVALID");
      }
      rows.push(row);
      const parent: unknown = row.ctx.boxOwnerRequestId;
      if (parent === undefined) cursor = null;
      else if (typeof parent === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(parent)) cursor = parent;
      else throw new BoxDurableJournalError("BOX_FAILED_STOP_CHAIN_INVALID");
    }
    const current = rows[0]!;
    const basis = current.ctx;
    const roundNo = basis.boxRoundNo;
    const handoff = basis.boxToolHandoff === undefined ? null
      : parseBoxStoredToolHandoff(basis.boxToolHandoff);
    if (basis.boxToolHandoff !== undefined && !handoff) {
      throw new BoxDurableJournalError("BOX_FAILED_STOP_CHAIN_INVALID");
    }
    if (rejectedStream && (handoff || current.state !== "inflight" && current.state !== "aborted"
      || (current.state === "inflight" && !["linked", "unknown"].includes(String(basis.boxState))))) {
      throw new BoxDurableJournalError("BOX_FAILED_STOP_CHAIN_INVALID");
    }
    if ((handoff ? ["inflight", "finalizing", "committed"].includes(current.state)
      : current.state === "aborted") && basis.boxState === "failed_stopped"
      && (basis.boxStopOutcome === "rejected_stream") === rejectedStream
      && rows.length === roundNo && isDeepStrictEqual(basis.boxTerminalProof, input.proof)) {
      await client.query("COMMIT"); committed = true; return;
    }
    if (!Number.isSafeInteger(roundNo) || Number(roundNo) < 2
      || Number(roundNo) > BOX_TOOL_MAX_ROUNDS || rows.length !== roundNo
      || basis.boxSessionId !== lockedSessionId
      || (handoff
        ? (!["inflight", "finalizing", "committed"].includes(current.state)
          || !["handoff", "unknown"].includes(String(basis.boxState))
          || handoff.roundNo !== roundNo
          || typeof basis.boxHandoffRevision !== "string"
          || !UUID_V4.test(basis.boxHandoffRevision)
          || handoff.catalogHash !== basis.boxCatalogHash
          || handoff.detachedRunnerHash !== basis.boxDetachedRunnerHash)
        : (current.state !== "inflight"
          || !["linked", "unknown"].includes(String(basis.boxState))))
      || basis.boxResumeRequestId !== undefined
      || typeof basis.boxAccountId !== "string"
      || !/^[1-9][0-9]{0,19}$/.test(basis.boxAccountId)
      || typeof basis.boxCatalogHash !== "string"
      || !/^[a-f0-9]{64}$/.test(basis.boxCatalogHash)
      || typeof basis.boxDetachedRunnerHash !== "string"
      || !/^[a-f0-9]{64}$/.test(basis.boxDetachedRunnerHash)) {
      throw new BoxDurableJournalError("BOX_FAILED_STOP_CHAIN_INVALID");
    }
    for (let i = 1; i < rows.length; i++) {
      const child = rows[i - 1]!;
      const parent = rows[i]!;
      const ctx = parent.ctx;
      const handoff = parseBoxStoredToolHandoff(ctx.boxToolHandoff);
      if (!handoff || handoff.roundNo !== Number(roundNo) - i
        || handoff.catalogHash !== basis.boxCatalogHash
        || handoff.detachedRunnerHash !== basis.boxDetachedRunnerHash
        || !["inflight", "finalizing", "committed"].includes(parent.state)
        || !["resuming", "unknown"].includes(String(ctx.boxState))
        || ctx.boxResumeRequestId !== child.request_id
        || typeof ctx.boxResumeRevision !== "string"
        || !UUID_V4.test(ctx.boxResumeRevision)
        || typeof child.ctx.boxParentResumeRevision !== "string"
        || !UUID_V4.test(child.ctx.boxParentResumeRevision)
        || ctx.boxResumeRevision !== child.ctx.boxParentResumeRevision
        || ctx.boxAccountId !== basis.boxAccountId
        || ctx.boxSessionId !== basis.boxSessionId
        || ctx.boxTurnKey !== basis.boxTurnKey
        || ctx.model !== basis.model) {
        throw new BoxDurableJournalError("BOX_FAILED_STOP_CHAIN_INVALID");
      }
    }
    if (!handoff) {
      if (await selectUsageRecordExists(client, current.request_id, input.uid)) {
        throw new BoxDurableJournalError("BOX_FAILED_STOP_USAGE_CONFLICT");
      }
    }
    const stopArgs = {
      requestId: current.request_id, uid: input.uid, leaseEpoch: input.leaseEpoch,
      patchJson: JSON.stringify({ boxState: "failed_stopped", boxTerminalProof: input.proof,
        boxStopOutcome: rejectedStream ? "rejected_stream" : "failed" }),
      runNonce: input.proof.runNonce,
    };
    const stopped = handoff
      ? await updateToolChainHandoffStoppedFailure(client, stopArgs)
      : await updateToolChainUnbilledStoppedFailure(client, stopArgs);
    if (!stopped) throw new BoxDurableJournalError("BOX_FAILED_STOP_FENCE_LOST");
    for (const ancestor of rows.slice(1)) {
      const changed = await updateToolChainAncestorStoppedFailure(client, {
        requestId: ancestor.request_id, uid: input.uid, leaseEpoch: input.leaseEpoch,
      });
      if (!changed) throw new BoxDurableJournalError("BOX_FAILED_STOP_FENCE_LOST");
    }
    await client.query("COMMIT"); committed = true;
  } finally {
    if (!committed) await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

/** OCV5-313: close a run that cannot be alive any more and whose keeper
 * proof cannot be read (disabled or unreachable account, proof files gone).
 * Nothing is proven and nothing remote is touched: the leaf and its waiting
 * ancestors only stop being unknown forever. */
export async function markBoxRunExpiredUnproven(
  pool: Pick<Pool, "connect" | "query">,
  input: Pick<BoxJournalAdmission, "requestId" | "uid" | "accountId" | "runNonce" | "leaseEpoch"> & {
    cause: string;
    operatorClosed?: true;
    apply?: boolean;
    absence?: { boot: string };
  },
): Promise<BoxExpiredCloseResult> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId) || input.uid <= 0n
    || input.accountId <= 0n || !/^[a-f0-9]{24}$/.test(input.runNonce)
    || !/^[a-f0-9]{32}$/.test(input.leaseEpoch) || !isBoxExpiredCloseCause(input.cause)
    || (input.absence !== undefined && (input.cause !== BOX_PROCESS_ABSENT_CAUSE
      || !isBoxBootId(input.absence.boot) || input.operatorClosed === true))) {
    throw new BoxDurableJournalError("BOX_EXPIRED_CLOSE_IDENTITY_INVALID");
  }
  const uid = input.uid.toString();
  const accountId = input.accountId.toString();
  const expirySec = BOX_RUN_EXPIRED_AFTER_MS / 1000;
  const invalid = (): never => {
    throw new BoxDurableJournalError("BOX_EXPIRED_CLOSE_CHAIN_INVALID");
  };
  const client = await pool.connect();
  let finished = false;
  try {
    await client.query("BEGIN");
    const lockedSessionId = await lockChainSession(client, input.uid, input.requestId);
    type Row = { request_id: string; state: string; final_credits: string | null;
      failure_code: string | null; expired: boolean; launched: boolean; now_ms: string;
      ctx: Record<string, unknown> };
    const rows: Row[] = [];
    const seen = new Set<string>();
    let cursor: string | null = input.requestId;
    while (cursor !== null) {
      if (rows.length >= BOX_TOOL_MAX_ROUNDS || seen.has(cursor)) invalid();
      seen.add(cursor);
      const found: { rows: Row[]; rowCount: number | null } = await client.query<Row>(
        `SELECT request_id,state,final_credits::text AS final_credits,failure_code,ctx,
            created_at <= NOW() - make_interval(secs => $3::double precision) AS expired,
            created_at <= NOW() - make_interval(secs => $4::double precision) AS launched,
            (EXTRACT(EPOCH FROM NOW())*1000)::bigint::text AS now_ms
           FROM request_finalize_journal
          WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
        [cursor, uid, expirySec, BOX_ABSENCE_LAUNCH_GRACE_SEC]);
      const row = found.rows[0];
      if (found.rowCount !== 1 || !row?.ctx || row.ctx.boxInvocationRecovery !== "v1"
        || !stoppedRunMode(row.ctx) || row.ctx.boxRunNonce !== input.runNonce
        || row.ctx.boxLeaseEpoch !== input.leaseEpoch
        || row.ctx.boxAccountId !== accountId) invalid();
      rows.push(row!);
      const parent: unknown = row!.ctx.boxOwnerRequestId;
      if (parent === undefined) cursor = null;
      else if (typeof parent === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(parent)) cursor = parent;
      else invalid();
    }
    const leaf = rows[0]!;
    const basis = leaf.ctx;
    const linked = basis.boxOwnerRequestId !== undefined;
    const handoff = basis.boxToolHandoff === undefined ? null
      : parseBoxStoredToolHandoff(basis.boxToolHandoff);
    if ((basis.boxToolHandoff !== undefined && !handoff) || basis.boxSessionId !== lockedSessionId) {
      invalid();
    }
    if (basis.boxTerminalProof !== undefined || basis.boxResumeRequestId !== undefined
      || basis.settlementClaimId !== undefined) {
      throw new BoxDurableJournalError("BOX_EXPIRED_CLOSE_EVIDENCE_PRESENT");
    }
    const resumable = ["inflight", "finalizing", "committed"].includes(leaf.state);
    const shape = handoff ? "billed_handoff" as const : "unbilled_leaf" as const;
    const closed = parseBoxExpiredClose(basis.boxExpiredClose);
    if (basis.boxState === BOX_EXPIRED_UNPROVEN_STATE) {
      // Idempotent only for the complete end state this method writes, as
      // judged by the same projection the idle proof uses.
      const valid = validExpiredChainIds(rows.map((row) => ({ requestId: row.request_id,
        state: row.state, ctx: row.ctx, finalCredits: row.final_credits,
        failureCode: row.failure_code })));
      if (!closed || rows.some((row) => !valid.has(row.request_id))) invalid();
      await client.query("ROLLBACK"); finished = true;
      return { action: "already_closed", shape, priorBoxState: closed!.priorBoxState,
        ancestors: rows.length - 1 };
    }
    if (basis.boxExpiredClose !== undefined) invalid();
    const actual = String(basis.boxState);
    let prior = actual;
    if (actual === BOX_OPERATOR_UNREACHABLE_CLOSED_STATE) {
      const operatorPrior = parseBoxOperatorUnreachableClose(basis.boxOperatorUnreachableClose);
      if (input.operatorClosed !== true || !operatorPrior) invalid();
      prior = operatorPrior!;
    } else if (basis.boxOperatorUnreachableClose !== undefined) invalid();
    // The same leaf states the proof-based closers accept per round type.
    const priorAllowed = handoff ? ["handoff", "unknown"]
      : linked ? ["linked", "unknown"] : ["running", "unknown"];
    if (!priorAllowed.includes(prior) || (handoff ? !resumable : leaf.state !== "inflight")
      || (!handoff && leaf.final_credits !== null)) invalid();
    if (linked) {
      const roundNo = basis.boxRoundNo;
      if (rows.some((row) => row.ctx.boxInvocationMode !== "detached_tool")
        || !Number.isSafeInteger(roundNo) || Number(roundNo) < 2
        || Number(roundNo) > BOX_TOOL_MAX_ROUNDS || rows.length !== roundNo
        || (handoff && (handoff.roundNo !== roundNo
          || typeof basis.boxHandoffRevision !== "string"
          || !UUID_V4.test(basis.boxHandoffRevision)
          || handoff.catalogHash !== basis.boxCatalogHash
          || handoff.detachedRunnerHash !== basis.boxDetachedRunnerHash))
        || typeof basis.boxCatalogHash !== "string"
        || !/^[a-f0-9]{64}$/.test(basis.boxCatalogHash)
        || typeof basis.boxDetachedRunnerHash !== "string"
        || !/^[a-f0-9]{64}$/.test(basis.boxDetachedRunnerHash)) invalid();
      for (let i = 1; i < rows.length; i++) {
        const child = rows[i - 1]!;
        const parent = rows[i]!;
        const ctx = parent.ctx;
        const stored = parseBoxStoredToolHandoff(ctx.boxToolHandoff);
        if (!stored || stored.roundNo !== Number(roundNo) - i
          || stored.catalogHash !== basis.boxCatalogHash
          || stored.detachedRunnerHash !== basis.boxDetachedRunnerHash
          || !["inflight", "finalizing", "committed"].includes(parent.state)
          || !["resuming", "unknown"].includes(String(ctx.boxState))
          // A proof anywhere in the chain belongs to the proof-based closers.
          || ctx.boxTerminalProof !== undefined
          || ctx.boxResumeRequestId !== child.request_id
          || typeof ctx.boxResumeRevision !== "string"
          || !UUID_V4.test(ctx.boxResumeRevision)
          || typeof child.ctx.boxParentResumeRevision !== "string"
          || !UUID_V4.test(child.ctx.boxParentResumeRevision)
          || ctx.boxResumeRevision !== child.ctx.boxParentResumeRevision
          || ctx.boxSessionId !== basis.boxSessionId
          || ctx.boxTurnKey !== basis.boxTurnKey
          || ctx.model !== basis.model) invalid();
      }
    } else if (rows.length !== 1 || (handoff && (handoff.roundNo !== 1
      || basis.boxInvocationMode !== "detached_tool"
      || typeof basis.boxHandoffRevision !== "string"
      || !UUID_V4.test(basis.boxHandoffRevision)))) invalid();
    if (input.absence) {
      const seen = parseBoxRunAbsent(basis.boxRunAbsent);
      if (!leaf.launched || !seen || (seen.boot === input.absence.boot
        && Number(leaf.now_ms) - seen.atMs < BOX_ABSENCE_CONFIRM_MS)) {
        throw new BoxDurableJournalError("BOX_ABSENT_CLOSE_NOT_CONFIRMED");
      }
      // Calls the run completed before it vanished are settled first: the
      // Box billing scan does not read expired rows. Nothing here bills.
      if (rows.some((row) => row.ctx.boxToolHandoff !== undefined && row.state !== "committed")) {
        throw new BoxDurableJournalError("BOX_ABSENT_CLOSE_BILLING_UNSETTLED");
      }
    } else if (!leaf.expired) throw new BoxDurableJournalError("BOX_EXPIRED_CLOSE_RUN_NOT_EXPIRED");
    if (!handoff) {
      if (await selectUsageRecordExists(client, leaf.request_id, input.uid)) {
        throw new BoxDurableJournalError("BOX_EXPIRED_CLOSE_USAGE_CONFLICT");
      }
    }
    const changed = await updateExpiredUnprovenLeaf(client, {
      requestId: leaf.request_id, uid, leaseEpoch: input.leaseEpoch,
      runNonce: input.runNonce, actualState: actual,
      expiredState: BOX_EXPIRED_UNPROVEN_STATE, priorState: prior,
      cause: input.cause, ageSec: input.absence ? BOX_ABSENCE_LAUNCH_GRACE_SEC : expirySec,
      hasHandoff: Boolean(handoff), requireRunAbsent: Boolean(input.absence),
    });
    if (!changed) throw new BoxDurableJournalError("BOX_EXPIRED_CLOSE_FENCE_LOST");
    for (const ancestor of rows.slice(1)) {
      const moved = await updateExpiredUnprovenAncestor(client, {
        requestId: ancestor.request_id, uid, leaseEpoch: input.leaseEpoch,
        expiredState: BOX_EXPIRED_UNPROVEN_STATE,
      });
      if (!moved) throw new BoxDurableJournalError("BOX_EXPIRED_CLOSE_FENCE_LOST");
    }
    const apply = input.apply !== false;
    await client.query(apply ? "COMMIT" : "ROLLBACK"); finished = true;
    return { action: apply ? "closed" : "would_close", shape, priorBoxState: prior,
      ancestors: rows.length - 1 };
  } finally {
    if (!finished) await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}
