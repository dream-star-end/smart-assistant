/**
 * 固定在对话输入框上方的「后台子任务」HUD。
 *
 * 与 PinnedTaskTracker 同层：组卡会随消息流滚走、刷新后过程树可能为空，本 HUD
 * 钉住 GET inflight-delegates 投影。父 turn 结束后只要还有 running 或未 dismiss
 * 的终态项就继续显示（这是后台任务的核心场景）。
 */
import { Bot, Check, ChevronDown, ChevronUp, LoaderCircle, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  isTerminalDelegateState,
  type InflightDelegateItem,
} from "../../lib/chat/inflightDelegates";
import { Button } from "../ui";
import { agentDisplayName } from "./agentNames";

const AUTO_COLLAPSE_MS = 3000;
const MAX_TERMINAL = 5;

function firstLine(text: string): string {
  const nl = text.search(/\r|\n/);
  return (nl === -1 ? text : text.slice(0, nl)).trim();
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function isRunningState(state: string): boolean {
  return state === "running";
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

function StatusMark({ state }: { state: string }) {
  if (state === "completed") {
    return <Check className="size-3.5 text-success" />;
  }
  if (state === "failed" || state === "cancelled" || state === "killed_by_cutover") {
    return <X className="size-3.5 text-danger" />;
  }
  return <LoaderCircle className="size-3.5 animate-spin text-accent" />;
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
  const summary = item.state === "completed" ? firstLine(item.resultSummary ?? "") : "";
  const name = agentDisplayName(item.agentId) || item.agentId;
  return (
    <div className="flex items-start gap-2 text-[13px]">
      <span className="mt-px shrink-0">
        <StatusMark state={item.state} />
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
          <div className="truncate text-faint" title={item.resultSummary}>
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
}: {
  items: InflightDelegateItem[];
  onDismiss: (jobId: string) => void;
}) {
  const visible = useMemo(() => visibleDelegateItems(items), [items]);
  const live = visible.filter((item) => !isTerminalDelegateState(item.state));
  const running = live.filter((item) => isRunningState(item.state));
  const latestRunning =
    (running.length > 0 ? running : live).slice().sort((a, b) => b.updatedAt - a.updatedAt)[0] ??
    null;
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

  useEffect(() => {
    if (!expanded || userTouched) return;
    const id = setTimeout(() => setExpanded(false), AUTO_COLLAPSE_MS);
    return () => clearTimeout(id);
  }, [expanded, userTouched, sig]);

  useEffect(() => {
    if (!hasRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasRunning]);

  useEffect(() => {
    const ids = new Set(visible.map((item) => item.jobId));
    for (const id of startedAtRef.current.keys()) {
      if (!ids.has(id)) startedAtRef.current.delete(id);
    }
    const seen = Date.now();
    for (const item of visible) {
      if (isTerminalDelegateState(item.state)) continue;
      if (!startedAtRef.current.has(item.jobId)) {
        startedAtRef.current.set(item.jobId, seen);
      }
    }
  }, [visible]);

  if (visible.length === 0) return null;

  const toggle = () => {
    setUserTouched(true);
    setExpanded((v) => !v);
  };

  const elapsedMs = latestRunning
    ? now - (startedAtRef.current.get(latestRunning.jobId) ?? now)
    : 0;
  const elapsed = hasRunning && latestRunning ? formatElapsed(elapsedMs) : "";
  const collapsedGoal = latestRunning ? firstLine(latestRunning.goal) || latestRunning.goal : "";
  const collapsedName = latestRunning
    ? agentDisplayName(latestRunning.agentId) || latestRunning.agentId
    : "";

  return (
    <div className="mx-auto mb-2 w-full max-w-3xl px-4">
      <div className="overflow-hidden rounded-lg border border-border bg-elevated shadow-soft">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          aria-controls="pinned-delegate-list"
          className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-hover"
        >
          <Bot className="size-4 shrink-0 text-accent" />
          <span className="shrink-0 text-xs font-medium text-muted">
            后台任务 {live.length}/{visible.length}
          </span>
          {!expanded && latestRunning && (
            <span className="min-w-0 flex-1 truncate text-[13px] text-fg">
              <span className="inline-flex max-w-full items-center gap-1.5">
                {isRunningState(latestRunning.state) ? (
                  <LoaderCircle className="size-3 shrink-0 animate-spin text-accent" />
                ) : (
                  <StatusMark state={latestRunning.state} />
                )}
                <span className="shrink-0 text-muted">{collapsedName}</span>
                <span className="min-w-0 truncate">{collapsedGoal}</span>
                {elapsed ? (
                  <span className="shrink-0 tabular-nums text-faint">{elapsed}</span>
                ) : null}
              </span>
            </span>
          )}
          {expanded && <span className="flex-1" />}
          {expanded ? (
            <ChevronDown className="size-4 shrink-0 text-faint" />
          ) : (
            <ChevronUp className="size-4 shrink-0 text-faint" />
          )}
        </button>
        {expanded && (
          <div
            id="pinned-delegate-list"
            className="flex max-h-52 flex-col gap-1.5 overflow-y-auto border-t border-border px-3 py-2"
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
