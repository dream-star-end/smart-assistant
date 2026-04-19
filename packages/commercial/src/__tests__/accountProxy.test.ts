/**
 * T-33 单元:proxy.streamClaude 的 SSE 解析 + HTTP 错误映射。
 *
 * 不碰 DB / 加密;用 mock fetch 构造 Response + ReadableStream。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  streamClaude,
  ProxyError,
  ProxyAuthError,
  DEFAULT_CLAUDE_ENDPOINT,
  DEFAULT_ANTHROPIC_VERSION,
} from "../account-pool/proxy.js";

/** 构造一个返回预置 SSE 流的 mock fetch。 */
function mockFetch(opts: {
  status?: number;
  chunks?: string[];
  headers?: Record<string, string>;
  body?: string; // 仅用于非 2xx 时
  onRequest?: (url: string, init: RequestInit) => void;
}): typeof fetch {
  return async (url: string | URL | Request, init?: RequestInit) => {
    opts.onRequest?.(String(url), init ?? {});
    const status = opts.status ?? 200;
    if (status < 200 || status >= 300) {
      return new Response(opts.body ?? "", { status });
    }
    const chunks = opts.chunks ?? [];
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl): void {
        const enc = new TextEncoder();
        for (const c of chunks) ctrl.enqueue(enc.encode(c));
        ctrl.close();
      },
    });
    return new Response(stream, {
      status,
      headers: opts.headers ?? { "Content-Type": "text/event-stream" },
    });
  };
}

function tokenBuf(s: string): Buffer {
  return Buffer.from(s, "utf8");
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

describe("streamClaude — 正常流", () => {
  test("单个事件 message_start", async () => {
    const f = mockFetch({
      chunks: [
        'event: message_start\ndata: {"type":"message_start"}\n\n',
        "data: [DONE]\n\n",
      ],
    });
    const events = await collect(
      streamClaude({ account: { token: tokenBuf("tk") }, body: { model: "m" } }, { fetch: f }),
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "message_start");
    assert.deepEqual(events[0].data, { type: "message_start" });
    assert.equal(events[0].raw, '{"type":"message_start"}');
  });

  test("多事件 + 跨 chunk 拼接", async () => {
    // 第一个 chunk 只含半个事件;第二个 chunk 补完 + 再追加一条
    const f = mockFetch({
      chunks: [
        "event: message_start\ndata: {\"type\":\"mes",
        "sage_start\"}\n\nevent: content_block_delta\ndata: {\"d\":1}\n\n",
        "data: [DONE]\n\n",
      ],
    });
    const events = await collect(
      streamClaude({ account: { token: tokenBuf("tk") }, body: {} }, { fetch: f }),
    );
    assert.equal(events.length, 2);
    assert.equal(events[0].event, "message_start");
    assert.deepEqual(events[0].data, { type: "message_start" });
    assert.equal(events[1].event, "content_block_delta");
    assert.deepEqual(events[1].data, { d: 1 });
  });

  test("SSE 注释行(以 : 开头)被忽略", async () => {
    const f = mockFetch({
      chunks: [
        ": ping keep-alive\n\n",
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        "data: [DONE]\n\n",
      ],
    });
    const events = await collect(
      streamClaude({ account: { token: tokenBuf("tk") }, body: {} }, { fetch: f }),
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "message_stop");
  });

  test("CRLF 分隔(\\r\\n\\r\\n)可解析", async () => {
    const f = mockFetch({
      chunks: [
        'event: msg\r\ndata: {"a":1}\r\n\r\n',
        "data: [DONE]\r\n\r\n",
      ],
    });
    const events = await collect(
      streamClaude({ account: { token: tokenBuf("tk") }, body: {} }, { fetch: f }),
    );
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].data, { a: 1 });
  });

  test("data 不是 JSON → 原样放在 data + raw", async () => {
    const f = mockFetch({
      chunks: ["data: hello world\n\n", "data: [DONE]\n\n"],
    });
    const events = await collect(
      streamClaude({ account: { token: tokenBuf("tk") }, body: {} }, { fetch: f }),
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "message");
    assert.equal(events[0].data, "hello world");
    assert.equal(events[0].raw, "hello world");
  });

  test("见到 [DONE] 立即停止(之后的 chunk 不 yield)", async () => {
    const f = mockFetch({
      chunks: [
        'event: msg\ndata: {"a":1}\n\n',
        "data: [DONE]\n\n",
        // 下面这条虽发了但不应 yield
        'event: after\ndata: {"b":2}\n\n',
      ],
    });
    const events = await collect(
      streamClaude({ account: { token: tokenBuf("tk") }, body: {} }, { fetch: f }),
    );
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].data, { a: 1 });
  });

  test("流结束时遗留未以空行收尾的事件仍解析", async () => {
    const f = mockFetch({
      chunks: ['event: trailing\ndata: {"t":1}'],
    });
    const events = await collect(
      streamClaude({ account: { token: tokenBuf("tk") }, body: {} }, { fetch: f }),
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "trailing");
    assert.deepEqual(events[0].data, { t: 1 });
  });
});

