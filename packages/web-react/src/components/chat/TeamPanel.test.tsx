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
});
