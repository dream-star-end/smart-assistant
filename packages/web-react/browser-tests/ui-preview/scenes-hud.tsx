/**
 * HUD 场景（t-836 · 覆盖复查缺口 G-1/G-2）：输入框上方两枚常驻 HUD
 * —— 任务列表 PinnedTaskTracker 与后台子任务 PinnedDelegateTracker。
 *
 * 两枚 HUD 都不走 api（数据由 App 经 props 下发），场景直接喂 props；
 * 折叠态没有 props 可控（组件 3s 后自动折叠，截图 400ms 内截不到），
 * 由 <Collapsed> 在挂载后点一下头部切换按钮拿到折叠态。
 * 整页截图（不含 Dialog），底部挂真 Composer 还原「HUD 钉在输入框上方」的真实层叠。
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Composer } from "../../src/components/Composer";
import { PinnedDelegateTracker } from "../../src/components/chat/PinnedDelegateTracker";
import { PinnedTaskTracker, type TodoItem } from "../../src/components/chat/PinnedTaskTracker";
import type { InflightDelegateItem } from "../../src/lib/chat/inflightDelegates";
import type { Scene } from "./types";

const NOW = Date.now();

const TODOS: TodoItem[] = [
  { content: "读取 PinnedTaskTracker 与 PinnedDelegateTracker 现状", status: "completed" },
  { content: "新增 ui-preview 场景并出 before 截图", status: "completed" },
  {
    content: "逐条审计三态状态机、移动端占位、键盘与 aria 可达性",
    status: "in_progress",
    activeForm: "正在审计三态状态机与移动端占位",
  },
  { content: "修复 P1/P2 并补 vitest", status: "pending" },
  { content: "跑 typecheck / vitest / test:browser 并出 after 截图", status: "pending" },
];

const TODOS_LONG: TodoItem[] = [
  { content: "梳理 v5 个人版 web-react 全部路由与顶层面板", status: "completed" },
  { content: "对照 12 份审计文档生成覆盖矩阵", status: "completed" },
  { content: "核对 PLAYBOOK §8 归属表漏项（optionsGroup / mathDelimiters）", status: "completed" },
  {
    content:
      "把知识星球自动回复面板（KnowledgePlanetAutomationPanel，811 行，settings-A 与 manage-A 互相推让）单独立项，写清入口、归属与建议优先级",
    status: "in_progress",
    activeForm: "正在为知识星球自动回复面板补写入口、归属与优先级说明，这一行故意很长用来验证折行与截断",
  },
  { content: "评估 ?demo=1 离线演示模式是否仍在使用", status: "pending" },
  { content: "检查 PermissionCard 未决态审批交互是否有专项审计", status: "pending" },
  { content: "整理薄弱覆盖清单（MessageFeedbackDialog / taskApprovalCard / releaseCards）", status: "pending" },
  { content: "生成缺口清单并给出 P1/P2/P3 建议", status: "pending" },
  { content: "complete_task 提交交付物", status: "pending" },
  { content: "claim_next_task 领下一条", status: "pending" },
  { content: "raise_hand 待命", status: "pending" },
  { content: "zhimo_chat 挂起", status: "pending" },
];

function delegate(over: Partial<InflightDelegateItem> & { jobId: string }): InflightDelegateItem {
  return {
    runId: `run-${over.jobId}`,
    agentId: "coding-assistant",
    goal: "在 wt/hud 工作树里跑 web-react 全量 vitest 并汇总失败用例",
    state: "running",
    liveHint: "",
    updatedAt: NOW - 45_000,
    parentSessionKey: "agent:main:webchat:dm:preview",
    ...over,
  };
}

const DELEGATES_MIXED: InflightDelegateItem[] = [
  delegate({
    jobId: "job-run-1",
    liveHint: "Bash · npx vitest run src/components/chat --maxWorkers=1",
  }),
  delegate({
    jobId: "job-run-2",
    agentId: "hidden-reviewer",
    goal: "复核 PinnedDelegateTracker 的 aria 结构\n第二行不该出现在首行摘要里",
    liveHint: "Read PinnedDelegateTracker.tsx",
    updatedAt: NOW - 12_000,
  }),
  delegate({ jobId: "job-queued", agentId: "researcher", goal: "检索 WCAG 2.2 对折叠控件 aria-controls 的要求", state: "queued" }),
  delegate({
    jobId: "job-done",
    agentId: "coding-assistant",
    goal: "把 scenes-hud.tsx 接进 ui-preview 截图台",
    state: "completed",
    resultSummary: "已新增 7 个场景，desktop/mobile × light/dark 共 28 张，manifest failures 0",
    updatedAt: NOW - 90_000,
  }),
  delegate({
    jobId: "job-failed",
    agentId: "coding-assistant",
    goal: "在主克隆里直接改代码",
    state: "failed",
    resultSummary: "被 PLAYBOOK §1 拦下：主克隆只读，请在自己的 worktree 里改",
    updatedAt: NOW - 200_000,
  }),
];

const DELEGATES_TERMINAL: InflightDelegateItem[] = [
  delegate({
    jobId: "t-done-1",
    goal: "跑 typecheck",
    state: "completed",
    resultSummary: "tsc -b 通过（52s）",
    updatedAt: NOW - 30_000,
  }),
  delegate({
    jobId: "t-done-2",
    agentId: "hidden-reviewer",
    goal: "复核 docs/audit/hud.md 的 H-xx 编号连续性",
    state: "completed",
    resultSummary: "编号连续，P1/P2 均有处置",
    updatedAt: NOW - 60_000,
  }),
  delegate({
    jobId: "t-failed",
    agentId: "researcher",
    goal: "拉取 v5-dev 上的线上快照",
    state: "failed",
    resultSummary: "SSH 22 端口不可达（d-24：本轮全部本地做）",
    updatedAt: NOW - 120_000,
  }),
];

/** 挂载后点一下 HUD 头部切换按钮，得到折叠态（组件自身 3s 才自动折叠，截图等不到）。 */
function Collapsed({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const buttons = ref.current?.querySelectorAll<HTMLButtonElement>('button[aria-expanded="true"]');
    buttons?.forEach((b) => b.click());
  }, []);
  return <div ref={ref}>{children}</div>;
}

