import type { PricingCache } from "../billing/pricing.js";
import {
  INITIAL_SWEEP_BATCH_LIMIT,
  startIdleSweepScheduler,
  startMigrationReconcileScheduler,
  startOrphanReconcileScheduler,
  startV3ContainerEventsWorker,
  startVolumeGcScheduler,
  type V3SupervisorDeps,
} from "../agent-sandbox/index.js";
import { getHealthPoller } from "../compute-pool/nodeHealth.js";
import { getPool } from "../db/index.js";
import { startDesiredWatch, type DesiredWatch, type Slot } from "../deploy/deployState.js";
import { createLeaderBundle, type LeaderBundle } from "../deploy/leaderBundle.js";
import {
  createLeaderLeaseController,
  resolveLeaderEnvEligibility,
  type LeaderLeaseController,
  type LeadershipStatus,
} from "../deploy/leaderLease.js";
import { rootLogger } from "../logging/logger.js";
import { makeCommercialRuntimeStatus, type CommercialRuntimeStatus } from "../runtimeStatus.js";
import type { UserChatBridgeHandler } from "../ws/userChatBridge.js";

export type MutatorDomain = "shared" | "v5-owned" | "local";

export type TrackSchedulerFn = <T>(name: string, domain: MutatorDomain, handle: T) => T;

export function parseSchedulerIntervalMs(
  rawValue: string | undefined,
  minMs: number,
  fallbackMs: number,
): number {
  const raw = Number(rawValue);
  return Number.isFinite(raw) && raw >= minMs ? raw : fallbackMs;
}

export interface SchedulerRegistryEntry {
  name: string;
  domain: MutatorDomain;
}

export function createDualMasterLeadership(args: {
  env: NodeJS.ProcessEnv;
  runtimeChannel: string;
  unregisterMutator: (name: string) => void;
  getSeedPlatformAgentsForLeadership: () => () => Promise<void>;
  getCronOriginBridge: () => UserChatBridgeHandler | null;
  onFatalExit: () => void;
}): {
  ocSlot: Slot;
  dualMasterEnabled: boolean;
  leaderBundle: LeaderBundle;
  deployDesiredWatch: DesiredWatch | undefined;
  leaderLease: LeaderLeaseController | undefined;
} {
  const ocSlotRaw = args.env.OC_SLOT?.trim() || "A";
  if (ocSlotRaw !== "A" && ocSlotRaw !== "B") {
    throw new Error(
      `[commercial] OC_SLOT 必须是 'A'|'B'(当前=${JSON.stringify(args.env.OC_SLOT)}),拒起`,
    );
  }
  const ocSlot: Slot = ocSlotRaw;
  const dualMasterEnabled = args.runtimeChannel === "v5";
  const leaderBundle: LeaderBundle = createLeaderBundle({
    onMemberStopped: (name) => args.unregisterMutator(name),
    onError: (ctx, err) =>
      rootLogger.warn(`[leaderBundle] ${ctx}`, {
        err: (err as Error)?.message ?? String(err),
      }),
    logger: {
      info: (m) => rootLogger.info(m, { subsys: "leaderBundle" }),
      warn: (m, meta) => rootLogger.warn(m, { subsys: "leaderBundle", meta }),
    },
  });

  if (!dualMasterEnabled) {
    return {
      ocSlot,
      dualMasterEnabled,
      leaderBundle,
      deployDesiredWatch: undefined,
      leaderLease: undefined,
    };
  }

  const deployDesiredWatch = startDesiredWatch({
    pool: getPool(),
    onError: (err) =>
      rootLogger.warn("[deployDesiredWatch] poll 失败(保留旧缓存)", {
        err: (err as Error)?.message ?? String(err),
      }),
  });
  const eligibleEnv = resolveLeaderEnvEligibility(args.env);
  const leaderLease = createLeaderLeaseController({
    pool: getPool(),
    slot: ocSlot,
    desiredWatch: deployDesiredWatch,
    eligibleEnv,
    callbacks: {
      onAcquire: async () => {
        await leaderBundle.start();
        await args.getSeedPlatformAgentsForLeadership()();
        await args.getCronOriginBridge()?.setBackgroundRoleActive?.(true);
      },
      onFence: async (reason) => {
        rootLogger.warn(`[leaderLease] fence → stopAndDrain bundle(${reason})`, {
          subsys: "leaderLease",
        });
        await args.getCronOriginBridge()?.setBackgroundRoleActive?.(false);
        return leaderBundle.stopAndDrain();
      },
    },
    onFatal: (reason, detail) => {
      rootLogger.error(`[leaderLease] FAIL-STOP: ${reason}`, {
        subsys: "leaderLease",
        detail: (detail as Error)?.message ?? detail,
      });
      args.onFatalExit();
    },
    logger: {
      info: (m, meta) => rootLogger.info(m, { subsys: "leaderLease", meta }),
      warn: (m, meta) => rootLogger.warn(m, { subsys: "leaderLease", meta }),
      error: (m, meta) => rootLogger.error(m, { subsys: "leaderLease", meta }),
    },
  });

  return {
    ocSlot,
    dualMasterEnabled,
    leaderBundle,
    deployDesiredWatch,
    leaderLease,
  };
}

