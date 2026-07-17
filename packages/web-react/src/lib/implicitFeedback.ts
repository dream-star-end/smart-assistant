/**
 * 隐式负反馈信号的**纯函数**收口 —— 从会话消息流里识别两类"用户没点👎、但行为表明不满意"
 * 的场景,供 App 侧静默上报为 implicit down（绝不渲染成用户已选态）:
 *
 *  1. **改写重发**（findRewriteTarget）:用户在短时间内把刚发过的问题改几个字重新发一遍,
 *     通常意味着上一轮回答没到位 —— 把被改写轮的末条 assistant 回答记为 implicit down。
 *  2. **中途打断**（findStopTarget）:回答还在流式产出时用户点了 Stop（且已过手滑秒停窗）,
 *     通常意味着方向不对 —— 把当前轮的末条 assistant 回答记为 implicit down。
 *
 * 另附 isExpensiveTurn:判定"高成本 turn"（耗时长 / 工具多），供 App 在此类轮完成后对评分行
 * 做一次性脉冲高亮引导（方案 a）——纯读，不产生任何副作用。
 *
 * 设计约束:全部为纯函数（输入消息数组 + now,输出目标/布尔），无 React、无网络、无时钟自取
 * （now 由调用方传入,便于单测）。"轮末条 assistant" 的判定与评价行挂载点（turnSegment /
 * cards.tsx）同源:role==='assistant' 且有非空 text 且无 _errorCode。
 */
import type { ChatMessage } from "./chat/model";
import { currentTurnStartIndex } from "../components/chat/turnSegment";

/** 命中的隐式反馈目标:评价行所在的 messageId + best-effort per-turn traceId（可空）。 */
export type ImplicitTarget = { messageId: string; traceId: string | null };

/** 改写重发窗口:超过则视为"新问题"而非"对上一轮不满"。 */
const REWRITE_WINDOW_MS = 5 * 60 * 1000;
/** 秒停过滤窗口:发出后极短时间内 Stop 多为手滑/误触,不采集。 */
const STOP_MIN_ELAPSED_MS = 10_000;
/** 改写文本归一化后的最短长度:过短的问题（"好的""继续"）改几字不作为不满信号。 */
const REWRITE_MIN_LEN = 4;
/** 判定为"改写"的相似度下限（bigram Jaccard）。 */
const REWRITE_SIM_THRESHOLD = 0.55;
/**
 * 改写误伤收窄：即便相似度 ≥ 阈值，若新消息相对上一条 user 的"新词占比"≥ 本值，
 * 视为**引入了新实体/显著新词的顺序任务**（如「写Python快排」→「写Python归并」，快排↔归并
 * 是完全不同的技术名）而非"对上一轮不满的改写重发"，不记 implicit down。
 * 取 0.3：与两端锚点都留足余量 —— 单字换主题的真·改写（如「春天」→「秋天」，新词占比≈0.09）
 * 稳落其下仍判改写；整词换实体（「快排」→「归并」，新词占比≈0.5）稳落其上判新任务。
 */
const REWRITE_NOVELTY_MAX = 0.3;
/**
 * 中途打断误伤收窄：assistant 该轮末条正文的**原始字符数** ≥ 本值时，把 Stop 视为
 * "产出已足够、用户满意后主动停止"而非"方向不对"，不记 implicit down。
 * 用原始长度（含空白/代码）而非归一化长度：宁可高估产出量也不误记 down。
 */
const STOP_LONG_OUTPUT_LEN = 200;
/**
 * 完成语形态：命中则视为回答已收尾（即便偏短），Stop 更可能是"已给出完整答复"而非不满，
 * 不记 implicit down。覆盖中英文常见收尾语；对原始文本（含标点）匹配，带 /i 忽略大小写。
 */
const COMPLETION_FORM_RE =
  /希望(对|能|这|本)|如(有|果)(需要|其他|问题|不清楚)|还(有|需要)(什么|其他|别的|问题)|以上(就是|是|便是|为|即)|祝(你|您)|请(参考|查收|知悉|按需)|需要.{0,8}(补充|继续|调整|修改)吗|hope this helps|let me know|feel free to|anything else|as requested/i;
/** 高成本 turn 的耗时下限。 */
const EXPENSIVE_DURATION_MS = 60_000;
/** 高成本 turn 的工具/团队消息数下限。 */
const EXPENSIVE_HEAVY_COUNT = 3;

/**
 * 文本归一化:转小写 + 去掉所有空白、标点、符号（Unicode 类 P/S，含中英文标点）。
 * CJK 文字本身属 Letter 类不被剥离,故对中文改写友好。
 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** 相邻字符 bigram 集合（长度<2 时为空集,调用方在此之前已走整串相等回退）。 */
function bigramSet(s: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** assistant 正文行判定（与评价行挂载门控一致）:有内容、非 error。 */
function isAssistantBody(m: ChatMessage | undefined): boolean {
  return (
    !!m &&
    m.role === "assistant" &&
    typeof m.text === "string" &&
    m.text.trim().length > 0 &&
    !m._errorCode
  );
}

/** U 之后最后一条 assistant 正文（= 该轮末条,与评价行落点同源）；无则 null。 */
function lastAssistantBodyAfter(messages: ChatMessage[], afterIndex: number): ChatMessage | null {
  let target: ChatMessage | null = null;
  for (let i = afterIndex + 1; i < messages.length; i++) {
    const m = messages[i];
    if (isAssistantBody(m)) target = m;
  }
  return target;
}

/**
 * 两段文本的字符 bigram Jaccard 相似度（0..1）。归一化（小写 / 去空白标点）后:
 *  - 任一串归一化长度 < 2（无法构造 bigram）→ 退化为整串相等（相等 1，否则 0）；
 *  - 否则 = |交集| / |并集|。CJK 友好（按字符切 bigram，中文两字一窗）。
 */
export function rewriteSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length < 2 || nb.length < 2) return na === nb ? 1 : 0;
  const ba = bigramSet(na);
  const bb = bigramSet(nb);
  let inter = 0;
  for (const g of ba) if (bb.has(g)) inter++;
  const union = ba.size + bb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * 把归一化文本切成"内容 token"：连续 ASCII 字母数字为一个词（如 python / v2），
 * 其余字符（CJK 等，归一化后已无空白标点）各自成一个单字 token。CJK 友好。
 */
