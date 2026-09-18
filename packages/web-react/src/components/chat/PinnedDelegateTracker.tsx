/**
 * 固定在对话输入框上方的「后台子任务」HUD。
 *
 * 与 PinnedTaskTracker 同层：组卡会随消息流滚走、刷新后过程树可能为空，本 HUD
 * 钉住 GET inflight-delegates 投影。父 turn 结束后只要还有 running 或未 dismiss
 * 的终态项就继续显示（这是后台任务的核心场景）。
 *
 * 头部只有**一个**切换按钮（图标 / 计数 / 折叠摘要 / chevron 都在按钮里），
 * 「停止本轮」「全部知道了」是按钮外的同级动作 —— 不再有 aria-hidden 的假 chevron 按钮。
 */
import { Bot, Check, ChevronDown, ChevronUp, Circle, LoaderCircle, Pause, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  isTerminalDelegateState,
  type InflightDelegateItem,
} from "../../lib/chat/inflightDelegates";
import { cn } from "../../lib/utils";
import { Button } from "../ui";
import { agentDisplayName } from "./agentNames";
import { HUD_LIST_CLS, HUD_TOGGLE_CLS, useHudListOverflow } from "./PinnedTaskTracker";

const AUTO_COLLAPSE_MS = 3000;
const MAX_TERMINAL = 5;

function firstLine(text: string): string {
  const nl = text.search(/\r|\n/);
  return (nl === -1 ? text : text.slice(0, nl)).trim();
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

function isRunningState(state: string): boolean {
  return state === "running";
}

function isFailureState(state: string): boolean {
  return state === "failed" || state === "cancelled" || state === "killed_by_cutover";
}

/** 终态 / 非终态的人话标签(状态标的 title / aria-label,H-07)。 */
export function delegateStateLabel(state: string): string {
  switch (state) {
    case "running":
      return "运行中";
    case "queued":
      return "排队中";
    case "paused_for_cutover":
      return "已暂停（等待切换）";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    case "killed_by_cutover":
      return "因切换被终止";
    default:
      return state;
  }
}

function visibleDelegateItems(items: InflightDelegateItem[]): InflightDelegateItem[] {
  const live: InflightDelegateItem[] = [];
  const terminal: InflightDelegateItem[] = [];
  for (const item of items) {
    if (isTerminalDelegateState(item.state)) terminal.push(item);
    else live.push(item);
  }
  terminal.sort((a, b) => b.updatedAt - a.updatedAt);
  return [...live, ...terminal.slice(0, MAX_TERMINAL)];
}

/**
 * 状态标(H-07):running 旋转;queued 空心圆(还没开始跑);paused 暂停标(warning);
 * completed ✓;failed / cancelled / killed ×。每个都带 title + aria-label,不再只靠颜色。
 */
function StatusMark({ state, className }: { state: string; className?: string }) {
  const label = delegateStateLabel(state);
  const common = {
    className: cn("shrink-0", className),
    title: label,
    "aria-label": label,
    role: "img" as const,
  };
  if (state === "completed")
    return <Check {...common} className={cn(common.className, "text-success")} />;
  if (isFailureState(state))
    return <X {...common} className={cn(common.className, "text-danger")} />;
  if (state === "queued")
    return <Circle {...common} className={cn(common.className, "text-faint")} />;
  if (state === "paused_for_cutover")
    return <Pause {...common} className={cn(common.className, "text-warning")} />;
  return <LoaderCircle {...common} className={cn(common.className, "animate-spin text-accent")} />;
}

function DelegateRow({
  item,
  onDismiss,
}: {
  item: InflightDelegateItem;
  onDismiss: (jobId: string) => void;
}) {
  const terminal = isTerminalDelegateState(item.state);
  const goalLine = firstLine(item.goal);
  const hint = item.liveHint.trim();
  // 终态一律显示摘要(H-01):失败 / 取消 / 被终止的原因就在 resultSummary 里,以前只给 completed 看。
  const summary = terminal ? firstLine(item.resultSummary ?? "") : "";
  const name = agentDisplayName(item.agentId) || item.agentId;
  return (
    <div className="flex items-start gap-2 text-body">
      <span className="mt-px shrink-0">
        <StatusMark state={item.state} className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 text-muted">{name}</span>
          <span className="min-w-0 truncate text-fg" title={item.goal}>
            {goalLine || item.goal}
          </span>
        </div>
        {hint ? (
          <div className="truncate text-faint" title={hint}>
            {hint}
          </div>
        ) : null}
        {summary ? (
          <div
            className={cn("truncate", isFailureState(item.state) ? "text-danger" : "text-faint")}
            title={item.resultSummary}
          >
            {summary}
          </div>
        ) : null}
      </div>
      {terminal ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss(item.jobId);
          }}
        >
          知道了
        </Button>
      ) : null}
    </div>
  );
}

