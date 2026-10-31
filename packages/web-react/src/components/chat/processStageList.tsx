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
import type { ChatMessage } from "../../lib/chat/model";
import { QuietContextNote } from "./QuietContextNote";
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
  delegateState,
  delegateTitle,
  formatElapsed,
  formatStepDuration,
  hasErrorMark,
  humanStepTitle,
  isClearedGoalRecord,
  isContextCompactionMessage,
  isDelegateRow,
  isErroredAssistant,
  normalizeToolForDisplay,
  rawAuditCommand,
  resolveToolMeta,
  resolveToolStatus,
  timelineMessageKey,
  toolStillRunning,
  workKind,
  workSummary,
  type ProcessSection,
} from "./ProcessDisclosure";

/** 一段步骤的摘要行:有事说事;只有思考 / 准备工作时直说。 */
function groupSummary(messages: readonly ChatMessage[]): string {
  const said = workSummary(messages);
  if (said) return said;
  const thoughts = messages.filter((message) => message.role === "thinking").length;
  if (thoughts) return thoughts > 1 ? `思考 ${thoughts} 次` : "思考";
  const prep = messages.filter((message) => workKind(message) === "prep").length;
  return prep ? `准备工作 ${prep} 步` : "执行记录";
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
      const meta = resolveToolMeta(display.name, display.input);
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

const NODE_TONE: Record<NodeTone, string> = {
  live: "oc-step-node-live text-accent ring-accent/45",
  warning: "text-warning ring-warning/40 bg-[color-mix(in_srgb,var(--warning)_10%,var(--bg))]",
  idle: "text-faint ring-border",
};

function StepNode({ Icon, tone }: { Icon: LucideIcon; tone: NodeTone }) {
  return (
    <span
      aria-hidden
      data-testid="process-step-node"
      data-tone={tone}
      className={`relative z-[1] mt-1.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-bg ring-1 transition-colors duration-300 [@media(hover:none)]:mt-2.5 ${NODE_TONE[tone]}`}
    >
      <Icon size={12.5} strokeWidth={2} />
    </span>
  );
}


/** 技术详情里的原卡不再挂耗时(标题行已经挂了一份)。 */
const NO_TIMINGS = new Map<string, never>();

/**
 * UI-3 点开才看的一行:时间轴里的一步(人话标题 + 未成功 + 耗时,点开是「技术详情」)和「准备工作 N 步」。
 * below 不论开合都挂在标题下面(未成功的原因)。
 */
function Fold({ testId, head, meta, below, children }: {
  testId: string;
  head: ReactNode;
  meta?: ReactNode;
  below?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid={testId} className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group/step -mx-2 flex min-h-9 w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors duration-150 hover:bg-hover/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [@media(hover:none)]:min-h-11"
      >
        {head}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-1">
          {meta}
          <ChevronRight
            size={14}
            aria-hidden
            className={`text-faint transition-transform duration-200 ${open ? "rotate-90" : "opacity-0 group-hover/step:opacity-100 group-focus-visible/step:opacity-100 [@media(hover:none)]:opacity-100"}`}
          />
        </span>
      </button>
      {below}
      {open ? children : null}
    </div>
  );
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

/** 时间轴上的一行:左列节点,右列内容。内容列与节点中心对齐到同一条竖线。 */
function RailRow({
  node,
  children,
  enter,
  testId,
}: {
  node: ReactNode;
  children: ReactNode;
  enter: boolean;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className={enter ? "oc-step-enter relative flex gap-3" : "relative flex gap-3"}>
      {node}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** 叙述段(中途的说明文字)在时间轴上只挂一颗小圆点,正文与步骤标题左缘对齐。 */
function NarrativeDot() {
  return (
    <span aria-hidden className="relative z-[1] flex w-6 shrink-0 justify-center pt-[9px]">
      <span className="size-1.5 rounded-full bg-border-strong ring-4 ring-bg" />
    </span>
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
    let reason = "";
    if (inline && head?.role === "tool") {
      try {
        const display = normalizeToolForDisplay(head);
        title = humanStepTitle(display.name, display.input);
        reason = resolveToolStatus(display).errorFirstLine;
      } catch {
        title = "调用工具";
      }
    }
    return (
      <RailRow key={key} testId="process-step" node={<StepNode Icon={node.Icon} tone={node.tone} />} enter={active && key === lastItemKey}>
        {(inline || delegated) && head ? (
          // UI-3:人话标题(「读取 周会记录.txt」「运行命令」「思考」);命令、技能 / 任务 ID、英文思考小标题
          // 和输出都在点开后的「技术详情」(原卡,原样)里。
          <Fold
            testId="process-step-row"
            head={
              <>
                <span className={`min-w-0 truncate text-body ${node.tone === "live" ? "text-muted" : "text-faint"}`}>
                  {node.tone === "live" && head.role === "thinking" ? "正在思考" : title}
                </span>
                {delegation ? (
                  <span data-testid="process-delegate-state" className={`shrink-0 text-meta ${delegation.running ? "text-muted" : "text-faint"}`}>
                    {delegation.label}
                  </span>
                ) : hasErrorMark(head) ? <span className="shrink-0 text-meta text-faint">未成功</span> : null}
              </>
            }
            meta={<StepMetaBadge ids={rows.map((message) => message.id)} tokenUsage={tokenUsageOf?.(item)} />}
            below={reason ? (
              // 未成功写原因(错误输出首行),安静灰字;整轮失败另有顶层提示。
              <div data-testid="process-step-reason" className="-mt-0.5 truncate pb-1 text-meta text-faint" title={reason}>
                {reason}
              </div>
            ) : null}
          >
            <div data-testid="process-step-tech" className="oc-reveal mb-1.5 mt-0.5 border-l-2 border-border pl-3">
              <p className="pt-0.5 text-caption text-faint">技术详情</p>
              <StepTimingContext.Provider value={NO_TIMINGS}>{body}</StepTimingContext.Provider>
            </div>
          </Fold>
        ) : (
          <div className="py-1">{body}</div>
        )}
      </RailRow>
    );
  };

  /** 一段的展开明细:人话步骤在前,底层步骤收成一行「准备工作 N 步」挂在后面。 */
  const stepRows = (items: readonly T[], isLastSection: boolean) => {
    const prep = items.filter((item) => {
      const rows = messagesOf(item);
      return rows.length > 0 && rows.every((message) => workKind(message) === "prep");
    });
    const last = items.at(-1);
    const row = (item: T) => stepRow(item, isLastSection && item === last);
    return (
      <>
        {items.filter((item) => !prep.includes(item)).map(row)}
        {prep.length ? (
          <RailRow node={<StepNode Icon={Wrench} tone="idle" />} enter={false}>
            <Fold testId="process-prep" head={<span className="min-w-0 truncate text-body text-faint">{`准备工作 ${prep.length} 步`}</span>}>
              {prep.map(row)}
            </Fold>
          </RailRow>
        ) : null}
      </>
    );
  };

  return (
    <>
            {sections.map((section, index) => {
              const isLastSection = index === sections.length - 1;
              if (section.quiet) {
                const message = section.messages.find(isContextCompactionMessage);
                if (!message) return null;
                return (
                  <div key={section.key} className="py-0.5 pl-9" data-testid="process-quiet-context">
                    <QuietContextNote message={message} />
                  </div>
                );
              }
              if (section.card) {
                // 过程里常显的整卡步骤:已回答的问答/审批(用户的选择是这轮的关键事实)、
                // 本轮已越过的中途错误(模型不可用等)。用原卡渲染,不藏在「N 项」后面。
                const node = stepNode(section.messages, false);
                return (
                  <RailRow key={section.key} testId="process-card" node={<StepNode Icon={node.Icon} tone={node.tone} />} enter={false}>
                    <div className="min-w-0 space-y-1.5 py-1">
                      {/* 能进过程的错误卡都已被本轮越过:不再给重试/切换模型/从断点继续(会重复开工)。 */}
                      <RecoveredStepContext.Provider value>
                        {section.items.map((item) => (
                          <div key={keyOf(item)}>{renderItem(item)}</div>
                        ))}
                      </RecoveredStepContext.Provider>
                    </div>
                  </RailRow>
                );
              }
              if (section.goal) {
                return (
                  <RailRow key={section.key} testId="process-goal" node={<StepNode Icon={Target} tone="idle" />} enter={false}>
                    <div className="py-1">
                      {section.items.map((item) => (
                        <div key={keyOf(item)}>{renderItem(item)}</div>
                      ))}
                    </div>
                  </RailRow>
                );
              }
              if (section.narrative) {
                const current = active && index === currentIndex;
                // Intermediate replies stay fully readable for the whole turn.
                // A one-line stage hid text the reader had already seen, then
                // showed it again only after the turn ended. Tool groups still
                // collapse. Only the current stage is live.
                return (
                  <RailRow key={section.key} node={<NarrativeDot />} enter={false}>
                    <div className="py-1">{narrativeBody(section, current)}</div>
                  </RailRow>
                );
              }
              const details = detailOpen(section.key);
              const current = active && index === currentIndex;
              const group = groupNode(section.messages, current);
              // OCV5-312: 流光挂在「正在干活」的这一段摘要行上(当前段、本轮仍在进行),表明 agent 此刻在做什么;
              // 其余过程文字一律 --faint,让下方 agent 的回复正文更突出。当前在写正文(叙述段)时不挂流光,流式文字本身就是信号。
              // 有意为之:干活行的回落色是 --muted(比完成行略实)。流光与节点光晕在 reduced-motion / 不支持
              // background-clip:text 时都不生效,这一档静态差异是那时唯一能指出「哪一行在干活」的线索;
              // 动效正常时流光静止色本就是 --faint,观感与其余过程行一致。
              // UI-3:在干活的段,摘要行就是这一轮唯一的运行状态行(写「正在…」),跑完才换成这一段的人话摘要;
              // 工具都已返回、在等模型时(#1234)那一行落到下面的「等待模型响应」尾行,不把已完成的工具标为仍在执行。
              const working = !!live && index === currentIndex && !toolsSettled;
              const groupTiming = working ? undefined : combineStepTimings(stepTimings, section.messages.map((message) => message.id));
              return (
                <div key={section.key} className="space-y-0.5" data-testid="process-step-group">
                  <RailRow node={<StepNode Icon={group.Icon} tone={group.tone} />} enter={false}>
                    <button
                      type="button"
                      className="group/sum -mx-2 flex min-h-9 w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-hover/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [@media(hover:none)]:min-h-11"
                      aria-expanded={details}
                      data-testid="process-detail-toggle"
                      onClick={() => setDetailOpen(section.key, !details)}
                    >
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
                        // 长命令 / 长工具:流光之外再给一个每秒在走的数字,一眼看出「还在跑、跑了多久」。
                        // 读屏不播报每秒变化的时长。
                        <span
                          aria-hidden
                          data-testid="process-step-running-for"
                          className="shrink-0 whitespace-nowrap text-meta tabular-nums text-faint"
                        >
                          {`已运行 ${runningFor}`}
                        </span>
                      ) : groupTiming?.ms !== undefined ? (
                        // OCV5-367: 折叠的步骤组给出这一组合计用时(组内每一步都有可信时间才给)。
                        <span
                          data-testid="process-group-duration"
                          className="shrink-0 whitespace-nowrap text-meta tabular-nums text-faint"
                          title={`这一组步骤共用时 ${formatStepDuration(groupTiming.ms)}`}
                        >
                          {formatStepDuration(groupTiming.ms)}
                        </span>
                      ) : null}
                      {/* OCV5-313: 不在摘要行单独点出「N 步未成功」——中途个别步骤没成功是正常流程,
                          事实留在展开后的步骤行里(安静的灰字),整轮失败另有顶层错误卡。 */}
                      <ChevronRight
                        size={14}
                        aria-hidden
                        className={`ml-auto shrink-0 text-faint transition-transform duration-200 ease-[var(--ease-spring)] group-hover/sum:text-muted ${details ? "rotate-90" : ""}`}
                      />
                    </button>
                  </RailRow>
                  {details ? (
                    <div className="space-y-0.5" data-testid="process-details">
                      {stepRows(section.items, isLastSection)}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {waiting && live ? (
              // 可见进展之后在等模型(叙述写完或工具都已返回):在最新进展处挂一行活的「等待模型响应」+ 等待时长,
              // 不把已经完成的工具标为仍在执行。下一步一冒出来这行就消失,流光随之落到那一段的摘要行上。
              <RailRow key="__live-tail" testId="process-live-tail" node={<StepNode Icon={Brain} tone="live" />} enter>
                <div className="flex min-h-9 items-center gap-2 py-1.5 [@media(hover:none)]:min-h-11">
                  <span data-testid="process-step-live" data-live-pending="true" className="oc-live-status-shine min-w-0 truncate text-body text-muted">等待模型响应</span>
                  <span aria-hidden className="shrink-0 whitespace-nowrap text-meta tabular-nums text-faint">
                    {formatElapsed(waitingMs)}
                  </span>
                </div>
              </RailRow>
            ) : null}
    </>
  );
}
