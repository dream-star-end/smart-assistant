/**
 * 多张任务审批卡回合级聚合测试（OCV5-869）：
 *  - 同回合 ≥2 张任务审批卡：逐张点击实时调 /api/board 生效，但不立刻 sendUserText、
 *    不锁死同组其它卡；底部显示进度、支持一键「全部通过 / 全部批准」、支持补充说明，
 *    最后由用户点「发送审批结果」合并成一条结构化消息发出。
 *  - 部分失败不假装全部成功；部分已处理可提前发送并标明未处理项；
 *  - 全部历史已生效时底栏隐身；单卡不入组保持点击即发。
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../lib/api";
import type { ChatMessage } from "../../lib/chat/model";
import type { Ticket, TicketStatus } from "../../lib/taskboard";
import { loadBeforeAll } from "../../test/moduleLoad";
import { MessageList } from "../MessageRenderer";
import { preloadToolBody } from "./lazyToolBody";
import {
  ChatInteractionContext,
  ToolCardActionsContext,
  type ToolCardActions,
} from "./context";
import { TaskApprovalCard } from "./taskApprovalCard";
import { preloadTaskApprovalGroup } from "./taskApprovalCoalesce";
import {
  TaskApprovalGroupFooter,
  TaskApprovalGroupProvider,
  coalesceTaskApprovalGroups,
  formatTaskApprovalSummary,
} from "./taskApprovalGroup";

loadBeforeAll(preloadToolBody);
loadBeforeAll(preloadTaskApprovalGroup);

afterEach(cleanup);

function makeTicket(identifier: string, overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: `uuid-${identifier}`,
    identifier,
    projectId: "p1",
    type: "feature",
    title: `任务 ${identifier}`,
    body: `说明 ${identifier}`,
    status: "waiting_human",
    stageId: "s1",
    pipelineId: "pipe",
    priority: "P1",
    severity: "major",
    labels: [],
    assignee: "agent:main",
    reporter: "agent:main",
    source: "chat",
    originSessionKey: "sess",
    dueDate: null,
    startDate: null,
    version: 3,
    blockedReason: null,
    stageLoopCount: 0,
    createdAt: 1,
    updatedAt: 2,
    closedAt: null,
    ...overrides,
  };
}

function renderGroup(opts: {
  ticketIds: string[];
  actions?: ToolCardActions;
  sendUserText?: (t: string) => void;
  busy?: boolean;
}) {
  return render(
    <ToolCardActionsContext.Provider value={opts.actions ?? {}}>
      <ChatInteractionContext.Provider
        value={{ sendUserText: opts.sendUserText, busy: opts.busy }}
      >
        <TaskApprovalGroupProvider ticketIds={opts.ticketIds}>
          <div data-testid="group-wrap">
            {opts.ticketIds.map((id) => (
              <div key={id} data-testid={`slot-${id}`}>
                <TaskApprovalCard id={id} />
              </div>
            ))}
            <TaskApprovalGroupFooter />
          </div>
        </TaskApprovalGroupProvider>
      </ChatInteractionContext.Provider>
    </ToolCardActionsContext.Provider>,
  );
}

describe("TaskApprovalGroup", () => {
  test("多张审批卡逐张点击实时改单但不发消息，点击底部发送合并为一条消息", async () => {
    const tickets: Record<string, Ticket> = {
      "OCV5-864": makeTicket("OCV5-864", { status: "waiting_human", version: 2 }),
      "OCV5-865": makeTicket("OCV5-865", { status: "waiting_human", version: 5 }),
    };
    const getTicket = vi.fn(async (id: string) => tickets[id]!);
    const approve = vi.fn(async (id: string, version: number) => ({
      ticket: makeTicket(id, { status: "ready" as TicketStatus, version: version + 1 }),
    }));
    const reject = vi.fn(async (id: string, version: number) => ({
      ticket: makeTicket(id, { status: "ready" as TicketStatus, version: version + 1 }),
    }));
    const sendUserText = vi.fn();

    renderGroup({
      ticketIds: ["OCV5-864", "OCV5-865"],
      actions: { taskApproval: { getTicket, approve, reject } },
      sendUserText,
    });

    const card1 = screen.getByTestId("slot-OCV5-864");
    const card2 = screen.getByTestId("slot-OCV5-865");
    await waitFor(() => {
      expect(within(card1).getByRole("button", { name: "通过" })).toBeEnabled();
      expect(within(card2).getByRole("button", { name: "通过" })).toBeEnabled();
    });

    // 点第一张通过：立刻调用 approve，不触发 sendUserText，第二张依然可点
    fireEvent.click(within(card1).getByRole("button", { name: "通过" }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith("OCV5-864", 2));
    expect(sendUserText).not.toHaveBeenCalled();
    expect(within(card1).getByText("已生效 · 待底部汇总发送")).toBeInTheDocument();
    expect(within(card2).getByRole("button", { name: "打回" })).toBeEnabled();

    // 第二张走打回并填理由
    fireEvent.click(within(card2).getByRole("button", { name: "打回" }));
    fireEvent.change(within(card2).getByPlaceholderText("打回理由（必填）"), {
      target: { value: "缺手机端截图" },
    });
    fireEvent.click(within(card2).getByRole("button", { name: "确认打回" }));
    await waitFor(() => expect(reject).toHaveBeenCalledWith("OCV5-865", 5, "缺手机端截图"));
    expect(sendUserText).not.toHaveBeenCalled();

    // 底部进度更新为 2 / 2，「全部通过」自动消失
    const footer = screen.getByTestId("task-approval-group-footer");
    expect(footer).toHaveTextContent("已处理 2 / 2 项");
    expect(screen.queryByTestId("task-approval-approve-all")).not.toBeInTheDocument();

    // 补充说明并点击统一发送
    fireEvent.click(within(footer).getByRole("button", { name: "补充说明" }));
    fireEvent.change(screen.getByTestId("task-approval-group-note-input"), {
      target: { value: "先推进 864" },
    });
    fireEvent.click(screen.getByTestId("task-approval-send-summary"));

    expect(sendUserText).toHaveBeenCalledTimes(1);
    expect(sendUserText).toHaveBeenCalledWith(
      "已完成任务审批（2/2）：\n- 已通过 OCV5-864\n- 已打回 OCV5-865：缺手机端截图\n补充说明：先推进 864",
    );
    expect(screen.getByTestId("task-approval-group-sent")).toHaveTextContent("已汇总发送全部审批结果");
  });

  test("一键全部通过：逐张真实调用 /api/board approve；部分失败时保留已完成项并提示失败", async () => {
    const tickets: Record<string, Ticket> = {
      "OCV5-901": makeTicket("OCV5-901", { status: "backlog", version: 1 }),
      "OCV5-902": makeTicket("OCV5-902", { status: "backlog", version: 2 }),
      "OCV5-903": makeTicket("OCV5-903", { status: "backlog", version: 4 }),
    };
    const getTicket = vi.fn(async (id: string) => tickets[id]!);
    const approve = vi.fn(async (id: string, version: number) => {
      if (id === "OCV5-902") {
        throw new ApiError({ status: 500, message: "server error", code: "internal" });
      }
      return {
        ticket: makeTicket(id, { status: "ready" as TicketStatus, version: version + 1 }),
      };
    });
    const sendUserText = vi.fn();

    renderGroup({
      ticketIds: ["OCV5-901", "OCV5-902", "OCV5-903"],
      actions: { taskApproval: { getTicket, approve, reject: vi.fn() } },
      sendUserText,
    });

    const approveAllBtn = await screen.findByTestId("task-approval-approve-all");
    await waitFor(() => expect(approveAllBtn).toBeEnabled());
    expect(approveAllBtn).toHaveTextContent("全部批准（3）");

    fireEvent.click(approveAllBtn);

    await waitFor(() => expect(approve).toHaveBeenCalledTimes(3));
    expect(approve).toHaveBeenNthCalledWith(1, "OCV5-901", 1);
    expect(approve).toHaveBeenNthCalledWith(2, "OCV5-902", 2);
    expect(approve).toHaveBeenNthCalledWith(3, "OCV5-903", 4);
    expect(sendUserText).not.toHaveBeenCalled();

    // 901 与 903 成功生效，902 失败并在底栏给出明确提示
    expect(await screen.findByText(/有 1 项审批未成功/)).toBeInTheDocument();
    expect(screen.getByTestId("task-approval-group-footer")).toHaveTextContent("已处理 2 / 3 项");

    // 即使有 1 项未处理，用户仍可主动发送当前已完成的审批结果，未处理项会被明确标出
    fireEvent.click(screen.getByTestId("task-approval-send-summary"));
    expect(sendUserText).toHaveBeenCalledTimes(1);
    expect(sendUserText).toHaveBeenCalledWith(
      "已完成任务审批（2/3）：\n- 已批准开工 OCV5-901\n- 暂未处理 OCV5-902\n- 已批准开工 OCV5-903",
    );
  });

  test("历史会话中全部卡片已处于非待审批态时，聚合底栏自动隐身", async () => {
    const getTicket = vi.fn(async (id: string) =>
      makeTicket(id, { status: "done" as TicketStatus, version: 10 }),
    );
    renderGroup({
      ticketIds: ["OCV5-701", "OCV5-702"],
      actions: { taskApproval: { getTicket, approve: vi.fn(), reject: vi.fn() } },
      sendUserText: vi.fn(),
    });
    await waitFor(() => expect(getTicket).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(screen.queryByTestId("task-approval-group-footer")).not.toBeInTheDocument();
    });
  });

  test("coalesceTaskApprovalGroups: 仅将连续 ≥2 张有效 present_task_approval 归组，单卡与不同分页不串组", () => {
    const mkTool = (
      id: string,
      ticketId: string,
      extra: Partial<ChatMessage> = {},
    ): { kind: "single"; m: ChatMessage } => ({
      kind: "single",
      m: {
        id,
        role: "tool",
        text: "审批",
        ts: 1_700_000_000_000,
        toolName: "mcp__openclaude-memory__present_task_approval",
        inputJson: { id: ticketId },
        _completed: true,
        ...extra,
      },
    });
    const userRow: { kind: "single"; m: ChatMessage } = {
      kind: "single",
      m: { id: "u1", role: "user", text: "hi", ts: 1_700_000_000_000 },
    };

    const items = [
      userRow,
      mkTool("t1", "OCV5-1"),
      mkTool("t2", "OCV5-2"),
      userRow,
      mkTool("t3", "OCV5-3"),
    ];
    const grouped = coalesceTaskApprovalGroups(items, (it) => it.m.id);
    expect(grouped).toHaveLength(4);
    expect(grouped[0]).toBe(userRow);
    expect(grouped[1]!.kind).toBe("approval-group");
    if (grouped[1]!.kind === "approval-group") {
      expect(grouped[1]!.ticketIds).toEqual(["OCV5-1", "OCV5-2"]);
      expect(grouped[1]!.key).toBe("approval-group:t1");
    }
    expect(grouped[2]).toBe(userRow);
    expect(grouped[3]!.kind).toBe("single");
  });

  test("formatTaskApprovalSummary: 相同单号去重并保留最新决策", () => {
    const text = formatTaskApprovalSummary([
      {
        key: "k1",
        order: 0,
        ticketId: "OCV5-864",
        identifier: "OCV5-864",
        loading: false,
        approvable: false,
        deciding: false,
        decision: { kind: "approve", summary: "已通过 OCV5-864" },
        alreadySettledExternally: false,
      },
      {
        key: "k2",
        order: 1,
        ticketId: "OCV5-864",
        identifier: "OCV5-864",
        loading: false,
        approvable: true,
        deciding: false,
        decision: null,
        alreadySettledExternally: false,
      },
      {
        key: "k3",
        order: 2,
        ticketId: "OCV5-865",
        identifier: "OCV5-865",
        loading: false,
        approvable: false,
        ticketStatus: "ready",
        ticketStatusLabel: "待执行",
        deciding: false,
        decision: null,
        alreadySettledExternally: true,
      },
    ]);
    expect(text).toBe("已完成任务审批（2/2）：\n- 已通过 OCV5-864\n- OCV5-865（已生效：待执行）");
  });

  test("端到端 MessageList：同回合两张 present_task_approval 自动聚组，逐张实时改单且底部一次发送", async () => {
    const tickets: Record<string, Ticket> = {
      "OCV5-864": makeTicket("OCV5-864", { status: "waiting_human", version: 4 }),
      "OCV5-865": makeTicket("OCV5-865", { status: "waiting_human", version: 7 }),
    };
    const getTicket = vi.fn(async (id: string) => tickets[id]!);
    const approve = vi.fn(async (id: string, version: number) => ({
      ticket: makeTicket(id, { status: "ready" as TicketStatus, version: version + 1 }),
    }));
    const sendUserText = vi.fn();
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", text: "请提交两张单据审批", ts: 1_700_000_000_000, status: "replied" },
      {
        id: "t1",
        role: "tool",
        text: "审批",
        ts: 1_700_000_000_100,
        _clientMessageId: "u1",
        toolName: "mcp__openclaude-memory__present_task_approval",
        inputJson: { id: "OCV5-864" },
        _completed: true,
        output: "ok",
      },
      {
        id: "t2",
        role: "tool",
        text: "审批",
        ts: 1_700_000_000_200,
        _clientMessageId: "u1",
        toolName: "ExecuteExtraTool",
        inputJson: {
          tool_name: "mcp__openclaude-memory__present_task_approval",
          params: { id: "OCV5-865" },
        },
        _completed: true,
        output: "ok",
      },
      {
        id: "a1",
        role: "assistant",
        text: "已为你贴出 OCV5-864 与 OCV5-865 两张审批卡。",
        ts: 1_700_000_000_300,
        _clientMessageId: "u1",
      },
    ];

    render(
      <ToolCardActionsContext.Provider value={{ taskApproval: { getTicket, approve, reject: vi.fn() } }}>
        <ChatInteractionContext.Provider value={{ sendUserText, busy: false }}>
          <MessageList
            processDisclosure
            messages={messages}
            sending={false}
            sessionId="sess-approval-batch"
            cb={{}}
            onRespondPermission={() => {}}
          />
        </ChatInteractionContext.Provider>
      </ToolCardActionsContext.Provider>,
    );

    const groupEl = await screen.findByTestId("task-approval-group");
    const answerEl = screen.getByText(/已为你贴出 OCV5-864 与 OCV5-865/);
    expect(Boolean(answerEl.compareDocumentPosition(groupEl) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

    const passButtons = await within(groupEl).findAllByRole("button", { name: "通过" });
    expect(passButtons).toHaveLength(2);
    await waitFor(() => {
      expect(passButtons[0]).toBeEnabled();
      expect(passButtons[1]).toBeEnabled();
    });

    // 点第一张：实时 approve，不立刻发消息，第二张仍可点
    fireEvent.click(passButtons[0]!);
    await waitFor(() => expect(approve).toHaveBeenCalledWith("OCV5-864", 4));
    expect(sendUserText).not.toHaveBeenCalled();
    expect(passButtons[1]).toBeEnabled();

    // 点第二张：实时 approve，仍不立刻发消息
    fireEvent.click(passButtons[1]!);
    await waitFor(() => expect(approve).toHaveBeenCalledWith("OCV5-865", 7));
    expect(sendUserText).not.toHaveBeenCalled();

    // 点击底部统一发送：合并为一条消息一次发出
    fireEvent.click(screen.getByTestId("task-approval-send-summary"));
    expect(sendUserText).toHaveBeenCalledTimes(1);
    expect(sendUserText).toHaveBeenCalledWith(
      "已完成任务审批（2/2）：\n- 已通过 OCV5-864\n- 已通过 OCV5-865",
    );
  });
});
