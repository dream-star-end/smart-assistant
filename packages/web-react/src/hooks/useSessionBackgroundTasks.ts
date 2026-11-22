import type { SwarmSnapshot } from "@openclaude/protocol/browser";
import type { MediaGenerationJob } from "@openclaude/protocol/mediaGeneration";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { latestSwarmSnapshot } from "../components/chat/swarmDetect";
import type { MediaJobWire } from "../lib/chat/frames";
import type { ChatMessage } from "../lib/chat/model";
import {
  cancelMediaGenerationJob,
  cancelSessionBgCommand,
  cancelSessionMuseJob,
  deleteSessionCronJob,
  fetchSessionBackgroundTasksResult,
  filterSessionMediaJobs,
  isTerminalMediaJobStatus,
  isTerminalMuseJobStatus,
  readDismissedBgMedia,
  updateSessionCronEnabled,
  writeDismissedBgMedia,
  type SessionBgCommandItem,
  type SessionCronItem,
  type SessionMuseJobItem,
  type SessionMuseJobStatus,
} from "../lib/chat/sessionBackgroundTasks";
import type { AuthSession, Session } from "../lib/types";

const ACTIVE_POLL_MS = 5_000;
const REFRESH_THROTTLE_MS = 1_500;
// 网关 cron 每 60s tick 一次（触发时刻可能落在目标分钟末尾如 :56），到期后按有限三段复查覆盖完整 tick 窗
const CRON_DUE_RECHECK_OFFSETS_MS = [5_000, 35_000, 68_000] as const;
const CRON_DUE_RECHECK_WINDOW_MS =
  CRON_DUE_RECHECK_OFFSETS_MS[CRON_DUE_RECHECK_OFFSETS_MS.length - 1];
const MAX_CRON_DUE_TIMER_MS = 24 * 60 * 60_000;
export const BG_MEDIA_TERMINAL_RECENCY_MS = 30 * 60_000;
const LIVE_MEDIA_MAP_CAP = 50;
const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

function isSwarmRunningPhase(phase: string | undefined): boolean {
  return phase === "starting" || phase === "running";
}

function syncTrackedCronDues(
  tracked: Map<string, number>,
  crons: readonly SessionCronItem[],
  watermark: number,
): void {
  const activeIds = new Set<string>();
  for (const c of crons) {
    const prevDue = tracked.get(c.id);
    const lastRun =
      typeof c.lastRunAt === "number" && Number.isFinite(c.lastRunAt) ? c.lastRunAt : null;
    if (!c.enabled) {
      // 网关执行一次性续跑时先写 enabled=false，结算完毕才写 lastRunAt：
      // 仅对「已跟踪且已到期、无 lastRunAt 且复查窗未耗尽」的一次性任务保留剩余复查，
      // 避免恰好撞进禁用中间态时提前取消后续复查；原本手动暂停的任务不在 tracked 中不会触发。
      if (
        c.oneshot === true &&
        prevDue !== undefined &&
        lastRun === null &&
        watermark >= prevDue &&
        watermark < prevDue + CRON_DUE_RECHECK_WINDOW_MS
      ) {
        activeIds.add(c.id);
      }
      continue;
    }
    activeIds.add(c.id);
    const nextDue = c.nextRunAt !== null && Number.isFinite(c.nextRunAt) ? c.nextRunAt : null;
    if (prevDue === undefined) {
      if (nextDue !== null) tracked.set(c.id, nextDue);
      continue;
    }
    // 后端已回报本次或更晚的执行记录 → 本轮复查提前收敛，周期任务滚动至下一次
    if (lastRun !== null && lastRun >= prevDue) {
      if (nextDue !== null && nextDue > prevDue) tracked.set(c.id, nextDue);
      else tracked.delete(c.id);
      continue;
    }
    // 调度被改早 → 立即跟进更早到期时间
    if (nextDue !== null && nextDue < prevDue) {
      tracked.set(c.id, nextDue);
      continue;
    }
    // 三段复查窗未耗尽前保留本轮到期点：即使 computeNextRun 在过整点后已返回 null 或跳到下周期/明年，
    // 仍须覆盖网关 60s tick 尾端（如 :56）完成执行后的清理复查
    if (watermark < prevDue + CRON_DUE_RECHECK_WINDOW_MS) {
      continue;
    }
    if (nextDue !== null && nextDue > prevDue) {
      tracked.set(c.id, nextDue);
    } else {
      tracked.delete(c.id);
    }
  }
  for (const id of tracked.keys()) {
    if (!activeIds.has(id)) tracked.delete(id);
  }
}

