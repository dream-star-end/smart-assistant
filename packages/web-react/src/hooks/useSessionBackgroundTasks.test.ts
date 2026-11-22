import type { SwarmSnapshot } from "@openclaude/protocol/browser";
import type { MediaGenerationJob } from "@openclaude/protocol/mediaGeneration";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createMemoryAuthSession } from "../lib/authSession";
import type { ChatMessage } from "../lib/chat/model";
import {
  cancelMediaGenerationJob,
  cancelSessionBgCommand,
  cancelSessionMuseJob,
  deleteSessionCronJob,
  fetchSessionBackgroundTasksResult,
  fetchSessionOriginCrons,
  filterSessionOriginCrons,
  formatCountdown,
  updateSessionCronEnabled,
  type SessionBgCommandItem,
  type SessionCronItem,
  type SessionMuseJobItem,
} from "../lib/chat/sessionBackgroundTasks";
import type { Session } from "../lib/types";
import {
  useBackgroundTaskTriggers,
  useLiveMediaJobStore,
  useSessionBackgroundTasks,
  useTrackedSwarmSessionIds,
} from "./useSessionBackgroundTasks";

vi.mock("../lib/chat/sessionBackgroundTasks", async (original) => ({
  ...(await original<typeof import("../lib/chat/sessionBackgroundTasks")>()),
  fetchSessionBackgroundTasksResult: vi.fn(),
  fetchSessionOriginCrons: vi.fn(),
  cancelSessionMuseJob: vi.fn(),
  cancelSessionBgCommand: vi.fn(),
  cancelMediaGenerationJob: vi.fn(),
  updateSessionCronEnabled: vi.fn(),
  deleteSessionCronJob: vi.fn(),
}));

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(fetchSessionBackgroundTasksResult).mockReset();
  vi.mocked(fetchSessionOriginCrons).mockReset();
  vi.mocked(cancelSessionMuseJob).mockReset();
  vi.mocked(cancelSessionBgCommand).mockReset();
  vi.mocked(cancelMediaGenerationJob).mockReset();
  vi.mocked(updateSessionCronEnabled).mockReset();
  vi.mocked(deleteSessionCronJob).mockReset();
});

function museJob(over: Partial<SessionMuseJobItem> = {}): SessionMuseJobItem {
  return {
    id: "muse-1",
    kind: "video",
    status: "running",
    promptPreview: "日落海边航拍慢镜头",
    queuedAt: Date.now() - 10_000,
    startedAt: Date.now() - 5_000,
    ...over,
  };
}

function bgCmd(over: Partial<SessionBgCommandItem> = {}): SessionBgCommandItem {
  return {
    id: "1234-ocb_1",
    jobId: "ocb_1",
    commandPreview: "npm run build -- --watch",
    cwd: "/workspace/app",
    startedAt: Date.now() - 20_000,
    updatedAt: Date.now() - 1_000,
    ...over,
  };
}

function cronItem(over: Partial<SessionCronItem> = {}): SessionCronItem {
  return {
    id: "cron-1",
    name: "检查构建结果",
    enabled: true,
    schedule: "*/30 * * * *",
    nextRunAt: Date.now() + 12 * 60_000,
    resume: "origin-session",
    sourceSessionKey: "agent:main:webchat:dm:s1",
    ...over,
  };
}

function mediaJob(over: Partial<MediaGenerationJob> = {}): MediaGenerationJob {
  const iso = new Date().toISOString();
  return {
    id: "mj-1",
    requestId: "req-1",
    kind: "h3_generate",
    resourceClass: "gpu-h3",
    status: "running",
    phase: "generating",
    prompt: "城市夜景延时摄影",
    sessionId: "s1",
    createdAt: iso,
    updatedAt: iso,
    ...over,
  };
}

