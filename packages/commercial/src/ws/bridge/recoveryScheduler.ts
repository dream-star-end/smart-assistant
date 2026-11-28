import {
  claimDueRecoveryJobs,
  listDueRecoveryCarrierContainers,
  releaseRecoveryForTransportWait,
  type ClaimedRecoveryJob,
} from "../../dispatch/turnRecoveryStore.js";
import { availableExecutors } from "../bridgeExecutorRegistration.js";
import { boundedMapSet, pruneTimestampMap } from "../outboundFrameDecode.js";
import { RECOVERY_LEASE_MS } from "./constants.js";
import type { BridgeSharedState } from "./types.js";

const DUE_RECOVERY_USERS_SQL = `SELECT user_id
           FROM (
             SELECT candidate.user_id::text AS user_id, MIN(candidate.next_attempt_at) AS earliest_due
               FROM turn_recovery_jobs candidate
              WHERE candidate.next_attempt_at<=NOW()
                AND (
                  (candidate.status IN ('queued','leased') AND candidate.dispatch_id IS NULL
                    AND (candidate.status='queued' OR candidate.lease_until<NOW()))
                  OR (candidate.user_id = ANY($1::bigint[])
                    AND candidate.status IN ('queued','leased','sent')
                    AND (candidate.status='queued' OR candidate.lease_until<NOW())
                    AND NOT EXISTS (
                      SELECT 1 FROM turn_dispatches bound
                       WHERE bound.dispatch_id=candidate.dispatch_id
                         AND bound.attempt_no=candidate.dispatch_attempt_no
                         AND bound.status<>'admitted'
                    ))
                )
              GROUP BY candidate.user_id
              ORDER BY earliest_due ASC
              LIMIT 20
           ) due_users`;

async function wakeRecoveryCarriersForUser(
  shared: BridgeSharedState,
  uid: bigint,
  key: string,
  epoch: number,
): Promise<void> {
  if (!shared.recovery || !shared.links || !shared.deps.pgPool) return;
  try {
    const channel = shared.deps.containerLinkRecovery?.channel ?? "v5";
    const carriers = await listDueRecoveryCarrierContainers(shared.deps.pgPool, uid, channel);
    if (!shared.isBackgroundCurrent(epoch)) return;
    for (const row of carriers) {
      if (!shared.isBackgroundCurrent(epoch)) return;
      if (shared.links.retainKeepAliveConsumer(uid, row.container_id)) continue;
      void shared.recovery
        .wake({ uid: key, containerId: row.container_id })
        .then(() => {
          const live = availableExecutors(shared.uidToRecoveryExecutors.get(key));
          if (shared.isBackgroundCurrent(epoch) && live.length > 0) {
            void shared.drainDurableRecoveryForUser(uid);
          }
        })
        .catch((wakeErr) => {
          if (shared.isBackgroundCurrent(epoch)) {
            shared.log?.warn("user-chat-bridge: durable recovery carrier wake failed", {
              uid: key,
              error: wakeErr,
            });
          }
        });
    }
  } catch (wakeErr) {
    if (shared.isBackgroundCurrent(epoch)) {
      shared.log?.warn("user-chat-bridge: durable recovery carrier lookup failed", {
        uid: key,
        error: wakeErr,
      });
    }
  }
}

async function releaseJobsForTransportWait(
  shared: BridgeSharedState,
  jobs: ClaimedRecoveryJob[],
): Promise<void> {
  const pool = shared.deps.pgPool;
  if (!pool) return;
  for (const job of jobs) {
    await releaseRecoveryForTransportWait(pool, job).catch((err) => {
      void err;
    });
  }
}

async function dispatchClaimedRecoveryJobs(
  shared: BridgeSharedState,
  jobs: ClaimedRecoveryJob[],
  key: string,
  epoch: number,
): Promise<void> {
  const pool = shared.deps.pgPool;
  if (!pool) return;
  for (const job of jobs) {
    if (!shared.isBackgroundCurrent(epoch)) {
      await releaseRecoveryForTransportWait(pool, job).catch((err) => {
        void err;
      });
      continue;
    }
    const liveExecutor = availableExecutors(shared.uidToRecoveryExecutors.get(key))[0];
    if (!liveExecutor) {
      await releaseRecoveryForTransportWait(pool, job);
      continue;
    }
    try {
      shared.recoveryJobEpochs.set(job, epoch);
      liveExecutor(job, epoch);
    } catch (err) {
      void err;
      await releaseRecoveryForTransportWait(pool, job);
    }
  }
}

