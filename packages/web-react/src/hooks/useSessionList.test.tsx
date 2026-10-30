import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import React, { Component, useEffect, useMemo, useRef } from "react";
import ts from "typescript";
import { type Mock, afterEach, describe, expect, test, vi } from "vitest";
import * as sessionStatus from "../lib/sessionStatus";
import { ToastProvider } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { createMemoryAuthSession } from "../lib/authSession";
import type { SessionDetail, User } from "../lib/types";
import type { UseChatSocket } from "./useChatSocket";
import { addMessage } from "../lib/chat/model";
import { ChatSocket } from "../lib/chat/socket";
import { deriveLiveTerminalEndedAt, deriveLiveTerminalFromMessages } from "../lib/sessionStatus";
import { formatCompactDuration, sessionDurationWindow } from "../components/sidebar/compactDuration";
import { useSessionList } from "./useSessionList";

// OCV5-421: 历史读取的瞬时失败会静默重试;本文件用真实重试逻辑、零间隔,免得每条用例等 12 秒。
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    retryTransientRead: <T,>(run: () => Promise<T>, stillWanted: () => boolean) =>
      actual.retryTransientRead(run, stillWanted, [0, 0, 0]),
  };
});

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
  /** 包一层 ToastProvider，让失败路径的 toast 文案可在 DOM 上断言。 */
  withToasts?: boolean;
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
  }), opts.withToasts ? { wrapper: ToastProvider } : undefined);

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
    // 中文标点(UI-SPEC §6 #22:「,不可恢复」中英混用)。
    expect(ask.title).toBe("删除该会话？");
    expect(String(ask.body)).toContain("都将删除，不可恢复。");
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

  // UI-SPEC §6 #22:删除成功没有任何回执,行消失分不清是删了还是没刷新出来。
  test("服务端删除成功 → 给出成功提示", async () => {
    const { result } = await renderSessionList({
      confirmResult: true,
      promptResult: null,
      withToasts: true,
    });
    const target = result.current.sessions.find((s) => s.id === "webdropme001")!;
    await act(async () => {
      await result.current.deleteSessionConfirm(target);
    });
    expect(screen.getByRole("status").textContent).toContain("已删除「待删除的会话」");
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

  // USL-02：服务端删除失败此前静默，表现为「删了、刷新又复活」。现在告知 + 立刻重拉列表让它回到侧栏。
  test("服务端删除失败 → 报错 toast 并重拉列表，会话回到侧栏而不是刷新后诡异复活", async () => {
    const { result, harness } = await renderSessionList({
      confirmResult: true,
      promptResult: null,
      withToasts: true,
    });
    harness.deleteSession.mockImplementation(async () => {
      throw new ApiError({ status: 500, message: "boom" });
    });
    const list = api.listSessions as unknown as Mock;
    const before = list.mock.calls.length;
    const target = result.current.sessions.find((s) => s.id === "webdropme001")!;
    await act(async () => {
      await result.current.deleteSessionConfirm(target);
    });
    expect(screen.getByRole("alert").textContent).toContain("删除失败");
    expect(screen.queryByRole("status")).toBeNull();
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() =>
      expect(result.current.sessions.map((s) => s.id)).toContain("webdropme001"),
    );
  });
});

