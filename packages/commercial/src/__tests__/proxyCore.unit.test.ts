/**
 * V3 Phase 4 — `http/proxy/core.ts` 单元测试。
 *
 * 跑法: npx tsx --test src/__tests__/proxyCore.unit.test.ts
 *
 * 覆盖目标:把 anthropicProxy.ts handler 里 L1421-1639 段(abort 绑定 + fetch +
 * SSE pipe + finalize + post-commit + zeroize)的所有分支都直接打到
 * `runUpstreamRoundTrip` 上,不再绕 e2e。
 *
 *   - buildSafeUpstreamHeaders HttpError → finalize.fail + sendJsonError + zeroize 兜底
 *   - fetch 上游 500 → finalize.fail(非 failClient)+ 502 UPSTREAM_ERROR
 *   - fetch 上游 400 + invalid_request_error preview → finalize.failClient(扣健康分豁免)
 *   - fetch 上游 400 + 非 invalid_request_error preview → finalize.fail(扣健康分)
 *   - fetch 上游 200 + null body → finalize.fail + 502 UPSTREAM_NO_BODY
 *   - happy path commit + debited>0 → appendCostCredits 先 → broadcastToUser 后
 *   - commit + debitedCredits=null → 跳过 persist + broadcast
 *   - commit + debitedCredits=0n → 跳过 persist + broadcast
 *   - ctx.sessionId 原样进 broadcast payload(不重提取)
 *   - appendCostCredits throw → broadcast 仍 fire(persist 失败 log 不阻塞)
 *   - broadcastToUser throw → 被吞,无 propagation
 *   - stream 中途非客户端 error + headersSent → res.end(非 sendJsonError 500)
 *   - 上游 fetch AbortError → finalize.failClient + headersSent=false → sendJsonError 500
 *   - finally 兜底:无论成功 / 错误 / abort,session.zeroizeSecrets 必被调用一次,
 *     req.off/res.off 必摘除 onClose 监听器
 *
 * 整链 e2e(包含 identity / rate-limit / pickUpstream / startInflightJournal)走
 * anthropicProxy.integ.test.ts;那里的 mock 更重。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { runUpstreamRoundTrip, type RoundTripCtx } from "../http/proxy/core.js";
import type { PreparedUpstreamSession } from "../http/proxy/upstream.js";
import type { ProxyBody, UsageObservation } from "../http/proxy/shared.js";
import type { FinalizerHandle, FinalizeOutcome } from "../billing/proxyBilling.js";
import { rootLogger } from "../logging/logger.js";

const log = rootLogger.child({ subsys: "proxyCore.unit.test" });

// ─── Mock req/res ──────────────────────────────────────────────────────────

class MockReq extends Readable {
  url = "/v1/messages";
  method = "POST";
  headers: Record<string, string>;
  closeListeners: Array<() => void> = [];
  constructor(headers: Record<string, string> = {}) {
    super();
    this.headers = {
      host: "x.invalid",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...headers,
    };
    this.push(null); // body 为空(core 不读 body)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(ev: string | symbol, cb: (...a: any[]) => void): this {
    if (ev === "close") this.closeListeners.push(cb as () => void);
    return super.on(ev, cb);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override off(ev: string | symbol, cb: (...a: any[]) => void): this {
    if (ev === "close") {
      const i = this.closeListeners.indexOf(cb as () => void);
      if (i >= 0) this.closeListeners.splice(i, 1);
    }
    return super.off(ev, cb);
  }
  /** 触发客户端断开:调用 ac.abort()(经由 onClose listener)。 */
  triggerClientClose() {
    for (const cb of this.closeListeners.slice()) cb();
  }
}

class MockRes {
  statusCode = 0;
  responseHeaders: Record<string, string | number | readonly string[]> = {};
  chunks: Buffer[] = [];
  ended = false;
  headersSent = false;
  closeListeners: Array<() => void> = [];
  /** 模拟 node http 在 res.end() 时同步触发 close 事件,验证 invariant #2 用。 */
  emitCloseOnEnd = false;
  private listeners = new Map<string, Array<(...a: unknown[]) => void>>();

