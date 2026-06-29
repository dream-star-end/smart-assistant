/**
 * CiteFix realignUnsupportedClaims 纯逻辑单测(注入 query):
 *   - unsupported claim 命中候选 → 重绑(supports=新 quote,status=unchecked,待 recheck)。
 *   - verified claim 不动。
 *   - 无候选 / 低于 minScore → 不重绑(change.requotedTo='none')。
 *   - 新 quote 入 manifest.quotes(去重)。
 *   - 不就地改入参 manifest。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { realignUnsupportedClaims } from "../research/citeFix.js";
import type { EvidenceManifest, QuoteHandle } from "@openclaude/protocol/research";

function manifest(over: Partial<EvidenceManifest> = {}): EvidenceManifest {
  return {
    sources: [],
    quotes: [],
    claims: [],
    coverage: { verifiedClaims: 0, totalClaims: 0 },
    gates: {
      quoteFirst: { passed: true, checked: 0, failed: 0 },
      claimBound: { passed: true, checked: 0, failed: 0 },
      identifier: { passed: true, checked: 0, failed: 0 },
      retraction: { passed: true, checked: 0, failed: 0 },
    },
    ...over,
  };
}

function quote(id: string, score: number): QuoteHandle {
  return { id, sourceId: "d1", docId: "d1", spanId: "s1", charStart: 0, charEnd: 10, text: "权威 span 子串", score };
}

describe("CiteFix realignUnsupportedClaims", () => {
  it("unsupported claim 命中候选 → 重绑 + status unchecked + 入 quotes", async () => {
    const m = manifest({
      claims: [{ id: "c1", text: "天空是蓝色的", supports: [], status: "unsupported" }],
    });
    const { manifest: out, changes } = await realignUnsupportedClaims(m, true, {
      query: async (_t: string) => [quote("d1#s1", 0.8)],
    });
    assert.equal(out.claims[0].status, "unchecked");
    assert.deepEqual(out.claims[0].supports, [{ quoteId: "d1#s1" }]);
    assert.equal(out.quotes.length, 1);
    assert.deepEqual(changes, [{ claimId: "c1", requotedTo: "d1#s1" }]);
  });

  it("红线:litrag best 覆盖同 id 提交 quote(不信伪造同 id)", async () => {
    // 提交一个伪造的 'd1#s1'(不同 docId/text);CiteFix 必须用 litrag 铸造的同 id best 覆盖。
    const forged: QuoteHandle = {
      id: "d1#s1",
      sourceId: "evil",
      docId: "evil",
      spanId: "x",
      charStart: 0,
      charEnd: 99,
      text: "伪造文本",
    };
    const m = manifest({
      quotes: [forged],
      claims: [{ id: "c1", text: "天空", supports: [], status: "unsupported" }],
    });
    const { manifest: out } = await realignUnsupportedClaims(m, true, {
      query: async (_t: string) => [quote("d1#s1", 0.9)],
    });
    const q = out.quotes.find((x) => x.id === "d1#s1");
    assert.equal(out.quotes.length, 1); // 覆盖而非新增
    assert.equal(q?.docId, "d1"); // litrag 铸造值
    assert.equal(q?.text, "权威 span 子串");
    assert.notEqual(q?.docId, "evil");
  });

  it("verified claim 不动", async () => {
    const m = manifest({
      quotes: [quote("q0", 1)],
      claims: [{ id: "c1", text: "x", supports: [{ quoteId: "q0" }], status: "verified" }],
    });
    let called = 0;
    const { manifest: out, changes } = await realignUnsupportedClaims(m, true, {
      query: async (_t: string) => {
        called++;
        return [quote("d1#s1", 0.9)];
      },
    });
    assert.equal(called, 0);
    assert.equal(out.claims[0].status, "verified");
    assert.equal(changes.length, 0);
  });

  it("无候选 → 不重绑,change=none", async () => {
    const m = manifest({ claims: [{ id: "c1", text: "x", supports: [], status: "unsupported" }] });
    const { manifest: out, changes } = await realignUnsupportedClaims(m, true, { query: async (_t: string) => [] });
    assert.equal(out.claims[0].status, "unsupported");
    assert.deepEqual(changes, [{ claimId: "c1", requotedTo: "none" }]);
  });

  it("候选低于 minScore → 不重绑", async () => {
    const m = manifest({ claims: [{ id: "c1", text: "x", supports: [], status: "unsupported" }] });
    const { manifest: out, changes } = await realignUnsupportedClaims(m, true, {
      query: async (_t: string) => [quote("d1#s1", 0.2)],
      minScore: 0.5,
    });
    assert.equal(out.claims[0].status, "unsupported");
    assert.equal(changes[0].requotedTo, "none");
  });

  it("不就地改入参", async () => {
    const m = manifest({ claims: [{ id: "c1", text: "x", supports: [], status: "unsupported" }] });
    const before = JSON.stringify(m);
    await realignUnsupportedClaims(m, true, { query: async (_t: string) => [quote("d1#s1", 0.9)] });
    assert.equal(JSON.stringify(m), before, "入参 manifest 不应被就地修改");
  });

  it("无权威文档(hasDocs=false)→ 全部跳过", async () => {
    const m = manifest({ claims: [{ id: "c1", text: "x", supports: [], status: "unsupported" }] });
    let called = 0;
    const { changes } = await realignUnsupportedClaims(m, false, {
      query: async (_t: string) => {
        called++;
        return [];
      },
    });
    assert.equal(called, 0);
    assert.equal(changes.length, 0);
  });
});
