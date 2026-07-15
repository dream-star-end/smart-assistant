/**
 * V3 commercial container → master /internal/v3/wechat-outbound adapter unit tests.
 *
 * Slice 7c lock-in invariants (Codex plan v3 PASS):
 *   1. every valid message/billing payload is fsync-staged before first POST
 *   2. only the durable queue owns send/retry/ACK deletion
 *   3. no request-body semantic size cap
 *   4. invalid routing payloads throw instead of silently dropping
 *   6. peer.displayName 正确 → wire body.peer.meta.senderId 出现该值
 *   7. shutdown() 后 send() 仍可调,attempt 失败仍可 enqueueDurable
 *   8. readV3WechatOutboundConfig:两 env 都缺 → null;尾斜杠 strip
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/v3WechatOutbound.test.ts
 */
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { OutboundMessage } from "@openclaude/protocol"

import {
  attemptSend,
  makeV3WechatOutboundAdapter,
  readV3WechatOutboundConfig,
  WECHAT_OUTBOUND_PATH,
  type V3WechatOutboundConfig,
} from "../v3WechatOutbound.js"
import {
  V3WechatSinkError,
  type V3WechatRetryEntry,
  type V3WechatRetryQueue,
  type V3WechatSinkWirePayload,
} from "../v3WechatRetryQueue.js"

// ─── fixtures ───────────────────────────────────────────────────────────

const CFG: V3WechatOutboundConfig = {
  baseUrl: "http://master.test:18791",
  bearer: "oc-v3.7." + "a".repeat(64),
  agentId: "main",
}

const SESSION_ID = "wsess-0123456789abcdef"
const SENDER_ID = "wx-sender-abc"

function makeOut(over: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    type: "outbound.message",
    sessionKey: "wechat:777:wx-sender-abc",
    channel: "wechat",
    peer: { id: SESSION_ID, kind: "dm", displayName: SENDER_ID },
    blocks: [{ kind: "text", text: "hello", partial: false } as any],
    isFinal: true,
    ...over,
  }
}

function makeFakeFetcher(opts: {
  status?: number
  body?: string
  throwError?: Error
  captureBody?: (b: string) => void
}): typeof import("undici").request {
  const fn = async (_url: any, init: any) => {
    if (opts.throwError) throw opts.throwError
    if (opts.captureBody && typeof init?.body === "string") opts.captureBody(init.body)
    const text = opts.body ?? ""
    const buf = Buffer.from(text, "utf8")
    return {
      statusCode: opts.status ?? 200,
      headers: {},
      trailers: {},
      opaque: undefined,
      context: {},
      body: {
        async *[Symbol.asyncIterator]() {
          yield buf
        },
        text: async () => text,
      } as any,
    }
  }
  return fn as unknown as typeof import("undici").request
}

type FakeQueue = V3WechatRetryQueue & {
  enqueued: V3WechatRetryEntry[]
  periodicStarted: boolean
  periodicStopped: boolean
  kicked: number
}

function fakeQueue(): FakeQueue {
  const q: FakeQueue = {
    enqueued: [],
    periodicStarted: false,
    periodicStopped: false,
    kicked: 0,
    async enqueueDurable(entry) {
      q.enqueued.push(entry)
    },
    async drainOnce() {
      return {
        considered: 0,
        drained: 0,
        retried: 0,
        ttlDropped: 0,
        fatalDropped: 0,
        errors: 0,
        pending: 0,
      }
    },
    kick() {
      q.kicked++
    },
    startPeriodic() {
      q.periodicStarted = true
    },
    stopPeriodic() {
      q.periodicStopped = true
    },
    async pendingCount() {
      return q.enqueued.length
    },
  }
  return q
}

function messagePayload(entry: V3WechatRetryEntry): V3WechatSinkWirePayload {
  assert.notEqual((entry.payload as { type?: unknown }).type, "outbound.codex_billing")
  return entry.payload as V3WechatSinkWirePayload
}

function makeCtx(): import("@openclaude/plugin-sdk").ChannelContext {
  return {
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as any,
    dispatch: () => {},
    resetSession: async () => {},
  } as any
}

// ─── readV3WechatOutboundConfig ─────────────────────────────────────────

