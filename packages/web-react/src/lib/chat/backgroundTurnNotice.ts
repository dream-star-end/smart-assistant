/**
 * 后台回合提示条与「继续」软确认的判定和文案(B4-SPEC §3.2–§3.5,UXE-B4a,纯函数)。
 *
 * 用户切回一个还在跑的长回合时,会追问「又停了？」、催「继续」、换会话找别人接手。
 * 再发的消息不会并行、也不会打断本轮:前端单槽 FIFO 加容器 session.lock 把它排到本轮之后,
 * 作为一整轮新回合执行并单独计费。提示条只讲这个后果。
 *
 * 合并规则(§3.4):本轮处于什么阶段(「后台运行中」「深度思考中」「启动引擎」「连接已断开」)
 * 只由 TurnActivity 那一行说;提示条仅在已有排队消息时显示,平时无排队消息时不弹出打扰。
 * 积分(「本轮已扣 N 积分」)来自统一快照的实扣结算(B4b),只说已扣,不估算。
 */
import type { BackgroundSendKind } from "./continuationNudge";
import type { ChatSession } from "./model";
import type { ChatStatusClass } from "./pure";
import { TURN_COST_REMINDER_CREDITS } from "./reducer";
import { formatCredits } from "../utils";
import type { DispatchStatus } from "./socket";

/** 独立后台回合提示条已并入 QueuedSendList，不再保留 10 秒残影。 */
export const BACKGROUND_TURN_HOLD_MS = 0;
/** 提示条复检节拍（保留导出以兼容上游 hook）。 */
export const BACKGROUND_TURN_TICK_MS = 5_000;

export const BACKGROUND_TURN_TEXT = "本轮仍在运行。现在发送的消息会等本轮结束后再发出，另行计费。";
export const BACKGROUND_TURN_TEXT_COMPACT = "本轮仍在运行；新消息会等它结束再发，另行计费。";

export type BackgroundTurnNoticeView = { text: string; compact: boolean; tone?: "info" | "warning" };

/**
 * 本轮已被服务端受理、还没有终态,也不在停止结算中。受理前(dispatch 非 null)活动行
 * 说的是「正在发送…」,不算在跑。
 */
export function isBackgroundTurnOpen(
  sess: Pick<ChatSession, "_sendingInFlight" | "_stopSettlement"> | undefined,
  dispatch: DispatchStatus | null,
): boolean {
  return !!sess?._sendingInFlight && !sess._stopSettlement && dispatch === null;
}

/** 距本轮最近一帧(没有帧时按受理时刻)多久没有新数据。 */
export function turnSilenceMs(
  sess: Pick<ChatSession, "_lastFrameAt" | "_turnStartedAt">,
  now: number,
): number {
  return Math.max(0, now - (sess._lastFrameAt ?? sess._turnStartedAt ?? now));
}

export type BackgroundTurnFacts = {
  turnOpen: boolean;
  transport: ChatStatusClass;
  /** isTurnDetached:hello 快照说过本轮在后台跑,之后还没有新帧。 */
  detached: boolean;
  silenceMs: number;
  /** 本会话「待发送」条数。 */
  queuedCount: number;
  /** 本轮已结算实扣(快照 credits.settled),没有就不参与。 */
  creditsSettled?: string;
};

/** (d) 实扣积分到了现有成本提醒的触发线。 */
export function creditsAtReminderLine(settled: string | undefined): boolean {
  return !!settled && /^[0-9]+$/.test(settled) && BigInt(settled) >= TURN_COST_REMINDER_CREDITS;
}

/**
 * B4-SPEC §3.3:只认当前在飞回合那份快照积分;无请求或为 0 不显示。收到超过 60 秒标出截至时间
 * (按本地收到时刻算,避开时钟偏差)。
 */
export function turnCreditsLine(
  sess: Pick<ChatSession, "_turnCredits" | "_activeClientMessageId">,
  now: number,
  compact: boolean,
): string | null {
  const c = sess._turnCredits;
  if (!c || c.clientMessageId !== sess._activeClientMessageId || c.requests < 1 || !/^[1-9][0-9]*$/.test(c.settled)) {
    return null;
  }
  const minutes = Math.floor((now - c.receivedAt) / 60_000);
  const asOf = minutes >= 1 ? (compact ? `（${minutes} 分钟前）` : `（截至 ${minutes} 分钟前）`) : "";
  return `本轮已扣 ${formatCredits(c.settled)} 积分${asOf}`;
}

/** 独立后台回合横幅已退场（合并至 QueuedSendList 副标题 + TurnCostReminder 独立承接）。 */
export function backgroundTurnTriggered(_f: BackgroundTurnFacts): boolean {
  return false;
}

/**
 * 显隐判定：独立横幅与 10 秒残影均已移除，统一返回隐藏。
 * 保留函数签名以兼容 `useBackgroundTurn`（`guardSend` 软确认继续独立有效）。
 */
export function decideBackgroundTurnNotice(
  _f: BackgroundTurnFacts & { lastTriggerAt: number | null; now: number },
): { visible: boolean; lastTriggerAt: number | null } {
  return { visible: false, lastTriggerAt: null };
}

export function backgroundTurnNoticeText(compact: boolean, creditsLine?: string | null): string {
  const text = compact ? BACKGROUND_TURN_TEXT_COMPACT : BACKGROUND_TURN_TEXT;
  return creditsLine ? `${creditsLine}，${text.slice("本轮".length)}` : text;
}

/** 正在运行的那条用户消息的原文(找不到就不做重复判定)。 */
export function runningUserText(
  sess: Pick<ChatSession, "messages" | "_activeClientMessageId">,
): string | undefined {
  const cmid = sess._activeClientMessageId;
  if (!cmid) return undefined;
  return sess.messages.find(
    (m) => m.role === "user" && (m.id === cmid || m._clientMessageId === cmid),
  )?.text;
}

/** §3.5 软确认的文案;选「排队发送」照常发送,选「先不发」保留草稿。 */
export function backgroundSendConfirm(
  kind: BackgroundSendKind,
  text: string,
  connected: boolean,
): { title: string; body: string; confirmText: string; cancelText: string } {
  const actions = { confirmText: "排队发送", cancelText: "先不发" };
  if (kind === "duplicate") {
    return {
      title: "这条和正在运行的那条相同",
      body: "重复发送不会让它更快，只会在它结束后再跑一轮，另行计费。",
      ...actions,
    };
  }
  return {
    title: connected ? "本轮还在运行，确定再发一条？" : "本轮可能还在运行，确定再发一条？",
    body: `现在发送「${text.trim()}」不会让它更快，只会在它结束后再开一轮，另行计费。可以先等本轮结束。`,
    ...actions,
  };
}
