/**
 * litrag 语义召回(P2.5)单测:纯逻辑,用假 embed/cache 注入,无 PG/网络。
 * 覆盖两条铁律 + 红线:
 *   ① 语义命中:TF 零命中但语义相关的 span 被召回(纯 TF 召不到)。
 *   ① fail-soft:embedding 抛错 → litragQuery 回落纯 TF,结果与 queryDocuments 完全一致。
 *   ② 成本上限:maxSpans 限制冷缓存 embed 扇出;缓存命中后不再 embed 文档向量。
 *   红线:两条路径的 QuoteHandle.text 都逐字等于权威 span.text。
 *   非降级:强 TF 命中段不会被纯语义段挤到其后。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { NormalizedDocument } from "@openclaude/protocol/research";
import { mintDocument } from "../research/ingest.js";
import {
  type SemanticQueryDeps,
  queryDocuments,
  queryDocumentsSemantic,
} from "../research/litrag.js";
import { litragQuery } from "../research/researchHandlers.js";

// ── 固定语料:s0 语义相关但零词面命中;s1 强词面命中;s2 不相关 ────────────
const S0 = "Transformers use self-attention mechanisms.";
const S1 = "The architecture of neural network models.";
const S2 = "Bananas are yellow fruits.";
const QUERY = "neural network architecture";

function corpusDoc(): NormalizedDocument {
  return mintDocument({ text: `${S0}\n\n${S1}\n\n${S2}` });
}

/** 假向量:query≡S0(cos=1),S1 略近(cos≈0.994),S2 正交(cos=0)。dim=4。 */
const VEC: Record<string, number[]> = {
  [QUERY]: [1, 1, 0, 0],
  [S0]: [1, 1, 0, 0],
  [S1]: [1, 0.8, 0, 0],
  [S2]: [0, 0, 1, 0],
};

interface FakeEmbedLog {
  calls: Array<{ kind: "query" | "document"; texts: string[] }>;
}

function fakeSemantic(
  log: FakeEmbedLog,
  cache: Map<string, Float32Array>,
  opts: { maxSpans?: number; throwOnEmbed?: boolean } = {},
): SemanticQueryDeps {
  return {
    embed: async (texts, kind) => {
      log.calls.push({ kind, texts: [...texts] });
      if (opts.throwOnEmbed) throw new Error("embed boom");
      return texts.map((t) => new Float32Array(VEC[t] ?? [0, 0, 0, 1]));
    },
    getCached: async (hashes) => {
      const out = new Map<string, Float32Array>();
      for (const h of hashes) {
        const v = cache.get(h);
        if (v) out.set(h, v);
      }
      return out;
    },
    putCached: async (entries) => {
      for (const e of entries) cache.set(e.contentHash, e.vec);
    },
    maxSpans: opts.maxSpans,
  };
}

