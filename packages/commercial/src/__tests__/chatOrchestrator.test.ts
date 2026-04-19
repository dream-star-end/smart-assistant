/**
 * T-40 — runClaudeChat 单元:只走纯函数 + 注入的 stub stream/refresh/scheduler,
 * 不触 DB / 不触 fetch。
 *
 * 覆盖:
 *   1. 正常流:scheduler.pick → streamClaude → 产出 meta/delta.../usage/done
 *   2. 预先 refresh(expires_at 在 skew 内)→ 先调 refreshFn 再 stream
 *   3. stream 中 ProxyAuthError → refreshFn + 重试一次 → 成功
 *   4. 重试后仍 401 → error code=ERR_UPSTREAM_AUTH
 *   5. ProxyError 非 401 → error code=ERR_UPSTREAM
 *   6. refresh 失败 → error code=ERR_REFRESH_FAILED
 *   7. pick 抛 AccountPoolUnavailableError → error code=ERR_ACCOUNT_POOL_UNAVAILABLE
 *   8. pick 抛 AeadError → error code=ERR_ACCOUNT_BROKEN
 *   9. usage 累积正确(message_start.input + cache_* + message_delta.output)
 *  10. stop_reason 从 message_delta 抽出
 *  11. content_block_delta.text_delta 被当 delta 转发,其他类型 delta 被忽略
 *  12. Token Buffer 被 fill(0) 清零(verify via release 前后 token 内容)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  runClaudeChat,
  ERR_ACCOUNT_POOL_UNAVAILABLE,
  ERR_REFRESH_FAILED,
  ERR_UPSTREAM,
  ERR_UPSTREAM_AUTH,
  ERR_ACCOUNT_BROKEN,
  type ChatEvent,
  type RunChatDeps,
} from "../chat/orchestrator.js";
import {
  AccountPoolUnavailableError,
  type AccountScheduler,
} from "../account-pool/scheduler.js";
import {
  ProxyAuthError,
  ProxyError,
  type ProxyEvent,
  type StreamClaudeInput,
} from "../account-pool/proxy.js";
import { RefreshError } from "../account-pool/refresh.js";
import { AeadError } from "../crypto/aead.js";

/* ----- stubs ------------------------------------------------------------- */

interface PickCall { mode: string; sessionId?: string; model?: string }
interface ReleaseCall { account_id: bigint | string; kind: "success" | "failure"; error?: string | null }

function mkScheduler(
  overrides: Partial<{
    pickResult: {
      account_id: bigint;
      plan: "pro" | "max" | "team";
      token: Buffer;
      refresh: Buffer | null;
      expires_at: Date | null;
      egress_proxy?: string | null;
    };
    pickError: Error;
  }> = {},
): { scheduler: AccountScheduler; picks: PickCall[]; releases: ReleaseCall[] } {
  const picks: PickCall[] = [];
  const releases: ReleaseCall[] = [];
  const scheduler: Partial<AccountScheduler> = {
    async pick(input) {
      picks.push(input);
      if (overrides.pickError) throw overrides.pickError;
      if (overrides.pickResult) {
        return { egress_proxy: null, ...overrides.pickResult };
      }
      return {
        account_id: 42n,
        plan: "pro",
        token: Buffer.from("tok-abc", "utf8"),
        refresh: Buffer.from("ref-xyz", "utf8"),
        expires_at: new Date(Date.now() + 60 * 60 * 1000), // 1h future → 不触发 refresh
        egress_proxy: null,
      };
    },
    async release(input) {
      releases.push({
        account_id: input.account_id,
        kind: input.result.kind,
        error: input.result.kind === "failure" ? input.result.error ?? null : undefined,
      });
    },
  };
  return { scheduler: scheduler as AccountScheduler, picks, releases };
}

interface StreamCallSnapshot {
  /** token 在调用瞬间的 utf8 快照(orchestrator 之后会 fill(0),所以必须抓快照) */
  tokenText: string;
  body: Record<string, unknown>;
  /** proxyDeps 在调用瞬间的引用 —— 用于断言 dispatcher 是否注入 */
  proxyDeps?: unknown;
}

