/**
 * oc-litrag quote-first RAG(master 侧检索权威 spans → 铸造 QuoteHandle)。
 *
 * 设计(§0.5 #3, #8):
 *   - 检索在 master,读 research_documents 权威 spans;**QuoteHandle.text 从权威 span
 *     逐字取**(canonical),容器/LLM 无法发明或篡改 quote 文本。
 *   - embedding/vector 后端可插拔;**in-proc 缺省 = 确定性 TF/token 重叠**,只影响
 *     召回排序,**绝不影响 verified**(verified 由 oc-cite check 铸造,与召回质量解耦)。
 *   - quote-first:抽出的 verbatim quote 是写作唯一可引用素材。
 *
 * ## 语义召回(P2.5,可选、fail-soft)
 *   `queryDocumentsSemantic` 在纯 TF 之上叠加向量语义召回:embed query + span 文本
 *   (按内容 hash 缓存,平台 key,不进容器),cosine 相似度与 TF 命中做 **RRF 秩融合**。
 *   两条铁律:
 *     ① fail-soft —— 任何 embedding 失败/不可用,调用方回落 `queryDocuments`(纯 TF,
 *        字节一致)。因此 `queryDocuments` 保持确定性,是语义路径的兜底权威。
 *     ② 不增用户成本 —— research ops 不按 token 计费;embedding 走平台 key + 内容 hash
 *        缓存跨请求摊薄;每查询至多 embed `maxSpans` 个 span(冷缓存有界扇出)。
 *   **红线不破**:两条路径都经单一权威 `mintQuote` 铸造 `QuoteHandle.text = span.text`
 *   (逐字取权威 span);语义只改召回**排序与候选集**,不触碰 verified 铸造链;报告的
 *   `score` 仍是确定性 TF 分(RRF 只驱动 order),下游 TF 尺度阈值(如 citeFix.fixMinScore)
 *   语义不变。
 */

import { createHash } from "node:crypto";
import type { NormalizedDocument, QuoteHandle, Span } from "@openclaude/protocol/research";
import { cosineSim } from "@openclaude/storage";

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
 * **单一权威**:从权威 span 逐字铸造 QuoteHandle。TF 路径与语义路径共用,保证
 * `text = span.text`(verbatim)只有一处实现,不会漂移。red-line:绝不改 `text` 来源。
 * sourceId = docId(上传文档作为其自身来源;若该文档有对应 SourceRecord 由调用方关联)。
 */
function mintQuote(docId: string, span: Span, score: number): QuoteHandle {
  return {
    id: `${docId}#${span.spanId}`,
    sourceId: docId,
    docId,
    spanId: span.spanId,
    charStart: span.charStart,
    charEnd: span.charEnd,
    text: span.text, // ← 权威 span 逐字,red-line 不动
    score,
  };
}

/**
 * 在给定权威文档集上检索 → 铸造 QuoteHandle(text=权威 span 子串)。
 * **确定性纯 TF**:语义路径不可用时的兜底权威(行为字节稳定)。
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
  return scored
    .slice(0, topK)
    .map((ss) => mintQuote(ss.docId, ss.span, Number(ss.score.toFixed(4))));
}

// ── 语义召回(RRF 秩融合;fail-soft 由调用方兜底纯 TF) ──────────────────

/** span 向量缓存键 = span 文本内容 hash(与 skill_embedding_cache 通用键契约一致)。 */
export function spanContentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * 语义召回注入依赖(master 侧提供:平台 embedding provider + 跨租户内容 hash 向量缓存)。
 * litrag 保持不含 key/egress 细节,便于用假实现单测融合逻辑。
 */
export interface SemanticQueryDeps {
  /** embed 文本(kind 区分 query/document 侧);失败抛错 → 调用方回落纯 TF。 */
  embed: (texts: string[], kind: "query" | "document") => Promise<Float32Array[]>;
  /** 按内容 hash 批量取缓存向量(best-effort;返回子集即可)。 */
  getCached: (hashes: string[]) => Promise<Map<string, Float32Array>>;
  /** 落新 embed 的向量(best-effort;不得因写失败中断召回)。 */
  putCached: (entries: Array<{ contentHash: string; vec: Float32Array }>) => Promise<void>;
  /** 每查询 embed 的 span 上限(冷缓存有界扇出;默认 DEFAULT_MAX_SEMANTIC_SPANS)。 */
  maxSpans?: number;
}

/** 冷缓存单查询 embed 的 span 上限(优先 TF 命中段,再补其余段以便语义发现)。 */
export const DEFAULT_MAX_SEMANTIC_SPANS = 200;
/** RRF 常数(行业惯例 60):抑制头部秩的过度主导,使秩融合平滑、抗单侧噪声。 */
const RRF_K = 60;

interface RawCand {
  docId: string;
  span: Span;
  tf: number;
}

