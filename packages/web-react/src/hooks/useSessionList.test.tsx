import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../lib/api";
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
  onDeleteSession: ReturnType<typeof vi.fn>;
  onActiveSessionDeleted: ReturnType<typeof vi.fn>;
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
    onDeleteSession: vi.fn(),
    onActiveSessionDeleted: vi.fn(),
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
});
