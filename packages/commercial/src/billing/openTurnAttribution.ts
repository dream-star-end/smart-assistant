/**
 * OCV5-704: attribute a container tool charge to the single open turn.
 *
 * Amounts are unchanged. This module only decides which turn a charge belongs
 * to. Zero open turns, several open turns, or one turn that has no turn key:
 * leave the charge unattributed and say so. A failed lookup is not stamped,
 * so the daily check can still see it.
 */

import type { Pool } from "pg";

export const TURN_KEY_RE = /^[0-9a-f]{64}$/;

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

const stampedDispatchIds = new Set<string>();

export function __resetOpenTurnKeyMemory(): void {
  stampedDispatchIds.clear();
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
