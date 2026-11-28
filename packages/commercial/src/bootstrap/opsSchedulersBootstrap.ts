import type { DurableCodexBilling } from "@openclaude/protocol";
import { startAlertScheduler } from "../admin/alerts.js";
import { startAuditRetentionSweeper } from "../admin/auditRetention.js";
import { startCursorAuthSyncActor } from "../account-pool/cursorMaterializer.js";
import { startCursorSandPreparationActor } from "../account-pool/cursorSandActor.js";
import { startCursorUsageSweeper } from "../account-pool/cursorUsageSweeper.js";
import { startGrokUsageSweeper } from "../account-pool/grokUsageSweeper.js";
import { startPoolRecoveryActor } from "../account-pool/policy/registry.js";
import { startRefreshEventsSweeper } from "../account-pool/refreshEventsSweeper.js";
import { startRemoteDriverDriftScheduler } from "../account-pool/remotePool/index.js";
import { startCronWakeScheduler } from "../agent-sandbox/cronWake.js";
import type { Mailer } from "../auth/mail.js";
import { reconcileBoxBillingBatch } from "../billing/boxBillingRecovery.js";
import { parseZeroChargeCutoff, startCursorAuditReconciler } from "../billing/cursorAuditReconciler.js";
import { startAntigravityTurnReconciler } from "../billing/durableAntigravityBilling.js";
import {
  DEFAULT_RECONCILE_INTERVAL_MS,
  MIN_INTERVAL_MS as FINALIZE_RECONCILER_MIN_INTERVAL_MS,
  resolveDurableWaiverAgeMs,
  resolveStuckThresholdMs,
  startFinalizeJournalReconciler,
} from "../billing/finalizeJournalReconciler.js";
import type { PreCheckRedis } from "../billing/preCheck.js";
import { recoverRemoteNativeTurnBilling } from "../billing/remoteNativeTurnBilling.js";
import type { CommercialConfig } from "../config.js";
import { startConnectorSweeper } from "../connectors/sweeper.js";
import { getPool } from "../db/index.js";
import {
  resolveLiveFrameMaintenanceDisabled,
  resolveLiveFrameMaintenanceIntervalMs,
  resolvePruneMaxBatches,
  resolveRetireMinAgeMs,
  startLiveFrameMaintenanceScheduler,
} from "../db/liveFrameMaintenanceScheduler.js";
import type { AutomaticRecoveryDecision, DispatchAdmissionBackend } from "../db/pgSessionsBackend.js";
import { startTapeJobScheduler } from "../db/tapeJobScheduler.js";
import type { LeaderBundle } from "../deploy/leaderBundle.js";
import {
  DEFAULT_SHUTDOWN_HANDOFF_BUDGET_MS,
  runShutdownDispatchHandoff,
  startTurnDispatchReconciler,
} from "../dispatch/turnDispatchReconciler.js";
import type { assertFlavorIdentity } from "../flavor/assertFlavor.js";
import { shouldStartCommercialScheduler } from "../flavor/commercialSchedulerPolicy.js";
import { startDesktopEnrollmentSweep } from "../http/desktopEnroll.js";
import type { BoxRemoteCleanupWorker } from "../http/proxy/boxRemoteCleanupWorker.js";
import { startInboxEmailScheduler } from "../inbox/email.js";
import { startOnboardingScheduler } from "../inbox/onboarding.js";
import { rootLogger } from "../logging/logger.js";
import { startPendingOrdersExpirer } from "../payment/pendingOrdersExpirer.js";
import {
  assertSelfhealConfig,
  selfhealTickMs,
  startIncidentReconciler,
  startIncidentSweeper,
  type IncidentReconcilerHandle,
  type IncidentSweeperHandle,
} from "../selfheal/index.js";
import type { UserChatBridgeHandler } from "../ws/userChatBridge.js";
import {
  parseSchedulerIntervalMs as parseInterval,
  type TrackSchedulerFn,
} from "./leaderBundleBootstrap.js";
import {
  buildCronWakeSchedulerOptions,
  buildTapeJobSchedulerSetup,
  buildTurnDispatchReconcilerConfig,
  wireTapeSchedulerKick,
} from "./v5WorkersBootstrap.js";

