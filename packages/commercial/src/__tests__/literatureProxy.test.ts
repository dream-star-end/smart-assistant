/**
 * literatureProxy — 单元测试。
 *
 * 跑法:npx tsx --test src/__tests__/literatureProxy.test.ts
 *
 * 不碰 DB / Redis,全用 in-memory mocks:
 *   - identityRepo:同 containerIdentity.test.ts 的 memRepo
 *   - redis:简易 eval 实现,模拟 GET-then-INCR
 *   - readConfig:同步返回 fixture
 *   - fetchImpl:可注入 200/4xx/5xx/timeout
 *
 * 覆盖:
 *   - 身份失败 → 401
 *   - 配置 disabled → 503
 *   - token 缺 → 503(enabled_without_token)
 *   - body 非 JSON / 缺 query / size 越界 → 400
 *   - per-container limiter 触发 → 429 + Retry-After
 *   - daily cap 触发 → 429 DAILY_CAP_EXCEEDED
 *   - upstream 5xx → 502
 *   - upstream timeout → 504
 *   - 成功 → 200 + 透传 JSON,counter +1
 *   - LRU evict 行为
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  makeLiteratureProxyHandler,
  makePerContainerLimiter,
  utcDayKey,
  getMetricsSnapshot,
  _resetMetricsForTest,
} from "../literatureProxy.js";
import type { ContainerIdentityRepo } from "../auth/containerIdentity.js";
import type { LiteratureDeepxivConfigRow } from "../admin/literatureConfig.js";

// ─── Fixtures ──────────────────────────────────────────────────────

const HOST = "00000000-0000-0000-0000-000000000001";
const IP = "172.30.1.42";

function makeIdentity(containerId: number, userId: number) {
  const secretHex = randomBytes(32).toString("hex");
  const secretHash = createHash("sha256").update(Buffer.from(secretHex, "hex")).digest();
  return { containerId, userId, secretHex, secretHash };
}

function memRepo(rows: Array<{ id: number; user_id: number; host_uuid: string; bound_ip: string; secret_hash: Buffer | null }>): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp(h, ip) {
      return rows.find((r) => r.host_uuid === h && r.bound_ip === ip) ?? null;
    },
  };
}

function makeConfig(overrides: Partial<LiteratureDeepxivConfigRow> = {}): LiteratureDeepxivConfigRow {
  return {
    id: 1,
    enabled: true,
    base_url: "https://data.rag.ac.cn",
    token: "test-token-abcd1234",
    daily_cap: 100,
    default_size: 10,
    timeout_sec: 5,
    updated_at: new Date(0),
    updated_by: null,
    ...overrides,
  };
}

// 简易 redis mock — 仅实现 eval,GET-then-INCR 语义
function makeRedis(initialCount = 0) {
  let counter = initialCount;
  let throwOnNext = false;
  return {
    triggerError() {
      throwOnNext = true;
    },
    getCounter() {
      return counter;
    },
    async eval(_script: string, _numKeys: number, _key: string, capStr: string, _ttlStr: string) {
      if (throwOnNext) {
        throwOnNext = false;
        throw new Error("ECONNREFUSED");
      }
      const cap = Number.parseInt(capStr, 10);
      if (counter >= cap) return -1;
      counter += 1;
      return counter;
    },
  };
}

// 构造 mock req/res,体可注入 JSON,method 默认 POST,headers 由 caller 设。
function makeReq(opts: { body?: string; method?: string; authorization?: string }): IncomingMessage {
  const em = new EventEmitter() as IncomingMessage & EventEmitter;
  em.method = opts.method ?? "POST";
  em.headers = {};
  if (opts.authorization !== undefined) em.headers.authorization = opts.authorization;
  em.url = "/v3/literature/search";
  // AsyncIterable<Buffer> 支持:返回单个 chunk 然后 end
  const body = opts.body ?? "";
  (em as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<Buffer> })[Symbol.asyncIterator] =
    async function* () {
      if (body.length > 0) yield Buffer.from(body, "utf8");
    };
  return em;
}

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader(k: string, v: string): void;
  end(b?: string): void;
}

function makeRes(): MockRes & ServerResponse {
  const r: MockRes = {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(k, v) {
      r.headers[k.toLowerCase()] = String(v);
    },
    end(b) {
      r.body = b ?? "";
    },
  };
  return r as unknown as MockRes & ServerResponse;
}

/**
 * 模拟 fetch 返回的 `Response`-like 对象。
 *
 * 新版 literatureProxy 不走 `await res.json()`,改用 `res.body.getReader()` 流式读取并
 * 强制上限。这里给出一个 web ReadableStream 实现,把 JSON 字符串切成可控 chunk,既
 * 能覆盖正常路径,又能通过 `chunkSize`/`payload` 触发 "超大 body" 路径。
 *
 * - `payload`:序列化后的字节数(默认 = `JSON.stringify(body).length`)。`> body 实际`
 *    时,在 body 之后再喂等量的 'X' 字节,模拟"上游响应巨大"。
 */
