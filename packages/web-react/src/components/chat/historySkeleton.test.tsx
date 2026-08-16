import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  JournalHydrationRetry,
  MessageListSkeleton,
  PartialHistorySkeleton,
  shouldShowHistorySkeleton,
} from "./HistorySkeleton";

afterEach(cleanup);

/** 默认「冷会话加载中」基线：已选中、无缓存、非发送、meta 未知、窗口未过 → 显示骨架。 */
function base(over: Partial<Parameters<typeof shouldShowHistorySkeleton>[0]> = {}) {
  return {
    selected: true,
    gated: false,
    cachedCount: 0,
    sending: false,
    loading: false,
    knownMessageCount: 0,
    metaKnown: false,
    graceExpired: false,
    capExpired: false,
    ...over,
  };
}

describe("shouldShowHistorySkeleton（冷会话骨架判定）", () => {
  test("未选中会话 → 不显示", () => {
    expect(shouldShowHistorySkeleton(base({ selected: false }))).toBe(false);
  });

  test("前置门激活(gated) → 不显示（AgentGate 占位）", () => {
    expect(shouldShowHistorySkeleton(base({ gated: true }))).toBe(false);
  });

  test("有缓存消息 → 绝不显示（避免与真内容打架/闪烁）", () => {
    expect(shouldShowHistorySkeleton(base({ cachedCount: 3 }))).toBe(false);
    // 即便确知有历史，只要本地已有缓存也不骨架（历史到达即隐藏的核心保证）
    expect(shouldShowHistorySkeleton(base({ cachedCount: 5, knownMessageCount: 9 }))).toBe(false);
  });

  test("有 in-flight turn(sending) → 走 typing 指示，不显示骨架", () => {
    expect(shouldShowHistorySkeleton(base({ sending: true }))).toBe(false);
  });

  test("canonical history 仍在途 → 即使固定 cap 已过也继续显示骨架", () => {
    expect(
      shouldShowHistorySkeleton(base({
        loading: true,
        knownMessageCount: 6,
        metaKnown: true,
        capExpired: true,
      })),
    ).toBe(true);
    expect(shouldShowHistorySkeleton(base({ loading: true, cachedCount: 1 }))).toBe(false);
    expect(shouldShowHistorySkeleton(base({ loading: true, sending: true }))).toBe(false);
  });

  test("确知有历史(messageCount>0) → 无缓存时显示，直到内容到达/安全兜底", () => {
    expect(shouldShowHistorySkeleton(base({ knownMessageCount: 6, metaKnown: true }))).toBe(true);
    // 安全兜底超时后隐藏（防历史拉取失败时骨架永停）
    expect(
      shouldShowHistorySkeleton(base({ knownMessageCount: 6, metaKnown: true, capExpired: true })),
    ).toBe(false);
  });

  test("权威已知为空会话(metaKnown && count=0) → 直接 EmptyState，不骨架", () => {
    expect(shouldShowHistorySkeleton(base({ metaKnown: true, knownMessageCount: 0 }))).toBe(false);
  });

  test("meta 未知(深链/列表未落定) → 800ms 兜底窗内显示，过后放行", () => {
    expect(shouldShowHistorySkeleton(base({ metaKnown: false, graceExpired: false }))).toBe(true);
    expect(shouldShowHistorySkeleton(base({ metaKnown: false, graceExpired: true }))).toBe(false);
  });
});

describe("MessageListSkeleton", () => {
  test("渲染无障碍加载态（aria-busy + 标注）", () => {
    render(<MessageListSkeleton />);
    const region = screen.getByLabelText("正在加载会话历史");
    expect(region).toHaveAttribute("aria-busy", "true");
  });
});

describe("PartialHistorySkeleton", () => {
  test("已有部分内容时保留真实消息，并用轻量尾部占位明确告知仍在加载", () => {
    render(<PartialHistorySkeleton />);
    const status = screen.getByRole("status", { name: "正在加载会话内容" });
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("正在加载会话内容…")).toBeInTheDocument();
  });
});

describe("JournalHydrationRetry", () => {
  test("renders an explicit retry without covering history", () => {
    const onRetry = vi.fn();
    render(<JournalHydrationRetry onRetry={onRetry} />);
    expect(screen.getByLabelText("实时内容未完全加载")).toBeInTheDocument();
    screen.getByRole("button", { name: "重新加载" }).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
