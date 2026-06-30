/**
 * oc-lit / oc-cite 纯逻辑单测(mock fetch,无网络/无 PG):
 *   - sources:各源 parse + normalize + makeSourceId + guessLang + 带 mock fetch 的 search。
 *   - litSearch:dedupKey / dedupAndMerge(DOI 去重 + 中文模糊去重 + OA/引用/撤稿合并)/
 *     searchMultiSource(单源失败 → warnings)。
 *   - cite:parseIdentifier 各形态 / verifyIdentifier(命中+撤稿+未命中 fallback)/ 三格式化。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  guessLang,
  makeSourceId,
  normalizeArxivId,
  normalizeDoi,
  parseArxivAtom,
  parseCrossrefItem,
  parseOpenAlexWork,
  searchOpenAlex,
} from "../research/sources.js";
import {
  dedupAndMerge,
  dedupKey,
  searchMultiSource,
} from "../research/litSearch.js";
import { parseIdentifier, verifyIdentifier } from "../research/cite.js";
import {
  type SourceRecord,
  formatApa,
  formatBibtex,
  formatGbt7714,
} from "@openclaude/protocol/research";

// ── mock fetch helper ────────────────────────────────────────────────

function mockFetch(routes: Array<{ match: string; json?: unknown; text?: string; status?: number }>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    const route = routes.find((r) => u.includes(r.match));
    if (!route) return new Response("not found", { status: 404 });
    const status = route.status ?? 200;
    if (route.text !== undefined) {
      return new Response(route.text, { status });
    }
    return new Response(JSON.stringify(route.json ?? {}), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

// ── sources: normalize / parse ───────────────────────────────────────

describe("sources: normalize & parse", () => {
  it("normalizeDoi 去前缀小写", () => {
    assert.equal(normalizeDoi("https://doi.org/10.1/AbC"), "10.1/abc");
    assert.equal(normalizeDoi("10.1/x"), "10.1/x");
    assert.equal(normalizeDoi(undefined), undefined);
  });

  it("normalizeArxivId 去版本/前缀", () => {
    assert.equal(normalizeArxivId("https://arxiv.org/abs/2301.00001v3"), "2301.00001");
    assert.equal(normalizeArxivId("arXiv:1706.03762"), "1706.03762");
  });

  it("guessLang 中英", () => {
    assert.equal(guessLang("基于深度学习的图像识别"), "zh");
    assert.equal(guessLang("Attention is all you need"), "en");
  });

  it("makeSourceId 优先 DOI", () => {
    assert.equal(makeSourceId({ doi: "10.1/x", title: "T", authors: [] }), "doi:10.1/x");
    assert.match(makeSourceId({ title: "T", authors: [{ name: "Bob Smith" }], year: 2020 }), /^t:/);
  });

  it("parseOpenAlexWork", () => {
    const rec = parseOpenAlexWork({
      id: "https://openalex.org/W1",
      doi: "https://doi.org/10.1/x",
      title: "Deep nets",
      publication_year: 2021,
      cited_by_count: 42,
      authorships: [{ author: { display_name: "Jane Doe" } }],
      open_access: { is_oa: true, oa_url: "http://oa/x.pdf" },
      primary_location: { source: { display_name: "Nature" } },
    });
    assert.equal(rec.doi, "10.1/x");
    assert.equal(rec.year, 2021);
    assert.equal(rec.citationCount, 42);
    assert.equal(rec.oa?.isOA, true);
    assert.equal(rec.venue, "Nature");
  });

  it("parseCrossrefItem 撤稿检测", () => {
    const rec = parseCrossrefItem({
      DOI: "10.1/y",
      title: ["Retracted paper"],
      author: [{ given: "A", family: "Bee" }],
      issued: { "date-parts": [[2019]] },
      "update-to": [{ type: "retraction" }],
    });
    assert.equal(rec.retracted, true);
    assert.equal(rec.authors[0].name, "A Bee");
    assert.equal(rec.year, 2019);
  });

  it("parseArxivAtom 多 entry", () => {
    const xml = `<feed>
      <entry><title>Paper One</title><id>http://arxiv.org/abs/2301.00001v1</id>
        <published>2023-01-02T00:00:00Z</published>
        <author><name>Alice</name></author><author><name>Bob</name></author></entry>
      <entry><title>Paper Two</title><id>http://arxiv.org/abs/2302.00002v2</id>
        <published>2023-02-02T00:00:00Z</published><author><name>Carol</name></author></entry>
    </feed>`;
    const recs = parseArxivAtom(xml);
    assert.equal(recs.length, 2);
    assert.equal(recs[0].arxivId, "2301.00001");
    assert.equal(recs[0].year, 2023);
    assert.equal(recs[0].authors.length, 2);
    assert.equal(recs[0].oa?.isOA, true);
  });

  it("searchOpenAlex 带 mock fetch + mailto", async () => {
    const f = mockFetch([{ match: "api.openalex.org", json: { results: [{ title: "X", doi: "10.1/x" }] } }]);
    const recs = await searchOpenAlex("q", { size: 5, mailto: "a@b.com", fetchImpl: f });
    assert.equal(recs.length, 1);
    assert.equal(recs[0].doi, "10.1/x");
  });
});

// ── litSearch: dedup & merge ─────────────────────────────────────────

function rec(p: Partial<SourceRecord> & { title: string }): SourceRecord {
  return {
    id: p.id ?? makeSourceId({ doi: p.doi, arxivId: p.arxivId, title: p.title, authors: p.authors ?? [], year: p.year }),
    title: p.title,
    authors: p.authors ?? [],
    year: p.year,
    venue: p.venue,
    doi: p.doi,
    arxivId: p.arxivId,
    openalexId: p.openalexId,
    citationCount: p.citationCount,
    oa: p.oa,
    lang: p.lang,
    retracted: p.retracted ?? null,
  };
}

describe("litSearch: dedup & merge", () => {
  it("dedupKey:DOI 优先,无 DOI 走标题+作者+年", () => {
    assert.equal(dedupKey(rec({ title: "T", doi: "10.1/X" })), "doi:10.1/x");
    const k = dedupKey(rec({ title: "Hello World", authors: [{ name: "Jane Doe" }], year: 2020 }));
    assert.match(k, /^t:helloworld\|doe\|2020$/);
  });

  it("dedupAndMerge:同 DOI 合并 OA/引用/撤稿", () => {
    const merged = dedupAndMerge([
      rec({ title: "A", doi: "10.1/x", citationCount: 5 }),
      rec({ title: "A", doi: "10.1/X", oa: { isOA: true, url: "http://oa" }, citationCount: 9, retracted: true }),
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].citationCount, 9);
    assert.equal(merged[0].oa?.isOA, true);
    assert.equal(merged[0].retracted, true);
  });

  it("dedupAndMerge:中文无 DOI 走模糊去重", () => {
    const merged = dedupAndMerge([
      rec({ title: "基于深度学习的图像识别", authors: [{ name: "张三" }], year: 2021 }),
      rec({ title: "基于深度学习的图像识别 ", authors: [{ name: "张三" }], year: 2021, citationCount: 3 }),
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].citationCount, 3);
  });

  it("searchMultiSource:单源失败进 warnings,其它正常", async () => {
    const f = mockFetch([
      { match: "api.openalex.org", json: { results: [{ title: "OA paper", doi: "10.1/o" }] } },
      { match: "api.crossref.org", status: 500 },
      { match: "export.arxiv.org", text: "<feed></feed>" },
    ]);
    const res = await searchMultiSource({ query: "q" }, { fetchImpl: f, retryDelayMs: 0 });
    assert.equal(res.sources.length, 1);
    assert.equal(res.sources[0].doi, "10.1/o");
    assert.ok(res.warnings.some((w) => w.includes("crossref")));
  });

  it("searchMultiSource:瞬时 fetch failed 自动重试后成功", async () => {
    let calls = 0;
    const f = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("api.openalex.org")) {
        calls++;
        if (calls === 1) throw new TypeError("fetch failed"); // 第一次瞬时网络失败
        return new Response(JSON.stringify({ results: [{ title: "OA", doi: "10.1/o" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not used", { status: 404 });
    }) as unknown as typeof fetch;
    const res = await searchMultiSource({ query: "q", sources: ["openalex"] }, { fetchImpl: f, retryDelayMs: 0 });
    assert.ok(calls >= 2, `应重试(实际调用 ${calls} 次)`);
    assert.equal(res.sources.length, 1);
    assert.equal(res.sources[0].doi, "10.1/o");
  });

  it("searchMultiSource:4xx(404)不重试,快速失败进 warnings", async () => {
    let calls = 0;
    const f = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("api.openalex.org")) {
        calls++;
        return new Response("nope", { status: 404 }); // 非瞬时 → 不应重试
      }
      return new Response("x", { status: 404 });
    }) as unknown as typeof fetch;
    const res = await searchMultiSource({ query: "q", sources: ["openalex"] }, { fetchImpl: f, retryDelayMs: 0 });
    assert.equal(calls, 1, "404 不应重试");
    assert.ok(res.warnings.some((w) => w.includes("openalex")));
  });
});

// ── cite: parse identifier / verify / format ─────────────────────────

describe("cite: parseIdentifier", () => {
  it("各形态", () => {
    assert.deepEqual(parseIdentifier("doi:10.1/X"), { scheme: "doi", id: "10.1/x" });
    assert.deepEqual(parseIdentifier("10.1234/abc"), { scheme: "doi", id: "10.1234/abc" });
    assert.deepEqual(parseIdentifier("https://doi.org/10.1/y"), { scheme: "doi", id: "10.1/y" });
    assert.deepEqual(parseIdentifier("arxiv:1706.03762"), { scheme: "arxiv", id: "1706.03762" });
    assert.deepEqual(parseIdentifier("2301.00001v2"), { scheme: "arxiv", id: "2301.00001" });
    assert.deepEqual(parseIdentifier("openalex:W123"), { scheme: "openalex", id: "W123" });
    assert.deepEqual(parseIdentifier("W999"), { scheme: "openalex", id: "W999" });
    assert.equal(parseIdentifier("not an id"), null);
  });
});

describe("cite: verifyIdentifier", () => {
  it("DOI 命中 + 撤稿标记", async () => {
    const f = mockFetch([
      {
        match: "api.crossref.org/works/10.1234",
        json: {
          message: {
            DOI: "10.1234/r",
            title: ["Retracted"],
            author: [{ given: "A", family: "Bee" }],
            issued: { "date-parts": [[2019]] },
            "update-to": [{ type: "retraction" }],
          },
        },
      },
    ]);
    const v = await verifyIdentifier("10.1234/r", { fetchImpl: f });
    assert.equal(v.resolved, true);
    assert.equal(v.retracted, true);
    assert.ok(v.bibtex?.includes("Retracted"));
    assert.ok(v.gbt7714?.includes("[J]"));
  });

  it("DOI Crossref 未命中 → OpenAlex fallback(字面 doi: path)", async () => {
    const f = mockFetch([
      { match: "api.crossref.org/works", status: 404 },
      { match: "api.openalex.org/works/doi:10.1234/z", json: { title: "Found via OA", publication_year: 2020 } },
    ]);
    const v = await verifyIdentifier("10.1234/z", { fetchImpl: f });
    assert.equal(v.resolved, true);
    assert.equal(v.record?.title, "Found via OA");
  });

  it("完全未命中 → resolved:false", async () => {
    const f = mockFetch([
      { match: "api.crossref.org/works", status: 404 },
      { match: "api.openalex.org/works", status: 404 },
    ]);
    const v = await verifyIdentifier("10.1234/none", { fetchImpl: f });
    assert.equal(v.resolved, false);
    assert.equal(v.record, undefined);
  });

  it("非法 identifier → resolved:false 不抛", async () => {
    const v = await verifyIdentifier("garbage", { fetchImpl: mockFetch([]) });
    assert.equal(v.resolved, false);
  });

  it("path 混淆 DOI(# ? % \\)在 fetch 前被 safeDoiPath 短路", async () => {
    let called = 0;
    const f = (() => {
      called++;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;
    for (const bad of ["10.1234/foo#x", "10.1234/foo?x=y", "10.1234/%2e%2e/x", "10.1234/a\\b"]) {
      const v = await verifyIdentifier(bad, { fetchImpl: f });
      assert.equal(v.resolved, false, `should reject ${bad}`);
    }
    assert.equal(called, 0, "safeDoiPath 应在 fetch 前短路,不发任何请求");
  });
});

describe("cite: formatters", () => {
  const sample = rec({
    title: "Attention is all you need",
    authors: [{ name: "Ashish Vaswani" }, { name: "Noam Shazeer" }],
    year: 2017,
    venue: "NeurIPS",
    doi: "10.5555/x",
  });

  it("bibtex", () => {
    const b = formatBibtex(sample);
    assert.ok(b.startsWith("@article{vaswani2017"));
    assert.ok(b.includes("author = {Ashish Vaswani and Noam Shazeer}"));
    assert.ok(b.includes("doi = {10.5555/x}"));
  });

  it("apa", () => {
    const a = formatApa(sample);
    assert.ok(a.includes("(2017)"));
    assert.ok(a.includes("https://doi.org/10.5555/x"));
  });

  it("gbt7714 期刊 [J] + 超 3 作者用等", () => {
    const g = formatGbt7714(sample);
    assert.ok(g.includes("[J]"));
    assert.ok(g.includes("NeurIPS"));
    const many = rec({
      title: "Big",
      authors: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }],
      year: 2020,
      doi: "10.1/m",
    });
    assert.ok(formatGbt7714(many).includes("等"));
  });

  it("gbt7714 arXiv 预印本 [J/OL]", () => {
    const pre = rec({ title: "Pre", authors: [{ name: "X" }], year: 2023, arxivId: "2301.00001" });
    const g = formatGbt7714(pre);
    assert.ok(g.includes("[J/OL]"));
    assert.ok(g.includes("arxiv.org/abs/2301.00001"));
  });
});
