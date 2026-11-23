/**
 * oc-ingest 外部 PDF 解析接线单测(使用真实本地 mock HTTP server,无 PG/无公网):
 *   1. MinerU / 通用 HTTP endpoint 成功解析(带 Bearer secret + 铸造权威 NormalizedDocument);
 *   2. Mistral OCR `{ pages: [{ markdown }] }` 响应成功解析;
 *   3. 外部 HTTP 500 → 优雅回落本地 pdf-parse(有文字层成功;扫描件保留 needsOcr:true 信号);
 *   4. 外部 HTTP 超时 → AbortController 截断并优雅回落本地 pdf-parse + 清晰保留 needsOcr 信号;
 *   5. 外部响应超字节上限 → 优雅回落不崩溃。
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";

delete process.env.OC_RESEARCH_WORKSPACE;

import { DEFAULT_RESEARCH_CONFIG, type ResearchConfigPublic } from "../admin/researchConfig.js";
import { hashSecret } from "../auth/containerIdentity.js";
import {
  type ResearchProxyHandlerCtx,
  type ResearchStoreDeps,
  makeResearchProxyHandler,
} from "../research/researchProxy.js";

const SECRET = "c3".repeat(32);
const AUTH = `Bearer oc-v3.9.${SECRET}`;
const CTX: ResearchProxyHandlerCtx = { hostUuid: "h-ext", boundIp: "10.0.0.9" };

function passingRepo(): any {
  return {
    findActiveByHostAndBoundIp: async () => ({
      id: 9,
      user_id: 99,
      bound_ip: "10.0.0.9",
      host_uuid: "h-ext",
      secret_hash: hashSecret(SECRET),
    }),
  };
}

function makeReq(url: string, body: unknown): any {
  const payload = JSON.stringify(body);
  const r = Readable.from([Buffer.from(payload)]) as any;
  r.method = "POST";
  r.url = url;
  r.headers = { authorization: AUTH };
  return r;
}

function makeRes(): { res: any; captured: { statusCode: number; body: any } } {
  const captured = { statusCode: 0, body: undefined as any };
  const res: any = {
    headersSent: false,
    setHeader() {},
    writeHead(status: number) {
      captured.statusCode = status;
      res.headersSent = true;
    },
    end(s?: string) {
      if (s) {
        try {
          captured.body = JSON.parse(s);
        } catch {
          captured.body = s;
        }
      }
      res.headersSent = true;
    },
  };
  return { res, captured };
}

function makeMemoryStore(
  bytes: Buffer,
  mime = "application/pdf",
  blobId = "blob-pdf",
): {
  store: Partial<ResearchStoreDeps>;
  savedDocs: Map<string, any>;
} {
  const savedDocs = new Map<string, any>();
  return {
    savedDocs,
    store: {
      getBlob: async (_uid, bid) => (bid === blobId ? { storagePath: `/mem/${blobId}`, mime } : null),
      readBlobBytes: async () => bytes,
      putDocument: async ({ doc }) => {
        savedDocs.set(doc.docId, doc);
      },
      getDocument: async (_uid, docId) => savedDocs.get(docId) ?? null,
    },
  };
}

/** 构造真实最小合法 PDF 1.4 字节流(可用于无 pdfImpl 注入的真实 pdf-parse v2 验收)。 */
function buildRealPdfBuffer(textLine?: string): Buffer {
  const safeText = (textLine ?? "").replace(/[()\\]/g, "");
  const stream = safeText ? `BT /F1 12 Tf 72 720 Td (${safeText}) Tj ET` : "";
  const objs = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const o of objs) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += o;
  }
  const xrefPos = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

