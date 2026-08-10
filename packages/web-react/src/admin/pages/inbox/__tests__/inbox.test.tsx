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
    category: "user",
    thread_key: null,
    thread_count: 1,
    source_type: null,
    source_id: null,
    source_phase: null,
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
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:inbox-preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
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
    expect(screen.getByText("站内已读")).toBeInTheDocument();
  });

  test("发送 → 确认弹窗 → 命中 POST /messages", async () => {
    stubApi();
    adminSend.mockResolvedValue({ message: {} });
    renderPage(<InboxPage />);
    await screen.findByText("系统维护通知");

    fireEvent.change(screen.getByPlaceholderText("≤200 字"), { target: { value: "上线公告" } });
    fireEvent.change(screen.getByPlaceholderText(/输入 Markdown/), {
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
          category: "user",
        }),
      ),
    );
  });

  test("历史分类筛选会重置分页并传 category", async () => {
    stubApi();
    renderPage(<InboxPage />);
    await screen.findByText("系统维护通知");

    fireEvent.pointerDown(screen.getByRole("button", { name: /分类.*全部分类/ }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "自动化" }));
    await waitFor(() =>
      expect(adminGet).toHaveBeenCalledWith(
        "/messages",
        expect.objectContaining({ offset: 0, category: "automation" }),
      ),
    );
  });

  test("空标题拦截：不发请求", async () => {
    stubApi();
    renderPage(<InboxPage />);
    await screen.findByText("系统维护通知");
    // 只填正文，标题留空
    fireEvent.change(screen.getByPlaceholderText(/输入 Markdown/), {
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

  test("图表模板写入 Markdown，并在预览侧保留 chart fence", async () => {
    stubApi();
    renderPage(<InboxPage />);
    await screen.findByText("系统维护通知");

    fireEvent.click(screen.getByRole("button", { name: "插入数据图表模板" }));
    const value = (screen.getByPlaceholderText(/输入 Markdown/) as HTMLTextAreaElement).value;
    expect(value).toContain("```chart");
    expect(value).toContain('"type":"bar"');
  });

  test("选择图片后插入占位符，发送 payload 带 base64 asset", async () => {
    stubApi();
    adminSend.mockResolvedValue({ message: {} });
    renderPage(<InboxPage />);
    await screen.findByText("系统维护通知");

    const file = new File([new Uint8Array([1, 2, 3, 4])], "demo.png", { type: "image/png" });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    });
    fireEvent.change(screen.getByLabelText("选择站内信图片"), { target: { files: [file] } });
    expect(await screen.findByText("demo.png")).toBeInTheDocument();
    expect((screen.getByPlaceholderText(/输入 Markdown/) as HTMLTextAreaElement).value).toMatch(
      /!\[demo\.png\]\(inbox-asset:\/\/[0-9a-f-]{36}\)/,
    );

    fireEvent.change(screen.getByPlaceholderText("≤200 字"), { target: { value: "图片公告" } });
    fireEvent.click(screen.getByRole("button", { name: /^发送$/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "发送" }));

    await waitFor(() =>
      expect(adminSend).toHaveBeenCalledWith(
        "POST",
        "/messages",
        expect.objectContaining({
          title: "图片公告",
          assets: [
            expect.objectContaining({
              filename: "demo.png",
              mime_type: "image/png",
              data_base64: "AQIDBA==",
            }),
          ],
        }),
      ),
    );
  });
});