describe("readV3WechatOutboundConfig", () => {
  test("returns null when both env missing", () => {
    assert.equal(readV3WechatOutboundConfig({}), null)
  })

  test("returns null when only one env present", () => {
    assert.equal(
      readV3WechatOutboundConfig({ OPENCLAUDE_V3_MASTER_BASE_URL: "http://x" }),
      null,
    )
    assert.equal(
      readV3WechatOutboundConfig({ OPENCLAUDE_V3_CONTAINER_TOKEN: "tok" }),
      null,
    )
  })

  test("returns config and strips trailing slashes", () => {
    const cfg = readV3WechatOutboundConfig({
      OPENCLAUDE_V3_MASTER_BASE_URL: "http://m.test:18791///",
      OPENCLAUDE_V3_CONTAINER_TOKEN: "tok",
    })
    assert.deepEqual(cfg, { baseUrl: "http://m.test:18791", bearer: "tok" })
  })

  test("includes agentId when env matches charset", () => {
    const cfg = readV3WechatOutboundConfig({
      OPENCLAUDE_V3_MASTER_BASE_URL: "http://x",
      OPENCLAUDE_V3_CONTAINER_TOKEN: "tok",
      OPENCLAUDE_AGENT_ID: "main",
    })
    assert.equal(cfg?.agentId, "main")
  })

  test("omits agentId when env fails charset", () => {
    const cfg = readV3WechatOutboundConfig({
      OPENCLAUDE_V3_MASTER_BASE_URL: "http://x",
      OPENCLAUDE_V3_CONTAINER_TOKEN: "tok",
      OPENCLAUDE_AGENT_ID: "bad agent id with space",
    })
    assert.equal(cfg?.agentId, undefined)
  })
})

// ─── attemptSend classification ─────────────────────────────────────────

describe("attemptSend — 2xx success", () => {
  const PAYLOAD: V3WechatSinkWirePayload = {
    sessionId: SESSION_ID,
    channel: "wechat",
    outboundId: "out12345",
    peer: { kind: "dm", meta: { senderId: SENDER_ID } },
    blocks: [{ kind: "text", text: "hi" }],
    createdAt: 1_700_000_000_000,
  }

  test("200 → resolves void (empty_render / dedup terminal)", async () => {
    await assert.doesNotReject(() =>
      attemptSend(PAYLOAD, {
        config: CFG,
        fetcher: makeFakeFetcher({
          status: 200,
          body: '{"ok":true,"outcome":"empty_render","scheduled":false}',
        }),
      }),
    )
  })

  test("202 → resolves void (queued / pending / sending)", async () => {
    // 202 是 broker enqueue 成功的合法响应,body shape 与 200 不同(scheduled:true),
    // success 判定必须先于 body shape 判定 — 否则会回退到 throw。
    await assert.doesNotReject(() =>
      attemptSend(PAYLOAD, {
        config: CFG,
        fetcher: makeFakeFetcher({
          status: 202,
          body: '{"ok":true,"outcome":"queued","scheduled":true,"outboxId":42}',
        }),
      }),
    )
  })

  test("299 (edge of 2xx) → resolves void", async () => {
    await assert.doesNotReject(() =>
      attemptSend(PAYLOAD, {
        config: CFG,
        fetcher: makeFakeFetcher({ status: 299, body: "" }),
      }),
    )
  })

  test("POSTs to correct path", async () => {
    let capturedUrl = ""
    const fetcher = (async (url: any) => {
      capturedUrl = String(url)
      return {
        statusCode: 200,
        headers: {},
        body: {
          async *[Symbol.asyncIterator]() {
            yield Buffer.from("")
          },
        } as any,
      }
    }) as unknown as typeof import("undici").request
    await attemptSend(PAYLOAD, { config: CFG, fetcher })
    assert.equal(capturedUrl, `${CFG.baseUrl}${WECHAT_OUTBOUND_PATH}`)
  })

  test("POSTs payload as JSON body", async () => {
    let captured = ""
    await attemptSend(PAYLOAD, {
      config: CFG,
      fetcher: makeFakeFetcher({ status: 202, captureBody: (b) => { captured = b } }),
    })
    const parsed = JSON.parse(captured)
    assert.equal(parsed.sessionId, SESSION_ID)
    assert.equal(parsed.peer.meta.senderId, SENDER_ID)
    assert.equal(parsed.outboundId, "out12345")
    assert.equal(parsed.channel, "wechat")
  })
})

