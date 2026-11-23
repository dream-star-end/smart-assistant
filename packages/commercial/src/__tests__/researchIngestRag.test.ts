/**
 * oc-ingest / oc-litrag / oc-cite check 纯逻辑单测(无 PG/网络):
 *   - ingest:抽取(txt/md/html/pdf 注入)、splitSpans(偏移+section)、mintDocument(docId 确定性)。
 *   - litrag:tokenize(ascii+cjk)、queryDocuments(排序/topK/quote=权威 span 文本)。
 *   - checkManifest(红线):quote 回查权威 span + range canonical 覆盖、status 由 master 铸造
 *     (忽略 LLM 提交)、四道闸、fail-closed(撤稿/未命中 → unsupported,不抛)。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  extractHtml,
  extractLocal,
  extractPdf,
  extractPdfTitle,
  extractPlainText,
  isNeedsOcr,
  isUselessPdfTitle,
  mintDocument,
  splitSpans,
} from "../research/ingest.js";
import { queryDocuments, tokenize } from "../research/litrag.js";
import { checkManifest } from "../research/checkManifest.js";
import type { CitationVerdict, EvidenceManifest, NormalizedDocument } from "@openclaude/protocol/research";

// ── ingest ───────────────────────────────────────────────────────────

describe("ingest: extract", () => {
  it("plain text + markdown title", () => {
    const r = extractPlainText(Buffer.from("# Hello\n\nbody text here"));
    assert.equal(r.title, "Hello");
    assert.ok(r.text.includes("body text"));
  });

  it("html strip tags + title", () => {
    const r = extractHtml(Buffer.from("<html><title>T</title><body><p>Hi <b>there</b></p><script>x()</script></body></html>"));
    assert.equal(r.title, "T");
    assert.ok(r.text.includes("Hi"));
    assert.ok(r.text.includes("there"));
    assert.ok(!r.text.includes("x()"));
  });

  it("pdf 注入抽取:正常文本", async () => {
    const r = await extractPdf(Buffer.from("x"), async () => ({ text: "A".repeat(100), info: { Title: "PdfTitle" } }));
    assert.ok(!isNeedsOcr(r));
    if (!isNeedsOcr(r)) assert.equal(r.title, "PdfTitle");
  });

  it("pdf 文字层过短 → needs_ocr(扫描件)", async () => {
    const r = await extractPdf(Buffer.from("x"), async () => ({ text: "  a b  " }));
    assert.ok(isNeedsOcr(r));
  });

  it("extractLocal 路由:caj → needs_ocr", async () => {
    const r = await extractLocal(Buffer.from("x"), "application/octet-stream", "paper.caj");
    assert.ok(isNeedsOcr(r));
  });

  it("extractLocal 路由:md 直取", async () => {
    const r = await extractLocal(Buffer.from("# T\n\nbody"), "text/markdown", "a.md");
    assert.ok(!isNeedsOcr(r));
  });

  it("OCV5-874 #4b: Copernicus GMD PDF 无 /Title 元数据时从正文抽取真实多行标题与章节路径", async () => {
    const gmdText = [
      "Geosci. Model Dev., 16, 4215–4238, 2023",
      "https://doi.org/10.5194/gmd-16-4215-2023",
      "© Author(s) 2023. This work is distributed under",
      "the Creative Commons Attribution 4.0 License.",
      "Geoscientific",
      "Model Development",
      "Open Access",
      "Model description paper",
      "A high-resolution global coupled ocean–atmosphere model for",
      "seasonal climate prediction (GCOAM v2.1)",
      "Alice Smith1, Bob Jones2, and Carol Lee1",
      "1Department of Atmospheric Sciences, University of Example",
      "Correspondence: Alice Smith (alice@example.edu)",
      "Received: 10 January 2023 – Discussion started: 25 January 2023",
      "Abstract. In this study we present the GCOAM v2.1 coupled Earth system model.",
      "1 Introduction",
      "Seasonal climate prediction relies on coupled ocean and atmosphere dynamics.",
      "2 Model description",
      "The coupled framework integrates atmospheric and oceanic components.",
      "2.1 Dynamical core",
      "We employ a finite-volume dynamical core on a cubed-sphere grid.",
      "3 Results",
      "Skill scores improve significantly across the tropical Pacific.",
      "References",
      "1. Smith, A. and Jones, B. (2020) Coupled Climate Dynamics.",
    ].join("\n");

    const r = await extractPdf(Buffer.from("gmd"), async () => ({ text: gmdText, info: { Title: "" } }));
    assert.ok(!isNeedsOcr(r));
    if (!isNeedsOcr(r)) {
      assert.equal(
        r.title,
        "A high-resolution global coupled ocean–atmosphere model for seasonal climate prediction (GCOAM v2.1)",
      );
      const doc = mintDocument({ text: r.text, title: r.title });
      const paths = doc.spans.map((s) => s.sectionPath).filter((p) => p.length > 0);
      assert.ok(paths.some((p) => p.join(" / ") === "Abstract"));
      assert.ok(paths.some((p) => p.join(" / ") === "1 Introduction"));
      assert.ok(paths.some((p) => p.join(" / ") === "2 Model description"));
      assert.ok(paths.some((p) => p.join(" / ") === "2 Model description / 2.1 Dynamical core"));
      assert.ok(paths.some((p) => p.join(" / ") === "3 Results"));
      assert.ok(paths.some((p) => p.join(" / ") === "References"));
      // References 下的编号条目不应被误识别为章节标题
      assert.ok(!paths.some((p) => p.some((seg) => seg.includes("Smith, A."))));
      for (const s of doc.spans) {
        assert.equal(r.text.slice(s.charStart, s.charEnd), s.text);
      }
    }
  });

  it("OCV5-874 #4b: arXiv PDF 过滤 Template for manuscripts 等模板元数据与运行页眉", async () => {
    const arxivText = [
      "Template for manuscripts in Advances in Space Research",
      "arXiv:2405.12345v1 [astro-ph.EP] 20 May 2024",
      "Preprint submitted to Advances in Space Research",
      "May 20, 2024",
      "",
      "Orbital Perturbations of Near-Earth Asteroids under Non-Gravitational Forces",
      "Jane Doe a , John Smith b",
      "Department of Planetary Sciences, Example Institute",
      "",
      "Abstract",
      "We investigate the long-term orbital evolution of near-Earth asteroids.",
    ].join("\n");

    const r = await extractPdf(Buffer.from("arxiv"), async () => ({
      text: arxivText,
      info: { Title: "Template for manuscripts in Advances in Space Research" },
    }));
    assert.ok(!isNeedsOcr(r));
    if (!isNeedsOcr(r)) {
      assert.equal(r.title, "Orbital Perturbations of Near-Earth Asteroids under Non-Gravitational Forces");
    }

    // 其它常见模板/页眉/无意义标题必须被识别为无效标题
    for (const junk of [
      "Template for manuscripts in Advances in Space Research",
      "Preprint",
      "Preprint. Under review.",
      "Under review as a conference paper at ICLR 2025",
      "Manuscript submitted to Journal of Geophysical Research",
      "arXiv:2301.00001v2 [cs.CL] 1 Jan 2023",
      "https://doi.org/10.5194/gmd-16-4215-2023",
      "© 2024 The Authors. All rights reserved.",
      "Page 1 of 12",
      "2024-05-20",
      "paper.pdf",
      "CONFIDENTIAL",
      "Draft",
      "Draft v2",
    ]) {
      assert.equal(isUselessPdfTitle(junk), true, `应过滤垃圾标题: ${junk}`);
    }

    // 正常中文/英文真实标题（含 Confidential / Draft 词首的合法学术标题）不得被误滤
    assert.equal(isUselessPdfTitle("基于大语言模型的科研文献证据接地方法研究"), false);
    assert.equal(isUselessPdfTitle("Confidential Computing for Genomics"), false);
    assert.equal(isUselessPdfTitle("Draft Genome Sequence of Arabidopsis"), false);
    assert.equal(
      extractPdfTitle(
        "第 45 卷 第 3 期 计 算 机 学 报 Vol. 45 No. 3\n2022 年 3 月\n基于大语言模型的科研文献证据接地方法研究\n张三1, 李四2, 王五1\n摘要：本文提出一种可核验的引用接地方法。",
      ),
      "基于大语言模型的科研文献证据接地方法研究",
    );
    assert.equal(
      extractPdfTitle(
        "Under review\narXiv:2501.00001v1 [cs.AI] 2 Jan 2025\n1\n\nScalable Verification of Scientific Claims\nWei Zhang, Li Wang\nAbstract\nDetails follow.",
        "Under review",
      ),
      "Scalable Verification of Scientific Claims",
    );
  });
});

describe("ingest: splitSpans + mintDocument", () => {
  it("splitSpans:段落 + markdown sectionPath + 精确偏移", () => {
    const text = "# Intro\n\nfirst para.\n\n## Methods\n\nsecond para.";
    const spans = splitSpans(text);
    // 4 段:# Intro / first / ## Methods / second
    assert.equal(spans.length, 4);
    const second = spans.find((s) => s.text === "second para.")!;
    assert.deepEqual(second.sectionPath, ["Intro", "Methods"]);
    // 偏移精确:text.slice 回放等于 span.text
    for (const s of spans) assert.equal(text.slice(s.charStart, s.charEnd), s.text);
  });

  it("mintDocument:docId 内容派生(同内容同 id,变内容变 id)", () => {
    const a = mintDocument({ text: "# T\n\nhello world" });
    const b = mintDocument({ text: "# T\n\nhello world" });
    const c = mintDocument({ text: "# T\n\nhello mars" });
    assert.equal(a.docId, b.docId);
    assert.notEqual(a.docId, c.docId);
    assert.ok(a.docId.startsWith("doc:"));
    assert.equal(a.spans.length, 2);
  });
});

// ── litrag ───────────────────────────────────────────────────────────

describe("litrag", () => {
  it("tokenize:ascii 词 + cjk 单字", () => {
    const t = tokenize("Deep 学习 model");
    assert.ok(t.includes("deep"));
    assert.ok(t.includes("model"));
    assert.ok(t.includes("学"));
    assert.ok(t.includes("习"));
  });

  it("queryDocuments:命中排序 + quote=权威 span 文本 + sourceId=docId", () => {
    const doc = mintDocument({ text: "Transformers use attention.\n\nCats are unrelated animals." });
    const quotes = queryDocuments([doc], "attention transformers", { topK: 2 });
    assert.ok(quotes.length >= 1);
    assert.equal(quotes[0].docId, doc.docId);
    assert.equal(quotes[0].sourceId, doc.docId);
    // quote 文本就是权威 span 文本(逐字)
    const span = doc.spans.find((s) => s.spanId === quotes[0].spanId)!;
    assert.equal(quotes[0].text, span.text);
    assert.ok(quotes[0].text.includes("attention"));
  });

  it("queryDocuments:空 query → 空", () => {
    const doc = mintDocument({ text: "abc" });
    assert.equal(queryDocuments([doc], "   ", {}).length, 0);
  });
});

// ── checkManifest(红线) ─────────────────────────────────────────────

function doc1(): NormalizedDocument {
  return mintDocument({ text: "The sky is blue because of Rayleigh scattering." });
}

function makeManifest(over: Partial<EvidenceManifest> = {}): EvidenceManifest {
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

function depsFor(doc: NormalizedDocument, verdicts: Record<string, CitationVerdict>) {
  return {
    getDocument: async (docId: string): Promise<NormalizedDocument | null> =>
      docId === doc.docId ? doc : null,
    verifyIdentifier: async (id: string): Promise<CitationVerdict> =>
      verdicts[id] ?? { identifier: id, resolved: false, retracted: null },
  };
}

/** 给文档挂 master 建立的出版身份(verifiedSource)。 */
function withSource(doc: NormalizedDocument, doi: string): NormalizedDocument {
  return { ...doc, verifiedSource: { id: "vs", title: "Published", authors: [], doi } };
}

