import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isInteractiveOnlyDecision,
  type ListPendingDecisionsResponse,
  type PendingDecisionItem,
} from "../../lib/api/wave4Api";
import { createMemoryAuthSession } from "../../lib/authSession";
import { ToastProvider } from "../ui";
import {
  PENDING_DECISIONS_COLLAPSED_STORAGE_KEY,
  PendingDecisionsDock,
  resolveTaskboardTicketRef,
} from "./PendingDecisionsDock";

const origFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = origFetch;
  try {
    window.localStorage.removeItem(PENDING_DECISIONS_COLLAPSED_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
});

function makeItem(overrides: Partial<PendingDecisionItem>): PendingDecisionItem {
  return {
    id: "turn_permission:req-1",
    source: "turn_permission",
    sourceId: "req-1",
    userId: "42",
    sessionId: "sess-1",
    title: "工具授权: bash",
    summary: "npm run build",
    riskLevel: "high",
    status: "pending",
    metadata: {},
    createdAt: "2026-11-21T08:00:00Z",
    expiresAt: "2026-11-21T08:15:00Z",
    allowedActions: ["approve", "deny"],
    ...overrides,
  };
}

function listPayload(items: PendingDecisionItem[]): ListPendingDecisionsResponse {
  return {
    items,
    counts: {
      total: items.length,
      bySource: {
        turn_permission: items.filter((i) => i.source === "turn_permission").length,
        connector_write: items.filter((i) => i.source === "connector_write").length,
        taskboard: items.filter((i) => i.source === "taskboard").length,
        browser_handoff: items.filter((i) => i.source === "browser_handoff").length,
      },
    },
    generatedAt: "2026-11-21T08:01:00Z",
  };
}

