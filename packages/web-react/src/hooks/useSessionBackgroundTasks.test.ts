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
  isSessionNotReady404,
  updateSessionCronEnabled,
  type SessionBackgroundTasksFetchResult,
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
  test("filterSessionOriginCrons 仅保留匹配当前 sessionId 且 resume=origin-session 的定时任务并兼容 message 字段", () => {
    const now = Date.now();
    const out = filterSessionOriginCrons(
      [
        {
          id: "c1",
          name: "本会话续跑",
          enabled: true,
          schedule: "*/15 * * * *",
          message: "汇总测试覆盖率",
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
    expect(out[0]?.prompt).toBe("汇总测试覆盖率");
  });

  test("isSessionNotReady404 精确区分新会话未建行 404 与路由缺失 404", () => {
    expect(isSessionNotReady404({ code: "SESSION_NOT_FOUND" })).toBe(true);
    expect(isSessionNotReady404({ error: { code: "SESSION_NOT_FOUND", message: "missing" } })).toBe(true);
    expect(isSessionNotReady404({ code: "NOT_FOUND", message: "session not found" })).toBe(true);
    expect(isSessionNotReady404({ error: { code: "NOT_FOUND", message: "session not found" } })).toBe(true);

    expect(isSessionNotReady404({ code: "NOT_FOUND", message: "session background task route not found" })).toBe(false);
    expect(isSessionNotReady404({ code: "NOT_FOUND", message: "Not Found" })).toBe(false);
    expect(isSessionNotReady404({ error: "Cannot GET /api/sessions/s1/background-tasks" })).toBe(false);
    expect(isSessionNotReady404(null)).toBe(false);
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

  test("fetchSessionBackgroundTasksResult 实测解析 sessionCrons 与 404 分流（SESSION_NOT_FOUND vs 缺路由）", async () => {
    const actual = await vi.importActual<typeof import("../lib/chat/sessionBackgroundTasks")>(
      "../lib/chat/sessionBackgroundTasks",
    );
    const auth = createMemoryAuthSession(() => {}, "tok");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // 1. 404 SESSION_NOT_FOUND → sessionNotReady: true, routeMissing: false
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: "SESSION_NOT_FOUND", message: "session not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(await actual.fetchSessionBackgroundTasksResult("s1", auth)).toEqual({
      ok: false,
      routeMissing: false,
      sessionNotReady: true,
    });

    // 2. 404 路由缺失 → routeMissing: true, sessionNotReady: false
    fetchSpy.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
    expect(await actual.fetchSessionBackgroundTasksResult("s1", auth)).toEqual({
      ok: false,
      routeMissing: true,
      sessionNotReady: false,
    });

    // 3. 200 聚合响应：仅发 /background-tasks，正确解析 sessionCrons
    const nextRunAt = Date.now() + 300_000;
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          delegates: [],
          museJobs: [],
          bgCommands: [],
          sessionCrons: [
            {
              id: "c1",
              name: "定时复查",
              enabled: true,
              schedule: "*/10 * * * *",
              message: "复查 CI 状态",
              nextRunAt,
              resume: "origin-session",
              sourceSessionKey: "agent:main:webchat:dm:s1",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const okRes = await actual.fetchSessionBackgroundTasksResult("s1", auth);
    expect(okRes.ok).toBe(true);
    if (okRes.ok) {
      expect(okRes.snapshot.sessionCrons).toHaveLength(1);
      expect(okRes.snapshot.sessionCrons[0]?.name).toBe("定时复查");
      expect(okRes.snapshot.sessionCrons[0]?.prompt).toBe("复查 CI 状态");
    }
    expect(fetchSpy.mock.calls.every(([url]) => String(url).includes("/background-tasks"))).toBe(
      true,
    );
  });
});

describe("useSessionBackgroundTasks", () => {
  const auth = createMemoryAuthSession(() => {}, "tok");

  test("进会话仅发 /background-tasks 零发 /api/cron，空闲时 0 轮询", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const cron = cronItem();
    vi.mocked(fetchSessionBackgroundTasksResult).mockResolvedValue({
      ok: true,
      snapshot: { delegates: [], museJobs: [], bgCommands: [], sessionCrons: [cron] },
    });

    const { result } = renderHook(() =>
      useSessionBackgroundTasks({ sessionId: "s1", enabled: true, auth }),
    );
    await act(async () => {});
    expect(result.current.sessionCrons).toEqual([cron]);
    expect(result.current.hasAny).toBe(true);
    expect(fetchSessionBackgroundTasksResult).toHaveBeenCalledTimes(1);
    // 绝不直接发 GET /api/cron（防止首拉唤醒休眠容器）
    expect(fetchSessionOriginCrons).not.toHaveBeenCalled();

    // 仅有待触发定时续跑、无活跃运行项时：0 轮询
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(fetchSessionBackgroundTasksResult).toHaveBeenCalledTimes(1);
    expect(fetchSessionOriginCrons).not.toHaveBeenCalled();
  });

  test("存在活跃后台命令/Muse 任务时开启 5s 轮询，隐藏暂停，切回前台立刻拉 1 次，终态后停止轮询", async () => {
    vi.useFakeTimers();
    let vis: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => vis);

    const running = museJob({ status: "running" });
    const done = { ...running, status: "succeeded" as const };
    vi.mocked(fetchSessionBackgroundTasksResult)
      .mockResolvedValueOnce({
        ok: true,
        snapshot: { delegates: [], museJobs: [running], bgCommands: [], sessionCrons: [] },
      })
      .mockResolvedValueOnce({
        ok: true,
        snapshot: { delegates: [], museJobs: [running], bgCommands: [], sessionCrons: [] },
      })
      .mockResolvedValueOnce({
        ok: true,
        snapshot: { delegates: [], museJobs: [done], bgCommands: [], sessionCrons: [] },
      });

    const { result } = renderHook(() =>
      useSessionBackgroundTasks({ sessionId: "s1", enabled: true, auth }),
    );
    await act(async () => {});
    expect(result.current.museJobs).toHaveLength(1);
    expect(fetchSessionBackgroundTasksResult).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(fetchSessionBackgroundTasksResult).toHaveBeenCalledTimes(2);

    vis = "hidden";
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(fetchSessionBackgroundTasksResult).toHaveBeenCalledTimes(2);

    vis = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fetchSessionBackgroundTasksResult).toHaveBeenCalledTimes(3);
    expect(result.current.museJobs[0]?.status).toBe("succeeded");

    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(fetchSessionBackgroundTasksResult).toHaveBeenCalledTimes(3);
  });

  test("Blocker 5: 首次 404 SESSION_NOT_FOUND（sessionNotReady）不永久拉黑，下一次 refreshTrigger 自动拉回任务", async () => {
    vi.useFakeTimers();
    const cmd = bgCmd();
    const cron = cronItem();
    vi.mocked(fetchSessionBackgroundTasksResult)
      .mockResolvedValueOnce({ ok: false, routeMissing: false, sessionNotReady: true })
      .mockResolvedValueOnce({
        ok: true,
        snapshot: { delegates: [], museJobs: [], bgCommands: [cmd], sessionCrons: [cron] },
      });

    const { result, rerender } = renderHook(
      ({ refreshTrigger }) =>
        useSessionBackgroundTasks({ sessionId: "s-new", enabled: true, auth, refreshTrigger }),
      { initialProps: { refreshTrigger: 0 } },
    );
    await act(async () => {});
    expect(result.current.hasAny).toBe(false);
    expect(fetchSessionBackgroundTasksResult).toHaveBeenCalledTimes(1);

    // 首轮发送/完成后触发 refreshTrigger，未被拉黑，正常拉回后台任务
    rerender({ refreshTrigger: 1 });
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(fetchSessionBackgroundTasksResult).toHaveBeenCalledTimes(2);
    expect(result.current.bgCommands).toEqual([cmd]);
    expect(result.current.sessionCrons).toEqual([cron]);
    expect(result.current.hasAny).toBe(true);
  });

  test("缺路由 404（routeMissing）静默降级停止后续拉取，且不影响当前会话 mediaJobs", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchSessionBackgroundTasksResult).mockResolvedValue({
      ok: false,
      routeMissing: true,
      sessionNotReady: false,
    });

    const liveMap = new Map<string, MediaGenerationJob>([
      ["mj-1", mediaJob({ id: "mj-1", sessionId: "s1" })],
      ["mj-other", mediaJob({ id: "mj-other", sessionId: "s2" })],
    ]);

    const { result, rerender } = renderHook(
      ({ refreshTrigger }) =>
        useSessionBackgroundTasks({
          sessionId: "s1",
          enabled: true,
          auth,
          liveMediaJobs: liveMap,
          refreshTrigger,
        }),
      { initialProps: { refreshTrigger: 0 } },
    );
    await act(async () => {});
    expect(result.current.museJobs).toEqual([]);
    expect(result.current.bgCommands).toEqual([]);
    expect(result.current.sessionCrons).toEqual([]);
    expect(result.current.mediaJobs.map((j) => j.id)).toEqual(["mj-1"]);
    expect(result.current.hasAny).toBe(true);

    // 后续 refreshTrigger 不再重试已判定缺失的路由
    rerender({ refreshTrigger: 1 });
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(fetchSessionBackgroundTasksResult).toHaveBeenCalledTimes(1);
  });

  test("请求序号保护：在途旧轮询响应滞后到达时，绝不覆盖更新的取消快照", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");

    const cmd = bgCmd({ id: "42-ocb_1" });
    let resolveStalePoll!: (r: SessionBackgroundTasksFetchResult) => void;
    const stalePollPromise = new Promise<SessionBackgroundTasksFetchResult>((r) => {
      resolveStalePoll = r;
    });

    vi.mocked(fetchSessionBackgroundTasksResult)
      // 第 1 次：进会话拉到运行中的后台命令
      .mockResolvedValueOnce({
        ok: true,
        snapshot: { delegates: [], museJobs: [], bgCommands: [cmd], sessionCrons: [] },
      })
      // 第 2 次：5s 定时轮询发出但滞后（包含未取消前的旧快照）
      .mockReturnValueOnce(stalePollPromise)
      // 第 3 次：cancelBgCommand 成功后立刻触发的新拉取（已为空）
      .mockResolvedValueOnce({
        ok: true,
        snapshot: { delegates: [], museJobs: [], bgCommands: [], sessionCrons: [] },
      });

    vi.mocked(cancelSessionBgCommand).mockResolvedValueOnce({ ok: true, cancelled: true });

    const { result } = renderHook(() =>
      useSessionBackgroundTasks({ sessionId: "s1", enabled: true, auth }),
    );
    await act(async () => {});
    expect(result.current.bgCommands).toEqual([cmd]);

    // 触发第 2 次 5s 轮询（滞留在途）
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(fetchSessionBackgroundTasksResult).toHaveBeenCalledTimes(2);

    // 在途轮询尚未返回时，用户点击终止并成功，触发第 3 次拉取
    await act(async () => {
      expect(await result.current.cancelBgCommand("42-ocb_1")).toBe(true);
    });
    expect(fetchSessionBackgroundTasksResult).toHaveBeenCalledTimes(3);
    expect(result.current.bgCommands).toEqual([]);

    // 此时旧的在途轮询才返回包含 cmd 的过期快照 → 必须被丢弃，不能复活已终止命令
    await act(async () => {
      resolveStalePoll({
        ok: true,
        snapshot: { delegates: [], museJobs: [], bgCommands: [cmd], sessionCrons: [] },
      });
    });
    expect(result.current.bgCommands).toEqual([]);
  });

  test("行内干预动作：cancelMuseJob / cancelBgCommand / toggleSessionCron / deleteSessionCron / dismissMuseJob", async () => {
    const mRunning = museJob({ id: "m-run", status: "running" });
    const mDone = museJob({ id: "m-done", status: "succeeded" });
    const cmd = bgCmd({ id: "42-ocb_1" });
    const cron = cronItem({ id: "cron-1", enabled: true });

    vi.mocked(fetchSessionBackgroundTasksResult)
      .mockResolvedValueOnce({
        ok: true,
        snapshot: { delegates: [], museJobs: [mRunning, mDone], bgCommands: [cmd], sessionCrons: [cron] },
      })
      .mockResolvedValueOnce({
        ok: true,
        snapshot: {
          delegates: [],
          museJobs: [{ ...mRunning, status: "cancelled" }, mDone],
          bgCommands: [cmd],
          sessionCrons: [cron],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        snapshot: {
          delegates: [],
          museJobs: [{ ...mRunning, status: "cancelled" }, mDone],
          bgCommands: [],
          sessionCrons: [cron],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        snapshot: {
          delegates: [],
          museJobs: [{ ...mRunning, status: "cancelled" }, mDone],
          bgCommands: [],
          sessionCrons: [{ ...cron, enabled: false }],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        snapshot: {
          delegates: [],
          museJobs: [{ ...mRunning, status: "cancelled" }, mDone],
          bgCommands: [],
          sessionCrons: [],
        },
      });

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
    expect(fetchSessionOriginCrons).not.toHaveBeenCalled();

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

    rerender({ activeId: "s2", latestSwarm: null, version: 2 });
    expect(result.current.has("s1")).toBe(true);

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

    msgs.push({ id: "d1", role: "agent-group", text: "", ts: 1 } as ChatMessage);
    rerender({ wsSending: true, wsMessages: msgs, chatVersion: 2, mediaJobVersion: 0 });
    expect(result.current.delegateRefreshTrigger).toBe(1);
    expect(result.current.bgTasksRefreshTrigger).toBe(0);

    rerender({ wsSending: false, wsMessages: msgs, chatVersion: 3, mediaJobVersion: 0 });
    expect(result.current.delegateRefreshTrigger).toBe(2);
    expect(result.current.bgTasksRefreshTrigger).toBe(1);

    rerender({ wsSending: false, wsMessages: msgs, chatVersion: 3, mediaJobVersion: 1 });
    expect(result.current.bgTasksRefreshTrigger).toBe(2);
  });
});