function quoteFor(doc: NormalizedDocument, id = "q1"): EvidenceManifest["quotes"][number] {
  const s = doc.spans[0];
  return { id, sourceId: "ignored", docId: doc.docId, spanId: s.spanId, charStart: s.charStart, charEnd: s.charEnd, text: "submitted" };
}

describe("checkManifest 红线", () => {
  it("canonical:用权威 span 子串覆盖 LLM 提交的 quote 文本(上传文档 → quote-bound verified)", async () => {
    const doc = doc1();
    const s = doc.spans[0];
    const manifest = makeManifest({
      quotes: [{ id: "q1", sourceId: "x", docId: doc.docId, spanId: s.spanId, charStart: s.charStart, charEnd: s.charStart + 11, text: "FABRICATED" }],
      claims: [{ id: "c1", text: "sky", supports: [{ quoteId: "q1" }], status: "verified" }],
    });
    const { manifest: out } = await checkManifest(manifest, depsFor(doc, {}));
    assert.equal(out.quotes[0].text, "The sky is ");
    assert.notEqual(out.quotes[0].text, "FABRICATED");
    // 上传文档无出版身份 → quote-bound 即 verified;source 不带 DOI
    assert.equal(out.claims[0].status, "verified");
    assert.equal(out.sources[0].id, doc.docId);
    assert.equal(out.sources[0].doi, undefined);
    assert.equal(out.claims[0].verdict?.identifierVerified, false);
  });

  it("P0 整数 guard:charStart 非整数 → 丢弃 quote,不 slice(NaN)", async () => {
    const doc = doc1();
    const s = doc.spans[0];
    const manifest = makeManifest({
      // @ts-expect-error 故意传非法 charStart
      quotes: [{ id: "q1", sourceId: "x", docId: doc.docId, spanId: s.spanId, charStart: "x", charEnd: 5, text: "t" }],
      claims: [{ id: "c1", text: "c", supports: [{ quoteId: "q1" }], status: "verified" }],
    });
    const { manifest: out, gates } = await checkManifest(manifest, depsFor(doc, {}));
    assert.equal(out.quotes.length, 0);
    assert.equal(out.claims[0].status, "unsupported");
    assert.equal(gates.quoteFirst.passed, false);
  });

  it("P0 防伪造:提交的 manifest.sources/quote.sourceId 被忽略(挂真 DOI 也不冒充)", async () => {
    const doc = doc1(); // 上传文档,无 verifiedSource
    const manifest = makeManifest({
      // 攻击者提交一个名 paper 的真 DOI,并把 quote.sourceId 指过去
      sources: [{ id: "famous", title: "Famous Paper", authors: [], doi: "10.1038/nature-famous" }],
      quotes: [{ ...quoteFor(doc), sourceId: "famous" }],
      claims: [{ id: "c1", text: "claim", supports: [{ quoteId: "q1" }], status: "verified" }],
    });
    const { manifest: out } = await checkManifest(manifest, depsFor(doc, {}));
    // master 自建 source = 上传文档,绝不出现攻击者的 DOI
    assert.equal(out.sources.length, 1);
    assert.equal(out.sources[0].id, doc.docId);
    assert.equal(out.sources[0].doi, undefined);
    assert.ok(!JSON.stringify(out).includes("nature-famous"), "攻击者 DOI 绝不能出现在输出");
    // quote.sourceId 被 override 为 docId
    assert.equal(out.quotes[0].sourceId, doc.docId);
    // claim 是 quote-bound verified,但 identifierVerified=false(上传,无出版身份)
    assert.equal(out.claims[0].status, "verified");
    assert.equal(out.claims[0].verdict?.identifierVerified, false);
  });

  it("出版身份撤稿 → claim unsupported", async () => {
    const doc = withSource(doc1(), "10.1234/r");
    const manifest = makeManifest({
      quotes: [quoteFor(doc)],
      claims: [{ id: "c1", text: "c", supports: [{ quoteId: "q1" }], status: "verified" }],
    });
    const verdicts = { "10.1234/r": { identifier: "10.1234/r", resolved: true, retracted: true } as CitationVerdict };
    const { manifest: out, gates } = await checkManifest(manifest, depsFor(doc, verdicts));
    assert.equal(out.claims[0].status, "unsupported");
    assert.equal(gates.retraction.passed, false);
  });

  it("出版身份 identifier 未命中 → claim unsupported", async () => {
    const doc = withSource(doc1(), "10.1234/none");
    const manifest = makeManifest({
      quotes: [quoteFor(doc)],
      claims: [{ id: "c1", text: "c", supports: [{ quoteId: "q1" }], status: "verified" }],
    });
    const { manifest: out, gates } = await checkManifest(manifest, depsFor(doc, {}));
    assert.equal(out.claims[0].status, "unsupported");
    assert.equal(gates.identifier.passed, false);
  });

  it("出版身份命中且未撤稿 → verified(source 带回查 DOI)", async () => {
    const doc = withSource(doc1(), "10.1234/ok");
    const manifest = makeManifest({
      quotes: [quoteFor(doc)],
      claims: [{ id: "c1", text: "c", supports: [{ quoteId: "q1" }], status: "unchecked" }],
    });
    const verdicts = {
      "10.1234/ok": { identifier: "10.1234/ok", resolved: true, retracted: false, record: { id: "X", title: "Real", authors: [{ name: "A" }], doi: "10.1234/ok" } } as CitationVerdict,
    };
    const { manifest: out } = await checkManifest(manifest, depsFor(doc, verdicts));
    assert.equal(out.claims[0].status, "verified");
    assert.equal(out.sources[0].identifiersVerified, true);
    assert.equal(out.sources[0].doi, "10.1234/ok");
    assert.equal(out.sources[0].title, "Real");
    assert.equal(out.claims[0].verdict?.identifierVerified, true);
  });

  it("quote 不命中权威 span → 丢弃 + claim unsupported(闸①)", async () => {
    const doc = doc1();
    const manifest = makeManifest({
      quotes: [{ id: "q1", sourceId: "x", docId: doc.docId, spanId: "ghost", charStart: 0, charEnd: 5, text: "x" }],
      claims: [{ id: "c1", text: "c", supports: [{ quoteId: "q1" }], status: "verified" }],
    });
    const { manifest: out, gates } = await checkManifest(manifest, depsFor(doc, {}));
    assert.equal(out.quotes.length, 0);
    assert.equal(out.claims[0].status, "unsupported");
    assert.equal(gates.quoteFirst.passed, false);
  });

  it("range 越界 quote → 丢弃(闸①)", async () => {
    const doc = doc1();
    const s = doc.spans[0];
    const manifest = makeManifest({
      quotes: [{ id: "q1", sourceId: "x", docId: doc.docId, spanId: s.spanId, charStart: s.charStart, charEnd: s.charEnd + 999, text: "x" }],
      claims: [{ id: "c1", text: "c", supports: [{ quoteId: "q1" }], status: "verified" }],
    });
    const { manifest: out } = await checkManifest(manifest, depsFor(doc, {}));
    assert.equal(out.quotes.length, 0);
    assert.equal(out.claims[0].status, "unsupported");
  });

  it("无 support → unchecked", async () => {
    const doc = doc1();
    const manifest = makeManifest({ claims: [{ id: "c1", text: "c", supports: [], status: "verified" }] });
    const { manifest: out } = await checkManifest(manifest, depsFor(doc, {}));
    assert.equal(out.claims[0].status, "unchecked");
  });

  it("coverage 统计正确", async () => {
    const doc = doc1();
    const manifest = makeManifest({
      quotes: [quoteFor(doc)],
      claims: [
        { id: "c1", text: "ok", supports: [{ quoteId: "q1" }], status: "unchecked" },
        { id: "c2", text: "no", supports: [], status: "verified" },
      ],
    });
    const { manifest: out } = await checkManifest(manifest, depsFor(doc, {}));
    assert.equal(out.claims[0].status, "verified");
    assert.equal(out.claims[1].status, "unchecked");
    assert.equal(out.claims[0].evidenceGrade, "A");
    assert.equal(out.claims[0].verdict?.evidenceGrade, "A");
    assert.equal(out.claims[1].evidenceGrade, "B");
    assert.equal(out.claims[1].verdict?.evidenceGrade, "B");
    assert.equal(out.quotes[0].evidenceGrade, "A");
    assert.equal(out.coverage.verifiedClaims, 1);
    assert.equal(out.coverage.totalClaims, 2);
  });
});

