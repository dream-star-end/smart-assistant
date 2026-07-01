import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it, beforeEach } from "node:test";

import { hashSecret, type ContainerIdentityRepo } from "../auth/containerIdentity.js";
import {
  makeMiniMaxWebSearchHandler,
  __resetWebSearchRateState,
} from "../minimax/webSearchProxy.js";

const HOST = "host-1";
const IP = "10.0.0.9";
const CID = 42;
const SECRET = "a".repeat(64);
const TOKEN = `oc-v3.${CID}.${SECRET}`;
const TOKEN_PLAN_KEY = "sk-cp-master-only";

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
  req.url = "/internal/v3/minimax-search";
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

describe("minimax webSearch handler", () => {
  beforeEach(() => __resetWebSearchRateState());

  it("405 for non-POST", async () => {
    const h = makeMiniMaxWebSearchHandler({ identityRepo: okRepo(), tokenPlanKey: TOKEN_PLAN_KEY });
    const { res } = makeRes();
    await h(makeReq("GET", {}), res, CTX);
    assert.equal(res.statusCode, 405);
  });

  it("503 when token plan key not configured (before identity)", async () => {
    const h = makeMiniMaxWebSearchHandler({ identityRepo: nullRepo });
    const { res, body } = makeRes();
    await h(makeReq("POST", { q: "x" }), res, CTX);
    assert.equal(res.statusCode, 503);
    assert.match(body(), /MINIMAX_NOT_CONFIGURED/);
  });

  it("401 when container identity fails", async () => {
    const h = makeMiniMaxWebSearchHandler({ identityRepo: nullRepo, tokenPlanKey: TOKEN_PLAN_KEY });
    const { res } = makeRes();
    await h(makeReq("POST", { q: "x" }), res, CTX);
    assert.equal(res.statusCode, 401);
  });

  it("400 on bad body (missing q)", async () => {
    const h = makeMiniMaxWebSearchHandler({ identityRepo: okRepo(), tokenPlanKey: TOKEN_PLAN_KEY });
    const { res } = makeRes();
    await h(makeReq("POST", { nope: 1 }), res, CTX);
    assert.equal(res.statusCode, 400);
  });

  it("200: injects Bearer token-plan-key upstream, returns organic, never leaks the key", async () => {
    let sentAuth: string | undefined;
    let sentUrl: string | undefined;
    const fetchImpl = (async (url: unknown, init: unknown) => {
      sentUrl = String(url);
      sentAuth = (init as { headers: Record<string, string> }).headers.authorization;
      return new Response(
        JSON.stringify({ organic: [{ title: "抖音", link: "https://csdn.net/x", snippet: "s" }], base_resp: { status_code: 0 } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const h = makeMiniMaxWebSearchHandler({ identityRepo: okRepo(), tokenPlanKey: TOKEN_PLAN_KEY, fetchImpl });
    const { res, body } = makeRes();
    await h(makeReq("POST", { q: "抖音运营" }), res, CTX);
    assert.equal(res.statusCode, 200);
    assert.equal(sentUrl, "https://api.minimaxi.com/v1/coding_plan/search");
    assert.equal(sentAuth, `Bearer ${TOKEN_PLAN_KEY}`);
    const out = JSON.parse(body());
    assert.deepEqual(out.organic, [{ title: "抖音", url: "https://csdn.net/x", snippet: "s" }]);
    assert.ok(!body().includes(TOKEN_PLAN_KEY), "response must not leak the token plan key");
  });

  it("502 on upstream base_resp error", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ base_resp: { status_code: 2013, status_msg: "invalid params" } }), { status: 200 })) as unknown as typeof fetch;
    const h = makeMiniMaxWebSearchHandler({ identityRepo: okRepo(), tokenPlanKey: TOKEN_PLAN_KEY, fetchImpl });
    const { res } = makeRes();
    await h(makeReq("POST", { q: "x" }), res, CTX);
    assert.equal(res.statusCode, 502);
  });

  it("504 on upstream timeout", async () => {
    const fetchImpl = (async () => {
      const e = new Error("timed out");
      e.name = "TimeoutError";
      throw e;
    }) as unknown as typeof fetch;
    const h = makeMiniMaxWebSearchHandler({ identityRepo: okRepo(), tokenPlanKey: TOKEN_PLAN_KEY, fetchImpl });
    const { res } = makeRes();
    await h(makeReq("POST", { q: "x" }), res, CTX);
    assert.equal(res.statusCode, 504);
  });

  it("429 after per-container rate limit exceeded", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ organic: [], base_resp: { status_code: 0 } }), { status: 200 })) as unknown as typeof fetch;
    const h = makeMiniMaxWebSearchHandler({ identityRepo: okRepo(), tokenPlanKey: TOKEN_PLAN_KEY, fetchImpl });
    let last = 0;
    for (let i = 0; i < 45; i++) {
      const { res } = makeRes();
      await h(makeReq("POST", { q: "x" }), res, CTX);
      last = res.statusCode;
    }
    assert.equal(last, 429);
  });
});