/** 构造一个 streamFn mock:按预设的 ProxyEvent 序列 yield。 */
function mkStreamFn(
  events: ProxyEvent[],
  opts: { throwAt?: number; throwError?: Error } = {},
): {
  fn: (input: StreamClaudeInput, deps?: unknown) => AsyncGenerator<ProxyEvent, void, void>;
  calls: StreamCallSnapshot[];
} {
  const calls: StreamCallSnapshot[] = [];
  const { throwAt, throwError } = opts;
  async function* gen(input: StreamClaudeInput, deps?: unknown): AsyncGenerator<ProxyEvent, void, void> {
    calls.push({
      tokenText: input.account.token.toString("utf8"),
      body: input.body as Record<string, unknown>,
      proxyDeps: deps,
    });
    for (let i = 0; i < events.length; i += 1) {
      if (throwAt !== undefined && i === throwAt && throwError) throw throwError;
      yield events[i];
    }
    if (throwAt !== undefined && throwAt >= events.length && throwError) throw throwError;
  }
  return { fn: gen, calls };
}

/**
 * 双阶段 streamFn:第一次调用 throw,第二次调用 yield 正常序列。
 * 用于模拟 401 → refresh → retry 成功。
 */
function mkStreamFnSequence(
  seq: Array<{ events: ProxyEvent[]; throwAfter?: Error }>,
): {
  fn: (input: StreamClaudeInput) => AsyncGenerator<ProxyEvent, void, void>;
  calls: StreamCallSnapshot[];
} {
  const calls: StreamCallSnapshot[] = [];
  let idx = 0;
  async function* gen(input: StreamClaudeInput): AsyncGenerator<ProxyEvent, void, void> {
    calls.push({
      tokenText: input.account.token.toString("utf8"),
      body: input.body as Record<string, unknown>,
    });
    const round = seq[idx] ?? seq[seq.length - 1];
    idx += 1;
    for (const ev of round.events) yield ev;
    if (round.throwAfter) throw round.throwAfter;
  }
  return { fn: gen, calls };
}

function mkRefreshFn(result: {
  ok?: { token: string; refresh?: string | null };
  error?: RefreshError;
}): { fn: typeof import("../account-pool/refresh.js").refreshAccountToken; calls: Array<bigint | string> } {
  const calls: Array<bigint | string> = [];
  const fn = async (accountId: bigint | string) => {
    calls.push(accountId);
    if (result.error) throw result.error;
    const r = result.ok!;
    return {
      token: Buffer.from(r.token, "utf8"),
      refresh: r.refresh === null ? null : r.refresh !== undefined ? Buffer.from(r.refresh, "utf8") : null,
      expires_at: new Date(Date.now() + 60 * 60 * 1000),
      plan: "pro" as const,
    };
  };
  return { fn: fn as unknown as typeof import("../account-pool/refresh.js").refreshAccountToken, calls };
}

/* ----- test event builders ----------------------------------------------- */

function evMessageStart(input_tokens = 10, cache_read = 0, cache_write = 0): ProxyEvent {
  const d = {
    type: "message_start",
    message: {
      usage: {
        input_tokens,
        cache_read_input_tokens: cache_read,
        cache_creation_input_tokens: cache_write,
      },
    },
  };
  return { event: "message_start", data: d, raw: JSON.stringify(d) };
}

function evContentBlockDelta(text: string): ProxyEvent {
  const d = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
  return { event: "content_block_delta", data: d, raw: JSON.stringify(d) };
}

function evMessageDelta(output_tokens: number, stop_reason = "end_turn"): ProxyEvent {
  const d = {
    type: "message_delta",
    delta: { stop_reason },
    usage: { output_tokens },
  };
  return { event: "message_delta", data: d, raw: JSON.stringify(d) };
}

function evMessageStop(): ProxyEvent {
  const d = { type: "message_stop" };
  return { event: "message_stop", data: d, raw: JSON.stringify(d) };
}

async function collect(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const baseInput = {
  userId: 1n,
  mode: "chat" as const,
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "hi" }],
  max_tokens: 1000,
};

