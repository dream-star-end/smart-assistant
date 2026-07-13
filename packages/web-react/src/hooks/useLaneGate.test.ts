import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LANE_DECISION_TIMEOUT_MS, useLaneGate } from "./useLaneGate";

/**
 * laneReady gate 时序（P3 RFC D1）：
 *  - 有 lane（present 字段）→ 立即 ready；
 *  - 无字段兼容（lane:null）→ 向后兼容仍立即 ready；
 *  - 决策进行中 → 3s 超时兜底放行 + console.warn（防 WS 永久阻塞）；
 *  - 拿到决策清在途兜底 timer（不迟到 warn）；未认证恒 false；登出复位。
 */
type LaneSig = { lane: string | null } | undefined;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useLaneGate", () => {
  test("有 lane（present 字段）→ 立即 ready", () => {
    const { result } = renderHook(() => useLaneGate(true, { lane: "g42.B" }));
    expect(result.current).toBe(true);
  });

  test("无字段兼容（lane:null=后端未部署）→ 立即 ready", () => {
    const { result } = renderHook(() => useLaneGate(true, { lane: null }));
    expect(result.current).toBe(true);
  });

  test("未认证（active=false）→ 恒 false（无需 lane）", () => {
    const { result } = renderHook(() => useLaneGate(false, undefined));
    expect(result.current).toBe(false);
  });

  test("决策进行中 → 3s 超时兜底放行 + warn", () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useLaneGate(true, undefined));
    expect(result.current).toBe(false); // 决策进行中，未 ready
    act(() => {
      vi.advanceTimersByTime(LANE_DECISION_TIMEOUT_MS - 1);
    });
    expect(result.current).toBe(false); // 未到点仍不放行
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(result.current).toBe(true); // 3s 兜底放行
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("决策进行中拿到 lane → 清在途兜底 timer，不迟到 warn", () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result, rerender } = renderHook(({ sig }: { sig: LaneSig }) => useLaneGate(true, sig), {
      initialProps: { sig: undefined as LaneSig },
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1000); // 未到 3s
    });
    rerender({ sig: { lane: "g1.A" } }); // 决策达成 → 应清在途兜底 timer
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(5000); // 旧兜底 timer 若未清会在此 warn
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test("登出（active 落回 false）→ 复位 false，下次认证重新走决策", () => {
    const { result, rerender } = renderHook(
      ({ active, sig }: { active: boolean; sig: LaneSig }) => useLaneGate(active, sig),
      { initialProps: { active: true, sig: { lane: "g1.A" } as LaneSig } },
    );
    expect(result.current).toBe(true);
    rerender({ active: false, sig: undefined }); // 登出
    expect(result.current).toBe(false);
    rerender({ active: true, sig: { lane: "g2.B" } }); // 重新登录并拿到决策
    expect(result.current).toBe(true);
  });
});
