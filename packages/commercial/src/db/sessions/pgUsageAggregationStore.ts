import type { PoolClient } from "pg";
import { LOSSLESS_TURN_TAPE_SHA256_RE } from "@openclaude/protocol";
import type {
  AppendCostCreditsResult,
  ClientSessionsBackend,
  DelegatePendingRow,
  DrainDelegateCostResult,
  MessageLike,
} from "@openclaude/storage";
import { computeSessionLastPreviewRaw } from "../pgTimelinePerf.js";
import { execPgSpillPlan } from "./appendCore.js";
import type { PgSessionsCtx, PgSessionsDeps } from "./deps.js";
import {
  loadSettledUsageAttribution,
  loadUsageAttributionCredits,
  stageUsageCostLocatorInBillingTransaction,
} from "./pgUsageAttributionReader.js";
import {
  CLOCK_MS_SQL,
  bigIntNumOr,
  escapeNulInSessionMessagesJson,
  notifyGoalUsageChanges,
  requestAdvisoryXactLock,
  withTx,
} from "./sqlHelpers.js";
import type { GoalUsageChange } from "./types.js";

export {
  loadSettledUsageAttribution,
  loadUsageAttributionCredits,
  stageUsageCostLocatorInBillingTransaction,
};

// ── SQL statements (static constants for SAST compliance) ────────────────────

const UPDATE_EXACT_COST_ANCHOR_SQL = `UPDATE client_sessions SET
   messages=$1,message_count=$2,last_at=$3,
   updated_at=GREATEST(updated_at + 1, ${CLOCK_MS_SQL}),
   next_seq=$4,archived_through_seq=$5,archived_count=$6,
   history_revision=history_revision + $9,last_preview=$10
 WHERE id=$7 AND user_id=$8 AND deleted_at IS NULL`;

const UPDATE_EXACT_COST_ARCHIVED_SQL = `UPDATE client_sessions
    SET updated_at=GREATEST(updated_at + 1, ${CLOCK_MS_SQL}),
        history_revision=history_revision + 1
  WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`;

const UPDATE_LEGACY_COST_PATCH_SQL = `UPDATE client_sessions
   SET messages = $1, message_count = $2, last_at = $3,
       updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL}),
       next_seq = next_seq + 1, archived_through_seq = $4, archived_count = $5,
       history_revision = history_revision + $8, last_preview = $9
 WHERE id = $6 AND user_id = $7`;

const UPSERT_LEGACY_PENDING_USAGE_PATCH_SQL = `INSERT INTO pending_usage_patches
   (request_id, user_id, session_id, parent_session_id, delegate_agent_id,
    turn_key, parent_turn_key, cost_credits)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
 ON CONFLICT (request_id, user_id) DO UPDATE SET
   cost_credits = EXCLUDED.cost_credits,
   session_id = EXCLUDED.session_id,
   parent_session_id = EXCLUDED.parent_session_id,
   delegate_agent_id = EXCLUDED.delegate_agent_id,
   turn_key = EXCLUDED.turn_key,
   parent_turn_key = EXCLUDED.parent_turn_key,
   created_at = ${CLOCK_MS_SQL}`;

const UPDATE_DRAINED_DELEGATE_SESSION_SQL = `UPDATE client_sessions
   SET messages = $1, message_count = $2, last_at = $3,
       updated_at = GREATEST(updated_at + 1, ${CLOCK_MS_SQL}),
       next_seq = next_seq + 1, archived_through_seq = $4, archived_count = $5,
       history_revision = history_revision + $8
 WHERE id = $6 AND user_id = $7`;

// ── Shared internal types & pure validation helpers ──────────────────────────

interface CostLocator {
  sessionId: string | null;
  parentSessionId: string | null;
  delegateAgentId: string | null;
  turnKey: string | null;
  parentTurnKey: string | null;
}

interface PendingUsagePatchRow {
  session_id: string | null;
  parent_session_id: string | null;
  delegate_agent_id: string | null;
  turn_key: string | null;
  parent_turn_key: string | null;
  cost_credits: string;
}

interface TurnAnchorMapRow {
  session_id: string;
  tape_id: string;
  billing_anchor_id: string;
}

interface ActiveSessionCostRow {
  messages: string;
  next_seq: number | null;
  archived_through_seq: number | null;
  archived_count: number | null;
}

interface SessionCostRow extends ActiveSessionCostRow {
  deleted_at: string | null;
}