describe("researchProxy: external PDF extraction via real local HTTP server (OCV5-865)", () => {
  let server: Server;
  let baseUrl = "";
  let lastAuthHeader: string | undefined;
  let lastBody: any;
  let requestCount = 0;
  let mode: "mineru-ok" | "mistral-ok" | "http-500" | "html-login" | "timeout" | "oversized" = "mineru-ok";

  before(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requestCount++;
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => {
        lastAuthHeader = req.headers.authorization;
        try {
          lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          lastBody = null;
        }
        if (mode === "mineru-ok") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              title: "MinerU Extracted Paper",
              markdown: "# MinerU Extracted Paper\n\n## Results\n\nAccuracy reached 94.2% on benchmark A.",
            }),
          );
          return;
        }
        if (mode === "mistral-ok") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              pages: [
                { markdown: "# Mistral OCR Paper\n\nFirst page formula: E = mc^2." },
                { markdown: "## Discussion\n\nSecond page findings." },
              ],
            }),
          );
          return;
        }
        if (mode === "html-login") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end("<!DOCTYPE html><html><head><title>SSO Login</title></head><body><h1>Sign in</h1></body></html>");
          return;
        }
        if (mode === "http-500") {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "upstream parser crashed" }));
          return;
        }
        if (mode === "oversized") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ text: "x".repeat(4096) }));
          return;
        }
        if (mode === "timeout") {
          // Intentionally hold open past the short test timeout
          const timer = setTimeout(() => {
            if (!res.writableEnded) {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ text: "too late" }));
            }
          }, 2000);
          timer.unref();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function cfgFor(ingest: ResearchConfigPublic["config"]["ingest"]): () => Promise<ResearchConfigPublic> {
    return async () => ({
      enabled: true,
      config: { ...DEFAULT_RESEARCH_CONFIG, ingest },
    });
  }

  it("mineru endpoint extracts PDF over real HTTP with Bearer secret and mints authoritative doc", async () => {
    mode = "mineru-ok";
    lastAuthHeader = undefined;
    lastBody = null;
    const pdfBytes = Buffer.from("%PDF-1.4\nfake-scanned-pdf-bytes");
    const { store, savedDocs } = makeMemoryStore(pdfBytes);

    const h = makeResearchProxyHandler({
      identityRepo: passingRepo(),
      readConfig: cfgFor({ engine: "mineru", mineruEndpoint: `${baseUrl}/parse` }),
      readSecrets: async () => ({ mineruApiKey: "secret-mineru-key" }),
      store,
    });
    const { res, captured } = makeRes();
    await h(makeReq("/v3/research/ingest/parse", { blobId: "blob-pdf", filename: "scan.pdf" }), res, CTX);

    assert.equal(captured.statusCode, 200);
    assert.equal(captured.body.title, "MinerU Extracted Paper");
    assert.ok(captured.body.docId.startsWith("doc:"));
    assert.equal(lastAuthHeader, "Bearer secret-mineru-key");
    assert.equal(lastBody.filename, "scan.pdf");
    assert.equal(Buffer.from(lastBody.contentBase64, "base64").toString("utf8"), pdfBytes.toString("utf8"));
    assert.equal(savedDocs.size, 1);
  });

  it("mistral endpoint parses { pages: [{ markdown }] } over real HTTP", async () => {
    mode = "mistral-ok";
    lastAuthHeader = undefined;
    const pdfBytes = Buffer.from("%PDF-1.4\nmistral-sample");
    const { store } = makeMemoryStore(pdfBytes);

    const h = makeResearchProxyHandler({
      identityRepo: passingRepo(),
      readConfig: cfgFor({ engine: "mistral", mistralEndpoint: `${baseUrl}/ocr` }),
      readSecrets: async () => ({ mistralApiKey: "secret-mistral-key" }),
      store,
    });
    const { res, captured } = makeRes();
    await h(makeReq("/v3/research/ingest/parse", { blobId: "blob-pdf", filename: "eq.pdf" }), res, CTX);

    assert.equal(captured.statusCode, 200);
    assert.equal(captured.body.title, "Mistral OCR Paper");
    assert.equal(lastAuthHeader, "Bearer secret-mistral-key");
    assert.equal(lastBody.model, "mistral-ocr-latest");
  });

  it("external HTTP 500 falls back gracefully to local pdf-parse when text layer exists", async () => {
    mode = "http-500";
    const pdfBytes = Buffer.from("%PDF-1.4\nfallback-text-layer");
    const { store } = makeMemoryStore(pdfBytes);

    const h = makeResearchProxyHandler({
      identityRepo: passingRepo(),
      readConfig: cfgFor({ engine: "mineru", mineruEndpoint: `${baseUrl}/parse` }),
      readSecrets: async () => ({}),
      store,
      ingestExtract: {
        pdfImpl: async () => ({
          text: "# Local Fallback Title\n\nLocal pdf-parse extracted sufficient text layer cleanly.",
          info: { Title: "Local Fallback Title" },
        }),
      },
    });
    const { res, captured } = makeRes();
    await h(makeReq("/v3/research/ingest/parse", { blobId: "blob-pdf", filename: "fallback.pdf" }), res, CTX);

    assert.equal(captured.statusCode, 200);
    assert.equal(captured.body.title, "Local Fallback Title");
    assert.ok(captured.body.docId.startsWith("doc:"));
  });

  it("external HTTP 500 + scanned PDF preserves needsOcr:true with clear reason", async () => {
    mode = "http-500";
    const pdfBytes = Buffer.from("%PDF-1.4\nscanned-no-text");
    const { store } = makeMemoryStore(pdfBytes);

    const h = makeResearchProxyHandler({
      identityRepo: passingRepo(),
      readConfig: cfgFor({ engine: "mineru", mineruEndpoint: `${baseUrl}/parse` }),
      readSecrets: async () => ({}),
      store,
      ingestExtract: {
        pdfImpl: async () => ({ text: "  " }), // scanned PDF → local needs_ocr
      },
    });
    const { res, captured } = makeRes();
    await h(makeReq("/v3/research/ingest/parse", { blobId: "blob-pdf", filename: "scanned.pdf" }), res, CTX);

    assert.equal(captured.statusCode, 200);
    assert.equal(captured.body.needsOcr, true);
    assert.match(captured.body.reason, /HTTP 500/);
    assert.match(captured.body.reason, /local fallback/);
  });

  it("external HTTP timeout aborts cleanly and falls back preserving needsOcr:true", async () => {
    mode = "timeout";
    const pdfBytes = Buffer.from("%PDF-1.4\ntimeout-pdf");
    const { store } = makeMemoryStore(pdfBytes);

    const h = makeResearchProxyHandler({
      identityRepo: passingRepo(),
      readConfig: cfgFor({ engine: "auto", mineruEndpoint: `${baseUrl}/slow` }),
      readSecrets: async () => ({}),
      store,
      externalExtractTimeoutMs: 120,
      ingestExtract: {
        pdfImpl: async () => ({ text: "" }),
      },
    });
    const { res, captured } = makeRes();
    await h(makeReq("/v3/research/ingest/parse", { blobId: "blob-pdf", filename: "slow.pdf" }), res, CTX);

    assert.equal(captured.statusCode, 200);
    assert.equal(captured.body.needsOcr, true);
    assert.match(captured.body.reason, /timeout/i);
  });

  it("external response exceeding maxResponseBytes falls back without crashing", async () => {
    mode = "oversized";
    const pdfBytes = Buffer.from("%PDF-1.4\noversized-resp");
    const { store } = makeMemoryStore(pdfBytes);

    const h = makeResearchProxyHandler({
      identityRepo: passingRepo(),
      readConfig: cfgFor({ engine: "mineru", mineruEndpoint: `${baseUrl}/big` }),
      readSecrets: async () => ({}),
      store,
      externalExtractMaxResponseBytes: 256,
      ingestExtract: {
        pdfImpl: async () => ({ text: "" }),
      },
    });
    const { res, captured } = makeRes();
    await h(makeReq("/v3/research/ingest/parse", { blobId: "blob-pdf", filename: "big.pdf" }), res, CTX);

    assert.equal(captured.statusCode, 200);
    assert.equal(captured.body.needsOcr, true);
    assert.match(captured.body.reason, /exceeds 256 bytes/);
  });

  it("non-PDF (TXT/MD/HTML) triggers ZERO external OCR requests under auto, mineru, and mistral (OCV5-865 #4)", async () => {
    mode = "mineru-ok";
    const cases: Array<{ filename: string; mime: string; content: string; engine: "auto" | "mineru" | "mistral" }> = [
      { filename: "notes.md", mime: "text/markdown", content: "# Local Markdown\n\nClean local text.", engine: "mineru" },
      { filename: "paper.txt", mime: "text/plain", content: "Plain local research notes without external OCR.", engine: "mistral" },
      { filename: "page.html", mime: "text/html", content: "<html><title>Local HTML</title><body><p>Body text</p></body></html>", engine: "auto" },
    ];
    for (const c of cases) {
      requestCount = 0;
      const { store, savedDocs } = makeMemoryStore(Buffer.from(c.content, "utf8"), c.mime, "blob-doc");
      const h = makeResearchProxyHandler({
        identityRepo: passingRepo(),
        readConfig: cfgFor({
          engine: c.engine,
          mineruEndpoint: `${baseUrl}/parse`,
          mistralEndpoint: `${baseUrl}/ocr`,
        }),
        readSecrets: async () => ({}),
        store,
      });
      const { res, captured } = makeRes();
      await h(makeReq("/v3/research/ingest/parse", { blobId: "blob-doc", filename: c.filename }), res, CTX);
      assert.equal(captured.statusCode, 200);
      assert.equal(requestCount, 0, `${c.filename} under ${c.engine} must make 0 external OCR requests`);
      const doc = savedDocs.get(captured.body.docId);
      assert.ok(doc, "local doc must be minted");
      assert.ok(!doc.spans.some((s: any) => s.text.includes("MinerU Extracted Paper")));
    }
  });

  it("real pdf-parse v2 fallback (NO pdfImpl mock!) extracts real text PDF and returns needsOcr for scanned PDF (OCV5-865 #5)", async () => {
    mode = "http-500";
    // 1. Real text PDF — NO ingestExtract.pdfImpl injected!
    const realTextPdf = buildRealPdfBuffer(
      "OpenClaude real PDF local fallback verification text with plenty of characters for pdf-parse v2.",
    );
    const { store: textStore, savedDocs } = makeMemoryStore(realTextPdf);
    const hText = makeResearchProxyHandler({
      identityRepo: passingRepo(),
      readConfig: cfgFor({ engine: "mineru", mineruEndpoint: `${baseUrl}/parse` }),
      readSecrets: async () => ({}),
      store: textStore,
    });
    const textRes = makeRes();
    await hText(makeReq("/v3/research/ingest/parse", { blobId: "blob-pdf", filename: "real-text.pdf" }), textRes.res, CTX);
    assert.equal(textRes.captured.statusCode, 200);
    assert.ok(textRes.captured.body.docId?.startsWith("doc:"), `expected real docId, got ${JSON.stringify(textRes.captured.body)}`);
    const doc = savedDocs.get(textRes.captured.body.docId);
    assert.ok(doc.spans.some((s: any) => s.text.includes("OpenClaude real PDF local fallback verification")));

    // 2. Real blank/scanned PDF — NO ingestExtract.pdfImpl injected!
    const scannedPdf = buildRealPdfBuffer("");
    const { store: scanStore } = makeMemoryStore(scannedPdf);
    const hScan = makeResearchProxyHandler({
      identityRepo: passingRepo(),
      readConfig: cfgFor({ engine: "mineru", mineruEndpoint: `${baseUrl}/parse` }),
      readSecrets: async () => ({}),
      store: scanStore,
    });
    const scanRes = makeRes();
    await hScan(makeReq("/v3/research/ingest/parse", { blobId: "blob-pdf", filename: "real-scan.pdf" }), scanRes.res, CTX);
    assert.equal(scanRes.captured.statusCode, 200);
    assert.equal(scanRes.captured.body.needsOcr, true);
    assert.match(scanRes.captured.body.reason, /local fallback/);
  });

  it("HTTP 200 text/html login page is rejected and falls back locally without ingesting HTML (OCV5-865 #6)", async () => {
    mode = "html-login";
    const scannedPdf = buildRealPdfBuffer("");
    const { store, savedDocs } = makeMemoryStore(scannedPdf);
    const h = makeResearchProxyHandler({
      identityRepo: passingRepo(),
      readConfig: cfgFor({ engine: "mineru", mineruEndpoint: `${baseUrl}/parse` }),
      readSecrets: async () => ({}),
      store,
    });
    const { res, captured } = makeRes();
    await h(makeReq("/v3/research/ingest/parse", { blobId: "blob-pdf", filename: "sso-gated.pdf" }), res, CTX);

    assert.equal(captured.statusCode, 200);
    assert.equal(captured.body.needsOcr, true, "200 text/html login page must NOT be minted as document");
    assert.match(captured.body.reason, /unsupported content-type text\/html/i);
    assert.equal(savedDocs.size, 0, "HTML login page must never be stored in research_documents");
  });
});