/* ----- tests ------------------------------------------------------------- */

describe("runClaudeChat — happy path", () => {
  test("正常流:meta → delta × 2 → usage → done", async () => {
    const { scheduler, releases } = mkScheduler();
    const { fn } = mkStreamFn([
      evMessageStart(10),
      evContentBlockDelta("Hello, "),
      evContentBlockDelta("world!"),
      evMessageDelta(5),
      evMessageStop(),
    ]);
    const events = await collect(
      runClaudeChat(baseInput, { scheduler, streamFn: fn } as RunChatDeps),
    );
    const types = events.map((e) => e.type);
    assert.deepEqual(types, ["meta", "delta", "delta", "usage", "done"]);
    assert.equal((events[1] as { text: string }).text, "Hello, ");
    assert.equal((events[2] as { text: string }).text, "world!");
    const u = events[3] as { usage: { input_tokens: bigint; output_tokens: bigint }; stop_reason: string };
    assert.equal(u.usage.input_tokens, 10n);
    assert.equal(u.usage.output_tokens, 5n);
    assert.equal(u.stop_reason, "end_turn");
    assert.equal(releases.length, 1);
    assert.equal(releases[0].kind, "success");
  });

  test("usage 累积:cache_read + cache_write 也正确", async () => {
    const { scheduler } = mkScheduler();
    const { fn } = mkStreamFn([
      evMessageStart(100, 50, 30),
      evContentBlockDelta("x"),
      evMessageDelta(200),
      evMessageStop(),
    ]);
    const events = await collect(runClaudeChat(baseInput, { scheduler, streamFn: fn }));
    const u = events.find((e) => e.type === "usage") as { usage: {
      input_tokens: bigint; output_tokens: bigint; cache_read_tokens: bigint; cache_write_tokens: bigint } };
    assert.equal(u.usage.input_tokens, 100n);
    assert.equal(u.usage.cache_read_tokens, 50n);
    assert.equal(u.usage.cache_write_tokens, 30n);
    assert.equal(u.usage.output_tokens, 200n);
  });

  test("非 text_delta 类型 delta 被忽略(不当 delta 转发)", async () => {
    const { scheduler } = mkScheduler();
    const inputJsonDelta: ProxyEvent = {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{" } },
      raw: "",
    };
    const { fn } = mkStreamFn([
      evMessageStart(10),
      inputJsonDelta,
      evContentBlockDelta("ok"),
      evMessageDelta(5),
      evMessageStop(),
    ]);
    const events = await collect(runClaudeChat(baseInput, { scheduler, streamFn: fn }));
    const deltas = events.filter((e) => e.type === "delta") as Array<{ text: string }>;
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].text, "ok");
  });
});

