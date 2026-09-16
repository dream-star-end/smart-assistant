/**
 * 固定在对话输入框上方的「任务列表」HUD。
 *
 * 取代 inline 的 TodoWrite 工具卡(后者会随消息流滚走):把当前任务列表钉在 composer 上方,
 * 始终可见。交互按 boss 要求:任务集首次出现/变化时**展开全部**,随后 ~3s **自动折叠**成
 * 只显示「正在执行的一条」;用户点击可手动展开/折叠(手动后不再自动折叠)。无未完成任务
 * (全部完成或无任务)→ 直接不渲染:不留"完成"残条。
 *
 * 渲染三态(收口判据,修复 d18bd587 去掉 active 门后 HUD 永久钉住的缺陷):
 *  1. 在飞(active)→ 钉住:turn 进行中任务列表始终可见;
 *  2. 刷新后仍在飞(active=false 且无终态证据:openDispatch 恢复 sending 或消息层无收口
 *     标记)→ 钉住:保留 d18bd587 的初衷,刷新不打断任务追踪;
 *  3. turn 收口 → 隐藏,inline 只读 TodoWrite/plan 卡兜底(MessageRenderer 在
 *     `inActiveTurn && sending` 为假时渲染 inline 卡,翻历史仍可见)。收口证据两路任一:
 *     a) live 下降沿:组件挂载期间 active 出现 true→false(同一任务集内);
 *     b) 消息层证据:App 传入 settled=currentTurnSettled(wsMessages)(刷新/重开会话场景,
 *        此时 active 一直 false,没有下降沿可看)。
 *
 * 数据来自上层从 wsMessages 提取的最新顶层 TodoWrite todos 或 Codex structured plan steps
 * (replace 语义,最后一次=权威)。
 */
import type { TurnTokenUsageSnapshot } from "@openclaude/protocol/frames";
import { Check, ChevronDown, ChevronUp, Circle, ListChecks, LoaderCircle } from "lucide-react";
import { type RefObject, useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChatMessage } from "../../lib/chat/model";
import { cn } from "../../lib/utils";
import { asArr, asStr, resolveToolInput } from "../tool/format";
import { TokenUsageBadge } from "./tokenUsage";
import { currentTurnStartIndex } from "./turnSegment";

/**
 * 两枚 HUD 共用的头部切换按钮样式(H-05):外层容器 `overflow-hidden rounded-lg` 会把画在
 * 盒外的浏览器默认 outline 裁掉,键盘焦点看不见 —— 焦点环必须 inset。
 */
export const HUD_TOGGLE_CLS =
  "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/**
 * 两枚 HUD 共用的展开列表高度上限(H-06):桌面维持 13rem(208px);窄屏(<sm)降到 9rem(≈4 行,
 * 其余靠滚动 + 底部渐隐提示);任何视口再按 30% 视口封顶 —— 两枚同时展开在 390×844 曾吃掉约六成
 * 屏幕,横屏手机(高 390)直接盖住对话区。
 */
export const HUD_LIST_CLS =
  "flex max-h-[min(13rem,30dvh)] max-sm:max-h-[min(9rem,30dvh)] flex-col gap-1.5 overflow-y-auto border-t border-border px-3 py-2";

/** 列表底部还有内容时的渐隐提示(H-17);滚到底自动消失。 */
const HUD_LIST_FADE_CLS =
  "[mask-image:linear-gradient(to_bottom,black_calc(100%-1.75rem),transparent)]";

/**
 * 列表是否还有未滚到的内容(H-17):挂载 / 内容变化 / 滚动 / 尺寸变化时重新量。
 * 返回的 fadeCls 直接拼进列表 class,onScroll 挂到列表上。
 */
export function useHudListOverflow(
  ref: RefObject<HTMLElement | null>,
  deps: readonly unknown[],
): { fadeCls: string; onScroll: () => void } {
  const [overflowing, setOverflowing] = useState(false);
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setOverflowing(el.scrollHeight - el.clientHeight - el.scrollTop > 4);
  }, [ref]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps 由调用方给出(内容签名),内容变了才重量。
  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, ...deps]);
  return { fadeCls: overflowing ? HUD_LIST_FADE_CLS : "", onScroll: measure };
}

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

