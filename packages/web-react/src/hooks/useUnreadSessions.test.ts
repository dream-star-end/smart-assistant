import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../lib/api";
import { createMemoryAuthSession } from "../lib/authSession";
import {
  unreadNotifyStorageKey,
  unreadSessionsStorageKey,
  useUnreadSessions,
  type UnreadSessionInput,
} from "./useUnreadSessions";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Args = {
  sessions: UnreadSessionInput[];
  activeId: string | null;
  userId: string | null;
  auth?: ReturnType<typeof createMemoryAuthSession> | null;
};

function hook(initial: Args) {
  return renderHook((props: Args) => useUnreadSessions(props), { initialProps: initial });
}

describe("useUnreadSessions", () => {
  test("running→terminal 标未读（乐观，不写 localStorage 权威）", () => {
    const { result, rerender } = hook({
      sessions: [{ id: "s1", title: "调研", runState: "running" }],
      activeId: "other",
      userId: "u1",
    });
    rerender({
      sessions: [{ id: "s1", title: "调研", runState: "idle", lastOutcome: "completed" }],
      activeId: "other",
      userId: "u1",
    });
    expect(result.current.unreadIds.has("s1")).toBe(true);
    expect(localStorage.getItem(unreadSessionsStorageKey("u1"))).toBeNull();
  });

  test("服务端 unread 为权威", () => {
    const { result } = hook({
      sessions: [
        { id: "s1", title: "A", unread: true, lastOutcome: "completed" },
        { id: "s2", title: "B", unread: false, lastOutcome: "completed" },
      ],
      activeId: null,
      userId: "u1",
    });
    expect(result.current.unreadIds.has("s1")).toBe(true);
    expect(result.current.unreadIds.has("s2")).toBe(false);
  });

  test("当前会话不标未读，并 POST mark-read", async () => {
    const auth = createMemoryAuthSession(() => {}, "token");
    const mark = vi.spyOn(api, "markSessionRead").mockResolvedValue({ ok: true, updated: 1 });
    const { result, rerender } = hook({
      sessions: [{ id: "s1", title: "当前", runState: "running" }],
      activeId: "s1",
      userId: "u1",
      auth,
    });
    rerender({
      sessions: [{ id: "s1", title: "当前", runState: "idle", lastOutcome: "crashed" }],
      activeId: "s1",
      userId: "u1",
      auth,
    });
    expect(result.current.unreadIds.has("s1")).toBe(false);
    await waitFor(() => expect(mark).toHaveBeenCalled());
  });

  test("activeId 切换清未读", () => {
    const { result, rerender } = hook({
      sessions: [{ id: "s1", title: "A", runState: "running" }],
      activeId: "other",
      userId: "u1",
    });
    rerender({
      sessions: [{ id: "s1", title: "A", runState: "idle", lastOutcome: "completed" }],
      activeId: "other",
      userId: "u1",
    });
    expect(result.current.unreadIds.has("s1")).toBe(true);
    rerender({
      sessions: [{ id: "s1", title: "A", runState: "idle", lastOutcome: "completed" }],
      activeId: "s1",
      userId: "u1",
    });
    expect(result.current.unreadIds.has("s1")).toBe(false);
  });

  test("首登合并一次 localStorage 后删除 key，之后不再当权威", async () => {
    const auth = createMemoryAuthSession(() => {}, "token");
    const migrate = vi
      .spyOn(api, "migrateUnreadSessions")
      .mockResolvedValue({ ok: true, updated: 2 });
    localStorage.setItem(unreadSessionsStorageKey("u1"), JSON.stringify(["kept", "also"]));
    const { result, rerender } = hook({
      sessions: [],
      activeId: null,
      userId: "u1",
      auth,
    });
    expect(result.current.unreadIds.has("kept")).toBe(true);
    expect(result.current.unreadIds.has("also")).toBe(true);
    await waitFor(() => expect(migrate).toHaveBeenCalledTimes(1));
    expect(migrate).toHaveBeenCalledWith(auth, ["kept", "also"]);
    await waitFor(() => expect(localStorage.getItem(unreadSessionsStorageKey("u1"))).toBeNull());

    localStorage.setItem(unreadSessionsStorageKey("u1"), JSON.stringify(["ghost"]));
    rerender({
      sessions: [{ id: "s-server", title: "S", unread: true }],
      activeId: null,
      userId: "u1",
      auth,
    });
    expect(result.current.unreadIds.has("ghost")).toBe(false);
    expect(result.current.unreadIds.has("s-server")).toBe(true);
    expect(migrate).toHaveBeenCalledTimes(1);
  });

  test("无 Notification 环境不崩", async () => {
    vi.stubGlobal("Notification", undefined);
    const { result } = hook({ sessions: [], activeId: null, userId: "u1" });
    expect(result.current.notifyPermission).toBe("unsupported");
    await act(async () => {
      await result.current.setNotifyEnabled(true);
    });
    expect(result.current.notifyEnabled).toBe(false);
    expect(result.current.notifyPermission).toBe("unsupported");
  });

  test("权限拒绝不置 enabled", async () => {
    class FakeNotification {
      static permission: NotificationPermission = "default";
      static requestPermission = vi.fn(async () => {
        FakeNotification.permission = "denied";
        return "denied" as const;
      });
      close = vi.fn();
      onclick: (() => void) | null = null;
      constructor(
        public title: string,
        public options?: NotificationOptions,
      ) {}
    }
    vi.stubGlobal("Notification", FakeNotification);
    localStorage.setItem(unreadNotifyStorageKey("u1"), "1");
    const { result } = hook({ sessions: [], activeId: null, userId: "u1" });
    expect(result.current.notifyEnabled).toBe(false);
    await act(async () => {
      await result.current.setNotifyEnabled(true);
    });
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(result.current.notifyEnabled).toBe(false);
    expect(result.current.notifyPermission).toBe("denied");
    expect(localStorage.getItem(unreadNotifyStorageKey("u1"))).toBe("0");
  });

  test("乐观已读在服务端确认前不闪回", () => {
    const { result, rerender } = hook({
      sessions: [{ id: "s1", title: "A", unread: true, lastOutcome: "completed" }],
      activeId: null,
      userId: "u1",
    });
    expect(result.current.unreadIds.has("s1")).toBe(true);
    act(() => {
      result.current.markRead("s1");
    });
    expect(result.current.unreadIds.has("s1")).toBe(false);
    rerender({
      sessions: [{ id: "s1", title: "A", unread: true, lastOutcome: "completed" }],
      activeId: null,
      userId: "u1",
    });
    expect(result.current.unreadIds.has("s1")).toBe(false);
  });

  test("mark-read 之后、首次 unread=false 刷新之前发生新终态 → 绿点必须出现", () => {
    const { result, rerender } = hook({
      sessions: [{ id: "s1", title: "A", unread: true, lastOutcome: "completed" }],
      activeId: null,
      userId: "u1",
    });
    act(() => {
      result.current.markRead("s1");
    });
    expect(result.current.unreadIds.has("s1")).toBe(false);
    rerender({
      sessions: [{ id: "s1", title: "A", unread: true, lastOutcome: "completed" }],
      activeId: null,
      userId: "u1",
    });
    expect(result.current.unreadIds.has("s1")).toBe(false);
    rerender({
      sessions: [{ id: "s1", title: "A", unread: true, runState: "running" }],
      activeId: null,
      userId: "u1",
    });
    rerender({
      sessions: [
        { id: "s1", title: "A", unread: true, runState: "idle", lastOutcome: "completed" },
      ],
      activeId: null,
      userId: "u1",
    });
    expect(result.current.unreadIds.has("s1")).toBe(true);
  });

  test("mark-all 之后、首次 unread=false 刷新之前发生新终态 → 绿点必须出现", () => {
    const { result, rerender } = hook({
      sessions: [
        { id: "s1", title: "A", unread: true, lastOutcome: "completed" },
        { id: "s2", title: "B", unread: true, lastOutcome: "completed" },
      ],
      activeId: null,
      userId: "u1",
    });
    act(() => {
      result.current.markAllRead();
    });
    expect(result.current.unreadIds.has("s1")).toBe(false);
    expect(result.current.unreadIds.has("s2")).toBe(false);
    rerender({
      sessions: [
        { id: "s1", title: "A", unread: true, lastOutcome: "completed" },
        { id: "s2", title: "B", unread: true, lastOutcome: "completed" },
      ],
      activeId: null,
      userId: "u1",
    });
    expect(result.current.unreadIds.has("s1")).toBe(false);
    expect(result.current.unreadIds.has("s2")).toBe(false);
    rerender({
      sessions: [
        { id: "s1", title: "A", unread: true, runState: "running" },
        { id: "s2", title: "B", unread: true, lastOutcome: "completed" },
      ],
      activeId: null,
      userId: "u1",
    });
    rerender({
      sessions: [
        { id: "s1", title: "A", unread: true, runState: "idle", lastOutcome: "completed" },
        { id: "s2", title: "B", unread: true, lastOutcome: "completed" },
      ],
      activeId: null,
      userId: "u1",
    });
    expect(result.current.unreadIds.has("s1")).toBe(true);
    expect(result.current.unreadIds.has("s2")).toBe(false);
  });
});