describe("attemptSend — fatal classification", () => {
  const PAYLOAD: V3WechatSinkWirePayload = {
    sessionId: SESSION_ID,
    channel: "wechat",
    outboundId: "out12345",
    peer: { kind: "dm", meta: { senderId: SENDER_ID } },
    blocks: [{ kind: "text", text: "hi" }],
    createdAt: 1_700_000_000_000,
  }

  for (const status of [401, 403, 404, 410, 400, 405, 413, 415, 422]) {
    test(`${status} → V3WechatSinkError(fatal, httpStatus=${status})`, async () => {
      await assert.rejects(
        () =>
          attemptSend(PAYLOAD, {
            config: CFG,
            fetcher: makeFakeFetcher({ status, body: `{"error":"${status}"}` }),
          }),
        (err: unknown) => {
          assert.ok(err instanceof V3WechatSinkError, `expected V3WechatSinkError, got ${err}`)
          assert.equal(err.errorClass, "fatal")
          assert.equal(err.httpStatus, status)
          return true
        },
      )
    })
  }
})

describe("attemptSend — transient classification", () => {
  const PAYLOAD: V3WechatSinkWirePayload = {
    sessionId: SESSION_ID,
    channel: "wechat",
    outboundId: "out12345",
    peer: { kind: "dm", meta: { senderId: SENDER_ID } },
    blocks: [{ kind: "text", text: "hi" }],
    createdAt: 1_700_000_000_000,
  }

  for (const status of [429, 500, 502, 503, 504]) {
    test(`${status} → V3WechatSinkError(transient, httpStatus=${status})`, async () => {
      await assert.rejects(
        () =>
          attemptSend(PAYLOAD, {
            config: CFG,
            fetcher: makeFakeFetcher({ status, body: "" }),
          }),
        (err: unknown) => {
          assert.ok(err instanceof V3WechatSinkError)
          assert.equal(err.errorClass, "transient")
          assert.equal(err.httpStatus, status)
          return true
        },
      )
    })
  }

  test("network error → V3WechatSinkError(transient)", async () => {
    await assert.rejects(
      () =>
        attemptSend(PAYLOAD, {
          config: CFG,
          fetcher: makeFakeFetcher({ throwError: new Error("ECONNRESET") }),
        }),
      (err: unknown) => {
        assert.ok(err instanceof V3WechatSinkError)
        assert.equal(err.errorClass, "transient")
        assert.match(err.message, /network error/)
        return true
      },
    )
  })

  test("AbortError (timeout) → V3WechatSinkError(transient)", async () => {
    const abortErr = new Error("aborted")
    abortErr.name = "AbortError"
    await assert.rejects(
      () =>
        attemptSend(PAYLOAD, {
          config: CFG,
          fetcher: makeFakeFetcher({ throwError: abortErr }),
        }),
      (err: unknown) => {
        assert.ok(err instanceof V3WechatSinkError)
        assert.equal(err.errorClass, "transient")
        return true
      },
    )
  })
})

describe("attemptSend — uncapped request body", () => {
  test("payload > former 64 KB cap is posted byte-exactly", async () => {
    const PAYLOAD: V3WechatSinkWirePayload = {
      sessionId: SESSION_ID,
      channel: "wechat",
      outboundId: "out12345",
      peer: { kind: "dm", meta: { senderId: SENDER_ID } },
      blocks: [{ kind: "text", text: "x".repeat(80 * 1024) }],
      createdAt: 1_700_000_000_000,
    }
    let postedBody = ""
    const fetcher = (async (_url: unknown, init: { body?: string }) => {
      postedBody = init.body ?? ""
      return { statusCode: 200, headers: {}, body: { async *[Symbol.asyncIterator]() {} } as any }
    }) as unknown as typeof import("undici").request
    await attemptSend(PAYLOAD, { config: CFG, fetcher })
    assert.deepEqual(JSON.parse(postedBody), PAYLOAD)
  })
})

