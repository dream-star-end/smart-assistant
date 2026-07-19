/**
 * Phase 2 端到端集成(真 PG + tmp blob dir + 真 store,mock cite verify fetch):
 *   blob 上传 → oc-ingest 铸造权威文档 → oc-litrag 取 quote handle → oc-cite check 铸 verified。
 * 验证证据权威链经**真实 research_documents 存储**闭环:
 *   - quote 文本来自权威 span(非容器输入)。
 *   - check 用权威 span 覆盖 LLM 伪造文本。
 *   - identifier 命中 + 未撤稿 → master 铸 verified。
 */
process.env.OPENCLAUDE_KMS_KEY = process.env.OPENCLAUDE_KMS_KEY ?? Buffer.alloc(32, 7).toString("base64");

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, beforeEach, describe, it } from "node:test";

import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { resetTestSchemaForTest } from "./helpers/db.js";
import { hashSecret } from "../auth/containerIdentity.js";
import { makeResearchProxyHandler } from "../research/researchProxy.js";
import { DEFAULT_RESEARCH_CONFIG, type ResearchConfigPublic } from "../admin/researchConfig.js";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

let pgAvailable = false;
let userId = 0;
let blobDir = "";
const SECRET = "a1".repeat(32);
const auth = `Bearer oc-v3.7.${SECRET}`;
const ctx = { hostUuid: "h1", boundIp: "10.0.0.1" };

function repo(): any {
  return {
    findActiveByHostAndBoundIp: async () => ({
      id: 7,
      user_id: userId,
      bound_ip: "10.0.0.1",
      host_uuid: "h1",
      secret_hash: hashSecret(SECRET),
    }),
  };
}

const enabledCfg = (): Promise<ResearchConfigPublic> =>
  Promise.resolve({ enabled: true, config: DEFAULT_RESEARCH_CONFIG });

