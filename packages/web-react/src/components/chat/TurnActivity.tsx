/**
 * 「本轮活动指示」—— 取代裸三个点（TypingDots），把模型慢时的**阶段反馈**显性化。
 *
 * 动机（用户报障①）：模型慢时前台只有三个跳动的点、没有任何阶段信息，用户无从判断是
 * 卡死还是仍在思考。lib/chat/pure.ts 早已备好一整套阶段文案（computeTypingLabel：思考中 /
 * 正在生成内容 / 深度思考中 / 处理时间较长仍在思考 / 正在压缩上下文），却是全仓零消费的
 * 死代码。本组件激活它：自带 1s tick，读会话级 turn 计时（_turnStartedAt / _lastFrameAt /
 * _turnStatus）算出经过秒数与静默时长，渲染对应阶段文案 + 圆点。
 *
 * 两个渲染点复用同一组件（MessageList 末尾的独立指示 + AssistantCard 流式空正文分支），
 * 语义一致、不再各写一份三个点。
 */
import { useEffect, useState } from "react";
import { AUTOMATIC_TURN_RETRY_MAX } from "@openclaude/protocol";
import type { TodoItem } from "./PinnedTaskTracker";
import {
  isRetryingTurnStatus,
  type RecoveryStatusState,
  type TurnStatusState,
} from "../../lib/chat/model";
import { computeTypingLabel } from "../../lib/chat/pure";
import { cn } from "../../lib/utils";

/**
 * 喂给 TurnActivity 的会话级快照（由 App 从当前活跃会话 + 当前 agent 派生）。刻意是「值快照」
 * 而非直接传 ChatSession：组件只读这几个字段，且 startedAt/turnStatus 相对稳定、秒数靠内部
 * tick 推进，无需把整个会话对象拖进渲染依赖。
 */
export type TurnActivityInfo = {
  /** 本轮开始时刻（_turnStartedAt）。null 时退化为无秒数的「思考中」。 */
  startedAt: number | null;
  /** 最近一帧到达时刻（_lastFrameAt），用于静默时长升级文案。 */
  lastFrameAt?: number;
  /** Cursor keepalive working-detail；展示前会收成中文动作标签，卡住时由 silenceMs 盖过。 */
  progressHint?: string;
  /** turn 非流式阶段态(判别联合,单一权威 model.ts TurnStatusState):
   *  'compacting' → 「正在压缩上下文」;{kind:'retrying'} → 统一自动重试文案。 */
  turnStatus?: TurnStatusState | null;
  /** Browser/service recovery stays in this existing activity row instead of
   * creating a second card or action surface above the composer. */
  recoveryStatus?: RecoveryStatusState | null;
  /** Units first pack already painted; retrying/waiting-service must not keep
   * the "正在恢复实时内容…" copy. */
  hasVisibleProcess?: boolean;
  /** 容器冷启（sys.cold_start）：typing 文案追加「容器首次加载中」后缀。 */
  coldStart?: boolean;
  /** 显示用 agent 名（如「主助手」「编程助手」）。 */
  agentName: string;
  /** 团队模式：队长当前正在执行的 plan step 文本（非团队模式恒 null，由 App 门控）。 */
  leaderStep?: string | null;
};

/**
 * 从任务列表（HUD 同源，PinnedTaskTracker.extractLatestTodos 的产物）推导「当前正在执行的
 * 一步」：优先 in_progress（取 activeForm 进行时文案），否则第一条未完成（即将执行）。
 * 纯函数、无 React，供 App 门控（仅团队模式）与单测复用；**不改 PinnedTaskTracker**。
 */
export function deriveActivePlanStep(todos: TodoItem[]): string | null {
  if (!todos || todos.length === 0) return null;
  const active = todos.find((t) => t.status === "in_progress");
  if (active) return (active.activeForm || active.content || "").trim() || null;
  const next = todos.find((t) => t.status !== "completed");
  return next ? (next.content || "").trim() || null : null;
}

function ActivityDots() {
  // 与 cards.tsx 的 TypingDots 视觉一致；此处内联三点避免 cards ↔ TurnActivity 循环 import。
  return (
    <span className="flex items-center gap-1.5" aria-hidden>
      <span className="size-2 animate-pulse rounded-full bg-muted" />
      <span className="size-2 animate-pulse rounded-full bg-muted [animation-delay:200ms]" />
      <span className="size-2 animate-pulse rounded-full bg-muted [animation-delay:400ms]" />
    </span>
  );
}

export function TurnActivity({ info }: { info: TurnActivityInfo }) {
  // 自带 1s tick 推进秒数/静默时长；组件只在流式态挂载，卸载即清 interval。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const started = info.startedAt ?? info.lastFrameAt ?? now;
  const secs = Math.max(0, Math.round((now - started) / 1000));
  const silenceMs = info.lastFrameAt ? Math.max(0, now - info.lastFrameAt) : 0;

  // 自动重试软提示优先级最高。所有底座/跨 turn 恢复只呈现这一行，不再各自
  // 插 assistant notice、synthetic user bubble 或倒计时变体。
  const retry = isRetryingTurnStatus(info.turnStatus) ? info.turnStatus : null;
  const recoveryKind = info.recoveryStatus?.kind;

  let text: string;
  let cls = "";
  if (recoveryKind === "stopping") {
    text = "正在停止…";
    cls = "stopping";
  } else if (retry) {
    text = `模型繁忙，正在重试中（${retry.attempt}/${AUTOMATIC_TURN_RETRY_MAX}）`;
    cls = "retrying";
  } else if (
    (recoveryKind === "waiting-service" || recoveryKind === "retrying") &&
    !info.hasVisibleProcess
  ) {
    text = "正在恢复实时内容…";
    cls = "recovering";
  } else if (info.turnStatus === "engine_starting" || info.turnStatus === "engine_resuming") {
    // 引擎冷启动可见化:进程 spawn / 会话恢复期间不再显示误导性的「思考中」。
    ({ text, cls } = computeTypingLabel({
      name: info.agentName,
      secs,
      silenceMs,
      turnStatus: info.turnStatus,
    }));
  } else if (info.turnStatus === "compacting") {
    // 压缩上下文（即便团队模式）：computeTypingLabel 产出「正在压缩上下文 (Xs)」。
    ({ text, cls } = computeTypingLabel({ name: info.agentName, secs, silenceMs, turnStatus: "compacting" }));
  } else if (info.turnStatus === "waiting_for_user") {
    text = "等待你确认后继续";
    cls = "waiting-for-user";
  } else if (info.leaderStep) {
    // 团队模式：消息区常长时间纯空白（队长在委派/编排），用队长当前 step 填充等待文案。
    text = `队长正在执行:${info.leaderStep}${secs >= 5 ? ` (${secs}s)` : ""}`;
  } else {
    const hint = info.coldStart ? "（容器首次加载中）" : "";
    ({ text, cls } = computeTypingLabel({
      name: info.agentName,
      secs,
      silenceMs,
      hint,
      progressHint: info.progressHint,
    }));
  }

  return (
    <div
      className={cn("flex items-center gap-2 py-1 text-[13px]", retry ? "text-warning" : "text-muted", cls)}
      aria-label="生成中"
      aria-live="polite"
    >
      <ActivityDots />
      <span className="min-w-0 break-words">{text}</span>
    </div>
  );
}
