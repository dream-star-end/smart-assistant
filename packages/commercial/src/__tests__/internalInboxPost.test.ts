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

  test("stable cron delivery key is validated and forwarded to durable storage", async () => {
    const p = capturePost();
    const h = makeInboxPostHandler({ identityRepo: repoFor(99), postMessage: p.postMessage });
    let res = makeRes();
    await h(makeReq({
      auth: `Bearer ${TOKEN}`,
      body: { title: "任务完成", bodyMd: "结果如下", deliveryKey: `cron.${"a".repeat(64)}` },
    }), res, CTX);
    assert.equal(res.statusCode, 200);
    assert.equal(p.posts[0]!.msg.deliveryKey, `cron.${"a".repeat(64)}`);

    res = makeRes();
    await h(makeReq({
      auth: `Bearer ${TOKEN}`,
      body: { title: "任务完成", bodyMd: "结果如下", deliveryKey: "bad key" },
    }), res, CTX);
    assert.equal(res.statusCode, 400);
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
    // 每次发不同内容 —— 这里测的是"条数"维度限流,不能被内容去重先行短路。
    let seq = 0;
    const send = async () => {
      const res = makeRes();
      await h(makeReq({ auth: `Bearer ${TOKEN}`, body: { title: "t", bodyMd: `b-${seq++}` } }), res, CTX);
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

  test("content dedupe: same uid+content within window → duplicate, no write; expiry/different content pass", async () => {
    const p = capturePost();
    let clock = 1_000_000;
    const h = makeInboxPostHandler({
      identityRepo: repoFor(5),
      postMessage: p.postMessage,
      now: () => clock,
      maxPerMin: 100, // 限频放宽,单测只看内容去重维度
      dedupeWindowMs: 6 * 3600_000,
    });
    const send = async (title: string, bodyMd: string) => {
      const res = makeRes();
      await h(makeReq({ auth: `Bearer ${TOKEN}`, body: { title, bodyMd } }), res, CTX);
      return res;
    };

    // 事故形态:同一段 "API Error: 402…" 每 5 分钟一条,且每条携带**不同的 request_id**
    // (线上 msg 622/623 实证)→ 归一化后仍判同内容:首条落库,后续全部 duplicate。
    const errBody = (rid: string) =>
      `API Error: 402 {"error":{"code":"INSUFFICIENT_CREDITS","message":"insufficient credits: balance=0 required=69"},"request_id":"${rid}"}`;
    let r = await send("Run the watchdog", errBody("60ea16950bd43c0e7d920bedb367a6e3"));
    assert.equal(r.body.ok, true);
    for (let i = 0; i < 5; i++) {
      clock += 5 * 60_000;
      r = await send("Run the watchdog", errBody(`5e755205c3cafc6b4f84a6b48aa33fb${i}`));
      assert.equal(r.body.ok, false, `第 ${i + 2} 条应被去重(request_id 不同不该穿透)`);
      assert.equal(r.body.reason, "duplicate");
    }
    assert.equal(p.posts.length, 1);

    // 不同内容不受影响。
    r = await send("Run the watchdog", "正常任务产出");
    assert.equal(r.body.ok, true);
    assert.equal(p.posts.length, 2);

    // 窗口过期后同内容放行(第二天的失败该再提醒一次)。
    clock += 6 * 3600_000 + 1;
    r = await send("Run the watchdog", errBody("aaaabbbbccccdddd0000111122223333"));
    assert.equal(r.body.ok, true);
    assert.equal(p.posts.length, 3);
  });

  test("content dedupe scoped per uid: same content from different users both write", async () => {
    const p = capturePost();
    // repo 按 boundIp 区分 uid —— 同一 handler 实例(共享去重表)服务两个用户。
    const repo: ContainerIdentityRepo = {
      async findActiveByHostAndBoundIp(hostUuid, boundIp) {
        // token 里的 identity id 固定为 7(TOKEN=oc-v3.7.…),user_id 按 boundIp 区分。
        const uid = boundIp === "172.31.0.7" ? 7 : 8;
        return { id: 7, user_id: uid, bound_ip: boundIp, host_uuid: hostUuid, secret_hash: hashSecret(SECRET) };
      },
    };
    const h = makeInboxPostHandler({ identityRepo: repo, postMessage: p.postMessage });
    const body = { title: "同文", bodyMd: "同一段内容" };

    let res = makeRes();
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body }), res, { hostUuid: "host-1", boundIp: "172.31.0.7" });
    assert.equal(res.body.ok, true);

    res = makeRes();
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body }), res, { hostUuid: "host-1", boundIp: "172.31.0.8" });
    assert.equal(res.body.ok, true, "不同 uid 的同内容不该互相去重");
    assert.equal(p.posts.length, 2);

    // 同 uid 重发才被去重。
    res = makeRes();
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body }), res, { hostUuid: "host-1", boundIp: "172.31.0.7" });
    assert.equal(res.body.ok, false);
    assert.equal(res.body.reason, "duplicate");
  });

  test("content dedupe: failed write does not claim the key — retry passes", async () => {
    let failOnce = true;
    const posts: number[] = [];
    const h = makeInboxPostHandler({
      identityRepo: repoFor(5),
      postMessage: async (uid) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("transient pg error");
        }
        posts.push(uid);
      },
    });
    const body = { title: "t", bodyMd: "b" };

    let res = makeRes();
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body }), res, CTX);
    assert.equal(res.statusCode, 500);

    res = makeRes();
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body }), res, CTX);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true, "落库失败不该占用去重键,合法重试要能过");
    assert.equal(posts.length, 1);
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
