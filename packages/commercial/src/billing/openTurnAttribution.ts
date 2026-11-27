/**
 * OCV5-704: attribute a container tool charge to the single open turn.
 *
 * Amounts are unchanged. This module only decides which turn a charge belongs
 * to. Zero open turns, several open turns, or one turn that has no turn key:
 * leave the charge unattributed and say so. A failed lookup is not stamped,
 * so the daily check can still see it.
 */

import type { Pool } from "pg";
import { lockTurnBillingKeys } from "./turnLock.js";

export const TURN_KEY_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OpenTurnSkipKind = "none" | "many" | "unkeyed";

export interface OpenTurnHit {
  dispatchId: string;
  attemptNo: number;
  sessionId: string;
  turnKey: string;
}

export type OpenTurnDecision =
  | { kind: "one"; turn: OpenTurnHit }
  | { kind: OpenTurnSkipKind; count: number };

export interface OpenDispatchRow {
  dispatchId: string;
  attemptNo: number;
  sessionId: string | null;
  turnKey: string | null;
}

/** Journal fields frozen at admit. `chatSessionId` is the client session for
 * the live cost frame. It is not a billing parentSessionId. */
export type OpenTurnJournalFields =
  | {
      dispatchId: string;
      attemptNo: number;
      turnKey: string;
      chatSessionId: string;
    }
  | { openTurnAttribution: OpenTurnSkipKind };

export type OpenTurnWarnLog = {
  warn(msg: string, fields?: Record<string, unknown>): void;
};

/** At most two rows: a second row is enough to refuse to guess. */
export const LOOKUP_SINGLE_OPEN_TURN_SQL = `SELECT dispatch_id::text AS dispatch_id,
       attempt_no,
       session_id,
       turn_key
  FROM turn_dispatches
 WHERE user_id = $1::bigint
   AND agent_container_id = $2::bigint
   AND status IN ('admitted', 'accepted', 'rejecting')
 ORDER BY admitted_at ASC
 LIMIT 2`;

/** First model admit wins. A later key does not overwrite. Not a balance write. */
export const REMEMBER_OPEN_TURN_KEY_SQL = `UPDATE turn_dispatches
   SET turn_key = $3
 WHERE dispatch_id = $1::uuid
   AND user_id = $2::bigint
   AND turn_key IS NULL`;

/**
 * Guarded active-dispatch turn_key bind (OCV5-898).
 * Works for all local & remote engines (Antigravity / Codex / Cursor / Grok / ZCode / CCB / Remote).
 * Enforces: strict non-null equal container ownership (`agent_container_id = $4::bigint`),
 * active non-terminal non-fenced row, immutable once set (NULL or same key),
 * serialized under `lockTurnBillingKeys` + DB unique index `idx_turn_dispatches_active_user_turn_key`,
 * and rejects keys belonging to waived turns, finalized tapes, foreign usage records,
 * or any other open / same-session dispatch.
 */
export const BIND_ACTIVE_DISPATCH_TURN_KEY_SQL = `/* open-turn:bind-active-dispatch-turn-key */
UPDATE turn_dispatches
   SET turn_key = $3
 WHERE dispatch_id = $1::uuid
   AND user_id = $2::bigint
   AND agent_container_id IS NOT NULL
   AND agent_container_id = $4::bigint
   AND ($5::integer IS NULL OR attempt_no = $5::integer)
   AND ($6::text IS NULL OR session_id = $6::text)
   AND ($7::text IS NULL OR client_message_id = $7::text)
   AND status IN ('admitted', 'accepted')
   AND terminal_at IS NULL
   AND producer_fenced_at IS NULL
   AND (turn_key IS NULL OR turn_key = $3)
   AND NOT EXISTS (
     SELECT 1 FROM turn_waivers w
      WHERE w.user_id = $2::bigint AND w.turn_key = $3
   )
   AND NOT EXISTS (
     SELECT 1 FROM server_authored_turn_anchor_map x
      WHERE x.user_id = 'c:' || $2::text AND x.turn_key = $3
   )
   AND NOT EXISTS (
     SELECT 1 FROM usage_records ur
      WHERE ur.user_id = $2::bigint
        AND ur.turn_key = $3
        AND (ur.dispatch_id IS NULL OR ur.dispatch_id <> $1::uuid)
   )
   AND NOT EXISTS (
     SELECT 1 FROM turn_dispatches d2
      WHERE d2.user_id = $2::bigint
        AND d2.status IN ('admitted', 'accepted', 'rejecting')
        AND d2.turn_key = $3
        AND d2.dispatch_id <> $1::uuid
   )
   AND NOT EXISTS (
     SELECT 1 FROM turn_dispatches d3
      WHERE d3.user_id = $2::bigint
        AND d3.session_id = turn_dispatches.session_id
        AND d3.turn_key = $3
        AND d3.dispatch_id <> $1::uuid
   )`;

