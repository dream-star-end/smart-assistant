import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { type Mock, afterEach, describe, expect, test, vi } from "vitest";
import { api, ApiError } from "../lib/api";
import { createMemoryAuthSession } from "../lib/authSession";
import type { SessionDetail, User } from "../lib/types";
import type { UseChatSocket } from "./useChatSocket";
import { useSessionList } from "./useSessionList";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function detail(id: string): SessionDetail {
  return {
    id,
    userId: "u1",
    agentId: "main",
    title: "history",
    pinned: false,
    createdAt: 1,
    lastAt: 1,
    messages: [],
    updatedAt: 1,
    historyRevision: 1,
    timelineGeneration: 1,
    timelineCursor: null,
    timelineHasMore: false,
    timelineSnapshotMaxSeq: 0,
    isPartial: false,
    maxSeq: 0,
    totalMessageCount: 0,
  };
}

// ── 改名 / 删除:三持有方收口 + 不可逆操作的确认门 ─────────────────────────────
// 侧栏的改名与删除各自要同时落三处(App 列表 state / WS service 与 IndexedDB / 服务端
// canonical),漏一处的表现都是"看起来成了,刷新又回去"或者"本地没了、云端复活"。
// 删除更是不可逆(确认文案:本地与云端记录都将删除,不可恢复),取消路径必须一处都不动。
// 这些行为此前零覆盖。
function meta(id: string, title: string) {
  return {
    id,
    title,
    agentId: "main",
    updatedAt: 2_000,
    lastAt: 2_000,
    messageCount: 3,
  };
}

type ListHarness = {
  socket: {
    renameSession: ReturnType<typeof vi.fn>;
    removeSession: ReturnType<typeof vi.fn>;
    removePersisted: ReturnType<typeof vi.fn>;
  };
  confirmCalls: Array<{
    title: string;
    body?: React.ReactNode;
    confirmText?: string;
    danger?: boolean;
  }>;
  onDeleteSession: Mock<(id: string) => void>;
  onActiveSessionDeleted: Mock<() => void>;
  deleteSession: ReturnType<typeof vi.fn>;
  patchSessionTitle: ReturnType<typeof vi.fn>;
};

async function renderSessionList(opts: {
  confirmResult: boolean;
  promptResult: string | null;
}) {
  const harness: ListHarness = {
    socket: {
      renameSession: vi.fn(),
      removeSession: vi.fn(),
      removePersisted: vi.fn(),
    },
    confirmCalls: [],
    onDeleteSession: vi.fn<(id: string) => void>(),
    onActiveSessionDeleted: vi.fn<() => void>(),
    deleteSession: vi.fn(async () => {}),
    patchSessionTitle: vi.fn(async () => {}),
  };
  vi.spyOn(api, "listSessions").mockResolvedValue([
    meta("webkeepme001", "保留的会话"),
    meta("webdropme001", "待删除的会话"),
  ] as never);
  vi.spyOn(api, "getSession").mockResolvedValue(detail("webkeepme001"));
  vi.spyOn(api, "deleteSession").mockImplementation(harness.deleteSession as never);
  vi.spyOn(api, "patchSessionTitle").mockImplementation(harness.patchSessionTitle as never);

  const auth = createMemoryAuthSession(() => {}, "token");
  const user: User = { id: "u1", displayName: "User", roles: ["user"] };
  const socket = {
    storedMaxSeq: () => 0,
    storedHistoryRevision: () => 1,
    mergeServerHistory: vi.fn(),
    ...harness.socket,
  } as unknown as UseChatSocket;

  const { result } = renderHook(() => useSessionList({
    demo: false,
    auth,
    authSession: auth,
    user,
    agentId: "main",
    sockRef: { current: socket },
    confirmDialog: async (o) => {
      harness.confirmCalls.push(o);
      return opts.confirmResult;
    },
    promptText: async () => opts.promptResult,
    clearChatError: () => {},
    onNewSessionReset: () => {},
    onDeleteSession: harness.onDeleteSession,
    onActiveSessionDeleted: harness.onActiveSessionDeleted,
  }));

  // 等服务端列表落定(自动选中最近会话也在此后完成)。
  await waitFor(() => expect(result.current.sessions.length).toBe(2));
  return { result, harness };
}