describe("streamClaude — HTTP 错误", () => {
  test("401 → ProxyAuthError(保留 bodyPreview)", async () => {
    const f = mockFetch({ status: 401, body: "invalid token" });
    const iter = streamClaude(
      { account: { token: tokenBuf("bad") }, body: {} },
      { fetch: f },
    );
    await assert.rejects(collect(iter), (err: unknown) => {
      assert.ok(err instanceof ProxyAuthError);
      assert.equal((err as ProxyAuthError).status, 401);
      assert.match((err as ProxyAuthError).bodyPreview, /invalid token/);
      return true;
    });
  });

  test("500 → ProxyError(非 ProxyAuthError)", async () => {
    const f = mockFetch({ status: 500, body: "upstream broke" });
    await assert.rejects(
      collect(
        streamClaude({ account: { token: tokenBuf("t") }, body: {} }, { fetch: f }),
      ),
      (err: unknown) => {
        assert.ok(err instanceof ProxyError);
        assert.ok(!(err instanceof ProxyAuthError));
        assert.equal((err as ProxyError).status, 500);
        return true;
      },
    );
  });

  test("403 → 普通 ProxyError(不视为可 refresh 的 auth 错)", async () => {
    const f = mockFetch({ status: 403, body: "forbidden" });
    await assert.rejects(
      collect(
        streamClaude({ account: { token: tokenBuf("t") }, body: {} }, { fetch: f }),
      ),
      (err: unknown) =>
        err instanceof ProxyError && !(err instanceof ProxyAuthError),
    );
  });
});

describe("streamClaude — 请求构造", () => {
  test("强制 stream=true,透传 body 其他字段", async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const f = mockFetch({
      chunks: ["data: [DONE]\n\n"],
      onRequest: (url, init) => {
        captured = { url, init };
      },
    });
    await collect(
      streamClaude(
        {
          account: { token: tokenBuf("abc") },
          body: { model: "claude-sonnet", max_tokens: 100, stream: false },
        },
        { fetch: f },
      ),
    );
    assert.equal(captured.url, DEFAULT_CLAUDE_ENDPOINT);
    const body = JSON.parse(String(captured.init?.body));
    assert.equal(body.stream, true, "stream must be forced to true");
    assert.equal(body.model, "claude-sonnet");
    assert.equal(body.max_tokens, 100);
  });

  test("Authorization: Bearer <token> + anthropic-version header", async () => {
    let captured: RequestInit | undefined;
    const f = mockFetch({
      chunks: ["data: [DONE]\n\n"],
      onRequest: (_u, init) => {
        captured = init;
      },
    });
    await collect(
      streamClaude(
        { account: { token: tokenBuf("MY-TOKEN-42") }, body: {} },
        { fetch: f },
      ),
    );
    const headers = captured?.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer MY-TOKEN-42");
    assert.equal(headers["anthropic-version"], DEFAULT_ANTHROPIC_VERSION);
    assert.equal(headers.Accept, "text/event-stream");
  });

  test("anthropic-beta 传入时出现在 headers 中", async () => {
    let captured: RequestInit | undefined;
    const f = mockFetch({
      chunks: ["data: [DONE]\n\n"],
      onRequest: (_u, init) => {
        captured = init;
      },
    });
    await collect(
      streamClaude(
        { account: { token: tokenBuf("t") }, body: {} },
        { fetch: f, anthropicBeta: "messages-2024-01-01" },
      ),
    );
    const headers = captured?.headers as Record<string, string>;
    assert.equal(headers["anthropic-beta"], "messages-2024-01-01");
  });

  test("endpoint 可覆盖", async () => {
    let captured = "";
    const f = mockFetch({
      chunks: ["data: [DONE]\n\n"],
      onRequest: (u) => {
        captured = u;
      },
    });
    await collect(
      streamClaude(
        { account: { token: tokenBuf("t") }, body: {} },
        { fetch: f, endpoint: "https://test.example/v1/messages" },
      ),
    );
    assert.equal(captured, "https://test.example/v1/messages");
  });
});