describe("runClaudeChat — refresh 路径", () => {
  test("expires_at 在 skew 内 → 预先 refresh + 再 stream(refresh 成功)", async () => {
    const { scheduler } = mkScheduler({
      pickResult: {
        account_id: 7n,
        plan: "pro",
        token: Buffer.from("old-tok", "utf8"),
        refresh: Buffer.from("old-ref", "utf8"),
        expires_at: new Date(Date.now() + 60_000), // 1 min future, < 5min skew
      },
    });
    const { fn: refreshFn, calls: rfCalls } = mkRefreshFn({ ok: { token: "new-tok", refresh: "new-ref" } });
    const { fn: streamFn, calls: stCalls } = mkStreamFn([
      evMessageStart(5),
      evContentBlockDelta("hi"),
      evMessageDelta(3),
      evMessageStop(),
    ]);
    const events = await collect(
      runClaudeChat(baseInput, { scheduler, streamFn, refreshFn }),
    );
    assert.equal(rfCalls.length, 1);
    assert.equal(rfCalls[0], 7n);
    assert.equal(stCalls.length, 1);
    assert.equal(stCalls[0].tokenText, "new-tok");
    assert.equal(events.at(-1)?.type, "done");
  });

  test("预先 refresh 失败 → error code=ERR_REFRESH_FAILED + release failure", async () => {
    const { scheduler, releases } = mkScheduler({
      pickResult: {
        account_id: 7n,
        plan: "pro",
        token: Buffer.from("old-tok", "utf8"),
        refresh: Buffer.from("old-ref", "utf8"),
        expires_at: new Date(Date.now() + 30_000),
      },
    });
    const { fn: refreshFn } = mkRefreshFn({
      error: new RefreshError("no_refresh_token", "no refresh on record"),
    });
    const { fn: streamFn, calls: stCalls } = mkStreamFn([]);
    const events = await collect(
      runClaudeChat(baseInput, { scheduler, streamFn, refreshFn }),
    );
    assert.equal(stCalls.length, 0);
    const err = events.find((e) => e.type === "error") as { code: string };
    assert.equal(err.code, ERR_REFRESH_FAILED);
    assert.equal(releases.length, 1);
    assert.equal(releases[0].kind, "failure");
  });

  test("401 → refresh + 重试一次 → 成功", async () => {
    const { scheduler, releases } = mkScheduler();
    const { fn: refreshFn, calls: rfCalls } = mkRefreshFn({ ok: { token: "new-tok" } });
    const { fn: streamFn, calls: stCalls } = mkStreamFnSequence([
      { events: [evMessageStart(0)], throwAfter: new ProxyAuthError("expired token") },
      { events: [evMessageStart(10), evContentBlockDelta("retry-ok"), evMessageDelta(5), evMessageStop()] },
    ]);
    const events = await collect(
      runClaudeChat(baseInput, { scheduler, streamFn, refreshFn }),
    );
    assert.equal(rfCalls.length, 1);
    assert.equal(stCalls.length, 2);
    assert.equal(stCalls[1].tokenText, "new-tok");
    const deltas = events.filter((e) => e.type === "delta") as Array<{ text: string }>;
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].text, "retry-ok");
    assert.equal(events.at(-1)?.type, "done");
    // 401 → refresh 成功后仍算整体 success
    assert.equal(releases[0].kind, "success");
  });

  test("401 → refresh 失败 → error code=ERR_REFRESH_FAILED", async () => {
    const { scheduler } = mkScheduler();
    const { fn: refreshFn } = mkRefreshFn({ error: new RefreshError("http_error", "500") });
    const { fn: streamFn } = mkStreamFnSequence([
      { events: [evMessageStart(0)], throwAfter: new ProxyAuthError("expired") },
    ]);
    const events = await collect(
      runClaudeChat(baseInput, { scheduler, streamFn, refreshFn }),
    );
    const err = events.find((e) => e.type === "error") as { code: string };
    assert.equal(err.code, ERR_REFRESH_FAILED);
  });

  test("重试后仍 401 → error code=ERR_UPSTREAM_AUTH", async () => {
    const { scheduler, releases } = mkScheduler();
    const { fn: refreshFn } = mkRefreshFn({ ok: { token: "new-tok" } });
    const { fn: streamFn, calls: stCalls } = mkStreamFnSequence([
      { events: [], throwAfter: new ProxyAuthError("401 a") },
      { events: [], throwAfter: new ProxyAuthError("401 b") },
    ]);
    const events = await collect(
      runClaudeChat(baseInput, { scheduler, streamFn, refreshFn }),
    );
    assert.equal(stCalls.length, 2);
    const err = events.find((e) => e.type === "error") as { code: string; upstreamStatus?: number };
    assert.equal(err.code, ERR_UPSTREAM_AUTH);
    assert.equal(err.upstreamStatus, 401);
    assert.equal(releases[0].kind, "failure");
  });
});

