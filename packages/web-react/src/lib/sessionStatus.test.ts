import { describe, expect, it } from "vitest";
import {
  clearTicketApprovalPendingCacheForTest,
  deriveLiveTerminalEndedAt,
  deriveLiveTerminalFromMessages,
  deriveSessionNeedsYou,
  isSidebarSessionRunning,
  recordTicketApprovalPending,
  syncTicketApprovalFromTicket,
  resolveSessionStatus,
  resolveSidebarDot,
  resolveSidebarDotLabel,
} from "./sessionStatus";

describe("resolveSessionStatus", () => {
  it("运行中优先于任何终态（本 tab 正在发送必须立刻闪绿）", () => {
    expect(
      resolveSessionStatus({
        running: true,
        lastOutcome: "crashed",
        lastErrorCode: "SERVICE_RESTART",
      }),
    ).toBe("running");
  });

  it("从未跑过 turn（lastOutcome 空）不显示点", () => {
    expect(resolveSessionStatus({ lastOutcome: null })).toBe("none");
    expect(resolveSessionStatus({})).toBe("none");
    expect(resolveSessionStatus({ lastOutcome: "" })).toBe("none");
  });

  it("正常结束：completed → completed，用户停止 interrupted → interrupted（都是绿点，文案不同）", () => {
    expect(resolveSessionStatus({ lastOutcome: "completed" })).toBe("completed");
    expect(resolveSessionStatus({ lastOutcome: "interrupted" })).toBe("interrupted");
    expect(resolveSessionStatus({ lastOutcome: "COMPLETED" })).toBe("completed");
  });

  it("异常结束：crashed / executed_error / not_accepted → error", () => {
    expect(resolveSessionStatus({ lastOutcome: "crashed" })).toBe("error");
    expect(resolveSessionStatus({ lastOutcome: "executed_error" })).toBe("error");
    expect(resolveSessionStatus({ lastOutcome: "not_accepted" })).toBe("error");
  });

  it("服务重启中断：归一化后 service_restart 标琥珀，即使 lastOutcome 是 crashed", () => {
    expect(resolveSessionStatus({ lastOutcome: "crashed", lastErrorCode: "SERVICE_RESTART" })).toBe(
      "service_restart",
    );
    expect(
      resolveSessionStatus({ lastOutcome: "executed_error", lastErrorCode: "service_restart" }),
    ).toBe("service_restart");
  });

  it("running=false 且非重启错误码时走 outcome", () => {
    expect(
      resolveSessionStatus({
        running: false,
        lastOutcome: "completed",
        lastErrorCode: "rate_limited",
      }),
    ).toBe("completed");
  });
});

describe("isSidebarSessionRunning", () => {
  it("本 tab isSending 优先于列表 idle", () => {
    expect(isSidebarSessionRunning({ id: "s1", runState: "idle" }, { isSending: () => true })).toBe(true);
  });

  it("runState=running 且没有本 tab 终态 → running", () => {
    expect(isSidebarSessionRunning({ id: "s1", runState: "running" })).toBe(true);
    expect(isSidebarSessionRunning({ id: "s1", runState: "running" }, { liveTerminal: () => undefined })).toBe(
      true,
    );
  });

  it("本 tab 已落入终态则不再当 running（即使列表仍 running）", () => {
    expect(
      isSidebarSessionRunning(
        { id: "s1", runState: "running" },
        { liveTerminal: () => ({ lastOutcome: "completed" }) },
      ),
    ).toBe(false);
  });

  it("idle 且未发送 → 非 running", () => {
    expect(isSidebarSessionRunning({ id: "s1", runState: "idle" })).toBe(false);
    expect(isSidebarSessionRunning({ id: "s1" })).toBe(false);
  });
});