/**
 * Positive Master-side evidence lookup for an active dispatch whose `turn_dispatches.turn_key`
 * has not been backfilled yet (OCV5-898 R2). Requires dispatch/attempt-scoped positive proof
 * in `authority_turn_dispatches` or an inflight/finalizing `request_finalize_journal` owned
 * by `(userId, containerId)` — never trusts caller-supplied session uniqueness alone.
 */
export const VERIFY_ACTIVE_PARENT_TURN_EVIDENCE_SQL = `/* open-turn:verify-parent-turn-evidence */
SELECT d.dispatch_id::text AS dispatch_id,
       d.attempt_no,
       d.session_id
  FROM turn_dispatches d
 WHERE d.user_id = $1::bigint
   AND d.agent_container_id IS NOT NULL
   AND d.agent_container_id = $2::bigint
   AND d.status IN ('admitted', 'accepted')
   AND d.terminal_at IS NULL
   AND d.producer_fenced_at IS NULL
   AND (d.turn_key IS NULL OR d.turn_key = $3)
   AND (
     EXISTS (
       SELECT 1 FROM authority_turn_dispatches a
        WHERE a.dispatch_id = d.dispatch_id
          AND a.attempt_no = d.attempt_no
          AND a.user_id = d.user_id
          AND a.turn_key = $3
     )
     OR EXISTS (
       SELECT 1 FROM request_finalize_journal j
        WHERE j.dispatch_id = d.dispatch_id
          AND j.attempt_no = d.attempt_no
          AND j.user_id = d.user_id
          AND j.container_id = d.agent_container_id
          AND j.state IN ('inflight', 'finalizing')
          AND j.ctx->>'turnKey' = $3
     )
   )
   AND NOT EXISTS (
     SELECT 1 FROM turn_waivers w
      WHERE w.user_id = d.user_id AND w.turn_key = $3
   )
   AND NOT EXISTS (
     SELECT 1 FROM server_authored_turn_anchor_map x
      WHERE x.user_id = 'c:' || d.user_id::text AND x.turn_key = $3
   )
 ORDER BY d.admitted_at DESC
 LIMIT 1`;

const stampedDispatchIds = new Set<string>();
const boundActiveDispatchKeys = new Set<string>();

export function __resetOpenTurnKeyMemory(): void {
  stampedDispatchIds.clear();
  boundActiveDispatchKeys.clear();
}

export function decideOpenTurnAttribution(rows: readonly OpenDispatchRow[]): OpenTurnDecision {
  if (rows.length === 0) return { kind: "none", count: 0 };
  if (rows.length >= 2) return { kind: "many", count: rows.length };
  const row = rows[0]!;
  if (
    !row.dispatchId ||
    !Number.isInteger(row.attemptNo) ||
    row.attemptNo < 0 ||
    !row.sessionId ||
    !TURN_KEY_RE.test(row.turnKey ?? "")
  ) {
    return { kind: "unkeyed", count: 1 };
  }
  return {
    kind: "one",
    turn: {
      dispatchId: row.dispatchId,
      attemptNo: row.attemptNo,
      sessionId: row.sessionId,
      turnKey: row.turnKey as string,
    },
  };
}