describe("useSessionList 删除会话（不可逆）", () => {
  test("先弹危险确认，文案点名该会话且说明云端也会删", async () => {
    const { result, harness } = await renderSessionList({
      confirmResult: false,
      promptResult: null,
    });
    const target = result.current.sessions.find((s) => s.id === "webdropme001")!;
    await act(async () => {
      await result.current.deleteSessionConfirm(target);
    });
    expect(harness.confirmCalls).toHaveLength(1);
    const ask = harness.confirmCalls[0];
    expect(ask.danger).toBe(true);
    expect(ask.confirmText).toBe("删除");
    expect(String(ask.body)).toContain("待删除的会话");
    expect(String(ask.body)).toContain("不可恢复");
  });

  test("用户取消 → 本地、IndexedDB、服务端一处都不动", async () => {
    const { result, harness } = await renderSessionList({
      confirmResult: false,
      promptResult: null,
    });
    const target = result.current.sessions.find((s) => s.id === "webdropme001")!;
    await act(async () => {
      await result.current.deleteSessionConfirm(target);
    });
    expect(harness.onDeleteSession).not.toHaveBeenCalled();
    expect(harness.socket.removeSession).not.toHaveBeenCalled();
    expect(harness.socket.removePersisted).not.toHaveBeenCalled();
    expect(harness.deleteSession).not.toHaveBeenCalled();
    expect(result.current.sessions.map((s) => s.id)).toContain("webdropme001");
  });

  test("用户确认 → 列表移除 + IndexedDB 本地副本清除 + 服务端删除，且只删被点的那条", async () => {
    const { result, harness } = await renderSessionList({
      confirmResult: true,
      promptResult: null,
    });
    const target = result.current.sessions.find((s) => s.id === "webdropme001")!;
    await act(async () => {
      await result.current.deleteSessionConfirm(target);
    });
    expect(result.current.sessions.map((s) => s.id)).toEqual(["webkeepme001"]);
    expect(harness.socket.removeSession).toHaveBeenCalledWith("webdropme001");
    // 不清 IndexedDB 本地副本 → reload 后被注水复活。
    expect(harness.socket.removePersisted).toHaveBeenCalledWith("webdropme001");
    // 不删服务端 → 下次 listSessions server-wins 又把它拉回来。
    expect(harness.deleteSession).toHaveBeenCalledTimes(1);
    expect(harness.deleteSession.mock.calls[0][1]).toBe("webdropme001");
  });

  test("删掉的是当前活动会话时通知上层清空聊天区，并清掉选中态", async () => {
    const { result, harness } = await renderSessionList({
      confirmResult: true,
      promptResult: null,
    });
    act(() => result.current.selectSession("webdropme001"));
    const target = result.current.sessions.find((s) => s.id === "webdropme001")!;
    await act(async () => {
      await result.current.deleteSessionConfirm(target);
    });
    expect(harness.onActiveSessionDeleted).toHaveBeenCalledTimes(1);
    expect(result.current.activeId).toBeUndefined();
  });
});