describe("resolveSidebarDot", () => {
  it("运行中始终是闪烁蓝点，盖过未读与终态", () => {
    expect(resolveSidebarDot({ running: true, lastOutcome: "completed" }, true)).toBe("running");
  });

  it("异常结束是红点，已读也不消失", () => {
    expect(resolveSidebarDot({ lastOutcome: "crashed" }, false)).toBe("error");
    expect(resolveSidebarDot({ lastOutcome: "executed_error" }, true)).toBe("error");
    expect(resolveSidebarDot({ lastOutcome: "not_accepted" })).toBe("error");
  });

  it("service_restart 保持琥珀，不染红、不因已读消失", () => {
    expect(
      resolveSidebarDot({ lastOutcome: "crashed", lastErrorCode: "SERVICE_RESTART" }, false),
    ).toBe("service_restart");
    expect(
      resolveSidebarDot({ lastOutcome: "crashed", lastErrorCode: "SERVICE_RESTART" }, true),
    ).toBe("service_restart");
  });

  it("正常结束仅未读时出绿点，已读不显示", () => {
    expect(resolveSidebarDot({ lastOutcome: "completed" }, true)).toBe("unread");
    expect(resolveSidebarDot({ lastOutcome: "interrupted" }, true)).toBe("unread");
    expect(resolveSidebarDot({ lastOutcome: "completed" }, false)).toBe("none");
    expect(resolveSidebarDot({ lastOutcome: "interrupted" })).toBe("none");
  });
});

describe("deriveLiveTerminalFromMessages", () => {
  it("倒序取最近终态，跳过 turn_status 阶段提示", () => {
    expect(
      deriveLiveTerminalFromMessages([
        { _dispatchOutcome: "completed" },
        { _turnStatusRecord: true, _errorCode: "whatever" },
      ]),
    ).toEqual({ lastOutcome: "completed", lastErrorCode: null });
  });

  it("service_restart 错误码优先于 outcome 缺省", () => {
    expect(deriveLiveTerminalFromMessages([{ _errorCode: "SERVICE_RESTART" }])).toEqual({
      lastOutcome: "crashed",
      lastErrorCode: "SERVICE_RESTART",
    });
  });

  it("outbound.error 无 dispatchOutcome 时记 executed_error", () => {
    expect(deriveLiveTerminalFromMessages([{ _errorCode: "runner_crashed" }])).toEqual({
      lastOutcome: "executed_error",
      lastErrorCode: "runner_crashed",
    });
  });
});

// #1233: USER_CANCELLED is a terminal event, not a product failure.
describe("主动停止的实时与持久状态", () => {
  it.each(["USER_CANCELLED", "user_cancelled", "STOPPED", "stopped"])("%s 不把主动停止误判成执行失败", (code) => {
    const live = deriveLiveTerminalFromMessages([{ _errorCode: code }]);
    expect(live).toEqual({ lastOutcome: "interrupted", lastErrorCode: code });
    expect(resolveSessionStatus(live!)).toBe("stopped");
    for (const lastOutcome of ["interrupted", "executed_error", undefined]) {
      expect(resolveSidebarDot({ lastOutcome, lastErrorCode: code }, false)).toBe("stopped");
    }
    expect(resolveSessionStatus({ ...live!, running: true })).toBe("running");
  });
});

describe("deriveLiveTerminalEndedAt", () => {
  it("优先采用终态消息的 completedAt / ts，离线恢复时不把观察时刻当成结束时刻", () => {
    const end = Date.parse("2026-10-30T10:02:00Z");
    const observed = Date.parse("2026-10-30T11:00:00Z");
    expect(
      deriveLiveTerminalEndedAt(
        [{ ts: end - 60_000, completedAt: end, _dispatchOutcome: "completed" }],
        observed,
      ),
    ).toBe(end);
    expect(
      deriveLiveTerminalEndedAt([{ ts: end, _errorCode: "upstream" }], observed),
    ).toBe(end);
    expect(
      deriveLiveTerminalEndedAt([{ _dispatchOutcome: "completed" }], observed),
    ).toBe(observed);
  });
});