function registerAlertAndAuditMembers(args: {
  env: NodeJS.ProcessEnv;
  leaderBundle: LeaderBundle;
  trackScheduler: TrackSchedulerFn;
  mailer: Mailer;
}): void {
  const { env, leaderBundle, trackScheduler, mailer } = args;
  if (env.COMMERCIAL_ALERTS_DISABLED !== "1") {
    leaderBundle.add({
      name: "alert",
      domain: "shared",
      start: () => {
        const tickMs = parseInterval(env.COMMERCIAL_ALERT_TICK_MS, 1000, 60_000);
        const h = trackScheduler("alert", "shared", startAlertScheduler({ intervalMs: tickMs, runOnStart: false }));
        return { stop: () => h.stop() };
      },
    });
  }
  if (env.COMMERCIAL_REFRESH_EVENTS_SWEEP_DISABLED !== "1") {
    leaderBundle.add({
      name: "refreshEventsSweep",
      domain: "shared",
      start: () => {
        const h = trackScheduler("refreshEventsSweep", "shared", startRefreshEventsSweeper());
        return { stop: () => h.stop() };
      },
    });
  }
  if (env.OC_DESKTOP_ENROLL_SWEEP_DISABLED !== "1") {
    leaderBundle.add({
      name: "desktopEnrollSweep",
      domain: "shared",
      start: () => {
        const h = trackScheduler("desktopEnrollSweep", "shared", startDesktopEnrollmentSweep());
        return { stop: () => h.stop() };
      },
    });
  }
  if (env.COMMERCIAL_AUDIT_RETENTION_SWEEP_DISABLED !== "1") {
    leaderBundle.add({
      name: "auditRetentionSweep",
      domain: "shared",
      start: () => {
        const h = trackScheduler("auditRetentionSweep", "shared", startAuditRetentionSweeper({ runOnStart: true }));
        return { stop: () => h.stop() };
      },
    });
  }
  if (env.COMMERCIAL_ONBOARDING_DISABLED !== "1") {
    leaderBundle.add({
      name: "onboarding",
      domain: "shared",
      start: () => {
        const intervalMs = parseInterval(env.COMMERCIAL_ONBOARDING_INTERVAL_MS, 5000, 60_000);
        const h = trackScheduler("onboarding", "shared", startOnboardingScheduler({ intervalMs }));
        return { stop: () => h.stop() };
      },
    });
  }
  if (env.COMMERCIAL_INBOX_EMAIL_DISABLED !== "1") {
    leaderBundle.add({
      name: "inboxEmail",
      domain: "shared",
      start: () => {
        const intervalMs = parseInterval(env.COMMERCIAL_INBOX_EMAIL_INTERVAL_MS, 5000, 30_000);
        const h = trackScheduler("inboxEmail", "shared", startInboxEmailScheduler({ mailer, intervalMs }));
        return { stop: () => h.stop() };
      },
    });
  }
}

