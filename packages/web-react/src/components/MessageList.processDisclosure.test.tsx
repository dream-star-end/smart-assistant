import "@testing-library/jest-dom/vitest";
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ChatMessage } from "../lib/chat/model";
import { MessageList } from "./MessageRenderer";

afterEach(() => {
  cleanup();
});

function row(id: string, role: ChatMessage["role"], text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, text, ts: 1_700_000_000_000, ...extra };
}

function renderList(
  messages: ChatMessage[],
  extra: Partial<ComponentProps<typeof MessageList>> = {},
) {
  return render(
    <MessageList
      processDisclosure
      messages={messages}
      sending={false}
      sessionId="session-a"
      cb={{}}
      onRespondPermission={() => {}}
      {...extra}
    />,
  );
}

function settledTurn(): ChatMessage[] {
  return [
    row("u1", "user", "做一版库存看板", { status: "replied" }),
    row("stage-1", "assistant", "先核对库存口径", { _clientMessageId: "u1" }),
    row("think-1", "thinking", "**probe-thinking-trace**", { _clientMessageId: "u1" }),
    row("done-child", "agent-group", "已经结束的子任务", {
      _clientMessageId: "u1",
      _completed: true,
      _delegateStatus: "ok",
      _delegate: true,
    }),
    row("bash-1", "tool", "终端", {
      _clientMessageId: "u1",
      toolName: "Bash",
      inputJson: { command: "probe-stock-layout" },
      _completed: true,
      output: "ok",
    }),
    row("answer-1", "assistant", "看板已经做好", { _clientMessageId: "u1" }),
    row("pdf-1", "tool", "PDF", {
      _clientMessageId: "u1",
      toolName: "Bash",
      inputJson: { command: "oc-pdf paper.qmd -o /home/agent/out/paper.pdf" },
      _completed: true,
      output: "wrote pdf",
    }),
  ];
}

