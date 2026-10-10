import "@testing-library/jest-dom/vitest";
import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../lib/chat/model";
import { MessageListSkeleton, PartialHistorySkeleton } from "./chat/HistorySkeleton";
import { operationSummary } from "./chat/ProcessDisclosure";
import { MessageList } from "./MessageRenderer";
import { ArtifactInspectContext } from "./tool/context";

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

  test("执行中长正文留在同一个过程里，手动展开跨 token 和结束后保持", () => {
    const base = settledTurn().filter((message) => message.id !== "pdf-1");
    const long = `${"进度明细。".repeat(30)}看板已经做好`;
    const messages = base.map((message) => (message.id === "answer-1" ? { ...message, text: long } : message));
    const view = renderList(messages, { sending: true });
    expect(screen.getAllByTestId("process-disclosure")).toHaveLength(1);
    expect(screen.getByTestId("turn-activity-footer")).toBeInTheDocument();
    expect(within(screen.getByTestId("process-disclosure")).queryByRole("button", { name: "停止" })).toBeNull();
    expect(screen.getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "true");
    const stage = screen.getAllByTestId("process-stage").find((node) => (node.textContent ?? "").includes("看板已经做好"));
    if (!stage) throw new Error("missing live stage");
    expect(stage).toHaveTextContent("看板已经做好");
    expect(stage.closest("[data-testid=assistant-row]")).toBeNull();
    expect(stage.className).not.toMatch(/line-clamp/);
    expect(screen.queryByTestId("assistant-row")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("process-disclosure")).queryByTestId("assistant-meta")).toBeNull();
    const openStages = screen.getAllByTestId("process-stage");
    expect(openStages.some((node) => (node.textContent ?? "").includes("先核对库存口径"))).toBe(true);
    expect(openStages.some((node) => (node.textContent ?? "").includes("看板已经做好"))).toBe(true);

    fireEvent.click(screen.getByTestId("process-toggle"));
    expect(screen.getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "false");
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
    expect(screen.getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("尾部仍在增长")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("process-toggle"));
    expect(screen.getAllByTestId("process-stage").some((node) => (node.textContent ?? "").includes("尾部仍在增长"))).toBe(true);
    const grownAgain = grown.map((message) =>
      message.id === "answer-1" ? { ...message, text: `${long}\n尾部仍在增长\n又一段` } : message,
    );
    view.rerender(
      <MessageList
        processDisclosure
        messages={grownAgain}
        sending
        sessionId="session-a"
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByTestId("process-stage").some((node) => (node.textContent ?? "").includes("又一段"))).toBe(true);
    expect(screen.getAllByTestId("process-stage").some((node) => (node.textContent ?? "").includes("先核对库存口径"))).toBe(true);
    expect(screen.getAllByTestId("process-disclosure")).toHaveLength(1);

    view.rerender(
      <MessageList
        processDisclosure
        messages={grownAgain}
        sending={false}
        sessionId="session-a"
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("先核对库存口径")).toBeInTheDocument();
    const answer = screen.getByTestId("assistant-row");
    expect(answer).toHaveTextContent("又一段");
    expect(answer.closest("[data-testid=process-disclosure]")).toBeNull();
  });

  // OCV5-307 回归:OCV5-308 实况 —— 中途一次 model_not_available(detail=error_during_execution JSON)
  // 之后本轮继续跑工具并给出回答,这张错误卡曾单独挂在收起的「工作过程」下面。
  const midTurnError = (code = "model_not_available") =>
    row("err-mid", "assistant", "通用代码已生成商业版候选并推送", {
      _clientMessageId: "u",
      _errorCode: code,
      _errorDetail: '{"subtype":"error_during_execution","result":"Selected model is at capacity."}',
      usage: { traceId: "trace-mid-err" },
    });

  test("OCV5-307: 本轮越过的中途错误卡收进过程，作为常显卡片步骤", () => {
    renderList([
      row("u", "user", "继续合并", { status: "replied" }),
      row("t1", "tool", "终端", { _clientMessageId: "u", toolName: "Bash", inputJson: { command: "git fetch" }, _completed: true, output: "ok" }),
      midTurnError(),
      row("t2", "tool", "终端", { _clientMessageId: "u", toolName: "Bash", inputJson: { command: "git merge" }, _completed: true, output: "ok" }),
      row("answer", "assistant", "已合并并推送", { _clientMessageId: "u" }),
    ]);
    // 收起态:只有一个过程壳,错误卡不在顶层
    expect(screen.getAllByTestId("process-disclosure")).toHaveLength(1);
    expect(screen.queryByText("模型暂不可用")).not.toBeInTheDocument();
    expect(screen.getByText("已合并并推送").closest("[data-testid=process-disclosure]")).toBeNull();
    fireEvent.click(screen.getByTestId("process-toggle"));
    const card = screen.getByTestId("process-card");
    expect(within(card).getByText("模型暂不可用")).toBeInTheDocument();
    expect(card.closest("[data-testid=process-disclosure]")).not.toBeNull();
    // OCV5-307:已越过的错误只留一行说明,不再是叫用户「切换模型后重发」的整张警示卡。
    const note = within(card).getByTestId("recovered-error-note");
    expect(note).toHaveTextContent("本轮已继续");
    expect(within(card).queryByRole("alert")).toBeNull();
    expect(card.textContent ?? "").not.toMatch(/切换一个模型|后重发/);
  });

  test("OCV5-307: 以 model_not_available 收尾的轮次，错误卡仍在顶层", () => {
    renderList([
      row("u", "user", "继续合并", { status: "replied" }),
      row("t1", "tool", "终端", { _clientMessageId: "u", toolName: "Bash", inputJson: { command: "git fetch" }, _completed: true, output: "ok" }),
      midTurnError(),
    ]);
    expect(screen.getByText("模型暂不可用").closest("[data-testid=process-disclosure]")).toBeNull();
  });

  test("OCV5-307: 以错误收尾的轮次，错误卡仍是顶层结果且保留重试出口", () => {
    renderList(
      [
        row("u", "user", "继续合并", { status: "replied" }),
        row("t1", "tool", "终端", { _clientMessageId: "u", toolName: "Bash", inputJson: { command: "git fetch" }, _completed: true, output: "ok" }),
        midTurnError("engine_error"),
      ],
      { cb: { onRegenerate: () => {} } },
    );
    const retry = screen.getByRole("button", { name: /重新尝试|重试/ });
    // 以错误收尾 = 本轮结局:仍是完整错误卡,不是「已继续」说明。
    expect(screen.queryByTestId("recovered-error-note")).toBeNull();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    // 对照组:可重试码在顶层(本轮结局)有重试出口,下面「过程里不给」的断言才有意义。
    expect(retry.closest("[data-testid=process-disclosure]")).toBeNull();
  });

  test("OCV5-307: 过程里的已越过错误卡不再给重试/切换模型(防重复开工)", () => {
    renderList(
      [
        row("u", "user", "继续合并", { status: "replied", _clientMessageId: "u" }),
        row("t1", "tool", "终端", { _clientMessageId: "u", toolName: "Bash", inputJson: { command: "git fetch" }, _completed: true, output: "ok" }),
        midTurnError("engine_error"),
        row("t2", "tool", "终端", { _clientMessageId: "u", toolName: "Bash", inputJson: { command: "git merge" }, _completed: true, output: "ok" }),
        row("answer", "assistant", "已合并并推送", { _clientMessageId: "u" }),
      ],
      { cb: { onRegenerate: () => {}, onOpenModelPicker: () => {} } },
    );
    fireEvent.click(screen.getByTestId("process-toggle"));
    const card = screen.getByTestId("process-card");
    expect(within(card).getByTestId("recovered-error-note")).toBeInTheDocument();
    for (const name of [/重试/, /重新尝试/, /切换模型/, /从断点继续/]) {
      expect(within(card).queryByRole("button", { name })).toBeNull();
    }
  });

  test("OCV5-307: 终态错误后只有延迟定位行/状态行时不算继续，错误仍在顶层", () => {
    renderList([
      row("u", "user", "继续合并", { status: "replied" }),
      row("t1", "tool", "终端", { _clientMessageId: "u", toolName: "Bash", inputJson: { command: "git fetch" }, _completed: true, output: "ok" }),
      midTurnError(),
      row("locator", "assistant", "", { _clientMessageId: "u", _payloadDeferred: true }),
      row("status", "assistant", "本轮结束", { _clientMessageId: "u", _turnStatusRecord: true }),
    ]);
    expect(screen.getByText("模型暂不可用").closest("[data-testid=process-disclosure]")).toBeNull();
  });

  test("OCV5-307: 已失败的子任务是过程步骤，不在收起的过程外单独成卡", () => {
    renderList([
      row("u", "user", "分派 T2", { status: "replied" }),
      row("t1", "tool", "终端", { _clientMessageId: "u", toolName: "Bash", inputJson: { command: "git status" }, _completed: true, output: "ok" }),
      row("child", "agent-group", "T2 校验迁移", {
        _clientMessageId: "u",
        _delegate: true,
        _completed: true,
        _isError: true,
        _delegateStatus: "failed",
      }),
      row("answer", "assistant", "T2 失败，已改走 T3", { _clientMessageId: "u" }),
    ]);
    expect(screen.getAllByTestId("process-disclosure")).toHaveLength(1);
    expect(screen.queryByText("T2 校验迁移")).not.toBeInTheDocument();
    expect(screen.getByTestId("process-toggle")).toHaveTextContent("子任务 1 项");
  });

  test("OCV5-307: 未回答的提问留在过程外，同一轮已回答的提问在过程轨线上", () => {
    renderList([
      row("u", "user", "继续", { status: "replied" }),
      row("bash", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "git status" },
        _completed: true,
        output: "ok",
      }),
      row("ask-done", "permission", "按哪个方向同步？", {
        _clientMessageId: "u",
        toolName: "AskUserQuestion",
        requestId: "req-done",
        _resolved: true,
        _behavior: "allow",
        inputJson: { questions: [{ question: "按哪个方向同步？", options: [{ label: "双向同步" }] }] },
      }),
      row("bash2", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "git merge" },
        _completed: true,
        output: "ok",
      }),
      row("ask-open", "permission", "现在推送吗？", {
        _clientMessageId: "u",
        toolName: "AskUserQuestion",
        requestId: "req-open",
        inputJson: { questions: [{ question: "现在推送吗？", options: [{ label: "推送" }] }] },
      }),
    ]);
    const cards = () => screen.getAllByTestId("permission-card");
    const open = cards().find((card) => card.getAttribute("data-permission-request") === "req-open");
    expect(open?.closest("[data-testid=process-disclosure]")).toBeNull();
    expect(screen.getAllByTestId("process-disclosure")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("process-toggle"));
    const done = cards().find((card) => card.getAttribute("data-permission-request") === "req-done");
    expect(done?.closest("[data-testid=process-card]")).not.toBeNull();
    expect(done?.className).toContain("border-border/80");
    expect(open?.className).toContain("border-accent/40");
  });

  test("已回答的问答卡和它同一次调用的 AskUserQuestion 工具行：工具行不再漏在过程外", () => {
    renderList([
      row("u", "user", "上线吧", { status: "replied" }),
      row("bash", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "git status" },
        _completed: true,
        output: "ok",
      }),
      row("ask-card", "permission", "怎么处理？", {
        _clientMessageId: "u",
        toolName: "AskUserQuestion",
        requestId: "req-ship",
        toolUseId: "toolu_ship",
        _resolved: true,
        _behavior: "allow",
        inputJson: { questions: [{ question: "怎么处理？", options: [{ label: "现在合并并部署" }] }] },
      }),
      row("ask-tool", "tool", "", {
        _clientMessageId: "u",
        toolName: "AskUserQuestion",
        blockId: "toolu_ship",
        _completed: true,
        inputJson: { questions: [{ question: "怎么处理？", options: [{ label: "现在合并并部署" }] }] },
        output: 'User has answered your questions: "怎么处理？"="现在合并并部署".',
      }),
      row("final", "assistant", "已合并", { _clientMessageId: "u" }),
    ]);
    expect(screen.queryByText("向用户提问")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("process-disclosure")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("process-toggle"));
    const card = screen.getAllByTestId("permission-card").find((el) => el.getAttribute("data-permission-request") === "req-ship");
    expect(card?.closest("[data-testid=process-card]")).not.toBeNull();
    expect(screen.queryByText("向用户提问")).not.toBeInTheDocument();
    expect(screen.queryByText(/User has answered your questions/)).not.toBeInTheDocument();
  });

  test("已确认的计划卡和它同一次调用的 ExitPlanMode 工具行：工具行不再漏在过程外，计划书仍在卡里", () => {
    renderList([
      row("u", "user", "先出个方案", { status: "replied" }),
      row("read", "tool", "读取", {
        _clientMessageId: "u",
        toolName: "Read",
        inputJson: { file_path: "/tmp/a.ts" },
        _completed: true,
        output: "ok",
      }),
      row("plan-card", "permission", "退出计划模式", {
        _clientMessageId: "u",
        toolName: "ExitPlanMode",
        requestId: "req-plan",
        toolUseId: "toolu_plan",
        _resolved: true,
        _behavior: "allow",
        inputJson: { plan: "# PLAN_BODY 改前端分组规则" },
      }),
      row("plan-tool", "tool", "", {
        _clientMessageId: "u",
        toolName: "ExitPlanMode",
        toolUseId: "toolu_plan",
        _completed: true,
        inputJson: { plan: "# PLAN_BODY 改前端分组规则" },
        output: "User has approved your plan. You can now start coding.",
      }),
      row("final", "assistant", "按计划改完了", { _clientMessageId: "u" }),
    ]);
    expect(screen.getAllByTestId("process-disclosure")).toHaveLength(1);
    // 过程收起时,外面不应再挂一张「退出计划模式」工具卡。
    expect(screen.queryByText("退出计划模式")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("process-toggle"));
    expect(screen.getAllByText("退出计划模式")).toHaveLength(1);
    const cards = screen.getAllByTestId("permission-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.closest("[data-testid=process-card]")).not.toBeNull();
    expect(cards[0]?.textContent ?? "").toContain("PLAN_BODY");
    expect(screen.queryByText(/User has approved your plan/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/PLAN_BODY/)).toHaveLength(1);
  });

  test("问答卡不吞同编号的其他工具行：配对必须工具名也一致", () => {
    renderList([
      row("u", "user", "继续", { status: "replied" }),
      row("ask-card", "permission", "问题？", {
        _clientMessageId: "u",
        toolName: "AskUserQuestion",
        requestId: "req-x",
        toolUseId: "toolu_same",
        _resolved: true,
        _behavior: "allow",
        inputJson: { questions: [{ question: "问题？", options: [{ label: "好" }] }] },
      }),
      row("plan-tool", "tool", "", {
        _clientMessageId: "u",
        toolName: "ExitPlanMode",
        toolUseId: "toolu_same",
        _completed: true,
        inputJson: { plan: "# LONE_PLAN" },
        output: "User has approved your plan.",
      }),
    ]);
    expect(screen.getAllByText("退出计划模式").length).toBeGreaterThan(0);
  });

  test("没有配对问答卡的 AskUserQuestion 工具行照常显示（不同 tool_use id 不算配对）", () => {
    renderList([
      row("u", "user", "继续", { status: "replied" }),
      row("ask-card", "permission", "另一个问题？", {
        _clientMessageId: "u",
        toolName: "AskUserQuestion",
        requestId: "req-other",
        toolUseId: "toolu_other",
        _resolved: true,
        _behavior: "allow",
        inputJson: { questions: [{ question: "另一个问题？", options: [{ label: "好" }] }] },
      }),
      row("ask-tool", "tool", "", {
        _clientMessageId: "u",
        toolName: "AskUserQuestion",
        blockId: "toolu_lonely",
        _completed: true,
        inputJson: { questions: [{ question: "孤立的问题？", options: [{ label: "好" }] }] },
        output: "User has answered your questions.",
      }),
    ]);
    expect(screen.getAllByText("向用户提问").length).toBeGreaterThan(0);
  });

  // OCV5-307:已回答的提问是这一轮的一个步骤,收进过程作为常显步骤;待审批 / 后台子任务仍在顶层。
  test("已回答的提问进过程，待审批和后台子任务不被折进过程，普通工具失败收在过程里", async () => {
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
    expect(screen.queryByText("未成功")).not.toBeInTheDocument();
    expect(screen.queryByText("probe-error-detail")).not.toBeInTheDocument();
    // 已结束的轮次过程默认收起:已回答的提问跟着收在里面,不再单独一张卡挂在过程外。
    expect(screen.queryByTestId("permission-card")).not.toBeInTheDocument();
    expect(screen.getByTestId("process-toggle")).toHaveTextContent("问答 1 项");
    const approval = await screen.findByText("任务待你确认");
    expect(approval.closest("[data-testid=process-disclosure]")).toBeNull();
    expect(screen.getByText("后台盘点还在跑")).toBeInTheDocument();
    expect(screen.queryByText("hidden-probe-cmd")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("process-toggle"));
    // 展开过程即可看到问答结果,不用再点开「N 项」细节。
    const prompt = screen.getByTestId("process-card");
    expect(within(prompt).getByTestId("permission-card")).toHaveTextContent("已提交");
    fireEvent.click(screen.getAllByTestId("process-detail-toggle")[0]!);
    const details = screen.getByTestId("process-details");
    expect(within(details).getAllByText("未成功").length).toBeGreaterThan(0);
    expect(within(details).getAllByText("probe-error-detail").length).toBeGreaterThan(0);
    expect(details.closest("[data-testid=process-disclosure]")).not.toBeNull();
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

  test("同一轮跨历史页仍是一组处理过程", () => {
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
    expect(screen.getAllByTestId("process-toggle")).toHaveLength(1);
    expect(screen.getByText("翻页后的回答").closest("[data-testid=process-disclosure]")).toBeNull();
    fireEvent.click(screen.getByTestId("process-toggle"));
    const disclosure = screen.getByTestId("process-disclosure");
    expect(within(disclosure).getByText("页一阶段")).toBeInTheDocument();
    expect(within(disclosure).getByText("页二阶段")).toBeInTheDocument();
  });

  test("同一轮里步骤编号不一致仍是一张处理过程", () => {
    renderList([
      row("u", "user", "统一替换下", { status: "replied" }),
      row("early", "tool", "终端", {
        _clientMessageId: "live-pack",
        toolName: "Grep",
        inputJson: { pattern: "early-step" },
        _completed: true,
        output: "a",
      }),
      row("later", "tool", "终端", {
        _clientMessageId: "tape-row",
        toolName: "Edit",
        inputJson: { file_path: "later-step.ts" },
        _completed: true,
        output: "b",
      }),
      row("note", "assistant", "运行时选型已经改到 4.7", { _clientMessageId: "tape-row" }),
      row("answer", "assistant", "最终回答在外面", { _clientMessageId: "u" }),
    ]);
    expect(screen.getAllByTestId("process-toggle")).toHaveLength(1);
    expect(screen.getByTestId("process-toggle")).toHaveTextContent("搜索 1 项");
    expect(screen.getByTestId("process-toggle")).toHaveTextContent("编辑 1 项");
    expect(screen.getByText("最终回答在外面").closest("[data-testid=process-disclosure]")).toBeNull();
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
    const preview = await screen.findByTitle("交互内容");
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
    expect(screen.queryByText("未成功")).not.toBeInTheDocument();
    expect(screen.queryByText(/paper\.pdf/)).not.toBeInTheDocument();
    expect(screen.queryByText("生成图片")).not.toBeInTheDocument();
    expect(screen.queryByText("货架静物")).not.toBeInTheDocument();

    // OCV5-307:回答之后的 bad/only 不再在回答下面另开一节,回到回答上方唯一的工作过程。
    const toggles = screen.getAllByTestId("process-toggle");
    expect(toggles).toHaveLength(1);
    const answerRow = screen.getByText(/总结在这里/).closest("[data-testid=assistant-row]");
    expect(screen.getByTestId("process-disclosure").compareDocumentPosition(answerRow!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(toggles[0]!);
    fireEvent.click(screen.getAllByTestId("process-detail-toggle")[0]!);
    const first = screen.getAllByTestId("process-details")[0]!;
    expect(within(first).getByText(/paper\.pdf/).closest("[data-testid=process-details]")).not.toBeNull();
    expect(within(first).getByText("生成图片").closest("[data-testid=process-details]")).not.toBeNull();
    expect(first.textContent ?? "").toMatch(/cp x \/home\/agent\/\.openclaude\/generated\//);
    const second = first;
    for (const button of within(second).getAllByRole("button")) {
      if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
    }
    const onlyText = within(second).getByText(/only-board\.csv/);
    expect(onlyText.closest("[data-testid=process-details]")).not.toBeNull();
    expect(within(second).getAllByText("未成功").length).toBeGreaterThan(0);
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

    const previews = await screen.findAllByTitle("交互内容");
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

  test("回答元信息用 caption 和本地日期，积分仍在，token 不打印", () => {
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
    const date = new Date(oldTs);
    const localDate = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
    expect(metas[0]).toHaveTextContent(localDate);
    expect(metas[0].querySelector("time")).toHaveAttribute("datetime", date.toISOString());
    expect(metas[0]).toHaveTextContent("#abc12345");
    expect(metas[0]).toHaveTextContent("12 积分");
    expect(metas[0]).not.toHaveTextContent(/token/i);
    expect(metas[0].querySelector("time.tabular-nums")?.className ?? "").toContain("text-caption");
    expect(metas[1]).toHaveTextContent("刚刚");
    expect(metas[1]).toHaveTextContent("3 积分");
    expect(metas[1]).not.toHaveTextContent(/token/i);
    expect(screen.queryByTestId("process-disclosure")).not.toBeInTheDocument();
  });

  test("同一轮分段过程始终一个壳，已清除目标不另起顶层卡", async () => {
    const user = row("u", "user", "这班发布", { status: "sent" });
    const thinking = row("th", "thinking", `THINK_HEAD ${"痕迹".repeat(80)} THINK_HIDDEN_TAIL`, { _clientMessageId: "u" });
    const stage = row("st", "assistant", "我先对一下这班发布落在哪", { _clientMessageId: "u" });
    const cleared = row("g", "goal", "", {
      _clientMessageId: "u",
      cleared: true,
      goalStatus: "cleared",
      _turnTapeId: "tape-goal",
    });
    const running = row("cmd", "tool", "终端", {
      _clientMessageId: "u",
      toolName: "Bash",
      inputJson: { command: "LIVE_CMD_MARKER", payload: { raw: true, noise: "RAW_JSON_SECRET" } },
      _completed: false,
    });
    const done = { ...running, _completed: true, output: "CMD_DONE_SECRET" };
    const stageTwo = row("st2", "assistant", "STAGE_TWO 继续核对切流", { _clientMessageId: "u" });
    const read = row("rd", "tool", "读取", {
      _clientMessageId: "u",
      toolName: "Read",
      inputJson: { file_path: "VERSION" },
      _completed: true,
      output: "READ_SECRET",
    });
    const long = `FINAL_LONG ${"段落。".repeat(40)}`;
    const answer = row("ans", "assistant", long, { _clientMessageId: "u" });
    const phases = [
      [thinking],
      [thinking, stage],
      [thinking, stage, cleared],
      [thinking, stage, cleared, running],
      [thinking, stage, cleared, done],
      [thinking, stage, cleared, done, stageTwo],
      [thinking, stage, cleared, done, stageTwo, read],
      [thinking, stage, cleared, done, stageTwo, read, answer],
    ];
    const view = renderList([user, ...phases[0]!], { sending: true });
    const expectOne = () => {
      expect(screen.getAllByTestId("process-disclosure")).toHaveLength(1);
      expect(screen.getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "true");
    };
    expectOne();
    expect(screen.getByTestId("process-step-live")).toHaveTextContent("正在思考");
    expect(screen.getByTestId("process-step-live")).toHaveAttribute("data-live-pending", "true");
    // OCV5-312: 展开时流光在「正在干活」的摘要行上,外壳标题不扫。
    expect(screen.getByTestId("process-step-live").className).not.toContain("oc-live-status-shine");
    expect(screen.getAllByTestId("process-group-summary").filter((node) => node.getAttribute("data-live-working") === "true")).toHaveLength(1);
    expect(screen.getAllByTestId("process-group-summary").find((node) => node.getAttribute("data-live-working") === "true")!.className).toContain("oc-live-status-shine");
    expect(screen.queryByText(/THINK_HIDDEN_TAIL/)).not.toBeInTheDocument();

    view.rerender(<MessageList processDisclosure messages={[user, ...phases[1]!]} sending sessionId="session-a" cb={{}} onRespondPermission={() => {}} />);
    expectOne();
    const liveStage = screen.getByTestId("process-stage");
    expect(liveStage).toHaveTextContent("我先对一下这班发布落在哪");
    expect(liveStage.closest("[data-testid=assistant-row]")).toBeNull();
    expect(screen.queryByTestId("assistant-meta")).not.toBeInTheDocument();

    view.rerender(<MessageList processDisclosure messages={[user, ...phases[2]!]} sending sessionId="session-a" cb={{}} onRespondPermission={() => {}} />);
    expectOne();
    expect(screen.queryByTestId("process-goal")).not.toBeInTheDocument();
    expect(screen.queryByTestId("process-goal-line")).not.toBeInTheDocument();
    expect(screen.queryByText("目标已清除")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看原始目标记录" })).not.toBeInTheDocument();
    expect(screen.queryByText(/tape-goal/)).not.toBeInTheDocument();
    expect(screen.getByTestId("process-toggle")).not.toHaveTextContent("目标");
    expect(screen.getByTestId("process-stage")).toHaveTextContent("我先对一下这班发布落在哪");

    view.rerender(<MessageList processDisclosure messages={[user, ...phases[3]!]} sending sessionId="session-a" cb={{}} onRespondPermission={() => {}} />);
    expectOne();
    expect(screen.getByTestId("process-step-live")).toHaveTextContent("正在运行命令");
    expect(screen.getByTestId("process-step-live")).toHaveAttribute("data-live-pending", "true");
    // OCV5-312: 展开时流光在「正在干活」的摘要行上,外壳标题不扫。
    expect(screen.getByTestId("process-step-live").className).not.toContain("oc-live-status-shine");
    expect(screen.getAllByTestId("process-group-summary").filter((node) => node.getAttribute("data-live-working") === "true")).toHaveLength(1);
    expect(screen.getAllByTestId("process-group-summary").find((node) => node.getAttribute("data-live-working") === "true")!.className).toContain("oc-live-status-shine");
    expect(screen.getByTestId("process-step-live")).not.toHaveTextContent("LIVE_CMD_MARKER");
    expect(screen.getByTestId("process-step-live")).not.toHaveTextContent("Bash");
    expect(screen.queryByText("RAW_JSON_SECRET")).not.toBeInTheDocument();

    view.rerender(<MessageList processDisclosure messages={[user, ...phases[4]!]} sending sessionId="session-a" cb={{}} onRespondPermission={() => {}} />);
    expectOne();
    expect(screen.getByTestId("process-step-live")).toHaveTextContent("正在思考下一步");
    expect(screen.getByTestId("process-step-live")).toHaveAttribute("data-live-pending", "true");
    // OCV5-312: 展开时流光在「正在干活」的摘要行上,外壳标题不扫。
    expect(screen.getByTestId("process-step-live").className).not.toContain("oc-live-status-shine");
    expect(screen.getAllByTestId("process-group-summary").filter((node) => node.getAttribute("data-live-working") === "true")).toHaveLength(1);
    expect(screen.getAllByTestId("process-group-summary").find((node) => node.getAttribute("data-live-working") === "true")!.className).toContain("oc-live-status-shine");
    expect(screen.getByTestId("process-step-live")).not.toHaveTextContent("LIVE_CMD_MARKER");
    expect(screen.queryByText("CMD_DONE_SECRET")).not.toBeInTheDocument();

    view.rerender(<MessageList processDisclosure messages={[user, ...phases[5]!]} sending sessionId="session-a" cb={{}} onRespondPermission={() => {}} />);
    expectOne();
    expect(screen.getAllByTestId("process-stage").some((node) => (node.textContent ?? "").includes("STAGE_TWO"))).toBe(true);
    expect(screen.getAllByTestId("process-stage").some((node) => (node.textContent ?? "").includes("我先对一下这班发布落在哪"))).toBe(true);
    expect(screen.queryByTestId("process-stage-toggle")).not.toBeInTheDocument();
    expect(screen.queryByText("LIVE_CMD_MARKER")).not.toBeInTheDocument();

    view.rerender(<MessageList processDisclosure messages={[user, ...phases[6]!]} sending sessionId="session-a" cb={{}} onRespondPermission={() => {}} />);
    expectOne();
    expect(screen.getByTestId("process-step-live")).toHaveTextContent("正在思考下一步");
    expect(screen.getByTestId("process-step-live")).not.toHaveTextContent("VERSION");
    expect(screen.queryByText("READ_SECRET")).not.toBeInTheDocument();

    view.rerender(<MessageList processDisclosure messages={[user, ...phases[7]!]} sending sessionId="session-a" cb={{}} onRespondPermission={() => {}} />);
    expectOne();
    const body = screen.getAllByTestId("process-stage").find((node) => node.textContent?.includes("FINAL_LONG"));
    expect(body).toBeTruthy();
    expect(body?.className ?? "").not.toMatch(/line-clamp/);
    expect(body?.closest("[data-testid=assistant-row]")).toBeNull();
    expect(screen.getAllByText("我先对一下这班发布落在哪").some((node) => node.closest("[data-testid=process-stage]"))).toBe(true);

    view.rerender(<MessageList processDisclosure messages={[user, ...phases[7]!]} sending={false} sessionId="session-a" cb={{}} onRespondPermission={() => {}} />);
    expect(screen.getAllByTestId("process-disclosure")).toHaveLength(1);
    expect(screen.getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "false");
    const finals = screen.getAllByText(/FINAL_LONG/);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.closest("[data-testid=process-disclosure]")).toBeNull();
    expect(screen.queryByText("会话目标")).not.toBeInTheDocument();
    expect(screen.queryByText("目标已清除")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("process-toggle"));
    expect(screen.queryByRole("button", { name: "查看原始目标记录" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("process-goal")).not.toBeInTheDocument();
  });

  // OCV5-320:#0498a304 实况 —— Codex 目标模式在回答之后回写一条进行中的目标(只在输入框上方钉住,
  // 正文不画),随后又跑了 2 步。这条看不见的目标行不能把步骤挤到回答下面另开一个「已执行 N 个步骤」。
  test("OCV5-320: 回答后的进行中目标回写不把后续步骤推到回答下面", () => {
    const bash = (id: string, command: string) => row(id, "tool", "终端", {
      _clientMessageId: "u",
      toolName: "Bash",
      inputJson: { command },
      _completed: true,
      output: "ok",
    });
    renderList([
      row("u", "user", "完成 OCV5-308", { status: "replied" }),
      bash("before", "probe-before"),
      row("answer", "assistant", "OCV5-308 已处理完", { _clientMessageId: "u" }),
      row("goal", "goal", "完成 OCV5-308", { _clientMessageId: "u", goalStatus: "active", cleared: false }),
      bash("after-1", "probe-after-1"),
      bash("after-2", "probe-after-2"),
    ]);
    const shells = screen.getAllByTestId("process-disclosure");
    expect(shells).toHaveLength(1);
    const answerRow = screen.getByText("OCV5-308 已处理完").closest("[data-testid=assistant-row]");
    expect(answerRow).not.toBeNull();
    expect(shells[0]!.compareDocumentPosition(answerRow!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByTestId("process-toggle"));
    fireEvent.click(screen.getByTestId("process-detail-toggle"));
    expect(screen.getByTestId("process-details").textContent ?? "").toMatch(/probe-before[\s\S]*probe-after-1[\s\S]*probe-after-2/);
  });

  test("OCV5-320: 进行中轮次里的目标回写不把过程拆成两节", () => {
    const bash = (id: string, command: string) => row(id, "tool", "终端", {
      _clientMessageId: "u",
      toolName: "Bash",
      inputJson: { command },
      _completed: true,
      output: "ok",
    });
    renderList([
      row("u", "user", "完成 OCV5-308", { status: "sent" }),
      bash("one", "probe-one"),
      row("goal", "goal", "完成 OCV5-308", { _clientMessageId: "u", goalStatus: "active", cleared: false }),
      bash("two", "probe-two"),
    ], { sending: true, turnActivity: { startedAt: Date.now(), agentName: "助手" } });
    expect(screen.getAllByTestId("process-disclosure")).toHaveLength(1);
  });

  test("进行中的目标和待确认不收进过程，普通句子里的目标二字也不当目标卡", () => {
    renderList([
      row("u", "user", "继续", { status: "replied" }),
      row("stage", "assistant", "会话目标已清除这句话只是阶段说明", { _clientMessageId: "u" }),
      row("bash", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "echo goal-not-a-card" },
        _completed: true,
        output: "ok",
      }),
      row("live-goal", "goal", "发布前确认目标", {
        _clientMessageId: "u",
        goalStatus: "active",
        cleared: false,
        _turnTapeId: "tape-live-goal",
      }),
      row("blocked-goal", "goal", "被堵住的目标", {
        _clientMessageId: "u",
        goalStatus: "blocked",
        cleared: false,
        _turnTapeId: "tape-blocked",
      }),
      row("ask", "permission", "目标要不要改", {
        _clientMessageId: "u",
        toolName: "AskUserQuestion",
        requestId: "req-goal-ask",
        _resolved: false,
        inputJson: { questions: [{ question: "目标要不要改", options: [{ label: "保持" }] }] },
      }),
      row("answer", "assistant", "目标先保持", { _clientMessageId: "u" }),
    ]);
    expect(screen.queryByText("发布前确认目标")).not.toBeInTheDocument();
    expect(screen.queryByText("被堵住的目标")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看原始目标记录" })).not.toBeInTheDocument();
    expect(screen.getByTestId("process-toggle")).not.toHaveTextContent("目标");
    expect(screen.getByTestId("permission-card").closest("[data-testid=process-disclosure]")).toBeNull();
    expect(screen.getByText("目标先保持").closest("[data-testid=process-disclosure]")).toBeNull();
    expect(screen.queryByText("goal-not-a-card")).not.toBeInTheDocument();
    expect(screen.queryByText("会话目标已清除这句话只是阶段说明")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("process-toggle"));
    fireEvent.click(screen.getByTestId("process-detail-toggle"));
    expect(screen.getByTestId("process-details").textContent ?? "").toMatch(/goal-not-a-card/);
    expect(screen.getByText("会话目标已清除这句话只是阶段说明").closest("[data-testid=process-stage]")).not.toBeNull();
  });

  test("回答与生成状态不留头像列，已有过程或正文时不再挂独立思考块", () => {
    const view = renderList([
      row("u", "user", "你好", { status: "sent" }),
    ], { sending: true, turnActivity: { startedAt: Date.now(), agentName: "助手" } });
    expect(screen.getByLabelText("生成中")).toHaveTextContent("思考中");
    expect(screen.getByTestId("turn-activity-footer").querySelector(".bg-grad-cta")).toBeNull();
    expect(screen.getByTestId("turn-activity-footer").className).not.toMatch(/ml-\[52px\]|gap-4/);

    view.rerender(
      <MessageList
        processDisclosure
        messages={[
          row("u", "user", "你好", { status: "sent" }),
          row("a", "assistant", "纯聊回答已经写出来了", { _clientMessageId: "u" }),
        ]}
        sending
        sessionId="session-a"
        turnActivity={{ startedAt: Date.now(), agentName: "助手" }}
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    const answer = screen.getByTestId("assistant-row");
    expect(answer).toHaveTextContent("纯聊回答已经写出来了");
    expect(answer.querySelector(".bg-grad-cta")).toBeNull();
    expect(answer.className).not.toMatch(/gap-4/);
    expect(screen.queryByLabelText("生成中")).not.toBeInTheDocument();
    expect(screen.queryByTestId("process-disclosure")).not.toBeInTheDocument();

    view.rerender(
      <MessageList
        processDisclosure
        messages={[
          row("u", "user", "继续", { status: "sent" }),
          row("stage", "assistant", "先看实时步骤", { _clientMessageId: "u" }),
          row("tool", "tool", "终端", {
            _clientMessageId: "u",
            toolName: "Bash",
            inputJson: { command: "echo live" },
            _completed: false,
          }),
          row("ask", "permission", "要不要继续", {
            _clientMessageId: "u",
            toolName: "AskUserQuestion",
            requestId: "req-avatar",
            _resolved: true,
            _behavior: "allow",
            inputJson: { questions: [{ question: "要不要继续", options: [{ label: "继续" }] }] },
          }),
        ]}
        sending
        sessionId="session-a"
        turnActivity={{ startedAt: Date.now(), agentName: "助手" }}
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByTestId("process-disclosure").className).not.toMatch(/ml-\[52px\]/);
    expect(screen.queryByLabelText("生成中")).not.toBeInTheDocument();
    // OCV5-307:进行中的轮次里,已回答的提问留在展开的过程轨线上(不再单独挂在过程外)。
    expect(screen.getByTestId("permission-card").closest("[data-testid=process-card]")).not.toBeNull();
    expect(screen.getByTestId("turn-activity-footer").querySelector(".bg-grad-cta")).toBeNull();

    view.rerender(
      <MessageList
        processDisclosure
        messages={[
          row("u", "user", "继续", { status: "sent" }),
          row("stage", "assistant", "先看实时步骤", { _clientMessageId: "u" }),
        ]}
        sending
        sessionId="session-a"
        turnActivity={{ startedAt: Date.now(), agentName: "助手", recoveryStatus: { kind: "stopping" } }}
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByText("正在停止…")).toBeInTheDocument();
    expect(screen.getByTestId("turn-activity-footer").querySelector(".bg-grad-cta")).toBeNull();
    cleanup();
    const { unmount } = render(<><MessageListSkeleton /><PartialHistorySkeleton /></>);
    expect(document.querySelector(".bg-grad-cta")).toBeNull();
    unmount();
  });

  test("同轮前一个工具仍在跑时，当前步骤不把后一个已完成当成整段结束", () => {
    renderList([
      row("u", "user", "并行查两处", { status: "sent" }),
      row("running", "tool", "读取", {
        _clientMessageId: "u",
        toolName: "Read",
        inputJson: { file_path: "STILL_RUNNING_FILE" },
        _completed: false,
      }),
      row("done", "tool", "搜索", {
        _clientMessageId: "u",
        toolName: "Grep",
        inputJson: { pattern: "LATER_DONE_PATTERN" },
        _completed: true,
        output: "LATER_DONE_SECRET",
      }),
    ], { sending: true });
    const live = screen.getByTestId("process-step-live");
    expect(live).toHaveTextContent("正在读取文件");
    expect(live).not.toHaveTextContent("Read");
    expect(live).not.toHaveTextContent("STILL_RUNNING_FILE");
    expect(live).not.toHaveTextContent("工具执行完成");
    expect(live).not.toHaveTextContent("LATER_DONE_PATTERN");
    expect(screen.queryByText("LATER_DONE_SECRET")).not.toBeInTheDocument();
  });

  test("进行中的旧阶段正文直接显示，不折成一行摘要", () => {
    const long = `先核对北仓南仓可售口径然后再决定预警是否单列。${"后文不该整段挂上。".repeat(8)}`;
    renderList([
      row("u", "user", "展开旧阶段", { status: "sent" }),
      row("old", "assistant", long, { _clientMessageId: "u" }),
      row("tool", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "echo next" },
        _completed: true,
      }),
      row("now", "assistant", "当前阶段还在写", { _clientMessageId: "u" }),
    ], { sending: true });
    expect(screen.queryByTestId("process-stage-toggle")).not.toBeInTheDocument();
    const bodies = screen.getAllByTestId("process-stage");
    const previous = bodies.find((node) => (node.textContent ?? "").includes("先核对北仓南仓"));
    expect(previous).toBeTruthy();
    expect(previous?.textContent ?? "").toContain("后文不该整段挂上");
    expect(bodies.some((node) => (node.textContent ?? "").includes("当前阶段还在写"))).toBe(true);
  });

  test("进行中的长正文后追加已清除目标，正文仍默认全文可读", () => {
    const user = row("u", "user", "写说明", { status: "sent" });
    const prep = row("prep", "tool", "终端", {
      _clientMessageId: "u",
      toolName: "Bash",
      inputJson: { command: "echo PREP_DONE" },
      _completed: true,
      output: "PREP_SECRET",
    });
    const sentence = "这是还在进行的阶段说明，不该被目标诊断收起。";
    const long = `LONG_BODY_MARKER ${sentence.repeat(8)}`;
    const stage = row("st", "assistant", long, { _clientMessageId: "u" });
    const goal = row("g", "goal", "库存目标", {
      _clientMessageId: "u",
      cleared: true,
      goalStatus: "cleared",
      _turnTapeId: "tape-after-body",
    });
    const view = renderList([user, prep, stage], { sending: true });
    const before = screen.getByTestId("process-stage");
    expect(before).toHaveTextContent("LONG_BODY_MARKER");
    expect(before.textContent ?? "").toContain(sentence.repeat(2));
    expect(before.className).not.toMatch(/line-clamp/);
    expect(screen.getByTestId("process-toggle")).toHaveTextContent("处理过程");

    view.rerender(
      <MessageList
        processDisclosure
        messages={[user, prep, stage, goal]}
        sending
        sessionId="session-a"
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    const body = screen.getByTestId("process-stage");
    expect(body).toHaveTextContent("LONG_BODY_MARKER");
    expect(body.textContent ?? "").toContain(sentence.repeat(2));
    expect(body.className).not.toMatch(/line-clamp/);
    expect(screen.queryByTestId("process-stage-toggle")).not.toBeInTheDocument();
    expect(body.closest("[data-testid=process-goal]")).toBeNull();
    expect(screen.queryByTestId("process-goal")).not.toBeInTheDocument();
    expect(screen.queryByText("目标已清除")).not.toBeInTheDocument();
    expect(screen.getByTestId("process-toggle")).not.toHaveTextContent("目标");
    expect(screen.getByTestId("process-disclosure")).toHaveAttribute("data-process-active", "true");
    expect(screen.getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByTestId("process-toggle"));
    expect(screen.getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("process-stage")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("process-toggle"));
    expect(screen.getByTestId("process-stage").textContent ?? "").toContain(sentence.repeat(2));

    const next = row("next", "tool", "读取", {
      _clientMessageId: "u",
      toolName: "Read",
      inputJson: { file_path: "NEXT_STEP_FILE" },
      _completed: false,
    });
    view.rerender(
      <MessageList
        processDisclosure
        messages={[user, prep, stage, goal, next]}
        sending
        sessionId="session-a"
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByTestId("process-stage")).toHaveTextContent("LONG_BODY_MARKER");
    expect(screen.getByTestId("process-stage").textContent ?? "").toContain(sentence.repeat(2));
    expect(screen.getByTestId("process-step-live")).toHaveTextContent("正在读取文件");
    expect(screen.getByTestId("process-step-live")).not.toHaveTextContent("NEXT_STEP_FILE");

    cleanup();
    renderList([user, prep, stage, goal, row("ans", "assistant", "终答在壳外", { _clientMessageId: "u" })]);
    expect(screen.getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("终答在壳外").closest("[data-testid=process-disclosure]")).toBeNull();
    expect(screen.queryByTestId("process-stage")).not.toBeInTheDocument();
  });

  test("流光只在正在干活的那一段：展开挂摘要行，折叠挂标题，结束后没有", () => {
    const user = row("u", "user", "清理磁盘", { status: "sent" });
    const done = row("c1", "tool", "终端", {
      _clientMessageId: "u",
      toolName: "Bash",
      inputJson: { command: "du -sh /tmp" },
      _completed: true,
      output: "1G",
    });
    const mid = row("m", "assistant", "先看了临时目录，接下来清缓存。", { _clientMessageId: "u" });
    const running = row("c2", "tool", "终端", {
      _clientMessageId: "u",
      toolName: "Bash",
      inputJson: { command: "rm -rf /tmp/cache" },
      _completed: false,
    });
    const view = renderList([user, done, mid, running], { sending: true });
    const summaries = screen.getAllByTestId("process-group-summary");
    expect(summaries).toHaveLength(2);
    expect(summaries[0]!.getAttribute("data-live-working")).toBe("false");
    expect(summaries[0]!.className).not.toContain("oc-live-status-shine");
    expect(summaries[0]!.className).toContain("text-faint");
    expect(summaries[1]!.getAttribute("data-live-working")).toBe("true");
    expect(summaries[1]!.className).toContain("oc-live-status-shine");
    expect(screen.getByTestId("process-step-live").className).not.toContain("oc-live-status-shine");
    expect(screen.getByTestId("process-step-live").className).toContain("text-faint");
    expect(document.querySelectorAll(".oc-live-status-shine")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("process-toggle"));
    expect(screen.queryByTestId("process-group-summary")).not.toBeInTheDocument();
    expect(screen.getByTestId("process-step-live").className).toContain("oc-live-status-shine");
    expect(document.querySelectorAll(".oc-live-status-shine")).toHaveLength(1);

    view.rerender(
      <MessageList
        processDisclosure
        messages={[user, done, mid, { ...running, _completed: true, output: "ok" }, row("a", "assistant", "清理完成", { _clientMessageId: "u" })]}
        sending={false}
        sessionId="session-a"
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(document.querySelectorAll(".oc-live-status-shine")).toHaveLength(0);
    // 结束后的外壳标题也是过程文字:--faint。
    expect(screen.getByTestId("process-title").className).toContain("text-faint");
  });

  test("当前在写正文时不挂流光；过程行回落 --faint，干活行用 --muted 作无动效时的静态强调", () => {
    const user = row("u", "user", "清理磁盘", { status: "sent" });
    const done = row("c1", "tool", "终端", {
      _clientMessageId: "u",
      toolName: "Bash",
      inputJson: { command: "du -sh /tmp" },
      _completed: true,
      output: "1G",
    });
    const writing = row("m", "assistant", "临时目录占了 1G，我先说明一下清理方案。", { _clientMessageId: "u" });
    renderList([user, done, writing], { sending: true });
    const summary = screen.getByTestId("process-group-summary");
    expect(summary.getAttribute("data-live-working")).toBe("false");
    expect(summary.className).toContain("text-faint");
    expect(summary.className).not.toContain("text-muted");
    expect(document.querySelectorAll(".oc-live-status-shine")).toHaveLength(0);
    expect(screen.getByTestId("process-stage")).toHaveTextContent("我先说明一下清理方案");

    cleanup();
    renderList([user, row("c2", "tool", "终端", {
      _clientMessageId: "u",
      toolName: "Bash",
      inputJson: { command: "rm -rf /tmp/cache" },
      _completed: false,
    })], { sending: true });
    const working = screen.getByTestId("process-group-summary");
    expect(working.getAttribute("data-live-working")).toBe("true");
    expect(working.className).toContain("oc-live-status-shine");
    expect(working.className).toContain("text-muted");
  });

  describe("长步骤 / 步骤间隙的活性信号", () => {
    const T0 = 1_790_000_000_000;
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(T0);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const user = row("u", "user", "清理磁盘", { status: "sent", ts: T0 - 60_000 });
    const done = row("c1", "tool", "终端", {
      _clientMessageId: "u",
      toolName: "Bash",
      inputJson: { command: "du -sh /tmp" },
      _completed: true,
      output: "1G",
      ts: T0 - 50_000,
    });

    test("叙述段写完后静默超过 3 秒，时间轴末尾挂一行活的「正在思考下一步」，新步骤一来就消失", () => {
      const mid = row("m", "assistant", "临时目录占了 1G，接下来清缓存。", { _clientMessageId: "u", ts: T0 - 1_000 });
      const activity = { startedAt: T0 - 60_000, lastFrameAt: T0 - 1_000, agentName: "助手" };
      const view = renderList([user, done, mid], { sending: true, turnActivity: activity });
      // 刚写完:还在「组织回复」,不挂尾行,也不挂流光(流式文字本身就是信号)。
      expect(screen.queryByTestId("process-live-tail")).not.toBeInTheDocument();
      expect(screen.getByTestId("process-step-live")).toHaveTextContent("正在组织回复");
      expect(document.querySelectorAll(".oc-live-status-shine")).toHaveLength(0);

      act(() => {
        vi.advanceTimersByTime(3_000);
      });
      const tail = screen.getByTestId("process-live-tail");
      expect(tail).toHaveTextContent("正在思考下一步");
      expect(tail).toHaveTextContent("4 秒");
      expect(screen.getByTestId("process-step-live")).toHaveTextContent("正在思考下一步");
      // 一轮仍只有一处在扫:展开时是尾行。
      expect(document.querySelectorAll(".oc-live-status-shine")).toHaveLength(1);
      expect(tail.querySelector(".oc-live-status-shine")).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(screen.getByTestId("process-live-tail")).toHaveTextContent("14 秒");

      // 下一条命令到了:尾行消失,流光落到这条命令所在段的摘要行。
      const next = row("c2", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "rm -rf /tmp/cache" },
        _completed: false,
        ts: Date.now(),
      });
      view.rerender(
        <MessageList
          processDisclosure
          messages={[user, done, mid, next]}
          sending
          sessionId="session-a"
          cb={{}}
          onRespondPermission={() => {}}
          turnActivity={{ ...activity, lastFrameAt: Date.now() }}
        />,
      );
      expect(screen.queryByTestId("process-live-tail")).not.toBeInTheDocument();
      expect(document.querySelectorAll(".oc-live-status-shine")).toHaveLength(1);
    });

    test("命令连续运行超过 5 秒，在干活的摘要行旁显示每秒在走的「已运行 N 秒」", () => {
      const running = row("c2", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "npm test" },
        _completed: false,
        ts: T0,
      });
      const activity = { startedAt: T0 - 60_000, lastFrameAt: T0, agentName: "助手" };
      renderList([user, done, row("m", "assistant", "跑一下测试。", { _clientMessageId: "u", ts: T0 - 2_000 }), running], {
        sending: true,
        turnActivity: activity,
      });
      expect(screen.queryByTestId("process-step-running-for")).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(screen.getByTestId("process-step-running-for")).toHaveTextContent("已运行 5 秒");
      act(() => {
        vi.advanceTimersByTime(70_000);
      });
      expect(screen.getByTestId("process-step-running-for")).toHaveTextContent("已运行 1 分 15 秒");
      // 只挂在正在干活的那一段;已完成的段没有。
      expect(screen.getAllByTestId("process-step-running-for")).toHaveLength(1);
      // 静默时长不影响命令段(不是叙述段),不会冒出「正在思考下一步」尾行。
      expect(screen.queryByTestId("process-live-tail")).not.toBeInTheDocument();
    });

    test("没有会话级帧时刻(历史轮 / 缺省)时两种信号都不出现", () => {
      const mid = row("m", "assistant", "临时目录占了 1G。", { _clientMessageId: "u", ts: T0 - 60_000 });
      const running = row("c2", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "npm test" },
        _completed: false,
        ts: T0 - 60_000,
      });
      renderList([user, done, mid], { sending: true, turnActivity: { startedAt: T0 - 60_000, agentName: "助手" } });
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(screen.queryByTestId("process-live-tail")).not.toBeInTheDocument();

      cleanup();
      renderList([user, done, running], { sending: true, turnActivity: { startedAt: T0 - 60_000, agentName: "助手" } });
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(screen.queryByTestId("process-step-running-for")).not.toBeInTheDocument();

      cleanup();
      renderList([user, done, mid], { sending: false, turnActivity: { startedAt: T0 - 60_000, lastFrameAt: T0 - 60_000, agentName: "助手" } });
      expect(screen.queryByTestId("process-live-tail")).not.toBeInTheDocument();
    });
  });

  test("刷新后上一轮的过程和回答不并进最新一轮的处理过程，旧问答卡回到自己那轮（OCV5-313）", () => {
    const u1 = row("u1", "user", "个人版又有合入", { status: "replied", ts: 1_790_953_040_000 });
    const u2 = row("u2", "user", "个人版又有新的提交", { status: "sent", ts: 1_790_957_298_000 });
    const early = row("t1a", "tool", "终端", { _clientMessageId: "u1", toolName: "Bash", inputJson: { command: "git log -3" }, _completed: true, output: "ok" });
    const mid1 = row("a1mid", "assistant", "收到，我再核对这次个人版增量", { _clientMessageId: "u1" });
    const strayTool = row("t1b", "tool", "终端", { _clientMessageId: "u1", toolName: "Bash", inputJson: { command: "npm test" }, _completed: true, output: "ok" });
    const strayFinal = row("a1fin", "assistant", "PREV_TURN_FINAL 最新合入已纳入商业候选并推送", { _clientMessageId: "u1" });
    const oldQ = row("q-old", "permission", "OLD_Q 按哪个方向同步？", {
      toolName: "AskUserQuestion",
      requestId: "req-old",
      _resolved: true,
      _behavior: "allow",
      _source: "local",
      inputJson: { questions: [{ question: "OLD_Q 按哪个方向同步？", options: [{ label: "双向同步" }] }] },
      ts: 1_790_920_012_000,
    } as Partial<ChatMessage>);
    const u0 = row("u0", "user", "将v5个人版和商业版代码同步下", { status: "replied", ts: 1_790_919_924_000 });
    const a0 = row("a0", "assistant", "OLDEST_ANSWER", { _clientMessageId: "u0" });
    const now = row("t2", "tool", "终端", { _clientMessageId: "u2", toolName: "Bash", inputJson: { command: "git fetch" }, _completed: false });
    renderList([u0, a0, u1, early, mid1, u2, strayTool, strayFinal, oldQ, now], { sending: true });
    const shells = screen.getAllByTestId("process-disclosure");
    const live = shells.find((shell) => shell.getAttribute("data-process-active") === "true")!;
    expect(live).toBeTruthy();
    expect(live.textContent ?? "").not.toMatch(/PREV_TURN_FINAL|收到，我再核对/);
    // 上一轮的终答回到上一轮,显示为顶层回答,不在最新一轮的壳里。
    const final = screen.getByText(/PREV_TURN_FINAL/);
    expect(final.closest("[data-process-active=true]")).toBeNull();
    // 旧问答卡排在它被回答的那一轮(最早那轮),在「个人版又有合入」之前,不再挂在最新回答后面。
    // 默认它收在最早那轮已结束的「工作过程」里(已回答的问答进过程),不在页面底部露出。
    expect(screen.queryByText(/OLD_Q/)).not.toBeInTheDocument();
    const oldestShell = shells[0]!;
    expect(oldestShell.getAttribute("data-process-active")).toBe("false");
    fireEvent.click(within(oldestShell).getByTestId("process-toggle"));
    const qNode = within(oldestShell).getAllByText(/OLD_Q/)[0] ?? null;
    expect(qNode).not.toBeNull();
    const laterUser = screen.getByText("个人版又有合入");
    expect(qNode!.compareDocumentPosition(laterUser) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(qNode!.compareDocumentPosition(final) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("进行中的工具后追加已完成目标，当前工具仍默认可见", () => {
    const user = row("u", "user", "接着查", { status: "sent" });
    const running = row("cmd", "tool", "终端", {
      _clientMessageId: "u",
      toolName: "Bash",
      inputJson: { command: "LIVE_STILL_RUNNING" },
      _completed: false,
    });
    const goal = row("g", "goal", "做完的目标", {
      _clientMessageId: "u",
      goalStatus: "completed",
      _turnTapeId: "tape-after-tool",
    });
    const view = renderList([user, running], { sending: true });
    expect(screen.getByTestId("process-step-live")).toHaveTextContent("正在运行命令");
    expect(screen.getByTestId("process-step-live")).not.toHaveTextContent("LIVE_STILL_RUNNING");

    view.rerender(
      <MessageList
        processDisclosure
        messages={[user, running, goal]}
        sending
        sessionId="session-a"
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    const live = screen.getByTestId("process-step-live");
    expect(live).toHaveTextContent("正在运行命令");
    expect(live).not.toHaveTextContent("LIVE_STILL_RUNNING");
    expect(live).not.toHaveTextContent("已完成");
    expect(screen.getByTestId("process-goal")).toBeInTheDocument();
    expect(screen.getByTestId("process-disclosure")).toHaveAttribute("data-process-active", "true");
    expect(screen.getByTestId("process-toggle")).toHaveTextContent("处理过程");
    expect(screen.getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByTestId("process-detail-toggle"));
    expect(screen.getByTestId("process-step-live")).toHaveTextContent("正在运行命令");
    expect(screen.getByTestId("process-details")).toHaveTextContent("LIVE_STILL_RUNNING");
  });

  test("进行中的长阶段超过128KiB后追加的尾部默认可读，旧阶段不再标成正在写", () => {
    const head = "长段".repeat((128 * 1024) / 2);
    const user = row("u", "user", "写长说明", { status: "sent" });
    const prep = row("prep", "tool", "终端", {
      _clientMessageId: "u",
      toolName: "Bash",
      inputJson: { command: "echo LONG_PREP" },
      _completed: true,
      output: "ok",
    });
    const stage = (text: string) => row("st", "assistant", text, { _clientMessageId: "u" });
    const view = renderList([user, prep, stage(head)], { sending: true });
    view.rerender(
      <MessageList
        processDisclosure
        messages={[user, prep, stage(`${head}\nTAIL_MARKER_NOW`)]}
        sending
        sessionId="session-a"
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    const body = screen.getByTestId("process-stage");
    expect(body).toHaveTextContent("TAIL_MARKER_NOW");
    expect(screen.queryByRole("button", { name: "继续显示正文" })).not.toBeInTheDocument();
    expect(body.className).not.toMatch(/\btext-sm\b|\bleading-6\b/);

    const next = row("st2", "assistant", "NEXT_STAGE_ONLY", { _clientMessageId: "u" });
    view.rerender(
      <MessageList
        processDisclosure
        messages={[user, prep, stage(`${head}\nTAIL_MARKER_NOW`), next]}
        sending
        sessionId="session-a"
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getAllByTestId("process-stage").some((node) => (node.textContent ?? "").includes("NEXT_STAGE_ONLY"))).toBe(true);
    expect(screen.getAllByTestId("process-stage").some((node) => (node.textContent ?? "").includes("长段"))).toBe(true);
    expect(screen.queryByTestId("process-stage-toggle")).not.toBeInTheDocument();
    expect(screen.queryByText("TAIL_MARKER_NOW")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续显示正文" })).toBeInTheDocument();
    expect(screen.getAllByTestId("process-stage").some((node) => (node.textContent ?? "").includes("NEXT_STAGE_ONLY"))).toBe(true);
  });

  test("实时状态说人话，默认不露命令、路径和任务号，展开仍能审计原命令", () => {
    const user = row("u", "user", "查一下", { status: "sent" });
    const hidden = (live: HTMLElement, pattern: RegExp) => {
      expect(live.textContent ?? "").not.toMatch(pattern);
      expect(live.getAttribute("title")).toBeNull();
      expect(live.getAttribute("aria-label")).toBeNull();
      const toggle = screen.getByTestId("process-detail-toggle");
      expect(`${toggle.getAttribute("title") ?? ""} ${toggle.getAttribute("aria-label") ?? ""} ${toggle.textContent ?? ""}`).not.toMatch(pattern);
    };
    const expectPhrase = (id: string, extra: Partial<ChatMessage>, phrase: string, pattern: RegExp) => {
      cleanup();
      renderList([
        user,
        row(id, "tool", "工具", { _clientMessageId: "u", _completed: false, ...extra }),
      ], { sending: true });
      const live = screen.getByTestId("process-step-live");
      expect(live).toHaveTextContent(phrase);
      hidden(live, pattern);
    };

    expectPhrase("wait", {
      toolName: "Bash",
      inputJson: { command: "OPENCLAUDE_GATEWAY_PORT=18790 oc-memory delegate-wait dlgjob-motion-SECRET" },
    }, "等待子任务完成", /dlgjob|delegate-wait|Bash|18790/);
    expectPhrase("wrap", {
      toolName: "Bash",
      inputJson: { command: "/bin/bash -lc 'oc-memory delegate-wait dlgjob-wrapped-SECRET'" },
    }, "等待子任务完成", /dlgjob|SECRET|bash/);
    expectPhrase("echo", {
      toolName: "Bash",
      inputJson: { command: "echo view_image /tmp/a.png imagegen dlgjob-fake" },
    }, "正在运行命令", /view_image|imagegen|dlgjob|\/tmp/);
    expectPhrase("quoted-semi", {
      toolName: "Bash",
      inputJson: { command: "printf '%s' '; oc-vision understand fake.png'" },
    }, "正在运行命令", /正在识别图片|fake\.png|understand|oc-vision/);
    expectPhrase("quoted-wait", {
      toolName: "Bash",
      inputJson: { command: "printf '%s' '; oc-memory delegate-wait dlgjob-quoted'" },
    }, "正在运行命令", /等待子任务完成|dlgjob/);
    expectPhrase("and-chain", {
      toolName: "Bash",
      inputJson: { command: "cd /tmp && oc-vision understand fake.png" },
    }, "正在运行命令", /正在识别图片|fake\.png|understand/);
    expectPhrase("py", {
      toolName: "Bash",
      inputJson: { command: "python build.py --output /tmp/view_image.png --note imagegen" },
    }, "正在运行命令", /view_image|imagegen|\/tmp|python/);
    expectPhrase("shot", {
      toolName: "Bash",
      inputJson: { command: "oc-browser screenshot --filename /home/agent/.openclaude/generated/secret-shot.png" },
    }, "工具执行中", /secret-shot|screenshot|oc-browser|generated/);
    expectPhrase("see", {
      toolName: "view_image",
      inputJson: { path: "/tmp/pic.png" },
    }, "正在查看图片", /\/tmp|pic\.png|view_image/);
    expectPhrase("vision", {
      toolName: "Bash",
      inputJson: { command: "oc-vision understand /tmp/pic.png --prompt 这是什么" },
    }, "正在识别图片", /\/tmp|pic\.png|understand|oc-vision/);
    expectPhrase("gen", {
      toolName: "imagegen",
      inputJson: { prompt: "a cat /tmp/out.png" },
    }, "正在生成图片", /\/tmp|imagegen|cat/);
    expectPhrase("codexgen", {
      toolName: "codex:imageGeneration",
      inputJson: { type: "imageGeneration", prompt: "x" },
    }, "正在生成图片", /imageGeneration/);
    expectPhrase("read", {
      toolName: "Read",
      inputJson: { file_path: "/tmp/VERSION" },
    }, "正在读取文件", /VERSION|\/tmp|Read/);
    expectPhrase("readimg", {
      toolName: "Read",
      inputJson: { file_path: "/tmp/imagegen.png" },
    }, "正在读取文件", /imagegen|\/tmp/);
    expectPhrase("search", {
      toolName: "Grep",
      inputJson: { pattern: "delegate-wait dlgjob-search" },
    }, "正在搜索资料", /dlgjob|delegate-wait|Grep/);
    expectPhrase("memsearch", {
      toolName: "Bash",
      inputJson: { command: "oc-memory core-search --query secret-topic" },
    }, "正在搜索资料", /secret-topic|core-search|oc-memory/);
    expectPhrase("unk", {
      toolName: "CustomWidget",
      inputJson: { query: "/tmp/secret" },
    }, "工具执行中", /CustomWidget|\/tmp|secret/);
    expectPhrase("done", {
      toolName: "Read",
      inputJson: { file_path: "/tmp/VERSION" },
      _completed: true,
      output: "ok",
    }, "正在思考下一步", /VERSION|\/tmp|Read/);

    cleanup();
    renderList([
      user,
      row("running", "tool", "读取", {
        _clientMessageId: "u",
        toolName: "Read",
        inputJson: { file_path: "/tmp/STILL" },
        _completed: false,
      }),
      row("later", "tool", "搜索", {
        _clientMessageId: "u",
        toolName: "Grep",
        inputJson: { pattern: "LATER" },
        _completed: true,
        output: "hit",
      }),
    ], { sending: true });
    const parallel = screen.getByTestId("process-step-live");
    expect(parallel).toHaveTextContent("正在读取文件");
    expect(parallel.textContent ?? "").not.toMatch(/工具执行完成|STILL|LATER/);

    cleanup();
    renderList([
      user,
      row("err", "tool", "失败命令", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "broken-probe" },
        _completed: true,
        error: true,
        output: "probe-error-detail",
      }),
    ], { sending: true });
    // OCV5-313: 中途单步未成功是正常流程:摘要行不单独点出「N 步未成功」,也不染红;外壳标题仍说在继续。
    expect(screen.queryByTestId("process-group-missed")).not.toBeInTheDocument();
    expect(screen.queryByText(/步未成功/)).not.toBeInTheDocument();
    expect(document.querySelector("[data-testid=process-disclosure] .text-danger")).toBeNull();
    expect(screen.getByTestId("process-step-live")).toHaveTextContent("正在思考下一步");
    expect(screen.queryByText("probe-error-detail")).not.toBeInTheDocument();
    expect(screen.queryByText("工具执行完成")).not.toBeInTheDocument();
    // 点开摘要后,这一步如实标「未成功」,但与其他过程文字同为安静灰字,整块不出现危险色。
    fireEvent.click(screen.getByTestId("process-detail-toggle"));
    const quiet = within(screen.getByTestId("process-details")).getByText("未成功");
    expect(quiet.className).toContain("text-faint");
    expect(document.querySelector("[data-testid=process-disclosure] .text-danger")).toBeNull();

    cleanup();
    renderList([
      user,
      row("audit", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "oc-memory delegate-wait dlgjob-audit-SECRET" },
        _completed: false,
      }),
    ], { sending: true });
    expect(screen.queryByText(/dlgjob-audit-SECRET/)).not.toBeInTheDocument();
    expect(screen.getByTestId("process-step-live")).toHaveTextContent("等待子任务完成");
    expect(screen.getByTestId("process-step-live")).toHaveAttribute("data-live-pending", "true");
    fireEvent.click(screen.getByTestId("process-detail-toggle"));
    expect(screen.getByTestId("process-raw-command")).toHaveTextContent("oc-memory delegate-wait dlgjob-audit-SECRET");
    expect(screen.getByTestId("process-step-live").textContent ?? "").not.toMatch(/dlgjob/);

    cleanup();
    const wrapped = "/bin/bash -lc 'oc-memory delegate-wait dlgjob-wrap-SECRET'";
    renderList([
      user,
      row("wrap-audit", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: wrapped },
        _completed: false,
      }),
    ], { sending: true });
    expect(screen.getByTestId("process-step-live")).toHaveTextContent("等待子任务完成");
    expect(screen.getByTestId("process-step-live").textContent ?? "").not.toMatch(/\/bin\/bash|dlgjob/);
    fireEvent.click(screen.getByTestId("process-detail-toggle"));
    expect(screen.getByTestId("process-raw-command").textContent ?? "").toBe(wrapped);
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
    expect(operationSummary([
      row("g", "goal", "库存目标", { cleared: true, goalStatus: "cleared" }),
      row("t", "tool", "终端", { toolName: "Bash", inputJson: { command: "echo keep" } }),
    ])).toBe("命令 1 项");
    expect(operationSummary([
      row("g", "goal", "做完的目标", { goalStatus: "completed" }),
    ])).toBe("目标 1 项");
  });

  test("已清除目标不占过程，只剩它时没有空壳，普通句子里的同样字句还在", () => {
    renderList([
      row("u", "user", "目标已清除", { status: "replied" }),
      row("g", "goal", "库存目标", {
        _clientMessageId: "u",
        cleared: true,
        goalStatus: "cleared",
        _turnTapeId: "tape-only",
      }),
    ]);
    expect(screen.getByText("目标已清除")).toBeInTheDocument();
    expect(screen.queryByTestId("process-disclosure")).not.toBeInTheDocument();
    expect(screen.queryByTestId("process-goal")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看原始目标记录" })).not.toBeInTheDocument();
    expect(screen.queryByText("tape-only")).not.toBeInTheDocument();
    expect(screen.queryByText("库存目标")).not.toBeInTheDocument();

    cleanup();
    const sample = "**对照重点**\n\n第一段说明。\n\n- 北仓\n\n`sku`";
    const completedGoal = row("done", "goal", "做完的目标", {
      _clientMessageId: "u", goalStatus: "completed", cleared: false, _turnTapeId: "tape-done",
    });
    renderList([
      row("u", "user", "继续", { status: "replied" }),
      row("flag", "goal", "只看清除标记", {
        _clientMessageId: "u",
        cleared: true,
        goalStatus: "active",
        _turnTapeId: "tape-flag",
      }),
      row("status", "goal", "只看状态", {
        _clientMessageId: "u",
        goalStatus: " Cleared ",
        _turnTapeId: "tape-status",
      }),
      completedGoal,
      row("paused", "goal", "暂停的目标", {
        _clientMessageId: "u",
        goalStatus: "paused",
        cleared: false,
      }),
      row("blocked", "goal", "堵住的目标", {
        _clientMessageId: "u",
        goalStatus: "blocked",
        cleared: false,
      }),
      row("bash", "tool", "终端", {
        _clientMessageId: "u",
        toolName: "Bash",
        inputJson: { command: "echo KEEP_STEP" },
        _completed: true,
        output: "ok",
      }),
      row("stage", "assistant", sample, { _clientMessageId: "u" }),
      row("main", "assistant", "目标已清除这句话是主助手回答", {
        _clientMessageId: "u",
        agentId: "main",
        ts: Date.now() - 5_000,
        usage: { costCredits: "9", totalTokens: 27_500, inputTokens: 20_000, outputTokens: 7_500 },
      }),
    ]);
    expect(screen.queryByText("只看清除标记")).not.toBeInTheDocument();
    expect(screen.queryByText("只看状态")).not.toBeInTheDocument();
    expect(screen.queryByText("目标已清除")).not.toBeInTheDocument();
    expect(screen.getByText("目标已清除这句话是主助手回答")).toBeInTheDocument();
    expect(screen.queryByText("暂停的目标")).not.toBeInTheDocument();
    expect(screen.queryByText("堵住的目标")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看原始目标记录" })).not.toBeInTheDocument();
    const meta = screen.getByTestId("assistant-meta");
    expect(meta).toHaveTextContent("9 积分");
    expect(meta.querySelector("time")).not.toBeNull();
    expect(meta).not.toHaveTextContent(/token/i);
    expect(screen.getAllByTestId("process-toggle")).toHaveLength(1);
    const goalToggle = screen.getByTestId("process-toggle");
    expect(goalToggle).toHaveTextContent("目标 1 项");
    expect(goalToggle).toHaveTextContent("命令 1 项");
    expect(goalToggle).not.toHaveTextContent("目标 2");
    fireEvent.click(goalToggle);
    const historical = screen.getByTestId("process-goal");
    expect(within(historical).getByText("做完的目标")).toBeInTheDocument();
    const rawToggle = within(historical).getByRole("button", { name: "查看原始目标记录" });
    expect(historical.querySelector("pre")).toBeNull();
    fireEvent.click(rawToggle);
    expect(historical.querySelector("pre")?.textContent).toBe(JSON.stringify(completedGoal, null, 2));
    fireEvent.click(within(historical).getByRole("button", { name: "收起原始目标记录" }));
    expect(historical.querySelector("pre")).toBeNull();
    const stage = screen.getByTestId("process-stage");
    expect(stage.className).not.toMatch(/\btext-sm\b|\bleading-6\b|\btext-muted\b/);
    expect(stage.querySelector(".prose")).not.toBeNull();
    expect(screen.getByText("目标已清除这句话是主助手回答").closest("[data-testid=assistant-row]")?.querySelector(".prose")).not.toBeNull();

    cleanup();
    renderList([
      row("u2", "user", "另一个助手", { status: "replied" }),
      row("other", "assistant", "研究助手的最终回答", {
        _clientMessageId: "u2",
        agentId: "research-assistant",
        ts: Date.now() - 4_000,
        usage: { costCredits: "4", totalTokens: 8_000, inputTokens: 5_000, outputTokens: 3_000, traceId: "agenttrace1" },
      }),
    ]);
    const other = screen.getByTestId("assistant-meta");
    expect(other).toHaveTextContent("4 积分");
    expect(other.querySelector("time")).not.toBeNull();
    expect(other).not.toHaveTextContent(/token/i);
    expect(screen.getByTestId("assistant-speaker")).toHaveTextContent("research-assistant");
  });

  test("正文后面的计划和已答提问收回上面的工作过程，不在回答下面再开一节", () => {
    renderList([
      ...settledTurn(),
      row("plan-late", "plan", "晚到的执行计划", {
        _clientMessageId: "u1",
        steps: [{ step: "核对折叠", status: "completed" }],
      }),
      row("ask-after", "permission", "现在发布吗？", {
        _clientMessageId: "u1",
        toolName: "AskUserQuestion",
        requestId: "req-after-plan",
        _resolved: true,
        _behavior: "allow",
        inputJson: { questions: [{ question: "现在发布吗？", options: [{ label: "可以" }] }] },
      }),
    ]);
    expect(screen.getAllByTestId("process-disclosure")).toHaveLength(1);
    const disclosure = screen.getByTestId("process-disclosure");
    const answer = screen.getByText("看板已经做好").closest("[data-testid=assistant-row]");
    if (!answer) throw new Error("missing answer row");
    expect(disclosure.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // OCV5-307:回答之后才答完的提问也是本轮步骤,随晚到的计划一起回到回答上方的工作过程;
    // 收起态下不在回答下面单独露出。
    expect(screen.queryByTestId("permission-card")).not.toBeInTheDocument();
    expect(screen.queryByText("核对折叠")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("process-toggle"));
    expect(screen.getByTestId("permission-card").closest("[data-testid=process-disclosure]")).toBe(disclosure);
    fireEvent.click(screen.getByTestId("process-detail-toggle"));
    expect(screen.getByText("核对折叠").closest("[data-testid=process-disclosure]")).toBe(disclosure);
  });

  test("只有回答时，后到的计划单独成节并排在回答前面", () => {
    renderList([
      row("u", "user", "问一句", { status: "replied" }),
      row("a", "assistant", "答完了", { _clientMessageId: "u" }),
      row("p", "plan", "晚到的执行计划", {
        _clientMessageId: "u",
        steps: [{ step: "只剩计划", status: "pending" }],
      }),
    ]);
    expect(screen.getAllByTestId("process-disclosure")).toHaveLength(1);
    const disclosure = screen.getByTestId("process-disclosure");
    const answer = screen.getByText("答完了").closest("[data-testid=assistant-row]");
    if (!answer) throw new Error("missing answer row");
    expect(disclosure.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByTestId("process-toggle"));
    fireEvent.click(screen.getByTestId("process-detail-toggle"));
    expect(screen.getByText("只剩计划").closest("[data-testid=process-disclosure]")).toBe(disclosure);
  });

  // OCV5-307:用户报障「工作过程排在回答后面」。回答之后本轮还跑的工具同样收回回答上方的
  // 那一个工作过程,不再在回答下面另开一节。
  test("正文后面的普通工具也收回上面的工作过程，回答下面不再另开一节", () => {
    renderList([
      ...settledTurn(),
      row("late-tool", "tool", "后补命令", {
        _clientMessageId: "u1",
        toolName: "Bash",
        inputJson: { command: "late-probe-cmd" },
        _completed: true,
        output: "ok",
      }),
    ]);
    expect(screen.getAllByTestId("process-disclosure")).toHaveLength(1);
    const answer = screen.getByText("看板已经做好").closest("[data-testid=assistant-row]");
    if (!answer) throw new Error("missing answer row");
    const shell = screen.getByTestId("process-disclosure");
    expect(shell.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByTestId("process-toggle"));
    for (const toggle of screen.getAllByTestId("process-detail-toggle")) fireEvent.click(toggle);
    expect(screen.getByText("late-probe-cmd", { exact: false }).closest("[data-testid=process-disclosure]")).toBe(shell);
  });

  // OCV5-307 实况(webmuqjhduqb0ifd9 / tape b16e514b):网关把 turn 终态错误(codex serverOverloaded)
  // 记在本轮**最后一段正文**上,之后存的工具行其实发生在错误之前。所以它不是「越过的中途错误」,
  // 而是本轮结局:整张错误卡排在本轮末尾(回答之后),后面那些行收进回答上方唯一的工作过程。
  test("OCV5-307: 记在最后一段正文上的终态错误排在本轮末尾，之后存的行收回上方工作过程", () => {
    renderList(
      [
        row("u", "user", "把新模型都上线", { status: "replied" }),
        row("t0", "tool", "终端", { _clientMessageId: "u", toolName: "Bash", inputJson: { command: "git fetch" }, _completed: true, output: "ok" }),
        row("s2", "assistant", "已明确：新增模型按个人版价格上线", { _clientMessageId: "u" }),
        row("t1", "tool", "终端", { _clientMessageId: "u", toolName: "Bash", inputJson: { command: "git diff" }, _completed: true, output: "ok" }),
        row("err", "assistant", "方案审查已通过，现在进入实现", { _clientMessageId: "u", _errorCode: "model_not_available" }),
        row("t2", "tool", "终端", { _clientMessageId: "u", toolName: "Bash", inputJson: { command: "git merge" }, _completed: true, output: "ok" }),
        row("th", "thinking", "**Resolving Git Conflicts**", { _clientMessageId: "u" }),
        row("t3", "tool", "终端", { _clientMessageId: "u", toolName: "Bash", inputJson: { command: "git push" }, _completed: true, output: "ok" }),
      ],
      { cb: { onOpenModelPicker: () => {} } },
    );
    const shells = screen.getAllByTestId("process-disclosure");
    expect(shells).toHaveLength(1);
    expect(screen.getByTestId("process-toggle")).toHaveTextContent("命令 4 项");
    const answer = screen.getByText("已明确：新增模型按个人版价格上线").closest("[data-testid=assistant-row]");
    const outcome = screen.getByText("模型暂不可用");
    if (!answer) throw new Error("missing answer row");
    expect(shells[0].compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 终态错误:顶层、在回答之后、是完整错误卡(不是「本轮已继续」说明),且后面再没有过程壳
    expect(outcome.closest("[data-testid=process-disclosure]")).toBeNull();
    expect(answer.compareDocumentPosition(outcome) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("recovered-error-note")).toBeNull();
    expect(screen.getByText("方案审查已通过，现在进入实现")).toBeInTheDocument();
    expect(outcome.compareDocumentPosition(shells[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeFalsy();
  });

  test("OCV5-307: 回答之后以错误收尾时，错误卡留在回答下方原位，前面的工具仍回到上方工作过程", () => {
    renderList([
      row("u", "user", "同步两边分支", { status: "replied" }),
      row("t0", "tool", "终端", { _clientMessageId: "u", toolName: "Bash", inputJson: { command: "git fetch" }, _completed: true, output: "ok" }),
      row("s2", "assistant", "审查发现一个不能直接合并的问题", { _clientMessageId: "u" }),
      row("t1", "tool", "终端", { _clientMessageId: "u", toolName: "Bash", inputJson: { command: "git merge" }, _completed: true, output: "ok" }),
      row("err", "assistant", "合并中断", { _clientMessageId: "u", _errorCode: "model_not_available" }),
    ]);
    expect(screen.getAllByTestId("process-disclosure")).toHaveLength(1);
    const shell = screen.getByTestId("process-disclosure");
    const answer = screen.getByText("审查发现一个不能直接合并的问题").closest("[data-testid=assistant-row]");
    const error = screen.getByText("模型暂不可用");
    if (!answer) throw new Error("missing answer row");
    expect(shell.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(answer.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(error.closest("[data-testid=process-disclosure]")).toBeNull();
  });
});

describe("OCV5-370 过程摘要上的详情面板入口", () => {
  test("本轮改过文件 → 常显「改动 N 个文件」,点开面板里这一轮的产出;不展开过程本身", () => {
    const openPane = vi.fn();
    const messages = settledTurn();
    messages.splice(
      messages.length - 1,
      0,
      row("w-1", "tool", "写入", {
        _clientMessageId: "u1",
        toolName: "Write",
        inputJson: { file_path: "/w/board.html", content: "<h1>库存</h1>" },
        _completed: true,
        output: "ok",
      }),
    );
    render(
      <ArtifactInspectContext.Provider value={{ open: () => {}, openPane }}>
        <MessageList processDisclosure messages={messages} sending={false} sessionId="session-a" cb={{}} onRespondPermission={() => {}} />
      </ArtifactInspectContext.Provider>,
    );
    const chip = screen.getByTestId("process-pane-changes");
    expect(chip).toHaveTextContent("改动 1 个文件");
    fireEvent.click(chip);
    // 带上这一轮的一行,面板据此定位到这一轮
    expect(openPane).toHaveBeenCalledWith("outputs", expect.objectContaining({ _clientMessageId: "u1" }));
    expect(screen.getByTestId("process-toggle")).toHaveAttribute("aria-expanded", "false");
  });

  test("只有其它步骤 → 「在详情面板查看步骤」;没有面板(无 provider)→ 都不出现", () => {
    const openPane = vi.fn();
    render(
      <ArtifactInspectContext.Provider value={{ open: () => {}, openPane }}>
        <MessageList processDisclosure messages={settledTurn()} sending={false} sessionId="session-a" cb={{}} onRespondPermission={() => {}} />
      </ArtifactInspectContext.Provider>,
    );
    expect(screen.queryByTestId("process-pane-changes")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "在详情面板查看步骤" }));
    expect(openPane).toHaveBeenCalledWith("steps");
    cleanup();
    renderList(settledTurn());
    expect(screen.queryByTestId("process-pane-steps")).not.toBeInTheDocument();
    expect(screen.queryByTestId("process-pane-changes")).not.toBeInTheDocument();
  });
});
