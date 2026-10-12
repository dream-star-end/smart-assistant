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
import { isCollapsedAnchorTerminalEvidence } from "../../lib/chat/render";

/** 当前活跃段的起始下标(最后一条 user 消息的下一条;无 user 消息 → 0)。 */
export function currentTurnStartIndex(messages: readonly ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i + 1;
  }
  return 0;
}

/**
 * 当前 turn 是否已收口(消息层终态证据版)。放在 turnSegment 而非组件内:轮边界必须与
 * currentTurnStartIndex 同源 —— HUD 判「当前段已收口」与 extractLatestTodos 判「任务属于
 * 当前段」用同一段定义,否则会出现「任务取自本轮、收口却按别轮判」的语义分叉。
 *
 * 只看消息层证据,不看「是否在发送」(时间轴):刷新/重开会话时没有 live 下降沿,靠本函数
 * 判收口。两路证据任一命中即收口:
 *  1. 当前段前一行(最后一条 user 行)status ∈ {replied, error} —— server 在 turn finalize
 *     时把 user 行置 replied,是最直接的轮收口标记;
 *  2. 当前段 [turnStart, end) 内任一行带终态存在证据(_turnTapeComplete / _turnStatusRecord /
 *     _dispatchTerminal / 非空 _errorCode / 过程控制折叠锚终态)。
 *
 * 注意:「在飞优先」不在此处判定 —— active(sending)时由调用方(PinnedTaskTracker)压住
 * 本结果,旧行残留终态标记不得盖过恢复中的 openDispatch。
 */
export function currentTurnSettled(messages: ChatMessage[]): boolean {
  const turnStart = currentTurnStartIndex(messages);
  if (turnStart > 0) {
    const lastUserRow = messages[turnStart - 1];
    const status = lastUserRow?.status;
    if (status === "replied" || status === "error") return true;
  }
  for (let i = turnStart; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (
      m._turnTapeComplete === true ||
      m._turnStatusRecord === true ||
      m._dispatchTerminal === true ||
      (typeof m._errorCode === "string" && m._errorCode) ||
      isCollapsedAnchorTerminalEvidence(m)
    ) {
      return true;
    }
  }
  return false;
}

/** OCV5-390: one visible turn = the user's message plus every automatic recovery / 从断点继续 child
 * under it (their control user rows are hidden). Maps a row's owner id to that turn's root id. */
export function turnRecoveryParents(messages: readonly ChatMessage[]): Map<string, string> {
  const parentOf = new Map<string, string>();
  for (const m of messages) {
    if (m?.role !== "user" || typeof m._recoveryOfClientMessageId !== "string" || !m._recoveryOfClientMessageId) {
      continue;
    }
    // A user row's own id is its client message id; rows that carry both get both keys.
    for (const id of [m.id, m._clientMessageId]) {
      if (typeof id === "string" && id) parentOf.set(id, m._recoveryOfClientMessageId);
    }
  }
  return parentOf;
}

/** Resolve an owner id to its visible turn. `parents` comes from the full message list: the recovery
 * control user rows are filtered out before rendering, so the rendered rows cannot rebuild it. */
export function turnLineageRoot(messages: readonly ChatMessage[],
  parents?: ReadonlyMap<string, string>): (id: string) => string {
  const parentOf = parents ?? turnRecoveryParents(messages);
  return (id: string): string => {
    let current = id;
    for (let hops = 0; hops < 64; hops++) {
      const parent = parentOf.get(current);
      if (!parent || parent === current) break;
      current = parent;
    }
    return current;
  };
}

/**
 * OCV5-390: the action row (copy / like / dislike / more) sits once per turn, on its final answer
 * (turnFinalAssistantFlags). A turn that ended on an error has none: the text before that error is
 * often the line the model wrote before a tool, and the error card carries its own minimal row.
 * Layout (which text is the answer) stays with turnFinalAssistantFlags.
 */