export function filterVisibleMuseJobs(
  items: SessionMuseJobItem[],
  opts: { dismissed: ReadonlySet<string>; seenLive: ReadonlySet<string>; now: number },
): SessionMuseJobItem[] {
  return items.filter((item) => {
    if (!isTerminalMuseJobStatus(item.status)) return true;
    if (opts.dismissed.has(item.id)) return false;
    if (opts.seenLive.has(item.id)) return true;
    const anchor = item.startedAt ?? item.queuedAt;
    return anchor > 0 && opts.now - anchor <= BG_MEDIA_TERMINAL_RECENCY_MS;
  });
}

export type UseSessionBackgroundTasksOpts = {
  sessionId: string | null;
  enabled: boolean;
  auth: AuthSession | null;
  liveMediaJobs?: ReadonlyMap<string, MediaGenerationJob>;
  refreshTrigger?: number;
};

export type UseSessionBackgroundTasksResult = {
  museJobs: SessionMuseJobItem[];
  bgCommands: SessionBgCommandItem[];
  sessionCrons: SessionCronItem[];
  mediaJobs: MediaGenerationJob[];
  hasAny: boolean;
  cancelMuseJob: (jobId: string) => Promise<boolean>;
  cancelBgCommand: (entryId: string) => Promise<boolean>;
  cancelMediaJob: (jobId: string) => Promise<boolean>;
  toggleSessionCron: (cronId: string, enabled: boolean) => Promise<boolean>;
  deleteSessionCron: (cronId: string) => Promise<boolean>;
  dismissMuseJob: (jobId: string) => void;
  refresh: () => void;
};

/**
 * 统一会话后台任务聚合 Hook（OCV5-844）：
 *
 * - 进会话首拉与轮询只请求 `GET /api/sessions/:id/background-tasks`（零 `/api/cron` 首拉唤醒容器），
 *   统一消费 `museJobs`、`bgCommands`、`sessionCrons` 并合并当前会话 `sys.media_job`；
 * - 仅当存在非终态 `museJobs` 或 `bgCommands` 时开 5s 轮询（隐藏页暂停、回前台即拉，空闲 0 轮询）；
 * - 严格区分缺路由 404（`routeMissing` 静默降级停轮询）与新会话未落行 404（`sessionNotReady` 当空态不拉黑，下一次触发即自动恢复）；
 * - 同会话单调请求序号（`requestSeqRef` / `committedSeqRef`）防止在途旧轮询覆盖新的取消/修改快照。
 */