// ─── adapter.send orchestration ─────────────────────────────────────────

describe("makeV3WechatOutboundAdapter — send orchestration", () => {
  test("codex billing frame is durably staged before delivery", async () => {
    const q = fakeQueue()
    const adapter = makeV3WechatOutboundAdapter({
      config: CFG,
      retryQueue: q,
    })
    await adapter.init!(makeCtx())
    await adapter.send!({
      type: "outbound.codex_billing",
      channel: "wechat",
      requestId: "0123456789abcdef0123456789abcdef",
      turnKey: "ab".repeat(32),
      parentTurnKey: "cd".repeat(32),
      parentSessionId: "web-parent-1",
      delegateAgentId: "researcher",
      engineSessionId: `oceng-${"ef".repeat(24)}`,
      status: "success",
      durationMs: 321,
      usage: { input_tokens: 10, output_tokens: 20 },
      rateLimits: { util5h: 0.1, reset5h: "2026-06-01T00:00:00Z" },
      traceId: "trc-codex-billing",
    } as unknown as OutboundMessage)
    assert.equal(q.enqueued.length, 1)
    assert.equal(q.enqueued[0]!.attempts, 0)
    assert.deepEqual(q.enqueued[0]!.payload, {
      type: "outbound.codex_billing",
      requestId: "0123456789abcdef0123456789abcdef",
      turnKey: "ab".repeat(32),
      parentTurnKey: "cd".repeat(32),
      parentSessionId: "web-parent-1",
      delegateAgentId: "researcher",
      engineSessionId: `oceng-${"ef".repeat(24)}`,
      status: "success",
      durationMs: 321,
      usage: { input_tokens: 10, output_tokens: 20 },
      rateLimits: { util5h: 0.1, reset5h: "2026-06-01T00:00:00Z" },
      traceId: "trc-codex-billing",
    })
  })

  test("rolling raw billing reason is converted before durable staging", async () => {
    const q = fakeQueue()
    const adapter = makeV3WechatOutboundAdapter({ config: CFG, retryQueue: q })
    await adapter.init!(makeCtx())
    await adapter.send!({
      type: "outbound.codex_billing",
      channel: "wechat",
      requestId: "0123456789abcdef0123456789abcdef",
      status: "error",
      durationMs: 9,
      errorReason: "DO_NOT_STAGE provider secret",
    } as unknown as OutboundMessage)
    assert.equal(q.enqueued.length, 1)
    assert.equal((q.enqueued[0]!.payload as { terminalCode?: string }).terminalCode, "CODEX_ERROR")
    assert.equal(Object.prototype.hasOwnProperty.call(q.enqueued[0]!.payload, "errorReason"), false)
    assert.equal(JSON.stringify(q.enqueued[0]!.payload).includes("DO_NOT_STAGE"), false)
  })

  test("webchat codex billing frame is accepted when sent through v3 WeChat adapter", async () => {
    const q = fakeQueue()
    const adapter = makeV3WechatOutboundAdapter({
      config: CFG,
      retryQueue: q,
    })
    await adapter.init!(makeCtx())
    await adapter.send!({
      type: "outbound.codex_billing",
      channel: "webchat",
      requestId: "0123456789abcdef0123456789abcdef",
      status: "success",
      durationMs: 321,
    } as unknown as OutboundMessage)
    assert.equal(q.enqueued.length, 1)
    assert.equal((q.enqueued[0]!.payload as { type?: string }).type, "outbound.codex_billing")
  })

  test("invalid codex billing requestId throws instead of silently dropping", async () => {
    const q = fakeQueue()
    let attempted = false
    const adapter = makeV3WechatOutboundAdapter({
      config: CFG,
      retryQueue: q,
      attemptSendImpl: async () => {
        attempted = true
      },
    })
    await adapter.init!(makeCtx())
    await assert.rejects(() => adapter.send!({
        type: "outbound.codex_billing",
        channel: "wechat",
        requestId: "BAD",
        status: "success",
        durationMs: 1,
      } as unknown as OutboundMessage), /cannot durably stage codex billing frame/)
    assert.equal(attempted, false)
    assert.equal(q.enqueued.length, 0)
  })

  test("codex billing entry starts at attempts=0 before any delivery", async () => {
    const q = fakeQueue()
    const adapter = makeV3WechatOutboundAdapter({
      config: CFG,
      retryQueue: q,
      attemptSendImpl: async () => {
        throw new V3WechatSinkError("master 503", "transient", 503)
      },
      now: () => 1_700_000_000_000,
    })
    await adapter.init!(makeCtx())
    await adapter.send!({
      type: "outbound.codex_billing",
      channel: "wechat",
      requestId: "0123456789abcdef0123456789abcdef",
      status: "success",
      durationMs: 321,
      usage: { input_tokens: 10, output_tokens: 20 },
    } as unknown as OutboundMessage)
    assert.equal(q.enqueued.length, 1)
    const entry = q.enqueued[0]!
    assert.equal(entry.schemaVersion, 1)
    assert.equal(entry.attempts, 0)
    assert.equal(entry.lastErrorClass, undefined)
    assert.deepEqual(entry.payload, {
      type: "outbound.codex_billing",
      requestId: "0123456789abcdef0123456789abcdef",
      status: "success",
      durationMs: 321,
      usage: { input_tokens: 10, output_tokens: 20 },
    })
  })

  test("even an immediately healthy master receives only after durable stage", async () => {
    const q = fakeQueue()
    const adapter = makeV3WechatOutboundAdapter({
      config: CFG,
      retryQueue: q,
      attemptSendImpl: async () => {},
    })
    await adapter.init!(makeCtx())
    await adapter.send!(makeOut())
    assert.equal(q.enqueued.length, 1)
    assert.equal(q.enqueued[0]!.attempts, 0)
  })

  test("non-final output is staged regardless of future fatal classification", async () => {
    const q = fakeQueue()
    const adapter = makeV3WechatOutboundAdapter({
      config: CFG,
      retryQueue: q,
      attemptSendImpl: async () => {
        throw new V3WechatSinkError("master rejected 400", "fatal", 400)
      },
    })
    await adapter.init!(makeCtx())
    await adapter.send!(makeOut({ isFinal: false }))
    assert.equal(q.enqueued.length, 1)
    assert.equal(messagePayload(q.enqueued[0]!).isFinal, undefined)
  })

  test("final output is staged with terminal marker and no pre-attempt error mutation", async () => {
    const q = fakeQueue()
    const adapter = makeV3WechatOutboundAdapter({
      config: CFG,
      retryQueue: q,
      attemptSendImpl: async () => {
        throw new V3WechatSinkError("master rejected final 401", "fatal", 401)
      },
      now: () => 1_700_000_000_000,
    })
    await adapter.init!(makeCtx())
    await adapter.send!(makeOut({ isFinal: true }))
    assert.equal(q.enqueued.length, 1)
    assert.equal(q.enqueued[0]!.attempts, 0)
    assert.equal(q.enqueued[0]!.lastErrorClass, undefined)
    assert.equal(messagePayload(q.enqueued[0]!).isFinal, true)
  })

  test("message payload is fully staged before transient delivery can occur", async () => {
    const q = fakeQueue()
    const adapter = makeV3WechatOutboundAdapter({
      config: CFG,
      retryQueue: q,
      attemptSendImpl: async () => {
        throw new V3WechatSinkError("master 503", "transient", 503)
      },
      now: () => 1_700_000_000_000,
    })
    await adapter.init!(makeCtx())
    await adapter.send!(makeOut())
    assert.equal(q.enqueued.length, 1)
    const entry = q.enqueued[0]!
    assert.equal(entry.schemaVersion, 1)
    assert.equal(entry.attempts, 0)
    assert.equal(entry.lastErrorClass, undefined)
    const payload = messagePayload(entry)
    assert.equal(payload.sessionId, SESSION_ID)
    assert.equal(payload.peer.meta.senderId, SENDER_ID)
    assert.equal(payload.channel, "wechat")
    assert.equal(payload.agentId, "main")
  })

  test("delivery implementation cannot run before injected durable queue accepts", async () => {
    const q = fakeQueue()
    const adapter = makeV3WechatOutboundAdapter({
      config: CFG,
      retryQueue: q,
      attemptSendImpl: async () => {
        throw new Error("unexpected")
      },
    })
    await adapter.init!(makeCtx())
    await adapter.send!(makeOut())
    assert.equal(q.enqueued.length, 1)
    assert.equal(q.enqueued[0]!.attempts, 0)
  })

  test("peer.id 不是 wsess- → reject, never silently drop", async () => {
    const q = fakeQueue()
    let attempted = false
    const adapter = makeV3WechatOutboundAdapter({
      config: CFG,
      retryQueue: q,
      attemptSendImpl: async () => {
        attempted = true
      },
    })
    await adapter.init!(makeCtx())
    await assert.rejects(() => adapter.send!(
        makeOut({ peer: { id: "personal-sess-xyz", kind: "dm", displayName: SENDER_ID } }),
      ), /cannot durably stage WeChat output/)
    assert.equal(attempted, false, "non-wsess- must short-circuit before POST")
    assert.equal(q.enqueued.length, 0)
  })

  test("peer.displayName 缺失 → reject (senderId carrier broken)", async () => {
    const q = fakeQueue()
    let attempted = false
    const adapter = makeV3WechatOutboundAdapter({
      config: CFG,
      retryQueue: q,
      attemptSendImpl: async () => {
        attempted = true
      },
    })
    await adapter.init!(makeCtx())
    await assert.rejects(
      () => adapter.send!(makeOut({ peer: { id: SESSION_ID, kind: "dm" } })),
      /cannot durably stage WeChat output/,
    )
    assert.equal(attempted, false)
    assert.equal(q.enqueued.length, 0)
  })

  test("peer.displayName 非 senderId 字符集 → reject", async () => {
    const q = fakeQueue()
    let attempted = false
    const adapter = makeV3WechatOutboundAdapter({
      config: CFG,
      retryQueue: q,
      attemptSendImpl: async () => {
        attempted = true
      },
    })
    await adapter.init!(makeCtx())
    await assert.rejects(() => adapter.send!(
        makeOut({ peer: { id: SESSION_ID, kind: "dm", displayName: "has spaces!" } }),
      ), /cannot durably stage WeChat output/)
    assert.equal(attempted, false)
    assert.equal(q.enqueued.length, 0)
  })

  test("blocks 空数组 → reject", async () => {
    const q = fakeQueue()
    let attempted = false
    const adapter = makeV3WechatOutboundAdapter({
      config: CFG,
      retryQueue: q,
      attemptSendImpl: async () => {
        attempted = true
      },
    })
    await adapter.init!(makeCtx())
    await assert.rejects(
      () => adapter.send!(makeOut({ blocks: [] })),
      /cannot durably stage WeChat output/,
    )
    assert.equal(attempted, false)
    assert.equal(q.enqueued.length, 0)
  })

  test("out.channel !== 'wechat' → no-op (adapter doesn't claim non-wechat frames)", async () => {
    const q = fakeQueue()
    let attempted = false
    const adapter = makeV3WechatOutboundAdapter({
      config: CFG,
      retryQueue: q,
      attemptSendImpl: async () => {
        attempted = true
      },
    })
    await adapter.init!(makeCtx())
    await adapter.send!(makeOut({ channel: "telegram" }))
    assert.equal(attempted, false)
    assert.equal(q.enqueued.length, 0)
  })

  test("init kicks queue + starts periodic drain", async () => {
    const q = fakeQueue()
    const adapter = makeV3WechatOutboundAdapter({ config: CFG, retryQueue: q })
    await adapter.init!(makeCtx())
    assert.equal(q.periodicStarted, true)
    assert.ok(q.kicked >= 1)
  })

  test("shutdown stops periodic but keeps enqueue path functional (late frame)", async () => {
    // ★ Codex slice 7c plan v3 reminder #2 — 关键不变量
    const q = fakeQueue()
    const adapter = makeV3WechatOutboundAdapter({
      config: CFG,
      retryQueue: q,
      attemptSendImpl: async () => {
        throw new V3WechatSinkError("master 503", "transient", 503)
      },
    })
    await adapter.init!(makeCtx())
    await adapter.shutdown!()
    assert.equal(q.periodicStopped, true, "periodic drain must stop")
    // shutdown 后还能 send,失败仍走 enqueueDurable
    await adapter.send!(makeOut())
    assert.equal(q.enqueued.length, 1, "late frame must still enqueue (no silent loss on SIGTERM)")
  })
})

