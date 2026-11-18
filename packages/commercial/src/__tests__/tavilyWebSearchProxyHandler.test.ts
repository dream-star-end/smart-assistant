import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it, beforeEach } from "node:test";

import { hashSecret, type ContainerIdentityRepo } from "../auth/containerIdentity.js";
import {
  makeTavilyWebSearchHandler,
  __resetTavilyWebSearchRateState,
} from "../tavily/webSearchProxy.js";

const HOST = "host-1";
const IP = "10.0.0.9";
const CID = 42;
const SECRET = "a".repeat(64);
const TOKEN = `oc-v3.${CID}.${SECRET}`;
const TAVILY_KEY = "tvly-master-only-secret";

function okRepo(): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp(hostUuid, boundIp) {
      if (hostUuid !== HOST || boundIp !== IP) return null;
      return { id: CID, user_id: 7, bound_ip: IP, host_uuid: HOST, secret_hash: hashSecret(SECRET) };
    },
  };
}
const nullRepo: ContainerIdentityRepo = { async findActiveByHostAndBoundIp() { return null; } };

function makeReq(method: string, body: unknown, auth = TOKEN) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw)]) as unknown as import("node:http").IncomingMessage;
  req.method = method;
  req.url = "/internal/v3/tavily-search";
  req.headers = { authorization: auth };
  return req;
}

function makeRes() {
  const chunks: Buffer[] = [];
  const headers: Record<string, unknown> = {};
  const res = {
    statusCode: 0,
    setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = v; },
    getHeader(k: string) { return headers[k.toLowerCase()]; },
    end(c?: unknown) { if (c) chunks.push(Buffer.from(c as string)); },
    write(c: unknown) { chunks.push(Buffer.from(c as string)); return true; },
  } as unknown as import("node:http").ServerResponse & { statusCode: number };
  return { res, body: () => Buffer.concat(chunks).toString("utf8") };
}

const CTX = { hostUuid: HOST, boundIp: IP };

describe("tavily webSearch handler", () => {
  beforeEach(() => __resetTavilyWebSearchRateState());

  it("405 for non-POST", async () => {
    const h = makeTavilyWebSearchHandler({ identityRepo: okRepo(), apiKey: TAVILY_KEY });
    const { res } = makeRes();
    await h(makeReq("GET", {}), res, CTX);
    assert.equal(res.statusCode, 405);
  });

  it("503 when apiKey not configured (before identity)", async () => {
    const h = makeTavilyWebSearchHandler({ identityRepo: nullRepo });
    const { res, body } = makeRes();
    await h(makeReq("POST", { q: "x" }), res, CTX);
    assert.equal(res.statusCode, 503);
    assert.match(body(), /TAVILY_NOT_CONFIGURED/);
  });

  it("401 when container identity fails", async () => {
    const h = makeTavilyWebSearchHandler({ identityRepo: nullRepo, apiKey: TAVILY_KEY });
    const { res } = makeRes();
    await h(makeReq("POST", { q: "x" }), res, CTX);
    assert.equal(res.statusCode, 401);
  });

  it("400 on bad body (missing q)", async () => {
    const h = makeTavilyWebSearchHandler({ identityRepo: okRepo(), apiKey: TAVILY_KEY });
    const { res } = makeRes();
    await h(makeReq("POST", { nope: 1 }), res, CTX);
    assert.equal(res.statusCode, 400);
  });

  it("200: injects Bearer apiKey upstream, maps results to organic + dedupes per host, never leaks apiKey", async () => {
    let sentAuth: string | undefined;
    let sentUrl: string | undefined;
    let sentBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (url: unknown, init: unknown) => {
      const reqInit = init as { headers: Record<string, string>; body: string };
      sentUrl = String(url);
      sentAuth = reqInit.headers.authorization;
      sentBody = JSON.parse(reqInit.body);
      return new Response(
        JSON.stringify({
          results: [
            { title: "One", url: "https://docs.example.com/1", content: "snippet 1", published_date: "2026-11-18" },
            { title: "Two", url: "https://docs.example.com/2", content: "snippet 2" },
            { title: "Three", url: "https://docs.example.com/3", content: "snippet 3" },
            { title: "Four-Dropped", url: "https://docs.example.com/4", content: "snippet 4" },
            { title: "BadScheme", url: "javascript:alert(1)", content: "bad" },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const h = makeTavilyWebSearchHandler({ identityRepo: okRepo(), apiKey: TAVILY_KEY, fetchImpl });
    const { res, body } = makeRes();
    await h(makeReq("POST", { q: "OpenAI docs" }), res, CTX);
    assert.equal(res.statusCode, 200);
    assert.equal(sentUrl, "https://api.tavily.com/search");
    assert.equal(sentAuth, `Bearer ${TAVILY_KEY}`);
    assert.deepEqual(sentBody, { query: "OpenAI docs", max_results: 10, search_depth: "basic" });
    const out = JSON.parse(body());
    assert.deepEqual(out.organic, [
      { title: "One", url: "https://docs.example.com/1", snippet: "snippet 1", date: "2026-11-18" },
      { title: "Two", url: "https://docs.example.com/2", snippet: "snippet 2" },
      { title: "Three", url: "https://docs.example.com/3", snippet: "snippet 3" },
    ]);
    assert.ok(!body().includes(TAVILY_KEY), "response must not leak the Tavily API key");
  });

  it("502 on upstream HTTP error or invalid JSON", async () => {
    const fetchErr = (async () =>
      new Response(JSON.stringify({ detail: { error: `bad ${TAVILY_KEY}` } }), { status: 401 })) as unknown as typeof fetch;
    const h1 = makeTavilyWebSearchHandler({ identityRepo: okRepo(), apiKey: TAVILY_KEY, fetchImpl: fetchErr });
    const r1 = makeRes();
    await h1(makeReq("POST", { q: "x" }), r1.res, CTX);
    assert.equal(r1.res.statusCode, 502);
    assert.ok(!r1.body().includes(TAVILY_KEY));

    const fetchBadJson = (async () => new Response("not-json", { status: 200 })) as unknown as typeof fetch;
    const h2 = makeTavilyWebSearchHandler({ identityRepo: okRepo(), apiKey: TAVILY_KEY, fetchImpl: fetchBadJson });
    const r2 = makeRes();
    await h2(makeReq("POST", { q: "x" }), r2.res, CTX);
    assert.equal(r2.res.statusCode, 502);
  });

  it("504 on upstream timeout", async () => {
    const fetchImpl = (async () => {
      const e = new Error("timed out");
      e.name = "TimeoutError";
      throw e;
    }) as unknown as typeof fetch;
    const h = makeTavilyWebSearchHandler({ identityRepo: okRepo(), apiKey: TAVILY_KEY, fetchImpl });
    const { res } = makeRes();
    await h(makeReq("POST", { q: "x" }), res, CTX);
    assert.equal(res.statusCode, 504);
  });

  it("429 after per-container rate limit exceeded", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ results: [] }), { status: 200 })) as unknown as typeof fetch;
    const h = makeTavilyWebSearchHandler({ identityRepo: okRepo(), apiKey: TAVILY_KEY, fetchImpl });
    let last = 0;
    for (let i = 0; i < 45; i++) {
      const { res } = makeRes();
      await h(makeReq("POST", { q: "x" }), res, CTX);
      last = res.statusCode;
    }
    assert.equal(last, 429);
  });
});
