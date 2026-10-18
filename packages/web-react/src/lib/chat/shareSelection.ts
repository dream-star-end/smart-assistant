import { isFoldableWorkRole } from "../../components/chat/ProcessDisclosure";
import type { ChatMessage } from "./model";
import { isAutoContinueMsg, isRecoveryControlUserTurn } from "./pure";

export type ShareRange = "last" | "last3" | "all";

/** 聊天视图本来就不显示的行(与 MessageRenderer 的 renderableMessages 同口径)。 */
function hiddenInChat(m: ChatMessage): boolean {
  const id = typeof m.id === "string" ? m.id : "";
  return (
    (m as ChatMessage & { _historyProjection?: unknown })._historyProjection !== undefined ||
    id.startsWith("projection-") ||
    id.startsWith("oc-dispatch-err:") ||
    m._turnTapeProcess === true ||
    m._timelineAuxiliary !== undefined ||
    isRecoveryControlUserTurn(m) ||
    (m.role === "user" && isAutoContinueMsg(m))
  );
}

/** 干净的最终正文:非错误、非状态记录、非降级合并行(降级行可能把过程段和答案拼在一起)。 */
function isAnswerBody(m: ChatMessage): boolean {
  return (
    m.role === "assistant" &&
    !m._errorCode &&
    !m._isError &&
    !m.error &&
    !m._turnStatusRecord &&
    !m._genPlaceholder &&
    !m._displayDegraded &&
    m._displayDegradeReason === undefined &&
    (m.text ?? "").trim().length > 0
  );
}

/** 参与「本轮最后一行是谁」判定的行:助手行(含错误/状态记录)和工作行。空正文的助手占位不算。 */
function isTurnTail(m: ChatMessage): boolean {
  if (m.role === "assistant") {
    return (m.text ?? "").trim().length > 0 || !!m._errorCode || !!m._isError || !!m.error || !!m._turnStatusRecord;
  }
  return isFoldableWorkRole(m);
}

type Order = { seq: number; ts: number; index: number };

function orderOf(m: ChatMessage, index: number): Order {
  return {
    seq: typeof m._orderSeq === "number" && Number.isSafeInteger(m._orderSeq) && m._orderSeq > 0 ? m._orderSeq : 0,
    ts: typeof m.ts === "number" && Number.isFinite(m.ts) ? m.ts : 0,
    index,
  };
}

/** a 是否晚于 b:两行都有 _orderSeq 才比它(本地追加的错误卡等没有),否则比 ts,再比数组下标。 */
function after(a: Order, b: Order): boolean {
  if (a.seq > 0 && b.seq > 0 && a.seq !== b.seq) return a.seq > b.seq;
  if (a.ts !== b.ts) return a.ts > b.ts;
  return a.index > b.index;
}

/**
 * 按范围挑消息。用户消息 = 真实提问(恢复控制行、自动续接、排队中的不算)。
 * 归轮:行的 _clientMessageId 指向哪条提问就归哪轮(恢复子轮沿 _recoveryOfClientMessageId 归并回原提问);
 * 没有归属的旧行按数组位置归到前一条真实提问。
 * 每轮最多收**一条**助手正文,而且必须是该轮的最后一行(按 after 的顺序,且与数组顺序一致):
 * 最后一行是错误卡、状态记录、降级合并行或工具/思考等工作行时,这一轮没有可分享的回答 ——
 * 宁可只分享问题,也不把「正在读取 …」这类过程文本当答案。`sending` 时进行中那一轮不收回答。
 */
export function selectShareMessages(
  messages: readonly ChatMessage[],
  range: ShareRange,
  sending = false,
): ChatMessage[] {
  // 恢复控制行 → 它所恢复的那条消息。
  const parent = new Map<string, string>();
  for (const m of messages) {
    if (!isRecoveryControlUserTurn(m) || !m._recoveryOfClientMessageId) continue;
    parent.set(m.id, m._recoveryOfClientMessageId);
    if (m._clientMessageId) parent.set(m._clientMessageId, m._recoveryOfClientMessageId);
  }
  const root = (id: string): string => {
    let cur = id;
    const seen = new Set<string>();
    while (parent.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = parent.get(cur) as string;
    }
    return cur;
  };

  // tail = 按 after 排序的最后一行;lastIndex = 数组里最后一行。两者一致才认这条回答。
  type Turn = { user: ChatMessage | null; tail: { m: ChatMessage; order: Order } | null; lastIndex: ChatMessage | null };
  const turns: Turn[] = [{ user: null, tail: null, lastIndex: null }];
  const byKey = new Map<string, Turn>();
  const rows = messages.filter((m) => !hiddenInChat(m));
  const positional: Turn[] = [];
  for (const m of rows) {
    if (m.role === "user" && m.status !== "queued" && (m.text ?? "").trim()) {
      const turn: Turn = { user: m, tail: null, lastIndex: null };
      turns.push(turn);
      byKey.set(m.id, turn);
      if (m._clientMessageId) byKey.set(m._clientMessageId, turn);
    }
    positional.push(turns[turns.length - 1]);
  }
  rows.forEach((m, i) => {
    if (m.role === "user" || !isTurnTail(m)) return;
    const owned = m._clientMessageId ? byKey.get(root(m._clientMessageId)) : undefined;
    const turn = owned ?? positional[i];
    const order = orderOf(m, i);
    if (!turn.tail || after(order, turn.tail.order)) turn.tail = { m, order };
    turn.lastIndex = m;
  });
  const live = sending ? turns[turns.length - 1] : null;
  const body: ChatMessage[] = [];
  for (const t of turns) {
    if (t.user) body.push(t.user);
    // 两种顺序说法不一时宁可只分享问题(不确定哪条才是最后一行,就不冒险把过程当答案)。
    if (t !== live && t.tail && t.tail.m === t.lastIndex && isAnswerBody(t.tail.m)) body.push(t.tail.m);
  }
  if (range === "all") return body;
  const userIdx: number[] = [];
  body.forEach((m, i) => {
    if (m.role === "user") userIdx.push(i);
  });
  if (userIdx.length === 0) return body;
  const rounds = range === "last" ? 1 : 3;
  return body.slice(userIdx[Math.max(0, userIdx.length - rounds)]);
}