interface DelegatePendingDbRow {
  request_id: string;
  cost_credits: string;
  delegate_agent_id: string | null;
}

function validateCostCreditsInput(
  costCredits: string,
  turnKey?: string | null,
  parentTurnKey?: string | null,
): string {
  if (!/^\d+$/.test(costCredits)) throw new Error("costCredits must be a non-negative integer");
  const normalizedCostCredits = BigInt(costCredits).toString();
  if (normalizedCostCredits.length > 78) throw new Error("costCredits exceeds NUMERIC(78,0)");
  if (turnKey && !LOSSLESS_TURN_TAPE_SHA256_RE.test(turnKey)) {
    throw new Error("turnKey must be a lowercase SHA-256 hex digest");
  }
  if (parentTurnKey && !LOSSLESS_TURN_TAPE_SHA256_RE.test(parentTurnKey)) {
    throw new Error("parentTurnKey must be a lowercase SHA-256 hex digest");
  }
  return normalizedCostCredits;
}

function fieldConflicts(incoming: string | null, stored: string | null): boolean {
  return incoming !== null && stored !== null && stored !== incoming;
}

function hasPendingLocatorConflict(
  pending: PendingUsagePatchRow,
  locator: CostLocator,
  normalizedCostCredits: string,
): boolean {
  return (
    fieldConflicts(locator.sessionId, pending.session_id) ||
    fieldConflicts(locator.parentSessionId, pending.parent_session_id) ||
    fieldConflicts(locator.delegateAgentId, pending.delegate_agent_id) ||
    fieldConflicts(locator.turnKey, pending.turn_key) ||
    fieldConflicts(locator.parentTurnKey, pending.parent_turn_key) ||
    BigInt(pending.cost_credits) !== BigInt(normalizedCostCredits)
  );
}

function fieldBackfillable(incoming: string | null, stored: string | null): boolean {
  return incoming !== null && stored === null;
}

function hasBackfillablePendingFields(
  pending: PendingUsagePatchRow,
  locator: CostLocator,
): boolean {
  return (
    fieldBackfillable(locator.sessionId, pending.session_id) ||
    fieldBackfillable(locator.parentSessionId, pending.parent_session_id) ||
    fieldBackfillable(locator.delegateAgentId, pending.delegate_agent_id) ||
    fieldBackfillable(locator.turnKey, pending.turn_key) ||
    fieldBackfillable(locator.parentTurnKey, pending.parent_turn_key)
  );
}

function parseHotMessagesOrEmpty(raw: string): MessageLike[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MessageLike[]) : [];
  } catch (err) {
    void err;
    return [];
  }
}

// ── Exact v2 turn-key cost path ──────────────────────────────────────────────

async function bumpSessionRowForExactCost(
  client: PoolClient,
  map: TurnAnchorMapRow,
  userId: string,
  sess: SessionCostRow,
  deps: PgSessionsDeps,
): Promise<void> {
  let messages: MessageLike[] = [];
  try {
    const parsed = JSON.parse(sess.messages);
    if (Array.isArray(parsed)) messages = parsed as MessageLike[];
  } catch (err) {
    void err;
    throw new Error("lossless turn billing target session row malformed");
  }
  const archivedThroughSeq = bigIntNumOr(sess.archived_through_seq, 0);
  messages = deps.storage.normalizeAndAssignOrderSeqs(
    messages,
    messages,
    archivedThroughSeq,
  ).messages;
  const anchorIndex = messages.findIndex(
    (message) =>
      message?.id === map.billing_anchor_id &&
      message?._turnTapeId === map.tape_id &&
      message?._source === "server",
  );
  if (anchorIndex < 0) {
    await client.query(UPDATE_EXACT_COST_ARCHIVED_SQL, [map.session_id, userId]);
    return;
  }
  const nextSeq =
    typeof sess.next_seq === "number" && sess.next_seq > 0
      ? sess.next_seq
      : Math.max(
          0,
          ...messages.map((message) => (typeof message?._seq === "number" ? message._seq : 0)),
        ) + 1;
  const touched = [...messages];
  touched[anchorIndex] = { ...touched[anchorIndex], _seq: nextSeq };
  const spill = deps.storage.planSpillOverflow(touched, archivedThroughSeq);
  const finalJson = escapeNulInSessionMessagesJson(JSON.stringify(spill.tail));
  if (Buffer.byteLength(finalJson, "utf8") > deps.storage.MAX_SESSION_BYTES) {
    throw new Error("lossless turn billing anchor tail unexpectedly oversized");
  }
  const nowMs = Date.now();
  const archivedDelta = await execPgSpillPlan(
    client, map.session_id, userId, spill.chunksToInsert, spill.idsToInsert, nowMs,
  );
  const archivedCount = bigIntNumOr(sess.archived_count, 0) + archivedDelta;
  await client.query(UPDATE_EXACT_COST_ANCHOR_SQL, [
    finalJson, spill.tail.length + archivedCount, nowMs, nextSeq + 1,
    spill.archivedThroughSeq, archivedCount, map.session_id, userId,
    archivedDelta > 0 ? 1 : 0, computeSessionLastPreviewRaw(spill.tail),
  ]);
}