describe("needs_you 与 Q 版问号待接入判定 (OCV5-739)", () => {
  it("resolveSidebarDot: needsYou 优先于 running / unread / completed", () => {
    expect(resolveSidebarDot({ running: true, needsYou: "approval" }, true)).toBe("needs_you");
    expect(resolveSidebarDot({ running: false, lastOutcome: "completed", needsYou: "answer" }, true)).toBe(
      "needs_you",
    );
    expect(resolveSidebarDotLabel("needs_you", "approval")).toBe("等你批准");
    expect(resolveSidebarDotLabel("needs_you", "answer")).toBe("等你回答");
  });

  it("deriveSessionNeedsYou: ExecuteExtraTool / call_mcp_tool 包装的 present_task_approval 识别为 approval，用户回复或单据解决后消解", () => {
    clearTicketApprovalPendingCacheForTest();
    const sess = {
      messages: [
        { role: "user", text: "开始处理" },
        {
          role: "tool",
          toolName: "ExecuteExtraTool",
          inputJson: {
            tool_name: "mcp__openclaude-memory__present_task_approval",
            params: { id: "OCV5-738" },
          },
          _completed: true,
          output: JSON.stringify({ ok: true, kind: "task_approval", status: "presented" }),
        },
        { role: "assistant", text: "下面有 OCV5-738 的审批卡，请点一下批准开工。" },
      ],
    };
    expect(deriveSessionNeedsYou(sess)).toBe("approval");

    // 单据在看板被批准/处理后，无需发新消息也自动消解
    recordTicketApprovalPending("OCV5-738", false);
    expect(deriveSessionNeedsYou(sess)).toBeNull();

    // Antigravity call_mcp_tool PascalCase 包装
    clearTicketApprovalPendingCacheForTest();
    const agySess = {
      messages: [
        { role: "user", text: "继续" },
        {
          role: "tool",
          toolName: "call_mcp_tool",
          inputJson: {
            ServerName: "openclaude-memory",
            ToolName: "present_task_approval",
            Arguments: { id: "OCV5-739" },
          },
          _completed: true,
          output: "ok",
        },
      ],
    };
    expect(deriveSessionNeedsYou(agySess)).toBe("approval");

    // 用户回复新消息后立即消解
    expect(
      deriveSessionNeedsYou({
        messages: [...agySess.messages, { role: "user", text: "已批准开工 OCV5-739" }],
      }),
    ).toBeNull();

    // use_tool 的 tool_input / name 变体与看板单据状态同步（syncTicketApprovalFromTicket）
    clearTicketApprovalPendingCacheForTest();
    const useToolSess = {
      messages: [
        { role: "user", text: "继续" },
        {
          role: "tool",
          toolName: "mcp__gateway__use_tool",
          inputJson: {
            name: "mcp__openclaude-memory__present_task_approval",
            tool_input: { id: "OCV5-740" },
          },
          _completed: true,
          output: "ok",
        },
      ],
    };
    expect(deriveSessionNeedsYou(useToolSess)).toBe("approval");
    syncTicketApprovalFromTicket({ id: "uuid-740", identifier: "ocv5-740", status: "ready", version: 2 });
    expect(deriveSessionNeedsYou(useToolSess)).toBeNull();
    // 乱序晚到的旧版本 v1/backlog 响应不得把已批准状态覆盖回 pending
    syncTicketApprovalFromTicket({ id: "uuid-740", identifier: "OCV5-740", status: "backlog", version: 1 });
    expect(deriveSessionNeedsYou(useToolSess)).toBeNull();
    // 更高版本 v3/waiting_human 进入待验收时允许重新置为待批
    syncTicketApprovalFromTicket({ id: "uuid-740", identifier: "OCV5-740", status: "waiting_human", version: 3 });
    expect(deriveSessionNeedsYou(useToolSess)).toBe("approval");
  });

  it("deriveSessionNeedsYou: 末尾 options 选择卡、未决 permission 问答/权限卡、waiting_for_user 均正确区分 answer / approval，异常或停止轮不误报", () => {
    expect(
      deriveSessionNeedsYou({
        messages: [
          { role: "user", text: "帮我选方案" },
          {
            role: "assistant",
            text: "请选择：\n```options\n{\"question\":\"选哪个？\",\"options\":[{\"label\":\"A\"}]}\n```",
          },
        ],
      }),
    ).toBe("answer");

    expect(
      deriveSessionNeedsYou({
        messages: [
          { role: "user", text: "执行" },
          { role: "permission", toolName: "AskUserQuestion", _resolved: false },
        ],
      }),
    ).toBe("answer");

    expect(
      deriveSessionNeedsYou({
        messages: [
          { role: "user", text: "执行" },
          { role: "permission", toolName: "ExitPlanMode", _resolved: false },
        ],
      }),
    ).toBe("approval");

    expect(
      deriveSessionNeedsYou({
        _turnStatus: "waiting_for_user",
        messages: [{ role: "user", text: "等待中" }],
      }),
    ).toBe("answer");

    // 已停止或报错结束的轮次不再提示待回答
    expect(
      deriveSessionNeedsYou({
        messages: [
          { role: "user", text: "帮我选方案" },
          {
            role: "assistant",
            text: "```options\n{\"options\":[{\"label\":\"A\"}]}\n```",
            _errorCode: "USER_CANCELLED",
          },
        ],
      }),
    ).toBeNull();
  });
});
