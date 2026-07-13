import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ConnBanner } from "../lib/chat/pure";
import { useDelayedConnBanner } from "./useDelayedConnBanner";

/**
 * 连接横幅 2s 延迟（P3 RFC D6）：
 *  - 2s 内重连成功 → 横幅从不出现（零闪烁）；
 *  - 断开超 2s → 横幅显示；
 *  - flap（断-连-断）旧 timer 必清，按最新一次断开重新计时；
 *  - 已点亮后内容更新（倒计时）不被延迟二次拦截；raw=null 恒 null。
 */
const DELAY = 2000;
const banner = (text = "断线"): ConnBanner => ({ tone: "warning", text });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useDelayedConnBanner", () => {
  test("raw 为 null（已连接）→ 恒 null", () => {
    const { result } = renderHook(() => useDelayedConnBanner(null, DELAY));
    expect(result.current).toBeNull();
  });

  test("2s 内重连成功 → 横幅从不出现（零闪烁）", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ r }: { r: ConnBanner }) => useDelayedConnBanner(r, DELAY), {
      initialProps: { r: null as ConnBanner },
    });
    expect(result.current).toBeNull();
    rerender({ r: banner() }); // 断开
    act(() => {
      vi.advanceTimersByTime(1000); // 1s < 2s
    });
    expect(result.current).toBeNull(); // 尚未点亮
    rerender({ r: null }); // 2s 内重连成功
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBeNull(); // 横幅从不出现
  });

  test("断开超 2s → 横幅显示", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ r }: { r: ConnBanner }) => useDelayedConnBanner(r, DELAY), {
      initialProps: { r: null as ConnBanner },
    });
    rerender({ r: banner() });
    act(() => {
      vi.advanceTimersByTime(DELAY - 1);
    });
    expect(result.current).toBeNull(); // 差 1ms 未到
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(result.current).toEqual({ tone: "warning", text: "断线" });
  });

  test("flap（断-连-断）：旧 timer 清，按最新一次断开重新计时", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ r }: { r: ConnBanner }) => useDelayedConnBanner(r, DELAY), {
      initialProps: { r: null as ConnBanner },
    });
    rerender({ r: banner("断1") });
    act(() => {
      vi.advanceTimersByTime(1500); // 第一次断开 1.5s
    });
    rerender({ r: null }); // 连上：清旧 timer
    rerender({ r: banner("断2") }); // 再断开：新 timer
    act(() => {
      // 距新断开仅 1.5s（自首次断开累计 3s+，旧 timer 若泄漏早已点亮 断1）。
      vi.advanceTimersByTime(1500);
    });
    expect(result.current).toBeNull(); // 仍 null 证明旧 timer 已清、按新断开计时
    act(() => {
      vi.advanceTimersByTime(600); // 新断开累计 2.1s
    });
    expect(result.current).toEqual({ tone: "warning", text: "断2" });
  });

  test("已点亮后内容更新（倒计时）立即反映，不被延迟二次拦截", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ r }: { r: ConnBanner }) => useDelayedConnBanner(r, DELAY), {
      initialProps: { r: null as ConnBanner },
    });
    rerender({ r: banner("5 秒后重连…") });
    act(() => {
      vi.advanceTimersByTime(DELAY + 1);
    });
    expect(result.current?.text).toBe("5 秒后重连…");
    rerender({ r: banner("4 秒后重连…") }); // 仍断开态，内容更新
    expect(result.current?.text).toBe("4 秒后重连…"); // 立即反映
  });
});
