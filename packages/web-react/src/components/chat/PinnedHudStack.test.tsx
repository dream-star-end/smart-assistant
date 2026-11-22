import type { SwarmSnapshot } from "@openclaude/protocol/browser";
import type { MediaGenerationJob } from "@openclaude/protocol/mediaGeneration";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { InflightDelegateItem } from "../../lib/chat/inflightDelegates";
import type { ChatMessage } from "../../lib/chat/model";
import type {
  SessionBgCommandItem,
  SessionCronItem,
  SessionMuseJobItem,
} from "../../lib/chat/sessionBackgroundTasks";
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

  test("已完成蜂群自动收起底部 HUD，不再与时间线内联卡片重复常驻（OCV5-831 #4）", () => {
    const completedSwarm = makeSwarm({
      phase: "completed",
      members: [
        { name: "coordinator", role: "coordinator", status: "waiting", stepCount: 4, unreadCount: 0 },
        { name: "worker-a", role: "worker", status: "killed", stepCount: 12, unreadCount: 0 },
      ],
    });
    const { container } = render(
      <PinnedHudStack
        timelineMessages={[]}
        chatVersion={1}
        wsSending={false}
        delegateItems={[]}
        onDismissDelegate={vi.fn()}
        latestSwarm={completedSwarm}
        latestSwarmKey="sw-1"
        dismissedSwarmKey={null}
        onOpenSwarmBoard={vi.fn()}
        onDismissSwarm={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("已完成蜂群与其他活态任务共存时，底部 HUD 仅展示活态任务而不占坑位（OCV5-831 #4）", async () => {
    const completedSwarm = makeSwarm({ phase: "completed" });
    render(
      <PinnedHudStack
        timelineMessages={[makeTodoMsg()]}
        chatVersion={1}
        wsSending
        delegateItems={[]}
        onDismissDelegate={vi.fn()}
        latestSwarm={completedSwarm}
        latestSwarmKey="sw-1"
        dismissedSwarmKey={null}
        onOpenSwarmBoard={vi.fn()}
        onDismissSwarm={vi.fn()}
      />,
    );
    const capsule = await screen.findByTestId("live-agent-capsule");
    expect(capsule).toHaveAttribute("data-primary-kind", "task");
    expect(screen.queryByTestId("live-agent-capsule-action")).toBeNull();
    expect(screen.queryByTestId("live-agent-capsule-more")).toBeNull();
  });

  test("超长蜂群标题强制单行省略且右侧按钮不可压缩，杜绝穿模爆框（OCV5-831 #1）", async () => {
    const longTitle = "Wave 1 并行交付：P0 止血 + PG/WS 性能攻坚 + 提效与合规加固";
    render(
      <PinnedHudStack
        timelineMessages={[]}
        chatVersion={1}
        wsSending
        delegateItems={[makeDelegate()]}
        onDismissDelegate={vi.fn()}
        latestSwarm={makeSwarm({ title: longTitle })}
        latestSwarmKey="sw-long"
        dismissedSwarmKey={null}
        onOpenSwarmBoard={vi.fn()}
        onDismissSwarm={vi.fn()}
      />,
    );
    const capsule = await screen.findByTestId("live-agent-capsule");
    expect(capsule.className).toContain("min-w-0");
    expect(capsule.className).toContain("max-w-full");
    expect(capsule.className).toContain("overflow-hidden");

    const toggle = within(capsule).getByTestId("live-agent-capsule-toggle");
    expect(toggle.className).toContain("min-w-0");
    expect(toggle.className).toContain("flex-1");
    expect(toggle.className).toContain("overflow-hidden");

    const titleEl = within(toggle).getByText(longTitle);
    expect(titleEl.className).toContain("min-w-0");
    expect(titleEl.className).toContain("flex-1");
    expect(titleEl.className).toContain("truncate");

    const action = within(capsule).getByTestId("live-agent-capsule-action");
    expect(action.className).toContain("shrink-0");
    expect(within(capsule).getByTestId("live-agent-capsule-more").className).toContain("shrink-0");
  });

  test("活跃后台命令优先级高于待触发定时续跑，单行胶囊显示 +1 并在展开面板支持终止/暂停/删除", async () => {
    const onCancelBgCommand = vi.fn(async () => true);
    const onToggleSessionCron = vi.fn(async () => true);
    const onDeleteSessionCron = vi.fn(async () => true);
    const bgCmd: SessionBgCommandItem = {
      id: "99-ocb_1",
      jobId: "ocb_1",
      commandPreview: "pytest -q tests/e2e",
      cwd: "/app",
      startedAt: Date.now() - 45_000,
      updatedAt: Date.now() - 1_000,
    };
    const cron: SessionCronItem = {
      id: "cron-1",
      name: "巡检部署状态",
      enabled: true,
      schedule: "*/15 * * * *",
      nextRunAt: Date.now() + 12 * 60_000,
      resume: "origin-session",
      sourceSessionKey: "agent:main:webchat:dm:s1",
    };

    render(
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
        bgCommands={[bgCmd]}
        sessionCrons={[cron]}
        onCancelBgCommand={onCancelBgCommand}
        onToggleSessionCron={onToggleSessionCron}
        onDeleteSessionCron={onDeleteSessionCron}
      />,
    );

    const capsule = await screen.findByTestId("live-agent-capsule");
    expect(capsule).toHaveAttribute("data-primary-kind", "bg_cmd");
    expect(capsule).toHaveAttribute("data-running", "true");
    expect(capsule).toHaveTextContent("后台命令");
    expect(capsule).toHaveTextContent("pytest -q tests/e2e");
    expect(within(capsule).getByTestId("live-agent-capsule-more")).toHaveTextContent("+1");

    // 展开面板展示后台命令与定时续跑并可执行行内干预
    fireEvent.click(screen.getByTestId("live-agent-capsule-toggle"));
    const panel = screen.getByTestId("pinned-background-tasks-panel");
    expect(within(panel).getByText("12 分钟后")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "终止后台命令：pytest -q tests/e2e" }));
    });
    expect(onCancelBgCommand).toHaveBeenCalledWith("99-ocb_1");

    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "暂停定时续跑：巡检部署状态" }));
    });
    expect(onToggleSessionCron).toHaveBeenCalledWith("cron-1", false);

    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "删除定时续跑：巡检部署状态" }));
    });
    expect(onDeleteSessionCron).toHaveBeenCalledWith("cron-1");
  });

  test("异步媒体（Muse + H3）与仅定时续跑场景正确渲染单行胶囊及展开操作", async () => {
    const onCancelMuseJob = vi.fn(async () => true);
    const onDismissMuseJob = vi.fn();
    const museQueued: SessionMuseJobItem = {
      id: "muse-q1",
      kind: "video",
      status: "queued",
      promptPreview: "雪山日出无人机航拍",
      queuePosition: 2,
      queueLength: 5,
      queuedAt: Date.now() - 8_000,
    };
    const h3Done: MediaGenerationJob = {
      id: "h3-done",
      requestId: "r-1",
      kind: "h3_generate",
      resourceClass: "gpu-h3",
      status: "completed",
      phase: "completed",
      prompt: "水墨山水转场",
      sessionId: "s1",
      createdAt: new Date(Date.now() - 30_000).toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const view = render(
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
        museJobs={[museQueued]}
        mediaJobs={[h3Done]}
        onCancelMuseJob={onCancelMuseJob}
        onDismissMuseJob={onDismissMuseJob}
      />,
    );

    const capsule = await screen.findByTestId("live-agent-capsule");
    expect(capsule).toHaveAttribute("data-primary-kind", "media");
    expect(capsule).toHaveAttribute("data-running", "true");
    expect(capsule).toHaveTextContent("排队第 2 位");
    expect(capsule).toHaveTextContent("雪山日出无人机航拍");

    fireEvent.click(screen.getByTestId("live-agent-capsule-toggle"));
    const panel = screen.getByTestId("pinned-background-tasks-panel");
    expect(within(panel).getByText("排队第 2/5 位")).toBeInTheDocument();
    expect(within(panel).getByText("已完成")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "取消媒体任务：雪山日出无人机航拍" }));
    });
    expect(onCancelMuseJob).toHaveBeenCalledWith("muse-q1");

    fireEvent.click(within(panel).getByRole("button", { name: "知道了" }));
    expect(onDismissMuseJob).toHaveBeenCalledWith("h3-done");

    // 仅剩定时续跑时展示 schedule 胶囊与倒计时
    view.rerender(
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
        sessionCrons={[
          {
            id: "c-only",
            name: "晚间总结提醒",
            enabled: true,
            schedule: "0 20 * * *",
            nextRunAt: Date.now() + 25 * 60_000,
            resume: "origin-session",
            sourceSessionKey: "agent:main:webchat:dm:s1",
          },
        ]}
      />,
    );
    const schedCapsule = await screen.findByTestId("live-agent-capsule");
    expect(schedCapsule).toHaveAttribute("data-primary-kind", "schedule");
    expect(schedCapsule).toHaveAttribute("data-running", "false");
    expect(schedCapsule).toHaveTextContent("定时续跑");
    expect(schedCapsule).toHaveTextContent("晚间总结提醒");
    expect(within(schedCapsule).getByTestId("live-agent-capsule-timer")).toHaveTextContent("25 分钟后");
  });
});
