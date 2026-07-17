import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { AuthSession, MarketplaceMyPublish } from "../lib/types";
import { createMemoryAuthSession } from "../lib/authSession";

const monitor = vi.hoisted(() => ({
  emit: null as null | ((transition: { previousStatus: "pending"; publish: MarketplaceMyPublish }) => void),
  refresh: vi.fn(),
  mute: vi.fn(),
  catalogChange: null as null | (() => void),
}));

vi.mock("./marketplace/useMarketplacePublishes", () => ({
  useMarketplacePublishes: ({
    onTransition,
  }: {
    onTransition: (transition: { previousStatus: "pending"; publish: MarketplaceMyPublish }) => void;
  }) => {
    monitor.emit = onTransition;
    return {
      rows: [],
      loading: false,
      error: null,
      refresh: monitor.refresh,
      muteTransition: monitor.mute,
    };
  },
}));

vi.mock("./marketplace/useMarketplaceRevision", () => ({
  useMarketplaceRevision: ({ onChange }: { onChange: () => void }) => {
    monitor.catalogChange = onChange;
  },
}));

vi.mock("./marketplace/BrowsePanel", () => ({
  BrowsePanel: ({
    kind,
    revision,
    focusRequest,
    onFocusRequestConsumed,
  }: {
    kind: string;
    revision: number;
    focusRequest?: { slug: string; nonce: number } | null;
    onFocusRequestConsumed?: (nonce: number) => void;
  }) => (
    <div data-testid="browse-props">
      {kind}|{revision}|{focusRequest?.slug ?? "none"}
      {focusRequest && (
        <button type="button" onClick={() => onFocusRequestConsumed?.(focusRequest.nonce)}>
          consume-focus
        </button>
      )}
    </div>
  ),
}));
vi.mock("./marketplace/InstalledPanel", () => ({ InstalledPanel: () => <div>installed</div> }));
vi.mock("./marketplace/PublishPanel", () => ({ PublishPanel: () => <div>publish</div> }));
vi.mock("./marketplace/ReviewPanel", () => ({ ReviewPanel: () => <div>review</div> }));

import { MarketplaceCenter } from "./MarketplaceCenter";

const auth: AuthSession = createMemoryAuthSession(() => {}, "tok");

function publish(status: "approved" | "rejected", over: Partial<MarketplaceMyPublish> = {}) {
  return {
    versionId: "201",
    slug: "docs-plugin",
    kind: "connector" as const,
    artifactKind: "plugin" as const,
    pluginType: "declarative-http" as const,
    version: "1.0.0",
    name: "文档插件",
    status,
    reviewNote: status === "rejected" ? "固定域名声明不完整" : null,
    createdAt: "2026-07-15T00:00:00Z",
    isCurrent: status === "approved",
    listingState: "active",
    ...over,
  } satisfies MarketplaceMyPublish;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  monitor.emit = null;
  monitor.catalogChange = null;
});

test("目录 revision 变化会刷新跨客户端市场和发布状态", () => {
  render(
    <MarketplaceCenter
      open
      tab="browse"
      auth={auth}
      isAdmin={false}
      onTabChange={() => {}}
      onClose={() => {}}
    />,
  );
  expect(screen.getByTestId("browse-props")).toHaveTextContent("skill|0|none");
  act(() => monitor.catalogChange?.());
  expect(screen.getByTestId("browse-props")).toHaveTextContent("skill|1|none");
  expect(monitor.refresh).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "关闭" })).toHaveClass("shrink-0", "[@media(hover:none)]:size-11");
  expect(screen.getByRole("button", { name: "技能" })).toHaveClass("[@media(hover:none)]:min-h-11");
  expect(screen.getByRole("heading", { name: "AI 市场" }).parentElement).toHaveClass("min-w-0");
  expect(screen.getByRole("dialog")).toHaveClass("oc-center-dialog", "h-[min(85vh,46rem)]", "h-[min(85dvh,46rem)]");
  expect(screen.getByRole("dialog")).not.toHaveClass("top-1/2");
});

test("连接器旧 kind 在产品层显示为插件；通过通知 CTA 实时刷新并一次性打开条目", () => {
  const onTabChange = vi.fn();
  render(
    <MarketplaceCenter
      open
      tab="browse"
      auth={auth}
      isAdmin={false}
      initialBrowseKind="connector"
      onTabChange={onTabChange}
      onClose={() => {}}
    />,
  );

  expect(screen.getByRole("button", { name: "插件" })).toBeInTheDocument();
  expect(screen.getByTestId("browse-props")).toHaveTextContent("connector|0|none");

  act(() => monitor.emit?.({ previousStatus: "pending", publish: publish("approved") }));
  expect(screen.getByText("API 连接插件已实时上架")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "在市场查看" }));

  expect(onTabChange).toHaveBeenCalledWith("browse");
  expect(screen.getByTestId("browse-props")).toHaveTextContent("connector|1|docs-plugin");
  fireEvent.click(screen.getByRole("button", { name: "consume-focus" }));
  expect(screen.getByTestId("browse-props")).toHaveTextContent("connector|1|none");
});

test("拒绝通知如实展示理由，并可进入我的发布", () => {
  const onTabChange = vi.fn();
  render(
    <MarketplaceCenter
      open
      tab="browse"
      auth={auth}
      isAdmin={false}
      onTabChange={onTabChange}
      onClose={() => {}}
    />,
  );

  act(() => monitor.emit?.({ previousStatus: "pending", publish: publish("rejected") }));
  expect(screen.getByText("API 连接插件未通过审核")).toBeInTheDocument();
  expect(screen.getByText(/固定域名声明不完整/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "查看我的发布" }));
  expect(onTabChange).toHaveBeenCalledWith("publish");
});
