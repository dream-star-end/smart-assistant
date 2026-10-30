/**
 * Leader-only tape materialization + settlement scheduler.
 * stop() waits for the in-flight tick (blocker 6). Does not copy
 * liveFrameMaintenanceScheduler's fire-and-forget stop.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { EVENTS } from "../admin/alertEvents.js";
import { enqueueAlert } from "../admin/alertOutbox.js";
import {
  claimDueMaterializationJobs,
  claimDueSettlementJobs,
  completeMaterializationJob,
  completeSettlementJob,
  failOrRequeueMaterializationJob,
  failOrRequeueSettlementJob,
  listTapeJobAlertCandidates,
  renewMaterializationLease,
  type MaterializationJob,
  type SettlementJob,
} from "./turnTapeJobs.js";

export const DEFAULT_INTERVAL_MS = 5_000;
export const MIN_INTERVAL_MS = 1_000;
export const ALERT_SCAN_INTERVAL_MS = 60_000;

export interface TapeJobSchedulerDeps {
  pool: Pool;
  materializePool?: Pool;
  ownerId?: string;
  intervalMs?: number;
  runOnStart?: boolean;
  onError?: (err: unknown) => void;
  materializeTape?: (job: MaterializationJob, renew: () => Promise<void>) => Promise<void>;
  settleJob?: (job: SettlementJob) => Promise<void>;
  _deps?: { enqueueAlert?: typeof enqueueAlert; now?: () => number };
}

export interface TapeJobSchedulerHandle {
  stop(): Promise<void>;
  runNow(): Promise<void>;
}

export function startTapeJobScheduler(deps: TapeJobSchedulerDeps): TapeJobSchedulerHandle {
  const interval = Math.max(MIN_INTERVAL_MS, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  const ownerId = deps.ownerId ?? `tape-jobs:${randomUUID()}`;
  const onError = deps.onError ?? ((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("[tapeJobScheduler] tick failed", err);
  });
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  const enqueue = deps._deps?.enqueueAlert ?? enqueueAlert;
  const now = deps._deps?.now ?? Date.now;
  let nextAlertScanAt = 0;

  async function scanAlerts(): Promise<void> {
    if (now() < nextAlertScanAt) return;
    try {
      const candidates = await listTapeJobAlertCandidates(deps.pool);
      const day = new Date(now()).toISOString().slice(0, 10);
      for (const job of candidates) {
        try {
          await enqueue({
            event_type: EVENTS.OPS_TAPE_JOB_STUCK,
            severity: "warning",
            dedupe_key: `${EVENTS.OPS_TAPE_JOB_STUCK}:${job.job_id}:${day}`,
            dedupe_all_statuses: true,
            title: "turn_tape 作业需要检查",
            body: `session=${job.session_id} tape=${job.tape_id.slice(0, 12)} attempt=${job.attempt} error_class=${job.error_class}`,
          });
        } catch (err) {
          onError(err);
        }
      }
      nextAlertScanAt = now() + ALERT_SCAN_INTERVAL_MS;
    } catch (err) {
      onError(err);
    }
  }

  async function failMaterialization(job: MaterializationJob, message: string): Promise<void> {
    if (await failOrRequeueMaterializationJob(deps.pool, job, message) === "failed") nextAlertScanAt = 0;
  }

  async function failSettlement(job: SettlementJob, message: string): Promise<void> {
    if (await failOrRequeueSettlementJob(deps.pool, job, message) === "failed") nextAlertScanAt = 0;
  }

  async function runJobs(): Promise<void> {
    const matJobs = await claimDueMaterializationJobs(deps.pool, { ownerId, limit: 1 });
    for (const job of matJobs) {
      try {
        if (!deps.materializeTape) {
          await failMaterialization(job, "materializeTape hook missing");
          continue;
        }
        await deps.materializeTape(job, async () => {
          const held = await renewMaterializationLease(deps.pool, job);
          if (!held) throw new Error("materialization lease lost");
        });
        const done = await completeMaterializationJob(deps.pool, job);
        if (!done) onError(new Error(`materialization complete lost fencing ${job.jobId}`));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await failMaterialization(job, message);
        onError(err);
      }
    }
    const settleJobs = await claimDueSettlementJobs(deps.pool, { ownerId, limit: 4 });
    for (const job of settleJobs) {
      try {
        if (!deps.settleJob) {
          await failSettlement(job, "settleJob hook missing");
          continue;
        }
        await deps.settleJob(job);
        const done = await completeSettlementJob(deps.pool, job);
        if (!done) onError(new Error(`settlement complete lost fencing ${job.jobId}`));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await failSettlement(job, message);
        onError(err);
      }
    }
  }

  async function runOneTick(): Promise<void> {
    try {
      await runJobs();
    } finally {
      await scanAlerts();
    }
  }

  function scheduleTick(): void {
    if (stopped) return;
    inFlight = inFlight
      .catch(() => undefined)
      .then(async () => {
        if (stopped) return;
        try {
          await runOneTick();
        } catch (err) {
          onError(err);
        }
      });
  }

  const timer = setInterval(scheduleTick, interval);
  if (typeof timer.unref === "function") timer.unref();
  if (deps.runOnStart) scheduleTick();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight.catch(() => undefined);
    },
    async runNow() {
      inFlight = inFlight.catch(() => undefined).then(runOneTick);
      await inFlight;
    },
  };
}
