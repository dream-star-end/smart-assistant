/**
 * 对话内任务审批卡:用户点击必须打同一套 /api/board 人闸门,而不是发一句「我选择」。
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../lib/api";
import type { Ticket, TicketStatus } from "../../lib/taskboard";
import {
  ChatInteractionContext,
  ToolCardActionsContext,
  type ToolCardActions,
} from "./context";
import { TaskApprovalCard } from "./taskApprovalCard";

afterEach(cleanup);

function sampleTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "t1",
    identifier: "OCV5-42",
    projectId: "p1",
    type: "bug",
    title: "登录 500",
    body: "复现:打开登录页",
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
    version: 6,
    blockedReason: null,
    stageLoopCount: 0,
    createdAt: 1,
    updatedAt: 2,
    closedAt: null,
    ...overrides,
  };
}

async function clickWhenEnabled(name: string | RegExp): Promise<HTMLElement> {
  const btn = await screen.findByRole("button", { name });
  await waitFor(() => expect(btn).toBeEnabled());
  fireEvent.click(btn);
  return btn;
}

function renderCard(opts: {
  actions?: ToolCardActions;
  sendUserText?: (t: string) => void;
  id?: string;
  prompt?: string;
  busy?: boolean;
}) {
  return render(
    <ToolCardActionsContext.Provider value={opts.actions ?? {}}>
      <ChatInteractionContext.Provider
        value={{ sendUserText: opts.sendUserText, busy: opts.busy }}
      >
        <TaskApprovalCard id={opts.id ?? "OCV5-42"} prompt={opts.prompt} />
      </ChatInteractionContext.Provider>
    </ToolCardActionsContext.Provider>,
  );
}

describe("TaskApprovalCard", () => {
  test("waiting_human 点通过:POST approve 用用户身份,并发送续跑消息", async () => {
    const waiting = sampleTicket();
    const passed = sampleTicket({ status: "ready" as TicketStatus, version: 7 });
    const getTicket = vi.fn().mockResolvedValue(waiting);
    const approve = vi.fn().mockResolvedValue({ ticket: passed });
    const reject = vi.fn();
    const sendUserText = vi.fn();
    renderCard({
      actions: { taskApproval: { getTicket, approve, reject } },
      sendUserText,
    });
    expect(await screen.findByText("OCV5-42 · 问题单 · P1")).toBeInTheDocument();
    expect(screen.getByText("登录 500")).toBeInTheDocument();
    await clickWhenEnabled("通过");
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    expect(approve).toHaveBeenCalledWith("OCV5-42", 6);
    expect(reject).not.toHaveBeenCalled();
    expect(sendUserText).toHaveBeenCalledWith("已通过 OCV5-42");
    expect(await screen.findByText("已在对话中确认")).toBeInTheDocument();
  });

  test("打回必须填写理由后才 POST reject", async () => {
    const waiting = sampleTicket();
    const rejected = sampleTicket({ status: "ready" as TicketStatus, version: 7 });
    const getTicket = vi.fn().mockResolvedValue(waiting);
    const approve = vi.fn();
    const reject = vi.fn().mockResolvedValue({ ticket: rejected });
    const sendUserText = vi.fn();
    renderCard({ actions: { taskApproval: { getTicket, approve, reject } }, sendUserText });
    await clickWhenEnabled("打回");
    expect(reject).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText("打回理由（必填）"), {
      target: { value: "缺回归证据" },
    });
    await clickWhenEnabled("确认打回");
    await waitFor(() => expect(reject).toHaveBeenCalledTimes(1));
    expect(reject).toHaveBeenCalledWith("OCV5-42", 6, "缺回归证据");
    expect(approve).not.toHaveBeenCalled();
    expect(sendUserText).toHaveBeenCalledWith("已打回 OCV5-42：缺回归证据");
  });

  test("backlog 点批准开工走 approve,不打 /done", async () => {
    const backlog = sampleTicket({ status: "backlog", version: 1, title: "新需求" });
    const ready = sampleTicket({ status: "ready", version: 2, title: "新需求" });
    const getTicket = vi.fn().mockResolvedValue(backlog);
    const approve = vi.fn().mockResolvedValue({ ticket: ready });
    renderCard({
      actions: { taskApproval: { getTicket, approve, reject: vi.fn() } },
      sendUserText: vi.fn(),
    });
    await clickWhenEnabled("批准开工");
    await waitFor(() => expect(approve).toHaveBeenCalledWith("OCV5-42", 1));
    expect(screen.queryByRole("button", { name: "打回" })).not.toBeInTheDocument();
  });

  test("409 版本冲突:重读后再 approve 一次", async () => {
    const waiting = sampleTicket({ version: 6 });
    const refreshed = sampleTicket({ version: 8 });
    const passed = sampleTicket({ status: "ready", version: 9 });
    const getTicket = vi.fn().mockResolvedValueOnce(waiting).mockResolvedValueOnce(refreshed);
    const approve = vi
      .fn()
      .mockRejectedValueOnce(new ApiError({ status: 409, message: "conflict", code: "version_conflict" }))
      .mockResolvedValueOnce({ ticket: passed });
    renderCard({
      actions: { taskApproval: { getTicket, approve, reject: vi.fn() } },
      sendUserText: vi.fn(),
    });
    await clickWhenEnabled("通过");
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(2));
    expect(approve).toHaveBeenNthCalledWith(1, "OCV5-42", 6);
    expect(approve).toHaveBeenNthCalledWith(2, "OCV5-42", 8);
    expect(getTicket).toHaveBeenCalledTimes(2);
  });

  test("无 taskApproval 注入:不拉取、无操作按钮", () => {
    renderCard({ actions: {} });
    expect(screen.getByText(/请打开任务面板处理/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "通过" })).not.toBeInTheDocument();
  });

  test("GET 失败:展示错误且批准按钮禁用", async () => {
    const getTicket = vi.fn().mockRejectedValue(new ApiError({ status: 404, message: "nope", code: "not_found" }));
    renderCard({
      actions: { taskApproval: { getTicket, approve: vi.fn(), reject: vi.fn() } },
    });
    expect(await screen.findByText("加载任务单失败")).toBeInTheDocument();
    expect(screen.getByText("无法核验")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "通过" })).not.toBeInTheDocument();
  });
});