  setHeader(k: string, v: string | number | readonly string[]) {
    this.responseHeaders[k.toLowerCase()] = v;
  }
  writeHead(status: number, headers?: Record<string, string | number | readonly string[]>) {
    this.statusCode = status;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) this.responseHeaders[k.toLowerCase()] = v;
    }
    this.headersSent = true;
  }
  write(chunk: string | Buffer | Uint8Array): boolean {
    if (typeof chunk === "string") this.chunks.push(Buffer.from(chunk));
    else if (chunk instanceof Buffer) this.chunks.push(chunk);
    else this.chunks.push(Buffer.from(chunk));
    return true;
  }
  end(chunk?: string | Buffer): void {
    if (chunk != null) this.write(chunk);
    this.ended = true;
    if (this.emitCloseOnEnd) {
      for (const cb of this.closeListeners.slice()) cb();
    }
  }
  on(ev: string, cb: (...a: unknown[]) => void): this {
    if (ev === "close") this.closeListeners.push(cb as () => void);
    if (!this.listeners.has(ev)) this.listeners.set(ev, []);
    this.listeners.get(ev)!.push(cb);
    return this;
  }
  off(ev: string, cb: (...a: unknown[]) => void): this {
    if (ev === "close") {
      const i = this.closeListeners.indexOf(cb as () => void);
      if (i >= 0) this.closeListeners.splice(i, 1);
    }
    const arr = this.listeners.get(ev);
    if (arr) {
      const idx = arr.indexOf(cb);
      if (idx >= 0) arr.splice(idx, 1);
    }
    return this;
  }
  emit(ev: string, ...args: unknown[]) {
    const arr = this.listeners.get(ev);
    if (arr) for (const cb of arr.slice()) cb(...args);
  }
  bodyText(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

// ─── Mock PreparedUpstreamSession ─────────────────────────────────────────

interface SessionSpy {
  session: PreparedUpstreamSession;
  zeroizeCount: number;
  applyAuthCalls: number;
  sanitizeCalls: number;
}

function makeSession(over: {
  endpoint?: string;
  dispatcher?: unknown;
  shouldUpdateQuotaFromResponse?: boolean;
  accountId?: bigint | null;
  applyAuthImpl?: (h: Record<string, string>, body: ProxyBody) => void;
} = {}): SessionSpy {
  let zeroizeCount = 0;
  let applyAuthCalls = 0;
  let sanitizeCalls = 0;
  const session: PreparedUpstreamSession = {
    accountId: over.accountId ?? 1001n,
    pinnedUserId: null,
    endpoint: over.endpoint ?? "https://api.anthropic.com/v1/messages",
    dispatcher: over.dispatcher,
    shouldUpdateQuotaFromResponse: over.shouldUpdateQuotaFromResponse ?? false,
    applyUpstreamAuth: (headers: Record<string, string>, body: ProxyBody) => {
      applyAuthCalls += 1;
      if (over.applyAuthImpl) over.applyAuthImpl(headers, body);
      headers["authorization"] = "Bearer test-token";
    },
    sanitizeMessages: (messages: unknown[]) => {
      sanitizeCalls += 1;
      return messages;
    },
    zeroizeSecrets: () => {
      zeroizeCount += 1;
    },
  } as unknown as PreparedUpstreamSession;
  return {
    session,
    get zeroizeCount() {
      return zeroizeCount;
    },
    get applyAuthCalls() {
      return applyAuthCalls;
    },
    get sanitizeCalls() {
      return sanitizeCalls;
    },
  };
}

// ─── Mock FinalizerHandle ─────────────────────────────────────────────────

interface FinalizerSpy {
  finalize: FinalizerHandle;
  commitCalls: UsageObservation[];
  failCalls: Array<{ obs: UsageObservation; err: unknown }>;
  failClientCalls: Array<{ obs: UsageObservation; err: unknown }>;
}

function makeFinalize(outcome: Partial<FinalizeOutcome> = {}): FinalizerSpy {
  // 注意:用 `in outcome` 判断显式覆盖,避免 `null ?? default` 把测试期望的
  // null/0n 被替换成默认 100n(已踩过坑)。
  const fullOutcome: FinalizeOutcome = {
    finalCredits: "finalCredits" in outcome ? outcome.finalCredits! : 100n,
    debitedCredits: "debitedCredits" in outcome ? outcome.debitedCredits! : 100n,
    state: outcome.state ?? "committed",
    requestId: outcome.requestId ?? "req-1",
    balanceAfter: "balanceAfter" in outcome ? outcome.balanceAfter! : 9900n,
  };
  const commitCalls: UsageObservation[] = [];
  const failCalls: Array<{ obs: UsageObservation; err: unknown }> = [];
  const failClientCalls: Array<{ obs: UsageObservation; err: unknown }> = [];
  const finalize: FinalizerHandle = {
    async commit(obs) {
      commitCalls.push(obs);
      return fullOutcome;
    },
    async fail(obs, err) {
      failCalls.push({ obs, err });
      return { ...fullOutcome, state: "aborted", debitedCredits: null };
    },
    async failClient(obs, err) {
      failClientCalls.push({ obs, err });
      return { ...fullOutcome, state: "aborted", debitedCredits: null };
    },
  };
  return { finalize, commitCalls, failCalls, failClientCalls };
}

// ─── Mock fetch ────────────────────────────────────────────────────────────

function makeFetch(impl: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  const f = ((url: unknown, init?: unknown) =>
    impl(String(url), (init ?? {}) as RequestInit)) as unknown as typeof fetch;
  return f;
}

/** 一个完整 SSE 流(message_start + message_delta + message_stop)。 */
function sseFullResponse(opts: { status?: number; inputTok?: number; outputTok?: number } = {}): Response {
  const inputTok = opts.inputTok ?? 100;
  const outputTok = opts.outputTok ?? 50;
  const chunks = [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        usage: {
          input_tokens: inputTok,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: {
        input_tokens: inputTok,
        output_tokens: outputTok,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const enc = new TextEncoder();
      for (const c of chunks) ctrl.enqueue(enc.encode(c));
      ctrl.close();
    },
  });
  return new Response(stream, {
    status: opts.status ?? 200,
    headers: { "content-type": "text/event-stream" },
  });
}

// ─── 共用 buildCtx ─────────────────────────────────────────────────────────

interface BuildCtxOpts {
  reqHeaders?: Record<string, string>;
  sessionOver?: Parameters<typeof makeSession>[0];
  finalizerOutcome?: Partial<FinalizeOutcome>;
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  sessionId?: string | null;
  parentSessionId?: string | null;
  appendCostCredits?: RoundTripCtx["appendCostCredits"];
  broadcastToUser?: RoundTripCtx["broadcastToUser"];
}

function buildCtx(opts: BuildCtxOpts) {
  const req = new MockReq(opts.reqHeaders);
  const res = new MockRes();
  const session = makeSession(opts.sessionOver);
  const finalize = makeFinalize(opts.finalizerOutcome);
  const body: ProxyBody = {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  } as ProxyBody;
  const ctx: RoundTripCtx = {
    pgPool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
    fetchFn: makeFetch(opts.fetchImpl),
    appendCostCredits: opts.appendCostCredits,
    broadcastToUser: opts.broadcastToUser,
    req: req as unknown as IncomingMessage,
    res: res as unknown as ServerResponse,
    requestId: "req-test-1",
    uid: 7n,
    body,
    session: session.session,
    finalize: finalize.finalize,
    sessionId: opts.sessionId ?? null,
    parentSessionId: opts.parentSessionId ?? null,
    userLog: log,
  };
  return { ctx, req, res, session, finalize };
}

// ─── Cases ─────────────────────────────────────────────────────────────────

describe("runUpstreamRoundTrip — buildSafeUpstreamHeaders HttpError", () => {
  test("anthropic-version 错 → finalize.fail + 400 ANTHROPIC_VERSION_NOT_ALLOWED + zeroize", async () => {
    let fetchCalled = false;
    const { ctx, req, res, session, finalize } = buildCtx({
      reqHeaders: { "anthropic-version": "wrong-version" },
      fetchImpl: async () => {
        fetchCalled = true;
        return new Response("");
      },
    });
    await runUpstreamRoundTrip(ctx);

    assert.equal(fetchCalled, false, "buildSafeUpstreamHeaders 早抛,fetch 不应被调用");
    assert.equal(finalize.failCalls.length, 1);
    assert.equal(finalize.failClientCalls.length, 0);
    assert.equal(finalize.commitCalls.length, 0);
    assert.equal(res.statusCode, 400);
    const errBody = JSON.parse(res.bodyText()) as { error: { code: string } };
    assert.equal(errBody.error.code, "ANTHROPIC_VERSION_NOT_ALLOWED");

    // finally 兜底
    assert.equal(session.zeroizeCount, 1, "zeroizeSecrets 必调一次");
    assert.equal(req.closeListeners.length, 0, "req.off('close') 已摘除");
    assert.equal(res.closeListeners.length, 0, "res.off('close') 已摘除");
  });
});

describe("runUpstreamRoundTrip — upstream non-2xx 分支", () => {
  test("上游 500 → finalize.fail(非 failClient)+ 502 UPSTREAM_ERROR", async () => {
    const { ctx, res, session, finalize } = buildCtx({
      fetchImpl: async () => new Response("internal error", { status: 500 }),
    });
    await runUpstreamRoundTrip(ctx);

    assert.equal(finalize.failCalls.length, 1, "500 走 fail 路径");
    assert.equal(finalize.failClientCalls.length, 0, "500 不走 failClient");
    assert.equal(res.statusCode, 502);
    const errBody = JSON.parse(res.bodyText()) as { error: { code: string } };
    assert.equal(errBody.error.code, "UPSTREAM_ERROR");
    assert.equal(session.zeroizeCount, 1);
  });

  test("上游 400 invalid_request_error → finalize.failClient(豁免健康分)", async () => {
    const preview = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "thinking signature invalid" },
    });
    const { ctx, finalize, session } = buildCtx({
      fetchImpl: async () => new Response(preview, { status: 400 }),
    });
    await runUpstreamRoundTrip(ctx);

    assert.equal(finalize.failClientCalls.length, 1, "400 + invalid_request_error → failClient");
    assert.equal(finalize.failCalls.length, 0, "不该走 fail");
    assert.equal(session.zeroizeCount, 1);
  });

  test("上游 400 非 invalid_request_error preview → finalize.fail(扣健康分)", async () => {
    const preview = JSON.stringify({
      type: "error",
      error: { type: "overloaded_error", message: "throttled" },
    });
    const { ctx, finalize } = buildCtx({
      fetchImpl: async () => new Response(preview, { status: 400 }),
    });
    await runUpstreamRoundTrip(ctx);

    assert.equal(finalize.failCalls.length, 1, "400 + non-invalid_request → 仍 fail");
    assert.equal(finalize.failClientCalls.length, 0);
  });

  test("上游 200 但 body=null → finalize.fail + 502 UPSTREAM_NO_BODY", async () => {
    const { ctx, res, finalize, session } = buildCtx({
      // Response 不带 body
      fetchImpl: async () => new Response(null, { status: 200 }),
    });
    await runUpstreamRoundTrip(ctx);

    assert.equal(finalize.failCalls.length, 1);
    assert.equal(finalize.failClientCalls.length, 0);
    assert.equal(res.statusCode, 502);
    const errBody = JSON.parse(res.bodyText()) as { error: { code: string } };
    assert.equal(errBody.error.code, "UPSTREAM_NO_BODY");
    assert.equal(session.zeroizeCount, 1);
  });
});

