import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  HISTORY_SKELETON_CAP_MS,
  HISTORY_SKELETON_GRACE_MS,
  type HistorySkeletonInput,
  useHistorySkeleton,
} from "./useHistorySkeleton";

/**
 * 冷会话骨架（OCV5-466，自 App.tsx 抽出）：
 *  - meta 未知（深链）→ GRACE 窗内骨架，过后 empty；
 *  - 确知有历史 → 骨架至 CAP 封顶；
 *  - 切换 activeId 两个截止标记重置、重新计时；
 *  - demo 不计时、不骨架；消息到达立即切 messages。
 */
const base = (over: Partial<HistorySkeletonInput> = {}): HistorySkeletonInput => ({
  demo: false,
  activeId: "sess-a",
  sessions: [],
  gated: false,
  wsMessageCount: 0,
  wsSending: false,
  demoMessageCount: 0,
  demoBusy: false,
  serverListSettled: false,
  historyLoading: false,
  historyError: null,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useHistorySkeleton", () => {
  test("meta 未知（深链）→ GRACE 窗内骨架，过后 empty", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useHistorySkeleton(base()));
    expect(result.current).toEqual({ loadingHistory: true, historySurface: "skeleton" });
    act(() => {
      vi.advanceTimersByTime(HISTORY_SKELETON_GRACE_MS);
    });
    expect(result.current).toEqual({ loadingHistory: false, historySurface: "empty" });
  });

  test("确知有历史 → 骨架持续到 CAP 封顶", () => {
    vi.useFakeTimers();
    const input = base({ serverListSettled: true, sessions: [{ id: "sess-a", messageCount: 5 }] });
    const { result } = renderHook(() => useHistorySkeleton(input));
    act(() => {
      vi.advanceTimersByTime(HISTORY_SKELETON_CAP_MS - 1);
    });
    expect(result.current.historySurface).toBe("skeleton");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.loadingHistory).toBe(false);
  });

  test("权威已知为空会话 → 直接 empty", () => {
    const { result } = renderHook(() =>
      useHistorySkeleton(base({ serverListSettled: true, sessions: [{ id: "sess-a", messageCount: 0 }] })),
    );
    expect(result.current).toEqual({ loadingHistory: false, historySurface: "empty" });
  });

  test("切换 activeId → 截止标记重置并重新计时", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook((p: HistorySkeletonInput) => useHistorySkeleton(p), {
      initialProps: base(),
    });
    act(() => {
      vi.advanceTimersByTime(HISTORY_SKELETON_GRACE_MS);
    });
    expect(result.current.loadingHistory).toBe(false);
    rerender(base({ activeId: "sess-b" }));
    expect(result.current.loadingHistory).toBe(true);
    act(() => {
      vi.advanceTimersByTime(HISTORY_SKELETON_GRACE_MS);
    });
    expect(result.current.loadingHistory).toBe(false);
  });

  test("消息到达 → 立即 messages，不等计时器", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook((p: HistorySkeletonInput) => useHistorySkeleton(p), {
      initialProps: base({ historyLoading: true }),
    });
    expect(result.current.historySurface).toBe("skeleton");
    rerender(base({ historyLoading: false, wsMessageCount: 3 }));
    expect(result.current).toEqual({ loadingHistory: false, historySurface: "messages" });
  });

  test("历史读取失败且确知非空 → 骨架封顶后 error", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useHistorySkeleton(
        base({
          serverListSettled: true,
          sessions: [{ id: "sess-a", messageCount: 2 }],
          historyError: new Error("boom"),
        }),
      ),
    );
    expect(result.current.historySurface).toBe("skeleton");
    act(() => {
      vi.advanceTimersByTime(HISTORY_SKELETON_CAP_MS);
    });
    expect(result.current.historySurface).toBe("error");
  });

  test("demo → 不骨架、不计时，surface 取 demo 消息/忙碌态", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useHistorySkeleton(base({ demo: true, demoMessageCount: 2, historyError: new Error("ignored") })),
    );
    expect(result.current).toEqual({ loadingHistory: false, historySurface: "messages" });
    expect(vi.getTimerCount()).toBe(0);
  });

  test("未选中会话 → 不计时", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useHistorySkeleton(base({ activeId: undefined })));
    expect(result.current).toEqual({ loadingHistory: false, historySurface: "empty" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