async function commitExactTurnCostComponent(
  client: PoolClient,
  params: {
    requestId: string;
    userId: string;
    normalizedCostCredits: string;
    locator: CostLocator;
    map: TurnAnchorMapRow;
    sess: SessionCostRow;
  },
  deps: PgSessionsDeps,
): Promise<{ result: AppendCostCreditsResult; goalUsageChange: GoalUsageChange | null }> {
  const { requestId, userId, normalizedCostCredits, locator, map, sess } = params;
  const existing = (
    await client.query<{
      session_id: string;
      tape_id: string;
      billing_anchor_id: string;
      cost_credits: string;
      delegate_agent_id: string | null;
    }>(
      `SELECT session_id,tape_id,billing_anchor_id,cost_credits::text,delegate_agent_id
         FROM turn_tape_cost_components
        WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
      [requestId, userId],
    )
  ).rows[0];
  const pendingExact = (
    await client.query<PendingUsagePatchRow>(
      `SELECT session_id,parent_session_id,delegate_agent_id,turn_key,
              parent_turn_key,cost_credits
         FROM pending_usage_patches
        WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
      [requestId, userId],
    )
  ).rows[0];
  if (pendingExact && hasPendingLocatorConflict(pendingExact, locator, normalizedCostCredits)) {
    throw new Error("lossless pending cost component refuses remapping");
  }
  if (existing) {
    if (
      existing.session_id !== map.session_id ||
      existing.tape_id !== map.tape_id ||
      existing.billing_anchor_id !== map.billing_anchor_id ||
      BigInt(existing.cost_credits) !== BigInt(normalizedCostCredits) ||
      existing.delegate_agent_id !== locator.delegateAgentId
    ) {
      throw new Error("lossless turn cost component refuses remapping");
    }
    if (pendingExact) {
      await client.query(
        "DELETE FROM pending_usage_patches WHERE request_id=$1 AND user_id=$2",
        [requestId, userId],
      );
    }
    return { result: { applied: "noop" }, goalUsageChange: { userId, sessionId: map.session_id } };
  }
  await client.query(
    `INSERT INTO turn_tape_cost_components
       (request_id,user_id,session_id,tape_id,billing_anchor_id,
        cost_credits,delegate_agent_id,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      requestId, userId, map.session_id, map.tape_id, map.billing_anchor_id,
      normalizedCostCredits, locator.delegateAgentId, Date.now(),
    ],
  );
  if (pendingExact) {
    await client.query(
      "DELETE FROM pending_usage_patches WHERE request_id=$1 AND user_id=$2",
      [requestId, userId],
    );
  }
  const bumped = await deps.goal.bumpGoalUsageSnapshotForTape(client, map.session_id, userId, map.tape_id);
  await bumpSessionRowForExactCost(client, map, userId, sess, deps);
  return {
    result: { applied: "patched" },
    goalUsageChange: bumped ? { userId, sessionId: map.session_id } : null,
  };
}

async function tryApplyExactTurnCost(
  client: PoolClient,
  params: {
    requestId: string;
    userId: string;
    normalizedCostCredits: string;
    targetTurnKey: string;
    locator: CostLocator;
  },
  deps: PgSessionsDeps,
): Promise<{ result: AppendCostCreditsResult; goalUsageChange: GoalUsageChange | null } | null> {
  const { requestId, userId, normalizedCostCredits, targetTurnKey, locator } = params;
  await requestAdvisoryXactLock(client, userId, `turn:${targetTurnKey}`);
  const map0 = (
    await client.query<TurnAnchorMapRow>(
      `SELECT session_id,tape_id,billing_anchor_id
         FROM server_authored_turn_anchor_map
        WHERE user_id=$1 AND turn_key=$2`,
      [userId, targetTurnKey],
    )
  ).rows[0];
  if (!map0) return null;

  const sess = (
    await client.query<SessionCostRow>(
      `SELECT deleted_at,messages,next_seq,archived_through_seq,archived_count
         FROM client_sessions
        WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [map0.session_id, userId],
    )
  ).rows[0];
  if (!sess || sess.deleted_at !== null) {
    return { result: { applied: "noop" }, goalUsageChange: null };
  }

  const map = (
    await client.query<TurnAnchorMapRow>(
      `SELECT session_id,tape_id,billing_anchor_id
         FROM server_authored_turn_anchor_map
        WHERE user_id=$1 AND turn_key=$2 FOR UPDATE`,
      [userId, targetTurnKey],
    )
  ).rows[0];
  if (
    !map ||
    map.session_id !== map0.session_id ||
    map.tape_id !== map0.tape_id ||
    map.billing_anchor_id !== map0.billing_anchor_id
  ) {
    throw new Error("lossless turn billing anchor mapping changed while locked");
  }
  return commitExactTurnCostComponent(
    client,
    { requestId, userId, normalizedCostCredits, locator, map, sess },
    deps,
  );
}