/**
 * 语义 + TF 混合召回。设计要点(满足两条铁律):
 *   - TF 分照旧算(scoreSpan),既是 fallback 兜底也是 RRF 的一路秩。
 *   - 候选 embed 集:按 TF 分降序优先(命中段必进预算),再补其余段到 maxSpans ——
 *     既不丢现有 TF 结果,又给"零词面命中但语义相关"的段一个被召回的机会。
 *   - 融合用 **RRF**(而非 0.7/0.3 线性加权):TF 分(无界)与 cosine([-1,1])尺度不可比,
 *     线性加权需脆弱的归一化;RRF 天然无量纲、抗单侧 ranker 噪声(embedding 抖动时,
 *     语义秩的贡献上界仅 1/(K+1),无法压垮同时拿到 TF 贡献的强词面命中段)——这正是
 *     铁律①"抖动不得变差"的结构性保证。
 *   - **报告 score 仍为确定性 TF 分**(RRF 只驱动 order);任何 embed 失败 throw,由
 *     litragQuery 捕获回落 `queryDocuments`(纯 TF,字节一致)。
 */
export async function queryDocumentsSemantic(
  docs: NormalizedDocument[],
  query: string,
  opts: QueryOpts,
  sem: SemanticQueryDeps,
): Promise<QuoteHandle[]> {
  const topK = Math.min(Math.max(opts.topK ?? 8, 1), 50);
  const minScore = opts.minScore ?? 0;
  const qStr = query.trim();
  const qTokens = new Set(tokenize(qStr));
  if (qTokens.size === 0) return [];

  // 1) 全量 span 打 TF 分(确定性;既是 RRF 一路,也是 fallback 语义)。
  const cands: RawCand[] = [];
  for (const doc of docs) {
    for (const span of doc.spans) {
      cands.push({ docId: doc.docId, span, tf: scoreSpan(qTokens, tokenize(span.text)) });
    }
  }
  if (cands.length === 0) return [];

  // 2) embed 预算:TF 分降序优先(命中段必进),tie 用原始 idx 保持确定性,取前 maxSpans。
  const maxSpans = Math.max(1, sem.maxSpans ?? DEFAULT_MAX_SEMANTIC_SPANS);
  const embedOrder = cands
    .map((c, idx) => ({ idx, tf: c.tf }))
    .sort((a, b) => b.tf - a.tf || a.idx - b.idx)
    .slice(0, maxSpans)
    .map((x) => x.idx);

  // 3) embed query + 候选 span 文本(内容 hash 缓存)。任一 throw → 调用方回落纯 TF。
  const [qVec] = await sem.embed([qStr], "query");
  if (!qVec) throw new Error("empty query embedding");

  const hashByIdx = new Map<number, string>();
  for (const idx of embedOrder) hashByIdx.set(idx, spanContentHash(cands[idx].span.text));
  const uniqHashes = [...new Set(hashByIdx.values())];
  const cached = await sem.getCached(uniqHashes).catch(() => new Map<string, Float32Array>());
  const missing = uniqHashes.filter((h) => !cached.has(h));
  if (missing.length > 0) {
    const textByHash = new Map<string, string>();
    for (const idx of embedOrder) {
      const h = hashByIdx.get(idx) as string;
      if (!textByHash.has(h)) textByHash.set(h, cands[idx].span.text);
    }
    const vecs = await sem.embed(
      missing.map((h) => textByHash.get(h) ?? ""),
      "document",
    );
    const toCache: Array<{ contentHash: string; vec: Float32Array }> = [];
    for (let i = 0; i < missing.length; i++) {
      const v = vecs[i];
      if (!v) throw new Error("embed count mismatch");
      cached.set(missing[i], v);
      toCache.push({ contentHash: missing[i], vec: v });
    }
    await sem.putCached(toCache).catch(() => {}); // best-effort,已有向量在手不阻断召回
  }

  // 4) semantic 秩:embedOrder 内按 cosine 降序(tie idx 升序)。
  const semScored = embedOrder.map((idx) => ({
    idx,
    cos: cosineSim(qVec, cached.get(hashByIdx.get(idx) as string) as Float32Array),
  }));
  const semRank = new Map<number, number>();
  [...semScored]
    .sort((a, b) => b.cos - a.cos || a.idx - b.idx)
    .forEach((s, i) => semRank.set(s.idx, i + 1));

  // 5) TF 秩:全体 tf>minScore 的段按 tf 降序(tie idx 升序)。
  const tfRank = new Map<number, number>();
  cands
    .map((c, idx) => ({ idx, tf: c.tf }))
    .filter((x) => x.tf > minScore)
    .sort((a, b) => b.tf - a.tf || a.idx - b.idx)
    .forEach((x, i) => tfRank.set(x.idx, i + 1));

  // 6) RRF 融合 union(tf 命中 ∪ embed 集);tie-break TF 降序再 idx 升序(确定性)。
  const fusedIdxs = new Set<number>([...tfRank.keys(), ...embedOrder]);
  const fused = [...fusedIdxs].map((idx) => {
    let s = 0;
    const tr = tfRank.get(idx);
    if (tr) s += 1 / (RRF_K + tr);
    const sr = semRank.get(idx);
    if (sr) s += 1 / (RRF_K + sr);
    return { idx, s, tf: cands[idx].tf };
  });
  fused.sort((a, b) => b.s - a.s || b.tf - a.tf || a.idx - b.idx);

  return fused
    .slice(0, topK)
    .map(({ idx }) => mintQuote(cands[idx].docId, cands[idx].span, Number(cands[idx].tf.toFixed(4))));
}