describe("runUpstreamRoundTrip — happy path commit + post-commit", () => {
  test("debited>0 → appendCostCredits 先 + broadcastToUser 后(顺序锁)", async () => {
    const events: string[] = [];
    const persistCalls: Array<{ rid: string; uid: string; cents: string }> = [];
    const broadcastCalls: Array<{ uid: bigint; payload: unknown }> = [];

    const { ctx, res, finalize, session } = buildCtx({
      fetchImpl: async () => sseFullResponse({ inputTok: 100, outputTok: 50 }),
      sessionId: "session-abc-123",
      finalizerOutcome: { state: "committed", debitedCredits: 250n, balanceAfter: 9750n },
      appendCostCredits: async (rid, uid, cents) => {
        events.push("persist");
        persistCalls.push({ rid, uid, cents });
      },
      broadcastToUser: (uid, payload) => {
        events.push("broadcast");
        broadcastCalls.push({ uid, payload });
      },
    });
    await runUpstreamRoundTrip(ctx);

    assert.equal(finalize.commitCalls.length, 1, "stream 正常结束 → commit");
    assert.equal(res.statusCode, 200, "SSE 200 写头");

    assert.deepEqual(events, ["persist", "broadcast"], "persist 必须先于 broadcast");
    assert.equal(persistCalls.length, 1);
    assert.equal(persistCalls[0].rid, "req-test-1");
    assert.equal(persistCalls[0].uid, "7");
    assert.equal(persistCalls[0].cents, "250");

    assert.equal(broadcastCalls.length, 1);
    assert.equal(broadcastCalls[0].uid, 7n);
    const payload = broadcastCalls[0].payload as {
      type: string;
      costCredits: string;
      balanceAfter: string | null;
      sessionId: string | null;
    };
    assert.equal(payload.type, "outbound.cost_charged");
    assert.equal(payload.costCredits, "250");
    assert.equal(payload.balanceAfter, "9750");
    assert.equal(
      payload.sessionId,
      "session-abc-123",
      "ctx.sessionId 必须原样进 payload(不重提取)",
    );

    assert.equal(session.zeroizeCount, 1);
  });

  test("delegate 模式:parentSessionId 进 park(第5参)+ broadcast payload(Fix A/B)", async () => {
    const persistArgs: Array<{ sessionId?: string | null; parentSessionId?: string | null }> = [];
    const broadcastPayloads: unknown[] = [];
    const { ctx } = buildCtx({
      fetchImpl: async () => sseFullResponse({ inputTok: 100, outputTok: 50 }),
      sessionId: "engine-delegate-uuid", // 委派子进程自己的引擎会话
      parentSessionId: "web-parent-01", // 父客户端会话(web-*)
      finalizerOutcome: { state: "committed", debitedCredits: 42n, balanceAfter: 100n },
      appendCostCredits: async (_rid, _uid, _cents, sessionId, parentSessionId) => {
        persistArgs.push({ sessionId, parentSessionId });
      },
      broadcastToUser: (_uid, payload) => {
        broadcastPayloads.push(payload);
      },
    });
    await runUpstreamRoundTrip(ctx);

    assert.equal(persistArgs.length, 1);
    assert.equal(persistArgs[0].sessionId, "engine-delegate-uuid", "session_id 仍是委派引擎会话");
    assert.equal(persistArgs[0].parentSessionId, "web-parent-01", "parentSessionId 进 park(durable 归并 key)");

    const payload = broadcastPayloads[0] as { sessionId: string | null; parentSessionId: string | null };
    assert.equal(payload.sessionId, "engine-delegate-uuid");
    assert.equal(payload.parentSessionId, "web-parent-01", "broadcast 带 parentSessionId(前端精确路由)");
  });

  test("普通 chat(非委派):parentSessionId=null 进 park + broadcast(零影响)", async () => {
    const persistArgs: Array<{ parentSessionId?: string | null }> = [];
    const broadcastPayloads: unknown[] = [];
    const { ctx } = buildCtx({
      fetchImpl: async () => sseFullResponse({ inputTok: 100, outputTok: 50 }),
      sessionId: "engine-chat-uuid",
      // parentSessionId 缺省 → buildCtx 填 null(普通 chat)
      finalizerOutcome: { state: "committed", debitedCredits: 30n, balanceAfter: 70n },
      appendCostCredits: async (_rid, _uid, _cents, _sessionId, parentSessionId) => {
        persistArgs.push({ parentSessionId });
      },
      broadcastToUser: (_uid, payload) => {
        broadcastPayloads.push(payload);
      },
    });
    await runUpstreamRoundTrip(ctx);

    assert.equal(persistArgs[0].parentSessionId, null, "普通 chat park 的 parentSessionId 恒 null");
    const payload = broadcastPayloads[0] as { parentSessionId: string | null };
    assert.equal(payload.parentSessionId, null, "普通 chat broadcast parentSessionId=null → 前端回落启发式");
  });

  test("debited=null(billing_failed)→ 跳过 persist + broadcast", async () => {
    let persistCalls = 0;
    let broadcastCalls = 0;
    const { ctx, finalize } = buildCtx({
      fetchImpl: async () => sseFullResponse(),
      finalizerOutcome: { state: "committed", debitedCredits: null, balanceAfter: 9750n },
      appendCostCredits: async () => {
        persistCalls += 1;
      },
      broadcastToUser: () => {
        broadcastCalls += 1;
      },
    });
    await runUpstreamRoundTrip(ctx);

    assert.equal(finalize.commitCalls.length, 1);
    assert.equal(persistCalls, 0, "debitedCredits=null 不该 persist");
    assert.equal(broadcastCalls, 0, "debitedCredits=null 不该 broadcast");
  });

  test("debited=0n → 跳过 persist + broadcast", async () => {
    let persistCalls = 0;
    let broadcastCalls = 0;
    const { ctx } = buildCtx({
      fetchImpl: async () => sseFullResponse(),
      finalizerOutcome: { state: "committed", debitedCredits: 0n, balanceAfter: 9750n },
      appendCostCredits: async () => {
        persistCalls += 1;
      },
      broadcastToUser: () => {
        broadcastCalls += 1;
      },
    });
    await runUpstreamRoundTrip(ctx);

    assert.equal(persistCalls, 0);
    assert.equal(broadcastCalls, 0);
  });

  test("appendCostCredits throw → broadcast 仍 fire(persist 失败不阻塞)", async () => {
    let broadcastCalls = 0;
    const { ctx } = buildCtx({
      fetchImpl: async () => sseFullResponse(),
      finalizerOutcome: { state: "committed", debitedCredits: 100n, balanceAfter: 9900n },
      appendCostCredits: async () => {
        throw new Error("persist exploded");
      },
      broadcastToUser: () => {
        broadcastCalls += 1;
      },
    });
    await runUpstreamRoundTrip(ctx);

    assert.equal(broadcastCalls, 1, "persist throw 不该掩盖 broadcast");
  });

  test("broadcastToUser throw → 被吞,无 propagation", async () => {
    const { ctx } = buildCtx({
      fetchImpl: async () => sseFullResponse(),
      finalizerOutcome: { state: "committed", debitedCredits: 100n, balanceAfter: 9900n },
      broadcastToUser: () => {
        throw new Error("broadcast exploded");
      },
    });
    // 不该 throw
    await runUpstreamRoundTrip(ctx);
  });
});

