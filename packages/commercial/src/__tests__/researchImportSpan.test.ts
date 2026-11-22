/**
 * 科研文献批量导入(DOI / arXiv / BibTeX)与原文权威 Span 定位单测(OCV5-828 R2 · B1 + B5 + N1 + N2)。
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/researchImportSpan.test.ts
 */
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import type { EvidenceManifest, NormalizedDocument, SourceRecord } from "@openclaude/protocol/research";
import { signAccess } from "../auth/jwt.js";
import { HttpError } from "../http/util.js";
import {
  BatchImportValidationError,
  importResearchBatch,
  makeUserImportLimiter,
  parseBatchImportInput,
  parseBibtexEntries,
} from "../research/batchImport.js";
import { checkManifest } from "../research/checkManifest.js";
import { mintDocument } from "../research/ingest.js";
import { WorkspaceProjectError } from "../research/library.js";
import {
  dispatchResearchLibraryRoute,
  handleGetResearchSpan,
  handleImportResearchIds,
} from "../research/libraryRoutes.js";
import { getResearchSpanForUser, locateDocumentSpan } from "../research/spanLocator.js";

const TEST_JWT_SECRET = "test-secret-for-research-import-span-32bytes";

function makeReq(opts: {
  method: string;
  url: string;
  token?: string;
  body?: unknown;
}): IncomingMessage {
  const payload = opts.body !== undefined ? JSON.stringify(opts.body) : "";
  const stream = Readable.from(payload ? [Buffer.from(payload, "utf8")] : []);
  const req = stream as unknown as IncomingMessage;
  req.method = opts.method;
  req.url = opts.url;
  req.headers = {
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    ...(payload ? { "content-type": "application/json" } : {}),
  };
  return req;
}

function makeRes(): {
  res: ServerResponse;
  statusCode: () => number;
  bodyText: () => string;
  bodyJson: () => unknown;
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  let code = 200;
  const chunks: Buffer[] = [];
  const res = {
    get statusCode() {
      return code;
    },
    set statusCode(v: number) {
      code = v;
    },
    setHeader(k: string, v: string | number) {
      headers[k.toLowerCase()] = String(v);
    },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
  } as unknown as ServerResponse;
  return {
    res,
    statusCode: () => code,
    bodyText: () => Buffer.concat(chunks).toString("utf8"),
    bodyJson: () => JSON.parse(Buffer.concat(chunks).toString("utf8")),
    headers,
  };
}

const ENABLED_CFG = {
  enabled: true,
  config: {
    litSources: { crossrefMailto: "test@example.com" },
    ingest: { engine: "local" as const },
  },
} as never;

const DISABLED_CFG = {
  enabled: false,
  config: {
    litSources: {},
    ingest: { engine: "local" as const },
  },
} as never;

describe("parseBibtexEntries & parseBatchImportInput (N1 single-pass budget)", () => {
  it("parses nested braces, quoted values, DOI, arXiv eprint and skips @comment", () => {
    const bib = `
      @comment{ignore me}
      @article{vaswani2017,
        title = {Attention Is All {You} Need},
        author = {Vaswani, Ashish and Shazeer, Noam},
        year = 2017,
        journal = "NeurIPS",
        doi = {10.48550/arXiv.1706.03762},
        eprint = {1706.03762},
        archivePrefix = {arXiv},
        abstract = {We propose the Transformer architecture.}
      }
      @misc{local2026,
        title = "Local Preprint Without Identifiers",
        author = {Zhang, Wei and Li, Ming},
        year = {2026}
      }
    `;
    const entries = parseBibtexEntries(bib);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.citationKey, "vaswani2017");
    assert.equal(entries[0]?.title, "Attention Is All You Need");
    assert.deepEqual(entries[0]?.authors, ["Vaswani, Ashish", "Shazeer, Noam"]);
    assert.equal(entries[0]?.year, 2017);
    assert.equal(entries[0]?.doi, "10.48550/arxiv.1706.03762");
    assert.equal(entries[0]?.arxivId, "1706.03762");
    assert.equal(entries[0]?.abstract, "We propose the Transformer architecture.");
    assert.equal(entries[1]?.doi, undefined);
  });

  it("deduplicates mixed identifiers/BibTeX and exits early when exceeding maxItems", () => {
    const parsed = parseBatchImportInput({
      identifiers: [
        "10.1038/s41586-020-2649-2",
        "https://doi.org/10.1038/S41586-020-2649-2",
        "arXiv:2301.00001v2",
        "https://arxiv.org/abs/2301.00001",
        "not-a-valid-id",
      ],
    });
    assert.equal(parsed.totalSubmitted, 5);
    assert.equal(parsed.unique.length, 2);
    assert.equal(parsed.duplicates.length, 2);
    assert.equal(parsed.invalid.length, 1);

    const oversizedRaw = Array.from({ length: 10 }, (_, i) => `10.1000/paper-${i}`).join("\n");
    assert.throws(
      () => parseBatchImportInput({ rawText: oversizedRaw }, 3),
      (err: unknown) => err instanceof BatchImportValidationError && err.code === "BATCH_TOO_LARGE",
    );
  });
});