/** 还原工作区底部层叠：对话区（留白）→ HUD → Composer。 */
function HudStage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col bg-bg text-fg">
      <div className="min-h-0 flex-1 overflow-auto px-5 py-8">
        <div className="mx-auto max-w-3xl text-body text-muted">（对话区占位：HUD 钉在下方输入框上方，不随消息流滚走）</div>
      </div>
      <div className="shrink-0 pb-3">
        {children}
        <Composer onSend={() => {}} />
      </div>
    </div>
  );
}

const both: Scene["viewports"] = ["desktop", "mobile"];

export const hudScenes: Scene[] = [
  {
    id: "hud-task-expanded",
    label: "HUD · 任务列表 · 在飞展开（初始态）",
    group: "工作区",
    viewports: both,
    api: {},
    render: () => (
      <HudStage>
        <PinnedTaskTracker todos={TODOS} active tokenUsage={{ totalTokens: 12_480 }} />
      </HudStage>
    ),
  },
  {
    id: "hud-task-collapsed",
    label: "HUD · 任务列表 · 折叠成正在执行的一条",
    group: "工作区",
    viewports: both,
    api: {},
    render: () => (
      <HudStage>
        <Collapsed>
          <PinnedTaskTracker todos={TODOS} active tokenUsage={{ totalTokens: 12_480 }} />
        </Collapsed>
      </HudStage>
    ),
  },
  {
    id: "hud-task-long",
    label: "HUD · 任务列表 · 12 条长文案（滚动与折行）",
    group: "工作区",
    viewports: both,
    api: {},
    render: () => (
      <HudStage>
        <PinnedTaskTracker todos={TODOS_LONG} active tokenUsage={{ totalTokens: 1_284_000, estimated: true }} />
      </HudStage>
    ),
  },
  {
    id: "hud-task-refresh-pinned",
    label: "HUD · 任务列表 · 刷新后仍在飞（active=false / settled=false）",
    group: "工作区",
    viewports: both,
    api: {},
    render: () => (
      <HudStage>
        <PinnedTaskTracker todos={TODOS} active={false} settled={false} />
      </HudStage>
    ),
  },
  {
    id: "hud-delegate-running",
    label: "HUD · 后台任务 · 2 运行 + 1 排队 + 2 终态（展开）",
    group: "工作区",
    viewports: both,
    api: {},
    render: () => (
      <HudStage>
        <PinnedDelegateTracker items={DELEGATES_MIXED} onDismiss={() => {}} onStop={() => {}} />
      </HudStage>
    ),
  },
  {
    id: "hud-delegate-collapsed",
    label: "HUD · 后台任务 · 折叠成最近运行的一条",
    group: "工作区",
    viewports: both,
    api: {},
    render: () => (
      <HudStage>
        <Collapsed>
          <PinnedDelegateTracker items={DELEGATES_MIXED} onDismiss={() => {}} onStop={() => {}} />
        </Collapsed>
      </HudStage>
    ),
  },
  {
    id: "hud-delegate-terminal",
    label: "HUD · 后台任务 · 全部结束（2 成功 1 失败，展开）",
    group: "工作区",
    viewports: both,
    api: {},
    render: () => (
      <HudStage>
        <PinnedDelegateTracker items={DELEGATES_TERMINAL} onDismiss={() => {}} onStop={() => {}} />
      </HudStage>
    ),
  },
  {
    id: "hud-delegate-terminal-collapsed",
    label: "HUD · 后台任务 · 全部结束后折叠（头部还剩什么）",
    group: "工作区",
    viewports: both,
    api: {},
    render: () => (
      <HudStage>
        <Collapsed>
          <PinnedDelegateTracker items={DELEGATES_TERMINAL} onDismiss={() => {}} onStop={() => {}} />
        </Collapsed>
      </HudStage>
    ),
  },
  {
    id: "hud-stack",
    label: "HUD · 两枚 HUD 同时折叠叠在输入框上（真实层叠）",
    group: "工作区",
    viewports: both,
    api: {},
    render: () => (
      <HudStage>
        <Collapsed>
          <PinnedTaskTracker todos={TODOS} active tokenUsage={{ totalTokens: 12_480 }} />
          <PinnedDelegateTracker items={DELEGATES_MIXED} onDismiss={() => {}} onStop={() => {}} />
        </Collapsed>
      </HudStage>
    ),
  },
  {
    id: "hud-stack-expanded",
    label: "HUD · 两枚 HUD 同时展开叠在输入框上（最坏占位）",
    group: "工作区",
    viewports: both,
    api: {},
    render: () => (
      <HudStage>
        <PinnedTaskTracker todos={TODOS} active tokenUsage={{ totalTokens: 12_480 }} />
        <PinnedDelegateTracker items={DELEGATES_MIXED} onDismiss={() => {}} onStop={() => {}} />
      </HudStage>
    ),
  },
];
