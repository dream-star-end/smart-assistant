/**
 * 生成占位卡（需求 C）渲染契约：running 角标 / 3 分钟超时兜底 / prefers-reduced-motion
 * 降级（关 canvas rAF）/ failed 态（danger + 原因 + 可选重试）/ 比例解析。
 * jsdom 无 canvas（getContext→null），组件短路不启 rAF，测试环境零 rAF、零抛错。
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { GeneratingPlaceholderCard, parseAspectRatio } from "./GeneratingPlaceholderCard";

afterEach(cleanup);

/** 覆写 matchMedia：reduced=true 时匹配 prefers-reduced-motion。 */
function stubReducedMotion(reduced: boolean) {
  window.matchMedia = ((query: string) =>
    ({
      matches: reduced && /prefers-reduced-motion/.test(query),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
}

describe("parseAspectRatio", () => {
  test("数字比值原样、字符串枚举解析、非法回退 1", () => {
    expect(parseAspectRatio(1.5)).toBeCloseTo(1.5);
    expect(parseAspectRatio("16:9")).toBeCloseTo(16 / 9);
    expect(parseAspectRatio("9/16")).toBeCloseTo(9 / 16);
    expect(parseAspectRatio("garbage")).toBe(1);
    expect(parseAspectRatio(0)).toBe(1);
  });
});

describe("GeneratingPlaceholderCard", () => {
  beforeEach(() => stubReducedMotion(false));

  test("running：显示「正在生成 · 约几十秒」角标", () => {
    render(<GeneratingPlaceholderCard aspect="16:9" status="running" startedAt={Date.now()} />);
    expect(screen.getByText("正在生成 · 约几十秒")).toBeInTheDocument();
    expect(screen.getByTestId("generating-placeholder")).toBeInTheDocument();
  });

  test("超时兜底：startedAt 早于 3 分钟 → 显示「仍在处理，稍后回来看」", () => {
    render(
      <GeneratingPlaceholderCard aspect={1} status="running" startedAt={Date.now() - 4 * 60_000} />,
    );
    expect(screen.getByText("仍在处理，稍后回来看")).toBeInTheDocument();
    expect(screen.queryByText("正在生成 · 约几十秒")).not.toBeInTheDocument();
  });

  test("超时兜底（fake timers）：3 分钟无事件后角标切换", () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      render(<GeneratingPlaceholderCard aspect={1} status="running" startedAt={startedAt} />);
      expect(screen.getByText("正在生成 · 约几十秒")).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(3 * 60_000 + 10);
      });
      expect(screen.getByText("仍在处理，稍后回来看")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test("prefers-reduced-motion：不渲染 canvas（关 rAF，降级 CSS 脉冲）", () => {
    stubReducedMotion(true);
    const { container } = render(
      <GeneratingPlaceholderCard aspect={1} status="running" startedAt={Date.now()} />,
    );
    expect(container.querySelector("canvas")).toBeNull();
  });

  test("非 reduced：渲染 canvas 元素（动效基面）", () => {
    stubReducedMotion(false);
    const { container } = render(
      <GeneratingPlaceholderCard aspect={1} status="running" startedAt={Date.now()} />,
    );
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  test("failed：danger 图标 + 原因 + 重试；不再显示生成角标", () => {
    const onRetry = vi.fn();
    render(
      <GeneratingPlaceholderCard
        aspect={1}
        status="failed"
        startedAt={Date.now()}
        reason="模型服务暂时不可用"
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("图片生成失败")).toBeInTheDocument();
    expect(screen.getByText("模型服务暂时不可用")).toBeInTheDocument();
    expect(screen.queryByText("正在生成 · 约几十秒")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /重试/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("failed 无 onRetry：不出重试按钮", () => {
    render(<GeneratingPlaceholderCard aspect={1} status="failed" startedAt={Date.now()} />);
    expect(screen.queryByRole("button", { name: /重试/ })).toBeNull();
  });
});