describe("makeV3WechatOutboundAdapter — wire payload assembly", () => {
  test("traceId present + valid → outboundId = traceId", async () => {
    const q = fakeQueue()
    const adapter = makeV3WechatOutboundAdapter({
      config: CFG,
      retryQueue: q,
      attemptSendImpl: async () => {
        throw new V3WechatSinkError("503", "transient", 503)
      },
    })
    await adapter.init!(makeCtx())
    await adapter.send!(makeOut({ traceId: "trace_abc123def4567890" }))
    assert.equal(messagePayload(q.enqueued[0]!).outboundId, "trace_abc123def4567890")
  })

  test("explicit outboundId overrides traceId and preserves traceId in payload", async () => {
    const q = fakeQueue()
    const adapter = makeV3WechatOutboundAdapter({
      config: CFG,
      retryQueue: q,
      attemptSendImpl: async () => {
        throw new V3WechatSinkError("503", "transient", 503)
      },
    })
    await adapter.init!(makeCtx())
    await adapter.send!(makeOut({
      traceId: "trace_abc123def4567890",
      outboundId: "trace_abc123def4567890.wxlive.1.final",
    } as any))
    const payload = messagePayload(q.enqueued[0]!)
    assert.equal(payload.outboundId, "trace_abc123def4567890.wxlive.1.final")
    assert.equal(payload.traceId, "trace_abc123def4567890")
  })

  test("traceId absent → outboundId derived from sessionId + ts + rand", async () => {
    const q = fakeQueue()
    const adapter = makeV3WechatOutboundAdapter({
      config: CFG,
      retryQueue: q,
      attemptSendImpl: async () => {
        throw new V3WechatSinkError("503", "transient", 503)
      },
      now: () => 1_700_000_000_000,
    })
    await adapter.init!(makeCtx())
    await adapter.send!(makeOut())
    const oid = messagePayload(q.enqueued[0]!).outboundId
    assert.ok(oid.startsWith(`${SESSION_ID}.1700000000000.`), `derived outboundId shape: ${oid}`)
    assert.ok(/^[A-Za-z0-9._:-]{8,128}$/.test(oid))
  })

  test("agentId omitted when config.agentId undefined", async () => {
    const q = fakeQueue()
    const adapter = makeV3WechatOutboundAdapter({
      config: { baseUrl: CFG.baseUrl, bearer: CFG.bearer }, // no agentId
      retryQueue: q,
      attemptSendImpl: async () => {
        throw new V3WechatSinkError("503", "transient", 503)
      },
    })
    await adapter.init!(makeCtx())
    await adapter.send!(makeOut())
    assert.equal("agentId" in q.enqueued[0]!.payload, false)
  })

  test("final frames carry isFinal marker to master", async () => {
    const q = fakeQueue()
    const adapter = makeV3WechatOutboundAdapter({
      config: CFG,
      retryQueue: q,
      attemptSendImpl: async () => {
        throw new V3WechatSinkError("503", "transient", 503)
      },
    })
    await adapter.init!(makeCtx())
    await adapter.send!(makeOut({ isFinal: true }))
    assert.equal(messagePayload(q.enqueued[0]!).isFinal, true)
  })

  test("webchat message frames are mirrored to WeChat wire channel", async () => {
    const q = fakeQueue()
    const adapter = makeV3WechatOutboundAdapter({
      config: CFG,
      retryQueue: q,
      attemptSendImpl: async () => {
        throw new V3WechatSinkError("503", "transient", 503)
      },
    })
    await adapter.init!(makeCtx())
    await adapter.send!(makeOut({ channel: "webchat" as any }))
    const payload = messagePayload(q.enqueued[0]!)
    assert.equal(payload.channel, "wechat")
    assert.equal(payload.sessionId, SESSION_ID)
    assert.equal(payload.peer.meta.senderId, SENDER_ID)
  })
})
