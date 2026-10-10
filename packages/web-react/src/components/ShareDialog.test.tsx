import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ChatMessage } from "../lib/chat/model";

const renderShareCard = vi.fn();
const saveBlob = vi.fn();
vi.mock("../lib/chat/shareCard", async (orig) => ({
  ...(await orig<typeof import("../lib/chat/shareCard")>()),
  renderShareCard: (...args: unknown[]) => renderShareCard(...args),
}));
vi.mock("../lib/chat/download", () => ({ saveBlob: (...args: unknown[]) => saveBlob(...args) }));

import { ShareDialog } from "./ShareDialog";
import { ToastProvider } from "./ui/Toast";

afterEach(cleanup);

const writeText = vi.fn(async (_text: string) => {});
beforeEach(() => {
  renderShareCard.mockReset();
  saveBlob.mockReset();
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  URL.createObjectURL = vi.fn(() => "blob:share");
  URL.revokeObjectURL = vi.fn();
});

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role">): ChatMessage {
  return { text: "", ts: 1, ...partial };
}

const MESSAGES = [
  msg({ id: "u1", role: "user", text: "整理客户名单" }),
  msg({ id: "a1", role: "assistant", text: "正在读取 /私有目录/客户名单", _clientMessageId: "u1" }),
  msg({ id: "t1", role: "tool", text: "Read", _clientMessageId: "u1" }),
  msg({ id: "a2", role: "assistant", text: "整理好了，共 12 位。", _clientMessageId: "u1" }),
];

function open(props: Partial<Parameters<typeof ShareDialog>[0]> = {}) {
  return render(
    <ToastProvider>
      <ShareDialog
        open
        onOpenChange={() => {}}
        messages={MESSAGES}
        sending={false}
        title="客户名单"
        agentName="全能助手"
        {...props}
      />
    </ToastProvider>,
  );
}

describe("ShareDialog", () => {
  it("生成长图后显示预览;保存图片用会话标题命名", async () => {
    const blob = new Blob(["png"], { type: "image/png" });
    renderShareCard.mockResolvedValue({ blob, layout: {} });
    open();
    expect(await screen.findByRole("img", { name: "分享长图预览" })).toHaveAttribute("src", "blob:share");
    const input = renderShareCard.mock.calls[0][0] as { messages: { text: string }[] };
    expect(input.messages.map((m) => m.text)).toEqual(["整理客户名单", "整理好了，共 12 位。"]);
    fireEvent.click(screen.getByRole("button", { name: /保存图片/ }));
    expect(saveBlob).toHaveBeenCalledWith(blob, "客户名单.png");
  });

  it("复制文字只含提问与最终回答,不含过程", async () => {
    renderShareCard.mockResolvedValue({ blob: new Blob(["png"]), layout: {} });
    open();
    await screen.findByRole("img", { name: "分享长图预览" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /复制文字/ }));
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0][0] as string;
    expect(text).toContain("【客户名单】");
    expect(text).toContain("整理好了，共 12 位。");
    expect(text).not.toContain("/私有目录");
  });

  it("画布不可用时提示并仍可复制文字;保存图片不可点", async () => {
    renderShareCard.mockRejectedValue(new Error("canvas unavailable"));
    open();
    expect(await screen.findByText("当前浏览器无法生成图片，可以复制文字分享。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /保存图片/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /复制文字/ })).toBeEnabled();
  });

  it("没有可分享内容时显示空态,不调用绘制", async () => {
    open({ messages: [] });
    expect(await screen.findByText("这个会话还没有可以分享的内容。")).toBeInTheDocument();
    expect(renderShareCard).not.toHaveBeenCalled();
  });

  it("生成中提示不含进行中的回答", async () => {
    renderShareCard.mockResolvedValue({ blob: new Blob(["png"]), layout: {} });
    open({ sending: true });
    expect(await screen.findByText("这一轮还在生成，分享内容不含进行中的回答。")).toBeInTheDocument();
    await waitFor(() => expect(renderShareCard).toHaveBeenCalled());
    const input = renderShareCard.mock.calls[0][0] as { messages: { text: string }[] };
    expect(input.messages.map((m) => m.text)).toEqual(["整理客户名单"]);
  });

  it("打开后消息数组被就地追加、sending 变化,切换范围仍用打开时的快照(code r1 #4)", async () => {
    renderShareCard.mockResolvedValue({ blob: new Blob(["png"]), layout: {} });
    const live = [...MESSAGES];
    const view = open({ messages: live });
    await screen.findByRole("img", { name: "分享长图预览" });
    live.push(
      msg({ id: "u2", role: "user", text: "再查一下" }),
      msg({ id: "a3", role: "assistant", text: "正在读取 /私有目录/另一份", _clientMessageId: "u2" }),
    );
    live[3].text = "被就地改写";
    view.rerender(
      <ToastProvider>
        <ShareDialog open onOpenChange={() => {}} messages={live} sending title="客户名单" agentName="全能助手" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("radio", { name: "全部" }));
    await waitFor(() => expect(renderShareCard.mock.calls.length).toBeGreaterThan(1));
    const last = renderShareCard.mock.calls.at(-1)?.[0] as { messages: { text: string }[] };
    expect(last.messages.map((m) => m.text)).toEqual(["整理客户名单", "整理好了，共 12 位。"]);
  });

  it("「导出 Markdown」保留原导出功能", async () => {
    renderShareCard.mockResolvedValue({ blob: new Blob(["png"]), layout: {} });
    const onExportMarkdown = vi.fn();
    open({ onExportMarkdown });
    fireEvent.click(screen.getByRole("button", { name: /导出 Markdown/ }));
    expect(onExportMarkdown).toHaveBeenCalledTimes(1);
  });
});