describe("checkManifest 闸⑤ MiniCheck 蕴含(P1.5)", () => {
  function vClaim(doc: NormalizedDocument) {
    return makeManifest({
      quotes: [quoteFor(doc)],
      claims: [{ id: "c1", text: "claim", supports: [{ quoteId: "q1" }], status: "verified" }],
    });
  }

  it("未提供 entail → 无 minicheck 闸,verified 不变", async () => {
    const doc = doc1();
    const { manifest: out, gates } = await checkManifest(vClaim(doc), depsFor(doc, {}));
    assert.equal(out.claims[0].status, "verified");
    assert.equal(gates.minicheck, undefined);
  });

  it("entail 高分 → entailmentScore 记录,minicheck 闸通过", async () => {
    const doc = doc1();
    const { manifest: out, gates } = await checkManifest(vClaim(doc), {
      ...depsFor(doc, {}),
      entail: async () => 0.9,
    });
    assert.equal(out.claims[0].status, "verified");
    assert.equal(out.claims[0].verdict?.entailmentScore, 0.9);
    assert.equal(gates.minicheck?.passed, true);
  });

  it("entail 低分 + strict → 降级 unsupported", async () => {
    const doc = doc1();
    const { manifest: out, gates } = await checkManifest(vClaim(doc), {
      ...depsFor(doc, {}),
      entail: async () => 0.2,
      strictEntail: true,
    });
    assert.equal(out.claims[0].status, "unsupported");
    assert.equal(gates.minicheck?.passed, false);
    assert.equal(out.coverage.verifiedClaims, 0);
  });

  it("entail 低分 + 非 strict → 保留 verified,仅 minicheck 闸记失败", async () => {
    const doc = doc1();
    const { manifest: out, gates } = await checkManifest(vClaim(doc), {
      ...depsFor(doc, {}),
      entail: async () => 0.2,
    });
    assert.equal(out.claims[0].status, "verified");
    assert.equal(gates.minicheck?.passed, false);
  });

  it("entail 返 null(服务不可用)→ 跳过,不降级、无闸", async () => {
    const doc = doc1();
    const { manifest: out, gates } = await checkManifest(vClaim(doc), {
      ...depsFor(doc, {}),
      entail: async () => null,
      strictEntail: true,
    });
    assert.equal(out.claims[0].status, "verified");
    assert.equal(gates.minicheck, undefined);
  });
});
