import type { PoolClient } from "pg";
import type { ClientSessionsBackend, UsageAggregationGcStats } from "@openclaude/storage";
import type { PgSessionsCtx } from "./deps.js";
import { notifyGoalUsageChanges, withTx } from "./sqlHelpers.js";
import type { GoalUsageChange, SessionsGcSweeperOptions } from "./types.js";

// ── GC retention windows (aligned with storage/sessionsDb.ts) ────────────────

const PENDING_AGING_MS = 60 * 60_000; // 1h alarm
const PENDING_HARD_DELETE_MS = 24 * 60 * 60_000; // 24h GC
const MAP_HARD_DELETE_MS = 7 * 24 * 60 * 60_000; // 7d GC
const PENDING_UNREACHABLE_DELETE_MS = 7 * 24 * 60 * 60_000; // 7d unreachable keyed pending GC
const FINALIZED_TAPE_PARTS_DELETE_MS = 48 * 60 * 60_000; // 48h finalized tape parts fallback GC
const SWEEP_GC_LEASE_KEY = "oc_sessions_sweep_gc";

// ── SQL statements ───────────────────────────────────────────────────────────

const FOLD_LATE_PENDING_TO_COMPONENTS_SQL = `WITH locked AS (
   SELECT p.request_id, p.user_id, p.cost_credits, p.delegate_agent_id,
          p.turn_key, p.parent_turn_key
     FROM pending_usage_patches p
    WHERE p.created_at <= $1
      AND (p.turn_key IS NOT NULL OR p.parent_turn_key IS NOT NULL)
    ORDER BY p.request_id
    FOR UPDATE SKIP LOCKED
 ), foldable AS (
   SELECT DISTINCT ON (l.request_id, l.user_id)
          l.request_id, l.user_id, l.cost_credits, l.delegate_agent_id,
          t.session_id, t.tape_id, t.billing_anchor_id
     FROM locked l
     JOIN client_session_turn_tapes t
       ON t.user_id = l.user_id
      AND (t.turn_key = l.turn_key OR t.turn_key = l.parent_turn_key)
      AND t.finalized_at IS NOT NULL
      AND t.billing_anchor_id IS NOT NULL
    ORDER BY l.request_id, l.user_id, t.finalized_at ASC, t.tape_id ASC
 ), inserted AS (
   INSERT INTO turn_tape_cost_components
     (request_id, user_id, session_id, tape_id, billing_anchor_id,
      cost_credits, delegate_agent_id, updated_at)
   SELECT request_id, user_id, session_id, tape_id, billing_anchor_id,
          cost_credits::numeric, delegate_agent_id, $2
     FROM foldable
   ON CONFLICT (request_id, user_id) DO NOTHING
   RETURNING session_id,user_id,tape_id
 ), updated AS (
   UPDATE session_goals g
      SET snapshot_revision=snapshot_revision+1,updated_at=clock_timestamp()
    WHERE EXISTS (
      SELECT 1
        FROM inserted i
        JOIN client_session_turn_tapes t
          ON t.session_id=i.session_id AND t.user_id=i.user_id AND t.tape_id=i.tape_id
       WHERE t.goal_id=g.goal_id AND t.session_id=g.session_id
    )
   RETURNING g.session_id
 )
 SELECT DISTINCT i.user_id,i.session_id
   FROM inserted i
   JOIN updated u ON u.session_id=i.session_id`;

const DELETE_FOLDED_PENDING_SQL = `DELETE FROM pending_usage_patches p
  USING client_session_turn_tapes t, turn_tape_cost_components c
  WHERE p.created_at <= $1
    AND (p.turn_key IS NOT NULL OR p.parent_turn_key IS NOT NULL)
    AND t.user_id = p.user_id
    AND (t.turn_key = p.turn_key OR t.turn_key = p.parent_turn_key)
    AND t.finalized_at IS NOT NULL
    AND t.billing_anchor_id IS NOT NULL
    AND c.request_id = p.request_id
    AND c.user_id = p.user_id
    AND c.session_id = t.session_id
    AND c.tape_id = t.tape_id
    AND c.billing_anchor_id = t.billing_anchor_id
    AND c.cost_credits::numeric = p.cost_credits::numeric
    AND c.delegate_agent_id IS NOT DISTINCT FROM p.delegate_agent_id`;

const COUNT_FOLD_ANOMALY_SQL = `SELECT COUNT(*)::int AS n
  FROM pending_usage_patches p
 WHERE p.created_at <= $1
   AND (p.turn_key IS NOT NULL OR p.parent_turn_key IS NOT NULL)
   AND EXISTS (
     SELECT 1 FROM client_session_turn_tapes t
      WHERE t.user_id = p.user_id
        AND (t.turn_key = p.turn_key OR t.turn_key = p.parent_turn_key)
        AND t.finalized_at IS NOT NULL AND t.billing_anchor_id IS NOT NULL
   )
   AND EXISTS (
     SELECT 1 FROM turn_tape_cost_components c
      WHERE c.request_id = p.request_id AND c.user_id = p.user_id
   )`;