// ── Legacy map-hit & pending park paths ──────────────────────────────────────

async function tryApplyLegacyMapCost(
  client: PoolClient,
  requestId: string,
  userId: string,
  normalizedCostCredits: string,
  deps: PgSessionsDeps,
): Promise<AppendCostCreditsResult | null> {
  const mapRow0 = (
    await client.query<{ session_id: string; msg_id: string }>(
      "SELECT session_id, msg_id FROM server_authored_request_map WHERE request_id = $1 AND user_id = $2",
      [requestId, userId],
    )
  ).rows[0];
  if (!mapRow0) return null;

  const sess = (
    await client.query<SessionCostRow>(
      "SELECT messages, next_seq, deleted_at, archived_through_seq, archived_count FROM client_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [mapRow0.session_id, userId],
    )
  ).rows[0];
  if (sess && sess.deleted_at !== null) return { applied: "noop" };

  const mapRow = (
    await client.query<{ session_id: string; msg_id: string }>(
      "SELECT session_id, msg_id FROM server_authored_request_map WHERE request_id = $1 AND user_id = $2 FOR UPDATE",
      [requestId, userId],
    )
  ).rows[0];
  if (mapRow && (mapRow.session_id !== mapRow0.session_id || mapRow.msg_id !== mapRow0.msg_id)) {
    throw new Error(
      `[pgSessions] appendCostCredits map locator 在锁定间隙变化(non-remappable 不变量被破坏): (requestId=${requestId},userId=${userId}) 首读 (${mapRow0.session_id},${mapRow0.msg_id}) 复核 (${mapRow.session_id},${mapRow.msg_id})`,
    );
  }
  if (!sess || !mapRow) return null;

  const msgs = parseHotMessagesOrEmpty(sess.messages);
  const currentNextSeq = typeof sess.next_seq === "number" && sess.next_seq > 0 ? sess.next_seq : 1;
  const plan = deps.storage.planCostPatch(
    msgs,
    mapRow.msg_id,
    normalizedCostCredits,
    currentNextSeq,
    bigIntNumOr(sess.archived_through_seq, 0),
  );
  if (plan.kind === "noop") return { applied: "noop" };
  if (plan.kind === "patch") {
    const nowMs = Date.now();
    const archivedDelta = await execPgSpillPlan(
      client, mapRow.session_id, userId, plan.chunksToInsert, plan.idsToInsert, nowMs,
    );
    const newArchivedCount = bigIntNumOr(sess.archived_count, 0) + archivedDelta;
    await client.query(UPDATE_LEGACY_COST_PATCH_SQL, [
      escapeNulInSessionMessagesJson(plan.finalJson), plan.tail.length + newArchivedCount, nowMs,
      plan.archivedThroughSeq, newArchivedCount, mapRow.session_id, userId,
      archivedDelta > 0 ? 1 : 0, computeSessionLastPreviewRaw(plan.tail),
    ]);
    return { applied: "patched" };
  }
  const archivedHit = await client.query(
    "SELECT 1 FROM client_session_archived_ids WHERE session_id = $1 AND msg_id = $2",
    [mapRow.session_id, mapRow.msg_id],
  );
  return (archivedHit.rowCount ?? 0) > 0 ? { applied: "noop" } : null;
}