export function useSessionBackgroundTasks(
  opts: UseSessionBackgroundTasksOpts,
): UseSessionBackgroundTasksResult {
  const { sessionId, enabled, auth, liveMediaJobs, refreshTrigger } = opts;
  const [rawMuseJobs, setRawMuseJobs] = useState<SessionMuseJobItem[]>([]);
  const [rawBgCommands, setRawBgCommands] = useState<SessionBgCommandItem[]>([]);
  const [sessionCrons, setSessionCrons] = useState<SessionCronItem[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(() => readDismissedBgMedia(sessionId));
  const [seenSessionId, setSeenSessionId] = useState(sessionId);

  if (sessionId !== seenSessionId) {
    setSeenSessionId(sessionId);
    setRawMuseJobs([]);
    setRawBgCommands([]);
    setSessionCrons([]);
    setDismissed(readDismissedBgMedia(sessionId));
  }

  const routeMissingRef = useRef(new Set<string>());
  const seenLiveRef = useRef(new Set<string>());
  const authRef = useRef(auth);
  authRef.current = auth;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const genRef = useRef(0);
  const requestSeqRef = useRef(0);
  const committedSeqRef = useRef(0);
  const lastRefreshAtRef = useRef(0);
  const refreshTimerRef = useRef<number | null>(null);
  const prevRefreshTriggerRef = useRef(refreshTrigger);
  const trackedCronDueRef = useRef<Map<string, number>>(new Map());

  // 记录实时观测到的非终态 H3 mediaJobs，终态在当前页保持可见直至「知道了」
  useEffect(() => {
    if (!sessionId || !liveMediaJobs) return;
    for (const job of liveMediaJobs.values()) {
      if (job.sessionId === sessionId && !isTerminalMediaJobStatus(job.status)) {
        seenLiveRef.current.add(job.id);
      }
    }
  }, [sessionId, liveMediaJobs]);

  const pullTasks = useCallback(async (sid: string, myGen: number) => {
    const a = authRef.current;
    if (!a || routeMissingRef.current.has(sid)) return;
    lastRefreshAtRef.current = Date.now();
    const mySeq = ++requestSeqRef.current;
    const res = await fetchSessionBackgroundTasksResult(sid, a);
    if (genRef.current !== myGen || mySeq < committedSeqRef.current) return;
    if (res.ok) {
      committedSeqRef.current = mySeq;
      for (const job of res.snapshot.museJobs) {
        if (!isTerminalMuseJobStatus(job.status)) seenLiveRef.current.add(job.id);
      }
      syncTrackedCronDues(
        trackedCronDueRef.current,
        res.snapshot.sessionCrons,
        lastRefreshAtRef.current,
      );
      setRawMuseJobs(res.snapshot.museJobs);
      setRawBgCommands(res.snapshot.bgCommands);
      setSessionCrons(res.snapshot.sessionCrons);
      return;
    }
    if (res.sessionNotReady) {
      committedSeqRef.current = mySeq;
      trackedCronDueRef.current.clear();
      setRawMuseJobs([]);
      setRawBgCommands([]);
      setSessionCrons([]);
      return;
    }
    if (res.routeMissing) {
      committedSeqRef.current = mySeq;
      routeMissingRef.current.add(sid);
      trackedCronDueRef.current.clear();
      setRawMuseJobs([]);
      setRawBgCommands([]);
      setSessionCrons([]);
    }
  }, []);

  useEffect(() => {
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    prevRefreshTriggerRef.current = refreshTrigger;
    trackedCronDueRef.current.clear();
    if (!enabled || !sessionId || !auth) {
      genRef.current += 1;
      committedSeqRef.current = ++requestSeqRef.current;
      setRawMuseJobs([]);
      setRawBgCommands([]);
      setSessionCrons([]);
      setDismissed(new Set());
      return;
    }
    const myGen = ++genRef.current;
    committedSeqRef.current = ++requestSeqRef.current;
    setRawMuseJobs([]);
    setRawBgCommands([]);
    setSessionCrons([]);
    setDismissed(readDismissedBgMedia(sessionId));
    seenLiveRef.current = new Set();
    void pullTasks(sessionId, myGen);
    return () => {
      genRef.current += 1;
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: refreshTrigger 由节流 effect 单独消费
  }, [enabled, sessionId, auth, pullTasks]);

  const triggerThrottledPull = useCallback(
    (sid: string, myGen: number) => {
      if (!authRef.current || routeMissingRef.current.has(sid)) return;
      const elapsed = Date.now() - lastRefreshAtRef.current;
      if (elapsed >= REFRESH_THROTTLE_MS) {
        if (refreshTimerRef.current !== null) {
          window.clearTimeout(refreshTimerRef.current);
          refreshTimerRef.current = null;
        }
        void pullTasks(sid, myGen);
        return;
      }
      if (refreshTimerRef.current !== null) return;
      const waitMs = Math.max(0, REFRESH_THROTTLE_MS - elapsed);
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        if (genRef.current === myGen) void pullTasks(sid, myGen);
      }, waitMs);
    },
    [pullTasks],
  );

  useEffect(() => {
    if (refreshTrigger === undefined || refreshTrigger === prevRefreshTriggerRef.current) {
      prevRefreshTriggerRef.current = refreshTrigger;
      return;
    }
    prevRefreshTriggerRef.current = refreshTrigger;
    if (!enabled || !sessionId || !auth || routeMissingRef.current.has(sessionId)) return;
    triggerThrottledPull(sessionId, genRef.current);
  }, [refreshTrigger, enabled, sessionId, auth, triggerThrottledPull]);

  const hasActivePollableTasks =
    rawMuseJobs.some((j) => !isTerminalMuseJobStatus(j.status)) || rawBgCommands.length > 0;
  const baseEligible =
    enabled &&
    Boolean(sessionId) &&
    Boolean(auth) &&
    !routeMissingRef.current.has(sessionId ?? "");
  const shouldPollTasks = baseEligible && hasActivePollableTasks;
  const shouldRefreshOnVisible = baseEligible && (hasActivePollableTasks || sessionCrons.length > 0);

  useEffect(() => {
    if (!shouldPollTasks || !sessionId) return;
    const myGen = genRef.current;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void pullTasks(sessionId, myGen);
    }, ACTIVE_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [shouldPollTasks, sessionId, pullTasks]);

  useEffect(() => {
    if (!shouldRefreshOnVisible || !sessionId) return;
    const myGen = genRef.current;
    const onVisible = () => {
      if (document.visibilityState === "visible") triggerThrottledPull(sessionId, myGen);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [shouldRefreshOnVisible, sessionId, triggerThrottledPull]);

  // 仅有待触发定时续跑且无活跃轮询项时，按任务 ID 保留本轮到期点并做有限三段复查（空闲仍 0 轮询）
  useEffect(() => {
    if (!baseEligible || hasActivePollableTasks || !sessionId) {
      return;
    }
    const myGen = genRef.current;
    let disposed = false;
    let timerId: number | null = null;
    let lastFiredTarget = 0;

    const clearTimer = () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
    };

    const scheduleNext = () => {
      clearTimer();
      if (disposed || genRef.current !== myGen) return;
      const watermark = Math.max(lastRefreshAtRef.current, lastFiredTarget);
      let nextTarget: number | null = null;
      for (const dueAt of trackedCronDueRef.current.values()) {
        for (const offset of CRON_DUE_RECHECK_OFFSETS_MS) {
          const candidate = dueAt + offset;
          if (candidate > watermark) {
            if (nextTarget === null || candidate < nextTarget) nextTarget = candidate;
            break;
          }
        }
      }
      if (nextTarget === null) return;
      const delay = nextTarget - Date.now();
      if (delay > MAX_CRON_DUE_TIMER_MS) {
        timerId = window.setTimeout(scheduleNext, MAX_CRON_DUE_TIMER_MS);
        return;
      }
      const targetToFire = nextTarget;
      timerId = window.setTimeout(() => {
        timerId = null;
        if (disposed || genRef.current !== myGen) return;
        if (document.visibilityState !== "visible") return;
        lastFiredTarget = targetToFire;
        void pullTasks(sessionId, myGen).then(() => {
          if (!disposed && genRef.current === myGen) scheduleNext();
        });
      }, Math.max(0, delay));
    };

    scheduleNext();
    return () => {
      disposed = true;
      clearTimer();
    };
    // 依赖 sessionCrons 引用：每次快照落地（含回前台刷新与到期复查）都用最新 trackedCronDueRef 重排后续阶梯
  }, [baseEligible, hasActivePollableTasks, sessionId, sessionCrons, pullTasks]);

  const dismissMuseJob = useCallback((jobId: string) => {
    setDismissed((prev) => {
      if (prev.has(jobId)) return prev;
      const next = new Set(prev);
      next.add(jobId);
      writeDismissedBgMedia(sessionIdRef.current, next);
      return next;
    });
  }, []);

  const cancelMuseJob = useCallback(
    async (jobId: string): Promise<boolean> => {
      const sid = sessionIdRef.current;
      const a = authRef.current;
      if (!sid || !a || !jobId) return false;
      const myGen = genRef.current;
      const res = await cancelSessionMuseJob(sid, jobId, a);
      if (!res.ok) return false;
      if (genRef.current === myGen) {
        committedSeqRef.current = ++requestSeqRef.current;
        const validStatus: SessionMuseJobStatus | null =
          res.status === "queued" ||
          res.status === "running" ||
          res.status === "succeeded" ||
          res.status === "failed" ||
          res.status === "cancelled"
            ? res.status
            : null;
        if (validStatus) {
          setRawMuseJobs((prev) =>
            prev.map((j) => (j.id === jobId ? { ...j, status: validStatus } : j)),
          );
        } else if (res.cancelled) {
          setRawMuseJobs((prev) =>
            prev.map((j) => (j.id === jobId ? { ...j, status: "cancelled" } : j)),
          );
        }
        await pullTasks(sid, myGen);
      }
      return Boolean(res.cancelled);
    },
    [pullTasks],
  );

  const cancelBgCommand = useCallback(
    async (entryId: string): Promise<boolean> => {
      const sid = sessionIdRef.current;
      const a = authRef.current;
      if (!sid || !a || !entryId) return false;
      const myGen = genRef.current;
      const res = await cancelSessionBgCommand(sid, entryId, a);
      if (!res.ok) return false;
      if (genRef.current === myGen) {
        committedSeqRef.current = ++requestSeqRef.current;
        setRawBgCommands((prev) => prev.filter((cmd) => cmd.id !== entryId));
        await pullTasks(sid, myGen);
      }
      return true;
    },
    [pullTasks],
  );

  const cancelMediaJob = useCallback(async (jobId: string): Promise<boolean> => {
    const a = authRef.current;
    if (!a || !jobId) return false;
    return cancelMediaGenerationJob(jobId, a);
  }, []);

  const toggleSessionCron = useCallback(
    async (cronId: string, nextEnabled: boolean): Promise<boolean> => {
      const sid = sessionIdRef.current;
      const a = authRef.current;
      if (!sid || !a || !cronId) return false;
      const myGen = genRef.current;
      const ok = await updateSessionCronEnabled(cronId, nextEnabled, a);
      if (!ok) return false;
      if (genRef.current === myGen) {
        committedSeqRef.current = ++requestSeqRef.current;
        if (!nextEnabled) trackedCronDueRef.current.delete(cronId);
        setSessionCrons((prev) =>
          prev.map((c) => (c.id === cronId ? { ...c, enabled: nextEnabled } : c)),
        );
        await pullTasks(sid, myGen);
      }
      return true;
    },
    [pullTasks],
  );

  const deleteSessionCron = useCallback(
    async (cronId: string): Promise<boolean> => {
      const sid = sessionIdRef.current;
      const a = authRef.current;
      if (!sid || !a || !cronId) return false;
      const myGen = genRef.current;
      const ok = await deleteSessionCronJob(cronId, a);
      if (!ok) return false;
      if (genRef.current === myGen) {
        committedSeqRef.current = ++requestSeqRef.current;
        setSessionCrons((prev) => prev.filter((c) => c.id !== cronId));
        await pullTasks(sid, myGen);
      }
      return true;
    },
    [pullTasks],
  );

  const refresh = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid || !authRef.current) return;
    void pullTasks(sid, genRef.current);
  }, [pullTasks]);

  const museJobs = useMemo(
    () =>
      filterVisibleMuseJobs(rawMuseJobs, {
        dismissed,
        seenLive: seenLiveRef.current,
        now: Date.now(),
      }),
    [rawMuseJobs, dismissed],
  );

  const mediaJobs = useMemo(() => {
    if (!enabled || !sessionId || !liveMediaJobs || liveMediaJobs.size === 0) return [];
    return filterSessionMediaJobs(liveMediaJobs.values(), sessionId, {
      dismissed,
      seenLive: seenLiveRef.current,
      now: Date.now(),
      recencyMs: BG_MEDIA_TERMINAL_RECENCY_MS,
    });
  }, [enabled, sessionId, liveMediaJobs, dismissed]);

  const hasAny =
    museJobs.length > 0 ||
    mediaJobs.length > 0 ||
    rawBgCommands.length > 0 ||
    sessionCrons.length > 0;

  return {
    museJobs,
    bgCommands: rawBgCommands,
    sessionCrons,
    mediaJobs,
    hasAny,
    cancelMuseJob,
    cancelBgCommand,
    cancelMediaJob,
    toggleSessionCron,
    deleteSessionCron,
    dismissMuseJob,
    refresh,
  };
}

