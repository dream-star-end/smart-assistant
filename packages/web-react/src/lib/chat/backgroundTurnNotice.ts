/**
 * 后台回合提示条与「继续」软确认的判定和文案(B4-SPEC §3.2–§3.5,UXE-B4a,纯函数)。
 *
 * 用户切回一个还在跑的长回合时,会追问「又停了？」、催「继续」、换会话找别人接手。
 * 再发的消息不会并行、也不会打断本轮:前端单槽 FIFO 加容器 session.lock 把它排到本轮之后,
 * 作为一整轮新回合执行并单独计费。提示条只讲这个后果。
 *
 * 合并规则(§3.4):本轮处于什么阶段(「后台运行中」「深度思考中」「启动引擎」「连接已断开」)
 * 只由 TurnActivity 那一行说;提示条不复述阶段,detached 的出现与消失直接跟 isTurnDetached 走,
 * 所以 #1198 的「后台运行中」与本提示条是同一件事的一处说明,不会出现第二条同义提示。
 * 积分(「本轮已扣 N 积分」)由 B4b 从统一快照接入,这一版不带数字。
 */
import type { BackgroundSendKind } from "./continuationNudge";
import type { ChatSession } from "./model";
import { type ChatStatusClass, STALE_WARN_MS } from "./pure";
import type { DispatchStatus } from "./socket";

/** 触发条件全部消失后,提示条再保留这么久,避免帧间隔在 30s 上下时来回闪。 */
export const BACKGROUND_TURN_HOLD_MS = 10_000;
/** 提示条自带的复检节拍:静默跨过 30s、保持期到点都靠它推进。 */
export const BACKGROUND_TURN_TICK_MS = 5_000;

export const BACKGROUND_TURN_TEXT = "本轮仍在运行。现在发送的消息会等本轮结束后再发出，另行计费。";
export const BACKGROUND_TURN_TEXT_COMPACT = "本轮仍在运行；新消息会等它结束再发，另行计费。";

export type BackgroundTurnNoticeView = { text: string; compact: boolean };

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
};

/** §3.2 触发 (a) detached、(b) 静默 ≥30s、(c) 已有排队消息。(d) 积分线随 B4b 加入。 */
export function backgroundTurnTriggered(f: BackgroundTurnFacts): boolean {
  return f.detached || f.silenceMs >= STALE_WARN_MS || f.queuedCount > 0;
}

/**
 * 显隐判定。断线时不显示:连接条和活动行已经说明了情况,而且断线期间无法确认本轮还在跑,
 * 说「仍在运行」就是撒谎。本轮结束、停止结算、断线都立即消失并清掉保持期。
 */
export function decideBackgroundTurnNotice(
  f: BackgroundTurnFacts & { lastTriggerAt: number | null; now: number },
): { visible: boolean; lastTriggerAt: number | null } {
  if (!f.turnOpen || f.transport !== "connected") return { visible: false, lastTriggerAt: null };
  if (backgroundTurnTriggered(f)) return { visible: true, lastTriggerAt: f.now };
  const held = f.lastTriggerAt !== null && f.now - f.lastTriggerAt < BACKGROUND_TURN_HOLD_MS;
  return { visible: held, lastTriggerAt: held ? f.lastTriggerAt : null };
}

export function backgroundTurnNoticeText(compact: boolean): string {
  return compact ? BACKGROUND_TURN_TEXT_COMPACT : BACKGROUND_TURN_TEXT;
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