function registerContainerSweepAndGcMembers(
  env: NodeJS.ProcessEnv,
  leaderBundle: LeaderBundle,
  trackScheduler: TrackSchedulerFn,
  v3Deps: V3SupervisorDeps,
): void {
  if (env.OC_IDLE_SWEEP_DISABLED !== "1") {
    leaderBundle.add({
      name: "idleSweep",
      domain: "shared",
      start: () => {
        const log = rootLogger.child({ subsys: "v3/idleSweep" });
        const h = trackScheduler(
          "idleSweep",
          "shared",
          startIdleSweepScheduler(v3Deps, {
            logger: log,
            runOnStart: false,
            batchLimit: INITIAL_SWEEP_BATCH_LIMIT,
          }),
        );
        log.info("scheduler started", { tickSec: 60, idleCutoffMin: 30, batchLimit: INITIAL_SWEEP_BATCH_LIMIT });
        return { stop: () => h.stop() };
      },
    });
  }
  if (env.OC_VOLUME_GC_DISABLED !== "1") {
    leaderBundle.add({
      name: "volumeGc",
      domain: "shared",
      start: () => {
        const log = rootLogger.child({ subsys: "v3/volumeGc" });
        const h = trackScheduler(
          "volumeGc",
          "shared",
          startVolumeGcScheduler(v3Deps, { logger: log, runOnStart: false }),
        );
        log.info("scheduler started", { tickSec: 3600, bannedDays: 7, noLoginDays: 90 });
        return { stop: () => h.stop() };
      },
    });
  }
  if (env.OC_ORPHAN_RECONCILE_DISABLED !== "1") {
    leaderBundle.add({
      name: "orphanReconcile",
      domain: "v5-owned",
      start: () => {
        const log = rootLogger.child({ subsys: "v3/orphanReconcile" });
        const h = trackScheduler(
          "orphanReconcile",
          "v5-owned",
          startOrphanReconcileScheduler(v3Deps, { logger: log }),
        );
        log.info("scheduler started", { tickSec: 3600, runOnStart: true });
        return { stop: () => h.stop() };
      },
    });
  }
}

function registerContainerHealthAndEventsMembers(
  env: NodeJS.ProcessEnv,
  leaderBundle: LeaderBundle,
  trackScheduler: TrackSchedulerFn,
  v3Deps: V3SupervisorDeps,
): void {
  if (env.OC_MIGRATION_RECONCILER_DISABLED !== "1") {
    leaderBundle.add({
      name: "migrationReconcile",
      domain: "shared",
      start: () => {
        const log = rootLogger.child({ subsys: "v3/migrationReconciler" });
        const h = trackScheduler(
          "migrationReconcile",
          "shared",
          startMigrationReconcileScheduler(v3Deps, { logger: log }),
        );
        log.info("scheduler started", { tickSec: 60, staleSec: 600, runOnStart: true });
        return { stop: () => h.stop() };
      },
    });
  }
  if (env.OC_HEALTH_POLLER_DISABLED !== "1") {
    leaderBundle.add({
      name: "healthPoller",
      domain: "shared",
      start: () => {
        const hp = trackScheduler("healthPoller", "shared", getHealthPoller());
        hp.start();
        rootLogger.child({ subsys: "node-health" }).info("scheduler started", { intervalMs: 30_000 });
        return { stop: () => hp.stop() };
      },
    });
  }
  if (env.OC_CONTAINER_EVENTS_DISABLED !== "1") {
    leaderBundle.add({
      name: "containerEvents",
      domain: "shared",
      start: () => {
        const eventsLog = rootLogger.child({ subsys: "v3/containerEvents" });
        const h = trackScheduler(
          "containerEvents",
          "shared",
          startV3ContainerEventsWorker({
            docker: v3Deps.docker,
            logger: {
              debug: (m, meta) => eventsLog.debug(m, meta),
              info: (m, meta) => eventsLog.info(m, meta),
              warn: (m, meta) => eventsLog.warn(m, meta),
              error: (m, meta) => eventsLog.error(m, meta),
            },
          }),
        );
        eventsLog.info("v3 container events worker started (oom/die -> alerts)");
        return { stop: () => h.stop() };
      },
    });
  }
}