/**
 * App 级 sys.media_job 映射存储：按 job.id 索引全部活跃/近期任务，同时暴露最新一条兼容 MediaTaskCenter。
 */
export function useLiveMediaJobStore() {
  const [state, setState] = useState<{
    map: ReadonlyMap<string, MediaGenerationJob>;
    latest: MediaGenerationJob | null;
    version: number;
  }>({ map: new Map(), latest: null, version: 0 });

  const onMediaJob = useCallback((frame: MediaJobWire) => {
    const job = frame.job;
    if (!job?.id) return;
    setState((prev) => {
      const next = new Map(prev.map);
      next.delete(job.id);
      next.set(job.id, job);
      while (next.size > LIVE_MEDIA_MAP_CAP) {
        const oldestKey = next.keys().next().value;
        if (oldestKey === undefined) break;
        next.delete(oldestKey);
      }
      return { map: next, latest: job, version: prev.version + 1 };
    });
  }, []);

  const clear = useCallback(() => {
    setState((prev) =>
      prev.map.size === 0 && prev.latest === null
        ? prev
        : { map: new Map(), latest: null, version: prev.version + 1 },
    );
  }, []);

  return {
    liveMediaJobs: state.map,
    liveMediaJob: state.latest,
    mediaJobVersion: state.version,
    onMediaJob,
    clearLiveMediaJobs: clear,
  };
}