function TodoRow({ t }: { t: TodoItem }) {
  const done = t.status === "completed";
  const active = t.status === "in_progress";
  const text = active && t.activeForm ? t.activeForm : t.content;
  return (
    <div className="flex items-start gap-2 text-body">
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

export function PinnedTaskTracker({
  todos,
  active,
  settled = false,
  tokenUsage,
}: {
  todos: TodoItem[];
  active: boolean;
  /** 消息层终态证据(App 传 currentTurnSettled(wsMessages)):刷新/重开会话时没有 live 下降沿,靠它判收口。 */
  settled?: boolean;
  tokenUsage?: TurnTokenUsageSnapshot;
}) {
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

  // live 收口:组件挂载期间 active 出现 true→false 的下降沿(同一任务集内)。必须在渲染期
  // 检测而非 useEffect —— 否则收口这一帧已按旧值渲染,HUD 会多钉一帧。sig 变化(新任务集)
  // 或 active 重新变 true(新 turn)时复位;每次重渲染幂等(StrictMode 双渲染安全)。
  const endedLiveRef = useRef(false);
  const liveSigRef = useRef<string | null>(null);
  const liveActiveRef = useRef<boolean | null>(null);
  if (liveSigRef.current !== sig) {
    liveSigRef.current = sig;
    endedLiveRef.current = false;
  }
  if (liveActiveRef.current === true && active === false) {
    endedLiveRef.current = true;
  }
  if (active) endedLiveRef.current = false;
  liveActiveRef.current = active;
  // 在飞优先:active 时即使旧行残留终态标记(settled 误报)也不算收口。
  const turnSettled = !active && (endedLiveRef.current || settled);
  // 渲染门:有未完成任务且本轮未收口(三态见文件头)。刷新后当前轮仍在飞
  // (openDispatch 恢复 sending 或无终态证据 → turnSettled=false)→ 钉住,保留 d18bd587 行为;
  // 打开已收口旧会话时 extractLatestTodos 拿不到当前段未完成项,hasIncomplete=false,不会误闪。
  const visible = hasIncomplete && !turnSettled;

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

  // 展开后 ~3s 自动折叠(用户未手动干预时)。以「HUD 可见」为门而非 active(H-11):
  // 刷新后仍在飞(active=false、settled=false)同样要折叠,否则永久展开占位;
  // HUD 隐藏时不计时,新任务集 / 新 turn 到来由上面的 effect 重新展开。
  // biome-ignore lint/correctness/useExhaustiveDependencies: sig 是刻意的——任务集变化要重新起 3s 计时。
  useEffect(() => {
    if (!visible || !expanded || userTouched) return;
    const id = setTimeout(() => setExpanded(false), AUTO_COLLAPSE_MS);
    return () => clearTimeout(id);
  }, [visible, expanded, userTouched, sig]);

  // aria-controls 只在列表真的渲染时输出(H-08);id 用 useId 防多实例重复。
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const overflow = useHudListOverflow(listRef, [sig, expanded, visible]);

  if (!visible) return null;

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
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          className={cn(
            "flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-hover",
            HUD_TOGGLE_CLS,
          )}
        >
          <ListChecks className="size-4 shrink-0 text-accent" aria-hidden />
          {/* 读屏补齐动作名(H-09);术语与 inline 工具卡(tool/meta.ts「任务列表」)一致(H-10)。 */}
          <span className="sr-only">{expanded ? "折叠任务列表" : "展开任务列表"}</span>
          <span className="shrink-0 text-xs font-medium text-muted">
            任务列表 {doneCount}/{total}
          </span>
          {!expanded && activeTodo && (
            <span className="min-w-0 flex-1 truncate text-body text-fg">
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
          <TokenUsageBadge usage={tokenUsage} />
          {expanded ? (
            <ChevronDown className="size-4 shrink-0 text-faint" aria-hidden />
          ) : (
            <ChevronUp className="size-4 shrink-0 text-faint" aria-hidden />
          )}
        </button>
        {/* 展开:全部任务 */}
        {expanded && (
          <div
            id={listId}
            ref={listRef}
            onScroll={overflow.onScroll}
            className={cn(HUD_LIST_CLS, overflow.fadeCls)}
          >
            {todos.map((t, i) => (
              <TodoRow key={`${i}-${t.content.slice(0, 24)}`} t={t} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
