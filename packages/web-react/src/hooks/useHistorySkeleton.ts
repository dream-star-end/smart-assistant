import { useEffect, useState } from "react";
import { shouldShowHistorySkeleton } from "../components/chat/HistorySkeleton";
import {
  countSubstantiveHistoryMessages,
  type HistorySurface,
  isSubstantiveHistoryMessage,
  sessionHistorySurface,
} from "../lib/chat/historyLoadState";

export { countSubstantiveHistoryMessages, isSubstantiveHistoryMessage };

/**
 * 冷会话加载骨架（moved out of App.tsx, FINDINGS §7 step 3a, OCV5-466）。
 *
 * App.tsx 原先把两个截止计时器放在一处、把唯一消费它们的派生（activeMeta /
 * loadingHistory / historySurface）放在约 1000 行之后；这里收成一个 hook，在派生的原位置调用。
 *
 * 切换/深链到本地无缓存会话、getSession 拉取期间显示消息形骨架，取代「空白 → 突然填满」。
 * meta（messageCount）取自侧栏当前选中会话，metaKnown 需 listSessions 已落定且命中列表
 * （否则视为深链未决走 GRACE 兜底窗）。
 */

// 冷会话骨架屏窗口（见 HistorySkeleton.shouldShowHistorySkeleton）：
//  - GRACE：meta 未知（深链/列表未落定）时的兜底窗，过后放行 EmptyState。
//  - CAP：确知有历史但迟迟不到（getSession 慢/失败）的安全封顶，防骨架永停。
export const HISTORY_SKELETON_GRACE_MS = 800;
export const HISTORY_SKELETON_SLOW_MS = 5000;
export const HISTORY_SKELETON_CAP_MS = 8000;

export interface HistorySkeletonInput {
  demo: boolean;
  activeId: string | undefined;
  sessions: ReadonlyArray<{ id: string; messageCount?: number }>;
  gated: boolean;
  /** wsMessages.length */
  wsMessageCount: number;
  wsSending: boolean;
  /** demo 回放的本地消息数与忙碌态。 */
  demoMessageCount: number;
  demoBusy: boolean;
  serverListSettled: boolean;
  historyLoading: boolean;
  /** 当前会话 canonical history 是否已至少落定一次（成功或 404）。 */
  historySettled?: boolean;
  /** 非 null = 当前会话 canonical history 读取失败。 */
  historyError: unknown;
}

export function useHistorySkeleton(input: HistorySkeletonInput): {
  loadingHistory: boolean;
  historySurface: HistorySurface;
  slowHistory: boolean;
} {
  const { demo, activeId, sessions } = input;
  // activeId 变化即重置截止标记；GRACE 用于 meta 未知（深链）分支，CAP 是安全封顶，SLOW 触发慢网重试条。
  const [historyGraceExpired, setHistoryGraceExpired] = useState(false);
  const [historyCapExpired, setHistoryCapExpired] = useState(false);
  const [historySlow, setHistorySlow] = useState(false);
  useEffect(() => {
    setHistoryGraceExpired(false);
    setHistoryCapExpired(false);
    setHistorySlow(false);
    if (demo || !activeId) return;
    const t1 = setTimeout(() => setHistoryGraceExpired(true), HISTORY_SKELETON_GRACE_MS);
    const t2 = setTimeout(() => setHistoryCapExpired(true), HISTORY_SKELETON_CAP_MS);
    const t3 = setTimeout(() => setHistorySlow(true), HISTORY_SKELETON_SLOW_MS);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [demo, activeId]);

  const activeMeta = !demo && activeId ? sessions.find((s) => s.id === activeId) : undefined;
  const hasHistoryError = !demo && input.historyError !== null;
  const loadingHistory =
    !demo &&
    shouldShowHistorySkeleton({
      selected: !!activeId,
      gated: input.gated,
      cachedCount: input.wsMessageCount,
      sending: input.wsSending,
      knownMessageCount: activeMeta?.messageCount ?? 0,
      metaKnown: input.serverListSettled && !!activeMeta,
      loading: input.historyLoading,
      graceExpired: historyGraceExpired,
      capExpired: historyCapExpired,
      historyError: hasHistoryError,
      settledEmpty: !demo && input.historySettled === true,
    });
  const historySurface = sessionHistorySurface({
    gated: input.gated,
    loadingHistory,
    hasMessages: demo ? input.demoMessageCount > 0 : input.wsMessageCount > 0,
    sending: demo ? input.demoBusy : input.wsSending,
    knownNonEmpty: (activeMeta?.messageCount ?? 0) > 0,
    historyError: !demo && input.historyError !== null,
  });
  return { loadingHistory, historySurface, slowHistory: loadingHistory && historySlow };
}