describe("useSessionList 重命名会话", () => {
  // USL-01：服务端失败此前被吞掉，60s 轮询 server-wins 后标题「自己变回去」。现在立刻回滚 + 告知。
  test("服务端 PATCH 失败 → 列表与 WS service 立刻回滚原标题，并给出失败 toast", async () => {
    const { result, harness } = await renderSessionList({
      confirmResult: true,
      promptResult: "改不成的标题",
      withToasts: true,
    });
    harness.patchSessionTitle.mockImplementation(async () => {
      throw new ApiError({ status: 500, message: "boom" });
    });
    const target = result.current.sessions.find((s) => s.id === "webkeepme001")!;
    await act(async () => {
      await result.current.renameSessionPrompt(target);
    });
    expect(result.current.sessions.find((s) => s.id === "webkeepme001")?.title).toBe("保留的会话");
    // 先乐观改名、失败后改回：WS service 两次都要同步。
    expect(harness.socket.renameSession.mock.calls).toEqual([
      ["webkeepme001", "改不成的标题"],
      ["webkeepme001", "保留的会话"],
    ]);
    expect(screen.getByRole("alert").textContent).toContain("重命名失败");
  });

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
  for (const agentId of ["main", "research-assistant"]) {
    for (const status of ["pending", "responded"] as const) {
      test(`permission recovery: empty incremental GET and tape reload forward ${agentId}/${status}`, async () => {
        const id = "webpermission185";
        const snapshot: NonNullable<SessionDetail["permissionPrompts"]> = {
          source: "pg",
          completeness: "complete",
          items: [{
            requestId: "permission-185",
            clientMessageId: "turn-185",
            toolUseId: "tool-185",
            toolName: "AskUserQuestion",
            inputJson: { questions: [{ question: "Continue?" }] },
            status,
            behavior: status === "responded" ? "allow" : null,
            reason: null,
            answers: null,
            expiresAt: Date.now() + 60_000,
            createdAt: 1,
            updatedAt: 2,
          }],
        };
        vi.spyOn(api, "listSessions").mockResolvedValue([]);
        const getSession = vi.spyOn(api, "getSession")
          .mockResolvedValueOnce({ ...detail(id), agentId, isPartial: true, permissionPrompts: snapshot })
          .mockResolvedValueOnce({ ...detail(id), agentId, permissionPrompts: snapshot });
        const mergeServerHistory = vi.fn();
        const socket = {
          storedMaxSeq: () => 10,
          storedHistoryRevision: () => 1,
          mergeServerHistory,
          hydrateDurableLiveFrameJournal: vi.fn(async (
            _id: string, _frames: unknown, reloadTape: () => Promise<void>,
          ) => reloadTape()),
        } as unknown as UseChatSocket;
        const auth = createMemoryAuthSession(() => {}, "token");
        const user: User = { id: "u1", displayName: "User", roles: ["user"] };
        const { result } = renderHook(() => useSessionList({
          demo: false, auth, authSession: auth, user, agentId,
          sockRef: { current: socket },
          confirmDialog: async () => true,
          promptText: async () => null,
          clearChatError: () => {},
          onNewSessionReset: () => {},
          onActiveSessionDeleted: () => {},
        }));
        act(() => result.current.selectSession(id));
        await waitFor(() => expect(mergeServerHistory).toHaveBeenCalledTimes(2));
        expect(getSession.mock.calls[0][2]).toBe(10);
        expect(mergeServerHistory).toHaveBeenNthCalledWith(1, expect.objectContaining({
          sessId: id, agentId, messages: [], full: false, permissionPrompts: snapshot,
        }));
        expect(mergeServerHistory).toHaveBeenNthCalledWith(2, expect.objectContaining({
          sessId: id, agentId, messages: [], full: true, permissionPrompts: snapshot,
        }));
      });
    }
  }

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
    // OCV5-421: 5xx 先静默重试 3 次,用尽才记 historyError;英文技术原文不外露。
    expect(getSession).toHaveBeenCalledTimes(4);
    expect(result.current.historyError?.message).toBe("会话加载失败，请重试");
    const activeBefore = result.current.activeId;
    getSession.mockRejectedValueOnce(new ApiError({ status: 500, message: "get failed again" }));
    act(() => result.current.retryHistory("webhistory5xx"));
    await waitFor(() => expect(getSession.mock.calls.length).toBeGreaterThanOrEqual(5));
    expect(result.current.activeId).toBe(activeBefore);
  });

  test("断网一次后恢复:静默重试成功,不出现 historyError(OCV5-421)", async () => {
    vi.spyOn(api, "listSessions").mockResolvedValue([
      { id: "webhistoryblip", title: "非空会话", agentId: "main", updatedAt: 2_000, lastAt: 2_000, messageCount: 4 },
    ] as never);
    const getSession = vi.spyOn(api, "getSession")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({ id: "webhistoryblip", messages: [] } as never);
    const auth = createMemoryAuthSession(() => {}, "token");
    const user: User = { id: "u1", displayName: "User", roles: ["user"] };
    const socket = {
      storedMaxSeq: () => 0,
      storedHistoryRevision: () => 1,
      mergeServerHistory: vi.fn(),
    } as unknown as UseChatSocket;
    const { result } = renderHook(() => useSessionList({
      demo: false, auth, authSession: auth, user, agentId: "main", sockRef: { current: socket },
      confirmDialog: async () => true, promptText: async () => null, clearChatError: () => {},
      onNewSessionReset: () => {}, onActiveSessionDeleted: () => {},
    }));
    await waitFor(() => expect(result.current.sessions.some((s) => s.id === "webhistoryblip")).toBe(true));
    act(() => result.current.selectSession("webhistoryblip"));
    // 第 1 次断网失败、第 2 次成功(之后可能还有正常的 tape 读取)。
    await waitFor(() => expect(getSession.mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(result.current.historyLoading).toBeFalsy());
    expect(result.current.historyError).toBeFalsy();
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

  test("listSessions 的 archived / lastMessagePreview / createdAt / lastAt 进入侧栏 Session", async () => {
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
    expect(result.current.sessions[0].createdAt).toBe(1);
    expect(result.current.sessions[0].lastAt).toBe(3_000);
  });

  // 侧栏用时 = createdAt → lastAt：本 tab 刚跑完的回合，列表 lastAt 还停在回合开始前（下一轮刷新 ≤60s 才更新），
  // 行会从「运行中算到现在」跌回旧值。终态带上本 tab 看到的结束时刻；只前进不后退，也不重复标未读。
  test("迟到 REST 终态与本地观察时间补齐：优先采用真实终态时刻，且列表刷新后不被保留的 liveTerminal 覆盖 (#1254)", async () => {
    const id = "weblatedone01";
    const start = Date.parse("2026-10-30T10:00:00Z");
    const end = Date.parse("2026-10-30T10:02:00Z");
    const observed = Date.parse("2026-10-30T11:00:00Z");
    const socket = new ChatSocket({
      getToken: () => "test-token",
      getAuthEpoch: () => 0,
      silentRefresh: async (epoch) => ({ kind: "transient", epoch, retryAfterMs: 500 }),
      onAuthExpired: () => {},
      defaultAgentId: "main",
    });
    try {
      const session = socket.ensureSession(id, "main", "迟到的终态");
      const userMessage = addMessage(session, "user", "两分钟任务", { status: "sent" });
      session.createdAt = start;
      session.lastAt = start;
      session._sendingInFlight = true;
      session._activeClientMessageId = userMessage.id;
      expect(socket.isSessionBusy(id)).toBe(true);

      vi.spyOn(api, "listSessions").mockResolvedValue([
        {
          id,
          title: "迟到的终态",
          agentId: "main",
          createdAt: start,
          lastAt: end,
          updatedAt: end,
          messageCount: 2,
          runState: "idle",
          lastOutcome: "completed",
          lastErrorCode: null,
        },
      ] as never);
      const auth = createMemoryAuthSession(() => {}, "test-token");
      const user: User = { id: "u1", displayName: "User", roles: ["user"] };
      const { result } = renderHook(() =>
        useSessionList({
          demo: false,
          auth,
          authSession: auth,
          user,
          agentId: "main",
          holdAutoSelect: true,
          sockRef: { current: {} as never },
          confirmDialog: async () => false,
          promptText: async () => null,
          clearChatError: () => {},
          onNewSessionReset: () => {},
          onDeleteSession: () => {},
          onActiveSessionDeleted: () => {},
        }),
      );
      const row = () => result.current.sessions.find((s) => s.id === id)!;
      await waitFor(() => expect(row()?.lastAt).toBe(end));

      socket.applyServerMessages(
        id,
        "main",
        [
          {
            id: "late-final",
            role: "assistant",
            text: "完成",
            ts: end,
            completedAt: end,
            _source: "server",
            _clientMessageId: userMessage.id,
            _turnTapeComplete: true,
            _dispatchOutcome: "completed",
          },
        ],
        true,
        2,
        { serverUpdatedAt: end },
      );
      expect(socket.isSessionBusy(id)).toBe(false);
      const msgs = socket.sessions.get(id)!.messages;
      const terminal = deriveLiveTerminalFromMessages(msgs);
      expect(terminal).toEqual({ lastOutcome: "completed", lastErrorCode: null });

      vi.spyOn(Date, "now").mockReturnValue(observed);
      expect(deriveLiveTerminalEndedAt(msgs)).toBe(end);

      // 即使调用方传入本地观察时刻作为临时补齐，权威列表刷新后重放保留的 liveTerminal 也必须保持服务端 2 分。
      const observedTerminal = { ...terminal!, endedAt: Date.now() };
      act(() => result.current.applySessionTerminal(id, observedTerminal));
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await waitFor(() => expect(row().lastAt).toBe(end));
      act(() => result.current.applySessionTerminal(id, observedTerminal));
      const win = sessionDurationWindow(row(), false, observed)!;
      expect(formatCompactDuration(win.endAt - win.startAt)).toBe("2分");
    } finally {
      socket.stop();
    }
  });

  test("applySessionTerminal 用本 tab 的结束时刻补齐 lastAt，不倒退、不重复标未读", async () => {
    const { result } = await renderSessionList({ confirmResult: false, promptResult: null });
    const row = () => result.current.sessions.find((s) => s.id === "webkeepme001")!;
    expect(row().lastAt).toBe(2_000);
    act(() => result.current.applySessionTerminal("webkeepme001", { lastOutcome: "completed", lastErrorCode: null, endedAt: 9_000 }));
    expect(row()).toMatchObject({ lastAt: 9_000, runState: "idle", lastOutcome: "completed", unread: true });
    // 用户点开读过（未读由 useUnreadSessions 清，这里直接改列表模拟）。
    act(() => result.current.setSessions((c) => c.map((x) => (x.id === "webkeepme001" ? { ...x, unread: false } : x))));
    act(() => result.current.applySessionTerminal("webkeepme001", { lastOutcome: "completed", lastErrorCode: null, endedAt: 5_000 }));
    expect(row().lastAt).toBe(9_000);
    act(() => result.current.applySessionTerminal("webkeepme001", { lastOutcome: "completed", lastErrorCode: null, endedAt: 12_000 }));
    expect(row()).toMatchObject({ lastAt: 12_000, unread: false });
    expect(result.current.sessions.find((s) => s.id === "webdropme001")!.lastAt).toBe(2_000);
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
    expect(harness.confirmCalls[0]?.title).toBe("删除 1 条会话？");
    expect(result.current.sessions.map((s) => s.id)).toContain("webdropme001");
    expect(batch).not.toHaveBeenCalled();
  });

  test("batchUpdateSessions 删除成功 → 给出条数回执", async () => {
    const batch = vi.spyOn(api, "batchSessions").mockResolvedValue({ ok: true, updated: 2 });
    const { result } = await renderSessionList({
      confirmResult: true,
      promptResult: null,
      withToasts: true,
    });
    await act(async () => {
      await result.current.batchUpdateSessions(["webdropme001", "webkeepme001"], "delete");
    });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(result.current.sessions).toEqual([]);
    expect(screen.getByRole("status").textContent).toContain("已删除 2 条会话");
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

  // S-08：分页失败此前直接 hasMore=false，更早的会话永远拉不到。现在保留 hasMore + 暴露 loadMoreError。
  test("loadMoreSessions 失败保留 hasMore 并置 loadMoreError；重试成功后清除", async () => {
    const page = vi
      .spyOn(api, "listSessionsPage")
      .mockRejectedValueOnce(new ApiError({ status: 502, message: "bad gateway" }))
      .mockResolvedValueOnce({
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
    expect(page).toHaveBeenCalledTimes(1);
    expect(result.current.loadMoreError).toBe(true);
    expect(result.current.hasMoreSessions).toBe(true);
    expect(result.current.loadingMoreSessions).toBe(false);

    await act(async () => {
      await result.current.loadMoreSessions();
    });
    expect(page).toHaveBeenCalledTimes(2);
    expect(result.current.loadMoreError).toBe(false);
    expect(result.current.sessions.map((s) => s.id)).toContain("webolder0001");
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

  test("searchSessionMessages 透传服务端命中与项目过滤，AbortError 当空数组", async () => {
    const search = vi.spyOn(api, "searchSessions").mockResolvedValue({
      results: [
        { sessionId: "a", title: "t", snippet: "x", matchedAt: 1, kind: "title" },
        { sessionId: "b", title: "t2", snippet: "y", matchedAt: 2, kind: "message" },
      ],
    });
    const { result } = await renderSessionList({ confirmResult: false, promptResult: null });
    const hits = await result.current.searchSessionMessages(
      "foo",
      new AbortController().signal,
      "project-1",
    );
    expect(hits.map((h) => h.sessionId)).toEqual(["a", "b"]);
    expect(search).toHaveBeenCalledWith(
      expect.anything(),
      "foo",
      expect.objectContaining({ projectId: "project-1", includeArchived: false }),
    );
    // S-10：「已归档」展开时消息搜索同样纳入归档会话，与标题本地过滤范围一致。
    await result.current.searchSessionMessages("foo", new AbortController().signal, null, true);
    expect(search).toHaveBeenLastCalledWith(
      expect.anything(),
      "foo",
      expect.objectContaining({ includeArchived: true, projectId: null }),
    );

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

test("confirmed metadata refreshes sidebar and local socket title without issuing another write", async () => {
  const { result, harness } = await renderSessionList({ confirmResult: false, promptResult: null });
  const patch = vi.spyOn(api, "patchSessionMeta");
  act(() => result.current.applySessionMetadata({ id: "webkeepme001", title: "Approved", pinned: true, updatedAt: 3000 }));
  expect(result.current.sessions.find(s => s.id === "webkeepme001")).toMatchObject({ title: "Approved", pinned: true });
  expect(harness.socket.renameSession).toHaveBeenCalledExactlyOnceWith("webkeepme001", "Approved");
  expect(harness.patchSessionTitle).not.toHaveBeenCalled();
  expect(patch).not.toHaveBeenCalled();
});
test("a delayed list response cannot restore metadata older than a confirmed receipt snapshot", async () => {
  const { result } = await renderSessionList({ confirmResult: false, promptResult: null });
  const old = deferred<Awaited<ReturnType<typeof api.listSessions>>>();
  vi.mocked(api.listSessions).mockImplementationOnce(() => old.promise);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(2));
  act(() => result.current.applySessionMetadata({ id: "webkeepme001", title: "Approved", pinned: true, updatedAt: 3000 }));
  await act(async () => old.resolve([meta("webkeepme001", "Old response")] as never));
  expect(result.current.sessions.find(s => s.id === "webkeepme001")).toMatchObject({ title: "Approved", pinned: true });
});
test("older display snapshots cannot overwrite a newer one and reset retires their version floor", async () => {
  const { result, harness } = await renderSessionList({ confirmResult: false, promptResult: null });
  act(() => result.current.applySessionMetadata({ id: "webkeepme001", title: "Newest", pinned: true, updatedAt: 4000 }));
  act(() => result.current.applySessionMetadata({ id: "webkeepme001", title: "Older", pinned: false, updatedAt: 3000 }));
  expect(result.current.sessions.find(s => s.id === "webkeepme001")?.title).toBe("Newest");
  expect(harness.socket.renameSession).toHaveBeenCalledTimes(1);
  act(() => result.current.reset());
  act(() => result.current.applySessionMetadata({ id: "webkeepme001", title: "New identity", pinned: false, updatedAt: 2000 }));
  expect(harness.socket.renameSession).toHaveBeenLastCalledWith("webkeepme001", "New identity");
});

test("a newer normal canonical page wins over the first delayed metadata snapshot", async () => {
  const { result, harness } = await renderSessionList({ confirmResult: false, promptResult: null });
  vi.spyOn(api,"listSessionsPage").mockResolvedValue({ sessions: [{ ...meta("webkeepme001","Newest page"), updatedAt: 4000 }], nextCursor: null } as never);
  await act(async () => result.current.loadArchivedSessions());
  act(() => result.current.applySessionMetadata({ id: "webkeepme001", title: "Delayed receipt", pinned: true, updatedAt: 3000 }));
  expect(result.current.sessions.find(s => s.id === "webkeepme001")?.title).toBe("Newest page");
  expect(harness.socket.renameSession).not.toHaveBeenCalled();
});
test("a metadata watermark cannot make an older model payload pass the existing confirmed model floor", async () => {
  const { result } = await renderSessionList({ confirmResult: false, promptResult: null });
  vi.spyOn(api,"patchSessionModel").mockResolvedValue({ ok: true, updatedAt: 2500 } as never);
  await act(async () => {
    result.current.setSessions(current => current.map(session => session.id === "webkeepme001" ? { ...session, modelId: "confirmed-model" } : session));
    result.current.queueModelPatch("webkeepme001","confirmed-model");
  });
  await waitFor(() => expect(api.patchSessionModel).toHaveBeenCalledTimes(1));
  act(() => result.current.applySessionMetadata({ id: "webkeepme001", title: "Approved name", pinned: true, updatedAt: 3000 }));
  vi.spyOn(api,"listSessionsPage").mockResolvedValue({ sessions: [{ ...meta("webkeepme001","Stale"), updatedAt: 1000, modelId: "stale-model" }], nextCursor: null } as never);
  await act(async () => result.current.loadArchivedSessions());
  expect(result.current.sessions.find(s => s.id === "webkeepme001")).toMatchObject({ title: "Approved name", pinned: true, modelId: "confirmed-model" });
});

// #1240「重命名第一次没生效」:60s 轮询 / 窗口 focus 重拉随时可能在飞，它带回的是改名前的标题。
describe("useSessionList 重命名与在飞的列表请求", () => {
  async function renameWithListInFlight(order: "list-first" | "patch-first") {
    const { result, harness } = await renderSessionList({ confirmResult: true, promptResult: "office-1029pm" });
    const stale = deferred<Awaited<ReturnType<typeof api.listSessions>>>();
    vi.mocked(api.listSessions).mockImplementationOnce(() => stale.promise);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(2));
    const patch = deferred<{ ok: true; updatedAt: number }>();
    harness.patchSessionTitle.mockImplementation(() => patch.promise);
    const target = result.current.sessions.find((s) => s.id === "webkeepme001")!;
    let renamed!: Promise<void>;
    act(() => {
      renamed = result.current.renameSessionPrompt(target);
    });
    await waitFor(() => expect(harness.patchSessionTitle).toHaveBeenCalledTimes(1));
    const staleRows = [meta("webkeepme001", "保留的会话"), meta("webdropme001", "待删除的会话")] as never;
    if (order === "list-first") {
      await act(async () => stale.resolve(staleRows));
      expect(result.current.sessions.find((s) => s.id === "webkeepme001")?.title).toBe("office-1029pm");
      await act(async () => patch.resolve({ ok: true, updatedAt: 3_000 }));
    } else {
      await act(async () => patch.resolve({ ok: true, updatedAt: 3_000 }));
      await act(async () => stale.resolve(staleRows));
    }
    await act(async () => renamed);
    return { result };
  }

  test("PATCH 未落地时在飞的旧列表回来，不把乐观标题盖回去", async () => {
    const { result } = await renameWithListInFlight("list-first");
    expect(result.current.sessions.find((s) => s.id === "webkeepme001")?.title).toBe("office-1029pm");
  });

  test("PATCH 落地后才回来的旧列表(updatedAt 更早)同样不盖回;之后更新的服务端标题照常生效", async () => {
    const { result } = await renameWithListInFlight("patch-first");
    expect(result.current.sessions.find((s) => s.id === "webkeepme001")?.title).toBe("office-1029pm");
    vi.mocked(api.listSessions).mockResolvedValueOnce([{ ...meta("webkeepme001", "别处又改了"), updatedAt: 4_000 }] as never);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() =>
      expect(result.current.sessions.find((s) => s.id === "webkeepme001")?.title).toBe("别处又改了"),
    );
  });

  test("改名只为标题背书：此前已确认的置顶不被改名框打开时的旧值盖掉", async () => {
    const { result, harness } = await renderSessionList({ confirmResult: true, promptResult: "office-1029pm" });
    const target = result.current.sessions.find((s) => s.id === "webkeepme001")!;
    expect(target.pinned).not.toBe(true);
    act(() => result.current.applySessionMetadata({ id: "webkeepme001", title: "保留的会话", pinned: true, updatedAt: 2_500 }));
    const stale = deferred<Awaited<ReturnType<typeof api.listSessions>>>();
    vi.mocked(api.listSessions).mockImplementationOnce(() => stale.promise);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(2));
    harness.patchSessionTitle.mockResolvedValue({ ok: true, updatedAt: 3_000 });
    await act(async () => {
      await result.current.renameSessionPrompt(target);
    });
    await act(async () => stale.resolve([meta("webkeepme001", "保留的会话")] as never));
    expect(result.current.sessions.find((s) => s.id === "webkeepme001")).toMatchObject({ title: "office-1029pm", pinned: true });
  });
});

describe("useSessionList 侧栏运行态与快照终态收敛 (U8)", () => {
  test("canonical getSession 无 openDispatch 时把滞留的 runState=running 收敛为 idle", async () => {
    const { result } = await renderSessionList({ confirmResult: false, promptResult: null });
    await waitFor(() => expect(result.current.historyLoading).toBeFalsy());
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");

    vi.mocked(api.listSessions).mockResolvedValueOnce([
      {
        ...meta("webkeepme001", "保留的会话"),
        runState: "running",
        updatedAt: 2_200,
      },
      meta("webdropme001", "待删除的会话"),
    ] as never);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() =>
      expect(result.current.sessions.find((s) => s.id === "webkeepme001")?.runState).toBe("running"),
    );

    vi.mocked(api.getSession).mockResolvedValueOnce({
      ...detail("webkeepme001"),
      updatedAt: 2_500,
      openDispatch: undefined,
      messages: [{ id: "a1", role: "agent", content: "done", _dispatchOutcome: "completed" }],
    } as never);

    await act(async () => {
      await result.current.loadHistory("webkeepme001", { force: true });
    });
    expect(result.current.sessions.find((s) => s.id === "webkeepme001")).toMatchObject({
      runState: "idle",
      lastOutcome: "completed",
    });
  });

  test("回合刚结束时已在飞的旧 listSessions(runState=running) 回来不会复活转圈；之后新回合(updatedAt 更大)照常显示 running", async () => {
    const { result } = await renderSessionList({ confirmResult: false, promptResult: null });
    await waitFor(() => expect(result.current.historyLoading).toBeFalsy());
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");

    vi.mocked(api.listSessions).mockResolvedValueOnce([
      {
        ...meta("webkeepme001", "保留的会话"),
        runState: "running",
        updatedAt: 2_100,
      },
      meta("webdropme001", "待删除的会话"),
    ] as never);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() =>
      expect(result.current.sessions.find((s) => s.id === "webkeepme001")?.runState).toBe("running"),
    );

    const staleInflight = deferred<Awaited<ReturnType<typeof api.listSessions>>>();
    vi.mocked(api.listSessions).mockImplementationOnce(() => staleInflight.promise);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(3));

    act(() => {
      result.current.applySessionTerminal("webkeepme001", {
        lastOutcome: "completed",
        lastErrorCode: null,
      });
    });
    expect(result.current.sessions.find((s) => s.id === "webkeepme001")?.runState).toBe("idle");

    await act(async () => {
      staleInflight.resolve([
        {
          ...meta("webkeepme001", "保留的会话"),
          runState: "running",
          updatedAt: 2_200,
        },
        meta("webdropme001", "待删除的会话"),
      ] as never);
    });
    expect(result.current.sessions.find((s) => s.id === "webkeepme001")?.runState).toBe("idle");

    vi.mocked(api.listSessions).mockResolvedValueOnce([
      {
        ...meta("webkeepme001", "保留的会话"),
        runState: "running",
        updatedAt: 4_000,
      },
      meta("webdropme001", "待删除的会话"),
    ] as never);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() =>
      expect(result.current.sessions.find((s) => s.id === "webkeepme001")?.runState).toBe("running"),
    );
  });

  function extractAppTerminalSlice() {
    const appPath = ["src/App.tsx", "packages/web-react/src/App.tsx"]
      .map((rel) => resolve(process.cwd(), rel))
      .find((candidate) => existsSync(candidate));
    if (!appPath) throw new Error(`App.tsx not found from cwd=${process.cwd()}`);
    const source = readFileSync(appPath, "utf8");
    const parsed = ts.createSourceFile(
      appPath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const app = parsed.statements.find(
      (n) => ts.isFunctionDeclaration(n) && n.name?.text === "App",
    );
    if (!app || !ts.isFunctionDeclaration(app) || !app.body) {
      throw new Error("Exact App declaration not found");
    }
    const names = new Set(["sendingIdsRef", "liveTerminalsRef", "liveTerminals"]);
    const extracted: string[] = [];
    const found = new Set<string>();
    let effects = 0;
    for (const statement of app.body.statements) {
      if (ts.isVariableStatement(statement)) {
        const declaration = statement.declarationList.declarations.find(
          (d) => ts.isIdentifier(d.name) && names.has(d.name.text),
        );
        if (declaration && ts.isIdentifier(declaration.name)) {
          found.add(declaration.name.text);
          extracted.push(statement.getText(parsed));
        }
      } else if (
        ts.isExpressionStatement(statement) &&
        ts.isCallExpression(statement.expression) &&
        statement.expression.expression.getText(parsed) === "useEffect" &&
        statement
          .getText(parsed)
          .includes("for (const [id, t] of liveTerminals) applySessionTerminal(id, t)")
      ) {
        effects++;
        extracted.push(statement.getText(parsed));
      }
    }
    if (found.size !== 3 || effects !== 1) {
      throw new Error(`Unexpected AST selection: ${[...found]}, effects=${effects}`);
    }
    const body = ts.transpileModule(
      `function useExactAppTerminalSlice(chat, sessions, demo, applySessionTerminal) {\n${extracted.join("\n")}\nreturn liveTerminals;\n}`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
    ).outputText;
    const statusRecord = sessionStatus as Record<string, unknown>;
    return new Function(
      "useRef",
      "useMemo",
      "useEffect",
      "deriveLiveTerminalFromMessages",
      "resolveLiveTurnEndTerminal",
      "deriveLiveTerminalEndedAt",
      `${body}\nreturn useExactAppTerminalSlice;`,
    )(
      useRef,
      useMemo,
      useEffect,
      sessionStatus.deriveLiveTerminalFromMessages,
      sessionStatus.resolveLiveTurnEndTerminal,
      statusRecord.deriveLiveTerminalEndedAt,
    ) as (
      chat: unknown,
      sessions: unknown,
      demo: boolean,
      applySessionTerminal: unknown,
    ) => Map<string, { lastOutcome: string; lastErrorCode: string | null }>;
  }

  class TerminalRenderBoundary extends Component<
    { errors: Error[]; children?: React.ReactNode },
    { failed: boolean }
  > {
    state = { failed: false };
    static getDerivedStateFromError() {
      return { failed: true };
    }
    componentDidCatch(error: Error) {
      this.props.errors.push(error);
    }
    render() {
      return this.state.failed
        ? React.createElement("output", { "data-testid": "guard-stopped" }, "guard stopped")
        : this.props.children;
    }
  }

  test("ordinary unannotated success settles without an App/session-list update loop (#1292 repro)", async () => {
    const sid = "webu8review001";
    const useExactAppTerminalSlice = extractAppTerminalSlice();
    const auth = createMemoryAuthSession(() => {}, "synthetic-review-token");
    const reviewUser: User = { id: "u1", displayName: "Review", roles: ["user"] } as never;
    const errors: Error[] = [];
    const logs: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => {
      logs.push(args);
    });
    vi.spyOn(api, "listSessions").mockResolvedValue([
      {
        id: sid,
        title: "ordinary success",
        agentId: "main",
        createdAt: 1000,
        updatedAt: 2000,
        lastAt: 2000,
        messageCount: 2,
        runState: "running",
      },
    ] as never);
    let isSending = true;
    let renders = 0;
    let latest: ReturnType<typeof useSessionList> | undefined;
    const messages = [{ id: "ordinary-final", role: "agent", content: "done", ts: 2100 }];
    const socket = { isSending: () => isSending };
    const options = {
      demo: false,
      auth,
      authSession: auth,
      user: reviewUser,
      agentId: "main",
      holdAutoSelect: true,
      sockRef: { current: socket },
      confirmDialog: async () => false,
      promptText: async () => null,
      clearChatError() {},
      onNewSessionReset() {},
      onActiveSessionDeleted() {},
    };
    function Harness({ frame }: { frame: number }) {
      renders++;
      if (renders > 80) {
        throw new Error(
          "REVIEW_RENDER_GUARD: head exceeded 80 renders after ordinary successful turn",
        );
      }
      const list = useSessionList(options as never);
      latest = list;
      const chat = useMemo(
        () => ({ version: frame, isSending: () => isSending, getSession: () => ({ messages }) }),
        [frame],
      );
      useExactAppTerminalSlice(chat, list.sessions, false, list.applySessionTerminal);
      return React.createElement("output", { "data-testid": "render-count" }, renders);
    }
    const element = (frame: number) =>
      React.createElement(
        TerminalRenderBoundary,
        { errors },
        React.createElement(Harness, { frame }),
      );
    const mounted = render(element(0));
    await waitFor(() => expect(latest?.sessions).toHaveLength(1));
    expect(renders).toBeLessThan(20);
    await act(async () => {
      isSending = false;
      mounted.rerender(element(1));
    });
    expect(
      errors.map((error) => error.message),
      `renders=${renders}; consoleErrors=${logs.length}`,
    ).toEqual([]);
    expect(logs).toEqual([]);
    expect(renders).toBeLessThan(30);
    expect(latest?.sessions[0]).toMatchObject({
      id: sid,
      runState: "idle",
      lastOutcome: "completed",
      lastErrorCode: null,
    });
    const settledRenders = renders;
    await act(async () => {
      await Promise.resolve();
    });
    expect(renders).toBe(settledRenders);
    mounted.unmount();
  });

  test("applySessionTerminal 在字段未变时返回原 sessions 引用且同一终态对象仅应用一次", async () => {
    const { result } = await renderSessionList({ confirmResult: false, promptResult: null });
    await waitFor(() => expect(result.current.historyLoading).toBeFalsy());

    const terminal = { lastOutcome: "completed" as const, lastErrorCode: null };
    act(() => {
      result.current.applySessionTerminal("webkeepme001", terminal);
    });
    const afterFirst = result.current.sessions;
    expect(afterFirst.find((s) => s.id === "webkeepme001")).toMatchObject({
      runState: "idle",
      lastOutcome: "completed",
      lastErrorCode: null,
      unread: true,
    });

    // 值完全相同时再次传入新终态对象：保持原数组引用（no-op）
    act(() => {
      result.current.applySessionTerminal("webkeepme001", {
        lastOutcome: "completed",
        lastErrorCode: null,
      });
    });
    expect(result.current.sessions).toBe(afterFirst);

    // 会话后续已被读或更新后，同一轮终态对象引用再次经 effect 扫过时不再重复应用
    act(() => {
      result.current.setSessions((c) =>
        c.map((s) => (s.id === "webkeepme001" ? { ...s, unread: false } : s)),
      );
    });
    const afterRead = result.current.sessions;
    act(() => {
      result.current.applySessionTerminal("webkeepme001", terminal);
    });
    expect(result.current.sessions).toBe(afterRead);
    expect(result.current.sessions.find((s) => s.id === "webkeepme001")?.unread).toBe(false);
  });
});