/**
 * 派生跨会话活跃蜂群集合，供给 Sidebar「协作中」徽标与 CommandPalette。
 */
export function useTrackedSwarmSessionIds(opts: {
  demo: boolean;
  activeId?: string;
  latestSwarm: SwarmSnapshot | null;
  sessions: readonly Session[];
  getMessages: (id: string) => ChatMessage[];
  isSending: (id: string) => boolean;
  version: number;
}): ReadonlySet<string> {
  const { demo, activeId, latestSwarm, sessions, getMessages, isSending, version } = opts;
  const trackedRef = useRef(new Set<string>());

  return useMemo(() => {
    void version;
    if (demo) {
      trackedRef.current.clear();
      return EMPTY_STRING_SET;
    }
    const next = new Set<string>();
    const knownIds = new Set(sessions.map((s) => s.id));

    if (activeId && latestSwarm && isSwarmRunningPhase(latestSwarm.phase)) {
      next.add(activeId);
    }

    for (const s of sessions) {
      if (s.id === activeId && latestSwarm) {
        if (isSwarmRunningPhase(latestSwarm.phase)) next.add(s.id);
        continue;
      }
      const snap = latestSwarmSnapshot(getMessages(s.id));
      if (snap) {
        if (isSwarmRunningPhase(snap.phase)) next.add(s.id);
      } else if (trackedRef.current.has(s.id) && isSending(s.id)) {
        next.add(s.id);
      }
    }

    for (const prevId of trackedRef.current) {
      if (!knownIds.has(prevId)) continue;
      if (next.has(prevId)) continue;
      const snap = latestSwarmSnapshot(getMessages(prevId));
      if (snap && isSwarmRunningPhase(snap.phase)) next.add(prevId);
    }

    trackedRef.current = next;
    return next.size === 0 ? EMPTY_STRING_SET : next;
  }, [demo, activeId, latestSwarm, sessions, getMessages, isSending, version]);
}

