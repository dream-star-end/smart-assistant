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

/**
 * 每条消息是否为其**所在轮次的末条 assistant 正文** —— 评价反馈行(ResponseRatingCard)
 * 唯一可见位。返回按 messages 下标对齐的布尔数组;非「轮末条 assistant 正文」行恒 false。
 *
 * 轮边界权威与 currentTurnStartIndex / coalesceTeam 的 anchorOf **同源**:**user 消息开启
 * 新轮**(client-authored、server 从不重排,最稳定的轮边界)。不另造第二套轮判定。
 *
 * 「assistant 正文」判定 = role==='assistant' 且有非空 text 且非 error(与 AssistantCard 挂载
 * 评价行的门控一致)。工具卡/思考卡/委派卡(agent-group)/user 行都不算正文 —— 一轮里穿插其间
 * 的它们不影响「谁是本轮末条」,故团队模式/thinking 分组下仍精准落在**队长最后一段文本回答**上。
 *
 * 每轮各自的末条都被标记(**不是**"全会话末条"):翻历史会话时每轮末条仍可补评;而一轮内模型
 * 产出的多段中间文本回复不再各自带一行"这条回复怎么样?",消除噪音(boss 07-11)。
 */
export function turnFinalAssistantFlags(messages: ChatMessage[]): boolean[] {
  const flags = new Array<boolean>(messages.length).fill(false);
  const isBody = (m: ChatMessage | undefined): boolean =>
    !!m &&
    m.role === "assistant" &&
    typeof m.text === "string" &&
    m.text.trim().length > 0 &&
    !m._errorCode;
  // lastBody = 当前(尚未落幕的)轮里最近一条 assistant 正文下标,-1=本轮还没有正文。
  let lastBody = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role === "user") {
      // 轮边界:上一轮落幕 → 其最后记录的正文即该轮末条。
      if (lastBody >= 0) flags[lastBody] = true;
      lastBody = -1;
      continue; // user 行本身永不是正文。
    }
    if (isBody(m)) lastBody = i;
  }
  if (lastBody >= 0) flags[lastBody] = true; // 收尾:最后一轮(无后继 user)的末条。
  return flags;
}
