import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { TeamPanel } from "./TeamPanel";

afterEach(cleanup);

function member(id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: "agent-group", text: "", ts: 1000, _delegate: true, ...extra };
}

describe("TeamPanel 团队协作面板", () => {
  test("头部聚合且每个成员实时显示自己的绝对 token 快照", () => {
    const members = [
      member("a", {
        _delegateAgentId: "队员甲",
        _completed: false,
        _delegateUsageByRun: { "run-a": { totalTokens: 100 } },
      }),
      member("b", {
        _delegateAgentId: "队员乙",
        _completed: false,
        childBlocks: [{ kind: "final", meta: { totalTokens: 50 } }],
      }),
    ];
    const view = render(<TeamPanel members={members} sig="tokens-1" />);
    expect(screen.getByText("150")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("50")).toBeInTheDocument();

    const updated = [
      { ...members[0], _delegateUsageByRun: { "run-a": { totalTokens: 180 } } },
      members[1],
    ];
    view.rerender(<TeamPanel members={updated} sig="tokens-2" />);
    expect(screen.getByText("230")).toBeInTheDocument();
    expect(screen.getByText("180")).toBeInTheDocument();
    expect(screen.queryByText("150")).not.toBeInTheDocument();
  });

  test("头部显示队员数 + 运行中/完成/失败 概览;活跃默认展开队员", () => {
    const members = [
      member("a", { _delegateAgentId: "前端工程师", _delegateGoal: "做登录页", _completed: false }),
      member("b", { _delegateAgentId: "后端工程师", _delegateGoal: "写鉴权API", _completed: true }),
      member("c", { _delegateAgentId: "测试工程师", _delegateGoal: "写e2e", _completed: true, _isError: true }),
    ];
    render(<TeamPanel members={members} sig="x" />);
    expect(screen.getByText("团队协作 · 3 个智能体")).toBeInTheDocument();
    expect(screen.getByText(/1 运行中/)).toBeInTheDocument();
    expect(screen.getByText(/1 完成/)).toBeInTheDocument();
    expect(screen.getByText(/1 失败/)).toBeInTheDocument();
    // 有运行中 → 默认展开 → 队员名 + 任务可见
    expect(screen.getByText("前端工程师")).toBeInTheDocument();
    expect(screen.getByText("做登录页")).toBeInTheDocument();
    expect(screen.getByText("后端工程师")).toBeInTheDocument();
    const headerStatus = screen.getByText(/1 运行中/).parentElement;
    expect(headerStatus).toHaveClass("flex-wrap", "max-w-[55%]");
  });

  test("全完成默认收起;点头部展开队员", () => {
    const members = [
      member("a", { _delegateAgentId: "队员甲", _completed: true }),
      member("b", { _delegateAgentId: "队员乙", _completed: true }),
    ];
    render(<TeamPanel members={members} sig="y" />);
    expect(screen.queryByText("队员甲")).not.toBeInTheDocument(); // 收起
    fireEvent.click(screen.getByText("团队协作 · 2 个智能体"));
    expect(screen.getByText("队员甲")).toBeInTheDocument();
    expect(screen.getByText("队员乙")).toBeInTheDocument();
  });

  test("活跃→全完成:面板保持展开,不自动收起吞掉内容", () => {
    const running = [
      member("a", { _delegateAgentId: "甲", _completed: false }),
      member("b", { _delegateAgentId: "乙", _completed: true }),
    ];
    const { rerender } = render(<TeamPanel members={running} sig="s1" />);
    expect(screen.getByText("甲")).toBeInTheDocument(); // 活跃默认展开
    // 全部完成(同一面板实例就地完成)
    const done = [
      member("a", { _delegateAgentId: "甲", _completed: true }),
      member("b", { _delegateAgentId: "乙", _completed: true }),
    ];
    rerender(<TeamPanel members={done} sig="s2" />);
    expect(screen.getByText("甲")).toBeInTheDocument(); // 仍展开(曾活跃→不自动收起)
    expect(screen.getByText("乙")).toBeInTheDocument();
  });

  test("team fallback 的 Codex 原生 Agent 显示为临时 Codex 子智能体", () => {
    const members = [
      member("a", {
        _delegate: false,
        _completed: false,
        _agentGroupOrigin: "codex-collab",
        _teamFallback: true,
        text: "并行检查仓库",
      }),
      member("b", { _delegate: false, _completed: false, text: "普通临时任务" }),
    ];
    render(<TeamPanel members={members} sig="fallback" />);
    expect(screen.getByText("临时 Codex 子智能体 1")).toBeInTheDocument();
    expect(screen.getByText("临时子智能体 2")).toBeInTheDocument();
    expect(screen.queryByText("智能体 1")).not.toBeInTheDocument();
  });

  test("非 Codex origin 的无名 agent-group 使用中性临时子智能体兜底名", () => {
    const members = [
      member("a", { _delegate: false, _completed: false, text: "临时任务A" }),
      member("b", { _delegate: false, _completed: false, text: "临时任务B" }),
    ];
    render(<TeamPanel members={members} sig="neutral" />);
    expect(screen.getByText("临时子智能体 1")).toBeInTheDocument();
    expect(screen.getByText("临时子智能体 2")).toBeInTheDocument();
    expect(screen.queryByText("临时 Codex 子智能体 1")).not.toBeInTheDocument();
  });

  test("hidden-reviewer(管理 API 隐藏的系统 agent)显示映射名「质量审查员」而非裸 id", () => {
    const members = [
      member("a", { _delegateAgentId: "hidden-reviewer", _delegateGoal: "审查代码质量", _completed: false }),
      member("b", { _delegateAgentId: "coder", _delegateGoal: "写代码", _completed: false }),
    ];
    render(<TeamPanel members={members} sig="hr" />);
    expect(screen.getByText("质量审查员")).toBeInTheDocument();
    expect(screen.queryByText("hidden-reviewer")).not.toBeInTheDocument();
    // 非系统 agent 照常回退裸 id(用户级 id 本身可读)
    expect(screen.getByText("coder")).toBeInTheDocument();
  });

  test("单个队员的超长真实过程按批挂载且最终一条可达", () => {
    const childBlocks = Array.from({ length: 205 }, (_, index) => ({
      kind: "text" as const,
      text: `team-child-${index}`,
    }));
    render(
      <TeamPanel
        members={[
          member("a", { _delegateAgentId: "长任务队员", _completed: false, childBlocks }),
        ]}
        sig="long-process"
      />,
    );

    expect(screen.getByText("team-child-0")).toBeInTheDocument();
    expect(screen.queryByText("team-child-100")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /继续加载过程/ }));
    expect(screen.getByText("team-child-100")).toBeInTheDocument();
    expect(screen.queryByText("team-child-204")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /继续加载过程/ }));
    expect(screen.getByText("team-child-204")).toBeInTheDocument();
  });

  test("队员卡不显示冗余原始记录入口，真实过程仍可查看", () => {
    render(
      <TeamPanel
        members={[
          member("a", {
            _delegateAgentId: "长任务队员",
            _delegateGoal: "保留完整记录",
            _completed: true,
            childBlocks: [{ kind: "text", text: "真实队员过程" }],
          }),
        ]}
        sig="no-redundant-raw-record"
      />,
    );

    fireEvent.click(screen.getByText("团队协作 · 1 个智能体"));
    fireEvent.click(screen.getByText("长任务队员"));
    expect(screen.getByText("真实队员过程")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看原始完整记录" })).not.toBeInTheDocument();
  });

  test("服务端完整 transcript 的结果、计划与终态事件均不被丢弃", () => {
    const marker = "EXACT_CHILD_RESULT_FINAL_MARKER";
    const output = `${"r".repeat(140_000)}${marker}`;
    render(
      <TeamPanel
        members={[
          member("a", {
            _delegateAgentId: "完整过程队员",
            _completed: true,
            childBlocks: [
              {
                kind: "tool_result",
                toolName: "Read",
                toolUseBlockId: "child-read",
                preview: "short preview",
                output,
                isError: false,
              },
              { kind: "plan", steps: [{ step: "真实计划步骤", status: "pending" }] },
              { kind: "final", meta: { stopReason: "end_turn" } },
            ],
          }),
        ]}
        sig="raw-transcript-events"
      />,
    );

    fireEvent.click(screen.getByText("团队协作 · 1 个智能体"));
    fireEvent.click(screen.getByText("完整过程队员"));
    expect(screen.getByRole("button", { name: /Read · 原始结果/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /子智能体计划事件/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /子智能体终态事件/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Read · 原始结果/ }));
    expect(document.body.textContent).not.toContain(marker);
    fireEvent.click(screen.getByRole("button", { name: /继续显示原始事件/ }));
    expect(document.body.textContent).not.toContain(marker);
    fireEvent.click(screen.getByRole("button", { name: /继续显示原始事件/ }));
    expect(document.body.textContent).toContain(marker);
  });
});