describe("PendingDecisionsDock · 统一待拍板聚合收件箱", () => {
  it("无待拍板项时零噪音收起（返回 null）", async () => {
    const auth = createMemoryAuthSession(() => {}, "jwt-pd-token");
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(listPayload([])), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as typeof fetch;

    const { container } = render(
      <ToastProvider>
        <PendingDecisionsDock auth={auth} pollIntervalMs={0} />
      </ToastProvider>,
    );

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    expect(container.querySelector('[data-testid="pending-decisions-dock"]')).toBeNull();
  });

  it("严格区分二元审批项与交互式直达项（ask_user 与 browser_handoff 绝不出现误导性批准按钮）", async () => {
    const auth = createMemoryAuthSession(() => {}, "jwt-pd-token");
    const items: PendingDecisionItem[] = [
      makeItem({
        id: "connector_write:cw-1",
        source: "connector_write",
        sourceId: "cw-1",
        title: "连接器外部写入: GitHub PR Comment",
        summary: "向 PR #128 发表评论",
        riskLevel: "medium",
      }),
      makeItem({
        id: "turn_permission:ask-user:q-1",
        source: "turn_permission",
        sourceId: "ask-user:q-1",
        sessionId: "sess-ask",
        title: "交互式提问: AskUserQuestion",
        summary: "需要前往网页会话填写结构化回答",
        metadata: { requiresInteractiveAnswer: true },
        allowedActions: ["deny"],
      }),
      makeItem({
        id: "browser_handoff:bh-1",
        source: "browser_handoff",
        sourceId: "bh-1",
        sessionId: "sess-browser",
        title: "浏览器人工接管",
        summary: "请完成 2FA 验证 (https://github.com/login)",
        metadata: { url: "https://github.com/login", reason: "2FA" },
        allowedActions: ["approve", "deny"],
      }),
    ];

    expect(isInteractiveOnlyDecision(items[0]!)).toBe(false);
    expect(isInteractiveOnlyDecision(items[1]!)).toBe(true);
    expect(isInteractiveOnlyDecision(items[2]!)).toBe(true);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/me/pending-decisions") && init?.method === "GET") {
        return new Response(JSON.stringify(listPayload(items)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/resolve") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            id: "connector_write:cw-1",
            source: "connector_write",
            sourceId: "cw-1",
            decision: "approve",
            status: "approved",
            idempotentReplay: false,
            resolvedAt: "2026-11-21T08:02:00Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const onSelectSession = vi.fn();
    const onOpenLiveBrowser = vi.fn();
    render(
      <ToastProvider>
        <PendingDecisionsDock
          auth={auth}
          pollIntervalMs={0}
          onSelectSession={onSelectSession}
          onOpenLiveBrowser={onOpenLiveBrowser}
        />
      </ToastProvider>,
    );

    expect(await screen.findByTestId("pending-decisions-dock")).toBeInTheDocument();
    expect(screen.getByTestId("pending-decisions-dock")).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByTestId("pending-decisions-count")).toHaveTextContent("3");
    expect(screen.getByTestId("pending-decisions-risk-dot")).toHaveAttribute("data-risk", "high");
    expect(screen.getByTestId("pending-decisions-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("pending-decisions-list")).toBeNull();
    expect(screen.queryAllByTestId("pending-decision-item")).toHaveLength(0);

    // 点击折叠条展开后，渲染全部卡片并保留二元审批 / 直达区分
    fireEvent.click(screen.getByTestId("pending-decisions-toggle"));
    expect(screen.getByTestId("pending-decisions-toggle")).toHaveAttribute("aria-expanded", "true");

    const cards = screen.getAllByTestId("pending-decision-item");
    expect(cards).toHaveLength(3);

    // 卡片 0（connector_write）有批准/拒绝按钮
    expect(within(cards[0]!).getByTestId("pending-decision-approve")).toBeInTheDocument();
    // 卡片 1（ask_user）绝无批准按钮，只有「直达回答」
    expect(within(cards[1]!).queryByTestId("pending-decision-approve")).toBeNull();
    fireEvent.click(within(cards[1]!).getByTestId("pending-decision-goto"));
    expect(onSelectSession).toHaveBeenCalledWith("sess-ask");

    // 卡片 2（browser_handoff）绝无批准按钮，只有「直达接管」
    expect(within(cards[2]!).queryByTestId("pending-decision-approve")).toBeNull();
    fireEvent.click(within(cards[2]!).getByTestId("pending-decision-goto"));
    expect(onOpenLiveBrowser).toHaveBeenCalledWith({
      url: "https://github.com/login",
      sessionId: "sess-browser",
    });

    // 点击卡片 0 的批准按钮后从列表移除
    fireEvent.click(within(cards[0]!).getByTestId("pending-decision-approve"));
    await waitFor(() => expect(screen.getAllByTestId("pending-decision-item")).toHaveLength(2));
  });

  it("409 冲突时展示冲突提示并自动刷新最新待拍板列表", async () => {
    const auth = createMemoryAuthSession(() => {}, "jwt-pd-token");
    let listCalls = 0;
    const item = makeItem({ id: "taskboard:tk-9", source: "taskboard", sourceId: "tk-9", title: "任务单待验收 #9" });

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/me/pending-decisions") && init?.method === "GET") {
        listCalls += 1;
        return new Response(JSON.stringify(listPayload([item])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/resolve") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ code: "CONFLICT_ALREADY_RESOLVED", message: "already resolved" }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    render(
      <ToastProvider>
        <PendingDecisionsDock auth={auth} pollIntervalMs={0} defaultCollapsed={false} />
      </ToastProvider>,
    );

    const approveBtn = await screen.findByTestId("pending-decision-approve");
    fireEvent.click(approveBtn);

    expect(await screen.findByTestId("pending-decisions-conflict")).toHaveTextContent(
      "已被其他终端处理",
    );
    await waitFor(() => expect(listCalls).toBe(2));
  });

  it("多条任务单待拍板全部渲染在可滚动列表内，且点击 ↗ 或标题直达对应任务单（含 identifier / ticketId / sourceId 回退）", async () => {
    const auth = createMemoryAuthSession(() => {}, "jwt-pd-token");
    const items: PendingDecisionItem[] = [
      makeItem({
        id: "taskboard:tk-145@v2",
        source: "taskboard",
        sourceId: "tk-145@v2",
        sessionId: null,
        title: "[OCV5-145] UX 持续迭代计划",
        summary: "等待人工验收",
        metadata: { ticketId: "tk-145", identifier: "OCV5-145", version: 2 },
      }),
      makeItem({
        id: "taskboard:tk-154@v1",
        source: "taskboard",
        sourceId: "tk-154@v1",
        sessionId: null,
        title: "[OCV5-154] 教程改为成果先行",
        summary: "等待人工验收",
        metadata: { ticketId: "tk-154", version: 1 },
      }),
      makeItem({
        id: "taskboard:tk-266@v4",
        source: "taskboard",
        sourceId: "tk-266@v4",
        sessionId: null,
        title: "[OCV5-266] 顾问模式对任意主模型可开",
        summary: "等待人工验收",
        metadata: {},
      }),
      makeItem({
        id: "taskboard:tk-301@v1",
        source: "taskboard",
        sourceId: "tk-301@v1",
        sessionId: null,
        title: "[OCV5-301] 第 4 条任务单",
        metadata: { ticketId: "tk-301", identifier: "OCV5-301", version: 1 },
      }),
      makeItem({
        id: "taskboard:tk-302@v1",
        source: "taskboard",
        sourceId: "tk-302@v1",
        sessionId: null,
        title: "[OCV5-302] 第 5 条任务单",
        metadata: { ticketId: "tk-302", identifier: "OCV5-302", version: 1 },
      }),
    ];

    expect(resolveTaskboardTicketRef(items[0]!)).toBe("OCV5-145");
    expect(resolveTaskboardTicketRef(items[1]!)).toBe("tk-154");
    expect(resolveTaskboardTicketRef(items[2]!)).toBe("tk-266");

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/me/pending-decisions") && init?.method === "GET") {
        return new Response(JSON.stringify(listPayload(items)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const onOpenBoard = vi.fn();
    render(
      <ToastProvider>
        <PendingDecisionsDock auth={auth} pollIntervalMs={0} onOpenBoard={onOpenBoard} />
      </ToastProvider>,
    );

    expect(await screen.findByTestId("pending-decisions-count")).toHaveTextContent("5");
    expect(screen.queryAllByTestId("pending-decision-item")).toHaveLength(0);

    fireEvent.click(screen.getByTestId("pending-decisions-toggle"));
    const cards = screen.getAllByTestId("pending-decision-item");
    expect(cards).toHaveLength(5);

    // 点击卡片 0 的 ↗ 按钮 → 直达 OCV5-145
    fireEvent.click(within(cards[0]!).getByTestId("pending-decision-open-source"));
    expect(onOpenBoard).toHaveBeenLastCalledWith("OCV5-145");

    // 点击卡片 1 的标题区 → 回退 metadata.ticketId
    fireEvent.click(within(cards[1]!).getByText("[OCV5-154] 教程改为成果先行"));
    expect(onOpenBoard).toHaveBeenLastCalledWith("tk-154");

    // 点击卡片 2 的 ↗ 按钮 → 从 sourceId 剥离 @v4
    fireEvent.click(within(cards[2]!).getByTestId("pending-decision-open-source"));
    expect(onOpenBoard).toHaveBeenLastCalledWith("tk-266");
  });

  it("展开/折叠偏好持久化到 localStorage：重挂载后保持用户选择，且优先于 defaultCollapsed", async () => {
    const auth = createMemoryAuthSession(() => {}, "jwt-pd-persist");
    const items: PendingDecisionItem[] = [
      makeItem({
        id: "connector_write:cw-low",
        source: "connector_write",
        sourceId: "cw-low",
        title: "普通低风险写入",
        riskLevel: "low",
      }),
    ];
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(listPayload(items)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as typeof fetch;

    const first = render(
      <ToastProvider>
        <PendingDecisionsDock auth={auth} pollIntervalMs={0} />
      </ToastProvider>,
    );

    expect(await screen.findByTestId("pending-decisions-dock")).toBeInTheDocument();
    // 全为低风险项时不展示高风险微点
    expect(screen.queryByTestId("pending-decisions-risk-dot")).toBeNull();
    expect(screen.getByTestId("pending-decisions-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryAllByTestId("pending-decision-item")).toHaveLength(0);

    // 用户点击展开，写入持久化偏好
    fireEvent.click(screen.getByTestId("pending-decisions-toggle"));
    expect(screen.getAllByTestId("pending-decision-item")).toHaveLength(1);
    expect(window.localStorage.getItem(PENDING_DECISIONS_COLLAPSED_STORAGE_KEY)).toBe("0");

    // 卸载重挂载（模拟关闭再打开移动端抽屉/侧栏）：保持展开
    first.unmount();
    const second = render(
      <ToastProvider>
        <PendingDecisionsDock auth={auth} pollIntervalMs={0} />
      </ToastProvider>,
    );
    expect(await screen.findByTestId("pending-decisions-dock")).toBeInTheDocument();
    expect(screen.getByTestId("pending-decisions-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByTestId("pending-decision-item")).toHaveLength(1);

    // 用户再次折叠，写入持久化偏好，即使外部传 defaultCollapsed={false} 也以用户持久化偏好为准
    fireEvent.click(screen.getByTestId("pending-decisions-toggle"));
    expect(window.localStorage.getItem(PENDING_DECISIONS_COLLAPSED_STORAGE_KEY)).toBe("1");
    second.unmount();

    render(
      <ToastProvider>
        <PendingDecisionsDock auth={auth} pollIntervalMs={0} defaultCollapsed={false} />
      </ToastProvider>,
    );
    expect(await screen.findByTestId("pending-decisions-dock")).toBeInTheDocument();
    expect(screen.getByTestId("pending-decisions-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryAllByTestId("pending-decision-item")).toHaveLength(0);
  });
});