describe("B1: mixed-source authority separation across import -> span -> checkManifest", () => {
  it("NEVER stamps verifiedSource onto user BibTeX abstract even when DOI resolves; only 100% trusted upstream text earns identifierVerified=true", async () => {
    const docs = new Map<string, NormalizedDocument>();
    const memberships: Array<{ userId: string; docId: string; projectId: string }> = [];

    const doiRecord: SourceRecord = {
      id: "doi:10.1038/s41586-020-2649-2",
      title: "Array programming with NumPy",
      authors: [{ name: "Charles R. Harris" }],
      year: 2020,
      venue: "Nature",
      doi: "10.1038/s41586-020-2649-2",
      identifiersVerified: true,
    };
    const arxivRecord: SourceRecord = {
      id: "arxiv:2301.00001",
      title: "Scaling Laws Revisited",
      authors: [{ name: "Alice Researcher" }],
      year: 2023,
      arxivId: "2301.00001",
      identifiersVerified: true,
    };

    const deps = {
      readConfig: async () => ENABLED_CFG,
      isWorkspaceEnabled: () => true,
      resolveProjectId: async (_uid: string, pid?: string) => pid ?? "proj-default",
      addMembership: async (userId: string, docId: string, projectId: string) => {
        memberships.push({ userId, docId, projectId });
      },
      getDocument: async (_uid: string | number, docId: string) => docs.get(docId) ?? null,
      putDocument: async (_uid: string | number, doc: NormalizedDocument) => {
        docs.set(doc.docId, doc);
      },
      resolveDoiImpl: async (doi: string) => (doi === "10.1038/s41586-020-2649-2" ? doiRecord : null),
      resolveArxivImpl: async (id: string) => (id === "2301.00001" ? arxivRecord : null),
      resolveTrustedTextImpl: async (rec: SourceRecord) =>
        rec.arxivId === "2301.00001"
          ? "Official arXiv abstract: compute-optimal scaling follows a power law."
          : null,
    };

    // Case A: Mixed BibTeX carrying a REAL DOI + user-fabricated abstract
    const mixedBib = `@article{harris2020,
      title = {Array programming with NumPy},
      author = {Harris, Charles R.},
      year = {2020},
      doi = {10.1038/s41586-020-2649-2},
      abstract = {User fabricated claim: NumPy achieves 999x quantum speedup.}
    }`;

    const res = await importResearchBatch(
      "42",
      {
        bibtex: mixedBib,
        identifiers: ["arxiv:2301.00001"],
        projectId: "proj-alpha",
      },
      deps,
    );
    assert.ok("ok" in res && res.ok);
    assert.equal(res.imported.length, 2);

    const mixedItem = res.imported.find((i) => i.dedupeKey === "doi:10.1038/s41586-020-2649-2")!;
    const trustedItem = res.imported.find((i) => i.dedupeKey === "arxiv:2301.00001")!;

    // 1) Import stage assertions
    assert.equal(mixedItem.bibliographicResolved, true);
    assert.equal(mixedItem.resolvedSource?.doi, "10.1038/s41586-020-2649-2");
    assert.equal(mixedItem.fulltextVerified, false);
    assert.equal(mixedItem.verified, false);
    assert.equal(mixedItem.userSuppliedTextUnverified, true);
    assert.equal(docs.get(mixedItem.docId)?.verifiedSource, undefined);

    assert.equal(trustedItem.bibliographicResolved, true);
    assert.equal(trustedItem.fulltextVerified, true);
    assert.equal(trustedItem.verified, true);
    assert.equal(docs.get(trustedItem.docId)?.verifiedSource?.arxivId, "2301.00001");

    // 2) Span locator stage assertions
    const mixedDoc = docs.get(mixedItem.docId)!;
    const fabricatedSpan = mixedDoc.spans.find((s) => s.text.includes("999x quantum speedup"))!;
    const locatedMixed = locateDocumentSpan(mixedDoc, fabricatedSpan.spanId);
    assert.ok(locatedMixed);
    assert.equal(locatedMixed.verifiedSource, undefined);

    const trustedDoc = docs.get(trustedItem.docId)!;
    const officialSpan = trustedDoc.spans.find((s) => s.text.includes("power law"))!;
    const locatedTrusted = locateDocumentSpan(trustedDoc, officialSpan.spanId);
    assert.ok(locatedTrusted);
    assert.equal(locatedTrusted.verifiedSource?.arxivId, "2301.00001");

    // 3) checkManifest stage assertions (end-to-end citation grounding proof)
    const manifest: EvidenceManifest = {
      sources: [],
      quotes: [
        {
          id: "q-mixed",
          sourceId: mixedDoc.docId,
          docId: mixedDoc.docId,
          spanId: fabricatedSpan.spanId,
          charStart: fabricatedSpan.charStart,
          charEnd: fabricatedSpan.charEnd,
          text: fabricatedSpan.text,
        },
        {
          id: "q-trusted",
          sourceId: trustedDoc.docId,
          docId: trustedDoc.docId,
          spanId: officialSpan.spanId,
          charStart: officialSpan.charStart,
          charEnd: officialSpan.charEnd,
          text: officialSpan.text,
        },
      ],
      claims: [
        { id: "c-mixed", text: "NumPy achieves 999x quantum speedup", supports: [{ quoteId: "q-mixed" }], status: "unchecked" },
        { id: "c-trusted", text: "Compute-optimal scaling follows a power law", supports: [{ quoteId: "q-trusted" }], status: "unchecked" },
      ],
      gates: {
        quoteFirst: { passed: true, checked: 0, failed: 0 },
        claimBound: { passed: true, checked: 0, failed: 0 },
        identifier: { passed: true, checked: 0, failed: 0 },
        retraction: { passed: true, checked: 0, failed: 0 },
      },
      coverage: { totalClaims: 2, verifiedClaims: 0 },
    };

    const checked = await checkManifest(manifest, {
      getDocument: async (id) => docs.get(id) ?? null,
      verifyIdentifier: async (ident) => ({
        identifier: ident,
        resolved: true,
        retracted: false,
        record: arxivRecord,
      }),
    });

    const mixedClaim = checked.manifest.claims.find((c) => c.id === "c-mixed")!;
    const trustedClaim = checked.manifest.claims.find((c) => c.id === "c-trusted")!;
    // Mixed user BibTeX text is quote-bound ONLY, NEVER identifierVerified!
    assert.equal(mixedClaim.verdict?.quoteBound, true);
    assert.equal(mixedClaim.verdict?.identifierVerified, false);
    // Trusted upstream text IS both quoteBound AND identifierVerified!
    assert.equal(trustedClaim.status, "verified");
    assert.equal(trustedClaim.verdict?.quoteBound, true);
    assert.equal(trustedClaim.verdict?.identifierVerified, true);
  });
});