describe("TeamPanel 审查裁决徽记 + per-delegate 成本(债C/债D)", () => {
  // 全完成默认收起 → 先点头部展开才能看到队员行徽记。
  function renderExpanded(members: ChatMessage[], props: Partial<{ delegateCosts: Record<string, string> }> = {}) {
    render(<TeamPanel members={members} sig="v" delegateCosts={props.delegateCosts} />);
    const header = screen.getByText(/团队协作 · \d+ 个智能体/);
    fireEvent.click(header);
  }

  test("审查员行 verdict=PASS → 渲染「质量审查员」+「PASS」通过徽记", () => {
    renderExpanded([
      member("a", { _delegateAgentId: "hidden-reviewer", _completed: true, _reviewVerdict: "PASS" }),
      member("b", { _delegateAgentId: "coder", _completed: true }),
    ]);
    expect(screen.getByText("质量审查员")).toBeInTheDocument();
    expect(screen.getByText("PASS")).toBeInTheDocument();
  });

  test("审查员行 verdict=NEEDS_FIX → 渲染「未通过」（即使执行态为完成）", () => {
    renderExpanded([
      member("a", {
        _delegateAgentId: "hidden-reviewer",
        _completed: true,
        _delegateStatus: "ok",
        _reviewVerdict: "NEEDS_FIX",
      }),
      member("b", { _delegateAgentId: "coder", _completed: true }),
    ]);
    // 执行成功(完成徽记)与裁决未通过并存 —— 二者正交。
    expect(screen.getByText("未通过")).toBeInTheDocument();
    // 两名队员均完成 → 多个「完成」执行态徽记;审查员行同时带「未通过」裁决徽记。
    expect(screen.getAllByText("完成").length).toBeGreaterThanOrEqual(1);
  });

  test("审查员行无裁决 → 不渲染裁决徽记（执行态徽记照常）", () => {
    renderExpanded([
      member("a", { _delegateAgentId: "hidden-reviewer", _completed: true }),
      member("b", { _delegateAgentId: "coder", _completed: true }),
    ]);
    expect(screen.queryByText("PASS")).not.toBeInTheDocument();
    expect(screen.queryByText("未通过")).not.toBeInTheDocument();
  });

  test("普通成员行误带 verdict → 不渲染裁决徽记（仅审查员行渲染）", () => {
    renderExpanded([
      member("a", { _delegateAgentId: "coder", _completed: true, _reviewVerdict: "PASS" }),
      member("b", { _delegateAgentId: "hidden-reviewer", _completed: true, _reviewVerdict: "NEEDS_FIX" }),
    ]);
    // 只有审查员的「未通过」出现；coder 的 PASS 被吞。
    expect(screen.getByText("未通过")).toBeInTheDocument();
    expect(screen.queryByText("PASS")).not.toBeInTheDocument();
  });

  test("delegateCosts 匹配 agentId → 队员行显示「N 积分」（千分位）", () => {
    renderExpanded(
      [
        member("a", { _delegateAgentId: "hidden-reviewer", _completed: true, _reviewVerdict: "PASS" }),
        member("b", { _delegateAgentId: "coding-assistant", _completed: true }),
      ],
      { delegateCosts: { "hidden-reviewer": "3", "coding-assistant": "12345" } },
    );
    expect(screen.getByText("3 积分")).toBeInTheDocument();
    const cost = screen.getByText("12,345 积分");
    expect(cost).toBeInTheDocument();
    expect(cost.parentElement).toHaveClass("flex-wrap", "max-w-[55%]");
  });
});
