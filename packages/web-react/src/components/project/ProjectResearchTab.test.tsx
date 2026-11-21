import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvidenceManifest } from "@openclaude/protocol/research";
import { parseProjectPath, projectPath } from "../../hooks/useAppRoute";
import { ProjectScopeProvider } from "../../hooks/useProjectScope";
import {
  buildResearchImportPayload,
  type BatchImportOutcome,
  type LocatedSpan,
} from "../../lib/api/wave4Api";
import { createMemoryAuthSession } from "../../lib/authSession";
import { ClaimList } from "../chat/researchEvidence";
import { ToastProvider, TooltipProvider } from "../ui";
import { ProjectResearchTab } from "./ProjectResearchTab";

const origFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

const MOCK_SPAN: LocatedSpan = {
  docId: "doc:abc123",
  title: "Attention Is All You Need",
  lang: "en",
  spanId: "s0",
  spanIndex: 0,
  totalSpans: 3,
  sectionPath: ["1", "Introduction"],
  charStart: 0,
  charEnd: 92,
  page: 2,
  pageSource: "explicit",
  quote: "The Transformer relies entirely on self-attention to compute representations of its input and output.",
  contextBefore: "Recurrent models factor computation along symbol positions.",
  contextAfter: "In the following sections, we describe the Transformer architecture.",
  beforeSpans: [],
  afterSpans: [{ spanId: "s1", text: "In the following sections...", charStart: 93, charEnd: 160 }],
  verifiedSource: {
    id: "src-1",
    title: "Attention Is All You Need",
    authors: [{ name: "Ashish Vaswani" }, { name: "Noam Shazeer" }],
    year: 2017,
    venue: "NeurIPS",
    doi: "10.48550/arXiv.1706.03762",
    arxivId: "1706.03762",
    oa: { isOA: true, url: "https://arxiv.org/abs/1706.03762" },
    retracted: false,
    identifiersVerified: true,
  },
};

describe("ProjectResearchTab & CitationSpanDrawer · 路由与纯函数", () => {
  it("支持 /p/<id>/research 路由解析与生成", () => {
    expect(parseProjectPath("/p/proj-1/research")).toEqual({ projectId: "proj-1", tab: "research" });
    expect(projectPath({ projectId: "proj-1", tab: "research" })).toBe("/p/proj-1/research");
  });

  it("区分 BibTeX 与 DOI/arXiv 列表构造导入载荷", () => {
    expect(buildResearchImportPayload("10.1038/x\narXiv:2307.09288", "p1")).toEqual({
      projectId: "p1",
      identifiers: ["10.1038/x", "arXiv:2307.09288"],
    });
    expect(buildResearchImportPayload("@article{vaswani2017, title={Attention}}", "p1")).toEqual({
      projectId: "p1",
      bibtex: "@article{vaswani2017, title={Attention}}",
    });
  });
});

