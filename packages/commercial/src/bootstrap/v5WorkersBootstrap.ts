/**
 * V5 background worker option builders (tape materialization, turn dispatch reconciler,
 * cron wake, and recovery friction reporting).
 *
 * Extracted from packages/commercial/src/index.ts (OCV5-830).
 * Scheduler factory invocations (startXxxScheduler / trackScheduler / leaderBundle.add)
 * remain in index.ts so check-schedulers.ts Rule 2 and v5ReleaseSafety.test.ts stay intact.
 */
import { normalizeTurnErrorCode, type DurableCodexBilling } from "@openclaude/protocol";
import {
  findDueCronWakeUsers,
  runCronWakeRescan,
  type CronWakeRunner,
} from "../agent-sandbox/cronWake.js";
import { releasePreCheck, type PreCheckRedis } from "../billing/preCheck.js";
import { applyTurnWaiver } from "../billing/refund.js";
import * as computeQueries from "../compute-pool/queries.js";
import { createPool, getPool } from "../db/index.js";
import {
  _setAfterLosslessStageBatch,
  commitVisibleLosslessTurnPhaseA,
  createPgSessionsBackend,
  type AutomaticRecoveryDecision,
  type DispatchAdmissionBackend,
} from "../db/pgSessionsBackend.js";
import { makeContainerDispatchClient } from "../dispatch/containerDispatchClient.js";
import { resolveDispatchEndpoint } from "../dispatch/resolveDispatchEndpoint.js";
import {
  buildTurnDispatchReconcileFrame,
  resolveDispatchStuckThresholdMs,
} from "../dispatch/turnDispatchReconciler.js";
import { rootLogger } from "../logging/logger.js";
import { recordProductFrictionEvent } from "../productFriction/events.js";
import { getRuntimeChannel } from "../runtimeChannel.js";
import { makeDesktopContainerTransport } from "../wechat/desktopContainerTransport.js";
import { makeNodeHttpContainerTransport } from "../wechat/nodeHttpContainerTransport.js";
import type { UserChatBridgeHandler } from "../ws/userChatBridge.js";

export function recordRecoveryJobTerminalFriction(
  userId: string,
  sessionId: string,
  info: {
    rootClientMessageId: string;
    errorCode: string;
    semanticAttempt: number;
    terminalStatus: "completed" | "paused";
    pauseReason: string | null;
  },
): void {
  const uidMatch = /^c:([1-9][0-9]*)$/.exec(userId);
  if (!uidMatch) return;
  const code = normalizeTurnErrorCode(info.errorCode);
  if (!/^[A-Za-z0-9_]{1,64}$/.test(code)) return;
  void recordProductFrictionEvent({
    correlation: `${sessionId}:${info.rootClientMessageId}`,
    userId: BigInt(uidMatch[1]!),
    surface: "recovery",
    stage: "recovery_job",
    code,
    outcome: info.terminalStatus === "completed" ? "recovered" : "failed",
    attempts: info.semanticAttempt,
    path: "job_terminal",
    reason: info.pauseReason ?? undefined,
    sessionId,
  }).catch((err: unknown) => {
    rootLogger.warn("recovery_job_friction_failed", {
      sessionId,
      errorClass: err instanceof Error ? err.constructor.name : typeof err,
    });
  });
}

