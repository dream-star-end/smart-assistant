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
  fetchSessionOriginCrons,
  filterSessionMediaJobs,
  isTerminalMediaJobStatus,
  isTerminalMuseJobStatus,
  readDismissedBgMedia,
  updateSessionCronEnabled,
  writeDismissedBgMedia,
  type SessionBgCommandItem,
  type SessionCronItem,
  type SessionMuseJobItem,
} from "../lib/chat/sessionBackgroundTasks";
import type { AuthSession, Session } from "../lib/types";

const ACTIVE_POLL_MS = 5_000;
const REFRESH_THROTTLE_MS = 1_500;
export const BG_MEDIA_TERMINAL_RECENCY_MS = 30 * 60_000;
const LIVE_MEDIA_MAP_CAP = 50;
const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

function isSwarmRunningPhase(phase: string | undefined): boolean {
  return phase === "starting" || phase === "running";
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
 * - 聚合当前会话的 Muse 异步媒体、oc_bash 后台命令、origin-session 定时续跑、sys.media_job 媒体任务；
 * - 进会话拉 1 次；收到 refreshTrigger（turn 结束 / sys.muse_result / sys.media_job）节流刷新；
 * - 仅当存在非终态 museJobs 或 bgCommands 时开 5s 轮询（隐藏页暂停、切回前台立刻拉 1 次），空闲时 0 轮询；
 * - /background-tasks 返回 404 时静默降级为空，不影响定时续跑与 H3 媒体任务展示。
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

  const bgNotFoundRef = useRef(new Set<string>());
  const seenLiveRef = useRef(new Set<string>());
  const authRef = useRef(auth);
  authRef.current = auth;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const genRef = useRef(0);
  const lastRefreshAtRef = useRef(0);
  const refreshTimerRef = useRef<number | null>(null);
  const prevRefreshTriggerRef = useRef(refreshTrigger);

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
    if (!a || bgNotFoundRef.current.has(sid)) return;
    const res = await fetchSessionBackgroundTasksResult(sid, a);
    if (genRef.current !== myGen) return;
    if (res.ok) {
      for (const job of res.snapshot.museJobs) {
        if (!isTerminalMuseJobStatus(job.status)) seenLiveRef.current.add(job.id);
      }
      setRawMuseJobs(res.snapshot.museJobs);
      setRawBgCommands(res.snapshot.bgCommands);
      return;
    }
    if (res.notFound) {
      bgNotFoundRef.current.add(sid);
      setRawMuseJobs([]);
      setRawBgCommands([]);
    }
  }, []);

  const pullCrons = useCallback(async (sid: string, myGen: number) => {
    const a = authRef.current;
    if (!a) return;
    const res = await fetchSessionOriginCrons(sid, a);
    if (genRef.current !== myGen) return;
    if (res.ok) setSessionCrons(res.items);
  }, []);

  const pullAll = useCallback(
    (sid: string, myGen: number) => {
      lastRefreshAtRef.current = Date.now();
      void pullTasks(sid, myGen);
      void pullCrons(sid, myGen);
    },
    [pullTasks, pullCrons],
  );

  useEffect(() => {
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    prevRefreshTriggerRef.current = refreshTrigger;
    if (!enabled || !sessionId || !auth) {
      genRef.current += 1;
      setRawMuseJobs([]);
      setRawBgCommands([]);
      setSessionCrons([]);
      setDismissed(new Set());
      return;
    }
    const myGen = ++genRef.current;
    setRawMuseJobs([]);
    setRawBgCommands([]);
    setSessionCrons([]);
    setDismissed(readDismissedBgMedia(sessionId));
    seenLiveRef.current = new Set();
    pullAll(sessionId, myGen);
    return () => {
      genRef.current += 1;
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: refreshTrigger 由节流 effect 单独消费
  }, [enabled, sessionId, auth, pullAll]);

  useEffect(() => {
    if (refreshTrigger === undefined || refreshTrigger === prevRefreshTriggerRef.current) {
      prevRefreshTriggerRef.current = refreshTrigger;
      return;
    }
    prevRefreshTriggerRef.current = refreshTrigger;
    if (!enabled || !sessionId || !auth) return;
    const myGen = genRef.current;
    const elapsed = Date.now() - lastRefreshAtRef.current;
    if (elapsed >= REFRESH_THROTTLE_MS) {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      pullAll(sessionId, myGen);
      return;
    }
    if (refreshTimerRef.current !== null) return;
    const waitMs = Math.max(0, REFRESH_THROTTLE_MS - elapsed);
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      if (genRef.current === myGen) pullAll(sessionId, myGen);
    }, waitMs);
  }, [refreshTrigger, enabled, sessionId, auth, pullAll]);

  const hasActivePollableTasks =
    rawMuseJobs.some((j) => !isTerminalMuseJobStatus(j.status)) || rawBgCommands.length > 0;
  const shouldPollTasks =
    enabled &&
    Boolean(sessionId) &&
    Boolean(auth) &&
    !bgNotFoundRef.current.has(sessionId ?? "") &&
    hasActivePollableTasks;

  useEffect(() => {
    if (!shouldPollTasks || !sessionId) return;
    const myGen = genRef.current;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void pullTasks(sessionId, myGen);
    }, ACTIVE_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void pullTasks(sessionId, myGen);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [shouldPollTasks, sessionId, pullTasks]);

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
      if (genRef.current === myGen) await pullTasks(sid, myGen);
      return true;
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
        setSessionCrons((prev) =>
          prev.map((c) => (c.id === cronId ? { ...c, enabled: nextEnabled } : c)),
        );
        await pullCrons(sid, myGen);
      }
      return true;
    },
    [pullCrons],
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
        setSessionCrons((prev) => prev.filter((c) => c.id !== cronId));
        await pullCrons(sid, myGen);
      }
      return true;
    },
    [pullCrons],
  );

  const refresh = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid || !authRef.current) return;
    pullAll(sid, genRef.current);
  }, [pullAll]);

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

  useEffect(() => {
    if (prevSessionRef.current !== sessionId) {
      prevSessionRef.current = sessionId;
      prevSendingRef.current = wsSending;
      prevDelegateBlocksRef.current = delegateBlockCount;
      prevMsgCountRef.current = msgCount;
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

    if (!wsSending && msgCount > prevMsgCountRef.current) {
      bumpBg = true;
    }
    prevMsgCountRef.current = msgCount;

    if (bumpDelegate) setDelegateTrigger((n) => n + 1);
    if (bumpBg) setBgTrigger((n) => n + 1);
  }, [sessionId, wsSending, delegateBlockCount, msgCount, mediaJobVersion]);

  return { delegateRefreshTrigger: delegateTrigger, bgTasksRefreshTrigger: bgTrigger };
}
