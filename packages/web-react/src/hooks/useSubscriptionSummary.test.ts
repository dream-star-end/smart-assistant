import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { createMemoryAuthSession } from "../lib/authSession";
import { lastKnownSubscriptionPaid, resetSubscribeUiState } from "../lib/subscribeIntent";
import type { MySubscription } from "../lib/types";
import { useSubscriptionSummary } from "./useSubscriptionSummary";

function makeSubscription(overrides: Partial<MySubscription> = {}): MySubscription {
  return {
    planCode: "pro",
    planName: "Pro",
    status: "active",
    periodStart: "2026-11-01T00:00:00Z",
    periodEnd: "2026-12-01T00:00:00Z",
    periodCredits: "12000",
    monthlyCredits: "20000",
    priceCents: "9900",
    tier: 2,
    paid: true,
    balance: { wallet: "500", period: "12000", total: "12500" },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  resetSubscribeUiState();
  vi.restoreAllMocks();
});

describe("useSubscriptionSummary", () => {
  it("未登录（auth=null）时不发请求且返回 null", () => {
    const spy = vi.spyOn(api, "getMySubscription");
    const { result } = renderHook(() => useSubscriptionSummary(null));
    expect(result.current.summary).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("登录后拉取订阅摘要并归一数值字段与 paid 记忆", async () => {
    const auth = createMemoryAuthSession(() => {}, "jwt-sub-1");
    const spy = vi
      .spyOn(api, "getMySubscription")
      .mockResolvedValue(makeSubscription());

    const { result } = renderHook(() => useSubscriptionSummary(auth));

    await waitFor(() => {
      expect(result.current.summary).toEqual({
        paid: true,
        planName: "Pro",
        planCode: "pro",
        periodEnd: "2026-12-01T00:00:00Z",
        periodCredits: 12000,
        status: "active",
      });
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(lastKnownSubscriptionPaid()).toBe(true);
  });

  it("并发挂起时对同一 auth 去重，只发一次请求", async () => {
    const auth = createMemoryAuthSession(() => {}, "jwt-sub-dedupe");
    let resolveSub!: (value: MySubscription) => void;
    const spy = vi.spyOn(api, "getMySubscription").mockImplementation(
      () =>
        new Promise<MySubscription>((resolve) => {
          resolveSub = resolve;
        }),
    );

    const h1 = renderHook(() => useSubscriptionSummary(auth));
    const h2 = renderHook(() => useSubscriptionSummary(auth));

    expect(spy).toHaveBeenCalledTimes(1);

    act(() => {
      resolveSub(makeSubscription({ planName: "Max", planCode: "max" }));
    });

    await waitFor(() => {
      expect(h1.result.current.summary?.planName).toBe("Max");
      expect(h2.result.current.summary?.planName).toBe("Max");
    });
  });

  it("404 或网络失败静默回退 null，不抛异常", async () => {
    const auth = createMemoryAuthSession(() => {}, "jwt-sub-err");
    vi.spyOn(api, "getMySubscription").mockRejectedValue(new Error("404 not found"));

    const { result } = renderHook(() => useSubscriptionSummary(auth));
    await waitFor(() => expect(api.getMySubscription).toHaveBeenCalledTimes(1));
    expect(result.current.summary).toBeNull();
  });

  it("调用 refresh() 后立即重拉并更新为最新套餐；登出后重置为 null", async () => {
    const auth = createMemoryAuthSession(() => {}, "jwt-sub-refresh");
    const spy = vi
      .spyOn(api, "getMySubscription")
      .mockResolvedValueOnce(
        makeSubscription({ paid: false, planName: "免费版", planCode: "free", periodCredits: "0" }),
      )
      .mockResolvedValueOnce(
        makeSubscription({ paid: true, planName: "Pro", planCode: "pro", periodCredits: "20000" }),
      );

    const { result, rerender } = renderHook(
      ({ session }) => useSubscriptionSummary(session),
      { initialProps: { session: auth as ReturnType<typeof createMemoryAuthSession> | null } },
    );

    await waitFor(() => expect(result.current.summary?.paid).toBe(false));
    expect(spy).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.summary?.paid).toBe(true);
      expect(result.current.summary?.planName).toBe("Pro");
      expect(result.current.summary?.periodCredits).toBe(20000);
    });
    expect(spy).toHaveBeenCalledTimes(2);

    rerender({ session: null });
    expect(result.current.summary).toBeNull();
  });
});