export function PinnedDelegateTracker({
  items,
  onDismiss,
  onStop,
}: {
  items: InflightDelegateItem[];
  onDismiss: (jobId: string) => void;
  onStop?: () => void;
}) {
  const visible = useMemo(() => visibleDelegateItems(items), [items]);
  const live = visible.filter((item) => !isTerminalDelegateState(item.state));
  const terminal = visible.filter((item) => isTerminalDelegateState(item.state));
  const running = live.filter((item) => isRunningState(item.state));
  const latestRunning =
    (running.length > 0 ? running : live).slice().sort((a, b) => b.updatedAt - a.updatedAt)[0] ??
    null;
  // 折叠摘要(H-03):有在飞项看最近在飞的;全部结束就看最近结束的那条 —— 头部不能只剩一个数字。
  const summaryItem = latestRunning ?? terminal[0] ?? null;
  const sig = visible.map((item) => `${item.jobId}:${item.state}`).join("\u0001");
  const hasRunning = running.length > 0;

  const [expanded, setExpanded] = useState(true);
  const [userTouched, setUserTouched] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const prevSig = useRef(sig);
  const startedAtRef = useRef(new Map<string, number>());

  useEffect(() => {
    if (prevSig.current !== sig) {
      prevSig.current = sig;
      setExpanded(true);
      setUserTouched(false);
    }
  }, [sig]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: sig 是刻意的——项集变化要重新起 3s 计时。
  useEffect(() => {
    if (!expanded || userTouched || hasRunning) return;
    const id = setTimeout(() => setExpanded(false), AUTO_COLLAPSE_MS);
    return () => clearTimeout(id);
  }, [expanded, userTouched, sig, hasRunning]);

  useEffect(() => {
    if (!hasRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasRunning]);

  // 计时起点(H-12):协议没有 startedAt,只能取「本页首次观察到」与「服务端最后更新」中更早的
  // —— 刷新后不再从 00:00 重来,但仍可能偏晚;title 里如实说明。
  useEffect(() => {
    const ids = new Set(visible.map((item) => item.jobId));
    for (const id of startedAtRef.current.keys()) {
      if (!ids.has(id)) startedAtRef.current.delete(id);
    }
    const seen = Date.now();
    for (const item of visible) {
      if (isTerminalDelegateState(item.state)) continue;
      if (!startedAtRef.current.has(item.jobId)) {
        const anchor = item.updatedAt > 0 ? Math.min(seen, item.updatedAt) : seen;
        startedAtRef.current.set(item.jobId, anchor);
      }
    }
  }, [visible]);

  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const overflow = useHudListOverflow(listRef, [sig, expanded]);

  if (visible.length === 0) return null;

  const toggle = () => {
    setUserTouched(true);
    setExpanded((v) => !v);
  };
  const dismissAll = () => {
    for (const item of terminal) onDismiss(item.jobId);
  };

  const elapsedMs = latestRunning
    ? now - (startedAtRef.current.get(latestRunning.jobId) ?? now)
    : 0;
  const elapsed = hasRunning && latestRunning ? formatElapsed(elapsedMs) : "";
  const summaryGoal = summaryItem ? firstLine(summaryItem.goal) || summaryItem.goal : "";
  const summaryName = summaryItem
    ? agentDisplayName(summaryItem.agentId) || summaryItem.agentId
    : "";
  // 头部计数(H-03):「N 进行中」/「N 已结束」,不再是语义不明的 live/visible 分式。
  const headline =
    live.length > 0 ? `后台任务 ${live.length} 进行中` : `后台任务 ${terminal.length} 已结束`;

  return (
    <div className="mx-auto mb-2 w-full max-w-3xl px-4">
      <div className="overflow-hidden rounded-lg border border-border bg-elevated shadow-soft">
        <div className="flex min-h-11 w-full items-center gap-2 px-3 py-2 transition-colors hover:bg-hover">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={expanded}
            aria-controls={expanded ? listId : undefined}
            className={cn(
              "flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md text-left",
              HUD_TOGGLE_CLS,
            )}
          >
            <Bot className="size-4 shrink-0 text-accent" aria-hidden />
            <span className="sr-only">{expanded ? "折叠后台任务列表" : "展开后台任务列表"}</span>
            <span className="shrink-0 text-xs font-medium text-muted">{headline}</span>
            {/* 折叠摘要(H-02):状态标 → 名字(窄屏隐藏)→ 目标(唯一可收缩项)→ 计时(在 truncate 之外)。 */}
            {!expanded && summaryItem && (
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-body text-fg">
                <StatusMark state={summaryItem.state} className="size-3" />
                <span className="hidden shrink-0 text-muted sm:inline">{summaryName}</span>
                <span className="min-w-0 flex-1 truncate" title={summaryItem.goal}>
                  {summaryGoal}
                </span>
                {/* 计时在窄屏让位给目标文本(390px 下头部同时挤着计数 / 目标 / 停止本轮)。 */}
                {elapsed ? (
                  <span
                    className="hidden shrink-0 tabular-nums text-faint sm:inline"
                    title="运行时长（自本页观察到该任务起算）"
                  >
                    {elapsed}
                  </span>
                ) : null}
              </span>
            )}
            {expanded && <span className="flex-1" />}
            {expanded ? (
              <ChevronDown className="size-4 shrink-0 text-faint" aria-hidden />
            ) : (
              <ChevronUp className="size-4 shrink-0 text-faint" aria-hidden />
            )}
          </button>
          {hasRunning && onStop ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                onStop();
              }}
              aria-label="停止本轮"
            >
              <span className="sm:hidden">停止</span>
              <span className="hidden sm:inline">停止本轮</span>
            </Button>
          ) : null}
          {/* 全部结束且 ≥2 条时一键清除(H-13):逐个 onDismiss,不改 App 接线。 */}
          {!hasRunning && live.length === 0 && terminal.length >= 2 ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                dismissAll();
              }}
            >
              全部知道了
            </Button>
          ) : null}
        </div>
        {expanded && (
          <div
            id={listId}
            ref={listRef}
            onScroll={overflow.onScroll}
            className={cn(HUD_LIST_CLS, overflow.fadeCls)}
          >
            {visible.map((item) => (
              <DelegateRow key={item.jobId} item={item} onDismiss={onDismiss} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
