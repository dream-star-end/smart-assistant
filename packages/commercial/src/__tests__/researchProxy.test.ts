/**
 * researchProxy handler 单测(注入 identityRepo + readConfig + mock fetch,无 PG):
 *   - 身份失败 → 401;disabled → 503;限流 → 429;未知路由 → 404;非 POST → 405。
 *   - lit/search 正常 → 200 {sources,warnings};cite/verify → 200 {verdicts};
 *     cite/format → 200 {verdict.formatted}。
 *   - bad input(缺 query / 缺 identifiers)→ 400。
 */
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import {
  type ResearchProxyHandlerCtx,
  makePerContainerLimiter,
  makeResearchProxyHandler,
} from "../research/researchProxy.js";
import { hashSecret } from "../auth/containerIdentity.js";
import { DEFAULT_RESEARCH_CONFIG, type ResearchConfigPublic } from "../admin/researchConfig.js";

// ── identity fakes ───────────────────────────────────────────────────
// token: oc-v3.<cid>.<64-hex secret>;repo.secret_hash = hashSecret(secret)(Buffer)。
const SECRET = "a1".repeat(32); // 64 hex
const goodAuth = `Bearer oc-v3.7.${SECRET}`;
const wrongAuth = `Bearer oc-v3.7.${"b2".repeat(32)}`;

function passingRepo(): any {
  return {
    findActiveByHostAndBoundIp: async () => ({
      id: 7,
      user_id: 42,
      bound_ip: "10.0.0.1",
      host_uuid: "h1",
      secret_hash: hashSecret(SECRET),
    }),
  };
}

const ctx: ResearchProxyHandlerCtx = { hostUuid: "h1", boundIp: "10.0.0.1" };

function enabledCfg(): () => Promise<ResearchConfigPublic> {
  return async () => ({ enabled: true, config: DEFAULT_RESEARCH_CONFIG });
}

// ── req/res fakes ────────────────────────────────────────────────────

function makeReq(method: string, url: string, body?: unknown, auth = goodAuth): any {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const r = Readable.from(payload ? [Buffer.from(payload)] : []) as any;
  r.method = method;
  r.url = url;
  r.headers = { authorization: auth };
  return r;
}

