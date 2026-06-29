/**
 * oc-litrag quote-first RAG(master 侧检索权威 spans → 铸造 QuoteHandle)。
 *
 * 设计(§0.5 #3, #8):
 *   - 检索在 master,读 research_documents 权威 spans;**QuoteHandle.text 从权威 span
 *     逐字取**(canonical),容器/LLM 无法发明或篡改 quote 文本。
 *   - embedding/vector 后端可插拔;**in-proc 缺省 = 确定性 TF-IDF/token 重叠**,只影响
 *     召回排序,**绝不影响 verified**(verified 由 oc-cite check 铸造,与召回质量解耦)。
 *   - quote-first:抽出的 verbatim quote 是写作唯一可引用素材。
 */

import type { NormalizedDocument, QuoteHandle, Span } from "@openclaude/protocol/research";

const CJK_RE = /[一-鿿]/;

/** 分词:ASCII 词(a-z0-9,长度≥2)+ 单个 CJK 字。crude 但确定性,够 in-proc 召回。 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const ascii = lower.match(/[a-z0-9]{2,}/g) ?? [];
  const cjk: string[] = [];
  for (const ch of lower) {
    if (CJK_RE.test(ch)) cjk.push(ch);
  }
  return [...ascii, ...cjk];
}

interface ScoredSpan {
  docId: string;
  span: Span;
  score: number;
}

/**
 * 打分:**distinct 命中覆盖优先**(命中越多不同 query 词越靠前)+ tf 微调 + 极轻长度惩罚
 * (仅防超长段刷分,不压制信息密集段)。这样短标题(命中 1 词)不会压过命中多词的正文段。
 */
function scoreSpan(queryTokens: Set<string>, spanTokens: string[]): number {
  if (spanTokens.length === 0) return 0;
  const tf = new Map<string, number>();
  for (const t of spanTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  let matchedDistinct = 0;
  let tfSum = 0;
  for (const q of queryTokens) {
    const c = tf.get(q);
    if (c) {
      matchedDistinct++;
      tfSum += c;
    }
  }
  if (matchedDistinct === 0) return 0;
  return matchedDistinct + Math.log(1 + tfSum) * 0.2 - Math.log(1 + spanTokens.length) * 0.05;
}

export interface QueryOpts {
  topK?: number;
  /** 召回阈值(score 低于此忽略);默认 0(任何命中都算)。 */
  minScore?: number;
}

/**
 * 在给定权威文档集上检索 → 铸造 QuoteHandle(text=权威 span 子串)。
 * sourceId = docId(上传文档作为其自身来源;若该文档有对应 SourceRecord 由调用方关联)。
 */
export function queryDocuments(
  docs: NormalizedDocument[],
  query: string,
  opts: QueryOpts = {},
): QuoteHandle[] {
  const topK = Math.min(Math.max(opts.topK ?? 8, 1), 50);
  const minScore = opts.minScore ?? 0;
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) return [];

  const scored: ScoredSpan[] = [];
  for (const doc of docs) {
    for (const span of doc.spans) {
      const s = scoreSpan(qTokens, tokenize(span.text));
      if (s > minScore) scored.push({ docId: doc.docId, span, score: s });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((ss) => ({
    id: `${ss.docId}#${ss.span.spanId}`,
    sourceId: ss.docId,
    docId: ss.docId,
    spanId: ss.span.spanId,
    charStart: ss.span.charStart,
    charEnd: ss.span.charEnd,
    text: ss.span.text,
    score: Number(ss.score.toFixed(4)),
  }));
}