function registerPoolAndOrdersMembers(args: {
  env: NodeJS.ProcessEnv;
  runtimeChannel: string;
  flavorIdentity: ReturnType<typeof assertFlavorIdentity>;
  paymentEnabled: boolean;
  leaderBundle: LeaderBundle;
  trackScheduler: TrackSchedulerFn;
}): void {
  const { env, runtimeChannel, flavorIdentity, paymentEnabled, leaderBundle, trackScheduler } = args;
  if (env.COMMERCIAL_COOLDOWN_RECOVERY_DISABLED !== "1") {
    leaderBundle.add({
      name: "cooldownRecovery",
      domain: "shared",
      start: () => {
        const intervalMs = parseInterval(env.COMMERCIAL_COOLDOWN_RECOVERY_INTERVAL_MS, 1000, 60_000);
        const h = trackScheduler("cooldownRecovery", "shared", startPoolRecoveryActor({ intervalMs }));
        return { stop: () => h.stop() };
      },
    });
  }
  if (env.COMMERCIAL_CURSOR_AUTH_SYNC_DISABLED !== "1") {
    leaderBundle.add({
      name: "cursorAuthSync",
      domain: "v5-owned",
      start: () => {
        const intervalMs = parseInterval(env.COMMERCIAL_CURSOR_AUTH_SYNC_INTERVAL_MS, 1000, 60_000);
        const preparation = trackScheduler("cursorAuthSync", "v5-owned", startCursorSandPreparationActor());
        const h = trackScheduler("cursorAuthSync", "v5-owned", startCursorAuthSyncActor({ intervalMs }));
        return { stop: async () => { await Promise.all([h.stop(), preparation.stop()]); } };
      },
    });
  }
  if (env.COMMERCIAL_CURSOR_USAGE_SWEEP_DISABLED !== "1") {
    leaderBundle.add({
      name: "cursorUsageSweep",
      domain: "v5-owned",
      start: () => {
        const intervalMs = parseInterval(env.COMMERCIAL_CURSOR_USAGE_SWEEP_INTERVAL_MS, 60_000, 60 * 60_000);
        const h = trackScheduler("cursorUsageSweep", "v5-owned", startCursorUsageSweeper({ intervalMs }));
        return { stop: () => h.stop() };
      },
    });
  }
  if (env.COMMERCIAL_GROK_USAGE_SWEEP_DISABLED !== "1") {
    leaderBundle.add({
      name: "grokUsageSweep",
      domain: "v5-owned",
      start: () => {
        const intervalMs = parseInterval(env.COMMERCIAL_GROK_USAGE_SWEEP_INTERVAL_MS, 60_000, 60 * 60_000);
        const h = trackScheduler("grokUsageSweep", "v5-owned", startGrokUsageSweeper({ intervalMs }));
        return { stop: () => h.stop() };
      },
    });
  }
  if (shouldStartCommercialScheduler("pendingOrdersExpirer", { flavorIdentity, runtimeChannel, paymentEnabled })) {
    leaderBundle.add({
      name: "pendingOrdersExpirer",
      domain: "shared",
      start: () => {
        const intervalMs = parseInterval(env.COMMERCIAL_PENDING_ORDERS_EXPIRER_INTERVAL_MS, 1000, 60_000);
        const h = trackScheduler("pendingOrdersExpirer", "shared", startPendingOrdersExpirer({ intervalMs }));
        return { stop: () => h.stop() };
      },
    });
  }
}

export interface CoreOpsLeaderMembersDeps {
  env: NodeJS.ProcessEnv;
  cfg: CommercialConfig;
  runtimeChannel: string;
  flavorIdentity: ReturnType<typeof assertFlavorIdentity>;
  paymentEnabled: boolean;
  leaderBundle: LeaderBundle;
  trackScheduler: TrackSchedulerFn;
  mailer: Mailer;
  preCheckRedis: PreCheckRedis;
  boxRemoteCleanup?: BoxRemoteCleanupWorker;
  sessionsStoreGeneration: number;
  recoveryDecisionBroadcastRef: {
    current: (userId: string, sessionId: string, decision: AutomaticRecoveryDecision) => void;
  };
  tapeSchedulerKickRef: { current: () => void };
  settleTapeEngineBilling: (userId: bigint, billing: DurableCodexBilling) => Promise<void>;
  bridgeSecret: string | undefined;
  dispatchAdmissionBackend: DispatchAdmissionBackend | undefined;
  containerLinkOn: boolean;
  userChatBridge: UserChatBridgeHandler;
  setTurnDispatchShutdownHandoff: (fn: () => Promise<unknown>) => void;
  durableCursorBillingDeps: () => Parameters<typeof startCursorAuditReconciler>[0] extends infer T
    ? Omit<T, "pool" | "zeroChargeBefore" | "intervalMs" | "runOnStart">
    : never;
  durableAntigravityBillingDeps: () => Parameters<typeof startAntigravityTurnReconciler>[0] extends infer T
    ? Omit<T, "intervalMs" | "runOnStart">
    : never;
  ensureContainerReady: ((uid: bigint) => Promise<void>) | undefined;
  v4ExecutorDeps: Parameters<typeof startRemoteDriverDriftScheduler>[0]["executorDeps"] | undefined;
}

