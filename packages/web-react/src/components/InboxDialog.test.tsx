import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AuthSession, InboxMessage } from "../lib/types";

// api 网络层全 mock —— 只验证抽屉与契约的交互（拉列表 / 单条已读 / 全部已读 / 分页）。
const listInboxMessages = vi.fn();
const markInboxRead = vi.fn();
const markAllInboxRead = vi.fn();
vi.mock("../lib/api", () => ({
  api: {
    listInboxMessages: (...a: unknown[]) => listInboxMessages(...a),
    markInboxRead: (...a: unknown[]) => markInboxRead(...a),
    markAllInboxRead: (...a: unknown[]) => markAllInboxRead(...a),
  },
  // 错误态直接回退到 fallback 文案，便于断言。
  apiErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

// Markdown 走懒加载 + Suspense；测试里替身为直渲 children，专注面板行为。
vi.mock("./Markdown", () => ({
  Markdown: ({ children }: { children: string }) => <div data-testid="md-body">{children}</div>,
}));

import { InboxDialog } from "./InboxDialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const auth: AuthSession = {
  getToken: () => "tok",
  setToken: () => {},
  onExpired: () => {},
};

function mk(id: string, extra: Partial<InboxMessage> = {}): InboxMessage {
  return {
    id,
    audience: "all",
    user_id: null,
    title: `标题${id}`,
    body_md: `正文 ${id} 内容`,
    level: "info",
    created_by: "1",
    created_at: new Date().toISOString(),
    expires_at: null,
    read: false,
    ...extra,
  };
}

describe("InboxDialog", () => {
  test("渲染列表（标题/摘要/未读加粗），打开后不自动标已读", async () => {
    listInboxMessages.mockResolvedValue({
      messages: [
        mk("1", { level: "notice", read: false, body_md: "**加粗** 摘要一 <!-- ob:abc -->" }),
        mk("2", { read: true, body_md: "# 标题行\n摘要二正文" }),
      ],
      unread_count: 1,
    });
    const onUnreadChange = vi.fn();

    render(<InboxDialog open auth={auth} onClose={() => {}} onUnreadChange={onUnreadChange} />);

    const title1 = await screen.findByText("标题1");
    expect(screen.getByText("标题2")).toBeInTheDocument();

    // 摘要剥掉 Markdown 标记与 ob 防重发 marker（不出现原始 ** 或 <!-- ob -->）。
    expect(screen.getByText("加粗 摘要一")).toBeInTheDocument();
    expect(screen.getByText("标题行 摘要二正文")).toBeInTheDocument();

    // 未读加粗、已读常规。
    expect(title1).toHaveClass("font-semibold");
    expect(screen.getByText("标题2")).toHaveClass("font-medium");

    // 关键：打开面板绝不自动标已读。
    await waitFor(() => expect(listInboxMessages).toHaveBeenCalled());
    expect(markInboxRead).not.toHaveBeenCalled();
    // 首屏拉取不带 unread_only（全部 Tab）。
    expect(listInboxMessages).toHaveBeenCalledWith(auth, { limit: 30, unreadOnly: false });
  });

  test("展开未读条目：渲染全文 + 恰好一次单条已读 + 回调；已读条目展开不再标记", async () => {
    listInboxMessages.mockResolvedValue({
      messages: [mk("1", { read: false }), mk("2", { read: true })],
      unread_count: 1,
    });
    markInboxRead.mockResolvedValue({ ok: true, already: false });
    const onUnreadChange = vi.fn();

    render(<InboxDialog open auth={auth} onClose={() => {}} onUnreadChange={onUnreadChange} />);
    await screen.findByText("标题1");

    // 展开未读条目 id=1。
    fireEvent.click(screen.getByRole("button", { name: /标题1/ }));
    expect(await screen.findByTestId("md-body")).toHaveTextContent("正文 1 内容");

    await waitFor(() => expect(markInboxRead).toHaveBeenCalledTimes(1));
    expect(markInboxRead).toHaveBeenCalledWith(auth, "1");
    await waitFor(() => expect(onUnreadChange).toHaveBeenCalledTimes(1));

    // 展开已读条目 id=2：不再触发单条已读。
    fireEvent.click(screen.getByRole("button", { name: /标题2/ }));
    await waitFor(() =>
      expect(screen.getAllByTestId("md-body").some((n) => n.textContent === "正文 2 内容")).toBe(true),
    );
    expect(markInboxRead).toHaveBeenCalledTimes(1);
  });

  test("全部已读：调 markAllInboxRead，本地全部置读，按钮转禁用", async () => {
    listInboxMessages.mockResolvedValue({
      messages: [mk("1", { read: false }), mk("2", { read: false })],
      unread_count: 2,
    });
    markAllInboxRead.mockResolvedValue({ ok: true, inserted: 2 });
    const onUnreadChange = vi.fn();

    render(<InboxDialog open auth={auth} onClose={() => {}} onUnreadChange={onUnreadChange} />);
    await screen.findByText("标题1");

    const allBtn = screen.getByRole("button", { name: /全部已读/ });
    expect(allBtn).toBeEnabled();
    fireEvent.click(allBtn);

    await waitFor(() => expect(markAllInboxRead).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onUnreadChange).toHaveBeenCalledTimes(1));
    // 本地全部置读 → 标题转常规、按钮禁用。
    await waitFor(() => expect(screen.getByText("标题1")).toHaveClass("font-medium"));
    expect(screen.getByRole("button", { name: /全部已读/ })).toBeDisabled();
  });

  test("切到「未读」Tab：重新拉取且带 unreadOnly", async () => {
    listInboxMessages.mockResolvedValue({ messages: [mk("1", { read: false })], unread_count: 1 });
    render(<InboxDialog open auth={auth} onClose={() => {}} onUnreadChange={() => {}} />);
    await screen.findByText("标题1");

    fireEvent.click(screen.getByRole("tab", { name: "未读" }));

    await waitFor(() =>
      expect(listInboxMessages).toHaveBeenCalledWith(auth, { limit: 30, unreadOnly: true }),
    );
  });

  test("加载更多：带 offset 的第二次请求并追加列表", async () => {
    const page1 = Array.from({ length: 30 }, (_, i) => mk(String(i), { read: true }));
    listInboxMessages
      .mockResolvedValueOnce({ messages: page1, unread_count: 0 })
      .mockResolvedValueOnce({ messages: [mk("m30", { read: true })], unread_count: 0 });

    render(<InboxDialog open auth={auth} onClose={() => {}} onUnreadChange={() => {}} />);
    await screen.findByText("标题0");

    // 首页满 30 条 → 出现「加载更多」。
    fireEvent.click(await screen.findByRole("button", { name: "加载更多" }));

    await waitFor(() =>
      expect(listInboxMessages).toHaveBeenLastCalledWith(auth, {
        limit: 30,
        offset: 30,
        unreadOnly: false,
      }),
    );
    expect(await screen.findByText("标题m30")).toBeInTheDocument();
    // 原有条目仍在（追加而非替换）。
    expect(screen.getByText("标题0")).toBeInTheDocument();
  });

  test("空态：全部 Tab 显示「暂无消息」", async () => {
    listInboxMessages.mockResolvedValue({ messages: [], unread_count: 0 });
    render(<InboxDialog open auth={auth} onClose={() => {}} onUnreadChange={() => {}} />);
    expect(await screen.findByText("暂无消息")).toBeInTheDocument();
  });

  test("错误态 + 重试：先报错，点重试后成功渲染", async () => {
    listInboxMessages
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ messages: [mk("1", { read: true })], unread_count: 0 });

    render(<InboxDialog open auth={auth} onClose={() => {}} onUnreadChange={() => {}} />);
    expect(await screen.findByText("加载站内信失败")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("标题1")).toBeInTheDocument();
  });
});
