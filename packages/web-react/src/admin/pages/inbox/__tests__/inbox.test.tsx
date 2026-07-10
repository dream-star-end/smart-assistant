import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToastProvider, TooltipProvider } from "../../../../components/ui";
import type { InboxMessage } from "../types";

const adminGet = vi.fn();
const adminSend = vi.fn();
vi.mock("../../../lib/adminApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/adminApi")>("../../../lib/adminApi");
  return { ...actual, adminGet: (...a: unknown[]) => adminGet(...a), adminSend: (...a: unknown[]) => adminSend(...a) };
});

import InboxPage from "../index";

function renderPage(node: ReactNode) {
  return render(
    <ToastProvider>
      <TooltipProvider>{node}</TooltipProvider>
    </ToastProvider>,
  );
}

function msg(over: Partial<InboxMessage> = {}): InboxMessage {
  return {
    id: 1,
    audience: "all",
    user_id: null,
    title: "系统维护通知",
    body_md: "# 维护\n今晚 02:00 维护。",
    level: "notice",
    created_by: 1,
    created_at: new Date().toISOString(),
    expires_at: null,
    read_count: 3,
    recipients: 100,
    notify_email: false,
    email_send_status: null,
    email_sent_at: null,
    email_summary: null,
    ...over,
  };
}

function stubApi() {
  adminGet.mockImplementation((path: string) => {
    if (path === "/messages/email-config") {
      return Promise.resolve({ enabled: true, provider: "stub" });
    }
    if (path === "/messages") {
      return Promise.resolve({ messages: [msg()], total: 1 });
    }
    return Promise.resolve({});
  });
}

beforeEach(() => {
  adminGet.mockReset();
  adminSend.mockReset();
});
afterEach(cleanup);

describe("InboxPage", () => {
  test("渲染发送卡 + 历史 + 邮件配置提示", async () => {
    stubApi();
    renderPage(<InboxPage />);

    expect(screen.getByText("新建站内信")).toBeInTheDocument();
    expect(screen.getByText("历史消息")).toBeInTheDocument();
    expect(await screen.findByText("系统维护通知")).toBeInTheDocument();
    // 邮件 worker=stub 提示
    expect(await screen.findByText(/stub mailer/)).toBeInTheDocument();
  });

  test("发送 → 确认弹窗 → 命中 POST /messages", async () => {
    stubApi();
    adminSend.mockResolvedValue({ message: {} });
    renderPage(<InboxPage />);
    await screen.findByText("系统维护通知");

    fireEvent.change(screen.getByPlaceholderText("≤200 字"), { target: { value: "上线公告" } });
    fireEvent.change(screen.getByPlaceholderText(/支持完整 Markdown/), {
      target: { value: "正文内容" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送/ }));

    // 确认弹窗
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "发送" }));

    await waitFor(() =>
      expect(adminSend).toHaveBeenCalledWith(
        "POST",
        "/messages",
        expect.objectContaining({
          audience: "all",
          title: "上线公告",
          body_md: "正文内容",
          level: "info",
        }),
      ),
    );
  });

  test("空标题拦截：不发请求", async () => {
    stubApi();
    renderPage(<InboxPage />);
    await screen.findByText("系统维护通知");
    // 只填正文，标题留空
    fireEvent.change(screen.getByPlaceholderText(/支持完整 Markdown/), {
      target: { value: "正文" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送/ }));
    // 不弹确认、不发请求
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(adminSend).not.toHaveBeenCalled();
  });

  test("删除 → 二次确认 → 命中 DELETE /messages/:id", async () => {
    stubApi();
    adminSend.mockResolvedValue({ deleted: true });
    renderPage(<InboxPage />);
    await screen.findByText("系统维护通知");

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

    await waitFor(() => expect(adminSend).toHaveBeenCalledWith("DELETE", "/messages/1"));
  });
});