// cite verify mock:10.1234/x 命中且未撤稿
function citeFetch(): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("api.crossref.org/works/10.1234")) {
      return new Response(
        JSON.stringify({ message: { DOI: "10.1234/x", title: ["Src"], author: [{ family: "Bee" }], issued: { "date-parts": [[2020]] } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("nf", { status: 404 });
  }) as unknown as typeof fetch;
}

function makeReqRaw(method: string, url: string, body: Buffer | string, contentType: string): any {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  const r = Readable.from([buf]) as any;
  r.method = method;
  r.url = url;
  r.headers = { authorization: auth, "content-type": contentType };
  return r;
}

function makeRes(): { res: any; captured: { statusCode: number; body: any } } {
  const captured = { statusCode: 0, body: undefined as any };
  const res: any = {
    headersSent: false,
    setHeader() {},
    writeHead(s: number) {
      captured.statusCode = s;
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

function handler() {
  return makeResearchProxyHandler({
    identityRepo: repo(),
    readConfig: enabledCfg,
    fetchImpl: citeFetch(),
    store: { blobDir },
  });
}

async function probePg(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try { await p.query("SELECT 1"); await p.end(); return true; }
  catch { try { await p.end(); } catch {} return false; }
}

before(async () => {
  pgAvailable = await probePg();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  await resetPool();
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }));
  await resetTestSchemaForTest();
  await runMigrations();
  blobDir = mkdtempSync(path.join(os.tmpdir(), "oc-research-blob-test-"));
});

after(async () => {
  if (pgAvailable) {
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query("TRUNCATE TABLE research_documents, research_blobs, users RESTART IDENTITY CASCADE");
  const u = await query<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ('a@test','x') RETURNING id::text AS id");
  userId = Number(u.rows[0].id);
});

describe("Phase 2 chain (real store)", () => {
  it("blob → ingest → litrag → cite check 闭环铸 verified;覆盖 LLM 伪造 quote", async (t) => {
    if (!pgAvailable) { t.skip("pg not running"); return; }
    const h = handler();
    const md = "# Sky\n\nThe sky is blue because of Rayleigh scattering of sunlight.\n\nCats are unrelated animals.";

    // 1) blob 上传(原始字节)
    const r1 = makeRes();
    await h(makeReqRaw("POST", "/v3/research/blob", md, "text/markdown"), r1.res, ctx);
    assert.equal(r1.captured.statusCode, 200, JSON.stringify(r1.captured.body));
    const blobId = r1.captured.body.blobId;
    assert.ok(blobId);

    // 2) ingest 铸造权威文档
    const r2 = makeRes();
    await h(makeReqRaw("POST", "/v3/research/ingest/parse", JSON.stringify({ blobId, filename: "a.md" }), "application/json"), r2.res, ctx);
    assert.equal(r2.captured.statusCode, 200, JSON.stringify(r2.captured.body));
    const docId = r2.captured.body.docId;
    assert.ok(docId);
    assert.ok(r2.captured.body.spanCount >= 2);

    // 3) litrag 取 quote handle(权威 span 子串)
    const r3 = makeRes();
    await h(makeReqRaw("POST", "/v3/research/litrag/query", JSON.stringify({ docIds: [docId], query: "sky blue rayleigh" }), "application/json"), r3.res, ctx);
    assert.equal(r3.captured.statusCode, 200);
    const quotes = r3.captured.body.quotes;
    assert.ok(quotes.length >= 1);
    assert.ok(quotes[0].text.includes("Rayleigh"), `quote should be authoritative span: ${quotes[0].text}`);
    const q = quotes[0];

    // 4) 攻击者组装 manifest:quote.text 被 LLM 篡改 + 挂一个无关真 DOI 想冒充已发表文献
    const tamperedQuote = { ...q, sourceId: "famous", text: "FAKE: the sky is green" };
    const manifest = {
      sources: [{ id: "famous", title: "Famous Paper", authors: [], doi: "10.1038/nature-famous" }],
      quotes: [tamperedQuote],
      claims: [{ id: "c1", text: "Sky is blue due to Rayleigh scattering.", supports: [{ quoteId: q.id }], status: "verified" }],
    };
    const r4 = makeRes();
    await h(makeReqRaw("POST", "/v3/research/cite/check", JSON.stringify({ manifest }), "application/json"), r4.res, ctx);
    assert.equal(r4.captured.statusCode, 200, JSON.stringify(r4.captured.body));
    const out = r4.captured.body.manifest;
    // 红线1:伪造 quote 文本被权威 span 覆盖
    assert.ok(out.quotes[0].text.includes("Rayleigh"), `canonical should override tamper: ${out.quotes[0].text}`);
    assert.ok(!out.quotes[0].text.includes("FAKE"));
    // 红线2:提交的 sources/sourceId 被忽略 —— 攻击者 DOI 绝不出现,source = 上传文档
    assert.ok(!JSON.stringify(out).includes("nature-famous"), "submitted fake DOI must never leak");
    assert.equal(out.quotes[0].sourceId, docId);
    assert.equal(out.sources[0].id, docId);
    assert.equal(out.sources[0].doi, undefined);
    // 上传文档无出版身份 → quote-bound verified,但 identifierVerified=false(诚实,不冒充已发表)
    assert.equal(out.claims[0].status, "verified");
    assert.equal(out.claims[0].verdict.identifierVerified, false);
    assert.equal(out.coverage.verifiedClaims, 1);
    assert.equal(out.gates.quoteFirst.passed, true);
  });

  it("ingest 不存在的 blob → 400 INGEST_FAILED", async (t) => {
    if (!pgAvailable) { t.skip("pg not running"); return; }
    const h = handler();
    const r = makeRes();
    await h(makeReqRaw("POST", "/v3/research/ingest/parse", JSON.stringify({ blobId: "nope" }), "application/json"), r.res, ctx);
    assert.equal(r.captured.statusCode, 400);
  });
});
