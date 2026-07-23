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