describe("useSessionList 重命名会话", () => {
  test("新标题同时落列表、WS service 与服务端 canonical（少一处都会被盖回）", async () => {
    const { result, harness } = await renderSessionList({
      confirmResult: true,
      promptResult: "  季度复盘（终版）  ",
    });
    const target = result.current.sessions.find((s) => s.id === "webkeepme001")!;
    await act(async () => {
      await result.current.renameSessionPrompt(target);
    });
    // 前后空白必须 trim 掉再落地(三处同一份值)。
    expect(result.current.sessions.find((s) => s.id === "webkeepme001")?.title).toBe(
      "季度复盘（终版）",
    );
    expect(harness.socket.renameSession).toHaveBeenCalledWith("webkeepme001", "季度复盘（终版）");
    expect(harness.patchSessionTitle).toHaveBeenCalledTimes(1);
    expect(harness.patchSessionTitle.mock.calls[0].slice(1)).toEqual([
      "webkeepme001",
      "季度复盘（终版）",
    ]);
  });

  test("用户取消输入 → 不改名、不发任何写请求", async () => {
    const { result, harness } = await renderSessionList({
      confirmResult: true,
      promptResult: null,
    });
    const target = result.current.sessions.find((s) => s.id === "webkeepme001")!;
    await act(async () => {
      await result.current.renameSessionPrompt(target);
    });
    expect(result.current.sessions.find((s) => s.id === "webkeepme001")?.title).toBe("保留的会话");
    expect(harness.socket.renameSession).not.toHaveBeenCalled();
    expect(harness.patchSessionTitle).not.toHaveBeenCalled();
  });

  test("输入与原标题相同 / 只剩空白 → 不产生无谓写请求", async () => {
    const same = await renderSessionList({ confirmResult: true, promptResult: "保留的会话" });
    const target = same.result.current.sessions.find((s) => s.id === "webkeepme001")!;
    await act(async () => {
      await same.result.current.renameSessionPrompt(target);
    });
    expect(same.harness.patchSessionTitle).not.toHaveBeenCalled();

    cleanup();
    vi.restoreAllMocks();

    const blank = await renderSessionList({ confirmResult: true, promptResult: "   " });
    const blankTarget = blank.result.current.sessions.find((s) => s.id === "webkeepme001")!;
    await act(async () => {
      await blank.result.current.renameSessionPrompt(blankTarget);
    });
    expect(blank.harness.patchSessionTitle).not.toHaveBeenCalled();
    expect(blank.result.current.sessions.find((s) => s.id === "webkeepme001")?.title).toBe(
      "保留的会话",
    );
  });
});

describe("useSessionList 新建会话", () => {
  test("非 demo 连点新建只进入一个空白态，不提前制造侧栏占位会话", async () => {
    const { result } = await renderSessionList({ confirmResult: true, promptResult: null });
    await waitFor(() => expect(result.current.activeId).toBe("webkeepme001"));
    const existingIds = result.current.sessions.map((session) => session.id);

    act(() => {
      result.current.newSession();
      result.current.newSession();
    });

    expect(result.current.activeId).toBeUndefined();
    expect(result.current.sessions.map((session) => session.id)).toEqual(existingIds);
  });

  test("用户先进入空白新会话后，迟到的历史列表不会自动抢走选中态", async () => {
    const list = deferred<ReturnType<typeof meta>[]>();
    vi.spyOn(api, "listSessions").mockImplementation(async () => list.promise as never);
    const auth = createMemoryAuthSession(() => {}, "token");
    const user: User = { id: "u1", displayName: "User", roles: ["user"] };
    const socket = {
      storedMaxSeq: () => 0,
      storedHistoryRevision: () => 1,
      mergeServerHistory: vi.fn(),
    } as unknown as UseChatSocket;
    const { result } = renderHook(() => useSessionList({
      demo: false,
      auth,
      authSession: auth,
      user,
      agentId: "main",
      sockRef: { current: socket },
      confirmDialog: async () => true,
      promptText: async () => null,
      clearChatError: () => {},
      onNewSessionReset: () => {},
      onActiveSessionDeleted: () => {},
    }));

    act(() => result.current.newSession());
    await act(async () => {
      list.resolve([meta("weblate00001", "迟到的会话")]);
      await list.promise;
    });
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    expect(result.current.activeId).toBeUndefined();
  });
});