export function registerContainerPlaneLeaderMembers(args: {
  env: NodeJS.ProcessEnv;
  leaderBundle: LeaderBundle;
  trackScheduler: TrackSchedulerFn;
  pricing: PricingCache;
  v3Deps: V3SupervisorDeps | undefined;
  cursorExternalOutbox:
    | {
        startScanner: (opts: {
          pool: ReturnType<typeof getPool>;
          pricing: PricingCache;
          logger: ReturnType<typeof rootLogger.child>;
        }) => { stop: () => Promise<void> | void };
      }
    | undefined;
}): void {
  const { env, leaderBundle, trackScheduler, pricing, v3Deps, cursorExternalOutbox } = args;
  if (cursorExternalOutbox) {
    leaderBundle.add({
      name: "cursorExternalApiOutbox",
      domain: "v5-owned",
      required: false,
      start: () => {
        const h = trackScheduler(
          "cursorExternalApiOutbox",
          "v5-owned",
          cursorExternalOutbox.startScanner({
            pool: getPool(),
            pricing,
            logger: rootLogger.child({ subsys: "cursorExternalApiOutbox" }),
          }),
        );
        return { stop: () => h.stop() };
      },
    });
  }
  if (!v3Deps) return;
  registerContainerSweepAndGcMembers(env, leaderBundle, trackScheduler, v3Deps);
  registerContainerHealthAndEventsMembers(env, leaderBundle, trackScheduler, v3Deps);
}

export async function finalizeLeadershipAndRuntimeStatus(args: {
  runtimeChannel: string;
  controlPlaneEnabled: boolean;
  autoMigrateEffective: boolean;
  ocSlot: Slot;
  dualMasterEnabled: boolean;
  agentRuntimeEnabled: boolean;
  containerRuntimeEnabled: boolean;
  schedulerRegistry: readonly SchedulerRegistryEntry[];
  leaderLease: LeaderLeaseController | undefined;
  leaderBundle: LeaderBundle;
  seedPlatformAgentsForLeadership: () => Promise<void>;
}): Promise<CommercialRuntimeStatus> {
  const legacyLeadership = (): LeadershipStatus => ({
    state: args.controlPlaneEnabled ? "leader" : "ineligible",
    slot: args.ocSlot,
    generation: null,
    leasePid: args.controlPlaneEnabled ? process.pid : null,
  });
  const runtimeStatus = makeCommercialRuntimeStatus({
    channel: args.runtimeChannel,
    controlPlaneEnabled: args.controlPlaneEnabled,
    autoMigrate: args.autoMigrateEffective,
    agentRuntime: args.agentRuntimeEnabled ? "enabled" : "disabled",
    containerRuntime: args.containerRuntimeEnabled ? "enabled" : "disabled",
    schedulers: () => args.schedulerRegistry.map((s) => s.name),
    leadership: () => (args.leaderLease ? args.leaderLease.status() : legacyLeadership()),
  });

  const liveLeader = args.leaderLease
    ? args.leaderLease.status().state === "leader"
    : args.controlPlaneEnabled;
  const eagerResidual = args.leaderLease
    ? new Set(["lifecycle", "imagePromote"])
    : new Set<string>();
  const sharedOnFollower = args.schedulerRegistry
    .filter((s) => s.domain === "shared" && !eagerResidual.has(s.name))
    .map((s) => s.name);
  if (!liveLeader && sharedOnFollower.length > 0) {
    throw new Error(
      `[commercial] control-plane invariant violated: 非 leader(leadership=${
        args.leaderLease ? args.leaderLease.status().state : `env:${args.controlPlaneEnabled}`
      })却有 shared-domain 调度器在册=[${sharedOnFollower.join(",")}]。非 leader 只允许 v5-owned/local 域 mutator。`,
    );
  }
  rootLogger.info(
    `commercial runtime status: channel=${args.runtimeChannel} controlPlane=${args.controlPlaneEnabled} slot=${args.ocSlot} dualMaster=${args.dualMasterEnabled} agentRuntime=${runtimeStatus.agentRuntime} containerRuntime=${runtimeStatus.containerRuntime} schedulers=[${runtimeStatus.schedulers.join(",")}]`,
    { subsys: "commercial", runtimeStatus },
  );

  if (args.dualMasterEnabled) {
    args.leaderLease!.start();
  } else if (args.controlPlaneEnabled) {
    await args.leaderBundle.start();
    await args.seedPlatformAgentsForLeadership();
  }
  return runtimeStatus;
}