function contentTokens(normalized: string): Set<string> {
  const set = new Set<string>();
  for (const m of normalized.matchAll(/[a-z0-9]+|[^a-z0-9]/gu)) set.add(m[0]);
  return set;
}

/**
 * 新消息相对旧消息的"新词占比"（0..1）：newTokens 中不在 oldTokens 的比例。
 * 高 → 引入了大量新实体/新词（顺序任务），低 → 只微调个别字（改写重发）。
 * newTokens 为空时返回 0（不触发收窄，交由上游相似度/长度门处理）。
 */
export function newTokenRatio(oldText: string, newText: string): number {
  const oldTokens = contentTokens(normalize(oldText));
  const newTokens = contentTokens(normalize(newText));
  if (newTokens.size === 0) return 0;
  let novel = 0;
  for (const t of newTokens) if (!oldTokens.has(t)) novel++;
  return novel / newTokens.size;
}

/**
 * "改写重发"目标:最后一条**非空 user** 消息 U 若满足
 *  ① now - U.ts ≤ 5min（近期）；② 新文本归一化后长度 ≥ 4；③ 与 U 相似度 ≥ 0.55；
 *  ④ 新词占比 < REWRITE_NOVELTY_MAX（否则是引入新实体的顺序任务，非改写不满）；
 *  ⑤ U 之后存在 assistant 正文
 * → 返回该轮末条 assistant 正文的 {messageId, traceId}；任一不满足返回 null。
 */
export function findRewriteTarget(
  messages: ChatMessage[],
  newText: string,
  now: number,
): ImplicitTarget | null {
  let iU = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && typeof m.text === "string" && m.text.trim().length > 0) {
      iU = i;
      break;
    }
  }
  if (iU < 0) return null;
  const U = messages[iU];
  if (!U || now - U.ts > REWRITE_WINDOW_MS) return null;
  if (normalize(newText).length < REWRITE_MIN_LEN) return null;
  if (rewriteSimilarity(U.text, newText) < REWRITE_SIM_THRESHOLD) return null;
  // 收窄误伤：高相似但引入大量新实体/新词 → 顺序任务（做完快排接着做归并），不记 down。
  if (newTokenRatio(U.text, newText) >= REWRITE_NOVELTY_MAX) return null;
  const target = lastAssistantBodyAfter(messages, iU);
  if (!target) return null;
  return { messageId: target.id, traceId: target.usage?.traceId ?? null };
}

/**
 * "中途打断"目标:最后一条 user 消息 U 若已过秒停窗（now - U.ts ≥ 10s）、其后存在 assistant
 * 正文、且该正文**产出较低**（原始长度 < STOP_LONG_OUTPUT_LEN 且无完成语形态）
 * → 返回该轮末条 assistant 正文的 {messageId, traceId}；否则 null。
 * 收窄误伤：产出已经很长 / 已带完成语的回答被 Stop，更可能是"够了已满意"主动停止，不记 down
 * （含手滑秒停 / 空轮打断 / 长产出后停止 / 已收尾后停止）。
 */
export function findStopTarget(messages: ChatMessage[], now: number): ImplicitTarget | null {
  let iU = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      iU = i;
      break;
    }
  }
  if (iU < 0) return null;
  const U = messages[iU];
  if (!U || now - U.ts < STOP_MIN_ELAPSED_MS) return null;
  const target = lastAssistantBodyAfter(messages, iU);
  if (!target) return null;
  const body = typeof target.text === "string" ? target.text : "";
  if (body.length >= STOP_LONG_OUTPUT_LEN || COMPLETION_FORM_RE.test(body)) return null;
  return { messageId: target.id, traceId: target.usage?.traceId ?? null };
}

/**
 * 当前（最后一）轮是否"高成本":从 currentTurnStartIndex 起,
 *  · 耗时 =（末条消息 completedAt ?? ts）-（该轮 user 消息 ts）≥ 60s，或
 *  · 轮内 role 为 'tool' | 'agent-group' 的消息数 ≥ 3。
 * 无 user 消息（如 cron 推送会话）时耗时条件跳过,只按工具数判定。
 */
export function isExpensiveTurn(messages: ChatMessage[]): boolean {
  if (messages.length === 0) return false;
  const start = currentTurnStartIndex(messages);
  const userTs = start > 0 ? messages[start - 1]?.ts : undefined;
  const last = messages[messages.length - 1];
  if (last && userTs !== undefined) {
    const duration = (last.completedAt ?? last.ts) - userTs;
    if (duration >= EXPENSIVE_DURATION_MS) return true;
  }
  let heavy = 0;
  for (let i = start; i < messages.length; i++) {
    const r = messages[i]?.role;
    if (r === "tool" || r === "agent-group") heavy++;
  }
  return heavy >= EXPENSIVE_HEAVY_COUNT;
}
