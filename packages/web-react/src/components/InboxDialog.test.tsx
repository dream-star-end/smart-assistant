import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AuthSession, InboxMessage } from "../lib/types";

// api 网络层全 mock —— 只验证面板与契约的交互（拉列表 / 可见即已读 / 全部已读）。
const listInboxMessages = vi.fn();
const markInboxRead = vi.fn();
const markAllInboxRead = vi.fn();
vi.mock("../lib/api", () => ({
  api: {
    listInboxMessages: (...a: unknown[]) => listInboxMessages(...a),
    markInboxRead: (...a: unknown[]) => markInboxRead(...a),
    markAllInboxRead: (...a: unknown[]) => markAllInboxRead(...a),
  },
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
  test("打开拉列表、渲染标题与 level chip、对未读做可见即已读并回调 onUnreadChange", async () => {
    listInboxMessages.mockResolvedValue({
      messages: [mk("1", { level: "notice", read: false }), mk("2", { read: true })],
      unread_count: 1,
    });
    markInboxRead.mockResolvedValue({ ok: true, already: false });
    const onUnreadChange = vi.fn();

    render(<InboxDialog open auth={auth} onClose={() => {}} onUnreadChange={onUnreadChange} />);

    expect(await screen.findByText("标题1")).toBeInTheDocument();
    expect(screen.getByText("标题2")).toBeInTheDocument();
    // notice → "公告" level chip
    expect(screen.getByText("公告")).toBeInTheDocument();

    // 可见即已读：仅未读那条(id=1)被标记，已读(id=2)不重复标记。
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledTimes(1));
    expect(markInboxRead).toHaveBeenCalledWith(auth, "1");
    await waitFor(() => expect(onUnreadChange).toHaveBeenCalled());
  });

  test("全部消息已读时不触发任何标记调用", async () => {
    listInboxMessages.mockResolvedValue({
      messages: [mk("1", { read: true })],
      unread_count: 0,
    });
    const onUnreadChange = vi.fn();

    render(<InboxDialog open auth={auth} onClose={() => {}} onUnreadChange={onUnreadChange} />);
    expect(await screen.findByText("标题1")).toBeInTheDocument();
    expect(markInboxRead).not.toHaveBeenCalled();
  });

  test("空列表显示占位", async () => {
    listInboxMessages.mockResolvedValue({ messages: [], unread_count: 0 });
    render(<InboxDialog open auth={auth} onClose={() => {}} onUnreadChange={() => {}} />);
    expect(await screen.findByText("暂无消息")).toBeInTheDocument();
  });
});
