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
import { AUTO_DISMISS_SUCCEEDED_MS } from "./PinnedBackgroundTasksPanel";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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
    // OCV5-850: 底部胶囊以自身边框慢呼吸承载运行态，不再在图标左侧叠加闪烁红点或图标光晕
    expect(within(capsule).queryByTestId("live-agent-capsule-dot")).toBeNull();
    expect(capsule.querySelector(".oc-alive-dot")).toBeNull();
    expect(capsule.querySelector(".oc-breathe-aura")).toBeNull();
    // goal 已收敛至 Composer 单入口，不再占 HUD +N 计数（仅 delegate + task = +2）
    expect(within(capsule).getByTestId("live-agent-capsule-more")).toHaveTextContent("+2");
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
    expect(screen.queryByTestId("pinned-goal")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("live-agent-expanded")).toBeNull();
  });

  test("仅有会话目标消息时 HUD 不渲染重复胶囊（统一由 Composer goal chip 承载）", () => {
    const { container } = render(
      <PinnedHudStack
        timelineMessages={[makeGoalMsg()]}
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

  test("仅有任务清单时展示进度与正在执行的任务，隐藏裸 tok 计数且无多余 +N 徽标", async () => {
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
    expect(within(capsule).queryByTestId("live-agent-capsule-timer")).toBeNull();
    expect(capsule).not.toHaveTextContent(/tok/i);
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

  test("当前回合运行中（wsSending=true）时不重复弹出后台命令胶囊（P0-2）", () => {
    const bgCmd: SessionBgCommandItem = {
      id: "99-ocb_1",
      jobId: "ocb_1",
      commandPreview: 'HOST_WT="/var/lib/docker/volumes/oc-v5/_data" pytest -q tests/e2e',
      cwd: "/var/lib/docker/app",
      startedAt: Date.now() - 45_000,
      updatedAt: Date.now() - 1_000,
    };
    const { container } = render(
      <PinnedHudStack
        timelineMessages={[]}
        chatVersion={1}
        wsSending={true}
        delegateItems={[]}
        onDismissDelegate={vi.fn()}
        latestSwarm={null}
        latestSwarmKey={null}
        dismissedSwarmKey={null}
        onOpenSwarmBoard={vi.fn()}
        onDismissSwarm={vi.fn()}
        bgCommands={[bgCmd]}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("独立残留后台任务隐藏原始 Shell/路径/jobId，主视图展示人话摘要且明细收入「技术详情」", async () => {
    const onCancelBgCommand = vi.fn(async () => true);
    const onToggleSessionCron = vi.fn(async () => true);
    const onDeleteSessionCron = vi.fn(async () => true);
    const bgCmd: SessionBgCommandItem = {
      id: "99-ocb_1",
      jobId: "ocb_1",
      commandPreview: 'HOST_WT="/var/lib/docker/volumes/oc-v5/_data" pytest -q tests/e2e',
      cwd: "/var/lib/docker/app",
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
    expect(capsule).toHaveTextContent("后台任务运行中");
    expect(capsule).toHaveTextContent("测试任务");
    expect(capsule).not.toHaveTextContent("HOST_WT");
    expect(capsule).not.toHaveTextContent("/var/lib/docker");
    expect(capsule).not.toHaveTextContent("ocb_1");
    expect(within(capsule).getByTestId("live-agent-capsule-more")).toHaveTextContent("+1");

    // 展开面板主视图仅展示人话摘要，默认不暴露原始命令、cwd 与 jobId
    fireEvent.click(screen.getByTestId("live-agent-capsule-toggle"));
    const panel = screen.getByTestId("pinned-background-tasks-panel");
    expect(within(panel).getByText("12 分钟后")).toBeInTheDocument();
    expect(within(panel).getByText("测试任务")).toBeInTheDocument();
    expect(within(panel).queryByText(/HOST_WT/)).toBeNull();
    expect(within(panel).queryByText(/\/var\/lib\/docker\/app/)).toBeNull();
    expect(within(panel).queryByText(/ocb_1/)).toBeNull();

    // 按需展开「技术详情」后可查看命令、目录与编号
    const detailsToggle = within(panel).getByTestId("bg-cmd-details-toggle-99-ocb_1");
    expect(detailsToggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(detailsToggle);
    expect(detailsToggle).toHaveAttribute("aria-expanded", "true");
    const details = within(panel).getByTestId("bg-cmd-details-99-ocb_1");
    expect(details).toHaveTextContent('HOST_WT="/var/lib/docker/volumes/oc-v5/_data" pytest -q tests/e2e');
    expect(details).toHaveTextContent("/var/lib/docker/app");
    expect(details).toHaveTextContent("ocb_1");

    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "终止后台任务：测试任务" }));
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

  test("异步媒体：失败错误码翻译为人话并保留「知道了」，成功终态不强迫点击且几秒后自动收起", async () => {
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
    const museFailed: SessionMuseJobItem = {
      id: "muse-f1",
      kind: "image",
      status: "failed",
      promptPreview: "赛博朋克夜景",
      queuedAt: Date.now() - 12_000,
      errorCode: "H3_OOM",
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
        museJobs={[museQueued, museFailed]}
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
    // 裸 H3_OOM 被翻译为人话，不暴露内部 errorCode
    expect(within(panel).queryByText("H3_OOM")).toBeNull();
    expect(within(panel).getByText("资源不足，请缩短时长或降低分辨率后重试")).toBeInTheDocument();
    // 成功项不强制显示「知道了」，仅失败项有「知道了」按钮
    const ackButtons = within(panel).getAllByRole("button", { name: "知道了" });
    expect(ackButtons).toHaveLength(1);

    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "取消媒体任务：雪山日出无人机航拍" }));
    });
    expect(onCancelMuseJob).toHaveBeenCalledWith("muse-q1");

    fireEvent.click(ackButtons[0]!);
    expect(onDismissMuseJob).toHaveBeenCalledWith("muse-f1");

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

  test("成功终态的后台子任务与媒体任务无需点「知道了」，几秒后静默自动隐藏", async () => {
    const onDismissDelegate = vi.fn();
    const onDismissMuseJob = vi.fn();
    const doneDelegate = makeDelegate({ jobId: "dlg-done", state: "completed", resultSummary: "已整理完毕" });
    const doneMuse: SessionMuseJobItem = {
      id: "muse-done",
      kind: "image",
      status: "succeeded",
      promptPreview: "晨雾山谷",
      queuedAt: Date.now() - 10_000,
    };

    const { container } = render(
      <PinnedHudStack
        timelineMessages={[]}
        chatVersion={1}
        wsSending={false}
        delegateItems={[doneDelegate]}
        onDismissDelegate={onDismissDelegate}
        museJobs={[doneMuse]}
        onDismissMuseJob={onDismissMuseJob}
        latestSwarm={null}
        latestSwarmKey={null}
        dismissedSwarmKey={null}
        onOpenSwarmBoard={vi.fn()}
        onDismissSwarm={vi.fn()}
      />,
    );

    // 先等 lazy chunk 加载完成
    await screen.findByTestId("live-agent-capsule");
    vi.useFakeTimers();
    // 重新挂载进入假时钟窗口验证自动静默收起
    cleanup();
    const view2 = render(
      <PinnedHudStack
        timelineMessages={[]}
        chatVersion={1}
        wsSending={false}
        delegateItems={[doneDelegate]}
        onDismissDelegate={onDismissDelegate}
        museJobs={[doneMuse]}
        onDismissMuseJob={onDismissMuseJob}
        latestSwarm={null}
        latestSwarmKey={null}
        dismissedSwarmKey={null}
        onOpenSwarmBoard={vi.fn()}
        onDismissSwarm={vi.fn()}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("live-agent-capsule")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(AUTO_DISMISS_SUCCEEDED_MS + 50);
    });
    expect(onDismissDelegate).toHaveBeenCalledWith("dlg-done");
    expect(onDismissMuseJob).toHaveBeenCalledWith("muse-done");
    expect(view2.container.querySelector('[data-testid="live-agent-capsule"]')).toBeNull();
    void container;
  });
});
