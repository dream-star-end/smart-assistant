/**
 * Unit tests for POST /internal/v3/inbox-post(离线送达兜底写站内信)。
 * Run: npx tsx --test packages/commercial/src/__tests__/internalInboxPost.test.ts
 */

import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, test } from "node:test";

import { hashSecret, type ContainerIdentityRepo } from "../auth/containerIdentity.js";
import {
  INBOX_POST_PATH,
  makeInboxPostHandler,
  type InboxPostMessage,
} from "../http/internalInboxPost.js";

const SECRET = "a".repeat(64);
const TOKEN = `oc-v3.7.${SECRET}`;
const CTX = { hostUuid: "host-1", boundIp: "172.31.0.7" };

function repoFor(userId = 42): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp(hostUuid, boundIp) {
      if (hostUuid !== CTX.hostUuid || boundIp !== CTX.boundIp) return null;
      return { id: 7, user_id: userId, bound_ip: boundIp, host_uuid: hostUuid, secret_hash: hashSecret(SECRET) };
    },
  };
}

function makeReq(opts: { method?: string; auth?: string; body?: unknown }): IncomingMessage {
  const raw = opts.body === undefined ? "" : JSON.stringify(opts.body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as IncomingMessage;
  req.method = opts.method ?? "POST";
  req.url = INBOX_POST_PATH;
  req.headers = {};
  if (opts.auth) req.headers.authorization = opts.auth;
  return req;
}

function makeRes(): ServerResponse & { body: any } {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string | number>,
    setHeader(k: string, v: string | number) {
      this.headers[k.toLowerCase()] = v;
    },
    end(s?: string) {
      (this as any).body = s ? JSON.parse(s) : {};
    },
  };
  return res as unknown as ServerResponse & { body: any };
}

function capturePost() {
  const posts: Array<{ uid: number; msg: InboxPostMessage }> = [];
  return {
    posts,
    postMessage: async (uid: number, msg: InboxPostMessage) => {
      posts.push({ uid, msg });
    },
  };
}

describe("inbox-post handler", () => {
  test("rejects non-POST and missing bearer", async () => {
    const p = capturePost();
    const h = makeInboxPostHandler({ identityRepo: repoFor(), postMessage: p.postMessage });

    let res = makeRes();
    await h(makeReq({ auth: `Bearer ${TOKEN}`, method: "GET", body: {} }), res, CTX);
    assert.equal(res.statusCode, 405);

    res = makeRes();
    await h(makeReq({ body: { title: "t", bodyMd: "b" } }), res, CTX);
    assert.equal(res.statusCode, 401);
    assert.equal(p.posts.length, 0);
  });

  test("valid body writes inbox (audience-scoped uid from identity, level info)", async () => {
    const p = capturePost();
    const h = makeInboxPostHandler({ identityRepo: repoFor(99), postMessage: p.postMessage });
    const res = makeRes();
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body: { title: "任务完成", bodyMd: "结果如下" } }), res, CTX);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(p.posts.length, 1);
    assert.equal(p.posts[0].uid, 99); // from identity, never body
    assert.equal(p.posts[0].msg.title, "任务完成");
    assert.equal(p.posts[0].msg.level, "info");
  });

  test("title/body truncated to caps", async () => {
    const p = capturePost();
    const h = makeInboxPostHandler({ identityRepo: repoFor(), postMessage: p.postMessage });
    const res = makeRes();
    await h(
      makeReq({ auth: `Bearer ${TOKEN}`, body: { title: "T".repeat(500), bodyMd: "B".repeat(9000) } }),
      res,
      CTX,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(p.posts[0].msg.title.length, 200);
    assert.ok(p.posts[0].msg.title.endsWith("…"));
    assert.equal(p.posts[0].msg.bodyMd.length, 4096);
    assert.ok(p.posts[0].msg.bodyMd.endsWith("…"));
  });

  test("invalid body (missing title / bad level / extra field) → 400", async () => {
    const p = capturePost();
    const h = makeInboxPostHandler({ identityRepo: repoFor(), postMessage: p.postMessage });
    for (const bad of [
      { bodyMd: "b" }, // missing title
      { title: "t" }, // missing bodyMd
      { title: "", bodyMd: "b" }, // empty title
      { title: "t", bodyMd: "b", level: "warning" }, // non-info level
      { title: "t", bodyMd: "b", extra: 1 }, // strict extra
    ]) {
      const res = makeRes();
      await h(makeReq({ auth: `Bearer ${TOKEN}`, body: bad }), res, CTX);
      assert.equal(res.statusCode, 400, JSON.stringify(bad));
    }
    assert.equal(p.posts.length, 0);
  });

  test("per-uid rate limit: over cap → 200 ok:false rate_limited, no write", async () => {
    const p = capturePost();
    let clock = 1_000_000;
    const h = makeInboxPostHandler({
      identityRepo: repoFor(5),
      postMessage: p.postMessage,
      now: () => clock,
      maxPerMin: 2,
    });
    const send = async () => {
      const res = makeRes();
      await h(makeReq({ auth: `Bearer ${TOKEN}`, body: { title: "t", bodyMd: "b" } }), res, CTX);
      return res;
    };

    let r = await send();
    assert.equal(r.body.ok, true);
    r = await send();
    assert.equal(r.body.ok, true);
    r = await send(); // 3rd within same minute → limited
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.reason, "rate_limited");
    assert.equal(p.posts.length, 2);

    // 滑窗过期后放行。
    clock += 61_000;
    r = await send();
    assert.equal(r.body.ok, true);
    assert.equal(p.posts.length, 3);
  });

  test("postMessage throws → 500", async () => {
    const h = makeInboxPostHandler({
      identityRepo: repoFor(),
      postMessage: async () => {
        throw new Error("no admin sender");
      },
    });
    const res = makeRes();
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body: { title: "t", bodyMd: "b" } }), res, CTX);
    assert.equal(res.statusCode, 500);
  });
});
