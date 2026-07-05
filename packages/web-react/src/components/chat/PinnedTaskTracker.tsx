/**
 * 固定在对话输入框上方的「任务列表」HUD。
 *
 * 取代 inline 的 TodoWrite 工具卡(后者会随消息流滚走):把当前任务列表钉在 composer 上方,
 * 始终可见。交互按 boss 要求:任务集首次出现/变化时**展开全部**,随后 ~3s **自动折叠**成
 * 只显示「正在执行的一条」;用户点击可手动展开/折叠(手动后不再自动折叠)。无未完成任务
 * (全部完成或无任务)→ 直接不渲染:不留"完成"残条,打开旧会话也不会闪一下。
 *
 * 数据来自上层从 wsMessages 提取的最新顶层 TodoWrite todos 或 Codex structured plan steps
 * (replace 语义,最后一次=权威)。
 */
import { Check, ChevronDown, ChevronUp, Circle, ListChecks, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../lib/chat/model";
import { cn } from "../../lib/utils";
import { asArr, asStr, resolveToolInput } from "../tool/format";
import { currentTurnStartIndex } from "./turnSegment";

export type TodoItem = { content: string; status: string; activeForm?: string };

function normalizePlanStatus(status: string): string {
  if (status === "completed") return "completed";
  if (status === "inProgress" || status === "in_progress") return "in_progress";
  return "pending";
}

function normalizePlanSteps(steps: unknown): TodoItem[] {
  const raw = asArr(steps);
  return raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object" && !Array.isArray(s))
    .map((s) => ({
      content: asStr(s.step) || asStr(s.text) || asStr(s.description),
      status: normalizePlanStatus(asStr(s.status)),
      activeForm: asStr(s.activeForm),
    }))
    .filter((t) => t.content || t.activeForm);
}

function normalizeTodoItems(todos: unknown): TodoItem[] {
  const raw = asArr(todos);
  return raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object" && !Array.isArray(t))
    .map((t) => ({ content: asStr(t.content), status: asStr(t.status) || "pending", activeForm: asStr(t.activeForm) }))
    .filter((t) => t.content || t.activeForm);
}

/**
 * 从**当前活跃段**(最后一条 user 消息之后,即当前 turn;判定收口 turnSegment.ts,与
 * MessageRenderer 的历史段抑制共用同一函数)提取最新顶层任务源(主 agent 的任务列表;
 * replace 语义,最后一次即权威)。任务源包括:
 *   1. CCB/legacy TodoWrite tool 的 todos;
 *   2. Codex app-server structured `role:"plan"` 的 steps。
 *
 * 归属判定走内容轴(任务集是否属于当前轮)而非时间轴(是否在发送)——全历史反向扫描
 * 会让几十轮前的旧任务在下一轮无关提问时复活钉在输入框上。多轮连续任务场景自然成立:
 * agent 下轮继续更新同一 todo 列表时,新 turn 里有新的 TodoWrite 块。
 * 子 agent 的 TodoWrite 是 agent-group 子块,不进主 HUD。反向扫描,命中最近的结构化
 * 任务源即返回；text-only plan 没有 steps,继续保留 inline PlanCard 兜底。
 */
export function extractLatestTodos(messages: ChatMessage[]): TodoItem[] {
  const turnStart = currentTurnStartIndex(messages);
  for (let i = messages.length - 1; i >= turnStart; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "plan" && Array.isArray(m.steps)) {
      return normalizePlanSteps(m.steps);
    }
    if (m.role !== "tool" || m.toolName !== "TodoWrite") continue;
    const input = resolveToolInput(m);
    return normalizeTodoItems(input?.todos);
  }
  return [];
}

const AUTO_COLLAPSE_MS = 3000;

function isDone(t: TodoItem): boolean {
  return t.status === "completed";
}