describe("ProjectResearchTab · 批量导入与原文 Span 溯源闭环", () => {
  it("展示课题文献库、提交批量导入明细（成功/重复/失败 + verifiedSource）并打开原文抽屉", async () => {
    const auth = createMemoryAuthSession(() => {}, "jwt-research-token");
    const outcome: BatchImportOutcome = {
      ok: true,
      totalSubmitted: 3,
      projectId: "p1",
      imported: [
        {
          dedupeKey: "arxiv:1706.03762",
          raw: "arXiv:1706.03762",
          docId: "doc:abc123",
          title: "Attention Is All You Need",
          spanCount: 3,
          source: "arxiv",
          bibliographicResolved: true,
          fulltextVerified: true,
          verified: true,
        },
      ],
      duplicates: [
        { dedupeKey: "doi:10.1000/dup", raw: "10.1000/dup", reason: "already_in_library" },
      ],
      failed: [
        { dedupeKey: "bad:id", raw: "not-a-doi", reason: "无法识别的标识符" },
      ],
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/me/research/library?projectId=p1" && init?.method === "GET") {
        return new Response(
          JSON.stringify({
            documents: [
              {
                docId: "doc:abc123",
                title: "Attention Is All You Need",
                lang: "en",
                spanCount: 3,
                createdAt: "2026-11-20T10:00:00Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "/api/me/research/library/import-ids" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body.projectId).toBe("p1");
        return new Response(JSON.stringify(outcome), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("/api/me/research/library/doc%3Aabc123/span/s0")) {
        return new Response(JSON.stringify(MOCK_SPAN), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    render(
      <TooltipProvider>
        <ToastProvider>
          <ProjectResearchTab
            projectId="p1"
            projectName="深度调研课题"
            demo={false}
            authSession={auth}
          />
        </ToastProvider>
      </TooltipProvider>,
    );

    expect(await screen.findByText("Attention Is All You Need")).toBeInTheDocument();

    // 粘贴批量导入并提交
    fireEvent.change(screen.getByTestId("research-import-input"), {
      target: { value: "arXiv:1706.03762\n10.1000/dup\nnot-a-doi" },
    });
    fireEvent.click(screen.getByTestId("research-import-submit"));

    expect(await screen.findByTestId("research-import-result")).toBeInTheDocument();
    expect(screen.getByTestId("import-count-success")).toHaveTextContent("成功 1");
    expect(screen.getByTestId("import-count-duplicate")).toHaveTextContent("重复 1");
    expect(screen.getByTestId("import-count-failed")).toHaveTextContent("失败 1");
    expect(screen.getByTestId("import-verified-badge")).toHaveTextContent("verifiedSource");

    // 点击文献行打开原文 Span 抽屉
    fireEvent.click(screen.getByTestId("research-doc-open-doc:abc123"));

    expect(await screen.findByTestId("citation-span-drawer")).toBeInTheDocument();
    expect(await screen.findByTestId("citation-verbatim-quote")).toHaveTextContent(
      "The Transformer relies entirely on self-attention",
    );
    expect(screen.getByTestId("citation-page-badge")).toHaveTextContent("第 2 页 · 原文页码");
    expect(screen.getByTestId("citation-verified-badge")).toHaveTextContent("权威出版源已验证");
    expect(screen.getByTestId("citation-context-before")).toHaveTextContent("Recurrent models");
    expect(screen.getByTestId("citation-context-after")).toHaveTextContent("Transformer architecture");
  });

  it("在对话/报告 ClaimList 中点击「原文溯源」直通 CitationSpanDrawer", async () => {
    const auth = createMemoryAuthSession(() => {}, "jwt-claim-token");
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/me/research/library/doc%3Aabc123/span/s0")) {
        return new Response(JSON.stringify(MOCK_SPAN), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ projects: [] }), { status: 200 });
    }) as typeof fetch;

    const manifest: EvidenceManifest = {
      claims: [
        {
          id: "c1",
          text: "Transformer 完全依赖自注意力机制。",
          status: "verified",
          supports: [{ quoteId: "q1" }],
        },
      ],
      quotes: [
        {
          id: "q1",
          sourceId: "src-1",
          docId: "doc:abc123",
          spanId: "s0",
          charStart: 0,
          charEnd: 92,
          text: MOCK_SPAN.quote,
        },
      ],
      sources: [MOCK_SPAN.verifiedSource!],
      coverage: { verifiedClaims: 1, totalClaims: 1 },
      gates: {
        quoteFirst: { passed: true, checked: 1, failed: 0 },
        claimBound: { passed: true, checked: 1, failed: 0 },
        identifier: { passed: true, checked: 1, failed: 0 },
        retraction: { passed: true, checked: 1, failed: 0 },
      },
    };

    render(
      <ToastProvider>
        <ProjectScopeProvider auth={auth} chatProjects={[]}>
          <ClaimList manifest={manifest} />
        </ProjectScopeProvider>
      </ToastProvider>,
    );

    // 展开引用角标 [1]
    fireEvent.click(screen.getByRole("button", { name: "[1]" }));
    fireEvent.click(screen.getByTestId("evidence-trace-span-s0"));

    await waitFor(() => expect(screen.getByTestId("citation-span-drawer")).toBeInTheDocument());
    expect(await screen.findByTestId("citation-verbatim-quote")).toHaveTextContent("self-attention");
  });
});