function mapOpenDispatchRow(row: {
  dispatch_id: unknown;
  attempt_no: unknown;
  session_id: unknown;
  turn_key: unknown;
}): OpenDispatchRow {
  const attempt = typeof row.attempt_no === "number" ? row.attempt_no : Number(row.attempt_no);
  return {
    dispatchId: typeof row.dispatch_id === "string" ? row.dispatch_id : "",
    attemptNo: Number.isInteger(attempt) ? attempt : -1,
    sessionId: typeof row.session_id === "string" && row.session_id.length > 0 ? row.session_id : null,
    turnKey: typeof row.turn_key === "string" ? row.turn_key : null,
  };
}

export async function lookupSingleOpenTurn(
  pool: Pick<Pool, "query">,
  args: { userId: bigint; containerId: bigint },
): Promise<OpenTurnDecision> {
  const result = await pool.query<{
    dispatch_id: string;
    attempt_no: number | string;
    session_id: string | null;
    turn_key: string | null;
  }>(LOOKUP_SINGLE_OPEN_TURN_SQL, [args.userId.toString(), args.containerId.toString()]);
  return decideOpenTurnAttribution(result.rows.map(mapOpenDispatchRow));
}

/** Null means the lookup failed. Callers bill the charge and do not stamp a skip. */
export async function attributeOpenTurn(
  pool: Pick<Pool, "query">,
  args: { userId: bigint; containerId: bigint },
  log?: OpenTurnWarnLog,
): Promise<OpenTurnJournalFields | null> {
  let decision: OpenTurnDecision;
  try {
    decision = await lookupSingleOpenTurn(pool, args);
  } catch (err) {
    log?.warn("open_turn_attribution_skipped", {
      userId: args.userId.toString(),
      containerId: args.containerId.toString(),
      kind: "lookup_failed",
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (decision.kind === "one") {
    return {
      dispatchId: decision.turn.dispatchId,
      attemptNo: decision.turn.attemptNo,
      turnKey: decision.turn.turnKey,
      chatSessionId: decision.turn.sessionId,
    };
  }
  log?.warn("open_turn_attribution_skipped", {
    userId: args.userId.toString(),
    containerId: args.containerId.toString(),
    kind: decision.kind,
    count: decision.count,
  });
  return { openTurnAttribution: decision.kind };
}

export async function rememberOpenTurnKey(
  pool: Pick<Pool, "query">,
  args: { dispatchId: string; userId: bigint; turnKey: string },
): Promise<void> {
  if (!TURN_KEY_RE.test(args.turnKey)) return;
  if (stampedDispatchIds.size >= 10_000) stampedDispatchIds.clear();
  if (stampedDispatchIds.has(args.dispatchId)) return;
  await pool.query(REMEMBER_OPEN_TURN_KEY_SQL, [
    args.dispatchId,
    args.userId.toString(),
    args.turnKey,
  ]);
  stampedDispatchIds.add(args.dispatchId);
}

export interface BindActiveDispatchTurnKeyArgs {
  dispatchId: string;
  userId: bigint;
  /** Strictly required positive container ID; rows with NULL or mismatched containerId fail closed. */
  containerId: number | bigint;
  turnKey: string;
  attemptNo?: number | null;
  sessionId?: string | null;
  clientMessageId?: string | null;
  /** When true, bypass the in-memory dedup set and verify live against PG under lockTurnBillingKeys. */
  skipCache?: boolean;
}

function normalizePositiveContainerId(value: number | bigint): string | null {
  if (typeof value === "bigint") {
    return value > 0n ? value.toString() : null;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return BigInt(value).toString();
  }
  return null;
}

export async function bindActiveDispatchTurnKey(
  pool: Pick<Pool, "connect">,
  args: BindActiveDispatchTurnKeyArgs,
): Promise<boolean> {
  if (!UUID_RE.test(args.dispatchId) || !TURN_KEY_RE.test(args.turnKey)) return false;
  const containerId = normalizePositiveContainerId(args.containerId);
  if (containerId === null) return false;
  const attemptNo =
    args.attemptNo !== undefined && args.attemptNo !== null
      ? Number.isInteger(args.attemptNo) && args.attemptNo > 0
        ? args.attemptNo
        : null
      : null;
  if (args.attemptNo !== undefined && args.attemptNo !== null && attemptNo === null) return false;
  const sessionId =
    typeof args.sessionId === "string" && args.sessionId.length > 0 && args.sessionId.length <= 256
      ? args.sessionId
      : null;
  if (args.sessionId !== undefined && args.sessionId !== null && sessionId === null) return false;
  const clientMessageId =
    typeof args.clientMessageId === "string" &&
    args.clientMessageId.length > 0 &&
    args.clientMessageId.length <= 256
      ? args.clientMessageId
      : null;
  if (
    args.clientMessageId !== undefined &&
    args.clientMessageId !== null &&
    clientMessageId === null
  ) {
    return false;
  }

  const cacheKey = `${args.dispatchId}:${containerId}:${args.turnKey}`;
  if (!args.skipCache && boundActiveDispatchKeys.has(cacheKey)) return true;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockTurnBillingKeys(client, args.userId, [args.turnKey]);
    const res = await client.query(BIND_ACTIVE_DISPATCH_TURN_KEY_SQL, [
      args.dispatchId,
      args.userId.toString(),
      args.turnKey,
      containerId,
      attemptNo,
      sessionId,
      clientMessageId,
    ]);
    await client.query("COMMIT");
    if ((res.rowCount ?? 0) > 0) {
      if (boundActiveDispatchKeys.size >= 10_000) boundActiveDispatchKeys.clear();
      boundActiveDispatchKeys.add(cacheKey);
      return true;
    }
    return false;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if ((err as { code?: unknown } | null)?.code === "23505") {
      return false;
    }
    throw err;
  } finally {
    client.release();
  }
}

export interface VerifyParentTurnEvidenceArgs {
  userId: bigint;
  containerId: bigint;
  turnKey: string;
  requestedParentSessionId?: string;
}

/**
 * Verify positive Master-side evidence (`authority_turn_dispatches` or inflight
 * `request_finalize_journal`) linking `turnKey` to an active dispatch owned by
 * `(userId, containerId)`, then atomically backfill `turn_dispatches.turn_key`
 * under `lockTurnBillingKeys` + DB unique index. Returns `null` when no positive
 * evidence exists (old containers without receipt/authority/journal fail closed).
 */
export async function verifyAndBindParentTurnFromEvidence(
  pool: Pick<Pool, "query" | "connect">,
  args: VerifyParentTurnEvidenceArgs,
): Promise<{ dispatchId: string; sessionId: string } | null> {
  if (!TURN_KEY_RE.test(args.turnKey)) return null;
  if (args.containerId <= 0n) return null;

  const lookup = await pool.query<{
    dispatch_id: string;
    attempt_no: number | string;
    session_id: string | null;
  }>(VERIFY_ACTIVE_PARENT_TURN_EVIDENCE_SQL, [
    args.userId.toString(),
    args.containerId.toString(),
    args.turnKey,
  ]);
  if ((lookup.rowCount ?? 0) === 0 || lookup.rows.length === 0) return null;
  const row = lookup.rows[0]!;
  const attemptNo = typeof row.attempt_no === "number" ? row.attempt_no : Number(row.attempt_no);
  const rowSession = typeof row.session_id === "string" && row.session_id.length > 0 ? row.session_id : null;
  if (!row.dispatch_id || !rowSession || !Number.isInteger(attemptNo) || attemptNo <= 0) return null;

  if (
    args.requestedParentSessionId &&
    rowSession !== args.requestedParentSessionId &&
    !rowSession.endsWith(`:${args.requestedParentSessionId}`)
  ) {
    return null;
  }

  const bound = await bindActiveDispatchTurnKey(pool, {
    dispatchId: row.dispatch_id,
    userId: args.userId,
    containerId: args.containerId,
    attemptNo,
    sessionId: rowSession,
    turnKey: args.turnKey,
    skipCache: true,
  });
  return bound ? { dispatchId: row.dispatch_id, sessionId: rowSession } : null;
}

/** Vision charges stay mode=chat. The client session is only for the live frame. */
export function visionOpenTurnCtx(stamp: OpenTurnJournalFields | null): Record<string, unknown> {
  if (!stamp) return {};
  if ("turnKey" in stamp) {
    return {
      dispatchId: stamp.dispatchId,
      attemptNo: stamp.attemptNo,
      turnKey: stamp.turnKey,
      chatSessionId: stamp.chatSessionId,
    };
  }
  return { openTurnAttribution: stamp.openTurnAttribution };
}

export function openTurnDispatchColumns(
  stamp: OpenTurnJournalFields | null,
): { dispatchId: string; attemptNo: number } | undefined {
  if (!stamp || !("turnKey" in stamp)) return undefined;
  return { dispatchId: stamp.dispatchId, attemptNo: stamp.attemptNo };
}

/** A caller-supplied parent turn wins. A single open turn fills the gap.
 * Skip kinds are stamped so the daily check can exclude them. */
export function delegateOpenTurnCtx(args: {
  parentSessionId?: string;
  parentTurnKey?: string;
  stamp: OpenTurnJournalFields | null;
}): Record<string, unknown> {
  if (args.parentTurnKey) {
    return {
      ...(args.parentSessionId ? { parentSessionId: args.parentSessionId } : {}),
      parentTurnKey: args.parentTurnKey,
    };
  }
  if (args.stamp && "turnKey" in args.stamp) {
    return {
      parentSessionId: args.parentSessionId ?? args.stamp.chatSessionId,
      parentTurnKey: args.stamp.turnKey,
      dispatchId: args.stamp.dispatchId,
      attemptNo: args.stamp.attemptNo,
      chatSessionId: args.stamp.chatSessionId,
    };
  }
  return {
    ...(args.parentSessionId ? { parentSessionId: args.parentSessionId } : {}),
    ...(args.stamp && "openTurnAttribution" in args.stamp
      ? { openTurnAttribution: args.stamp.openTurnAttribution }
      : {}),
  };
}

export function journalTurnKey(frameTurnKey: string | null | undefined, ctxTurnKey: unknown): string | null {
  if (typeof frameTurnKey === "string" && TURN_KEY_RE.test(frameTurnKey)) return frameTurnKey;
  if (typeof ctxTurnKey === "string" && TURN_KEY_RE.test(ctxTurnKey)) return ctxTurnKey;
  return null;
}

/** Wire parent for outbound.cost_charged. Never a billing parentSessionId. */
export function costBroadcastParentSessionId(
  frameParentSessionId: string | null | undefined,
  chatSessionId: unknown,
): string | null {
  if (typeof frameParentSessionId === "string" && frameParentSessionId.length > 0) {
    return frameParentSessionId;
  }
  if (typeof chatSessionId === "string" && chatSessionId.length > 0 && chatSessionId.length <= 240) {
    return chatSessionId;
  }
  return null;
}

/** Pure replay of one round: model credits plus tool charges. Ledger is the
 * sum either way. The label grows only when exactly one open turn is keyed. */
export function labelRoundFromOpenTurns(args: {
  openTurns: readonly OpenDispatchRow[];
  modelCredits: bigint;
  toolCharges: readonly bigint[];
}): { kind: OpenTurnDecision["kind"]; attributed: bigint; label: bigint; ledger: bigint } {
  const decision = decideOpenTurnAttribution(args.openTurns);
  const tools = args.toolCharges.reduce((sum, credits) => sum + credits, 0n);
  const attributed = decision.kind === "one" ? tools : 0n;
  return {
    kind: decision.kind,
    attributed,
    label: args.modelCredits + attributed,
    ledger: args.modelCredits + tools,
  };
}