const DELETE_UNREACHABLE_PENDING_SQL = `DELETE FROM pending_usage_patches p
 WHERE p.created_at <= $1
   AND (p.turn_key IS NOT NULL OR p.parent_turn_key IS NOT NULL)
   AND NOT EXISTS (
     SELECT 1 FROM client_session_turn_tapes t
      WHERE t.user_id = p.user_id
        AND (t.turn_key = p.turn_key OR t.turn_key = p.parent_turn_key)
        AND t.finalized_at IS NOT NULL AND t.billing_anchor_id IS NOT NULL
   )`;

const DELETE_FINALIZED_TAPE_PARTS_SQL = `DELETE FROM client_session_turn_tape_parts pp
 USING client_session_turn_tapes t
 WHERE t.session_id = pp.session_id
   AND t.user_id = pp.user_id
   AND t.tape_id = pp.tape_id
   AND t.finalized_at IS NOT NULL
   AND pp.created_at <= $1`;

// ── Advisory-leased GC sweeper lifecycle ─────────────────────────────────────

interface GcSweeperState {
  readonly opts: SessionsGcSweeperOptions;
  readonly intervalMs: number;
  readonly recompeteMs: number;
  readonly now: () => number;
  stopped: boolean;
  leaseClient: PoolClient | null;
  sweepTimer: ReturnType<typeof setInterval> | null;
  recompeteTimer: ReturnType<typeof setTimeout> | null;
  sweeping: boolean;
}

function unrefTimer(
  timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>,
): void {
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}

function destroyLeaseClient(client: PoolClient, err: unknown): void {
  try {
    client.release(err instanceof Error ? err : new Error(String(err)));
  } catch (releaseErr) {
    void releaseErr;
  }
}

function clearSweepTimer(state: GcSweeperState): void {
  if (!state.sweepTimer) return;
  clearInterval(state.sweepTimer);
  state.sweepTimer = null;
}

async function runSweepPass(state: GcSweeperState): Promise<void> {
  if (state.stopped || !state.leaseClient || state.sweeping) return;
  state.sweeping = true;
  try {
    const changes: GoalUsageChange[] = [];
    const stats = await withTx(state.opts.pool, (client) => sweepOnce(client, state.now(), changes));
    await notifyGoalUsageChanges(state.opts.onGoalUsageChanged, changes);
    state.opts.onStats?.(stats);
  } catch (err) {
    state.opts.onError?.(err);
  } finally {
    state.sweeping = false;
  }
}

function scheduleRecompete(state: GcSweeperState): void {
  if (state.stopped || state.recompeteTimer) return;
  state.recompeteTimer = setTimeout(() => {
    state.recompeteTimer = null;
    void competeForGcLease(state);
  }, state.recompeteMs);
  unrefTimer(state.recompeteTimer);
}

function handleLeaseClientError(
  state: GcSweeperState,
  client: PoolClient,
  err: unknown,
): void {
  state.opts.onError?.(err);
  if (client !== state.leaseClient) return;
  clearSweepTimer(state);
  state.leaseClient = null;
  destroyLeaseClient(client, err);
  scheduleRecompete(state);
}

async function competeForGcLease(state: GcSweeperState): Promise<void> {
  if (state.stopped || state.leaseClient) return;
  let client: PoolClient;
  try {
    client = await state.opts.pool.connect();
  } catch (err) {
    state.opts.onError?.(err);
    scheduleRecompete(state);
    return;
  }
  client.on("error", (err) => handleLeaseClientError(state, client, err));
  try {
    const r = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok",
      [SWEEP_GC_LEASE_KEY],
    );
    if (r.rows[0]?.ok === true) {
      state.leaseClient = client;
      state.sweepTimer = setInterval(() => void runSweepPass(state), state.intervalMs);
      unrefTimer(state.sweepTimer);
    } else {
      client.release();
      scheduleRecompete(state);
    }
  } catch (err) {
    state.opts.onError?.(err);
    destroyLeaseClient(client, err);
    scheduleRecompete(state);
  }
}

async function stopGcSweeper(state: GcSweeperState): Promise<void> {
  state.stopped = true;
  clearSweepTimer(state);
  if (state.recompeteTimer) {
    clearTimeout(state.recompeteTimer);
    state.recompeteTimer = null;
  }
  const client = state.leaseClient;
  state.leaseClient = null;
  if (!client) return;
  try {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [SWEEP_GC_LEASE_KEY]);
    client.release();
  } catch (err) {
    destroyLeaseClient(client, err);
  }
}

