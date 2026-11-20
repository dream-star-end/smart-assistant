import type { SwarmSnapshot } from "@openclaude/protocol/browser";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { InflightDelegateItem } from "../../lib/chat/inflightDelegates";
import type { ChatMessage } from "../../lib/chat/model";
import { PinnedHudStack } from "./PinnedHudStack";

afterEach(cleanup);

function makeSwarm(over: Partial<SwarmSnapshot> = {}): SwarmSnapshot {
  return {
    swarmId: "sw-1",
    title: "UI 统一重构",
    phase: "running",
    startedAt: Date.now() - 65_000,
    totalPosts: 8,
    members: [
      { name: "timeline-composer", role: "worker", status: "working", activity: "重构中" },
      { name: "verifier", role: "worker", status: "waiting" },
    ],
    posts: [
      { seq: 8, agent: "timeline-composer", text: "完成步骤时间线去双高亮", time: "05:55:00" },
    ],
    ...over,
  } as SwarmSnapshot;
}

function makeDelegate(over: Partial<InflightDelegateItem> = {}): InflightDelegateItem {
  return {
    jobId: "dlg-1",
    runId: "run-1",
    agentId: "coding-assistant",
    goal: "核验单测与构建",
    state: "running",
    liveHint: "vitest run",
    updatedAt: Date.now() - 12_000,
    parentSessionKey: "agent:main:webchat:dm:web-1",
    ...over,
  };
}

function makeTodoMsg(): ChatMessage {
  return {
    id: "todo-1",
    role: "tool",
    toolName: "TodoWrite",
    text: "TodoWrite",
    ts: 1000,
    inputJson: {
      todos: [
        { content: "设计 Token", status: "completed" },
        { content: "收敛胶囊", status: "in_progress", activeForm: "正在收敛胶囊" },
      ],
    },
  } as ChatMessage;
}

function makeGoalMsg(): ChatMessage {
  return {
    id: "goal-1",
    role: "goal",
    text: "交付 Phase 0+1 UI 改造",
    goalStatus: "active",
    ts: 1000,
    tokensUsed: 200,
    tokenBudget: 1000,
    timeUsedSeconds: 42,
  } as ChatMessage;
}

describe("PinnedHudStack — unified Live Agent capsule", () => {
  test("无活跃运行状态时不渲染任何胶囊", () => {
    const { container } = render(
      <PinnedHudStack
        timelineMessages={[]}
        chatVersion={1}
        wsSending={false}
        delegateItems={[]}
        onDismissDelegate={vi.fn()}
        latestSwarm={null}
        latestSwarmKey={null}
        dismissedSwarmKey={null}
        onOpenSwarmBoard={vi.fn()}
        onDismissSwarm={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("并发多条状态默认收敛为单一 Live Agent 胶囊，显示 +N 与一键看板动作，点击可展开详情", async () => {
    const onOpenSwarmBoard = vi.fn();
    const swarm = makeSwarm();
    render(
      <PinnedHudStack
        timelineMessages={[makeGoalMsg(), makeTodoMsg()]}
        chatVersion={1}
        wsSending
        delegateItems={[makeDelegate()]}
        onDismissDelegate={vi.fn()}
        onStopTurn={vi.fn()}
        latestSwarm={swarm}
        latestSwarmCardId="c-1"
        latestSwarmBlockId="b-1"
        latestSwarmKey="sw-1"
        dismissedSwarmKey={null}
        onOpenSwarmBoard={onOpenSwarmBoard}
        onDismissSwarm={vi.fn()}
      />,
    );

    const capsule = await screen.findByTestId("live-agent-capsule");
    expect(capsule).toHaveAttribute("data-primary-kind", "swarm");
    expect(capsule).toHaveAttribute("data-running", "true");
    expect(capsule).toHaveTextContent("UI 统一重构");
    expect(within(capsule).getByTestId("live-agent-capsule-dot")).toHaveAttribute("data-running", "true");
    expect(within(capsule).getByTestId("live-agent-capsule-more")).toHaveTextContent("+3");
    expect(within(capsule).getByTestId("live-agent-capsule-timer")).toBeInTheDocument();
    // 默认折叠，不叠罗汉渲染完整卡片栈
    expect(screen.queryByTestId("live-agent-expanded")).toBeNull();

    // 一键跳转蜂群看板
    fireEvent.click(screen.getByTestId("live-agent-capsule-action"));
    expect(onOpenSwarmBoard).toHaveBeenCalledWith({
      snapshot: swarm,
      cardId: "c-1",
      blockId: "b-1",
    });

    // 点击胶囊展开完整卡片栈，再点击收起
    const toggle = screen.getByTestId("live-agent-capsule-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("live-agent-expanded")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("live-agent-expanded")).toBeNull();
  });

  test("仅有任务清单时展示进度与正在执行的任务，无多余 +N 徽标", async () => {
    render(
      <PinnedHudStack
        timelineMessages={[makeTodoMsg()]}
        chatVersion={1}
        wsSending
        tokenUsage={{ totalTokens: 128 }}
        delegateItems={[]}
        onDismissDelegate={vi.fn()}
        latestSwarm={null}
        latestSwarmKey={null}
        dismissedSwarmKey={null}
        onOpenSwarmBoard={vi.fn()}
        onDismissSwarm={vi.fn()}
      />,
    );
    const capsule = await screen.findByTestId("live-agent-capsule");
    expect(capsule).toHaveAttribute("data-primary-kind", "task");
    expect(capsule).toHaveTextContent("任务 1/2");
    expect(capsule).toHaveTextContent("正在收敛胶囊");
    expect(within(capsule).getByTestId("live-agent-capsule-timer")).toHaveTextContent("128 tok");
    expect(screen.queryByTestId("live-agent-capsule-more")).toBeNull();
  });

  test("仅有后台任务时展示进行中计数与目标摘要", async () => {
    render(
      <PinnedHudStack
        timelineMessages={[]}
        chatVersion={1}
        wsSending={false}
        delegateItems={[makeDelegate()]}
        onDismissDelegate={vi.fn()}
        latestSwarm={null}
        latestSwarmKey={null}
        dismissedSwarmKey={null}
        onOpenSwarmBoard={vi.fn()}
        onDismissSwarm={vi.fn()}
      />,
    );
    const capsule = await screen.findByTestId("live-agent-capsule");
    expect(capsule).toHaveAttribute("data-primary-kind", "delegate");
    expect(capsule).toHaveAttribute("data-running", "true");
    expect(capsule).toHaveTextContent("后台 1 进行中");
    expect(capsule).toHaveTextContent("核验单测与构建");
  });
});
