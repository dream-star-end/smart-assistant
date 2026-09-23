import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { MessageList } from "../MessageRenderer";
import { QueuedSendList } from "./QueuedSendList";

afterEach(() => cleanup());

function user(partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "text">): ChatMessage {
  return { role: "user", ts: 1, ...partial };
}

describe("待发送列表", () => {
  test("钉在输入框上方的卡片右侧有修改和立即发送，不把排队消息画进对话", () => {
    const onEdit = vi.fn();
    const onSendNow = vi.fn();
    const waiting = user({ id: "wait", text: "等上一轮结束再发", status: "queued" });
    render(<QueuedSendList messages={[waiting]} onEdit={onEdit} onSendNow={onSendNow} />);
    expect(screen.getByTestId("queued-send-list")).toBeInTheDocument();
    expect(screen.getByText("等上一轮结束再发")).toBeInTheDocument();
    screen.getByRole("button", { name: "修改" }).click();
    screen.getByRole("button", { name: "立即发送" }).click();
    expect(onEdit).toHaveBeenCalledWith(waiting);
    expect(onSendNow).toHaveBeenCalledWith(waiting);
  });

  test("对话流不渲染还在排队的用户消息", () => {
    render(
      <MessageList
        messages={[
          user({ id: "sent", text: "已经发出去", status: "sent" }),
          user({ id: "wait", text: "还在排队不要进对话", status: "queued" }),
        ]}
        sending
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByText("已经发出去")).toBeInTheDocument();
    expect(screen.queryByText("还在排队不要进对话")).toBeNull();
    expect(screen.queryByRole("button", { name: "立即发送" })).toBeNull();
  });
});