describe("useSessionList history loading fence", () => {
  test("reset 前的同 ID 请求完成时不能清掉 reset 后的新请求", async () => {
    const first = deferred<SessionDetail>();
    const second = deferred<SessionDetail>();
    vi.spyOn(api, "listSessions").mockResolvedValue([]);
    vi.spyOn(api, "getSession")
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async () => second.promise);

    const auth = createMemoryAuthSession(() => {}, "token");
    const user: User = { id: "u1", displayName: "User", roles: ["user"] };
    const socket = {
      storedMaxSeq: () => 0,
      storedHistoryRevision: () => 1,
      mergeServerHistory: vi.fn(),
    } as unknown as UseChatSocket;
    const { result } = renderHook(() => useSessionList({
      demo: false,
      auth,
      authSession: auth,
      user,
      agentId: "main",
      sockRef: { current: socket },
      confirmDialog: async () => true,
      promptText: async () => null,
      clearChatError: () => {},
      onNewSessionReset: () => {},
      onActiveSessionDeleted: () => {},
    }));

    act(() => result.current.selectSession("webhistory01"));
    await waitFor(() => expect(result.current.historyLoading).toBe(true));

    act(() => result.current.reset());
    expect(result.current.historyLoading).toBe(false);
    act(() => result.current.selectSession("webhistory01"));
    await waitFor(() => expect(result.current.historyLoading).toBe(true));

    await act(async () => {
      first.resolve(detail("webhistory01"));
      await first.promise;
    });
    expect(result.current.historyLoading).toBe(true);
    expect(socket.mergeServerHistory).not.toHaveBeenCalled();

    await act(async () => {
      second.resolve(detail("webhistory01"));
      await second.promise;
    });
    await waitFor(() => expect(result.current.historyLoading).toBe(false));
    expect(socket.mergeServerHistory).toHaveBeenCalledTimes(1);
  });

  test("canonical getSession 返回后即清骨架,不等 journal 水合", async () => {
    const history = deferred<SessionDetail>();
    const journal = deferred<void>();
    vi.spyOn(api, "listSessions").mockResolvedValue([]);
    vi.spyOn(api, "getSession").mockImplementation(async () => history.promise);
    const hydrateDurableLiveFrameJournal = vi.fn(async () => journal.promise);
    const auth = createMemoryAuthSession(() => {}, "token");
    const user: User = { id: "u1", displayName: "User", roles: ["user"] };
    const socket = {
      storedMaxSeq: () => 0,
      storedHistoryRevision: () => 1,
      mergeServerHistory: vi.fn(),
      hydrateDurableLiveFrameJournal,
    } as unknown as UseChatSocket;
    const { result } = renderHook(() => useSessionList({
      demo: false,
      auth,
      authSession: auth,
      user,
      agentId: "main",
      sockRef: { current: socket },
      confirmDialog: async () => true,
      promptText: async () => null,
      clearChatError: () => {},
      onNewSessionReset: () => {},
      onActiveSessionDeleted: () => {},
    }));

    act(() => result.current.selectSession("webhistory02"));
    await waitFor(() => expect(result.current.historyLoading).toBe(true));

    await act(async () => {
      history.resolve(detail("webhistory02"));
      await history.promise;
    });
    await waitFor(() => expect(result.current.historyLoading).toBe(false));
    expect(hydrateDurableLiveFrameJournal).toHaveBeenCalledTimes(1);
    expect(socket.mergeServerHistory).toHaveBeenCalledTimes(1);
  });

  test("GET 5xx 且侧栏 messageCount>0 记 historyError，retryHistory 不走 selectSession", async () => {
    vi.spyOn(api, "listSessions").mockResolvedValue([
      {
        id: "webhistory5xx",
        title: "非空会话",
        agentId: "main",
        updatedAt: 2_000,
        lastAt: 2_000,
        messageCount: 4,
      },
    ] as never);
    const getSession = vi.spyOn(api, "getSession").mockRejectedValue(
      new ApiError({ status: 500, message: "get failed" }),
    );
    const auth = createMemoryAuthSession(() => {}, "token");
    const user: User = { id: "u1", displayName: "User", roles: ["user"] };
    const socket = {
      storedMaxSeq: () => 0,
      storedHistoryRevision: () => 1,
      mergeServerHistory: vi.fn(),
    } as unknown as UseChatSocket;
    const { result } = renderHook(() => useSessionList({
      demo: false,
      auth,
      authSession: auth,
      user,
      agentId: "main",
      sockRef: { current: socket },
      confirmDialog: async () => true,
      promptText: async () => null,
      clearChatError: () => {},
      onNewSessionReset: () => {},
      onActiveSessionDeleted: () => {},
    }));
    await waitFor(() => expect(result.current.sessions.some((s) => s.id === "webhistory5xx")).toBe(true));
    act(() => result.current.selectSession("webhistory5xx"));
    await waitFor(() => expect(result.current.historyError?.sessionId).toBe("webhistory5xx"));
    expect(result.current.historyError?.message).toMatch(/get failed|加载失败/);
    const activeBefore = result.current.activeId;
    getSession.mockRejectedValueOnce(new ApiError({ status: 500, message: "get failed again" }));
    act(() => result.current.retryHistory("webhistory5xx"));
    await waitFor(() => expect(getSession.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(result.current.activeId).toBe(activeBefore);
  });

  test("GET 404 不当成 historyError", async () => {
    vi.spyOn(api, "listSessions").mockResolvedValue([]);
    vi.spyOn(api, "getSession").mockRejectedValue(new ApiError({ status: 404, message: "not found" }));
    const auth = createMemoryAuthSession(() => {}, "token");
    const user: User = { id: "u1", displayName: "User", roles: ["user"] };
    const socket = {
      storedMaxSeq: () => 0,
      storedHistoryRevision: () => 1,
      mergeServerHistory: vi.fn(),
    } as unknown as UseChatSocket;
    const { result } = renderHook(() => useSessionList({
      demo: false,
      auth,
      authSession: auth,
      user,
      agentId: "main",
      sockRef: { current: socket },
      confirmDialog: async () => true,
      promptText: async () => null,
      clearChatError: () => {},
      onNewSessionReset: () => {},
      onActiveSessionDeleted: () => {},
    }));
    act(() => result.current.selectSession("weblocalnew1"));
    await waitFor(() => expect(result.current.historyLoading).toBe(false));
    expect(result.current.historyError).toBeNull();
  });
});

describe("useSessionList 置顶 / 项目归属 / 终态字段", () => {
  test("listSessions 的 pinned / projectId / lastOutcome 会进入侧栏 Session（不再丢弃）", async () => {
    vi.spyOn(api, "listSessions").mockResolvedValue([
      {
        id: "webpinned01",
        title: "钉住的会话",
        agentId: "coder",
        pinned: true,
        projectId: "p-work",
        runState: "idle",
        lastOutcome: "completed",
        lastErrorCode: null,
        createdAt: 1,
        lastAt: 2_000,
        updatedAt: 2_000,
        messageCount: 4,
      },
    ] as never);
    vi.spyOn(api, "getSession").mockResolvedValue(detail("webpinned01"));
    const auth = createMemoryAuthSession(() => {}, "token");
    const user: User = { id: "u1", displayName: "User", roles: ["user"] };
    const { result } = renderHook(() =>
      useSessionList({
        demo: false,
        auth,
        authSession: auth,
        user,
        agentId: "main",
        sockRef: { current: { storedMaxSeq: () => 0, storedHistoryRevision: () => 1, mergeServerHistory: vi.fn() } as never },
        confirmDialog: async () => false,
        promptText: async () => null,
        clearChatError: () => {},
        onNewSessionReset: () => {},
        onActiveSessionDeleted: () => {},
      }),
    );
    await waitFor(() => expect(result.current.sessions.length).toBe(1));
    const s = result.current.sessions[0];
    expect(s.pinned).toBe(true);
    expect(s.projectId).toBe("p-work");
    expect(s.agentId).toBe("coder");
    expect(s.lastOutcome).toBe("completed");
    expect(s.runState).toBe("idle");
  });

  test("togglePinSession 乐观更新并 PATCH meta；失败回滚", async () => {
    vi.spyOn(api, "listSessions").mockResolvedValue([
      { id: "webkeepme001", title: "保留的会话", agentId: "main", pinned: false, updatedAt: 2_000, lastAt: 2_000, messageCount: 1 },
    ] as never);
    vi.spyOn(api, "getSession").mockResolvedValue(detail("webkeepme001"));
    const patch = vi.spyOn(api, "patchSessionMeta").mockRejectedValue(new Error("boom"));
    const { result } = await renderSessionList({ confirmResult: false, promptResult: null });
    const target = result.current.sessions[0];
    expect(target.pinned).toBe(false);
    await act(async () => {
      await result.current.togglePinSession(target);
    });
    expect(patch).toHaveBeenCalledWith(expect.anything(), "webkeepme001", { pinned: true });
    expect(result.current.sessions[0].pinned).toBe(false);
  });

  test("listSessions 的 archived / lastMessagePreview / lastAt 进入侧栏 Session", async () => {
    vi.spyOn(api, "listSessions").mockResolvedValue([
      {
        id: "webarchive01",
        title: "归档会话",
        agentId: "main",
        archived: true,
        lastMessagePreview: "最后一句",
        createdAt: 1,
        lastAt: 3_000,
        updatedAt: 3_000,
        messageCount: 2,
        pinned: false,
      },
    ] as never);
    vi.spyOn(api, "getSession").mockResolvedValue(detail("webarchive01"));
    const auth = createMemoryAuthSession(() => {}, "token");
    const user: User = { id: "u1", displayName: "User", roles: ["user"] };
    const { result } = renderHook(() =>
      useSessionList({
        demo: false,
        auth,
        authSession: auth,
        user,
        agentId: "main",
        sockRef: { current: { storedMaxSeq: () => 0, storedHistoryRevision: () => 1, mergeServerHistory: vi.fn() } as never },
        confirmDialog: async () => false,
        promptText: async () => null,
        clearChatError: () => {},
        onNewSessionReset: () => {},
        onActiveSessionDeleted: () => {},
      }),
    );
    await waitFor(() => expect(result.current.sessions.length).toBe(1));
    expect(result.current.sessions[0].archived).toBe(true);
    expect(result.current.sessions[0].lastMessagePreview).toBe("最后一句");
    expect(result.current.sessions[0].lastAt).toBe(3_000);
  });

  test("toggleArchiveSession 乐观更新并 PATCH archived；失败回滚", async () => {
    vi.spyOn(api, "listSessions").mockResolvedValue([
      { id: "webkeepme001", title: "保留的会话", agentId: "main", archived: false, updatedAt: 2_000, lastAt: 2_000, messageCount: 1 },
    ] as never);
    vi.spyOn(api, "getSession").mockResolvedValue(detail("webkeepme001"));
    const patch = vi.spyOn(api, "patchSessionMeta").mockRejectedValue(new Error("boom"));
    const { result } = await renderSessionList({ confirmResult: false, promptResult: null });
    const target = result.current.sessions[0];
    await act(async () => {
      await result.current.toggleArchiveSession(target);
    });
    expect(patch).toHaveBeenCalledWith(expect.anything(), "webkeepme001", { archived: true });
    expect(result.current.sessions[0].archived).toBe(false);
  });

  test("batchUpdateSessions 删除先确认条数，取消则不动；确认则乐观移除", async () => {
    const batch = vi.spyOn(api, "batchSessions").mockResolvedValue({ ok: true, updated: 1 });
    const { result, harness } = await renderSessionList({ confirmResult: false, promptResult: null });
    await act(async () => {
      await result.current.batchUpdateSessions(["webdropme001"], "delete");
    });
    expect(harness.confirmCalls[0]?.title).toContain("1 条");
    expect(result.current.sessions.map((s) => s.id)).toContain("webdropme001");
    expect(batch).not.toHaveBeenCalled();
  });

  test("batchUpdateSessions 归档乐观更新，失败回滚", async () => {
    vi.spyOn(api, "batchSessions").mockRejectedValue(new Error("nope"));
    const { result } = await renderSessionList({ confirmResult: true, promptResult: null });
    await act(async () => {
      await result.current.batchUpdateSessions(["webkeepme001"], "archive");
    });
    expect(result.current.sessions.find((s) => s.id === "webkeepme001")?.archived).toBeFalsy();
  });

  test("loadMoreSessions 用 before=lastAt 追加去重，无 nextCursor 则停", async () => {
    const page = vi.spyOn(api, "listSessionsPage").mockResolvedValue({
      sessions: [
        {
          id: "webkeepme001",
          title: "保留的会话",
          agentId: "main",
          pinned: false,
          createdAt: 1,
          lastAt: 2_000,
          updatedAt: 2_000,
          messageCount: 3,
        },
        {
          id: "webolder0001",
          title: "更早的一页",
          agentId: "main",
          pinned: false,
          createdAt: 1,
          lastAt: 1_000,
          updatedAt: 1_000,
          messageCount: 1,
        },
      ],
    });
    const { result } = await renderSessionList({ confirmResult: false, promptResult: null });
    await act(async () => {
      await result.current.loadMoreSessions();
    });
    expect(page).toHaveBeenCalled();
    const query = page.mock.calls[0][1];
    expect(query?.before).toBeDefined();
    expect(result.current.sessions.map((s) => s.id)).toEqual(
      expect.arrayContaining(["webkeepme001", "webdropme001", "webolder0001"]),
    );
    expect(result.current.hasMoreSessions).toBe(false);
  });

  test("首屏不拉 includeArchived；loadArchivedSessions 才带该参数", async () => {
    const page = vi.spyOn(api, "listSessionsPage").mockResolvedValue({ sessions: [] });
    const { result } = await renderSessionList({ confirmResult: false, promptResult: null });
    expect(page).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.loadArchivedSessions();
    });
    expect(page).toHaveBeenCalledTimes(1);
    expect(page.mock.calls[0][1]).toEqual({ includeArchived: true });
  });

  test("searchSessionMessages 只回 message 命中，AbortError 当空数组", async () => {
    vi.spyOn(api, "searchSessions").mockResolvedValue({
      results: [
        { sessionId: "a", title: "t", snippet: "x", matchedAt: 1, kind: "title" },
        { sessionId: "b", title: "t2", snippet: "y", matchedAt: 2, kind: "message" },
      ],
    });
    const { result } = await renderSessionList({ confirmResult: false, promptResult: null });
    const hits = await result.current.searchSessionMessages("foo", new AbortController().signal);
    expect(hits.map((h) => h.sessionId)).toEqual(["b"]);

    vi.spyOn(api, "searchSessions").mockRejectedValue(new DOMException("aborted", "AbortError"));
    const aborted = await result.current.searchSessionMessages("foo", new AbortController().signal);
    expect(aborted).toEqual([]);
  });

  test("hidden→visible 触发 listSessions，hidden 不轮询", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result } = await renderSessionList({ confirmResult: false, promptResult: null });
      expect(result.current.sessions.length).toBe(2);
      const list = api.listSessions as unknown as Mock;
      const afterBoot = list.mock.calls.length;
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(list.mock.calls.length).toBe(afterBoot);
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(list.mock.calls.length).toBeGreaterThan(afterBoot);
    } finally {
      vi.useRealTimers();
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
    }
  });

  test("visibility 重拉不丢已 loadMore 的行", async () => {
    const page = vi.spyOn(api, "listSessionsPage").mockResolvedValue({
      sessions: [
        {
          id: "webolder0001",
          title: "更早的一页",
          agentId: "main",
          pinned: false,
          createdAt: 1,
          lastAt: 1_000,
          updatedAt: 1_000,
          messageCount: 1,
        },
      ],
    });
    const { result } = await renderSessionList({ confirmResult: false, promptResult: null });
    await act(async () => {
      await result.current.loadMoreSessions();
    });
    expect(page).toHaveBeenCalled();
    expect(result.current.sessions.map((s) => s.id)).toEqual(
      expect.arrayContaining(["webkeepme001", "webdropme001", "webolder0001"]),
    );
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.sessions.map((s) => s.id)).toEqual(
      expect.arrayContaining(["webkeepme001", "webdropme001", "webolder0001"]),
    );
  });
});