function registerFinalizeAndLiveFrameMembers(deps: CoreOpsLeaderMembersDeps): void {
  const { env, runtimeChannel, leaderBundle, trackScheduler, preCheckRedis, boxRemoteCleanup } = deps;
  if (boxRemoteCleanup) {
    leaderBundle.add({
      name: "finalizeReconciler",
      domain: "shared",
      start: () => {
        const intervalMs = parseInterval(
          env.COMMERCIAL_FINALIZE_RECONCILER_INTERVAL_MS,
          FINALIZE_RECONCILER_MIN_INTERVAL_MS,
          DEFAULT_RECONCILE_INTERVAL_MS,
        );
        const rawCodexMax = Number(env.CODEX_SESSION_MAX_MS);
        const thresholdMs = resolveStuckThresholdMs(
          env.COMMERCIAL_FINALIZE_RECONCILER_THRESHOLD_MS,
          Number.isFinite(rawCodexMax) ? rawCodexMax : undefined,
        );
        const durableWaiverAgeMs = resolveDurableWaiverAgeMs(
          env.COMMERCIAL_FINALIZE_DURABLE_WAIVER_AGE_MS,
          thresholdMs,
        );
        const h = trackScheduler(
          "finalizeReconciler",
          "shared",
          startFinalizeJournalReconciler({
            intervalMs,
            thresholdMs,
            durableWaiverAgeMs,
            boxRecoveryFn: async () => {
              const results = await Promise.allSettled([
                reconcileBoxBillingBatch(getPool(), 20, preCheckRedis),
                boxRemoteCleanup.reconcileBatch(10),
                recoverRemoteNativeTurnBilling(
                  { pool: getPool(), preCheckRedis, log: rootLogger.child({ subsys: "remoteNativeBillingRecovery" }) },
                  { limit: 20 },
                ),
              ]);
              if (results.some((result) => result.status === "rejected")) {
                throw new Error("BOX_RECOVERY_PARTIAL_FAILURE");
              }
            },
          }),
        );
        return { stop: () => h.stop() };
      },
    });
  }
  if (runtimeChannel === "v5" && !resolveLiveFrameMaintenanceDisabled()) {
    leaderBundle.add({
      name: "liveFrameMaintenance",
      domain: "shared",
      start: () => {
        const h = trackScheduler(
          "liveFrameMaintenance",
          "shared",
          startLiveFrameMaintenanceScheduler({
            pool: getPool(),
            intervalMs: resolveLiveFrameMaintenanceIntervalMs(env.COMMERCIAL_LIVE_FRAME_MAINTENANCE_INTERVAL_MS),
            pruneMaxBatches: resolvePruneMaxBatches(env.COMMERCIAL_LIVE_FRAME_PRUNE_MAX_BATCHES),
            retireMinAgeMs: resolveRetireMinAgeMs(env.COMMERCIAL_LIVE_FRAME_RETIRE_MIN_AGE_MS),
            runOnStart: true,
            onError: (err) =>
              rootLogger.warn("[liveFrameMaintenance] tick failed", {
                err: (err as Error)?.message ?? String(err),
              }),
          }),
        );
        return { stop: () => h.stop() };
      },
    });
  }
}