export function turnRatingFlags(messages: readonly ChatMessage[], finals: readonly boolean[],
  parents?: ReadonlyMap<string, string>): boolean[] {
  const rootOf = turnLineageRoot(messages, parents);
  const flags = finals.slice();
  const finalOf = new Map<string, number>();
  finals.forEach((isFinal, i) => {
    const id = messages[i]?._clientMessageId;
    if (isFinal && typeof id === "string" && id) finalOf.set(rootOf(id), i);
  });
  // Order between two rows of one turn: the durable sequence when both have one, else array order.
  const later = (a: number, b: number): boolean => {
    const sa = messages[a]?._orderSeq;
    const sb = messages[b]?._orderSeq;
    if (typeof sa === "number" && typeof sb === "number" && sa > 0 && sb > 0 && sa !== sb) return sa > sb;
    return a > b;
  };
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    // The turn ended on a failure: an assistant error row, or the dispatch-terminal status record the
    // master writes when the turn never ran to completion (Codex r1).
    const failure = !!m && !!m._errorCode
      && (m.role === "assistant" || (m._turnStatusRecord === true && m._dispatchTerminal === true));
    if (!failure || typeof m._clientMessageId !== "string" || !m._clientMessageId) continue;
    const at = finalOf.get(rootOf(m._clientMessageId));
    if (at !== undefined && later(i, at)) flags[at] = false;
  }
  return flags;
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
export function turnFinalAssistantFlags(messages: ChatMessage[],
  parents?: ReadonlyMap<string, string>): boolean[] {
  const flags = new Array<boolean>(messages.length).fill(false);
  const isBody = (m: ChatMessage | undefined): boolean =>
    !!m &&
    m.role === "assistant" &&
    typeof m.text === "string" &&
    m.text.trim().length > 0 &&
    !m._errorCode &&
    // Process control 显式排除:它是终态存在证据，不是末条 assistant 正文，
    // 绝不挂评分卡。其正文尚未展开;展开后由真 tape 展开行(独立行)承接末条评分。
    !m._turnTapeProcess;
  const orderTuple = (m: ChatMessage, index: number): [number, number, number] => [
    typeof m._orderSeq === "number" && Number.isSafeInteger(m._orderSeq) && m._orderSeq > 0
      ? m._orderSeq
      : 0,
    typeof m.ts === "number" && Number.isFinite(m.ts) ? m.ts : 0,
    index,
  ];
  const tupleAfter = (a: [number, number, number], b: [number, number, number]): boolean =>
    a[0] > b[0] ||
    (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));

  const rootOf = turnLineageRoot(messages, parents);
  // Durable/live rows carry the exact user message id that owns their turn.
  // Grouping on it is independent of a temporarily polluted array order.
  const grouped = new Map<string, { index: number; tuple: [number, number, number] }>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!isBody(message) || typeof message._clientMessageId !== "string" || !message._clientMessageId) continue;
    const tuple = orderTuple(message, i);
    const owner = rootOf(message._clientMessageId);
    const previous = grouped.get(owner);
    if (!previous || tupleAfter(tuple, previous.tuple)) {
      grouped.set(owner, { index: i, tuple });
    }
  }
  for (const winner of grouped.values()) flags[winner.index] = true;

  // Rolling legacy rows have no _clientMessageId. Keep the user-boundary
  // fallback per array segment, but do not add a second rating when that
  // segment already contains a keyed body.
  let lastBody = -1;
  let segmentHasGroupedBody = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role === "user") {
      // 轮边界:上一轮落幕 → 其最后记录的正文即该轮末条。
      if (lastBody >= 0 && !segmentHasGroupedBody) flags[lastBody] = true;
      lastBody = -1;
      segmentHasGroupedBody = false;
      continue; // user 行本身永不是正文。
    }
    if (isBody(m)) {
      if (typeof m?._clientMessageId === "string" && m._clientMessageId) {
        segmentHasGroupedBody = true;
      } else {
        lastBody = i;
      }
    }
  }
  if (lastBody >= 0 && !segmentHasGroupedBody) flags[lastBody] = true;
  return flags;
}
