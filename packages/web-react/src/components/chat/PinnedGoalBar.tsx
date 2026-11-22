import type { ChatMessage } from "../../lib/chat/model";

/** Latest goal that is still an objective. A newer cleared row hides the bar. */
export function latestVisibleGoal(messages: ChatMessage[]): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "goal") continue;
    const status = (message.goalStatus ?? "").trim().toLowerCase();
    if (message.cleared === true || status === "cleared") return null;
    return message;
  }
  return null;
}

/**
 * 会话目标统一收敛到 Composer 的 `composer-goal-chip` 单入口，
 * 不再在 HUD 重复渲染只读目标条或暴露裸 token 预算。保留导出供懒加载壳兼容。
 */
export function PinnedGoalBar(_props: { messages: ChatMessage[] }) {
  return null;
}