export function buildTapeJobSchedulerSetup(deps: {
  env: NodeJS.ProcessEnv;
  sessionsStoreGeneration: number;
  recoveryDecisionBroadcastRef: {
    current: (userId: string, sessionId: string, verdict: AutomaticRecoveryDecision) => void;
  };
  settleTapeEngineBilling: (userId: bigint, billing: DurableCodexBilling) => Promise<void>;
}) {
  const materializePool = createPool({
    max: 2,
    statementTimeoutMs: 120_000,
    idleInTransactionSessionTimeoutMs: 600_000,
    applicationName: "openclaude-tape-materialize",
  });
  const materializeBackend = createPgSessionsBackend(materializePool, {
    expectedGeneration: deps.sessionsStoreGeneration,
    onAutomaticRecoveryDecision: (userId, sessionId, verdict) =>
      deps.recoveryDecisionBroadcastRef.current(userId, sessionId, verdict),
    onRecoveryJobTerminal: (userId, sessionId, info) =>
      recordRecoveryJobTerminalFriction(userId, sessionId, info),
  });
  const rawInterval = Number(deps.env.COMMERCIAL_TAPE_MATERIALIZATION_INTERVAL_MS);
  const intervalMs = Number.isFinite(rawInterval) && rawInterval >= 1000 ? rawInterval : 5_000;

  return {
    materializePool,
    schedulerOpts: {
      pool: getPool(),
      materializePool,
      intervalMs,
      runOnStart: true,
      onError: (err: unknown) =>
        rootLogger.warn("[tapeJobScheduler] tick failed", {
          err: (err as Error)?.message ?? String(err),
        }),
      materializeTape: async (
        job: { sessionId: string; userId: string; tapeId: string },
        renew: () => Promise<void>,
      ) => {
        _setAfterLosslessStageBatch(renew);
        try {
          const header = await getPool().query<{
            agent_id: string;
            turn_index: number;
            status: "completed" | "interrupted" | "crashed";
            turn_key: string;
            tape_sha256: string;
            total_bytes: string;
            part_count: number;
            created_at: string;
            waive_reason: string | null;
            model: string | null;
            dispatch_id: string | null;
            attempt_no: number | null;
            materialized: boolean;
          }>(
            `SELECT agent_id, turn_index, status, turn_key, tape_sha256, total_bytes::text,
                    part_count, created_at::text, waive_reason, NULL::text AS model,
                    dispatch_id::text, attempt_no,
                    (materialization_status='complete' OR finalized_at IS NOT NULL) AS materialized
               FROM client_session_turn_tapes
              WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
            [job.sessionId, job.userId, job.tapeId],
          );
          const row = header.rows[0];
          if (!row) throw new Error("tape header missing for materialization job");
          if (row.materialized) return;
          const result = await materializeBackend.finalizeLosslessTurnTape(job.userId, {
            protocolVersion: 2,
            action: "finalize",
            sessionId: job.sessionId,
            agentId: row.agent_id,
            turnIndex: row.turn_index,
            status: row.status,
            turnKey: row.turn_key,
            tapeId: job.tapeId,
            tapeSha256: row.tape_sha256,
            totalBytes: Number(row.total_bytes),
            partCount: row.part_count,
            createdAt: Number(row.created_at),
            ...(row.waive_reason ? { waiveReason: row.waive_reason as "idle_timeout" } : {}),
            ...(row.dispatch_id ? { dispatchId: row.dispatch_id, attemptNo: row.attempt_no ?? 1 } : {}),
          });
          if (result.applied === "incomplete") {
            throw new Error("tape materialization still incomplete");
          }
          const done = await getPool().query<{ ok: boolean }>(
            `SELECT (materialization_status='complete' OR finalized_at IS NOT NULL) AS ok
               FROM client_session_turn_tapes
              WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
            [job.sessionId, job.userId, job.tapeId],
          );
          if (done.rows[0]?.ok !== true) {
            throw new Error("tape materialization pending after finalize");
          }
        } finally {
          _setAfterLosslessStageBatch(null);
        }
      },
      settleJob: async (job: { userId: string; kind: string; payload: unknown }) => {
        const uidMatch = /^c:([1-9][0-9]*)$/.exec(job.userId);
        if (!uidMatch) throw new Error("settlement job requires commercial user");
        const uid = BigInt(uidMatch[1]!);
        if (job.kind === "billing") {
          const billings = Array.isArray((job.payload as { engineBillings?: unknown }).engineBillings)
            ? (job.payload as { engineBillings: DurableCodexBilling[] }).engineBillings
            : [];
          for (const billing of billings) {
            await deps.settleTapeEngineBilling(uid, billing);
          }
          return;
        }
        const reason = (job.payload as { reason?: string; turnKey?: string }).reason;
        const turnKey = (job.payload as { turnKey?: string }).turnKey;
        if (!reason || !turnKey) throw new Error("waiver job payload missing reason/turnKey");
        const waiver = await applyTurnWaiver(getPool(), {
          userId: uid,
          turnKey,
          reason: reason as "idle_timeout",
          logger: rootLogger.child({ subsys: "tapeWaiver" }),
        });
        if (waiver.disposition === "deferred") {
          throw new Error(`turn waiver proof pending: ${waiver.reason}`);
        }
      },
    },
  };
}

export function wireTapeSchedulerKick(
  tapeSchedulerKickRef: { current: () => void },
  runNow: () => Promise<unknown>,
): void {
  let kickRunning = false;
  let kickRequested = false;
  const drainKicks = (): void => {
    if (kickRunning) {
      kickRequested = true;
      return;
    }
    kickRunning = true;
    void runNow()
      .catch(() => undefined)
      .finally(() => {
        kickRunning = false;
        if (kickRequested) {
          kickRequested = false;
          drainKicks();
        }
      });
  };
  tapeSchedulerKickRef.current = drainKicks;
}