/**
 * 从当前会话实时信号派生 `useInflightDelegates` 与 `useSessionBackgroundTasks` 的轻量刷新脉冲：
 * - wsSending true -> false 时双方各触发一次；
 * - 出现新 agent-group / delegate-progress 消息块时触发委派刷新；
 * - mediaJobVersion 递增或非发送态消息数增长（sys.muse_result 落库同步）时触发后台任务刷新。
 */
export function useBackgroundTaskTriggers(opts: {
  sessionId: string | undefined;
  wsSending: boolean;
  wsMessages: readonly ChatMessage[];
  chatVersion: number;
  mediaJobVersion: number;
}): { delegateRefreshTrigger: number; bgTasksRefreshTrigger: number } {
  const { sessionId, wsSending, wsMessages, chatVersion, mediaJobVersion } = opts;
  const [delegateTrigger, setDelegateTrigger] = useState(0);
  const [bgTrigger, setBgTrigger] = useState(0);

  const prevSendingRef = useRef(wsSending);
  const prevSessionRef = useRef(sessionId);
  const prevDelegateBlocksRef = useRef(0);
  const prevMsgCountRef = useRef(wsMessages.length);
  const prevMediaVersionRef = useRef(mediaJobVersion);

  const delegateBlockCount = useMemo(() => {
    void chatVersion;
    let count = 0;
    for (const m of wsMessages) {
      if (m.role === "agent-group" || m.role === "delegate-progress") count += 1;
    }
    return count;
  }, [wsMessages, chatVersion]);

  const msgCount = useMemo(() => {
    void chatVersion;
    return wsMessages.length;
  }, [wsMessages, chatVersion]);

  // 长会话热尾归档（spill）后 wsMessages.length 可能不变或变小，额外追踪末条消息签名捕获离线补拉/定时续跑回复
  const tailMsgSignature = useMemo(() => {
    void chatVersion;
    const last = wsMessages[wsMessages.length - 1];
    if (!last) return "";
    const orderSeq = typeof last._orderSeq === "number" ? last._orderSeq : "";
    return `${last.id}:${orderSeq}`;
  }, [wsMessages, chatVersion]);
  const prevTailMsgSigRef = useRef(tailMsgSignature);

  useEffect(() => {
    if (prevSessionRef.current !== sessionId) {
      prevSessionRef.current = sessionId;
      prevSendingRef.current = wsSending;
      prevDelegateBlocksRef.current = delegateBlockCount;
      prevMsgCountRef.current = msgCount;
      prevTailMsgSigRef.current = tailMsgSignature;
      prevMediaVersionRef.current = mediaJobVersion;
      return;
    }

    let bumpDelegate = false;
    let bumpBg = false;

    if (prevSendingRef.current && !wsSending) {
      bumpDelegate = true;
      bumpBg = true;
    }
    prevSendingRef.current = wsSending;

    if (delegateBlockCount > prevDelegateBlocksRef.current) {
      bumpDelegate = true;
    }
    prevDelegateBlocksRef.current = delegateBlockCount;

    if (mediaJobVersion !== prevMediaVersionRef.current) {
      bumpBg = true;
    }
    prevMediaVersionRef.current = mediaJobVersion;

    const tailAdvanced = tailMsgSignature !== "" && tailMsgSignature !== prevTailMsgSigRef.current;
    if (!wsSending && (msgCount > prevMsgCountRef.current || tailAdvanced)) {
      bumpBg = true;
    }
    prevMsgCountRef.current = msgCount;
    prevTailMsgSigRef.current = tailMsgSignature;

    if (bumpDelegate) setDelegateTrigger((n) => n + 1);
    if (bumpBg) setBgTrigger((n) => n + 1);
  }, [sessionId, wsSending, delegateBlockCount, msgCount, tailMsgSignature, mediaJobVersion]);

  return { delegateRefreshTrigger: delegateTrigger, bgTasksRefreshTrigger: bgTrigger };
}