describe("locateDocumentSpan & getResearchSpanForUser", () => {
  it("infers page from PDF form-feeds, returns exact verbatim quote and surrounding context, and enforces tenant isolation", async () => {
    const rawText = [
      "# Introduction",
      "First page intro paragraph.",
      "End of page one.\f# Methods",
      "Page two methodology paragraph with exact claim.",
      "Following paragraph on page two.",
      "Final discussion paragraph.",
    ].join("\n\n");
    const doc = mintDocument({ text: rawText, title: "Demo Paper" });

    const targetSpan = doc.spans[3]!;
    const located = locateDocumentSpan(doc, targetSpan.spanId, { contextWindow: 1 });
    assert.ok(located);
    assert.equal(located.quote, targetSpan.text);
    assert.equal(located.page, 2);
    assert.equal(located.pageSource, "formfeed");
    assert.equal(located.beforeSpans.length, 1);
    assert.equal(located.afterSpans.length, 1);

    const ownerStore = async (uid: bigint | number | string, docId: string) =>
      String(uid) === "100" && docId === doc.docId ? doc : null;

    const okHit = await getResearchSpanForUser("100", doc.docId, targetSpan.spanId, {}, { getDocument: ownerStore });
    assert.equal(okHit?.quote, targetSpan.text);
    const crossTenant = await getResearchSpanForUser("200", doc.docId, targetSpan.spanId, {}, { getDocument: ownerStore });
    assert.equal(crossTenant, null);
  });
});

