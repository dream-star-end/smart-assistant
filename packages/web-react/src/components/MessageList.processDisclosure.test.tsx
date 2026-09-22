import "@testing-library/jest-dom/vitest";
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ChatMessage } from "../lib/chat/model";
import { operationSummary } from "./chat/ProcessDisclosure";
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
    row("img-1", "tool", "生成图片", {
      _clientMessageId: "u1",
      toolName: "codex:imageGeneration",
      inputJson: { type: "imageGeneration", prompt: "仓库货架" },
      _completed: true,
      output: "ok",
    }),
    row("pdf-1", "tool", "PDF", {
      _clientMessageId: "u1",
      toolName: "Bash",
      inputJson: { command: "oc-pdf paper.qmd -o /home/agent/out/paper.pdf" },
      _completed: true,
      output: "wrote pdf",
    }),
    row("answer-1", "assistant", "看板已经做好", { _clientMessageId: "u1" }),
  ];
}

describe("MessageList Manus 过程披露", () => {
  test("默认只见回答和交付物，两级点击才看见阶段和工具", () => {
    renderList(settledTurn());
    expect(screen.getByText("看板已经做好")).toBeInTheDocument();
    expect(screen.queryByText(/paper\.pdf/)).not.toBeInTheDocument();
    expect(screen.queryByText("生成图片")).not.toBeInTheDocument();
    expect(screen.queryByText("先核对库存口径")).not.toBeInTheDocument();
    expect(screen.queryByText("probe-stock-layout")).not.toBeInTheDocument();
    expect(screen.queryByText(/probe-thinking-trace/)).not.toBeInTheDocument();
    expect(screen.queryByText("已经结束的子任务")).not.toBeInTheDocument();
    expect(screen.getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByTestId("process-toggle"));
    expect(screen.getByTestId("process-stage")).toHaveTextContent("先核对库存口径");
    expect(screen.queryByText("probe-stock-layout")).not.toBeInTheDocument();
    expect(screen.queryByText(/paper\.pdf/)).not.toBeInTheDocument();
    expect(screen.queryByText(/probe-thinking-trace/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("process-detail-toggle"));
    const pdf = screen.getByText(/paper\.pdf/);
    expect(pdf.closest("[data-testid=process-disclosure]")).not.toBeNull();
    expect(screen.getByText("生成图片").closest("[data-testid=process-disclosure]")).not.toBeNull();
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

  test("执行中末条回答全文可见，手动展开在结束后仍保持", () => {
    const base = settledTurn().filter((message) => message.id !== "pdf-1");
    const long = `${"进度明细。".repeat(30)}看板已经做好`;
    const messages = base.map((message) => (message.id === "answer-1" ? { ...message, text: long } : message));
    const view = renderList(messages, { sending: true });
    expect(screen.getByTestId("turn-activity-footer")).toBeInTheDocument();
    expect(within(screen.getByTestId("process-disclosure")).queryByRole("button", { name: "停止" })).toBeNull();
    const answer = screen.getByTestId("assistant-row");
    expect(answer).toHaveTextContent("看板已经做好");
    expect(answer.closest("[data-testid=process-live-summary]")).toBeNull();
    expect(screen.getByTestId("process-live-summary")).toHaveTextContent("先核对库存口径");
    expect(screen.getByTestId("process-live-summary")).not.toHaveTextContent("看板已经做好");

    fireEvent.click(screen.getByTestId("process-toggle"));
    expect(screen.getByText("先核对库存口径")).toBeInTheDocument();

    const grown = messages.map((message) =>
      message.id === "answer-1" ? { ...message, text: `${long}\n尾部仍在增长` } : message,
    );
    view.rerender(
      <MessageList
        processDisclosure
        messages={grown}
        sending
        sessionId="session-a"
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByTestId("assistant-row")).toHaveTextContent("尾部仍在增长");
    expect(screen.getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "true");

    view.rerender(
      <MessageList
        processDisclosure
        messages={grown}
        sending={false}
        sessionId="session-a"
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("先核对库存口径")).toBeInTheDocument();
    expect(screen.getByTestId("assistant-row")).toHaveTextContent("尾部仍在增长");
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

  test("带预览、图片或生成附件的助手留在顶层，普通阶段仍走 Markdown", async () => {
    renderList([
      row("u", "user", "出图", { status: "replied" }),
      row("plain", "assistant", "普通阶段见 [口径说明](https://example.com/stock-note)", { _clientMessageId: "u" }),
      row("bash", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "echo complicated-catalog" },
        _completed: true,
        output: "ok",
      }),
      row("preview", "assistant", "看预览\n```htmlpreview\n<div>PREVIEW_STOCK</div>\n```", { _clientMessageId: "u" }),
      row("shot", "assistant", "配图 ![仓库](/home/agent/.openclaude/generated/warehouse.png)", { _clientMessageId: "u" }),
      row("file", "assistant", "文件在 /home/agent/.openclaude/generated/stock-report.docx", { _clientMessageId: "u" }),
      row("answer", "assistant", "最终总结在这里", { _clientMessageId: "u" }),
    ]);
    expect(screen.getByText("最终总结在这里")).toBeInTheDocument();
    expect(screen.queryByText(/普通阶段见/)).not.toBeInTheDocument();
    expect(screen.queryByText("echo complicated-catalog")).not.toBeInTheDocument();
    const preview = await screen.findByTitle("HTML 沙盒预览");
    expect(preview.closest("[data-testid=process-disclosure]")).toBeNull();
    const image = await screen.findByText("仓库");
    expect(image.closest("[data-testid=process-disclosure]")).toBeNull();
    expect(screen.queryByText(/!\[仓库\]/)).not.toBeInTheDocument();
    const file = await screen.findByText("stock-report.docx");
    expect(file.closest("[data-testid=process-disclosure]")).toBeNull();

    fireEvent.click(screen.getByTestId("process-toggle"));
    const link = await screen.findByRole("link", { name: "口径说明" });
    expect(link).toHaveAttribute("href", "https://example.com/stock-note");
    expect(screen.getByTestId("process-toggle")).toHaveTextContent("命令 1 项");
  });

  test("未发布降级正文放进过程后仍然不可见", () => {
    renderList([
      row("u", "user", "继续", { status: "replied" }),
      row("hidden", "assistant", "不该再出现的降级正文", {
        _clientMessageId: "u",
        _hideUnpublishedFallback: true,
      }),
      row("bash", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "true" },
        _completed: true,
        output: "ok",
      }),
      row("answer", "assistant", "可见的最终回答", { _clientMessageId: "u" }),
    ]);
    fireEvent.click(screen.getByTestId("process-toggle"));
    fireEvent.click(screen.getByTestId("process-detail-toggle"));
    expect(screen.getByText("可见的最终回答")).toBeInTheDocument();
    expect(screen.queryByText("不该再出现的降级正文")).not.toBeInTheDocument();
  });

  test("成功的办公和图像执行记录折进过程，助手没有的生成文件才留在结果层", async () => {
    renderList([
      row("u", "user", "出文件", { status: "replied" }),
      row("stage", "assistant", "先跑命令", { _clientMessageId: "u" }),
      row("img", "tool", "生成图片", {
        _clientMessageId: "u",
        toolName: "codex:imageGeneration",
        inputJson: { type: "imageGeneration", prompt: "货架静物" },
        _completed: true,
        output: "ok",
      }),
      row("pdf", "tool", "PDF", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "oc-pdf paper.qmd -o /home/agent/out/paper.pdf" },
        _completed: true,
        output: "wrote pdf",
      }),
      row("dup", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "cp x /home/agent/.openclaude/generated/shared-board.csv" },
        _completed: true,
        output: "ok",
      }),
      row("answer", "assistant", "总结在这里\n表在 /home/agent/.openclaude/generated/shared-board.csv", {
        _clientMessageId: "u",
      }),
      row("bad", "tool", "失败", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "oc-pdf bad.qmd -o /home/agent/out/broken.pdf" },
        _completed: true,
        error: true,
        output: "fail",
      }),
      row("only", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "cp y /home/agent/.openclaude/generated/only-board.csv" },
        _completed: true,
        output: "ok",
      }),
    ]);
    expect(screen.getByText(/总结在这里/)).toBeInTheDocument();
    const shared = await screen.findAllByText(/shared-board\.csv/);
    expect(shared.some((node) => node.closest("[data-testid=process-disclosure]") == null)).toBe(true);
    expect(shared.every((node) => node.closest("[data-testid=process-disclosure]") == null)).toBe(true);
    // 命令里的生成路径不是交付：only 不得作为顶层文件成品出现。
    expect(screen.queryByText(/only-board\.csv/)).not.toBeInTheDocument();
    expect(document.querySelector("[data-chat-virtual-key=only]")).toBeNull();
    expect(screen.getByText("未成功").closest("[data-testid=process-disclosure]")).toBeNull();
    expect(screen.queryByText(/paper\.pdf/)).not.toBeInTheDocument();
    expect(screen.queryByText("生成图片")).not.toBeInTheDocument();
    expect(screen.queryByText("货架静物")).not.toBeInTheDocument();

    const toggles = screen.getAllByTestId("process-toggle");
    expect(toggles).toHaveLength(2);
    fireEvent.click(toggles[0]!);
    fireEvent.click(screen.getAllByTestId("process-detail-toggle")[0]!);
    const first = screen.getAllByTestId("process-details")[0]!;
    expect(within(first).getByText(/paper\.pdf/).closest("[data-testid=process-details]")).not.toBeNull();
    expect(within(first).getByText("生成图片").closest("[data-testid=process-details]")).not.toBeNull();
    expect(first.textContent ?? "").toMatch(/cp x \/home\/agent\/\.openclaude\/generated\//);
    fireEvent.click(toggles[1]!);
    fireEvent.click(screen.getAllByTestId("process-detail-toggle")[1]!);
    const second = screen.getAllByTestId("process-details")[1]!;
    for (const button of within(second).getAllByRole("button")) {
      if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
    }
    const onlyText = within(second).getByText(/only-board\.csv/);
    expect(onlyText.closest("[data-testid=process-details]")).not.toBeNull();
    expect(onlyText.closest("[title='文件准备中…(容器冷启时稍候)']")).toBeNull();
    expect(document.querySelector("[data-chat-virtual-key=only]")).toBeNull();
  });

  test("请求路径、未完成命令、Read 和办公日志不冒充顶层文件成品", async () => {
    renderList([
      row("u", "user", "打包", { status: "replied" }),
      row("stage", "assistant", "先跑构建", { _clientMessageId: "u" }),
      row("bash", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "python build.py --output /home/agent/.openclaude/generated/not-created.pdf" },
        inputPreview: "python build.py --output /home/agent/.openclaude/generated/not-created.pdf",
        _completed: true,
        output: "ok",
      }),
      row("live", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "python build.py --output /home/agent/.openclaude/generated/still-running.pdf" },
        _completed: false,
        output: "ok",
      }),
      row("read", "tool", "读取", {
        _clientMessageId: "u",
        toolName: "Read",
        inputJson: { file_path: "/home/agent/.openclaude/generated/already-there.docx" },
        _completed: true,
        output: "正文 /home/agent/.openclaude/generated/already-there.docx",
      }),
      row("office", "tool", "PDF", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "oc-pdf paper.qmd -o /home/agent/.openclaude/generated/guess.pdf" },
        _completed: true,
        output: "wrote /home/agent/.openclaude/generated/guess.pdf",
      }),
      row("answer", "assistant", "构建记录在过程里", { _clientMessageId: "u" }),
    ]);
    expect(screen.getByText("构建记录在过程里")).toBeInTheDocument();
    expect(screen.queryByText(/not-created\.pdf/)).not.toBeInTheDocument();
    expect(screen.queryByText(/still-running\.pdf/)).not.toBeInTheDocument();
    expect(screen.queryByText(/already-there\.docx/)).not.toBeInTheDocument();
    expect(screen.queryByText(/guess\.pdf/)).not.toBeInTheDocument();
    expect(screen.queryByTitle("文件准备中…(容器冷启时稍候)")).not.toBeInTheDocument();
    expect(document.querySelector("[data-chat-virtual-key=bash]")).toBeNull();
    expect(document.querySelector("[data-chat-virtual-key=read]")).toBeNull();
    expect(document.querySelector("[data-chat-virtual-key=office]")).toBeNull();

    fireEvent.click(screen.getByTestId("process-toggle"));
    fireEvent.click(screen.getByTestId("process-detail-toggle"));
    const details = screen.getByTestId("process-details");
    for (const button of within(details).getAllByRole("button")) {
      if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
    }
    expect(details.textContent ?? "").toMatch(/not-created\.pdf/);
    expect(details.textContent ?? "").toMatch(/still-running\.pdf/);
    expect(details.textContent ?? "").toMatch(/already-there\.docx/);
    const guesses = screen.getAllByText(/guess\.pdf/);
    expect(guesses.length).toBeGreaterThan(0);
    expect(guesses.every((node) => node.closest("[data-testid=process-details]") != null)).toBe(true);
    expect(screen.getByText("构建记录在过程里").closest("[data-testid=process-disclosure]")).toBeNull();
  });

  test("助手的不同 HTML 预览留在顶层，Bash 里的 htmlpreview 只是终端日志", async () => {
    const alpha = "```htmlpreview\n<div>PREVIEW_ALPHA</div>\n```";
    const beta = "```htmlpreview\n<div>PREVIEW_BETA</div>\n```";
    const sameId = "```htmlpreview id=board-a\n<div>PREVIEW_OTHER</div>\n```";
    const otherId = "```htmlpreview id=board-b\n<div>PREVIEW_OTHER</div>\n```";
    renderList([
      row("u", "user", "出预览", { status: "replied" }),
      row("plain", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "true" },
        _completed: true,
        output: "ok",
      }),
      row("preview", "assistant", `看两份\n${alpha}\n${sameId}`, { _clientMessageId: "u" }),
      row("same-body", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "cat alpha.html" },
        _completed: true,
        output: alpha,
      }),
      row("same-id", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "cat board.html" },
        _completed: true,
        output: sameId,
      }),
      row("html-beta", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "cat beta.html" },
        _completed: true,
        output: beta,
      }),
      row("html-b", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "cat b.html" },
        _completed: true,
        output: otherId,
      }),
      row("answer", "assistant", "预览在上面", { _clientMessageId: "u" }),
    ]);
    expect(document.querySelector("[data-chat-virtual-key=html-beta]")).toBeNull();
    expect(document.querySelector("[data-chat-virtual-key=html-b]")).toBeNull();
    expect(document.querySelector("[data-chat-virtual-key=same-body]")).toBeNull();
    expect(document.querySelector("[data-chat-virtual-key=same-id]")).toBeNull();
    expect(screen.queryByText(/PREVIEW_BETA/)).not.toBeInTheDocument();

    const previews = await screen.findAllByTitle("HTML 沙盒预览");
    expect(previews).toHaveLength(2);
    expect(previews.every((node) => node.tagName === "IFRAME")).toBe(true);
    expect(previews.every((node) => node.closest("[data-testid=process-disclosure]") == null)).toBe(true);
    const docs = previews.map((node) => node.getAttribute("srcdoc") ?? "");
    expect(docs.some((doc) => doc.includes("PREVIEW_ALPHA"))).toBe(true);
    expect(docs.some((doc) => doc.includes("PREVIEW_OTHER"))).toBe(true);
    expect(docs.some((doc) => doc.includes("PREVIEW_BETA"))).toBe(false);
    expect(new Set(docs).size).toBe(2);

    for (const toggle of screen.getAllByTestId("process-toggle")) fireEvent.click(toggle);
    for (const toggle of screen.getAllByTestId("process-detail-toggle")) fireEvent.click(toggle);
    for (const details of screen.getAllByTestId("process-details")) {
      for (const button of within(details).getAllByRole("button")) {
        if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
      }
    }
    const betaSource = screen.getByText(/PREVIEW_BETA/);
    const betaPre = betaSource.closest("pre");
    expect(betaPre?.closest("[data-testid=process-details]")).not.toBeNull();
    expect(betaPre?.closest("[data-chat-virtual-key=html-beta]")).toBeNull();
    expect(betaPre?.textContent ?? "").toMatch(/\$ cat beta\.html/);
    expect(betaPre?.textContent ?? "").toMatch(/```htmlpreview/);
    expect(betaPre?.textContent ?? "").toMatch(/PREVIEW_BETA/);
    const folded = screen.getAllByTestId("process-details").map((node) => node.textContent ?? "").join("\n");
    expect(folded).toMatch(/\$ cat alpha\.html/);
    expect(folded).toMatch(/PREVIEW_ALPHA/);
    expect(folded).toMatch(/id=board-b/);
  });

  test("查询和句末标点归一后同一生成文件才去重，真实文件名保留", async () => {
    renderList([
      row("u", "user", "对一下文件", { status: "replied" }),
      row("noise", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "true" },
        _completed: true,
        output: "ok",
      }),
      row(
        "shot",
        "assistant",
        "图 ![图](/home/agent/.openclaude/generated/my.report.v2.png?x=1)\n表 /home/agent/.openclaude/generated/notes.v2.pdf。",
        { _clientMessageId: "u" },
      ),
      row("dup-image", "tool", "生成图片", {
        _clientMessageId: "u",
        toolName: "codex:imageGeneration",
        inputJson: { type: "imageGeneration", prompt: "同一张" },
        _completed: true,
        output: "imageGeneration → /home/agent/.openclaude/generated/my.report.v2.png",
      }),
      row("other-image", "tool", "生成图片", {
        _clientMessageId: "u",
        toolName: "codex:imageGeneration",
        inputJson: { type: "imageGeneration", prompt: "另一张" },
        _completed: true,
        output: "imageGeneration → /home/agent/.openclaude/generated/other.v2.png",
      }),
      row("dup-report", "tool", "报告", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "oc-report --schema s" },
        _completed: true,
        output: JSON.stringify({ output: "/home/agent/.openclaude/generated/notes.v2.pdf" }),
      }),
      row("other-report", "tool", "报告", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "oc-report --schema s" },
        _completed: true,
        output: JSON.stringify({ output: "/home/agent/.openclaude/generated/notes.v2.final.pdf" }),
      }),
      row("answer", "assistant", "对过了", { _clientMessageId: "u" }),
    ]);
    const picture = await screen.findByText("图");
    expect(picture.closest("[data-testid=process-disclosure]")).toBeNull();
    const note = await screen.findByText("notes.v2.pdf");
    expect(note.closest("[data-testid=process-disclosure]")).toBeNull();
    expect(note.textContent).toBe("notes.v2.pdf");
    // 带查询的 my.report.v2.png 与工具返回的同一文件名折成一件；裁短文件名则对不上，卡会留在顶层。
    expect(document.querySelector("[data-chat-virtual-key=dup-image]")).toBeNull();
    expect(document.querySelector("[data-chat-virtual-key=dup-report]")).toBeNull();
    const otherImage = document.querySelector("[data-chat-virtual-key=other-image]");
    const otherReport = document.querySelector("[data-chat-virtual-key=other-report]");
    expect(otherImage?.closest("[data-testid=process-disclosure]")).toBeNull();
    expect(otherReport?.closest("[data-testid=process-disclosure]")).toBeNull();
    fireEvent.click(within(otherImage as HTMLElement).getByRole("button"));
    expect(within(otherImage as HTMLElement).getByText("图片已生成")).toBeInTheDocument();
    expect(within(otherImage as HTMLElement).getByText(/other\.v2\.png/)).toBeInTheDocument();
  });

  test("只有输出里的真实图像留在结果层，命令里的截图路径不算", async () => {
    renderList([
      row("u", "user", "出图", { status: "replied" }),
      row("noise", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "true" },
        _completed: true,
        output: "ok",
      }),
      row("named", "tool", "截图", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "oc-browser screenshot --filename=/home/agent/.openclaude/generated/requested-only.png" },
        _completed: true,
        output: "Saved screenshot",
      }),
      row("shot", "tool", "截图", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "oc-browser screenshot" },
        _completed: true,
        output: "saved /home/agent/.openclaude/generated/from-output.png",
      }),
      row("mmx", "tool", "媒体", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "mmx image generate \"货架\"" },
        _completed: true,
        output: "/home/agent/.openclaude/generated/shelf-unique.png\nbilling: 12 credits-cents",
      }),
      row("empty-image", "tool", "生成图片", {
        _clientMessageId: "u",
        toolName: "codex:imageGeneration",
        inputJson: { type: "imageGeneration", savedPath: "/home/agent/.openclaude/generated/input-only.png", prompt: "不要凭输入路径" },
        _completed: true,
        output: "ok",
      }),
      row("answer", "assistant", "图在结果里", { _clientMessageId: "u" }),
    ]);
    expect(screen.getByText("图在结果里")).toBeInTheDocument();
    expect(screen.queryByText(/requested-only\.png/)).not.toBeInTheDocument();
    expect(screen.queryByText(/input-only\.png/)).not.toBeInTheDocument();
    expect(document.querySelector("[data-chat-virtual-key=named]")).toBeNull();
    expect(document.querySelector("[data-chat-virtual-key=empty-image]")).toBeNull();
    const shot = document.querySelector("[data-chat-virtual-key=shot]");
    const media = document.querySelector("[data-chat-virtual-key=mmx]");
    expect(shot?.closest("[data-testid=process-disclosure]")).toBeNull();
    expect(media?.closest("[data-testid=process-disclosure]")).toBeNull();
    fireEvent.click(within(shot as HTMLElement).getByRole("button"));
    fireEvent.click(within(media as HTMLElement).getByRole("button"));
    const shotImage = within(shot as HTMLElement).queryByText("页面截图")
      ?? within(shot as HTMLElement).queryByAltText("页面截图");
    expect(shotImage).not.toBeNull();
    expect(shotImage?.closest("[data-testid=process-disclosure]")).toBeNull();
    expect(within(media as HTMLElement).getByText("shelf-unique.png")).toBeInTheDocument();
    expect(screen.getByText("shelf-unique.png").closest("[data-testid=process-disclosure]")).toBeNull();
  });

  test("回答元信息用 caption，旧日期和近时都在，积分与 token 仍在", () => {
    const oldTs = 1_700_000_000_000;
    const recentTs = Date.now() - 2_000;
    renderList([
      row("u", "user", "看时间", { status: "replied", ts: oldTs }),
      row("a", "assistant", "旧日期回答", {
        _clientMessageId: "u",
        ts: oldTs,
        usage: {
          costCredits: "12",
          totalTokens: 1840,
          inputTokens: 1200,
          outputTokens: 640,
          traceId: "abc12345xyz",
        },
      }),
      row("u2", "user", "现在呢", { status: "replied", ts: recentTs }),
      row("a2", "assistant", "近时回答", {
        _clientMessageId: "u2",
        ts: recentTs,
        usage: { costCredits: "3", totalTokens: 420, inputTokens: 300, outputTokens: 120 },
      }),
    ]);
    const metas = screen.getAllByTestId("assistant-meta");
    expect(metas).toHaveLength(2);
    expect(metas[0]).toHaveClass("text-caption");
    expect(metas[0]).toHaveTextContent("2023-11-15");
    expect(metas[0]).toHaveTextContent("12 积分");
    expect(metas[0]).toHaveTextContent("token");
    expect(metas[0].querySelector("time.tabular-nums")?.className ?? "").toContain("text-caption");
    expect(metas[1]).toHaveTextContent("刚刚");
    expect(metas[1]).toHaveTextContent("3 积分");
    expect(metas[1]).toHaveTextContent("token");
    expect(screen.queryByTestId("process-disclosure")).not.toBeInTheDocument();
  });

  test("命令计数看工具名或命令首词，不扫参数里的子串", () => {
    expect(operationSummary([
      row("t", "tool", "终端", { toolName: "Bash", inputJson: { command: "echo complicated-catalog" } }),
    ])).toBe("命令 1 项");
    expect(operationSummary([
      row("t", "tool", "终端", { toolName: "Bash", inputJson: { command: "cat /tmp/a" } }),
    ])).toBe("读取 1 项");
    expect(operationSummary([
      row("t", "tool", "读取", { toolName: "Read", inputJson: { file_path: "/tmp/a" } }),
    ])).toBe("读取 1 项");
  });
});
