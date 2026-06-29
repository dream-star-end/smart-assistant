/**
 * 引用图 snowball 单测(mock fetch):
 *   - seedToOpenAlexSelector 各形态;
 *   - backward(referenced_works)/ forward(cites:)/ both(去重);
 *   - 非法 seed / seed 未命中 → warnings。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { seedToOpenAlexSelector, snowball } from "../research/snowball.js";

function mockFetch(routes: Array<{ match: string; json?: unknown; status?: number }>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    const r = routes.find((x) => u.includes(x.match));
    if (!r) return new Response("nf", { status: 404 });
    return new Response(JSON.stringify(r.json ?? {}), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("seedToOpenAlexSelector", () => {
  it("各形态", () => {
    assert.equal(seedToOpenAlexSelector("W123"), "W123");
    assert.equal(seedToOpenAlexSelector("openalex:w999"), "W999");
    assert.equal(seedToOpenAlexSelector("10.1038/abc1234"), "doi:10.1038/abc1234");
    assert.equal(seedToOpenAlexSelector("arxiv:1706.03762"), "doi:10.48550/arxiv.1706.03762");
    assert.equal(seedToOpenAlexSelector("not an id"), null);
  });
});

describe("snowball", () => {
  it("backward:referenced_works → 拉取", async () => {
    const f = mockFetch([
      {
        match: "api.openalex.org/works/W1",
        json: { id: "https://openalex.org/W1", title: "Seed", referenced_works: ["https://openalex.org/W2"] },
      },
      {
        match: "filter=openalex_id",
        json: { results: [{ id: "https://openalex.org/W2", title: "Ref paper", doi: "10.1/ref" }] },
      },
    ]);
    const r = await snowball({ seed: "W1", direction: "backward" }, { fetchImpl: f });
    assert.equal(r.seedId, "https://openalex.org/W1");
    assert.equal(r.sources.length, 1);
    assert.equal(r.sources[0].title, "Ref paper");
  });

  it("forward:cites: → 拉取", async () => {
    const f = mockFetch([
      { match: "api.openalex.org/works/W1", json: { id: "https://openalex.org/W1", title: "Seed", referenced_works: [] } },
      { match: "filter=cites", json: { results: [{ id: "https://openalex.org/W3", title: "Citing paper", doi: "10.1/cit" }] } },
    ]);
    const r = await snowball({ seed: "W1", direction: "forward" }, { fetchImpl: f });
    assert.equal(r.sources.length, 1);
    assert.equal(r.sources[0].title, "Citing paper");
  });

  it("both:去重(同 DOI 只一条)", async () => {
    const f = mockFetch([
      {
        match: "api.openalex.org/works/W1",
        json: { id: "https://openalex.org/W1", title: "Seed", referenced_works: ["https://openalex.org/W2"] },
      },
      { match: "filter=openalex_id", json: { results: [{ id: "https://openalex.org/W2", title: "Dup", doi: "10.1/d" }] } },
      { match: "filter=cites", json: { results: [{ id: "https://openalex.org/W9", title: "Dup", doi: "10.1/d" }] } },
    ]);
    const r = await snowball({ seed: "W1", direction: "both" }, { fetchImpl: f });
    assert.equal(r.sources.length, 1); // 同 DOI 去重
  });

  it("非法 seed → warning,无结果", async () => {
    const r = await snowball({ seed: "garbage" }, { fetchImpl: mockFetch([]) });
    assert.equal(r.seedId, null);
    assert.ok(r.warnings.some((w) => w.includes("无法识别")));
  });

  it("seed 未命中 → warning", async () => {
    const f = mockFetch([{ match: "api.openalex.org/works/W1", status: 404 }]);
    const r = await snowball({ seed: "W1" }, { fetchImpl: f });
    assert.equal(r.seedId, null);
    assert.ok(r.warnings.length > 0);
  });
});