describe("sessionBackgroundTasks pure helpers", () => {
  test("filterSessionOriginCrons 仅保留匹配当前 sessionId 且 resume=origin-session 的定时任务", () => {
    const now = Date.now();
    const out = filterSessionOriginCrons(
      [
        {
          id: "c1",
          name: "本会话续跑",
          enabled: true,
          schedule: "*/15 * * * *",
          nextRunAt: now + 600_000,
          resume: "origin-session",
          sourceSessionKey: "agent:main:webchat:dm:sess-a",
        },
        {
          id: "c2",
          name: "其他会话续跑",
          enabled: true,
          schedule: "*/15 * * * *",
          nextRunAt: now + 600_000,
          resume: "origin-session",
          sourceSessionKey: "agent:main:webchat:dm:sess-b",
        },
        {
          id: "c3",
          name: "隔离任务",
          enabled: true,
          schedule: "*/15 * * * *",
          nextRunAt: now + 600_000,
          resume: "isolated",
          sourceSessionKey: "agent:main:webchat:dm:sess-a",
        },
        {
          id: "c4",
          name: "已执行一次性提醒",
          enabled: false,
          oneshot: true,
          nextRunAt: null,
          lastRunAt: now - 10_000,
          resume: "origin-session",
          sourceSessionKey: "agent:main:webchat:dm:sess-a",
        },
      ],
      "sess-a",
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("c1");
  });

  test("formatCountdown 准确格式化倒计时文案", () => {
    const now = 1_000_000;
    expect(formatCountdown(now + 20_000, now)).toBe("即将触发");
    expect(formatCountdown(now + 12 * 60_000, now)).toBe("12 分钟后");
    expect(formatCountdown(now + 90 * 60_000, now)).toBe("1 小时 30 分后");
    expect(formatCountdown(now + 2 * 60 * 60_000, now)).toBe("2 小时后");
    expect(formatCountdown(now + 48 * 60 * 60_000, now)).toBe("2 天后");
    expect(formatCountdown(null, now)).toBe("");
  });
});

describe("useSessionBackgroundTasks", () => {
  const auth = createMemoryAuthSession(() => {}, "tok");

  test("空闲会话只拉 1 次，0 轮询", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.mocked(fetchSessionBackgroundTasksResult).mockResolvedValue({
      ok: true,
      snapshot: { delegates: [], museJobs: [], bgCommands: [] },
    });
    vi.mocked(fetchSessionOriginCrons).mockResolvedValue({ ok: true, items: [] });

    const { result } = renderHook(() =>
      useSessionBackgroundTasks({ sessionId: "s1", enabled: true, auth }),
    );
    await act(async () => {});
    expect(result.current.hasAny).toBe(false);
    expect(fetchSessionBackgroundTasksResult).toHaveBeenCalledTimes(1);
    expect(fetchSessionOriginCrons).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(fetchSessionBackgroundTasksResult).toHaveBeenCalledTimes(1);
    expect(fetchSessionOriginCrons).toHaveBeenCalledTimes(1);
  });

  test("存在活跃后台命令/Muse 任务时开启 5s 轮询，隐藏暂停，切回前台立刻拉 1 次，终态后停止轮询", async () => {
    vi.useFakeTimers();
    let vis: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => vis);

    const running = museJob({ status: "running" });
    const done = { ...running, status: "succeeded" as const };
    vi.mocked(fetchSessionBackgroundTasksResult)
      .mockResolvedValueOnce({ ok: true, snapshot: { delegates: [], museJobs: [running], bgCommands: [] } })
      .mockResolvedValueOnce({ ok: true, snapshot: { delegates: [], museJobs: [running], bgCommands: [] } })
      .mockResolvedValueOnce({ ok: true, snapshot: { delegates: [], museJobs: [done], bgCommands: [] } });
    vi.mocked(fetchSessionOriginCrons).mockResolvedValue({ ok: true, items: [] });

    const { result } = renderHook(() =>
      useSessionBackgroundTasks({ sessionId: "s1", enabled: true, auth }),
    );
    await act(async () => {});
    expect(result.current.museJobs).toHaveLength(1);
    expect(fetchSessionBackgroundTasksResult).toHaveBeenCalledTimes(1);

    // 5s 后触发第 2 次拉取
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(fetchSessionBackgroundTasksResult).toHaveBeenCalledTimes(2);

    // 隐藏标签页：跳过轮询
    vis = "hidden";
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(fetchSessionBackgroundTasksResult).toHaveBeenCalledTimes(2);

    // 切回前台：立刻拉第 3 次，收到终态
    vis = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fetchSessionBackgroundTasksResult).toHaveBeenCalledTimes(3);
    expect(result.current.museJobs[0]?.status).toBe("succeeded");

    // 终态后停止轮询
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(fetchSessionBackgroundTasksResult).toHaveBeenCalledTimes(3);
  });

  test("/background-tasks 返回 404 时静默降级为空，不影响定时续跑与当前会话 mediaJobs", async () => {
    vi.mocked(fetchSessionBackgroundTasksResult).mockResolvedValue({ ok: false, notFound: true });
    vi.mocked(fetchSessionOriginCrons).mockResolvedValue({ ok: true, items: [cronItem()] });

    const liveMap = new Map<string, MediaGenerationJob>([
      ["mj-1", mediaJob({ id: "mj-1", sessionId: "s1" })],
      ["mj-other", mediaJob({ id: "mj-other", sessionId: "s2" })],
    ]);

    const { result } = renderHook(() =>
      useSessionBackgroundTasks({ sessionId: "s1", enabled: true, auth, liveMediaJobs: liveMap }),
    );
    await act(async () => {});
    expect(result.current.museJobs).toEqual([]);
    expect(result.current.bgCommands).toEqual([]);
    expect(result.current.sessionCrons).toHaveLength(1);
    expect(result.current.mediaJobs.map((j) => j.id)).toEqual(["mj-1"]);
    expect(result.current.hasAny).toBe(true);
  });

  test("行内干预动作：cancelMuseJob / cancelBgCommand / toggleSessionCron / deleteSessionCron / dismissMuseJob", async () => {
    const mRunning = museJob({ id: "m-run", status: "running" });
    const mDone = museJob({ id: "m-done", status: "succeeded" });
    const cmd = bgCmd({ id: "42-ocb_1" });
    const cron = cronItem({ id: "cron-1", enabled: true });

    vi.mocked(fetchSessionBackgroundTasksResult)
      .mockResolvedValueOnce({
        ok: true,
        snapshot: { delegates: [], museJobs: [mRunning, mDone], bgCommands: [cmd] },
      })
      .mockResolvedValueOnce({
        ok: true,
        snapshot: {
          delegates: [],
          museJobs: [{ ...mRunning, status: "cancelled" }, mDone],
          bgCommands: [cmd],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        snapshot: {
          delegates: [],
          museJobs: [{ ...mRunning, status: "cancelled" }, mDone],
          bgCommands: [],
        },
      });
    vi.mocked(fetchSessionOriginCrons)
      .mockResolvedValueOnce({ ok: true, items: [cron] })
      .mockResolvedValueOnce({ ok: true, items: [{ ...cron, enabled: false }] })
      .mockResolvedValueOnce({ ok: true, items: [] });

    vi.mocked(cancelSessionMuseJob).mockResolvedValue({ ok: true, cancelled: true, status: "cancelled" });
    vi.mocked(cancelSessionBgCommand).mockResolvedValue({ ok: true, cancelled: true });
    vi.mocked(updateSessionCronEnabled).mockResolvedValue(true);
    vi.mocked(deleteSessionCronJob).mockResolvedValue(true);

    const { result } = renderHook(() =>
      useSessionBackgroundTasks({ sessionId: "s1", enabled: true, auth }),
    );
    await act(async () => {});
    expect(result.current.museJobs).toHaveLength(2);
    expect(result.current.bgCommands).toHaveLength(1);
    expect(result.current.sessionCrons[0]?.enabled).toBe(true);

    await act(async () => {
      expect(await result.current.cancelMuseJob("m-run")).toBe(true);
    });
    expect(cancelSessionMuseJob).toHaveBeenCalledWith("s1", "m-run", auth);

    await act(async () => {
      expect(await result.current.cancelBgCommand("42-ocb_1")).toBe(true);
    });
    expect(cancelSessionBgCommand).toHaveBeenCalledWith("s1", "42-ocb_1", auth);
    expect(result.current.bgCommands).toEqual([]);

    await act(async () => {
      expect(await result.current.toggleSessionCron("cron-1", false)).toBe(true);
    });
    expect(updateSessionCronEnabled).toHaveBeenCalledWith("cron-1", false, auth);
    expect(result.current.sessionCrons[0]?.enabled).toBe(false);

    await act(async () => {
      expect(await result.current.deleteSessionCron("cron-1")).toBe(true);
    });
    expect(deleteSessionCronJob).toHaveBeenCalledWith("cron-1", auth);
    expect(result.current.sessionCrons).toEqual([]);

    act(() => {
      result.current.dismissMuseJob("m-done");
    });
    expect(result.current.museJobs.some((m) => m.id === "m-done")).toBe(false);
  });
});