/**
 * 启动 advisory-lease 门控的 usage 聚合 GC sweeper。只有竞到固定 key 的 session-level advisory
 * lock 的进程才周期执行 sweep;持锁连接掉线 → 停 sweep → 重竞锁;备者接管。返回 { stop }。
 */
export function startSessionsGcSweeper(
  opts: SessionsGcSweeperOptions,
): { stop: () => Promise<void> } {
  const state: GcSweeperState = {
    opts,
    intervalMs: opts.intervalMs ?? 60 * 60_000,
    recompeteMs: opts.recompeteMs ?? 60_000,
    now: opts.now ?? (() => Date.now()),
    stopped: false,
    leaseClient: null,
    sweepTimer: null,
    recompeteTimer: null,
    sweeping: false,
  };
  void competeForGcLease(state);
  return {
    stop: () => stopGcSweeper(state),
  };
}

// ── Single-pass sweep execution ──────────────────────────────────────────────

async function foldLateKeyedPendingPatches(
  client: PoolClient,
  agingThreshold: number,
  nowMs: number,
  goalUsageChanges: GoalUsageChange[],
): Promise<{ pendingFolded: number; pendingFoldAnomaly: number }> {
  const changedGoals = await client.query<{ user_id: string; session_id: string }>(
    FOLD_LATE_PENDING_TO_COMPONENTS_SQL,
    [agingThreshold, nowMs],
  );
  goalUsageChanges.push(
    ...changedGoals.rows.map((row) => ({ userId: row.user_id, sessionId: row.session_id })),
  );
  const delFolded = await client.query(DELETE_FOLDED_PENDING_SQL, [agingThreshold]);
  const foldAnomaly = (
    await client.query<{ n: number }>(COUNT_FOLD_ANOMALY_SQL, [agingThreshold])
  ).rows[0];
  return {
    pendingFolded: delFolded.rowCount ?? 0,
    pendingFoldAnomaly: foldAnomaly?.n ?? 0,
  };
}

/** 单次 sweep(map→pending 锁序;供 sweeper 与测试共用)。 */
export async function sweepOnce(
  client: PoolClient,
  nowMs: number,
  goalUsageChanges: GoalUsageChange[] = [],
): Promise<UsageAggregationGcStats> {
  const agingThreshold = nowMs - PENDING_AGING_MS;
  const expiredThreshold = nowMs - PENDING_HARD_DELETE_MS;
  const mapThreshold = nowMs - MAP_HARD_DELETE_MS;
  const unreachableThreshold = nowMs - PENDING_UNREACHABLE_DELETE_MS;
  const partsThreshold = nowMs - FINALIZED_TAPE_PARTS_DELETE_MS;

  const aging = (
    await client.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM pending_usage_patches WHERE created_at <= $1 AND created_at > $2",
      [agingThreshold, expiredThreshold],
    )
  ).rows[0];
  const delMap = await client.query(
    "DELETE FROM server_authored_request_map WHERE written_at <= $1",
    [mapThreshold],
  );
  const delPending = await client.query(
    `DELETE FROM pending_usage_patches
      WHERE created_at <= $1 AND turn_key IS NULL AND parent_turn_key IS NULL`,
    [expiredThreshold],
  );
  const { pendingFolded, pendingFoldAnomaly } = await foldLateKeyedPendingPatches(
    client,
    agingThreshold,
    nowMs,
    goalUsageChanges,
  );
  const delUnreachable = await client.query(DELETE_UNREACHABLE_PENDING_SQL, [unreachableThreshold]);
  const delParts = await client.query(DELETE_FINALIZED_TAPE_PARTS_SQL, [partsThreshold]);

  return {
    pendingAging: aging?.n ?? 0,
    pendingExpired: delPending.rowCount ?? 0,
    mapExpired: delMap.rowCount ?? 0,
    pendingFolded,
    pendingFoldAnomaly,
    pendingUnreachableExpired: delUnreachable.rowCount ?? 0,
    tapePartsPurged: delParts.rowCount ?? 0,
  };
}

// ── Store factory ────────────────────────────────────────────────────────────

export function createPgSessionsGcStore(
  ctx: PgSessionsCtx,
): Pick<ClientSessionsBackend, "sweepUsageAggregationGc"> {
  return {
    async sweepUsageAggregationGc(now: number = Date.now()): Promise<UsageAggregationGcStats> {
      const changes: GoalUsageChange[] = [];
      const stats = await withTx(ctx.pool, (client) => sweepOnce(client, now, changes));
      await notifyGoalUsageChanges(ctx.options.onGoalUsageChanged, changes);
      return stats;
    },
  };
}