export function buildTurnDispatchReconcilerConfig(deps: {
  env: NodeJS.ProcessEnv;
  bridgeSecret: string | undefined;
  dispatchAdmissionBackend: DispatchAdmissionBackend | undefined;
  containerLinkOn: boolean;
  preCheckRedis: PreCheckRedis;
  userChatBridge: UserChatBridgeHandler;
}) {
  const rawInterval = Number(deps.env.COMMERCIAL_TURN_DISPATCH_RECONCILER_INTERVAL_MS);
  const intervalMs = Number.isFinite(rawInterval) && rawInterval >= 5000 ? rawInterval : 30_000;
  const rawCodexMax = Number(deps.env.CODEX_SESSION_MAX_MS);
  const stuckThresholdMs = resolveDispatchStuckThresholdMs(
    deps.env.COMMERCIAL_TURN_DISPATCH_STUCK_MS,
    Number.isFinite(rawCodexMax) ? rawCodexMax : undefined,
  );
  const container = makeContainerDispatchClient({
    transport: makeNodeHttpContainerTransport(),
    desktopTransport: makeDesktopContainerTransport(),
    bridgeSecret: deps.bridgeSecret ?? "",
    resolveRunningEndpoint: async (id) => {
      if (!deps.bridgeSecret) return null;
      return resolveDispatchEndpoint(id);
    },
  });
  const reconcilerDeps = {
    recoverInterruptedAdmission: deps.dispatchAdmissionBackend
      ? (id: string) => deps.dispatchAdmissionBackend!.recoverInterruptedAdmission(id)
      : undefined,
    containerLinkEnabled: deps.containerLinkOn,
    pool: getPool(),
    container,
    stuckThresholdMs,
    releaseReservation: (ref: { userId: string; requestId: string }) =>
      releasePreCheck(deps.preCheckRedis, { userId: ref.userId, requestId: ref.requestId }).then(() => {}),
    recordFriction: (event: Parameters<typeof recordProductFrictionEvent>[0]) =>
      recordProductFrictionEvent(event),
    nudgeClient: (
      uid: bigint,
      sessionId: string,
      clientMessageId: string,
      reconcile?: "turn_completed" | "interrupted" | "turn_state_unknown",
    ) => {
      try {
        deps.userChatBridge.broadcastToUser(
          uid,
          buildTurnDispatchReconcileFrame({
            sessionId,
            clientMessageId,
            reconcile,
          }),
        );
      } catch {
        /* best-effort */
      }
    },
    commitVisibleTape: async (input: { userId: string; sessionId: string; tapeId: string }) => {
      const header = await getPool().query<{
        agent_id: string;
        turn_index: number;
        status: "completed" | "interrupted" | "crashed";
        turn_key: string;
        tape_sha256: string;
        total_bytes: string;
        part_count: number;
        created_at: string;
        waive_reason: string | null;
        dispatch_id: string | null;
        attempt_no: number | null;
      }>(
        `SELECT agent_id, turn_index, status, turn_key, tape_sha256, total_bytes::text,
                part_count, created_at::text, waive_reason, dispatch_id::text, attempt_no
           FROM client_session_turn_tapes
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
        [input.sessionId, input.userId, input.tapeId],
      );
      const row = header.rows[0];
      if (!row) throw new Error("visible tape header missing");
      await commitVisibleLosslessTurnPhaseA(getPool(), input.userId, {
        protocolVersion: 2,
        action: "finalize",
        sessionId: input.sessionId,
        agentId: row.agent_id,
        turnIndex: row.turn_index,
        status: row.status,
        turnKey: row.turn_key,
        tapeId: input.tapeId,
        tapeSha256: row.tape_sha256,
        totalBytes: Number(row.total_bytes),
        partCount: row.part_count,
        createdAt: Number(row.created_at),
        ...(row.waive_reason ? { waiveReason: row.waive_reason as "idle_timeout" } : {}),
        ...(row.dispatch_id ? { dispatchId: row.dispatch_id, attemptNo: row.attempt_no ?? 1 } : {}),
      });
    },
  };
  return { intervalMs, reconcilerDeps };
}

export function buildCronWakeSchedulerOptions(deps: {
  env: NodeJS.ProcessEnv;
  wakeFn: (uid: bigint) => Promise<void>;
}) {
  const cronWakeRunner = getPool() as unknown as CronWakeRunner;
  const maxRaw = Number(deps.env.COMMERCIAL_CRON_WAKE_MAX_PER_TICK);
  const maxPerTick = Number.isFinite(maxRaw) && maxRaw >= 1 ? Math.trunc(maxRaw) : undefined;
  const cdRaw = Number(deps.env.COMMERCIAL_CRON_WAKE_COOLDOWN_MIN);
  const cooldownMs = Number.isFinite(cdRaw) && cdRaw >= 0 ? Math.trunc(cdRaw) * 60_000 : undefined;
  return {
    findDueUsers: (scanLimit: number, horizonSec: number) =>
      findDueCronWakeUsers(cronWakeRunner, {
        runtimeChannel: getRuntimeChannel(),
        horizonSec,
        scanLimit,
      }),
    isContainerActive: async (uid: bigint) => computeQueries.userHasRunningContainer(Number(uid)),
    wakeContainer: (uid: bigint) => deps.wakeFn(uid),
    recordWakeOutcome: ({
      userId,
      correlation,
      outcome,
      attempts,
    }: {
      userId: bigint;
      correlation: string;
      outcome: "failed" | "recovered";
      attempts: number;
    }) => {
      void recordProductFrictionEvent(
        {
          correlation,
          userId,
          surface: "cron",
          stage: "container_wake",
          code: "WAKE_FAILED",
          outcome,
          attempts,
        },
        getPool(),
      ).catch(() => {});
    },
    runRescan: () => runCronWakeRescan({ runner: cronWakeRunner }),
    logger: rootLogger,
    maxPerTick,
    cooldownMs,
  };
}