describe("runUpstreamRoundTrip — stream / fetch error 分支", () => {
  test("stream 抛错 + headersSent=true → res.end(非 sendJsonError 500)+ finalize.fail", async () => {
    const errorStream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        // 发一个 chunk(触发 writeHead)然后 error
        const enc = new TextEncoder();
        ctrl.enqueue(enc.encode("event: message_start\ndata: {}\n\n"));
        ctrl.error(new Error("upstream socket reset"));
      },
    });
    const { ctx, res, finalize } = buildCtx({
      fetchImpl: async () =>
        new Response(errorStream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    });
    await runUpstreamRoundTrip(ctx);

    assert.equal(finalize.failCalls.length, 1, "非 client abort → fail");
    assert.equal(finalize.failClientCalls.length, 0);
    // writeHead 200 已发,res.end 收尾,不发 500
    assert.equal(res.statusCode, 200);
    assert.equal(res.ended, true);
  });

  test("fetch 直接抛 AbortError(headersSent=false)→ failClient + sendJsonError 500", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const { ctx, res, finalize, session } = buildCtx({
      fetchImpl: async () => {
        throw abortErr;
      },
    });
    await runUpstreamRoundTrip(ctx);

    assert.equal(finalize.failClientCalls.length, 1, "AbortError → failClient");
    assert.equal(finalize.failCalls.length, 0);
    assert.equal(res.statusCode, 500, "字节未 flush → sendJsonError 500");
    const errBody = JSON.parse(res.bodyText()) as { error: { code: string } };
    assert.equal(errBody.error.code, "INTERNAL");
    assert.equal(session.zeroizeCount, 1, "finally zeroize 兜底");
  });

  test("fetch 抛非 abort error(headersSent=false)→ fail + sendJsonError 500", async () => {
    const { ctx, res, finalize } = buildCtx({
      fetchImpl: async () => {
        throw new Error("DNS resolution failed");
      },
    });
    await runUpstreamRoundTrip(ctx);

    assert.equal(finalize.failCalls.length, 1, "非 abort → fail(扣健康分)");
    assert.equal(finalize.failClientCalls.length, 0);
    assert.equal(res.statusCode, 500);
  });

  // Invariant #2 锁:abort 分类只看 err.shape,不看 ac.signal.aborted。
  // 实际 node http 中 res.end() 会同步触发 res 'close' → onClose → ac.abort(),
  // 此时 ac.signal.aborted=true。catch 块若误用 ac.signal.aborted 判定,
  // 就会把 server-side stream error 错判为 client abort(应走 fail,不走 failClient)。
  test("stream 中途 server-side error + res.end()→close 同步触发 ac.abort → 仍走 fail(invariant #2)", async () => {
    const errorStream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        const enc = new TextEncoder();
        ctrl.enqueue(enc.encode("event: message_start\ndata: {}\n\n"));
        ctrl.error(new Error("upstream socket reset")); // 非 abort,非 ProxyAbortError
      },
    });
    const req = new MockReq();
    const res = new MockRes();
    res.emitCloseOnEnd = true; // 关键:res.end() 同步触发 close 事件
    const session = makeSession();
    const finalize = makeFinalize();
    const body: ProxyBody = {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    } as ProxyBody;
    const ctx: RoundTripCtx = {
      pgPool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
      fetchFn: makeFetch(async () =>
        new Response(errorStream, { status: 200, headers: { "content-type": "text/event-stream" } }),
      ),
      req: req as unknown as IncomingMessage,
      res: res as unknown as ServerResponse,
      requestId: "req-test-inv2",
      uid: 7n,
      body,
      session: session.session,
      finalize: finalize.finalize,
      sessionId: null,
      parentSessionId: null,
      userLog: log,
    };
    await runUpstreamRoundTrip(ctx);

    // server-side error 即便 ac.signal.aborted=true(由 res.end 触发)也必须分类为 fail
    assert.equal(finalize.failCalls.length, 1, "server-side stream error → fail(不能因 ac.signal.aborted 误判 failClient)");
    assert.equal(finalize.failClientCalls.length, 0, "isClientAbort 只看 err.shape,res.end 触发的 abort 不算 client abort");
    assert.equal(res.ended, true);
  });
});