describe("runClaudeChat — 错误映射", () => {
  test("ProxyError 5xx → error code=ERR_UPSTREAM + upstreamStatus + 不归咎账号(无 release)", async () => {
    const { scheduler, releases } = mkScheduler();
    const { fn } = mkStreamFnSequence([
      { events: [], throwAfter: new ProxyError(500, "server err", "upstream 500") },
    ]);
    const events = await collect(runClaudeChat(baseInput, { scheduler, streamFn: fn }));
    const err = events.find((e) => e.type === "error") as { code: string; upstreamStatus?: number };
    assert.equal(err.code, ERR_UPSTREAM);
    assert.equal(err.upstreamStatus, 500);
    // 5xx → classifyError='neutral' → release 不调用 scheduler.release(跳过 health 更新)
    assert.equal(releases.length, 0, "5xx must not be blamed on the account");
  });

  test("ProxyError 429 → error code=ERR_UPSTREAM + release failure(账号 rate-limit)", async () => {
    const { scheduler, releases } = mkScheduler();
    const { fn } = mkStreamFnSequence([
      { events: [], throwAfter: new ProxyError(429, "rate_limit", "rate_limit_error") },
    ]);
    const events = await collect(runClaudeChat(baseInput, { scheduler, streamFn: fn }));
    const err = events.find((e) => e.type === "error") as { code: string; upstreamStatus?: number };
    assert.equal(err.code, ERR_UPSTREAM);
    assert.equal(err.upstreamStatus, 429);
    assert.equal(releases.length, 1);
    assert.equal(releases[0].kind, "failure");
  });

  test("pick 抛 AccountPoolUnavailableError → ERR_ACCOUNT_POOL_UNAVAILABLE(无 release)", async () => {
    const { scheduler, releases } = mkScheduler({
      pickError: new AccountPoolUnavailableError("no active accounts"),
    });
    const { fn } = mkStreamFn([]);
    const events = await collect(runClaudeChat(baseInput, { scheduler, streamFn: fn }));
    assert.equal(events.length, 1);
    const err = events[0] as { type: string; code: string };
    assert.equal(err.type, "error");
    assert.equal(err.code, ERR_ACCOUNT_POOL_UNAVAILABLE);
    assert.equal(releases.length, 0, "pick 未成功,不应 release");
  });

  test("pick 抛 AeadError(账号密文损坏)→ ERR_ACCOUNT_BROKEN(无 release)", async () => {
    const { scheduler, releases } = mkScheduler({
      pickError: new AeadError("decrypt failed"),
    });
    const { fn } = mkStreamFn([]);
    const events = await collect(runClaudeChat(baseInput, { scheduler, streamFn: fn }));
    const err = events[0] as { code: string };
    assert.equal(err.code, ERR_ACCOUNT_BROKEN);
    assert.equal(releases.length, 0);
  });
});

describe("runClaudeChat — Buffer 清零", () => {
  test("成功路径 —— 结束后 token Buffer 被 fill(0)", async () => {
    const tokenBuf = Buffer.from("secret", "utf8");
    const refreshBuf = Buffer.from("secret-ref", "utf8");
    const { scheduler } = mkScheduler({
      pickResult: {
        account_id: 99n,
        plan: "pro",
        token: tokenBuf,
        refresh: refreshBuf,
        expires_at: new Date(Date.now() + 3600_000),
      },
    });
    const { fn } = mkStreamFn([
      evMessageStart(1),
      evContentBlockDelta("x"),
      evMessageDelta(1),
      evMessageStop(),
    ]);
    await collect(runClaudeChat(baseInput, { scheduler, streamFn: fn }));
    // 所有字节都应为 0
    assert.ok(tokenBuf.every((b) => b === 0), "token buffer should be zeroed");
    assert.ok(refreshBuf.every((b) => b === 0), "refresh buffer should be zeroed");
  });

  test("错误路径 —— 同样清零", async () => {
    const tokenBuf = Buffer.from("secret-err", "utf8");
    const { scheduler } = mkScheduler({
      pickResult: {
        account_id: 99n,
        plan: "pro",
        token: tokenBuf,
        refresh: null,
        expires_at: new Date(Date.now() + 3600_000),
      },
    });
    const { fn } = mkStreamFnSequence([
      { events: [], throwAfter: new ProxyError(500, "boom") },
    ]);
    await collect(runClaudeChat(baseInput, { scheduler, streamFn: fn }));
    assert.ok(tokenBuf.every((b) => b === 0), "token buffer should be zeroed on error");
  });
});

