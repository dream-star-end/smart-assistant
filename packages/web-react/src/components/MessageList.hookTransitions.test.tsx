import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import type { ChatMessage } from "../lib/chat/model";
import { MessageList } from "./MessageRenderer";

afterEach(cleanup);

const rows: ChatMessage[] = [{
  id: "hook-order-user",
  role: "user",
  text: "HOOK_ORDER_VISIBLE_USER",
  ts: 1,
  status: "sent",
}];
const common = {
  cb: {},
  onRespondPermission: () => {},
  historyGeneration: "hook-order-session",
};

describe("MessageList preserves hooks across production mount branches", () => {
  test("callback-ref first commit binds null to the real scroll element", () => {
    function CallbackRefMount() {
      const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null);
      return (
        <div ref={setScrollParent} data-testid="hook-order-scroller">
          <MessageList {...common} messages={rows} sending={false} scrollParent={scrollParent} />
        </div>
      );
    }
    render(<StrictMode><CallbackRefMount /></StrictMode>);
    expect(screen.getByText("HOOK_ORDER_VISIBLE_USER")).toBeInTheDocument();
    expect(screen.getByTestId("hook-order-scroller")).toContainElement(
      screen.getByTestId("timeline-short-list"),
    );
    expect(screen.queryByText("正在准备会话…")).toBeNull();
  });

  test("explicit scroll ref can bind, detach and rebind without changing hook order", () => {
    const scroller = document.createElement("div");
    const view = render(
      <MessageList {...common} messages={rows} sending={false} scrollParent={null} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("正在准备会话");
    expect(screen.queryByText("HOOK_ORDER_VISIBLE_USER")).toBeNull();
    view.rerender(
      <MessageList {...common} messages={rows} sending={false} scrollParent={scroller} />,
    );
    expect(screen.getByText("HOOK_ORDER_VISIBLE_USER")).toBeInTheDocument();
    view.rerender(
      <MessageList {...common} messages={rows} sending={false} scrollParent={null} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("正在准备会话");
    view.rerender(
      <MessageList {...common} messages={rows} sending={false} scrollParent={scroller} readOnly />,
    );
    expect(screen.getByText("HOOK_ORDER_VISIBLE_USER")).toBeInTheDocument();
  });

  test("empty loading/activity chrome can enter and leave the transcript branch", () => {
    const scroller = document.createElement("div");
    const view = render(
      <MessageList {...common} messages={[]} sending historyLoading scrollParent={scroller} />,
    );
    expect(screen.getByLabelText("生成中")).toBeInTheDocument();
    expect(screen.getByLabelText("正在加载会话内容")).toBeInTheDocument();
    view.rerender(
      <MessageList {...common} messages={rows} sending scrollParent={scroller} />,
    );
    expect(screen.getByText("HOOK_ORDER_VISIBLE_USER")).toBeInTheDocument();
    expect(screen.getByLabelText("生成中")).toBeInTheDocument();
    expect(screen.queryByLabelText("正在加载会话内容")).toBeNull();
    view.rerender(
      <MessageList {...common} messages={[]} sending historyLoading scrollParent={scroller} />,
    );
    expect(screen.queryByText("HOOK_ORDER_VISIBLE_USER")).toBeNull();
    expect(screen.getByLabelText("正在加载会话内容")).toBeInTheDocument();
    view.rerender(
      <MessageList {...common} messages={rows} sending={false} scrollParent={scroller} />,
    );
    expect(screen.getByText("HOOK_ORDER_VISIBLE_USER")).toBeInTheDocument();
    expect(screen.queryByLabelText("生成中")).toBeNull();
  });
});