describe("MessageList Manus 过程披露", () => {
  test("默认只见回答和交付物，两级点击才看见阶段和工具", () => {
    renderList(settledTurn());
    expect(screen.getByText("看板已经做好")).toBeInTheDocument();
    const deliverable = screen.getByText(/paper\.pdf/);
    expect(deliverable.closest("[data-testid=process-disclosure]")).toBeNull();
    expect(screen.queryByText("先核对库存口径")).not.toBeInTheDocument();
    expect(screen.queryByText("probe-stock-layout")).not.toBeInTheDocument();
    expect(screen.queryByText(/probe-thinking-trace/)).not.toBeInTheDocument();
    expect(screen.queryByText("已经结束的子任务")).not.toBeInTheDocument();
    expect(screen.getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByTestId("process-toggle"));
    expect(screen.getByTestId("process-stage")).toHaveTextContent("先核对库存口径");
    expect(screen.queryByText("probe-stock-layout")).not.toBeInTheDocument();
    expect(screen.queryByText(/probe-thinking-trace/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("process-detail-toggle"));
    expect(screen.getByText("probe-stock-layout")).toBeInTheDocument();
    expect(screen.getByText(/probe-thinking-trace/)).toBeInTheDocument();
    expect(screen.getByText("已经结束的子任务")).toBeInTheDocument();
    expect(screen.getByText("看板已经做好")).toBeInTheDocument();
  });

  test("没有工具的普通聊天不套工作过程", () => {
    renderList([
      row("u", "user", "你好"),
      row("a", "assistant", "你好，需要我做什么？", { _clientMessageId: "u" }),
    ]);
    expect(screen.queryByTestId("process-disclosure")).not.toBeInTheDocument();
    expect(screen.getByText("你好，需要我做什么？")).toBeInTheDocument();
    expect(screen.getByTestId("assistant-row")).toBeInTheDocument();
  });

  test("未开启披露的诊断入口仍直接铺开工具", () => {
    render(
      <MessageList messages={settledTurn()} sending={false} cb={{}} onRespondPermission={() => {}} />,
    );
    expect(screen.queryByTestId("process-disclosure")).not.toBeInTheDocument();
    expect(screen.getByText("probe-stock-layout")).toBeInTheDocument();
    expect(screen.getByText("先核对库存口径")).toBeInTheDocument();
  });

  test("执行中展开后，完成时保留展开并放出最终回答", () => {
    const messages = settledTurn().filter((message) => message.id !== "pdf-1");
    const view = renderList(messages, { sending: true });
    expect(screen.getByTestId("turn-activity-footer")).toBeInTheDocument();
    expect(screen.queryByTestId("assistant-row")).not.toBeInTheDocument();
    expect(screen.getByTestId("process-live-summary")).toHaveTextContent("看板已经做好");
    expect(within(screen.getByTestId("process-disclosure")).queryByRole("button", { name: "停止" })).toBeNull();

    fireEvent.click(screen.getByTestId("process-toggle"));
    expect(screen.getByText("先核对库存口径")).toBeInTheDocument();

    view.rerender(
      <MessageList
        processDisclosure
        messages={messages}
        sending={false}
        sessionId="session-a"
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("先核对库存口径")).toBeInTheDocument();
    expect(screen.getByTestId("assistant-row")).toHaveTextContent("看板已经做好");
    expect(screen.queryByTestId("process-live-summary")).not.toBeInTheDocument();
  });

  test("提问、失败、审批和后台子任务不被折进过程", async () => {
    renderList([
      row("u", "user", "继续", { status: "replied" }),
      row("stage", "assistant", "我先查一下", { _clientMessageId: "u" }),
      row("bash", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "hidden-probe-cmd" },
        _completed: true,
        output: "ok",
      }),
      row("err", "tool", "失败命令", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "broken-probe" },
        _completed: true,
        error: true,
        output: "probe-error-detail",
      }),
      row("ask", "permission", "现在发布吗？", {
        _clientMessageId: "u",
        toolName: "AskUserQuestion",
        requestId: "req-ask",
        _resolved: true,
        _behavior: "allow",
        inputJson: { questions: [{ question: "现在发布吗？", options: [{ label: "可以" }] }] },
      }),
      row("approval", "tool", "审批", {
        _clientMessageId: "u",
        toolName: "mcp__openclaude-memory__present_task_approval",
        inputJson: { id: "OCV5-265" },
        _completed: false,
        output: "ok",
      }),
      row("live-child", "agent-group", "后台盘点还在跑", {
        _clientMessageId: "u",
        _background: true,
        _completed: false,
        _delegate: true,
      }),
      row("answer", "assistant", "还差你的确认", { _clientMessageId: "u" }),
    ]);
    expect(screen.getByText("还差你的确认")).toBeInTheDocument();
    expect(screen.getByText("未成功")).toBeInTheDocument();
    expect(screen.getByTestId("permission-card")).toBeInTheDocument();
    const approval = await screen.findByText("任务待你确认");
    expect(approval.closest("[data-testid=process-disclosure]")).toBeNull();
    expect(screen.getByText("后台盘点还在跑")).toBeInTheDocument();
    expect(screen.queryByText("hidden-probe-cmd")).not.toBeInTheDocument();
  });

  test("两轮、分页、刷新和切会话不会串组或带走展开", () => {
    const messages: ChatMessage[] = [
      row("u1", "user", "第一问", { status: "replied" }),
      row("s1", "assistant", "第一轮阶段", { _clientMessageId: "u1", _historyPageKey: "page-a" }),
      row("t1", "tool", "终端", {
        _clientMessageId: "u1",
        _historyPageKey: "page-a",
        toolName: "Bash",
        inputJson: { command: "turn-one-tool" },
        _completed: true,
        output: "1",
      }),
      row("a1", "assistant", "第一轮回答", { _clientMessageId: "u1", _historyPageKey: "page-a" }),
      row("u2", "user", "第二问", { status: "replied" }),
      row("s2", "assistant", "第二轮阶段", { _clientMessageId: "u2", _historyPageKey: "page-b" }),
      row("t2", "tool", "终端", {
        _clientMessageId: "u2",
        _historyPageKey: "page-b",
        toolName: "Bash",
        inputJson: { command: "turn-two-tool" },
        _completed: true,
        output: "2",
      }),
      row("a2", "assistant", "第二轮回答", { _clientMessageId: "u2", _historyPageKey: "page-b" }),
    ];
    const view = renderList(messages);
    const toggles = screen.getAllByTestId("process-toggle");
    expect(toggles).toHaveLength(2);
    expect(screen.getByText("第一轮回答")).toBeInTheDocument();
    expect(screen.getByText("第二轮回答")).toBeInTheDocument();
    expect(screen.queryByText("turn-one-tool")).not.toBeInTheDocument();
    expect(screen.queryByText("turn-two-tool")).not.toBeInTheDocument();

    fireEvent.click(toggles[0]!);
    expect(screen.getByText("第一轮阶段")).toBeInTheDocument();
    expect(screen.queryByText("第二轮阶段")).not.toBeInTheDocument();

    view.rerender(
      <MessageList
        processDisclosure
        messages={messages.map((message) => ({ ...message }))}
        sending={false}
        sessionId="session-a"
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByText("第一轮阶段")).toBeInTheDocument();
    expect(screen.queryByText("第二轮阶段")).not.toBeInTheDocument();

    view.rerender(
      <MessageList
        processDisclosure
        messages={messages}
        sending={false}
        sessionId="session-b"
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.queryByText("第一轮阶段")).not.toBeInTheDocument();
    expect(screen.queryByText("第二轮阶段")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("process-toggle").every((button) => button.getAttribute("aria-expanded") === "false")).toBe(true);
  });

  test("同一轮跨历史页的过程不会并成一组", () => {
    renderList([
      row("u", "user", "翻页", { status: "replied" }),
      row("s", "assistant", "页一阶段", { _clientMessageId: "u", _historyPageKey: "page-1" }),
      row("t", "tool", "终端", {
        _clientMessageId: "u",
        _historyPageKey: "page-1",
        toolName: "Read",
        inputJson: { file_path: "/tmp/page-one.txt" },
        _completed: true,
        output: "a",
      }),
      row("s2", "assistant", "页二阶段", { _clientMessageId: "u", _historyPageKey: "page-2" }),
      row("t2", "tool", "终端", {
        _clientMessageId: "u",
        _historyPageKey: "page-2",
        toolName: "Read",
        inputJson: { file_path: "/tmp/page-two.txt" },
        _completed: true,
        output: "b",
      }),
      row("a", "assistant", "翻页后的回答", { _clientMessageId: "u", _historyPageKey: "page-2" }),
    ]);
    expect(screen.getAllByTestId("process-toggle")).toHaveLength(2);
    fireEvent.click(screen.getAllByTestId("process-toggle")[0]!);
    expect(screen.getByText("页一阶段")).toBeInTheDocument();
    expect(screen.queryByText("页二阶段")).not.toBeInTheDocument();
  });

  test("延迟加载的最终回答留在外面，过程里的延迟行仍会挂上读取入口", async () => {
    const messages: ChatMessage[] = [
      row("u", "user", "看记录", { status: "replied" }),
      row("stage", "assistant", "可见阶段", { _clientMessageId: "u" }),
      row("mid", "assistant", "", {
        _clientMessageId: "u",
        _payloadDeferred: true,
        _turnTapeId: "tape-1",
        _recordOrdinal: 4,
      }),
      row("tool", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "deferred-hidden-tool" },
        _completed: true,
        output: "ok",
      }),
      row("final", "assistant", "", {
        _clientMessageId: "u",
        _payloadDeferred: true,
        _turnTapeId: "tape-1",
        _recordOrdinal: 9,
      }),
    ];
    const view = renderList(messages);
    await waitFor(() => {
      expect(screen.getAllByText(/真实/).length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.queryByText("deferred-hidden-tool")).not.toBeInTheDocument();
    const outside = screen.getAllByText(/真实/).filter((node) => !node.closest("[data-testid=process-disclosure]"));
    expect(outside.length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByTestId("process-toggle"));
    const hydrated = messages.map((message) =>
      message.id === "mid" ? { ...message, _payloadDeferred: undefined, text: "水合后的阶段说明" } : message,
    );
    view.rerender(
      <MessageList
        processDisclosure
        messages={hydrated}
        sending={false}
        sessionId="session-a"
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByText("水合后的阶段说明")).toBeInTheDocument();
    expect(screen.queryByText("deferred-hidden-tool")).not.toBeInTheDocument();
  });

  test("搜索命中折叠阶段时展开并能定位到该段正文", () => {
    renderList(settledTurn(), { find: { onClose: () => {} } });
    expect(screen.queryByText("先核对库存口径")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "在会话中查找" }), { target: { value: "库存口径" } });
    const stage = screen.getByTestId("process-stage");
    expect(stage).toHaveTextContent("先核对库存口径");
    expect(stage).toHaveAttribute("data-find-member", "stage-1");
    expect(screen.queryByText("probe-stock-layout")).not.toBeInTheDocument();
    const current = document.querySelector("[data-find-current]");
    expect(current?.textContent ?? "").toContain("先核对库存口径");
  });
});