function makeRes(): { res: any; captured: { statusCode: number; body: any; headers: Record<string, string> } } {
  const captured = { statusCode: 0, body: undefined as any, headers: {} as Record<string, string> };
  const res: any = {
    headersSent: false,
    setHeader(k: string, v: string) {
      captured.headers[k.toLowerCase()] = v;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      captured.statusCode = status;
      if (headers) for (const [k, v] of Object.entries(headers)) captured.headers[k.toLowerCase()] = String(v);
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

function mockFetch(routes: Array<{ match: string; json?: unknown; text?: string; status?: number }>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    const route = routes.find((r) => u.includes(r.match));
    if (!route) return new Response("nf", { status: 404 });
    if (route.text !== undefined) return new Response(route.text, { status: route.status ?? 200 });
    return new Response(JSON.stringify(route.json ?? {}), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

// ── gating ───────────────────────────────────────────────────────────

describe("researchProxy: gating", () => {
  it("非 POST → 405", async () => {
    const h = makeResearchProxyHandler({ identityRepo: passingRepo(), readConfig: enabledCfg() });
    const { res, captured } = makeRes();
    await h(makeReq("GET", "/v3/research/lit/search"), res, ctx);
    assert.equal(captured.statusCode, 405);
  });

  it("身份失败(secret 不符)→ 401", async () => {
    const h = makeResearchProxyHandler({ identityRepo: passingRepo(), readConfig: enabledCfg() });
    const { res, captured } = makeRes();
    await h(makeReq("POST", "/v3/research/lit/search", { query: "x" }, wrongAuth), res, ctx);
    assert.equal(captured.statusCode, 401);
  });

  it("disabled → 503", async () => {
    const h = makeResearchProxyHandler({
      identityRepo: passingRepo(),
      readConfig: async () => ({ enabled: false, config: DEFAULT_RESEARCH_CONFIG }),
    });
    const { res, captured } = makeRes();
    await h(makeReq("POST", "/v3/research/lit/search", { query: "x" }), res, ctx);
    assert.equal(captured.statusCode, 503);
  });

  it("限流 → 429", async () => {
    const limiter = makePerContainerLimiter(60_000, 1);
    const h = makeResearchProxyHandler({
      identityRepo: passingRepo(),
      readConfig: enabledCfg(),
      limiter,
      fetchImpl: mockFetch([
        { match: "api.openalex", json: { results: [] } },
        { match: "api.crossref", json: { message: { items: [] } } },
        { match: "export.arxiv", text: "<feed></feed>" },
      ]),
    });
    const r1 = makeRes();
    await h(makeReq("POST", "/v3/research/lit/search", { query: "x" }), r1.res, ctx);
    assert.equal(r1.captured.statusCode, 200);
    const r2 = makeRes();
    await h(makeReq("POST", "/v3/research/lit/search", { query: "x" }), r2.res, ctx);
    assert.equal(r2.captured.statusCode, 429);
  });

  it("未知路由 → 404", async () => {
    const h = makeResearchProxyHandler({ identityRepo: passingRepo(), readConfig: enabledCfg() });
    const { res, captured } = makeRes();
    await h(makeReq("POST", "/v3/research/bogus", {}), res, ctx);
    assert.equal(captured.statusCode, 404);
  });
});

// ── routes ───────────────────────────────────────────────────────────

describe("researchProxy: routes", () => {
  function handler(routes: Parameters<typeof mockFetch>[0]) {
    return makeResearchProxyHandler({
      identityRepo: passingRepo(),
      readConfig: enabledCfg(),
      fetchImpl: mockFetch(routes),
    });
  }
  const crossrefWork = {
    match: "api.crossref.org/works/10.1234",
    json: {
      message: { DOI: "10.1234/x", title: ["T"], author: [{ family: "Bee" }], issued: { "date-parts": [[2020]] } },
    },
  };

  it("lit/search → 200 {sources,warnings}", async () => {
    const h = handler([
      { match: "api.openalex.org", json: { results: [{ title: "P", doi: "10.1234/p" }] } },
      { match: "api.crossref.org", json: { message: { items: [] } } },
      { match: "export.arxiv.org", text: "<feed></feed>" },
    ]);
    const { res, captured } = makeRes();
    await h(makeReq("POST", "/v3/research/lit/search", { query: "deep learning" }), res, ctx);
    assert.equal(captured.statusCode, 200);
    assert.equal(captured.body.sources.length, 1);
    assert.equal(captured.body.sources[0].doi, "10.1234/p");
  });

  it("lit/search 缺 query → 400", async () => {
    const { res, captured } = makeRes();
    await handler([])(makeReq("POST", "/v3/research/lit/search", {}), res, ctx);
    assert.equal(captured.statusCode, 400);
  });

  it("cite/verify → 200 {verdicts}", async () => {
    const { res, captured } = makeRes();
    await handler([crossrefWork])(
      makeReq("POST", "/v3/research/cite/verify", { identifiers: ["10.1234/x"] }),
      res,
      ctx,
    );
    assert.equal(captured.statusCode, 200);
    assert.equal(captured.body.verdicts[0].resolved, true);
  });

  it("cite/verify 缺 identifiers → 400", async () => {
    const { res, captured } = makeRes();
    await handler([])(makeReq("POST", "/v3/research/cite/verify", {}), res, ctx);
    assert.equal(captured.statusCode, 400);
  });

  it("cite/format → 200 {verdict.formatted}", async () => {
    const { res, captured } = makeRes();
    await handler([crossrefWork])(
      makeReq("POST", "/v3/research/cite/format", { identifier: "10.1234/x", style: "gb-t-7714-2015" }),
      res,
      ctx,
    );
    assert.equal(captured.statusCode, 200);
    assert.ok(captured.body.verdict.formatted.includes("[J]"));
  });
});