function registerEngineAuditReconcilers(deps: CoreOpsLeaderMembersDeps): void {
  const { env, cfg, leaderBundle, trackScheduler } = deps;
  if (env.COMMERCIAL_CURSOR_AUDIT_RECONCILER_DISABLED !== "1") {
    leaderBundle.add({
      name: "cursorAuditReconciler",
      domain: "shared",
      start: () => {
        const intervalMs = parseInterval(env.COMMERCIAL_CURSOR_AUDIT_RECONCILER_INTERVAL_MS, 5000, 60_000);
        const zeroChargeBefore =
          parseZeroChargeCutoff(env.COMMERCIAL_CURSOR_AUDIT_BACKFILL_ZERO_CHARGE_BEFORE) ?? new Date();
        const h = trackScheduler(
          "cursorAuditReconciler",
          "shared",
          startCursorAuditReconciler({
            ...deps.durableCursorBillingDeps(),
            pool: getPool(),
            zeroChargeBefore,
            intervalMs,
            runOnStart: true,
          }),
        );
        rootLogger.info("cursorAuditReconciler started", {
          intervalMs,
          zeroChargeBefore: zeroChargeBefore.toISOString(),
        });
        return { stop: () => h.stop() };
      },
    });
  }
  if (!cfg.COMMERCIAL_ANTIGRAVITY_RECONCILER_DISABLED) {
    leaderBundle.add({
      name: "antigravityTurnReconciler",
      domain: "shared",
      start: () => {
        const rawInterval = cfg.COMMERCIAL_ANTIGRAVITY_RECONCILER_INTERVAL_MS;
        const intervalMs = typeof rawInterval === "number" && rawInterval >= 5000 ? rawInterval : 60_000;
        const h = trackScheduler(
          "antigravityTurnReconciler",
          "shared",
          startAntigravityTurnReconciler({ ...deps.durableAntigravityBillingDeps(), intervalMs, runOnStart: true }),
        );
        rootLogger.info("antigravityTurnReconciler started", { intervalMs });
        return { stop: () => h.stop() };
      },
    });
  }
}

function registerTapeDispatchAndEngineReconcilers(deps: CoreOpsLeaderMembersDeps): void {
  const { env, runtimeChannel, leaderBundle, trackScheduler, preCheckRedis } = deps;
  if (runtimeChannel !== "v5") return;
  if (env.COMMERCIAL_TAPE_MATERIALIZATION_DISABLED !== "1") {
    leaderBundle.add({
      name: "tapeJobScheduler",
      domain: "shared",
      start: () => {
        const { materializePool, schedulerOpts } = buildTapeJobSchedulerSetup({
          env,
          sessionsStoreGeneration: deps.sessionsStoreGeneration,
          recoveryDecisionBroadcastRef: deps.recoveryDecisionBroadcastRef,
          settleTapeEngineBilling: deps.settleTapeEngineBilling,
        });
        const h = trackScheduler("tapeJobScheduler", "shared", startTapeJobScheduler(schedulerOpts));
        wireTapeSchedulerKick(deps.tapeSchedulerKickRef, () => h.runNow());
        return {
          stop: async () => {
            deps.tapeSchedulerKickRef.current = () => {
              /* scheduler stopped */
            };
            await h.stop();
            await materializePool.end();
          },
        };
      },
    });
  }
  if (env.COMMERCIAL_TURN_DISPATCH_RECONCILER_DISABLED !== "1") {
    leaderBundle.add({
      name: "turnDispatchReconciler",
      domain: "shared",
      start: () => {
        const { intervalMs, reconcilerDeps } = buildTurnDispatchReconcilerConfig({
          env,
          bridgeSecret: deps.bridgeSecret,
          dispatchAdmissionBackend: deps.dispatchAdmissionBackend,
          containerLinkOn: deps.containerLinkOn,
          preCheckRedis,
          userChatBridge: deps.userChatBridge,
        });
        const h = trackScheduler(
          "turnDispatchReconciler",
          "shared",
          startTurnDispatchReconciler({ ...reconcilerDeps, intervalMs, runOnStart: true }),
        );
        deps.setTurnDispatchShutdownHandoff(() =>
          runShutdownDispatchHandoff({
            ...reconcilerDeps,
            budgetMs: DEFAULT_SHUTDOWN_HANDOFF_BUDGET_MS,
            limit: 8,
          }),
        );
        return { stop: () => h.stop() };
      },
    });
  }
  registerEngineAuditReconcilers(deps);
}