function TodoRow({ t, compact }: { t: TodoItem; compact?: boolean }) {
  const done = t.status === "completed";
  const active = t.status === "in_progress";
  const text = active && t.activeForm ? t.activeForm : t.content;
  return (
    <div className={cn("flex items-start gap-2", compact ? "text-[13px]" : "text-[13px]")}>
      <span className="mt-px shrink-0">
        {done ? (
          <Check className="size-3.5 text-success" />
        ) : active ? (
          <LoaderCircle className="size-3.5 animate-spin text-accent" />
        ) : (
          <Circle className="size-3.5 text-faint" />
        )}
      </span>
      <span className={cn("min-w-0 break-words", done ? "text-faint line-through" : active ? "text-fg" : "text-muted")}>
        {text}
      </span>
    </div>
  );
}

export function PinnedTaskTracker({ todos, active }: { todos: TodoItem[]; active: boolean }) {
  const total = todos.length;
  const doneCount = todos.filter(isDone).length;
  const hasIncomplete = todos.some((t) => !isDone(t));
  // 「正在执行的一条」:优先 in_progress,否则第一条未完成(即将执行)。仅在有未完成任务时
  // 渲染,故 active 必非空。
  const activeTodo = todos.find((t) => t.status === "in_progress") ?? todos.find((t) => !isDone(t)) ?? null;
  // 任务集签名(只看内容,状态变化不触发重展开,避免每完成一条就闪一下)。
  const sig = todos.map((t) => t.content).join("");

  const [expanded, setExpanded] = useState(true);
  const [userTouched, setUserTouched] = useState(false);
  const prevSig = useRef(sig);
  const prevActive = useRef(active);

  // 任务集变化 / 新 turn 开始 → 重新展开全部、复位用户态。
  useEffect(() => {
    const becameActive = !prevActive.current && active;
    if (prevSig.current !== sig || becameActive) {
      prevSig.current = sig;
      setExpanded(true);
      setUserTouched(false);
    }
    prevActive.current = active;
  }, [sig, active]);

  // 展开后 ~3s 自动折叠(用户未手动干预时)。非运行态不启动计时器,避免旧会话
  // 隐藏 HUD 时悄悄改变下一轮初始展开状态。
  useEffect(() => {
    if (!active || !expanded || userTouched) return;
    const id = setTimeout(() => setExpanded(false), AUTO_COLLAPSE_MS);
    return () => clearTimeout(id);
  }, [active, expanded, userTouched, sig]);

  // 只在当前 turn 仍在执行时显示。停止/收尾/打开旧会话后,历史 plan/TodoWrite
  // 可能仍保留 pending/in_progress 状态用于 transcript,但不能继续钉在输入框上方误导用户。
  if (!active) return null;
  // 只在有未完成任务时显示:全部完成(或无任务)即隐藏,不留"完成"残条、不在打开旧会话时闪。
  if (!hasIncomplete) return null;

  const toggle = () => {
    setUserTouched(true);
    setExpanded((v) => !v);
  };

  return (
    <div className="mx-auto mb-2 w-full max-w-3xl px-4">
      <div className="overflow-hidden rounded-lg border border-border bg-elevated shadow-soft">
        {/* 头部:进度 + 折叠态显示「正在执行的一条」+ 展开/折叠 chevron */}
        <button
          type="button"
          onClick={toggle}
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-hover"
        >
          <ListChecks className="size-4 shrink-0 text-accent" />
          <span className="shrink-0 text-xs font-medium text-muted">
            任务 {doneCount}/{total}
          </span>
          {!expanded && activeTodo && (
            <span className="min-w-0 flex-1 truncate text-[13px] text-fg">
              <span className="inline-flex items-center gap-1.5">
                {activeTodo.status === "in_progress" ? (
                  <LoaderCircle className="size-3 shrink-0 animate-spin text-accent" />
                ) : (
                  <Circle className="size-3 shrink-0 text-faint" />
                )}
                {activeTodo.status === "in_progress" && activeTodo.activeForm ? activeTodo.activeForm : activeTodo.content}
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
        {/* 展开:全部任务 */}
        {expanded && (
          <div className="flex max-h-52 flex-col gap-1.5 overflow-y-auto border-t border-border px-3 py-2">
            {todos.map((t, i) => (
              <TodoRow key={`${i}-${t.content.slice(0, 24)}`} t={t} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
