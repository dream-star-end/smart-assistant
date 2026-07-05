/**
 * 「当前活跃段」判定 —— 任务归属当前轮的唯一收口。
 *
 * 定义:最后一条 user 消息**之后**的消息区间 = 当前 turn 的产出段(内容轴,而非
 * "是否在发送"的时间轴)。没有 user 消息(如 cron 推送会话)时整个消息流视为一段。
 *
 * 两个消费方必须共用本函数,不许各写一份(否则"HUD 判属当前轮 / transcript 判属历史"
 * 会出现语义分叉):
 *  - PinnedTaskTracker.extractLatestTodos:HUD 任务源只从该段提取 → 几十轮前的旧任务
 *    不会在下一轮无关提问时复活钉在输入框上;
 *  - MessageRenderer:仅该段(且本轮进行中)抑制 TodoWrite / structured plan 的 inline
 *    卡,历史段渲染只读卡 → 翻历史会话仍能看到当时的计划与完成状态。
 */
import type { ChatMessage } from "../../lib/chat/model";

/** 当前活跃段的起始下标(最后一条 user 消息的下一条;无 user 消息 → 0)。 */
export function currentTurnStartIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i + 1;
  }
  return 0;
}
