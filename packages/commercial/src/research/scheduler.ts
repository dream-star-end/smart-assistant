/**
 * 科研 durable job worker scheduler。
 *
 * 设计权威:docs/research-agent/IMPLEMENTATION_PLAN.md §2。仿 inbox/email.ts:
 *   - 启动时一次 recoverStale(running 且 locked_at<NOW-staleMs → interrupted,不重发)。
 *   - 每 intervalMs:claimNextJob(batch)→ 按 kind 派发 handler → complete/fail。
 *   - 单进程 inflight guard 防 tick 重叠;跨进程靠 store.claimNextJob 的 advisory
 *     lock + FOR UPDATE SKIP LOCKED 双保险。
 *
 * 门控:本 scheduler **必须**只在 master control-plane(controlPlaneEnabled=true,
 * 即 runtimeChannel='v3')启动 —— v5 follower 下 commercial/index.ts 不调
 * startResearchJobScheduler,且 enabledSchedulers 非空会触发 P0 CRASH(纵深兜底)。
 *
 * handler 注入(DI seam):Phase 0 wiring 传空/部分 handler;Phase 1/2 逐步补
 * ingest/index/cite_check/lit_search/render 的真实 handler。未注册 kind 的 job →
 * 标 failed(clear error,可观测),不无限 spin。
 */

import type { ResearchJobKind, ResearchPhase } from "@openclaude/protocol/research";
import {
  type ResearchJobRow,
  claimNextJob,
  completeJob,
  failJob,
  recordCheckpoint,
  recoverStale,
  transitionPhase,
} from "./store.js";

// ─── 常量 ────────────────────────────────────────────────────────────

export const DEFAULT_INTERVAL_MS = 5_000;
export const MIN_INTERVAL_MS = 2_000;
export const DEFAULT_BATCH_SIZE = 8;
/** running → interrupted 阈值:科研 op 上限 ~ 多分钟;30min 远超合理,几乎只可能是崩溃。 */
export const STALE_RUNNING_MS = 30 * 60_000;

// ─── handler 契约 ────────────────────────────────────────────────────

/** handler 用的辅助上下文,绑定到具体 job(进度/相位 checkpoint)。 */
export interface JobHandlerCtx {
  /** 更新 job 当前相位(进度展示)。 */
  setPhase(phase: ResearchPhase): Promise<void>;
  /** 落相位 checkpoint(可恢复)。 */
  checkpoint(
    phase: ResearchPhase,
    status: "pending" | "completed" | "failed",
    output?: unknown,
    error?: string,
  ): Promise<void>;
}

/** 单个 job handler:返回值写入 job.result。抛错 → job 标 failed。 */
export type JobHandler = (job: ResearchJobRow, ctx: JobHandlerCtx) => Promise<unknown>;

export type JobHandlerMap = Partial<Record<ResearchJobKind, JobHandler>>;

// ─── drain ───────────────────────────────────────────────────────────

export interface DrainResult {
  ran: boolean;
  picked: number;
  completed: number;
  failed: number;
  skipReason?: "empty" | "lock-busy";
}

export interface DrainOptions {
  handlers: JobHandlerMap;
  batchSize?: number;
  onError?: (err: unknown, job?: ResearchJobRow) => void;
}

function makeCtx(jobId: string): JobHandlerCtx {
  return {
    setPhase: (phase) => transitionPhase(jobId, phase),
    checkpoint: async (phase, status, output, error) => {
      // 丢弃 recordCheckpoint 的 boolean(写入成功与否对 handler 透明;
      // guard 失败=job 已非 running,handler 无需感知)。
      await recordCheckpoint(jobId, phase, status, output, error);
    },
  };
}

export async function drainResearchJobs(opts: DrainOptions): Promise<DrainResult> {
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
  const onError = opts.onError ?? defaultOnError;

  const picked = await claimNextJob(batchSize);
  if (picked.length === 0) {
    return { ran: false, picked: 0, completed: 0, failed: 0, skipReason: "empty" };
  }

  let completed = 0;
  let failed = 0;

  for (const job of picked) {
    const handler = opts.handlers[job.kind];
    if (!handler) {
      // 未注册 handler(Phase 未接线 / 误配)→ 标 failed,不让 job 永久卡 running。
      if (await failJob(job.id, `no handler registered for kind=${job.kind}`)) failed++;
      continue;
    }
    try {
      const result = await handler(job, makeCtx(job.id));
      if (await completeJob(job.id, result)) completed++;
    } catch (err) {
      onError(err, job);
      if (await failJob(job.id, err)) failed++;
    }
  }

  return { ran: true, picked: picked.length, completed, failed };
}

function defaultOnError(err: unknown, job?: ResearchJobRow): void {
  // eslint-disable-next-line no-console
  console.warn(`[research/scheduler] job ${job?.id ?? "?"} (${job?.kind ?? "?"}) failed:`, err);
}

// ─── scheduler ───────────────────────────────────────────────────────

export interface ResearchJobSchedulerHandle {
  stop(): void;
  /** 测试 / 触发用:立即跑一次 drain。 */
  runNow(): Promise<DrainResult>;
}

export interface ResearchJobSchedulerOptions {
  handlers: JobHandlerMap;
  intervalMs?: number;
  batchSize?: number;
  /** 启动时跑一次 stale cleanup;默认 true。 */
  runStaleCleanupOnStart?: boolean;
  staleMs?: number;
  onError?: (err: unknown, job?: ResearchJobRow) => void;
}

/**
 * 启动科研 job worker。**只应在 controlPlaneEnabled 时由 commercial/index.ts 调用。**
 */
export function startResearchJobScheduler(
  opts: ResearchJobSchedulerOptions,
): ResearchJobSchedulerHandle {
  const interval = Math.max(MIN_INTERVAL_MS, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const onError = opts.onError ?? defaultOnError;
  const staleMs = Math.max(60_000, opts.staleMs ?? STALE_RUNNING_MS);
  const runStaleOnStart = opts.runStaleCleanupOnStart !== false;
  let stopped = false;
  let inflight = false;

  async function tickOnce(): Promise<DrainResult> {
    if (inflight) {
      return { ran: false, picked: 0, completed: 0, failed: 0, skipReason: "lock-busy" };
    }
    inflight = true;
    try {
      return await drainResearchJobs({
        handlers: opts.handlers,
        batchSize: opts.batchSize,
        onError,
      });
    } catch (err) {
      onError(err);
      return { ran: false, picked: 0, completed: 0, failed: 0, skipReason: "empty" };
    } finally {
      inflight = false;
    }
  }

  if (runStaleOnStart) {
    void (async () => {
      try {
        await recoverStale(staleMs);
      } catch (err) {
        onError(err);
      }
    })();
  }

  const timer = setInterval(() => {
    if (stopped) return;
    void tickOnce();
  }, interval);
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    runNow: tickOnce,
  };
}