async function parkExactPendingUsagePatch(
  client: PoolClient,
  requestId: string,
  userId: string,
  locator: CostLocator,
  normalizedCostCredits: string,
): Promise<AppendCostCreditsResult> {
  const pending = (
    await client.query<PendingUsagePatchRow>(
      `SELECT session_id,parent_session_id,delegate_agent_id,turn_key,parent_turn_key,
              cost_credits::text
         FROM pending_usage_patches
        WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
      [requestId, userId],
    )
  ).rows[0];
  if (pending) {
    if (hasPendingLocatorConflict(pending, locator, normalizedCostCredits)) {
      throw new Error("lossless pending cost component refuses remapping");
    }
    if (hasBackfillablePendingFields(pending, locator)) {
      await client.query(
        `UPDATE pending_usage_patches
            SET session_id = COALESCE(session_id, $3),
                parent_session_id = COALESCE(parent_session_id, $4),
                delegate_agent_id = COALESCE(delegate_agent_id, $5),
                turn_key = COALESCE(turn_key, $6),
                parent_turn_key = COALESCE(parent_turn_key, $7)
          WHERE request_id = $1 AND user_id = $2`,
        [
          requestId, userId, locator.sessionId, locator.parentSessionId,
          locator.delegateAgentId, locator.turnKey, locator.parentTurnKey,
        ],
      );
    }
    return { applied: "pending" };
  }
  await client.query(
    `INSERT INTO pending_usage_patches
       (request_id,user_id,session_id,parent_session_id,delegate_agent_id,
        turn_key,parent_turn_key,cost_credits)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      requestId, userId, locator.sessionId, locator.parentSessionId,
      locator.delegateAgentId, locator.turnKey, locator.parentTurnKey, normalizedCostCredits,
    ],
  );
  return { applied: "pending" };
}

async function parkLegacyPendingUsagePatch(
  client: PoolClient,
  requestId: string,
  userId: string,
  locator: CostLocator,
  normalizedCostCredits: string,
): Promise<AppendCostCreditsResult> {
  await client.query(UPSERT_LEGACY_PENDING_USAGE_PATCH_SQL, [
    requestId, userId, locator.sessionId, locator.parentSessionId,
    locator.delegateAgentId, locator.turnKey, locator.parentTurnKey, normalizedCostCredits,
  ]);
  return { applied: "pending" };
}

async function appendCostCreditsImpl(
  ctx: PgSessionsCtx,
  requestId: string,
  userId: string,
  costCredits: string,
  sessionId?: string | null,
  parentSessionId?: string | null,
  delegateAgentId?: string | null,
  turnKey?: string | null,
  parentTurnKey?: string | null,
): Promise<AppendCostCreditsResult> {
  const normalizedCostCredits = validateCostCreditsInput(costCredits, turnKey, parentTurnKey);
  const locator: CostLocator = {
    sessionId: sessionId ?? null,
    parentSessionId: parentSessionId ?? null,
    delegateAgentId: delegateAgentId ?? null,
    turnKey: turnKey ?? null,
    parentTurnKey: parentTurnKey ?? null,
  };
  const targetTurnKey = locator.parentTurnKey ?? locator.turnKey;
  let goalUsageChange: GoalUsageChange | null = null;

  const result = await withTx(ctx.pool, async (client): Promise<AppendCostCreditsResult> => {
    await requestAdvisoryXactLock(client, userId, requestId);
    if (targetTurnKey) {
      const exactOutcome = await tryApplyExactTurnCost(
        client,
        { requestId, userId, normalizedCostCredits, targetTurnKey, locator },
        ctx.deps,
      );
      if (exactOutcome) {
        goalUsageChange = exactOutcome.goalUsageChange;
        return exactOutcome.result;
      }
      return parkExactPendingUsagePatch(client, requestId, userId, locator, normalizedCostCredits);
    }
    const legacyOutcome = await tryApplyLegacyMapCost(
      client,
      requestId,
      userId,
      normalizedCostCredits,
      ctx.deps,
    );
    if (legacyOutcome) return legacyOutcome;
    return parkLegacyPendingUsagePatch(client, requestId, userId, locator, normalizedCostCredits);
  });

  await notifyGoalUsageChanges(
    ctx.options.onGoalUsageChanged,
    goalUsageChange ? [goalUsageChange] : [],
  );
  return result;
}

// ── Delegate cost draining ───────────────────────────────────────────────────

