/**
 * 展开后的过程时间轴(人话步骤、技术详情、组摘要)。
 * 收起时的外壳总览留在 ProcessDisclosure,首屏同步渲染。
 * 这一块只在外壳打开后才需要,按需加载,不进 index.html 的静态闭包
 * (first-screen-budget)。
 */
import {
  Bot,
  Brain,
  ChevronRight,
  Circle,
  FileText,
  ListChecks,
  ListTodo,
  type LucideIcon,
  MessageCircleQuestion,
  Pencil,
  Search,
  ShieldCheck,
  Target,
  Terminal,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { isServerAuthoredRow, type ChatMessage } from "../../lib/chat/model";
import { agentTerminalStatus } from "../../lib/chat/render";
import type { CardCallbacks } from "./cards";
import type { DisplayTokenUsage } from "./tokenUsage";
import {
  FirstTextPaintCommitProbe,
  ProcessStepContext,
  ProgressiveMarkdown,
  RecoveredStepContext,
  StepMetaBadge,
  StepTimingContext,
  combineStepTimings,
  countLabel,
  delegateTitle,
  formatElapsed,
  formatStepDuration,
  hasErrorMark,
  humanStepTitle,
  isClearedGoalRecord,
  isErroredAssistant,
  normalizeToolForDisplay,
  rawAuditCommand,
  resolveToolMeta,
  resolveToolStatus,
  stripShellWrapperForDisplay,
  timelineMessageKey,
  toolStillRunning,
  workKind,
  workSummary,
  type PhaseKind,
  type ProcessSection,
  type ToolInput,
} from "./ProcessDisclosure";
import { buildPhaseTimeline, classifyMessagePhase } from "./phaseTimeline";
import { PhaseGroupHeader, PhaseTimelineFilterBar } from "./PhaseTimelineSummary";

function isDelegateRow(message: ChatMessage): boolean {
  return message.role === "agent-group" || message.role === "delegate-progress";
}

function delegateState(rows: readonly ChatMessage[]): { label: string; running: boolean } {
  if (rows.some((message) => !message._completed && !isServerAuthoredRow(message))) return { label: "进行中", running: true };
  const states = rows.map((message) => agentTerminalStatus(message));
  return { label: (states.find((state) => state.tone === "danger") ?? states.find((state) => state.tone === "warning") ?? states[0])?.label ?? "完成", running: false };
}

/** 一段步骤的摘要行:有事说事;只有思考 / 准备工作时直说。 */
function groupSummary(messages: readonly ChatMessage[]): string {
  const said = workSummary(messages);
  if (said) return said;
  const thoughts = messages.filter((message) => message.role === "thinking").length;
  if (thoughts) return thoughts > 1 ? `思考 ${thoughts} 次` : "思考";
  const prep = messages.filter((message) => workKind(message) === "prep").length;
  return prep ? `准备工作 ${prep} 步` : "执行记录";
}

// ── OCV5-831 步骤行人类可读副摘要提取（优先 toolSummary / id / query / 短路径 / 安全命令头）──
const SAFE_CLI_WITH_SUB = new Set(["git", "pnpm", "npm", "yarn", "cargo", "docker", "kubectl", "gh", "npx"]);
const SAFE_CLI_HEAD = new Set([
  ...SAFE_CLI_WITH_SUB,
  "vitest", "jest", "tsc", "vite", "pytest", "go", "curl", "rg", "grep", "find", "ls",
  "node", "tsx", "python", "python3", "make", "ssh", "rsync",
]);
const TASK_OPS = new Set([
  "task_comment", "task_update", "task_get", "task_create", "task_approve", "present_task_approval",
]);
const TICKET_ID_RE = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
const INTERNAL_SUMMARY_RE = /\/(?:home|opt|root|usr)\/|HOME=|You are |subagentType/i;

function normalizeSingleUnderscoreMcp(name: string): string {
  if (name.startsWith("mcp__")) return name;
  const m = /^mcp_([a-z0-9]+-[a-z0-9-]+)_(.+)$/i.exec(name);
  return m ? `mcp__${m[1]}__${m[2]}` : name;
}

function mcpOpName(name: string): string {
  const norm = normalizeSingleUnderscoreMcp(name);
  if (norm.startsWith("mcp__")) {
    const rest = norm.slice(5);
    const sep = rest.indexOf("__");
    return (sep >= 0 ? rest.slice(sep + 2) : rest).toLowerCase();
  }
  return norm.toLowerCase();
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function effectiveArgs(input: ToolInput, rawMessage: ChatMessage): Record<string, unknown> | null {
  const raw = parseRecord(rawMessage.inputJson) ?? parseRecord(rawMessage.inputPreview);
  const base = parseRecord(input);
  const merged = raw && base ? { ...raw, ...base } : (base ?? raw);
  if (!merged) return null;
  const nested =
    parseRecord(merged.Arguments) ??
    parseRecord(merged.arguments) ??
    parseRecord(merged.params) ??
    parseRecord(merged.tool_input) ??
    parseRecord(merged.toolInput);
  return nested ? { ...merged, ...nested } : merged;
}

function cleanOneLine(value: unknown, max = 44): string {
  if (typeof value !== "string") return "";
  const s = value.replace(/\s+/g, " ").trim();
  if (!s || s.startsWith("{") || s.startsWith("[") || INTERNAL_SUMMARY_RE.test(s)) return "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function isRedundantSubtitle(candidate: string, title: string): boolean {
  const c = candidate.trim();
  return !c || title === c || title.includes(c);
}

function extractCommandHead(command: string, allowUnknownBin: boolean): string {
  const unwrapped = stripShellWrapperForDisplay(command);
  const firstLine = unwrapped.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  if (!firstLine) return "";
  let rest = firstLine.replace(/^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*)+/, "");
  while (/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/.test(rest)) {
    rest = rest.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/, "");
  }
  const segment = rest.split(/[;&|<>]/)[0]?.trim() ?? "";
  const tokens = segment.split(/\s+/).filter(Boolean);
  const rawBin = (tokens[0] ?? "").replace(/^['"]|['"]$/g, "");
  const bin = rawBin.split("/").pop() ?? "";
  if (!bin || !/^[A-Za-z0-9._-]{1,28}$/.test(bin)) return "";
  const lower = bin.toLowerCase();
  if (SAFE_CLI_WITH_SUB.has(lower)) {
    const sub = (tokens[1] ?? "").replace(/^['"]|['"]$/g, "");
    if (sub && /^[A-Za-z0-9:_-]{1,24}$/.test(sub) && !sub.startsWith("-")) {
      return `${bin} ${sub}`;
    }
    return bin;
  }
  if (SAFE_CLI_HEAD.has(lower)) return bin;
  if (allowUnknownBin && lower !== "echo" && lower !== "printf" && !bin.startsWith("-")) return bin;
  return "";
}

/** 提取步骤行轻量副摘要：优先 toolSummary，次选任务单 ID / 检索词 / 短文件名 / 安全命令首词。 */
export function extractStepSubtitle(
  name: string,
  input: ToolInput,
  title: string,
  rawMessage: ChatMessage,
): string {
  const args = effectiveArgs(input, rawMessage);
  if (!args) return "";

  for (const key of ["toolSummary", "tool_summary", "description", "summary"] as const) {
    const text = cleanOneLine(args[key], 44);
    if (text && !isRedundantSubtitle(text, title)) return text;
  }

  const op = mcpOpName(name);
  const isTaskTool = TASK_OPS.has(op) || title.includes("任务单");
  for (const key of ["identifier", "id", "issueId", "taskId"] as const) {
    const rawId = typeof args[key] === "string" ? args[key].trim() : "";
    if (!rawId || rawId.startsWith("dlgjob")) continue;
    if (isTaskTool || TICKET_ID_RE.test(rawId)) {
      const clipped = cleanOneLine(rawId, 32);
      if (clipped && !isRedundantSubtitle(clipped, title)) return clipped;
    }
  }
  if (isTaskTool) {
    const taskTitle = cleanOneLine(args.title, 40);
    if (taskTitle && !isRedundantSubtitle(taskTitle, title)) return taskTitle;
  }

  for (const key of ["query", "pattern", "glob_pattern", "q"] as const) {
    const q = cleanOneLine(args[key], 36);
    if (q && !isRedundantSubtitle(q, title)) return q;
  }

  for (const key of ["file_path", "path", "Path", "target_file", "notebook_path", "filename"] as const) {
    const rawPath = typeof args[key] === "string" ? args[key].trim() : "";
    if (!rawPath) continue;
    const base = rawPath.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? "";
    if (base && !base.startsWith("-") && !isRedundantSubtitle(base, title)) {
      return base.length > 36 ? `${base.slice(0, 36)}…` : base;
    }
  }

  if (title === "执行命令" || title === "运行命令") {
    const rawCmd =
      (typeof args.command === "string" && args.command) ||
      (typeof args.CommandLine === "string" && args.CommandLine) ||
      (typeof args.cmd === "string" && args.cmd) ||
      "";
    if (rawCmd) {
      const head = extractCommandHead(rawCmd, op === "oc_bash" || name.toLowerCase().includes("oc_bash"));
      if (head && !isRedundantSubtitle(head, title)) return head;
    }
  }

  return "";
}


// ── OCV5-310 时间轴呈现 ──────────────────────────────────────────────────────
// 外壳:一行标题(运行中 = 环形动效 + 当前动作 + 计时;结束 = 步骤数 + 单色图标统计)。
// 展开:一条竖向时间轴。中途说明是正文;连续的工具步骤收成一行人话摘要(「运行 7 条命令，
// 读取 1 个文件」,同原生 Claude Code);默认不露命令、路径、任务号,点开摘要才逐条列出,每条再
// 点开才看输出。「正在做什么」由外壳标题(动作 + 计时)和当前段节点的运行光晕表达。
// 状态色只给运行中 / 未成功 / 受阻。
type NodeTone = "live" | "warning" | "idle";

const KIND_ICON: Record<string, LucideIcon> = {
  命令: Terminal,
  读取: FileText,
  编辑: Pencil,
  搜索: Search,
  工具: Wrench,
  思考: Brain,
  计划: ListTodo,
  目标: Target,
  子任务: Bot,
  问答: MessageCircleQuestion,
  授权: ShieldCheck,
  计划确认: ListChecks,
};

function firstCounted(messages: readonly ChatMessage[]): ChatMessage | undefined {
  return messages.find((message) => !isClearedGoalRecord(message) && countLabel(message));
}

/** 时间轴节点:图标跟着步骤种类走,颜色只跟状态走(运行中 / 未成功 / 受阻)。 */
function stepNode(messages: readonly ChatMessage[], live: boolean): { Icon: LucideIcon; tone: NodeTone } {
  const head = firstCounted(messages) ?? messages[0];
  if (!head) return { Icon: Circle, tone: "idle" };
  if (head.role === "tool") {
    try {
      const display = normalizeToolForDisplay(head);
      const meta = resolveToolMeta(normalizeSingleUnderscoreMcp(display.name), display.input);
      const status = resolveToolStatus(display);
      // OCV5-313: 过程里的单步未成功 / 受阻是正常工作流的一部分,节点不染红/黄,与其他步骤同色。
      const tone: NodeTone = status.isRunning && live ? "live" : "idle";
      return { Icon: meta.icon, tone };
    } catch {
      return { Icon: Wrench, tone: "idle" };
    }
  }
  if (head.role === "permission") {
    return { Icon: head.toolName === "AskUserQuestion" ? MessageCircleQuestion : ShieldCheck, tone: "idle" };
  }
  if (isErroredAssistant(head)) return { Icon: TriangleAlert, tone: "warning" };
  if (head.role === "agent-group" || head.role === "delegate-progress") {
    const failed = hasErrorMark(head) || head._delegateStatus === "failed" || head._delegateStatus === "timeout";
    const done = head._completed === true || head._delegateStatus === "ok";
    return { Icon: Bot, tone: live && !done && !failed ? "live" : "idle" };
  }
  if (head.role === "thinking") return { Icon: Brain, tone: live ? "live" : "idle" };
  const Icon = KIND_ICON[countLabel(head)] ?? Circle;
  return { Icon, tone: "idle" };
}

const ICON_TONE: Record<NodeTone, string> = {
  live: "oc-codex-icon-live",
  warning: "text-warning",
  idle: "text-faint transition-colors group-hover/step:text-muted group-hover/sum:text-muted",
};

function StepIcon({ Icon, tone }: { Icon: LucideIcon; tone: NodeTone }) {
  return (
    <i
      aria-hidden
      data-testid="process-step-node"
      data-tone={tone}
      className={`not-italic flex size-4 shrink-0 items-center justify-center ${ICON_TONE[tone]}`}
    >
      <Icon size={14} strokeWidth={1.75} />
    </i>
  );
}


/** 技术详情里的原卡不再挂耗时(标题行已经挂了一份)。 */
const NO_TIMINGS = new Map<string, never>();

/**
 * UI-3 / Codex 极简步骤行:14px 柔和线性图标 + 人话标题 + 副摘要 + 单行耗时，点开是轻巧「技术详情」。
 * below 不论开合都挂在标题下面(未成功的原因)。
 */
function Fold({ testId, icon, head, meta, below, showChevron = false, children }: {
  testId: string;
  icon?: ReactNode;
  head: ReactNode;
  meta?: ReactNode;
  below?: ReactNode;
  showChevron?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid={testId} className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group/step -mx-1.5 flex min-h-8 w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 py-1.5 text-left outline-none transition-colors duration-150 hover:bg-hover/65 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [@media(hover:none)]:min-h-10"
      >
        {icon}
        {head}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
          {meta}
          <ChevronRight
            size={13}
            aria-hidden
            className={`text-faint/80 transition-transform duration-200 ${open ? "rotate-90" : showChevron ? "opacity-80 group-hover/step:text-muted" : "opacity-0 group-hover/step:opacity-100 group-focus-visible/step:opacity-100 [@media(hover:none)]:opacity-100"}`}
          />
        </span>
      </button>
      {below}
      {open ? children : null}
    </div>
  );
}

const EXPLORE_CLUSTER_MIN = 3;

function isFoldableExploreItem<T>(item: T, messagesOf: (item: T) => ChatMessage[]): boolean {
  const rows = messagesOf(item);
  if (rows.length === 0) return false;
  return rows.every(
    (message) =>
      !message._payloadDeferred &&
      message.role === "tool" &&
      message._completed === true &&
      !hasErrorMark(message) &&
      workKind(message) !== "prep" &&
      classifyMessagePhase(message) === "explore",
  );
}

function exploreClusterLabel<T>(items: readonly T[], messagesOf: (item: T) => ChatMessage[]): string {
  let reads = 0;
  let searches = 0;
  let total = 0;
  for (const item of items) {
    for (const message of messagesOf(item)) {
      total += 1;
      const kind = workKind(message);
      if (kind === "read" || kind === "attach") reads += 1;
      else if (kind === "search") searches += 1;
    }
  }
  const count = total || items.length;
  if (reads === count) return `已读取 ${count} 个文件`;
  if (searches === count) return `已检索 ${count} 处代码与资料`;
  return `已探索 ${count} 处文件与代码`;
}

type StepRun<T> =
  | { kind: "step"; item: T }
  | { kind: "explore-cluster"; key: string; items: T[] };

function groupExploreRuns<T>(
  items: readonly T[],
  messagesOf: (item: T) => ChatMessage[],
  keyOf: (item: T) => string,
): StepRun<T>[] {
  const runs: StepRun<T>[] = [];
  let buffer: T[] = [];
  const flush = () => {
    if (buffer.length >= EXPLORE_CLUSTER_MIN) {
      runs.push({ kind: "explore-cluster", key: `explore:${keyOf(buffer[0]!)}`, items: buffer });
    } else {
      for (const item of buffer) runs.push({ kind: "step", item });
    }
    buffer = [];
  };
  for (const item of items) {
    if (isFoldableExploreItem(item, messagesOf)) {
      buffer.push(item);
    } else {
      flush();
      runs.push({ kind: "step", item });
    }
  }
  flush();
  return runs;
}

/** 一段的节点:段里有在跑的就是运行态;图标取段内最多的那类。未成功在摘要行右侧单独标出,不把整段染红。 */
function groupNode(messages: readonly ChatMessage[], current: boolean): { Icon: LucideIcon; tone: NodeTone } {
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (isClearedGoalRecord(message)) continue;
    const label = countLabel(message);
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  const Icon = KIND_ICON[top] ?? Wrench;
  const last = messages.at(-1);
  const live = current && (messages.some(toolStillRunning) || last?.role === "thinking");
  return { Icon, tone: live ? "live" : "idle" };
}

function StageText({ message, live = false, onFirstTextPaint }: {
  message: ChatMessage; live?: boolean; onFirstTextPaint?: CardCallbacks["onFirstTextPaint"];
}) {
  // Same suppression as AssistantCard: an unpublished fallback must not
  // reappear just because the row was grouped into the process. The body
  // itself is ProgressiveMarkdown, the final answer's renderer, with no
  // extra size or color on the wrapper. Only the current live stage keeps
  // the streaming tail; a finished or reopened stage uses the normal pager.
  if (message._payloadDeferred || message._hideUnpublishedFallback === true) return null;
  if (message.error || message._isError || message._errorCode) return null;
  const text = message.text ?? "";
  if (!text.trim()) return null;
  return (
    <div
      data-testid="process-stage"
      data-find-member={timelineMessageKey(message)}
      className="min-w-0"
    >
      <FirstTextPaintCommitProbe message={message} onFirstTextPaint={onFirstTextPaint} />
      <ProgressiveMarkdown text={text} live={live} />
    </div>
  );
}

export type ProcessStageListProps<T> = {
  sections: ProcessSection<T>[];
  active: boolean;
  currentIndex: number;
  live: { text: string; pending: boolean } | null;
  toolsSettled: boolean;
  runningFor: string;
  waiting: boolean;
  waitingMs: number;
  stepTimings: Parameters<typeof combineStepTimings>[0];
  lastItemKey: string;
  detailOpen: (key: string) => boolean;
  setDetailOpen: (key: string, open: boolean) => void;
  renderItem: (item: T) => ReactNode;
  keyOf: (item: T) => string;
  messagesOf: (item: T) => ChatMessage[];
  onFirstTextPaint?: CardCallbacks["onFirstTextPaint"];
  tokenUsageOf?: (item: T) => DisplayTokenUsage | undefined;
  phaseFilter?: PhaseKind | null;
  onPhaseFilterChange?: (phase: PhaseKind | null) => void;
};

export function ProcessStageList<T>({
  sections,
  active,
  currentIndex,
  live,
  toolsSettled,
  runningFor,
  waiting,
  waitingMs,
  stepTimings,
  lastItemKey,
  detailOpen,
  setDetailOpen,
  renderItem,
  keyOf,
  messagesOf,
  onFirstTextPaint,
  tokenUsageOf,
  phaseFilter = null,
  onPhaseFilterChange,
}: ProcessStageListProps<T>) {
  const narrativeBody = (section: ProcessSection<T>, isLive: boolean) => (
    <div className="space-y-1">
      {section.items.map((item) => {
        const rows = messagesOf(item);
        if (rows.some((message) => message._payloadDeferred)) {
          return <div key={keyOf(item)}>{renderItem(item)}</div>;
        }
        return (
          <div key={keyOf(item)} className="space-y-1">
            {rows.map((message) => (
              <StageText key={message.id} message={message} live={isLive} onFirstTextPaint={onFirstTextPaint} />
            ))}
          </div>
        );
      })}
    </div>
  );

  const stepRow = (item: T, isLastOfProcess: boolean) => {
    const rows = messagesOf(item);
    const key = keyOf(item);
    const deferred = rows.some((message) => message._payloadDeferred);
    const node = stepNode(rows, active && isLastOfProcess);
    // 只有工具 / 思考行换成人话步骤行(原卡进「技术详情」);子任务、计划等仍用原卡(它们自带结构)。
    const inline = !deferred && rows.length > 0 && rows.every((message) => message.role === "tool" || message.role === "thinking");
    const body = (
      <>
        <ProcessStepContext.Provider value={inline}>{renderItem(item)}</ProcessStepContext.Provider>
        {rows.map((message) => {
          const raw = rawAuditCommand(message);
          if (!raw) return null;
          return (
            <pre
              key={`${message.id}:raw`}
              data-testid="process-raw-command"
              className="mb-1 mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-hover/60 px-2 py-1 font-mono text-xs text-muted"
            >
              {raw}
            </pre>
          );
        })}
      </>
    );
    const head = rows[0];
    // 委派:谁接了、做什么、进行中 / 完成一眼可见;原委派卡(子代理的过程)在技术详情里。
    const delegated = !deferred && rows.length > 0 && rows.every(isDelegateRow);
    const delegation = delegated ? delegateState(rows) : null;
    let title = delegated ? delegateTitle(rows) : "思考";
    let subtitle = "";
    let reason = "";
    if (inline && head?.role === "tool") {
      try {
        const display = normalizeToolForDisplay(head);
        const normalizedName = normalizeSingleUnderscoreMcp(display.name);
        title = humanStepTitle(normalizedName, display.input);
        subtitle = extractStepSubtitle(normalizedName, display.input, title, head);
        reason = resolveToolStatus(display).errorFirstLine;
      } catch {
        title = "调用工具";
      }
    }
    const rowIds = rows.map((message) => message.id);
    const stepTiming = combineStepTimings(stepTimings, rowIds);
    const splitTimingDetail =
      stepTiming?.ms !== undefined &&
      stepTiming.executionMs !== undefined &&
      stepTiming.ms - stepTiming.executionMs >= 1_000
        ? `执行 ${formatStepDuration(stepTiming.executionMs)} · 等待 ${formatStepDuration(stepTiming.ms - stepTiming.executionMs)}`
        : "";
    return (
      <div
        key={key}
        data-testid="process-step"
        className={active && key === lastItemKey ? "oc-step-enter min-w-0" : "min-w-0"}
      >
        {(inline || delegated) && head ? (
          // UI-3 & OCV5-831 / OCV5-834: Codex 极简紧凑行（14px 柔和线性微图标 + 主动作 + 人类可读副摘要 + 单行耗时），
          // 完整命令、参数与输出在点开后的「技术详情」(原卡,原样)里。
          <Fold
            testId="process-step-row"
            icon={<StepIcon Icon={node.Icon} tone={node.tone} />}
            head={
              <>
                <span
                  className={
                    subtitle
                      ? `max-w-[46%] shrink-0 truncate text-body font-medium ${node.tone === "live" ? "text-fg" : "text-fg/85"}`
                      : `min-w-0 truncate text-body ${node.tone === "live" ? "text-muted" : "text-faint group-hover/step:text-muted"}`
                  }
                >
                  {node.tone === "live" && head.role === "thinking" ? "正在思考" : title}
                </span>
                {subtitle ? (
                  <span
                    data-testid="process-step-summary"
                    className="min-w-0 flex-1 truncate text-meta tabular-nums text-muted"
                    title={subtitle}
                  >
                    {subtitle}
                  </span>
                ) : null}
                {delegation ? (
                  <span data-testid="process-delegate-state" className={`shrink-0 text-caption ${delegation.running ? "text-muted" : "text-faint"}`}>
                    {delegation.label}
                  </span>
                ) : hasErrorMark(head) ? <span className="shrink-0 text-caption text-faint">未成功</span> : null}
              </>
            }
            meta={<StepMetaBadge ids={rowIds} tokenUsage={tokenUsageOf?.(item)} />}
            below={reason ? (
              // 未成功写原因(错误输出首行),安静灰字;整轮失败另有顶层提示。
              <div data-testid="process-step-reason" className="-mt-0.5 truncate pb-1 pl-6 text-caption text-faint" title={reason}>
                {reason}
              </div>
            ) : null}
          >
            <div data-testid="process-step-tech" className="oc-reveal mb-1.5 ml-2 mt-0.5 border-l border-border/75 pl-3">
              <p className="flex flex-wrap items-center gap-x-2 pt-0.5 text-caption tabular-nums text-faint">
                <span>技术详情</span>
                {splitTimingDetail ? <span data-testid="process-step-timing-detail">{splitTimingDetail}</span> : null}
              </p>
              <StepTimingContext.Provider value={NO_TIMINGS}>{body}</StepTimingContext.Provider>
            </div>
          </Fold>
        ) : (
          <div className="py-1">{body}</div>
        )}
      </div>
    );
  };

  /** 一段的展开明细:人话步骤在前(连续 ≥3 条已完成只读探索微折叠),底层步骤收成一行「准备工作 N 步」挂在后面。 */
  const stepRows = (items: readonly T[], isLastSection: boolean) => {
    const prep = items.filter((item) => {
      const rows = messagesOf(item);
      return rows.length > 0 && rows.every((message) => workKind(message) === "prep");
    });
    const prepSet = new Set(prep);
    const main = items.filter((item) => !prepSet.has(item));
    const last = items.at(-1);
    const row = (item: T) => stepRow(item, isLastSection && item === last);
    const runs = groupExploreRuns(main, messagesOf, keyOf);
    return (
      <>
        {runs.map((entry) => {
          if (entry.kind === "step") return row(entry.item);
          const clusterIds = entry.items.flatMap((item) => messagesOf(item).map((message) => message.id));
          const clusterTiming = combineStepTimings(stepTimings, clusterIds);
          const clusterLabel = exploreClusterLabel(entry.items, messagesOf);
          return (
            <div key={entry.key} className="min-w-0">
              <Fold
                testId="process-explore-cluster"
                icon={<StepIcon Icon={Search} tone="idle" />}
                head={<span className="min-w-0 truncate text-body text-muted">{clusterLabel}</span>}
                meta={
                  clusterTiming?.ms !== undefined ? (
                    <span className="shrink-0 whitespace-nowrap text-caption tabular-nums text-faint">
                      {formatStepDuration(clusterTiming.ms)}
                    </span>
                  ) : undefined
                }
                showChevron
              >
                <div className="ml-2 mt-0.5 space-y-0.5 border-l border-border/55 pl-3">
                  {entry.items.map(row)}
                </div>
              </Fold>
            </div>
          );
        })}
        {prep.length ? (
          <div className="min-w-0">
            <Fold
              testId="process-prep"
              icon={<StepIcon Icon={Wrench} tone="idle" />}
              head={<span className="min-w-0 truncate text-body text-faint">{`准备工作 ${prep.length} 步`}</span>}
              showChevron
            >
              <div className="ml-2 mt-0.5 space-y-0.5 border-l border-border/55 pl-3">
                {prep.map(row)}
              </div>
            </Fold>
          </div>
        ) : null}
      </>
    );
  };

  const allMessages = sections.flatMap((section) => section.messages);
  const phaseTimeline = buildPhaseTimeline(allMessages, { stepTimings: stepTimings ?? undefined, active });
  const activePhaseFilter =
    phaseFilter !== null && phaseTimeline.phases.some((phase) => phase.kind === phaseFilter) ? phaseFilter : null;
  const filteredPhaseSegment =
    activePhaseFilter !== null ? phaseTimeline.phases.find((phase) => phase.kind === activePhaseFilter) : undefined;
  const filteredItems =
    activePhaseFilter !== null
      ? sections.flatMap((section) => {
          if (section.narrative || section.goal) return [];
          return section.items.filter((item) =>
            messagesOf(item).some((message) => classifyMessagePhase(message) === activePhaseFilter),
          );
        })
      : null;

  return (
    <>
            {phaseTimeline.showFilterBar && onPhaseFilterChange ? (
              <PhaseTimelineFilterBar
                timeline={phaseTimeline}
                selectedPhase={activePhaseFilter}
                onSelectPhase={onPhaseFilterChange}
              />
            ) : null}
            {filteredItems !== null ? (
              <div data-testid="process-phase-filtered" data-phase-filter={activePhaseFilter}>
                {filteredPhaseSegment ? <PhaseGroupHeader phase={filteredPhaseSegment} /> : null}
                <div className="space-y-0.5">
                  {filteredItems.map((item, idx) => stepRow(item, idx === filteredItems.length - 1))}
                </div>
              </div>
            ) : (
            <div className="space-y-0.5">
            {sections.map((section, index) => {
              const isLastSection = index === sections.length - 1;
              if (section.card) {
                // 过程里常显的整卡步骤:已回答的问答/审批(用户的选择是这轮的关键事实)、
                // 本轮已越过的中途错误(模型不可用等)。用原卡渲染,不藏在「N 项」后面。
                return (
                  <div key={section.key} data-testid="process-card" className="min-w-0 space-y-1.5 py-1">
                    {/* 能进过程的错误卡都已被本轮越过:不再给重试/切换模型/从断点继续(会重复开工)。 */}
                    <RecoveredStepContext.Provider value>
                      {section.items.map((item) => (
                        <div key={keyOf(item)}>{renderItem(item)}</div>
                      ))}
                    </RecoveredStepContext.Provider>
                  </div>
                );
              }
              if (section.goal) {
                return (
                  <div key={section.key} data-testid="process-goal" className="min-w-0 py-1">
                    {section.items.map((item) => (
                      <div key={keyOf(item)}>{renderItem(item)}</div>
                    ))}
                  </div>
                );
              }
              if (section.narrative) {
                const current = active && index === currentIndex;
                // Intermediate replies stay fully readable for the whole turn,
                // styled naturally like Codex editorial commentary without extra dots.
                return (
                  <div key={section.key} className="oc-codex-commentary min-w-0">
                    {narrativeBody(section, current)}
                  </div>
                );
              }
              const details = detailOpen(section.key);
              const current = active && index === currentIndex;
              const group = groupNode(section.messages, current);
              // OCV5-817: 整轮已完成且仅有一个工具步骤组时,外层 ProcessDisclosure 标题已给足汇总,
              // 直接平铺步骤行省去冗余的第二层分组折叠(4 击压至 2 击)。
              if (!active && sections.length === 1) {
                return (
                  <div key={section.key} className="space-y-0.5" data-testid="process-details">
                    {stepRows(section.items, isLastSection)}
                  </div>
                );
              }
              const working = !!live && index === currentIndex && !toolsSettled;
              const groupTiming = working ? undefined : combineStepTimings(stepTimings, section.messages.map((message) => message.id));
              return (
                <div key={section.key} className="space-y-0.5" data-testid="process-step-group">
                  <button
                    type="button"
                    className="group/sum -mx-1.5 flex min-h-8 w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors duration-150 hover:bg-hover/65 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [@media(hover:none)]:min-h-10"
                    aria-expanded={details}
                    data-testid="process-detail-toggle"
                    onClick={() => setDetailOpen(section.key, !details)}
                  >
                    <StepIcon Icon={group.Icon} tone={group.tone} />
                    <span
                      data-testid="process-group-summary"
                      data-live-working={working ? "true" : "false"}
                      className={`min-w-0 truncate text-body ${working ? "oc-live-status-shine text-muted" : "text-faint"}`}
                    >
                      {working && live ? (
                        <span key={live.text} data-testid="process-step-live" data-live-pending={live.pending ? "true" : "false"} className="oc-swap-in">
                          {live.text}
                        </span>
                      ) : (
                        groupSummary(section.messages)
                      )}
                    </span>
                    {working && runningFor ? (
                      <span
                        aria-hidden
                        data-testid="process-step-running-for"
                        className="shrink-0 whitespace-nowrap text-caption tabular-nums text-faint"
                      >
                        {`已运行 ${runningFor}`}
                      </span>
                    ) : groupTiming?.ms !== undefined ? (
                      <span
                        data-testid="process-group-duration"
                        className="shrink-0 whitespace-nowrap text-caption tabular-nums text-faint"
                        title={`这一组步骤共用时 ${formatStepDuration(groupTiming.ms)}`}
                      >
                        {formatStepDuration(groupTiming.ms)}
                      </span>
                    ) : null}
                    <ChevronRight
                      size={13}
                      aria-hidden
                      className={`ml-auto shrink-0 text-faint/80 transition-transform duration-200 ease-[var(--ease-spring)] group-hover/sum:text-muted ${details ? "rotate-90" : ""}`}
                    />
                  </button>
                  {details ? (
                    <div className="ml-2 mt-0.5 space-y-0.5 border-l border-border/55 pl-3" data-testid="process-details">
                      {stepRows(section.items, isLastSection)}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {waiting && live ? (
              <div key="__live-tail" data-testid="process-live-tail" className="oc-step-enter flex min-h-8 items-center gap-2 py-1 [@media(hover:none)]:min-h-10">
                <StepIcon Icon={Brain} tone="live" />
                <span data-testid="process-step-live" data-live-pending="true" className="oc-live-status-shine min-w-0 truncate text-body text-muted">等待模型响应</span>
                <span aria-hidden className="shrink-0 whitespace-nowrap text-caption tabular-nums text-faint">
                  {formatElapsed(waitingMs)}
                </span>
              </div>
            ) : null}
            </div>
            )}
    </>
  );
}