describe("runUpstreamRoundTrip — finally 兜底不变量", () => {
  test("happy path 后 session.zeroizeSecrets / req.off / res.off 全归零", async () => {
    const { ctx, req, res, session } = buildCtx({
      fetchImpl: async () => sseFullResponse(),
      finalizerOutcome: { state: "committed", debitedCredits: 0n },
    });
    // 入口前监听器应为空,确保只验证 core 自己加 / 移
    assert.equal(req.closeListeners.length, 0);
    assert.equal(res.closeListeners.length, 0);

    await runUpstreamRoundTrip(ctx);

    assert.equal(session.zeroizeCount, 1, "成功路径 zeroize 必调");
    assert.equal(req.closeListeners.length, 0, "成功路径 req close listener 必摘");
    assert.equal(res.closeListeners.length, 0, "成功路径 res close listener 必摘");
  });

  test("dispatcher 注入 → fetchInit.dispatcher 被透传", async () => {
    let capturedInit: RequestInit | null = null;
    const fakeDispatcher = { __test: "fake-dispatcher" };
    const { ctx } = buildCtx({
      sessionOver: { dispatcher: fakeDispatcher },
      fetchImpl: async (_url, init) => {
        capturedInit = init;
        return sseFullResponse();
      },
    });
    await runUpstreamRoundTrip(ctx);

    assert.notEqual(capturedInit, null);
    const dispatcher = (capturedInit as unknown as RequestInit & { dispatcher?: unknown }).dispatcher;
    assert.equal(dispatcher, fakeDispatcher, "session.dispatcher 必透传给 fetchInit");
  });

  test("dispatcher 缺省 → fetchInit 不带 dispatcher 字段", async () => {
    let capturedInit: RequestInit | null = null;
    const { ctx } = buildCtx({
      sessionOver: { dispatcher: undefined },
      fetchImpl: async (_url, init) => {
        capturedInit = init;
        return sseFullResponse();
      },
    });
    await runUpstreamRoundTrip(ctx);

    assert.notEqual(capturedInit, null);
    const dispatcher = (capturedInit as unknown as RequestInit & { dispatcher?: unknown }).dispatcher;
    assert.equal(dispatcher, undefined, "无 dispatcher → fetchInit 不显式赋值");
  });
});