/**
 * Codex 8ec407b 复审跟进:验证 finally 真的会 cancel 上游 ReadableStream。
 *
 * 不 cancel 时, ProxyAgent.close() 会等死(socket 还在 keep-alive)。
 * 测法: 自定义 ReadableStream 暴露 cancel 调用计数,模拟"调用方提前 break"
 * (`break` 出 for-await 会触发 generator return → 触发 finally),
 * 然后断言 cancel 至少被调用了一次。
 */
function mockFetchInfinite(opts: {
  onCancel: () => void;
  primer?: string; // 先丢一段已成事件的内容,让 generator 至少 yield 一次
}): typeof fetch {
  return async () => {
    const enc = new TextEncoder();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl): void {
        // 第一次 pull 给出预置完整事件;之后只 enqueue 一些数据,永不 close。
        pulls += 1;
        if (pulls === 1 && opts.primer) {
          ctrl.enqueue(enc.encode(opts.primer));
          return;
        }
        ctrl.enqueue(enc.encode(": keepalive\n"));
      },
      cancel(): void {
        opts.onCancel();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
}

describe("streamClaude — finally 取消上游(Codex 8ec407b 复审跟进)", () => {
  test("调用方提前 break → 触发 reader.cancel() 让上游 socket 不再 keep-alive", async () => {
    let cancelCount = 0;
    const f = mockFetchInfinite({
      onCancel: () => { cancelCount += 1; },
      primer: 'event: message_start\ndata: {"type":"message_start"}\n\n',
    });
    const gen = streamClaude(
      { account: { token: tokenBuf("tk") }, body: { model: "m" } },
      { fetch: f },
    );
    let firstEv: unknown = null;
    for await (const ev of gen) {
      firstEv = ev;
      break; // 模拟调用方拿到第一个事件后立即 break
    }
    // generator return 触发 finally,await 一下让 microtask 跑完
    await Promise.resolve();
    assert.ok(firstEv, "第一个事件应已 yield");
    assert.equal(cancelCount, 1, "finally 必须 cancel 上游 ReadableStream 一次");
  });

  test("正常自然结束(收到 [DONE])→ finally 也 cancel(no-op 不报错)", async () => {
    // [DONE] 路径走 return,也会进 finally,对已 closed 的流 cancel 应是 no-op
    let cancelCount = 0;
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl): void {
        ctrl.enqueue(enc.encode('event: message_start\ndata: {"type":"message_start"}\n\n'));
        ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
        ctrl.close();
      },
      cancel(): void { cancelCount += 1; },
    });
    const f: typeof fetch = async () =>
      new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const events = await collect(
      streamClaude({ account: { token: tokenBuf("tk") }, body: {} }, { fetch: f }),
    );
    await Promise.resolve();
    assert.equal(events.length, 1);
    // 流自然 close 后 cancel 不应被底层调用(spec: cancel on closed stream resolves immediately,
    // 不调 underlying source 的 cancel),所以 cancelCount === 0 是正确预期。
    // 关键是:这个测试**不 hang**,证明 finally 的 cancel 对 closed stream 是安全的。
    assert.equal(cancelCount, 0);
  });
});