describe("cross-session & trigger helpers", () => {
  test("useLiveMediaJobStore 按 id 维护 Map 并保留最新项", () => {
    const { result } = renderHook(() => useLiveMediaJobStore());
    const j1 = mediaJob({ id: "j1", status: "queued" });
    const j2 = mediaJob({ id: "j2", status: "running", sessionId: "s2" });
    act(() => {
      result.current.onMediaJob({ type: "sys.media_job", job: j1, ts: 1 });
      result.current.onMediaJob({ type: "sys.media_job", job: j2, ts: 2 });
    });
    expect(result.current.liveMediaJobs.size).toBe(2);
    expect(result.current.liveMediaJob?.id).toBe("j2");
    act(() => {
      result.current.onMediaJob({ type: "sys.media_job", job: { ...j1, status: "completed" }, ts: 3 });
    });
    expect(result.current.liveMediaJobs.get("j1")?.status).toBe("completed");
    expect(result.current.liveMediaJob?.id).toBe("j1");
    act(() => {
      result.current.clearLiveMediaJobs();
    });
    expect(result.current.liveMediaJobs.size).toBe(0);
    expect(result.current.liveMediaJob).toBeNull();
  });

  test("useTrackedSwarmSessionIds 跨会话追踪运行中蜂群并在完成后自动移除", () => {
    const runningSwarm = {
      swarmId: "sw-1",
      title: "并行重构",
      phase: "running",
      revision: 1,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      totalPosts: 1,
      members: [],
      channels: [],
      posts: [],
    } as unknown as SwarmSnapshot;
    const completedSwarm = { ...runningSwarm, phase: "completed" } as SwarmSnapshot;

    const msgsBySession: Record<string, ChatMessage[]> = {
      s1: [{ id: "m1", role: "tool", toolName: "SwarmBoard", text: "", ts: 1, _swarmSnapshot: runningSwarm } as ChatMessage],
      s2: [],
    };
    const sessions = [{ id: "s1", title: "A" }, { id: "s2", title: "B" }] as Session[];

    const { result, rerender } = renderHook(
      ({ activeId, latestSwarm, version }) =>
        useTrackedSwarmSessionIds({
          demo: false,
          activeId,
          latestSwarm,
          sessions,
          getMessages: (id) => msgsBySession[id] ?? [],
          isSending: () => false,
          version,
        }),
      { initialProps: { activeId: "s1", latestSwarm: runningSwarm as SwarmSnapshot | null, version: 1 } },
    );
    expect(result.current.has("s1")).toBe(true);

    // 切去 s2：后台 s1 仍在运行，仍保留在 swarmSessionIds 中
    rerender({ activeId: "s2", latestSwarm: null, version: 2 });
    expect(result.current.has("s1")).toBe(true);

    // s1 蜂群完成：自动移除
    msgsBySession.s1 = [
      { id: "m1", role: "tool", toolName: "SwarmBoard", text: "", ts: 1, _swarmSnapshot: completedSwarm } as ChatMessage,
    ];
    rerender({ activeId: "s2", latestSwarm: null, version: 3 });
    expect(result.current.has("s1")).toBe(false);
  });

  test("useBackgroundTaskTriggers 在 turn 结束 / 出现委派块 / 收到媒体事件时递增对应触发器", () => {
    const msgs: ChatMessage[] = [];
    const { result, rerender } = renderHook(
      ({ wsSending, wsMessages, chatVersion, mediaJobVersion }) =>
        useBackgroundTaskTriggers({
          sessionId: "s1",
          wsSending,
          wsMessages,
          chatVersion,
          mediaJobVersion,
        }),
      {
        initialProps: {
          wsSending: true,
          wsMessages: msgs,
          chatVersion: 1,
          mediaJobVersion: 0,
        },
      },
    );
    expect(result.current.delegateRefreshTrigger).toBe(0);
    expect(result.current.bgTasksRefreshTrigger).toBe(0);

    // 出现委派块 → 触发 delegateRefreshTrigger
    msgs.push({ id: "d1", role: "agent-group", text: "", ts: 1 } as ChatMessage);
    rerender({ wsSending: true, wsMessages: msgs, chatVersion: 2, mediaJobVersion: 0 });
    expect(result.current.delegateRefreshTrigger).toBe(1);
    expect(result.current.bgTasksRefreshTrigger).toBe(0);

    // wsSending true -> false → 双方各触发 1 次
    rerender({ wsSending: false, wsMessages: msgs, chatVersion: 3, mediaJobVersion: 0 });
    expect(result.current.delegateRefreshTrigger).toBe(2);
    expect(result.current.bgTasksRefreshTrigger).toBe(1);

    // mediaJobVersion 递增 → 触发 bgTasksRefreshTrigger
    rerender({ wsSending: false, wsMessages: msgs, chatVersion: 3, mediaJobVersion: 1 });
    expect(result.current.bgTasksRefreshTrigger).toBe(2);
  });
});