function mockUpstreamResponse(body: unknown, opts: {
  status?: number;
  ok?: boolean;
  padBytes?: number;
} = {}): Response {
  const status = opts.status ?? 200;
  const ok = opts.ok ?? (status >= 200 && status < 300);
  const json = JSON.stringify(body);
  const padBytes = opts.padBytes ?? 0;
  const totalBytes = Buffer.byteLength(json, "utf8") + padBytes;
  let pushed = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pushed >= totalBytes) {
        controller.close();
        return;
      }
      // 第一波把整个 JSON 推出去;之后每次推 64KB padding,模拟流式上游
      if (pushed === 0) {
        const buf = Buffer.from(json, "utf8");
        controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        pushed += buf.byteLength;
        return;
      }
      const remaining = totalBytes - pushed;
      const sliceLen = Math.min(remaining, 64 * 1024);
      controller.enqueue(new Uint8Array(Buffer.alloc(sliceLen, 0x58 /* 'X' */)));
      pushed += sliceLen;
    },
  });
  return {
    ok,
    status,
    body: stream,
  } as unknown as Response;
}

// 公用一个身份夹具,需要时 caller 覆盖
function fixtureSetup(opts: { configOverride?: Partial<LiteratureDeepxivConfigRow> } = {}) {
  const id = makeIdentity(42, 7);
  const repo = memRepo([
    { id: id.containerId, user_id: id.userId, host_uuid: HOST, bound_ip: IP, secret_hash: id.secretHash },
  ]);
  const cfg = makeConfig(opts.configOverride);
  const redis = makeRedis();
  const auth = `Bearer oc-v3.${id.containerId}.${id.secretHex}`;
  return { id, repo, cfg, redis, auth };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("utcDayKey", () => {
  test("UTC 日期成 deepxiv:daily:YYYYMMDD", () => {
    const k = utcDayKey(new Date("2026-05-19T12:34:56Z"));
    assert.equal(k, "deepxiv:daily:20260519");
  });
});

describe("PerContainerLimiter", () => {
  test("窗口内未达上限 → ok:true,计数递增", () => {
    let t = 1_000_000;
    const lim = makePerContainerLimiter({ now: () => t, maxInWindow: 3, windowMs: 1000 });
    assert.equal(lim.check(1).ok, true);
    assert.equal(lim.check(1).ok, true);
    assert.equal(lim.check(1).ok, true);
    const r = lim.check(1);
    assert.equal(r.ok, false);
    assert.ok(r.retryAfterSec >= 1);
  });

  test("窗口外的时间戳被 evict", () => {
    let t = 0;
    const lim = makePerContainerLimiter({ now: () => t, maxInWindow: 2, windowMs: 1000 });
    lim.check(1);
    lim.check(1);
    assert.equal(lim.check(1).ok, false);
    t = 2000; // 窗口外
    assert.equal(lim.check(1).ok, true);
  });

  test("不同 container 互不干扰", () => {
    const lim = makePerContainerLimiter({ maxInWindow: 1, windowMs: 100_000 });
    assert.equal(lim.check(1).ok, true);
    assert.equal(lim.check(2).ok, true);
    assert.equal(lim.check(1).ok, false);
    assert.equal(lim.check(2).ok, false);
  });

  test("LRU evict 老 container", () => {
    const lim = makePerContainerLimiter({ maxEntries: 2, maxInWindow: 10, windowMs: 100_000 });
    lim.check(1);
    lim.check(2);
    lim.check(3); // 应 evict container 1(最老)
    assert.equal(lim._size(), 2);
    // container 1 重新进来时是新 bucket,所以 1 次后还能加
    assert.equal(lim.check(1).used, 1);
  });
});

describe("makeLiteratureProxyHandler", () => {
  test("成功 200 — 透传 upstream JSON,counter +1", async () => {
    _resetMetricsForTest();
    const f = fixtureSetup();
    const upstreamBody = { results: [{ title: "Attention is all you need" }], total: 1 };
    const fetchImpl = (async () => mockUpstreamResponse(upstreamBody)) as unknown as typeof fetch;
    const handler = makeLiteratureProxyHandler({
      identityRepo: f.repo,
      redis: f.redis,
      readConfig: async () => f.cfg,
      fetchImpl,
    });
    const req = makeReq({ body: JSON.stringify({ query: "transformers" }), authorization: f.auth });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), upstreamBody);
    assert.equal(getMetricsSnapshot().allowed, 1);
    assert.equal(f.redis.getCounter(), 1);
  });

  test("身份失败 → 401", async () => {
    _resetMetricsForTest();
    const f = fixtureSetup();
    const handler = makeLiteratureProxyHandler({
      identityRepo: f.repo,
      redis: f.redis,
      readConfig: async () => f.cfg,
      fetchImpl: (async () => {
        throw new Error("should not fetch");
      }) as unknown as typeof fetch,
    });
    const req = makeReq({
      body: JSON.stringify({ query: "x" }),
      authorization: "Bearer oc-v3.42.deadbeef" + "0".repeat(56),
    });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 401);
    assert.equal(getMetricsSnapshot().auth_failed, 1);
  });

  test("disabled → 503", async () => {
    _resetMetricsForTest();
    const f = fixtureSetup({ configOverride: { enabled: false } });
    const handler = makeLiteratureProxyHandler({
      identityRepo: f.repo,
      redis: f.redis,
      readConfig: async () => f.cfg,
    });
    const req = makeReq({ body: JSON.stringify({ query: "x" }), authorization: f.auth });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 503);
    assert.equal(getMetricsSnapshot().disabled, 1);
  });

  test("enabled 但 token 空 → 503", async () => {
    _resetMetricsForTest();
    const f = fixtureSetup({ configOverride: { token: null } });
    const handler = makeLiteratureProxyHandler({
      identityRepo: f.repo,
      redis: f.redis,
      readConfig: async () => f.cfg,
    });
    const req = makeReq({ body: JSON.stringify({ query: "x" }), authorization: f.auth });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 503);
    assert.equal(getMetricsSnapshot().disabled, 1);
  });

  test("body 非 JSON → 400", async () => {
    _resetMetricsForTest();
    const f = fixtureSetup();
    const handler = makeLiteratureProxyHandler({
      identityRepo: f.repo,
      redis: f.redis,
      readConfig: async () => f.cfg,
    });
    const req = makeReq({ body: "not-json", authorization: f.auth });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 400);
    assert.equal(getMetricsSnapshot().bad_input, 1);
  });

  test("缺 query → 400", async () => {
    _resetMetricsForTest();
    const f = fixtureSetup();
    const handler = makeLiteratureProxyHandler({
      identityRepo: f.repo,
      redis: f.redis,
      readConfig: async () => f.cfg,
    });
    const req = makeReq({ body: JSON.stringify({ size: 5 }), authorization: f.auth });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 400);
  });

  test("size 越界 → 400", async () => {
    _resetMetricsForTest();
    const f = fixtureSetup();
    const handler = makeLiteratureProxyHandler({
      identityRepo: f.repo,
      redis: f.redis,
      readConfig: async () => f.cfg,
    });
    const req = makeReq({ body: JSON.stringify({ query: "x", size: 200 }), authorization: f.auth });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 400);
  });

  test("per-container 限流 → 429 + Retry-After", async () => {
    _resetMetricsForTest();
    const f = fixtureSetup();
    const fetchImpl = (async () => mockUpstreamResponse({ results: [] })) as unknown as typeof fetch;
    const limiter = makePerContainerLimiter({ maxInWindow: 1, windowMs: 60_000 });
    const handler = makeLiteratureProxyHandler({
      identityRepo: f.repo,
      redis: f.redis,
      readConfig: async () => f.cfg,
      fetchImpl,
      limiter,
    });
    // 第一次:放行
    const r1 = makeReq({ body: JSON.stringify({ query: "x" }), authorization: f.auth });
    const s1 = makeRes();
    await handler(r1, s1, { hostUuid: HOST, boundIp: IP });
    assert.equal(s1.statusCode, 200);
    // 第二次:限流
    const r2 = makeReq({ body: JSON.stringify({ query: "x" }), authorization: f.auth });
    const s2 = makeRes();
    await handler(r2, s2, { hostUuid: HOST, boundIp: IP });
    assert.equal(s2.statusCode, 429);
    assert.ok(s2.headers["retry-after"]);
    assert.equal(getMetricsSnapshot().rejected_per_container, 1);
  });

  test("daily cap 满 → 429 DAILY_CAP_EXCEEDED", async () => {
    _resetMetricsForTest();
    const f = fixtureSetup({ configOverride: { daily_cap: 1 } });
    // 预先把 redis counter 填满
    f.redis.eval("", 1, "k", "0", "1"); // 这调一次 counter=1,但 cap=0 会返 -1;实际改用直接构造
    // 重置:用一个干净 redis,cap=1,先打一次成功,第二次就该拒绝
    const redis = makeRedis(1); // 起始 counter=1
    const fetchImpl = (async () => mockUpstreamResponse({ results: [] })) as unknown as typeof fetch;
    const handler = makeLiteratureProxyHandler({
      identityRepo: f.repo,
      redis,
      readConfig: async () => f.cfg,
      fetchImpl,
    });
    const req = makeReq({ body: JSON.stringify({ query: "x" }), authorization: f.auth });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 429);
    assert.match(res.body, /DAILY_CAP_EXCEEDED/);
    assert.equal(getMetricsSnapshot().rejected_daily_cap, 1);
  });

  test("upstream 5xx → 502", async () => {
    _resetMetricsForTest();
    const f = fixtureSetup();
    const fetchImpl = (async () => mockUpstreamResponse({}, { status: 502, ok: false })) as unknown as typeof fetch;
    const handler = makeLiteratureProxyHandler({
      identityRepo: f.repo,
      redis: f.redis,
      readConfig: async () => f.cfg,
      fetchImpl,
    });
    const req = makeReq({ body: JSON.stringify({ query: "x" }), authorization: f.auth });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 502);
    assert.equal(getMetricsSnapshot().upstream_5xx, 1);
  });

  test("upstream timeout → 504", async () => {
    _resetMetricsForTest();
    const f = fixtureSetup();
    const fetchImpl = (async (_url: string, init: { signal?: AbortSignal }) => {
      // 模拟一个永远等待但响应 abort 的 fetch
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted") as Error & { name: string };
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as unknown as typeof fetch;
    const handler = makeLiteratureProxyHandler({
      identityRepo: f.repo,
      redis: f.redis,
      readConfig: async () => ({ ...f.cfg, timeout_sec: 3 }),
      fetchImpl,
    });
    const req = makeReq({ body: JSON.stringify({ query: "x" }), authorization: f.auth });
    const res = makeRes();
    // 这里要让 AbortController 真的 fire — handler 内部 setTimeout 3s 实在太久,
    // 改用更短超时(已 mock cfg.timeout_sec=3 但 setTimeout 等不及测试)。直接降至 0.05s:
    const handlerFast = makeLiteratureProxyHandler({
      identityRepo: f.repo,
      redis: f.redis,
      readConfig: async () => ({ ...f.cfg, timeout_sec: 3 }),
      fetchImpl: (async (_url: string, init: { signal?: AbortSignal }) => {
        return new Promise<Response>((_resolve, reject) => {
          // 立即触发 abort
          setTimeout(() => {
            init.signal?.dispatchEvent?.(new Event("abort"));
            const e = new Error("aborted") as Error & { name: string };
            e.name = "AbortError";
            reject(e);
          }, 1);
        });
      }) as unknown as typeof fetch,
    });
    await handlerFast(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 504);
    assert.equal(getMetricsSnapshot().timeout, 1);
  });

  test("redis 挂 → 500", async () => {
    _resetMetricsForTest();
    const f = fixtureSetup();
    f.redis.triggerError();
    const handler = makeLiteratureProxyHandler({
      identityRepo: f.repo,
      redis: f.redis,
      readConfig: async () => f.cfg,
    });
    const req = makeReq({ body: JSON.stringify({ query: "x" }), authorization: f.auth });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 500);
    assert.equal(getMetricsSnapshot().redis_error, 1);
  });

  test("非 POST → 405", async () => {
    _resetMetricsForTest();
    const f = fixtureSetup();
    const handler = makeLiteratureProxyHandler({
      identityRepo: f.repo,
      redis: f.redis,
      readConfig: async () => f.cfg,
    });
    const req = makeReq({ method: "GET", authorization: f.auth });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 405);
  });

  test("upstream body 超过 MAX_UPSTREAM_BYTES → 502 + upstream_body_too_large 计数", async () => {
    // 拒上游回 1 GB JSON 把进程拖崩 — stream 读到 > 2 MiB 就 cancel + 抛
    _resetMetricsForTest();
    const f = fixtureSetup();
    // padBytes = 3 MiB,确保超过 2 MiB cap
    const fetchImpl = (async () =>
      mockUpstreamResponse({ results: [] }, { padBytes: 3 * 1024 * 1024 })) as unknown as typeof fetch;
    const handler = makeLiteratureProxyHandler({
      identityRepo: f.repo,
      redis: f.redis,
      readConfig: async () => f.cfg,
      fetchImpl,
    });
    const req = makeReq({ body: JSON.stringify({ query: "x" }), authorization: f.auth });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /UPSTREAM_ERROR/);
    const m = getMetricsSnapshot();
    assert.equal(m.upstream_body_too_large, 1);
    assert.equal(m.allowed, 0);
  });

  test("upstream body 慢/卡死 → timeout abort 触发 504(timeout 覆盖 body 阶段)", async () => {
    // 反向 slowloris:上游快速回 200 headers,但 body stream 一直 pending 不结束。
    // 必须由 timeout_sec abort 闸住,不能因为 headers 已到就放任 body 无限读。
    _resetMetricsForTest();
    const f = fixtureSetup();
    // 构造一个永远 pending 的 ReadableStream,响应 abort 信号
    const fetchImpl = (async (_url: string, init: { signal?: AbortSignal }) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // 先 push 一小段(模拟"头已到 + 少量 body 已到")
          controller.enqueue(new Uint8Array(Buffer.from('{"results":', "utf8")));
          // 然后挂起,等 abort 触发
          if (init.signal !== undefined) {
            const onAbort = () => {
              const e = new Error("aborted") as Error & { name: string };
              e.name = "AbortError";
              try { controller.error(e); } catch { /* already closed */ }
            };
            if (init.signal.aborted) onAbort();
            else init.signal.addEventListener("abort", onAbort);
          }
        },
      });
      return { ok: true, status: 200, body: stream } as unknown as Response;
    }) as unknown as typeof fetch;
    const handler = makeLiteratureProxyHandler({
      identityRepo: f.repo,
      redis: f.redis,
      // timeout_sec=0(0s setTimeout 立刻 abort)— 既稳又快
      readConfig: async () => ({ ...f.cfg, timeout_sec: 0 }),
      fetchImpl,
    });
    const req = makeReq({ body: JSON.stringify({ query: "x" }), authorization: f.auth });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 504);
    const m = getMetricsSnapshot();
    assert.equal(m.timeout, 1);
    assert.equal(m.allowed, 0);
  });

  test("非 2xx 上游返回时 body 被显式 cancel(防 undici 连接滞留)", async () => {
    _resetMetricsForTest();
    const f = fixtureSetup();
    let cancelCalled = false;
    const fetchImpl = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // 推一些数据但不 close,让 cancel 真正能 fire
          controller.enqueue(new Uint8Array(Buffer.from('upstream error body', "utf8")));
        },
        cancel() {
          cancelCalled = true;
        },
      });
      return { ok: false, status: 502, body: stream } as unknown as Response;
    }) as unknown as typeof fetch;
    const handler = makeLiteratureProxyHandler({
      identityRepo: f.repo,
      redis: f.redis,
      readConfig: async () => f.cfg,
      fetchImpl,
    });
    const req = makeReq({ body: JSON.stringify({ query: "x" }), authorization: f.auth });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 502);
    assert.equal(cancelCalled, true);
  });

  test("readConfig 抛错 → 500 + config_read_error 计数(不计入 redis_error)", async () => {
    _resetMetricsForTest();
    const f = fixtureSetup();
    const handler = makeLiteratureProxyHandler({
      identityRepo: f.repo,
      redis: f.redis,
      readConfig: async () => {
        // 模拟 DB 不可达 / AeadError(KMS key 错配)
        throw new Error("ECONNREFUSED");
      },
    });
    const req = makeReq({ body: JSON.stringify({ query: "x" }), authorization: f.auth });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 500);
    const m = getMetricsSnapshot();
    assert.equal(m.config_read_error, 1);
    assert.equal(m.redis_error, 0);
  });
});