describe("HTTP routes (B5 exact URL contract): POST /api/me/research/library/import-ids & GET /api/me/research/library/:docId/span/:spanId", () => {
  it("enforces auth (401), rate limits (429), disabled (503), invalid project (400), and singular span path (200/404)", async () => {
    const { token: userToken } = await signAccess({ sub: "100", role: "user" }, TEST_JWT_SECRET);
    const { token: otherToken } = await signAccess({ sub: "200", role: "user" }, TEST_JWT_SECRET);

    await assert.rejects(
      () =>
        dispatchResearchLibraryRoute(
          makeReq({ method: "POST", url: "/api/me/research/library/import-ids", body: { identifiers: ["2301.00001"] } }),
          makeRes().res,
          { jwtSecret: TEST_JWT_SECRET },
        ),
      (err: unknown) => err instanceof HttpError && err.status === 401,
    );

    await assert.rejects(
      () =>
        handleImportResearchIds(
          makeReq({
            method: "POST",
            url: "/api/me/research/library/import-ids",
            token: userToken,
            body: { identifiers: ["2301.00001"] },
          }),
          makeRes().res,
          undefined,
          {
            jwtSecret: TEST_JWT_SECRET,
            limiter: makeUserImportLimiter(60_000, 10, 100),
            importDeps: { readConfig: async () => DISABLED_CFG },
          },
        ),
      (err: unknown) => err instanceof HttpError && err.status === 503,
    );

    await assert.rejects(
      () =>
        handleImportResearchIds(
          makeReq({
            method: "POST",
            url: "/api/me/research/library/import-ids",
            token: userToken,
            body: { identifiers: ["2301.00001"], projectId: "not-mine" },
          }),
          makeRes().res,
          undefined,
          {
            jwtSecret: TEST_JWT_SECRET,
            limiter: makeUserImportLimiter(60_000, 10, 100),
            importDeps: {
              readConfig: async () => ENABLED_CFG,
              isWorkspaceEnabled: () => true,
              resolveProjectId: async () => {
                throw new WorkspaceProjectError("project not found");
              },
            },
          },
        ),
      (err: unknown) => err instanceof HttpError && err.status === 400,
    );

    const tightLimiter = makeUserImportLimiter(60_000, 1, 10);
    const storeDocs = new Map<string, NormalizedDocument>();
    const importDeps = {
      readConfig: async () => ENABLED_CFG,
      isWorkspaceEnabled: () => false,
      getDocument: async (_uid: string | number, docId: string) => storeDocs.get(docId) ?? null,
      putDocument: async (_uid: string | number, doc: NormalizedDocument) => {
        storeDocs.set(doc.docId, doc);
      },
      resolveArxivImpl: async (id: string) => ({
        id: `arxiv:${id}`,
        title: "Quantum Advantage",
        authors: [{ name: "J. Doe" }],
        year: 2025,
        arxivId: id,
        identifiersVerified: true,
      }),
    };

    const res1 = makeRes();
    await dispatchResearchLibraryRoute(
      makeReq({
        method: "POST",
        url: "/api/me/research/library/import-ids",
        token: userToken,
        body: { identifiers: ["2501.00001"] },
      }),
      res1.res,
      { jwtSecret: TEST_JWT_SECRET, limiter: tightLimiter, importDeps },
    );
    assert.equal(res1.statusCode(), 200);
    const body1 = res1.bodyJson() as { imported: Array<{ docId: string }> };
    assert.equal(body1.imported.length, 1);
    const importedDocId = body1.imported[0]!.docId;

    await assert.rejects(
      () =>
        dispatchResearchLibraryRoute(
          makeReq({
            method: "POST",
            url: "/api/me/research/library/import-ids",
            token: userToken,
            body: { identifiers: ["2501.00002"] },
          }),
          makeRes().res,
          { jwtSecret: TEST_JWT_SECRET, limiter: tightLimiter, importDeps },
        ),
      (err: unknown) => err instanceof HttpError && err.status === 429,
    );

    // Singular `/span/` path matches ticket contract
    const spanDeps = {
      getDocument: async (uid: bigint | number | string, docId: string) =>
        String(uid) === "100" ? (storeDocs.get(docId) ?? null) : null,
    };
    const spanRes = makeRes();
    await dispatchResearchLibraryRoute(
      makeReq({
        method: "GET",
        url: `/api/me/research/library/${encodeURIComponent(importedDocId)}/span/s0`,
        token: userToken,
      }),
      spanRes.res,
      { jwtSecret: TEST_JWT_SECRET, spanDeps },
    );
    assert.equal(spanRes.statusCode(), 200);
    const spanBody = spanRes.bodyJson() as { docId: string; spanId: string; quote: string; page: number };
    assert.equal(spanBody.docId, importedDocId);
    assert.equal(spanBody.spanId, "s0");
    assert.ok(spanBody.quote.includes("Quantum Advantage"));

    // Cross-tenant query fails closed with 404
    await assert.rejects(
      () =>
        handleGetResearchSpan(
          makeReq({
            method: "GET",
            url: `/api/me/research/library/${encodeURIComponent(importedDocId)}/span/s0`,
            token: otherToken,
          }),
          makeRes().res,
          undefined,
          { jwtSecret: TEST_JWT_SECRET, spanDeps },
        ),
      (err: unknown) => err instanceof HttpError && err.status === 404,
    );
  });
});
