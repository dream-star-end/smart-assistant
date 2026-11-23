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
  parsePubmedSummary,
  parseS2Paper,
  searchOpenAlex,
  searchPubmed,
  searchS2,
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
  formatCitation,
  formatGbt7714,
  formatIeee,
  formatNature,
  resolveEvidenceGrade,
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

// ── sources: PubMed ──────────────────────────────────────────────────

describe("sources: pubmed", () => {
  const esummaryRec = {
    uid: "123",
    title: "CRISPR therapy outcomes",
    pubdate: "2021 Mar 4",
    fulljournalname: "Nature Medicine",
    source: "Nat Med",
    authors: [{ name: "Smith J", authtype: "Author" }, { name: "CollabGroup", authtype: "CollectiveName" }],
    articleids: [
      { idtype: "pubmed", value: "123" },
      { idtype: "doi", value: "10.1038/S41591-021-0001" },
    ],
    pubtype: ["Journal Article"],
  };

  it("parsePubmedSummary:doi 从 articleids 取 + 年/期刊/作者映射", () => {
    const rec = parsePubmedSummary(esummaryRec);
    assert.ok(rec);
    assert.equal(rec.doi, "10.1038/s41591-021-0001"); // 归一小写 → 与其它源 DOI 去重直接生效
    assert.equal(rec.id, "doi:10.1038/s41591-021-0001");
    assert.equal(rec.year, 2021);
    assert.equal(rec.venue, "Nature Medicine");
    assert.deepEqual(rec.authors, [{ name: "Smith J", family: "Smith", given: "J" }]); // 非 Author authtype 剔除且保留结构化姓/名
    assert.equal(rec.retracted, null);
  });

  it("parsePubmedSummary:Retracted Publication → retracted:true;无题名 → null", () => {
    const rec = parsePubmedSummary({ ...esummaryRec, pubtype: ["Journal Article", "Retracted Publication"] });
    assert.equal(rec?.retracted, true);
    assert.equal(parsePubmedSummary({ title: "  " }), null);
  });

  it("searchPubmed:esearch→esummary 两跳 + tool/email polite 参数", async () => {
    const urls: string[] = [];
    const f = (async (url: string | URL | Request) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("esearch.fcgi")) {
        return new Response(JSON.stringify({ esearchresult: { idlist: ["123"] } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("esummary.fcgi")) {
        return new Response(JSON.stringify({ result: { uids: ["123"], "123": esummaryRec } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const recs = await searchPubmed("crispr", { size: 5, pubmedEmail: "a@b.com", yearMin: 2020, fetchImpl: f });
    assert.equal(recs.length, 1);
    assert.equal(recs[0].doi, "10.1038/s41591-021-0001");
    assert.equal(urls.length, 2);
    assert.ok(urls[0].includes("esearch.fcgi") && urls[0].includes("tool=openclaude-research"));
    assert.ok(urls[0].includes("email=a%40b.com"));
    assert.ok(urls[0].includes("mindate=2020") && urls[0].includes("datetype=pdat"));
    assert.ok(urls[1].includes("esummary.fcgi") && urls[1].includes("id=123"));
  });

  it("searchPubmed:esearch 空命中 → 不发 esummary,返回 []", async () => {
    let calls = 0;
    const f = (async (url: string | URL | Request) => {
      calls++;
      assert.ok(String(url).includes("esearch.fcgi"), "空命中不应再发 esummary");
      return new Response(JSON.stringify({ esearchresult: { idlist: [] } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    assert.deepEqual(await searchPubmed("nothing", { size: 5, fetchImpl: f }), []);
    assert.equal(calls, 1);
  });
});

// ── sources: Semantic Scholar ────────────────────────────────────────

describe("sources: s2", () => {
  const s2Paper = {
    paperId: "p1",
    title: "Attention is all you need",
    authors: [{ name: "Ashish Vaswani" }],
    year: 2017,
    venue: "NeurIPS",
    externalIds: { DOI: "10.5555/X", ArXiv: "1706.03762" },
    citationCount: 99999,
    isOpenAccess: true,
    openAccessPdf: { url: "https://oa/x.pdf" },
  };

  it("parseS2Paper:externalIds → doi/arxivId + OA/引用数映射", () => {
    const rec = parseS2Paper(s2Paper);
    assert.ok(rec);
    assert.equal(rec.doi, "10.5555/x");
    assert.equal(rec.arxivId, "1706.03762");
    assert.equal(rec.year, 2017);
    assert.equal(rec.venue, "NeurIPS");
    assert.equal(rec.citationCount, 99999);
    assert.deepEqual(rec.oa, { isOA: true, url: "https://oa/x.pdf", source: "s2" });
    assert.equal(parseS2Paper({ title: null }), null);
  });

  it("searchS2:有 apiKey 时带 x-api-key header;无 key 不带", async () => {
    const seenKeys: Array<string | undefined> = [];
    const f = (async (_url: string | URL | Request, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      seenKeys.push(h["x-api-key"]);
      return new Response(JSON.stringify({ data: [s2Paper] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const withKey = await searchS2("q", { size: 5, fetchImpl: f }, { apiKey: "sk-s2" });
    assert.equal(withKey.length, 1);
    assert.equal(withKey[0].doi, "10.5555/x");
    await searchS2("q", { size: 5, yearMin: 2015, fetchImpl: f });
    assert.deepEqual(seenKeys, ["sk-s2", undefined]);
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

  it("searchMultiSource:主源全空 + DeepXiv 配置 → 用 DeepXiv 兜底召回", async () => {
    const f = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("data.rag.ac.cn")) {
        return new Response(
          JSON.stringify({ results: [{ title: "DX Paper", arxiv_id: "2301.00001", authors: ["Alice"], year: 2023 }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u.includes("export.arxiv.org")) return new Response("<feed></feed>", { status: 200 });
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const res = await searchMultiSource(
      { query: "q" },
      { fetchImpl: f, retryDelayMs: 0, deepxiv: { base: "https://data.rag.ac.cn", token: "t" } },
    );
    assert.equal(res.sources.length, 1);
    assert.equal(res.sources[0].title, "DX Paper");
    assert.equal(res.sources[0].arxivId, "2301.00001");
    assert.ok(res.warnings.some((w) => w.includes("DeepXiv")));
  });

  it("searchMultiSource:主源有结果时不触发 DeepXiv(不常态加压)", async () => {
    let dxCalls = 0;
    const f = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("data.rag.ac.cn")) {
        dxCalls++;
        return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("api.openalex.org")) {
        return new Response(JSON.stringify({ results: [{ title: "OA", doi: "10.1/o" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("export.arxiv.org")) return new Response("<feed></feed>", { status: 200 });
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const res = await searchMultiSource(
      { query: "q" },
      { fetchImpl: f, retryDelayMs: 0, deepxiv: { base: "https://data.rag.ac.cn", token: "t" } },
    );
    assert.ok(res.sources.length >= 1);
    assert.equal(dxCalls, 0, "主源有结果不应查 DeepXiv");
  });

  it("searchMultiSource:显式 --sources 排除 arxiv 时,即使空也不用 DeepXiv", async () => {
    let dxCalls = 0;
    const f = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("data.rag.ac.cn")) {
        dxCalls++;
        return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const res = await searchMultiSource(
      { query: "q", sources: ["openalex"] },
      { fetchImpl: f, retryDelayMs: 0, deepxiv: { base: "https://data.rag.ac.cn", token: "t" } },
    );
    assert.equal(res.sources.length, 0);
    assert.equal(dxCalls, 0, "用户显式排除 arxiv → 不混入 DeepXiv");
  });
});

// ── litSearch: pubmed / s2 门控 ──────────────────────────────────────

describe("litSearch: pubmed/s2 gating", () => {
  const emptyMain = [
    { match: "api.openalex.org", json: { results: [] } },
    { match: "api.crossref.org", json: { message: { items: [] } } },
    { match: "export.arxiv.org", text: "<feed></feed>" },
  ];

  it("pubmed 默认参与(免费官方 API),结果并入去重", async () => {
    const f = mockFetch([
      ...emptyMain,
      { match: "esearch.fcgi", json: { esearchresult: { idlist: ["1"] } } },
      {
        match: "esummary.fcgi",
        json: { result: { uids: ["1"], "1": { title: "PubMed hit", pubdate: "2022", articleids: [{ idtype: "doi", value: "10.9/pm" }] } } },
      },
    ]);
    const res = await searchMultiSource({ query: "q" }, { fetchImpl: f, retryDelayMs: 0 });
    assert.equal(res.sources.length, 1);
    assert.equal(res.sources[0].doi, "10.9/pm");
  });

  it("pubmedEnabled=false → pubmed 不出网", async () => {
    let pubmedCalls = 0;
    const f = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("eutils.ncbi.nlm.nih.gov")) pubmedCalls++;
      if (u.includes("export.arxiv.org")) return new Response("<feed></feed>", { status: 200 });
      if (u.includes("api.crossref.org")) {
        return new Response(JSON.stringify({ message: { items: [] } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await searchMultiSource({ query: "q" }, { fetchImpl: f, retryDelayMs: 0, pubmedEnabled: false });
    assert.equal(pubmedCalls, 0);
  });

  it("pubmed 上游错误 → 转 warning 不拖垮整体", async () => {
    const f = mockFetch([
      { match: "api.openalex.org", json: { results: [{ title: "OK", doi: "10.1/o" }] } },
      { match: "api.crossref.org", json: { message: { items: [] } } },
      { match: "export.arxiv.org", text: "<feed></feed>" },
      { match: "esearch.fcgi", status: 400 },
    ]);
    const res = await searchMultiSource({ query: "q" }, { fetchImpl: f, retryDelayMs: 0 });
    assert.equal(res.sources.length, 1);
    assert.ok(res.warnings.some((w) => w.includes("pubmed")));
  });

  it("s2 默认不参与(s2Enabled 未开)→ 不出网、无 warning", async () => {
    let s2Calls = 0;
    const f = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("semanticscholar.org")) s2Calls++;
      if (u.includes("export.arxiv.org")) return new Response("<feed></feed>", { status: 200 });
      if (u.includes("api.crossref.org")) {
        return new Response(JSON.stringify({ message: { items: [] } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("esearch.fcgi")) {
        return new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const res = await searchMultiSource({ query: "q" }, { fetchImpl: f, retryDelayMs: 0 });
    assert.equal(s2Calls, 0, "s2Enabled 未开不应出网");
    assert.ok(!res.warnings.some((w) => w.includes("s2")), "默认候选剔除应静默");
  });

  it("显式 --sources s2 但平台未开 → warning + 不出网", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response("x", { status: 500 });
    }) as unknown as typeof fetch;
    const res = await searchMultiSource({ query: "q", sources: ["s2"] }, { fetchImpl: f, retryDelayMs: 0 });
    assert.equal(calls, 0);
    assert.equal(res.sources.length, 0);
    assert.ok(res.warnings.some((w) => w.includes("s2") && w.includes("disabled")));
  });

  it("s2Enabled=true 无 key 被限速(429)→ 重试后转 warning", async () => {
    let s2Calls = 0;
    const f = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("semanticscholar.org")) {
        s2Calls++;
        return new Response("rate limited", { status: 429 });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const res = await searchMultiSource(
      { query: "q", sources: ["s2"] },
      { fetchImpl: f, retryDelayMs: 0, s2Enabled: true },
    );
    assert.ok(s2Calls >= 2, `429 属瞬时应重试(实际 ${s2Calls} 次)`);
    assert.equal(res.sources.length, 0);
    assert.ok(res.warnings.some((w) => w.includes("s2") && w.includes("upstream_429")));
  });

  it("s2Enabled=true 正常返回并与其它源 DOI 去重", async () => {
    const f = mockFetch([
      { match: "api.openalex.org", json: { results: [{ title: "Same paper", doi: "10.1/x" }] } },
      { match: "api.crossref.org", json: { message: { items: [] } } },
      { match: "export.arxiv.org", text: "<feed></feed>" },
      { match: "esearch.fcgi", json: { esearchresult: { idlist: [] } } },
      {
        match: "semanticscholar.org",
        json: { data: [{ title: "Same paper", year: 2020, externalIds: { DOI: "10.1/X" }, citationCount: 7 }] },
      },
    ]);
    const res = await searchMultiSource({ query: "q" }, { fetchImpl: f, retryDelayMs: 0, s2Enabled: true });
    assert.equal(res.sources.length, 1, "同 DOI 应去重合并");
    assert.equal(res.sources[0].citationCount, 7);
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

  it("OCV5-865: gbt7714 完整卷期页码/会议[C]/DOI + ieee + nature + formatCitation 调度", () => {
    const journalRec: SourceRecord = {
      id: "doi:10.1038/s41586-024-0001",
      title: "Scalable Graph Reasoning",
      authors: [
        { name: "Alice Chen" },
        { name: "Bob Zhang" },
        { name: "Carol Li" },
      ],
      year: 2024,
      venue: "Nature",
      volume: "628",
      issue: "8007",
      pages: "112-119",
      doi: "10.1038/s41586-024-0001",
    };
    const confRec: SourceRecord = {
      id: "doi:10.1109/cvpr.2025.0042",
      title: "Dense Visual Grounding",
      authors: [{ name: "John Smith" }, { name: "Jane Doe" }],
      year: 2025,
      venue: "Proceedings of CVPR",
      pages: "450-459",
      publisher: "IEEE",
      crossrefType: "proceedings-article",
      doi: "10.1109/cvpr.2025.0042",
    };

    const gbtJournal = formatCitation(journalRec, "gb-t-7714");
    assert.equal(gbtJournal, formatCitation(journalRec, "gb-t-7714-2015"));
    assert.ok(gbtJournal.includes("[J]"));
    assert.ok(gbtJournal.includes("2024, 628(8007): 112-119"));
    assert.ok(gbtJournal.includes("DOI: 10.1038/s41586-024-0001"));

    const gbtConf = formatCitation(confRec, "gb-t-7714");
    assert.ok(gbtConf.includes("[C]//Proceedings of CVPR"));
    assert.ok(gbtConf.includes("IEEE, 2025: 450-459"));

    const bibConf = formatCitation(confRec, "bibtex");
    assert.ok(bibConf.startsWith("@inproceedings{"));
    assert.ok(bibConf.includes("booktitle = {Proceedings of CVPR}"));
    assert.ok(bibConf.includes("pages = {450--459}"));

    const ieeeJournal = formatCitation(journalRec, "ieee");
    assert.ok(ieeeJournal.includes("A. Chen, B. Zhang, and C. Li"));
    assert.ok(ieeeJournal.includes("vol. 628, no. 8007, pp. 112–119, 2024"));
    assert.ok(ieeeJournal.includes("doi: 10.1038/s41586-024-0001"));

    const ieeeConf = formatIeee(confRec);
    assert.ok(ieeeConf.includes("in Proceedings of CVPR"));

    const natureJournal = formatCitation(journalRec, "nature");
    assert.ok(natureJournal.includes("Chen, A., Zhang, B. & Li, C."));
    assert.ok(natureJournal.includes("Nature 628, 112–119 (2024)."));
    assert.ok(natureJournal.includes("https://doi.org/10.1038/s41586-024-0001"));

    const manyAuthorsNature = formatNature({
      ...journalRec,
      authors: [
        { name: "Alice Chen" },
        { name: "Bob Zhang" },
        { name: "Carol Li" },
        { name: "Dave Wang" },
        { name: "Eve Sun" },
        { name: "Frank Wu" },
      ],
    });
    assert.ok(manyAuthorsNature.startsWith("Chen, A. et al."));
  });

  it("OCV5-865: PubMed Smith JA 与 Crossref 多作者 APA/IEEE/Nature 格式化 CLI 与 Web 一致 (#8)", async () => {
    const { parseCrossrefItem, parsePubmedSummary } = await import("../research/sources.js");
    const webCiteModulePath = "../../../web-react/src/lib/research/cite.js";
    const webCite = (await import(webCiteModulePath)) as { formatCitation: typeof formatCitation };

    // 1. PubMed "Smith JA" 姓必须仍是 Smith
    const pubmedRec = parsePubmedSummary({
      uid: "39000001",
      title: "Single-cell atlas of cortical plasticity",
      pubdate: "2024 May",
      fulljournalname: "Nature Neuroscience",
      volume: "27",
      issue: "5",
      pages: "801-812",
      authors: [
        { name: "Smith JA", authtype: "Author" },
        { name: "van der Berg HM", authtype: "Author" },
      ],
      articleids: [{ idtype: "doi", value: "10.1038/s41593-024-0001" }],
    });
    assert.ok(pubmedRec);
    assert.equal(pubmedRec.authors[0]?.family, "Smith");
    assert.equal(formatCitation(pubmedRec, "ieee"), webCite.formatCitation(pubmedRec, "ieee"));
    assert.equal(formatCitation(pubmedRec, "nature"), webCite.formatCitation(pubmedRec, "nature"));
    assert.equal(formatCitation(pubmedRec, "apa"), webCite.formatCitation(pubmedRec, "apa"));
    assert.ok(formatCitation(pubmedRec, "ieee").startsWith("J. A. Smith and H. M. van der Berg,"));
    assert.ok(formatCitation(pubmedRec, "nature").startsWith("Smith, J. A. & van der Berg, H. M."));
    assert.ok(formatCitation(pubmedRec, "apa").startsWith("Smith, J. A., & van der Berg, H. M. (2024)."));
    assert.ok(formatCitation(pubmedRec, "bibtex").startsWith("@article{smith2024,"));

    // 2. Crossref 双作者 APA 对照: "Smith, J., & Brown, J."
    const crossrefRec = parseCrossrefItem({
      DOI: "10.1000/apa-test",
      title: ["Empirical Study of Citations"],
      author: [
        { given: "Jane", family: "Smith" },
        { given: "John", family: "Brown" },
      ],
      issued: { "date-parts": [[2020]] },
      "container-title": ["Journal of Testing"],
      volume: "12",
      issue: "3",
      page: "45-60",
    });
    assert.equal(formatCitation(crossrefRec, "apa"), webCite.formatCitation(crossrefRec, "apa"));
    assert.ok(
      formatCitation(crossrefRec, "apa").startsWith("Smith, J., & Brown, J. (2020). Empirical Study of Citations."),
      `got APA: ${formatCitation(crossrefRec, "apa")}`,
    );
  });

  it("OCV5-865: evidenceGrade A 仅来自已核验本地证据，调用方自报 A 不得提权 (#7)", async () => {
    const { checkManifest } = await import("../research/checkManifest.js");
    assert.equal(resolveEvidenceGrade({ quoteBound: true }), "A");
    assert.equal(resolveEvidenceGrade({ localEvidenceVerified: true }), "A");
    assert.equal(resolveEvidenceGrade({ localEvidenceVerified: false, docId: "doc:abc", spanId: "s0", evidenceGrade: "A" }), "B");
    assert.equal(resolveEvidenceGrade({ evidenceGrade: "A" }), "B");
    assert.equal(resolveEvidenceGrade({ evidenceGrade: "A", quoteBound: false }), "B");
    assert.equal(resolveEvidenceGrade({}), "B");
    assert.equal(resolveEvidenceGrade({ docId: "doc:abc" }), "B");
    assert.equal(resolveEvidenceGrade({ evidenceGrade: "B", quoteBound: true }), "B");

    // checkManifest: 无 quotes/supports 且调用方自报 A → 必须仍为 unchecked + evidenceGrade B
    const checked = await checkManifest(
      {
        sources: [],
        quotes: [],
        claims: [
          {
            id: "c-spoof",
            text: "Unverified claim attempting self-grade A",
            supports: [],
            status: "unchecked",
            evidenceGrade: "A",
          },
        ],
        coverage: { verifiedClaims: 0, totalClaims: 1 },
        gates: {
          quoteFirst: { checked: 0, failed: 0, passed: true },
          claimBound: { checked: 0, failed: 0, passed: true },
          identifier: { checked: 0, failed: 0, passed: true },
          retraction: { checked: 0, failed: 0, passed: true },
        },
      },
      {
        getDocument: async () => null,
        verifyIdentifier: async (id) => ({ identifier: id, resolved: false, retracted: null }),
      },
    );
    assert.equal(checked.manifest.claims[0]?.status, "unchecked");
    assert.equal(checked.manifest.claims[0]?.evidenceGrade, "B");
    assert.equal(checked.manifest.claims[0]?.verdict?.quoteBound, false);
    assert.equal(checked.manifest.claims[0]?.verdict?.evidenceGrade, "B");
  });
});
