/**
 * 后台回合提示条 + 「继续」软确认的接线(B4-SPEC §3.2/§3.5,UXE-B4a)。
 *
 * 判定和文案在 lib/chat/backgroundTurnNotice.ts、lib/chat/continuationNudge.ts;这里只负责
 * 读会话状态、5 秒一次的复检节拍和 10 秒保持期,以及把 Composer 的发送包一层软确认。
 * App 只接线(App.tsx 余量有限,新逻辑不往里放)。
 */
import { useEffect, useRef, useState } from "react";
import type { ConfirmChoice, ConfirmOpts } from "../components/ui/ConfirmDialog";
import {
  BACKGROUND_TURN_TICK_MS,
  type BackgroundTurnNoticeView,
  backgroundSendConfirm,
  backgroundTurnNoticeText,
  decideBackgroundTurnNotice,
  isBackgroundTurnOpen,
  runningUserText,
  turnSilenceMs,
} from "../lib/chat/backgroundTurnNotice";
import { classifyBackgroundSend } from "../lib/chat/continuationNudge";
import { type ChatSession, isTurnDetached } from "../lib/chat/model";
import type { UseChatSocket } from "./useChatSocket";

export type UseBackgroundTurnInput = {
  chat: Pick<UseChatSocket, "status" | "dispatchStatus">;
  /** 当前会话(就地 mutation 的同一对象,App 随 chat.version 重渲)。 */
  sess: ChatSession | undefined;
  /** 非 demo、未被 gate 拦住。 */
  enabled: boolean;
  queuedCount: number;
  /** 窄屏(<md):短文案,进 Composer 的 banner 插槽。 */
  compact: boolean;
  confirm: (opts: ConfirmOpts) => Promise<ConfirmChoice>;
};

export function useBackgroundTurn({ chat, sess, enabled, queuedCount, compact, confirm }: UseBackgroundTurnInput) {
  const transport = chat.status.cls;
  const turnOpen = enabled && !!sess && isBackgroundTurnOpen(sess, chat.dispatchStatus(sess.id));
  // 保持期只对同一轮有效:换会话、换轮都从零算。
  const turnKey = turnOpen && sess ? `${sess.id}\u0000${sess._activeClientMessageId ?? ""}` : null;
  const holdRef = useRef<{ key: string; at: number } | null>(null);
  const evaluate = (now: number): boolean => {
    if (!sess || turnKey === null) {
      holdRef.current = null;
      return false;
    }
    const decision = decideBackgroundTurnNotice({
      turnOpen,
      transport,
      detached: isTurnDetached(sess),
      silenceMs: turnSilenceMs(sess, now),
      queuedCount,
      lastTriggerAt: holdRef.current?.key === turnKey ? holdRef.current.at : null,
      now,
    });
    holdRef.current = decision.lastTriggerAt === null ? null : { key: turnKey, at: decision.lastTriggerAt };
    return decision.visible;
  };
  const visible = evaluate(Date.now());
  const evaluateRef = useRef(evaluate);
  evaluateRef.current = evaluate;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (turnKey === null) return;
    // 帧、排队、连接变化都会让 App 重渲;只有「静默跨过 30s」和「保持期到点」要靠时间推进,
    // 显隐真的变了才触发重渲。
    const id = setInterval(() => {
      if (evaluateRef.current(Date.now()) !== visibleRef.current) setTick((t) => t + 1);
    }, BACKGROUND_TURN_TICK_MS);
    return () => clearInterval(id);
  }, [turnKey]);

  const notice: BackgroundTurnNoticeView | null = visible
    ? { text: backgroundTurnNoticeText(compact), compact }
    : null;

  /** 本轮在跑时,「继续」类或重复的消息先软确认;选「先不发」返回 false,Composer 保留草稿。 */
  const guardSend = async <T>(
    text: string,
    media: readonly unknown[] | undefined,
    run: () => T | Promise<T>,
  ): Promise<T | false> => {
    if (enabled && sess && isBackgroundTurnOpen(sess, chat.dispatchStatus(sess.id))) {
      const kind = classifyBackgroundSend({ text, hasMedia: !!media?.length, runningText: runningUserText(sess) });
      if (kind && (await confirm(backgroundSendConfirm(kind, text, chat.status.cls === "connected"))) !== true) {
        return false;
      }
    }
    return run();
  };

  return { notice, guardSend };
}
