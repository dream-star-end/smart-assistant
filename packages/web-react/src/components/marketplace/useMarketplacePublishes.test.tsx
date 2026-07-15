import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { AuthSession, MarketplaceMyPublish } from "../../lib/types";

const listMarketplaceMyPublishes = vi.fn();
vi.mock("../../lib/api", () => ({
  api: {
    listMarketplaceMyPublishes: (...args: unknown[]) => listMarketplaceMyPublishes(...args),
  },
  apiErrorMessage: (_cause: unknown, fallback: string) => fallback,
}));

import {
  detectPublishTransitions,
  type MarketplacePublishTransition,
  useMarketplacePublishes,
} from "./useMarketplacePublishes";

const auth: AuthSession = { getToken: () => "tok", setToken: () => {}, onExpired: () => {} };

function publish(status: string, over: Partial<MarketplaceMyPublish> = {}): MarketplaceMyPublish {
  return {
    versionId: "101",
    slug: "docs-plugin",
    kind: "connector",
    artifactKind: "plugin",
    pluginType: "declarative-http",
    version: "1.0.0",
    name: "文档插件",
    status,
    createdAt: "2026-07-15T00:00:00Z",
    isCurrent: status === "approved",
    listingState: "active",
    ...over,
  };
}

function Harness({ onTransition }: { onTransition: (value: MarketplacePublishTransition) => void }) {
  const state = useMarketplacePublishes({ auth, enabled: true, onTransition });
  return (
    <div>
      <span>{state.rows?.[0]?.status ?? (state.loading ? "loading" : "empty")}</span>
      <button type="button" onClick={state.refresh}>
        refresh
      </button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("首个成功快照只建基线；pending→approved 才触发一次转换", async () => {
  vi.useFakeTimers();
  listMarketplaceMyPublishes
    .mockResolvedValueOnce([publish("pending")])
    .mockResolvedValueOnce([publish("approved", { reviewSource: "ai" })]);
  const onTransition = vi.fn();

  render(<Harness onTransition={onTransition} />);
  await act(async () => Promise.resolve());
  expect(screen.getByText("pending")).toBeInTheDocument();
  expect(onTransition).not.toHaveBeenCalled();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(screen.getByText("approved")).toBeInTheDocument();
  expect(onTransition).toHaveBeenCalledTimes(1);
  expect(onTransition.mock.calls[0][0].publish.slug).toBe("docs-plugin");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(4_000);
  });
  expect(listMarketplaceMyPublishes).toHaveBeenCalledTimes(2);
});

test("首次基线请求失败会自动重试；成功取得 pending 基线时不误报", async () => {
  vi.useFakeTimers();
  listMarketplaceMyPublishes
    .mockRejectedValueOnce(new Error("temporary"))
    .mockResolvedValueOnce([publish("pending")]);
  const onTransition = vi.fn();

  render(<Harness onTransition={onTransition} />);
  await act(async () => Promise.resolve());
  expect(listMarketplaceMyPublishes).toHaveBeenCalledTimes(1);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(listMarketplaceMyPublishes).toHaveBeenCalledTimes(2);
  expect(screen.getByText("pending")).toBeInTheDocument();
  expect(onTransition).not.toHaveBeenCalled();
});

test("空基线后的显式刷新失败会重试，发现 pending 后继续追踪至终态", async () => {
  vi.useFakeTimers();
  listMarketplaceMyPublishes
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error("temporary"))
    .mockResolvedValueOnce([publish("pending")])
    .mockResolvedValueOnce([publish("approved")]);
  const onTransition = vi.fn();

  render(<Harness onTransition={onTransition} />);
  await act(async () => Promise.resolve());
  expect(screen.getByText("empty")).toBeInTheDocument();

  await act(async () => fireEvent.click(screen.getByRole("button", { name: "refresh" })));
  expect(listMarketplaceMyPublishes).toHaveBeenCalledTimes(2);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(screen.getByText("pending")).toBeInTheDocument();
  expect(onTransition).not.toHaveBeenCalled();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(screen.getByText("approved")).toBeInTheDocument();
  expect(onTransition).toHaveBeenCalledTimes(1);
});

test("打开市场时已经终态的历史发布不通知，也不继续轮询", async () => {
  vi.useFakeTimers();
  listMarketplaceMyPublishes.mockResolvedValue([publish("approved")]);
  const onTransition = vi.fn();

  render(<Harness onTransition={onTransition} />);
  await act(async () => Promise.resolve());
  expect(screen.getByText("approved")).toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(listMarketplaceMyPublishes).toHaveBeenCalledTimes(1);
  expect(onTransition).not.toHaveBeenCalled();
});

test("转换检测按 versionId+终态去重，并可静音用户主动撤销", () => {
  const previous = new Map([["101", "pending"]]);
  const seen = new Set<string>();
  const approved = publish("approved");
  expect(detectPublishTransitions(previous, [approved], seen, new Set())).toHaveLength(1);
  expect(detectPublishTransitions(previous, [approved], seen, new Set())).toHaveLength(0);

  const rejected = publish("rejected", { versionId: "102" });
  const priorRejected = new Map([["102", "pending"]]);
  expect(
    detectPublishTransitions(priorRejected, [rejected], seen, new Set(["102"])),
  ).toHaveLength(0);
});

test("页面隐藏时暂停 pending 轮询，恢复可见后立即校准", async () => {
  vi.useFakeTimers();
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  listMarketplaceMyPublishes.mockResolvedValue([publish("pending")]);

  render(<Harness onTransition={() => {}} />);
  await act(async () => Promise.resolve());
  expect(listMarketplaceMyPublishes).toHaveBeenCalledTimes(1);

  visibility = "hidden";
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6_000);
  });
  expect(listMarketplaceMyPublishes).toHaveBeenCalledTimes(1);

  visibility = "visible";
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(listMarketplaceMyPublishes).toHaveBeenCalledTimes(2);
});
