import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { beforeEach, describe, it } from "node:test";

import { hashSecret, type ContainerIdentityRepo } from "../auth/containerIdentity.js";
import {
  GROK_SEARCH_UPSTREAM,
  __resetGrokWebSearchRateState,
  makeGrokWebSearchHandler,
  organicFromGrokResponse,
} from "../grok/webSearchProxy.js";

const HOST = "host-1";
const IP = "10.0.0.9";
const CID = 42;
const SECRET = "b".repeat(64);
const TOKEN = `oc-v3.${CID}.${SECRET}`;

function okRepo(): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp(hostUuid, boundIp) {
      if (hostUuid !== HOST || boundIp !== IP) return null;
      return { id: CID, user_id: 7, bound_ip: IP, host_uuid: HOST, secret_hash: hashSecret(SECRET) };
    },
  };
}

function makeReq(method: string, body: unknown, auth = TOKEN) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw)]) as unknown as import("node:http").IncomingMessage;
  req.method = method;
  req.url = "/internal/v3/grok-search";
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
const TOKEN_BYTES = Buffer.from("grok-access-secret");

function upstreamOk(payload: unknown) {
  return async () => ({
    statusCode: 200,
    body: { text: async () => JSON.stringify(payload) },
  });
}

describe("organicFromGrokResponse", () => {
  it("prefers titled JSON over bare source urls", () => {
    const hits = organicFromGrokResponse({
      output: [
        { type: "web_search_call", action: { sources: [{ url: "https://example.com/bare" }] } },
        {
          type: "message",
          content: [{
            type: "output_text",
            text: '{"results":[{"title":"央行","url":"https://jingji.cctv.com/a","snippet":"1年期 3.0%"}]}',
          }],
        },
      ],
    });
    assert.deepEqual(hits, [{ title: "央行", url: "https://jingji.cctv.com/a", snippet: "1年期 3.0%" }]);
  });

  it("uses source urls when the model wrote no JSON", () => {
    const hits = organicFromGrokResponse({
      output: [
        { type: "web_search_call", action: { sources: [{ type: "url", url: "https://www.pbc.gov.cn/a" }] } },
      ],
    });
    assert.deepEqual(hits, [{ title: "", url: "https://www.pbc.gov.cn/a", snippet: "" }]);
  });
});

describe("grok webSearch handler", () => {
  beforeEach(() => __resetGrokWebSearchRateState());

  it("405 for non-POST", async () => {
    const h = makeGrokWebSearchHandler({ identityRepo: okRepo(), pickAccountId: async () => 1n });
    const { res } = makeRes();
    await h(makeReq("GET", {}), res, CTX);
    assert.equal(res.statusCode, 405);
  });

  it("401 when container identity fails", async () => {
    const h = makeGrokWebSearchHandler({
      identityRepo: { async findActiveByHostAndBoundIp() { return null; } },
      pickAccountId: async () => 1n,
    });
    const { res } = makeRes();
    await h(makeReq("POST", { q: "x" }), res, CTX);
    assert.equal(res.statusCode, 401);
  });

  it("503 when no active grok account", async () => {
    const h = makeGrokWebSearchHandler({ identityRepo: okRepo(), pickAccountId: async () => null });
    const { res, body } = makeRes();
    await h(makeReq("POST", { q: "x" }), res, CTX);
    assert.equal(res.statusCode, 503);
    assert.match(body(), /GROK_SEARCH_NOT_CONFIGURED/);
  });

  it("200: calls the CLI proxy with the grok token, never echoes it", async () => {
    const token = Buffer.from(TOKEN_BYTES);
    let sentUrl = "";
    let sentAuth = "";
    let sentBody = "";
    const h = makeGrokWebSearchHandler({
      identityRepo: okRepo(),
      pickAccountId: async () => 9n,
      freshToken: async () => token,
      requestFn: async (url, init) => {
        sentUrl = url;
        sentAuth = init.headers.authorization;
        sentBody = init.body;
        return upstreamOk({
          output: [{
            type: "message",
            content: [{ text: '{"results":[{"title":"LPR","url":"https://jingji.cctv.com/a","snippet":"3.0%"}]}' }],
          }],
        })();
      },
    });
    const { res, body } = makeRes();
    await h(makeReq("POST", { q: "2026年9月 LPR" }), res, CTX);
    assert.equal(res.statusCode, 200);
    assert.equal(sentUrl, GROK_SEARCH_UPSTREAM);
    assert.equal(sentAuth, "Bearer grok-access-secret");
    assert.match(sentBody, /web_search/);
    assert.match(sentBody, /"effort":"low"/);
    assert.ok(!body().includes("grok-access-secret"));
    assert.equal(token.every((b) => b === 0), true);
    const out = JSON.parse(body());
    assert.equal(out.organic[0].url, "https://jingji.cctv.com/a");
  });

  it("502 when upstream status is not ok, so CCB can fall through", async () => {
    const h = makeGrokWebSearchHandler({
      identityRepo: okRepo(),
      pickAccountId: async () => 9n,
      freshToken: async () => Buffer.from("t"),
      recordStatus: async () => {},
      requestFn: async () => ({ statusCode: 429, body: { text: async () => "nope" } }),
    });
    const { res } = makeRes();
    await h(makeReq("POST", { q: "x" }), res, CTX);
    assert.equal(res.statusCode, 502);
  });

  it("429 after the per-container cap", async () => {
    const h = makeGrokWebSearchHandler({
      identityRepo: okRepo(),
      pickAccountId: async () => 9n,
      freshToken: async () => Buffer.from("t"),
      recordStatus: async () => {},
      requestFn: async () => upstreamOk({ output: [{ type: "web_search_call", action: { sources: [] } }] })(),
    });
    let last = 0;
    for (let i = 0; i < 10; i++) {
      const { res } = makeRes();
      await h(makeReq("POST", { q: "x" }), res, CTX);
      last = res.statusCode;
    }
    assert.equal(last, 429);
  });
});
