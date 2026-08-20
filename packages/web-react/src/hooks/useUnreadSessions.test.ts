import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
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
};

function hook(initial: Args) {
  return renderHook((props: Args) => useUnreadSessions(props), { initialProps: initial });
}

describe("useUnreadSessions", () => {
  test("running→terminal 标未读", () => {
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
    expect(JSON.parse(localStorage.getItem(unreadSessionsStorageKey("u1")) || "[]")).toContain("s1");
  });

  test("当前会话不标未读", () => {
    const { result, rerender } = hook({
      sessions: [{ id: "s1", title: "当前", runState: "running" }],
      activeId: "s1",
      userId: "u1",
    });
    rerender({
      sessions: [{ id: "s1", title: "当前", runState: "idle", lastOutcome: "crashed" }],
      activeId: "s1",
      userId: "u1",
    });
    expect(result.current.unreadIds.has("s1")).toBe(false);
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

  test("持久化读回", () => {
    localStorage.setItem(unreadSessionsStorageKey("u1"), JSON.stringify(["kept", "also"]));
    const { result } = hook({ sessions: [], activeId: null, userId: "u1" });
    expect(result.current.unreadIds.has("kept")).toBe(true);
    expect(result.current.unreadIds.has("also")).toBe(true);
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
});