async function applyDelegateCostPlan(
  client: PoolClient,
  clientSessionId: string,
  userId: string,
  msgId: string,
  sess: ActiveSessionCostRow | undefined,
  pendings: DelegatePendingDbRow[],
  deps: PgSessionsDeps,
): Promise<DrainDelegateCostResult> {
  const msgs = sess ? parseHotMessagesOrEmpty(sess.messages) : null;
  const currentNextSeq =
    sess && typeof sess.next_seq === "number" && sess.next_seq > 0 ? sess.next_seq : 1;
  const currentArchivedThroughSeq = sess ? bigIntNumOr(sess.archived_through_seq, 0) : 0;

  const plan = deps.storage.planDelegateCostMerge(
    msgs,
    msgId,
    pendings.map(
      (p): DelegatePendingRow => ({
        costCredits: p.cost_credits,
        delegateAgentId: p.delegate_agent_id,
      }),
    ),
    currentNextSeq,
    currentArchivedThroughSeq,
  );
  if (plan.kind === "no_positive_cost") {
    await client.query(
      "DELETE FROM pending_usage_patches WHERE user_id = $1 AND request_id = ANY($2::text[])",
      [userId, pendings.map((p) => p.request_id)],
    );
    return { merged: "0", drained: pendings.length };
  }
  if (plan.kind === "target_not_ready") return { merged: "0", drained: 0 };

  const nowMs = Date.now();
  const archivedDelta = await execPgSpillPlan(
    client, clientSessionId, userId, plan.chunksToInsert, plan.idsToInsert, nowMs,
  );
  const newArchivedCount = bigIntNumOr(sess!.archived_count, 0) + archivedDelta;
  await client.query(UPDATE_DRAINED_DELEGATE_SESSION_SQL, [
    escapeNulInSessionMessagesJson(plan.finalJson), plan.tail.length + newArchivedCount, nowMs,
    plan.archivedThroughSeq, newArchivedCount, clientSessionId, userId, archivedDelta > 0 ? 1 : 0,
  ]);
  await client.query(
    "DELETE FROM pending_usage_patches WHERE user_id = $1 AND request_id = ANY($2::text[])",
    [userId, pendings.map((p) => p.request_id)],
  );
  return {
    merged: plan.merged,
    drained: pendings.length,
    ...(plan.delegates.length > 0 ? { delegates: plan.delegates } : {}),
  };
}

async function drainDelegateCostImpl(
  ctx: PgSessionsCtx,
  clientSessionId: string,
  userId: string,
  msgId: string,
): Promise<DrainDelegateCostResult> {
  return withTx(ctx.pool, async (client): Promise<DrainDelegateCostResult> => {
    const probe = await client.query(
      "SELECT 1 FROM pending_usage_patches WHERE user_id = $1 AND parent_session_id = $2 LIMIT 1",
      [userId, clientSessionId],
    );
    if ((probe.rowCount ?? 0) === 0) return { merged: "0", drained: 0 };

    const sess = (
      await client.query<ActiveSessionCostRow>(
        "SELECT messages, next_seq, archived_through_seq, archived_count FROM client_sessions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE",
        [clientSessionId, userId],
      )
    ).rows[0];
    const pendings = (
      await client.query<DelegatePendingDbRow>(
        "SELECT request_id, cost_credits, delegate_agent_id FROM pending_usage_patches WHERE user_id = $1 AND parent_session_id = $2 ORDER BY request_id FOR UPDATE",
        [userId, clientSessionId],
      )
    ).rows;
    if (pendings.length === 0) return { merged: "0", drained: 0 };

    return applyDelegateCostPlan(client, clientSessionId, userId, msgId, sess, pendings, ctx.deps);
  });
}

// ── Store factory ────────────────────────────────────────────────────────────

export function createPgUsageAggregationStore(
  ctx: PgSessionsCtx,
): Pick<ClientSessionsBackend, "appendCostCredits" | "drainDelegateCostForClientSession"> {
  return {
    appendCostCredits(
      requestId, userId, costCredits, sessionId, parentSessionId, delegateAgentId, turnKey, parentTurnKey,
    ) {
      return appendCostCreditsImpl(
        ctx, requestId, userId, costCredits, sessionId, parentSessionId, delegateAgentId, turnKey, parentTurnKey,
      );
    },
    drainDelegateCostForClientSession(clientSessionId, userId, msgId) {
      return drainDelegateCostImpl(ctx, clientSessionId, userId, msgId);
    },
  };
}