async function runSingleRecoveryDrainPass(
  shared: BridgeSharedState,
  uid: bigint,
  key: string,
  epoch: number,
): Promise<void> {
  if (!shared.deps.pgPool || !shared.isBackgroundCurrent(epoch)) return;
  const lastScanAt = shared.recoveryLastScanAt.get(key) ?? 0;
  const nowMs = Date.now();
  if (shared.deps.reconcileAutomaticRecoveryJobs && nowMs - lastScanAt >= 30_000) {
    boundedMapSet(shared.recoveryLastScanAt, key, nowMs, 4096);
    if (shared.recoveryLastScanAt.size > 1024) {
      pruneTimestampMap(shared.recoveryLastScanAt, nowMs, 5 * 60_000, 4096);
    }
    await shared.deps.reconcileAutomaticRecoveryJobs(uid, 100);
    if (!shared.isBackgroundCurrent(epoch)) return;
  }
  let executor = availableExecutors(shared.uidToRecoveryExecutors.get(key))[0];
  if (!executor) {
    await wakeRecoveryCarriersForUser(shared, uid, key, epoch);
    if (!shared.isBackgroundCurrent(epoch)) return;
    executor = availableExecutors(shared.uidToRecoveryExecutors.get(key))[0];
    if (!executor) return;
  }
  const jobs = await claimDueRecoveryJobs(shared.deps.pgPool, {
    userId: uid,
    ownerId: shared.recoveryLeaseOwner,
    leaseMs: RECOVERY_LEASE_MS,
  });
  if (!shared.isBackgroundCurrent(epoch)) {
    await releaseJobsForTransportWait(shared, jobs);
    return;
  }
  await dispatchClaimedRecoveryJobs(shared, jobs, key, epoch);
}

export function drainDurableRecoveryForUser(
  shared: BridgeSharedState,
  uid: bigint,
): Promise<void> {
  if (!shared.deps.pgPool || shared.shuttingDown || !shared.backgroundActive) {
    return Promise.resolve();
  }
  const epoch = shared.backgroundEpoch;
  const key = uid.toString();
  const existing = shared.recoveryDrainInFlight.get(key);
  if (existing) {
    shared.recoveryDrainNeedsRerun.add(key);
    return existing;
  }
  const work = (async () => {
    do {
      shared.recoveryDrainNeedsRerun.delete(key);
      try {
        await runSingleRecoveryDrainPass(shared, uid, key, epoch);
      } catch (error) {
        if (shared.isBackgroundCurrent(epoch)) {
          shared.log?.warn("user-chat-bridge: durable recovery drain failed", { uid: key, error });
        }
      }
    } while (shared.recoveryDrainNeedsRerun.has(key) && shared.isBackgroundCurrent(epoch));
  })().finally(() => {
    shared.recoveryDrainInFlight.delete(key);
    shared.recoveryDrainNeedsRerun.delete(key);
  });
  shared.recoveryDrainInFlight.set(key, work);
  return work;
}

export function startRecoveryDrainTimer(shared: BridgeSharedState): NodeJS.Timeout {
  const timer = setInterval(() => {
    if (!shared.backgroundActive || shared.shuttingDown || !shared.deps.pgPool) return;
    const nowMs = Date.now();
    if (nowMs - shared.lastOnlineReconcileSweepAt >= 30_000) {
      shared.lastOnlineReconcileSweepAt = nowMs;
      for (const uidKey of shared.uidToRecoveryExecutors.keys()) {
        void shared.drainDurableRecoveryForUser(BigInt(uidKey));
      }
    }
    if (shared.recoveryPollInFlight) return;
    shared.recoveryPollInFlight = true;
    const onlineUids = Array.from(shared.uidToRecoveryExecutors.keys());
    void shared.deps.pgPool
      .query<{ user_id: string }>(DUE_RECOVERY_USERS_SQL, [onlineUids])
      .then((res) => {
        for (const row of res.rows ?? []) {
          if (shared.uidToRecoveryExecutors.has(row.user_id) || (shared.recovery && shared.links)) {
            void shared.drainDurableRecoveryForUser(BigInt(row.user_id));
          }
        }
      })
      .catch((error) => {
        shared.log?.warn("user-chat-bridge: durable recovery poll failed", { error });
      })
      .finally(() => {
        shared.recoveryPollInFlight = false;
      });
  }, 1_000);
  timer.unref?.();
  return timer;
}

export async function setBackgroundRoleActive(
  shared: BridgeSharedState,
  active: boolean,
): Promise<void> {
  if (active) {
    shared.backgroundEpoch += 1;
    shared.backgroundActive = true;
    await Promise.allSettled([
      shared.controls?.setActive(true),
      shared.recovery?.setActive(true),
    ]);
    return;
  }
  shared.backgroundActive = false;
  shared.backgroundEpoch += 1;
  shared.links?.releaseInactiveLinks();
  await Promise.allSettled([
    shared.controls?.setActive(false),
    shared.recovery?.setActive(false),
    ...shared.recoveryDrainInFlight.values(),
  ]);
  while (shared.recoveryExecutionInFlight.size > 0) {
    await Promise.allSettled([...shared.recoveryExecutionInFlight.values()]);
  }
}