describe("runClaudeChat — body 透传", () => {
  test("system + extra 字段透传;stream 字段不会被 extra 覆盖(由 streamClaude 强制)", async () => {
    const { scheduler } = mkScheduler();
    const { fn, calls } = mkStreamFn([
      evMessageStart(1),
      evContentBlockDelta("ok"),
      evMessageDelta(1),
      evMessageStop(),
    ]);
    await collect(runClaudeChat(
      { ...baseInput, system: "you are helpful", extra: { temperature: 0.5, stream: false, messages: [] } },
      { scheduler, streamFn: fn },
    ));
    const body = calls[0].body;
    assert.equal(body.system, "you are helpful");
    assert.equal(body.temperature, 0.5);
    assert.equal(body.model, baseInput.model);
    assert.equal(body.max_tokens, baseInput.max_tokens);
    // orchestrator 不会把 extra.stream 写入 body(stream 由 streamClaude 在内部强制 true)
    assert.equal(body.stream, undefined);
    // orchestrator 不会让 extra.messages 覆盖真 messages
    assert.deepEqual(body.messages, baseInput.messages);
  });
});

describe("runClaudeChat — egress_proxy 注入(Codex 8ec407b 复审跟进)", () => {
  test("egress_proxy=null → streamFn 收到的 proxyDeps 不含 dispatcher 字段", async () => {
    const { scheduler } = mkScheduler({
      pickResult: {
        account_id: 7n,
        plan: "pro",
        token: Buffer.from("tok-no-proxy", "utf8"),
        refresh: null,
        expires_at: new Date(Date.now() + 3600_000),
        egress_proxy: null,
      },
    });
    const { fn, calls } = mkStreamFn([
      evMessageStart(1),
      evMessageDelta(1),
      evMessageStop(),
    ]);
    await collect(runClaudeChat(baseInput, { scheduler, streamFn: fn } as RunChatDeps));
    assert.equal(calls.length, 1);
    const pd = calls[0].proxyDeps as Record<string, unknown>;
    assert.ok(pd, "proxyDeps must exist");
    assert.equal(
      "dispatcher" in pd,
      false,
      "无代理时不应给 fetchInit 注入 dispatcher 字段(避免被 undici 误解为 'cancel default')",
    );
  });

  test("egress_proxy=有值 → streamFn 收到 dispatcher 实例(undici ProxyAgent)", async () => {
    const { scheduler } = mkScheduler({
      pickResult: {
        account_id: 8n,
        plan: "pro",
        token: Buffer.from("tok-proxy", "utf8"),
        refresh: null,
        expires_at: new Date(Date.now() + 3600_000),
        egress_proxy: "http://u:p@127.0.0.1:1",
      },
    });
    const { fn, calls } = mkStreamFn([
      evMessageStart(1),
      evMessageDelta(1),
      evMessageStop(),
    ]);
    await collect(runClaudeChat(baseInput, { scheduler, streamFn: fn } as RunChatDeps));
    assert.equal(calls.length, 1);
    const pd = calls[0].proxyDeps as Record<string, unknown>;
    assert.ok(pd && pd.dispatcher, "有代理时 proxyDeps.dispatcher 必须被注入");
    // 只检 dispatcher 是个对象。ProxyAgent.close 在 Node 上是 DispatcherBase 继承,
    // 但 Bun 内置 undici 替换没暴露,所以测试不强检方法名,避免 runtime 耦合。
    // finally 里 closeDispatcher 已用 try/catch 包裹了,真没有 .close 也只 warn。
    assert.equal(typeof pd.dispatcher, "object");
  });

  test("有 dispatcher + 正常完成路径不会 hang(整个测试在 timeout 内 resolve)", async () => {
    const { scheduler } = mkScheduler({
      pickResult: {
        account_id: 9n,
        plan: "pro",
        token: Buffer.from("tok-happy", "utf8"),
        refresh: null,
        expires_at: new Date(Date.now() + 3600_000),
        egress_proxy: "http://127.0.0.1:1",
      },
    });
    const { fn } = mkStreamFn([evMessageStart(1), evMessageDelta(1), evMessageStop()]);
    const events = await collect(runClaudeChat(baseInput, { scheduler, streamFn: fn } as RunChatDeps));
    assert.equal(events[events.length - 1].type, "done");
  });
});