describe("litrag 语义召回", () => {
  it("语义命中:召回 TF 零命中但语义相关的 span(纯 TF 召不到)", async () => {
    const doc = corpusDoc();
    // 基线:纯 TF 只召回 S1(S0/S2 零词面命中)。
    const tf = queryDocuments([doc], QUERY, { topK: 5 });
    assert.deepEqual(
      tf.map((q) => q.text),
      [S1],
      "纯 TF 只命中 S1",
    );

    // 语义:S0 因向量近似被召回。
    const log: FakeEmbedLog = { calls: [] };
    const quotes = await queryDocumentsSemantic([doc], QUERY, { topK: 5 }, fakeSemantic(log, new Map()));
    const texts = quotes.map((q) => q.text);
    assert.ok(texts.includes(S0), "语义应召回 S0(TF 召不到)");
    assert.ok(texts.includes(S1), "强 TF 命中 S1 仍在");
    // 非降级:S1(强 TF)排在 S0(纯语义)之前。
    assert.equal(texts[0], S1, "强 TF 命中不被纯语义段挤下");
    assert.ok(texts.indexOf(S1) < texts.indexOf(S0));
  });

  it("红线:两条路径 QuoteHandle.text 均逐字等于权威 span.text", async () => {
    const doc = corpusDoc();
    const log: FakeEmbedLog = { calls: [] };
    const quotes = await queryDocumentsSemantic([doc], QUERY, { topK: 5 }, fakeSemantic(log, new Map()));
    for (const q of quotes) {
      const span = doc.spans.find((s) => s.spanId === q.spanId);
      assert.ok(span, "quote 指向真实 span");
      assert.equal(q.text, span?.text, "quote.text 逐字等于权威 span.text");
    }
    // 报告 score 仍是确定性 TF 分:S0(TF 零命中)score=0。
    const s0q = quotes.find((q) => q.text === S0);
    assert.equal(s0q?.score, 0, "纯语义段的 score 仍为 TF 分(0)");
  });

  it("fail-soft:embedding 抛错 → litragQuery 回落纯 TF,结果与 queryDocuments 一致", async () => {
    const doc = corpusDoc();
    const getDocument = async (_uid: number, id: string) => (id === doc.docId ? doc : null);
    const log: FakeEmbedLog = { calls: [] };
    const res = await litragQuery(1, [doc.docId], QUERY, { topK: 5 }, {
      getDocument,
      semantic: fakeSemantic(log, new Map(), { throwOnEmbed: true }),
    });
    const tf = queryDocuments([doc], QUERY, { topK: 5 });
    assert.deepEqual(
      res.quotes.map((q) => ({ id: q.id, text: q.text, score: q.score })),
      tf.map((q) => ({ id: q.id, text: q.text, score: q.score })),
      "embed 抛错必须回落到与纯 TF 完全一致",
    );
  });

  it("无 semantic deps → litragQuery 走纯 TF(行为不变)", async () => {
    const doc = corpusDoc();
    const getDocument = async (_uid: number, id: string) => (id === doc.docId ? doc : null);
    const res = await litragQuery(1, [doc.docId], QUERY, { topK: 5 }, { getDocument });
    assert.deepEqual(res.quotes.map((q) => q.text), [S1]);
    assert.deepEqual(res.missing, []);
  });

  it("成本上限:maxSpans 限制 embed 扇出,只 embed 优先(TF 命中)段", async () => {
    const doc = corpusDoc();
    const log: FakeEmbedLog = { calls: [] };
    // maxSpans=1 → 仅 embed 最高 TF 段(S1);S0(纯语义)不进预算 → 召不到。
    const quotes = await queryDocumentsSemantic([doc], QUERY, { topK: 5 }, fakeSemantic(log, new Map(), { maxSpans: 1 }));
    const docCall = log.calls.find((c) => c.kind === "document");
    assert.equal(docCall?.texts.length, 1, "只 embed 1 个 span 文档向量");
    assert.deepEqual(docCall?.texts, [S1], "优先 embed TF 命中段 S1");
    assert.deepEqual(quotes.map((q) => q.text), [S1], "预算外的 S0 不被语义召回");
  });

  it("缓存命中:第二次查询不再 embed 文档向量(仅 embed query)", async () => {
    const doc = corpusDoc();
    const cache = new Map<string, Float32Array>();
    const log1: FakeEmbedLog = { calls: [] };
    await queryDocumentsSemantic([doc], QUERY, { topK: 5 }, fakeSemantic(log1, cache));
    assert.ok(log1.calls.some((c) => c.kind === "document"), "首次冷缓存 embed 文档向量");

    const log2: FakeEmbedLog = { calls: [] };
    await queryDocumentsSemantic([doc], QUERY, { topK: 5 }, fakeSemantic(log2, cache));
    assert.ok(
      !log2.calls.some((c) => c.kind === "document"),
      "命中缓存后不再 embed 文档向量(成本摊薄)",
    );
    assert.ok(log2.calls.some((c) => c.kind === "query"), "仍 embed query 向量");
  });

  it("空 query → 空结果(与纯 TF 一致)", async () => {
    const doc = corpusDoc();
    const log: FakeEmbedLog = { calls: [] };
    const quotes = await queryDocumentsSemantic([doc], "   ", { topK: 5 }, fakeSemantic(log, new Map()));
    assert.equal(quotes.length, 0);
    assert.equal(log.calls.length, 0, "空 query 不触发 embedding");
  });
});
