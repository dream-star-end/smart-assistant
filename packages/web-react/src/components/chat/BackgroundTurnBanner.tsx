import type { BackgroundTurnNoticeView } from "../../lib/chat/backgroundTurnNotice";

/**
 * 独立后台回合横幅已退场：排队与另行计费说明已整合进 `QueuedSendList`，
 * 实扣积分提醒由 `TurnCostReminder` 独立承接。保留导出以兼容懒加载壳。
 */
export function BackgroundTurnBanner(_props: { notice?: BackgroundTurnNoticeView | null }) {
  return null;
}