function registerCronSelfhealAndDriftMembers(deps: CoreOpsLeaderMembersDeps): void {
  const { env, runtimeChannel, flavorIdentity, leaderBundle, trackScheduler } = deps;
  if (env.COMMERCIAL_CRON_WAKE_DISABLED !== "1" && deps.ensureContainerReady) {
    const wakeFn = deps.ensureContainerReady;
    leaderBundle.add({
      name: "cronWake",
      domain: "v5-owned",
      start: () => {
        const h = trackScheduler(
          "cronWake",
          "v5-owned",
          startCronWakeScheduler(buildCronWakeSchedulerOptions({ env, wakeFn })),
        );
        return { stop: () => h.stop() };
      },
    });
  }
  if (runtimeChannel === "v5" && env.OC_SELFHEAL_DISABLED !== "1") {
    assertSelfhealConfig();
    leaderBundle.add({
      name: "incidentReconciler",
      domain: "v5-owned",
      start: () => {
        const h: IncidentReconcilerHandle = trackScheduler(
          "incidentReconciler",
          "v5-owned",
          startIncidentReconciler({ intervalMs: selfhealTickMs() }),
        );
        return { stop: () => h.stop() };
      },
    });
    leaderBundle.add({
      name: "incidentSweeper",
      domain: "v5-owned",
      start: () => {
        const h: IncidentSweeperHandle = trackScheduler(
          "incidentSweeper",
          "v5-owned",
          startIncidentSweeper({ intervalMs: selfhealTickMs() }),
        );
        return { stop: () => h.stop() };
      },
    });
  }
  if (runtimeChannel === "v5" && env.OC_CONNECTOR_SWEEPER_DISABLED !== "1") {
    leaderBundle.add({
      name: "connectorSweeper",
      domain: "v5-owned",
      start: async () => {
        const intervalMs = parseInterval(env.OC_CONNECTOR_SWEEPER_INTERVAL_MS, 5_000, 60_000);
        const h = trackScheduler("connectorSweeper", "v5-owned", startConnectorSweeper({ intervalMs }));
        return { stop: () => h.stop() };
      },
    });
  }
  if (
    runtimeChannel === "v5" &&
    flavorIdentity.status === "ok" &&
    flavorIdentity.flavor === "selfhost" &&
    deps.v4ExecutorDeps &&
    env.OC_REMOTE_DRIVER_DRIFT_DISABLED !== "1"
  ) {
    const executorDeps = deps.v4ExecutorDeps;
    leaderBundle.add({
      name: "remoteDriverDrift",
      domain: "v5-owned",
      start: () => {
        const h = trackScheduler(
          "remoteDriverDrift",
          "v5-owned",
          startRemoteDriverDriftScheduler({
            pool: getPool(),
            executorDeps,
            log: rootLogger.child({ subsys: "remoteDriverDrift" }),
          }),
        );
        return { stop: () => h.stop() };
      },
    });
  }
}

export function registerCoreOpsLeaderMembers(deps: CoreOpsLeaderMembersDeps): void {
  registerAlertAndAuditMembers({
    env: deps.env,
    leaderBundle: deps.leaderBundle,
    trackScheduler: deps.trackScheduler,
    mailer: deps.mailer,
  });
  registerPoolAndOrdersMembers({
    env: deps.env,
    runtimeChannel: deps.runtimeChannel,
    flavorIdentity: deps.flavorIdentity,
    paymentEnabled: deps.paymentEnabled,
    leaderBundle: deps.leaderBundle,
    trackScheduler: deps.trackScheduler,
  });
  registerFinalizeAndLiveFrameMembers(deps);
  registerTapeDispatchAndEngineReconcilers(deps);
  registerCronSelfhealAndDriftMembers(deps);
}
