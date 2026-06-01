/**
 * v3 commercial wechat outboundReceiver — HTTP handler 单测。
 *
 * 覆盖:
 *   - method gate(405 non-POST)
 *   - identity gate(401 bad auth / bad host / bad secret)
 *   - body schema(empty / invalid JSON / 缺字段 / 错正则 / 未知 block kind / hard-cap blocks)
 *   - rate-limit gate(429 当 checkOutbound 返 false)
 *   - renderWechatBlocks 纯函数:text/tool_use/tool_result/thinking/tool_output_tail/parentToolUseId
 *   - render → 空 IlinkPart[] → 200 empty_render, **不**调 enqueue
 *   - enqueue 4 种 outcome 翻 HTTP:queued/pending → 202 scheduled:true;already_sent/already_failed → 200 scheduled:false
 *   - enqueue throws → 500 STORAGE_ERROR
 *   - body cap 超 256KB → 413
 *   - trust boundary:bindingUserId 取自 identity 而非 body
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/wechatOutboundReceiver.test.ts
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { Readable } from "node:stream"
import { ServerResponse, IncomingMessage } from "node:http"
import { createHash } from "node:crypto"
import type { Pool } from "pg"

import {
  makeOutboundReceiverHandler,
  renderWechatBlocks,
  WECHAT_OUTBOUND_PATH,
  type WechatCodexBillingBody,
  type OutboundReceiverBody,
  type OutboundReceiverCtx,
  type OutboundReceiverDeps,
} from "../wechat/outboundReceiver.js"
import type { ContainerIdentityRepo } from "../auth/containerIdentity.js"
import type { RateLimiter } from "../wechat/rateLimiter.js"
import type { EnqueueOutcome } from "../wechat/outboxStore.js"

// ─── fixtures ──────────────────────────────────────────────────────────────

const VALID_SECRET = "a".repeat(64)
const VALID_TOKEN = `oc-v3.7.${VALID_SECRET}`
const VALID_HOST = "host-uuid-1"
const VALID_IP = "172.30.0.5"
const VALID_USER_ID = 42
const VALID_SESSION_ID = "wsess-0123456789abcdef"
const CTX: OutboundReceiverCtx = { hostUuid: VALID_HOST, boundIp: VALID_IP }

function makeRepo(
  hostUuid = VALID_HOST,
  boundIp = VALID_IP,
  containerId = 7,
  userId = VALID_USER_ID,
): ContainerIdentityRepo {
  const secretHash = createHash("sha256").update(Buffer.from(VALID_SECRET, "hex")).digest()
  return {
    async findActiveByHostAndBoundIp(h, ip) {
      if (h !== hostUuid || ip !== boundIp) return null
      return { id: containerId, user_id: userId, bound_ip: boundIp, host_uuid: hostUuid, secret_hash: secretHash }
    },
  }
}

function makeReq(opts: { method?: string; body?: string | Buffer; auth?: string; url?: string }): IncomingMessage {
  const body = opts.body ?? ""
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body
  const req = Readable.from(buf.length > 0 ? [buf] : []) as unknown as IncomingMessage
  req.method = opts.method ?? "POST"
  req.url = opts.url ?? WECHAT_OUTBOUND_PATH
  req.headers = {}
  if (opts.auth) req.headers.authorization = opts.auth
  return req
}

interface RecordedRes {
  status?: number
  headers: Record<string, string | number>
  body: string
  ended: boolean
}

function makeRes(): { res: ServerResponse; rec: RecordedRes } {
  const rec: RecordedRes = { headers: {}, body: "", ended: false }
  const res = {
    headersSent: false,
    setHeader(k: string, v: string | number) {
      rec.headers[String(k).toLowerCase()] = v
    },
    writeHead(this: { headersSent: boolean }, status: number, headers: Record<string, string | number>) {
      rec.status = status
      for (const [k, v] of Object.entries(headers)) rec.headers[String(k).toLowerCase()] = v
      this.headersSent = true
    },
    end(chunk?: string) {
      if (chunk !== undefined) rec.body += chunk
      rec.ended = true
    },
  } as unknown as ServerResponse
  return { res, rec }
}

const okRateLimiter: RateLimiter = { checkInbound: () => true, checkOutbound: () => true }
const blockedRateLimiter: RateLimiter = { checkInbound: () => true, checkOutbound: () => false }

interface EnqueueSpy {
  calls: Array<{
    outboundId: string
    bindingUserId: string
    senderId: string
    sessionId: string
    payloadLen: number
    payload: unknown[]
    now: number
  }>
}

/**
 * fake Pool — 拦截 BEGIN/COMMIT/ROLLBACK 走 noop;
 * INSERT ON CONFLICT DO NOTHING RETURNING id 按 `firstInsertReturns` 答复(模拟 enqueue 首插成功 / 冲突);
 * SELECT ... FOR UPDATE 走 `existingRowFn`(冲突路径下读旧行)。
 */
function makeFakePool(opts: {
  /** 行为模式:全 noop 不入队(只用在 method/identity/body 早 reject 测试) */
  mode: "noop"
} | {
  mode: "enqueue_queued"
  outboxId: number
} | {
  mode: "enqueue_pending"
  outboxId: number
  attempts: number
} | {
  mode: "enqueue_already_sent"
  outboxId: number
  attempts: number
} | {
  mode: "enqueue_already_failed"
  outboxId: number
  attempts: number
} | {
  mode: "enqueue_throws"
}): { pool: Pool; spy: EnqueueSpy } {
  const spy: EnqueueSpy = { calls: [] }

  const respond = (sql: string, params: ReadonlyArray<unknown>): { rows: Record<string, unknown>[]; rowCount: number | null } => {
    const trimmed = sql.trim().toUpperCase()
    if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK") {
      return { rows: [], rowCount: 0 }
    }
    if (opts.mode === "noop") {
      throw new Error("makeFakePool(noop): handler should not have reached enqueue")
    }
    if (opts.mode === "enqueue_throws") {
      throw new Error("simulated PG outage")
    }

    if (/INSERT INTO wechat_outbox/.test(sql)) {
      const payload = typeof params[4] === "string" ? (JSON.parse(params[4] as string) as unknown[]) : []
      // record the call before answering
      spy.calls.push({
        outboundId: String(params[0]),
        bindingUserId: String(params[1]),
        senderId: String(params[2]),
        sessionId: String(params[3]),
        payloadLen: payload.length,
        payload,
        now: Number(params[5]),
      })
      if (opts.mode === "enqueue_queued") {
        return { rows: [{ id: opts.outboxId }], rowCount: 1 }
      }
      // 其他 mode 都走 conflict path
      return { rows: [], rowCount: 0 }
    }

    if (/SELECT id, status, attempts FROM wechat_outbox/.test(sql)) {
      if (opts.mode === "enqueue_pending") {
        return { rows: [{ id: opts.outboxId, status: "queued", attempts: opts.attempts }], rowCount: 1 }
      }
      if (opts.mode === "enqueue_already_sent") {
        return { rows: [{ id: opts.outboxId, status: "sent", attempts: opts.attempts }], rowCount: 1 }
      }
      if (opts.mode === "enqueue_already_failed") {
        return { rows: [{ id: opts.outboxId, status: "failed", attempts: opts.attempts }], rowCount: 1 }
      }
    }

    throw new Error(`makeFakePool: unhandled SQL: ${sql.slice(0, 80)}`)
  }

  const fakeClient = {
    query: async (sql: string, params: ReadonlyArray<unknown> = []) => respond(sql, params),
    release: () => {},
  }
  const pool = {
    query: async (sql: string, params: ReadonlyArray<unknown> = []) => respond(sql, params),
    connect: async () => fakeClient,
  } as unknown as Pool
  return { pool, spy }
}

function makeDeps(overrides: Partial<OutboundReceiverDeps> = {}): OutboundReceiverDeps {
  return {
    identityRepo: overrides.identityRepo ?? makeRepo(),
    pool: overrides.pool ?? (makeFakePool({ mode: "noop" }).pool),
    rateLimiter: overrides.rateLimiter ?? okRateLimiter,
    getWechatShowToolCalls: overrides.getWechatShowToolCalls ?? (async () => true),
    now: overrides.now ?? (() => 1_700_000_000_000),
    ...overrides,
  }
}

function validBody(overrides: Partial<OutboundReceiverBody> = {}): OutboundReceiverBody {
  return {
    sessionId: VALID_SESSION_ID,
    agentId: "main",
    channel: "wechat",
    peer: { kind: "dm", meta: { senderId: "wx-sender-1" } },
    blocks: [{ kind: "text", text: "你好" }],
    outboundId: "ob-12345678",
    createdAt: 1_700_000_000_000,
    traceId: "trc-1",
    ...overrides,
  }
}

function authedReq(body: unknown): IncomingMessage {
  return makeReq({
    body: typeof body === "string" ? body : JSON.stringify(body),
    auth: `Bearer ${VALID_TOKEN}`,
  })
}

// ─── method gate ───────────────────────────────────────────────────────────

describe("outboundReceiver — method gate", () => {
  test("405 on GET", async () => {
    const handler = makeOutboundReceiverHandler(makeDeps())
    const { res, rec } = makeRes()
    await handler(makeReq({ method: "GET" }), res, CTX)
    assert.equal(rec.status, 405)
  })

  test("405 on PUT", async () => {
    const handler = makeOutboundReceiverHandler(makeDeps())
    const { res, rec } = makeRes()
    await handler(makeReq({ method: "PUT" }), res, CTX)
    assert.equal(rec.status, 405)
  })
})

// ─── identity gate ─────────────────────────────────────────────────────────

describe("outboundReceiver — identity gate", () => {
  test("401 when bearer missing", async () => {
    const handler = makeOutboundReceiverHandler(makeDeps())
    const { res, rec } = makeRes()
    await handler(makeReq({ body: "{}" }), res, CTX)
    assert.equal(rec.status, 401)
  })

  test("401 when (host,ip) doesn't match repo", async () => {
    const handler = makeOutboundReceiverHandler(makeDeps())
    const { res, rec } = makeRes()
    await handler(makeReq({ body: "{}", auth: `Bearer ${VALID_TOKEN}` }), res, {
      hostUuid: "wrong-host",
      boundIp: "9.9.9.9",
    })
    assert.equal(rec.status, 401)
  })

  test("401 when secret mismatches", async () => {
    const handler = makeOutboundReceiverHandler(makeDeps())
    const { res, rec } = makeRes()
    await handler(makeReq({ body: "{}", auth: `Bearer oc-v3.7.${"b".repeat(64)}` }), res, CTX)
    assert.equal(rec.status, 401)
  })

  test("401 when container_id in token doesn't match row", async () => {
    const handler = makeOutboundReceiverHandler(makeDeps())
    const { res, rec } = makeRes()
    // repo returns containerId=7 but token claims containerId=99
    await handler(
      makeReq({ body: "{}", auth: `Bearer oc-v3.99.${VALID_SECRET}` }),
      res,
      CTX,
    )
    assert.equal(rec.status, 401)
  })
})

// ─── body schema ───────────────────────────────────────────────────────────

describe("outboundReceiver — body schema", () => {
  test("400 on empty body", async () => {
    const handler = makeOutboundReceiverHandler(makeDeps())
    const { res, rec } = makeRes()
    await handler(authedReq(""), res, CTX)
    assert.equal(rec.status, 400)
  })

  test("400 on invalid JSON", async () => {
    const handler = makeOutboundReceiverHandler(makeDeps())
    const { res, rec } = makeRes()
    await handler(authedReq("{not-json"), res, CTX)
    assert.equal(rec.status, 400)
  })

  test("400 on missing sessionId", async () => {
    const handler = makeOutboundReceiverHandler(makeDeps())
    const { res, rec } = makeRes()
    const { sessionId: _, ...rest } = validBody()
    await handler(authedReq(rest), res, CTX)
    assert.equal(rec.status, 400)
  })

  test("400 on bad sessionId regex (not wsess- namespace)", async () => {
    const handler = makeOutboundReceiverHandler(makeDeps())
    const { res, rec } = makeRes()
    await handler(authedReq(validBody({ sessionId: "sess-not-wechat" })), res, CTX)
    assert.equal(rec.status, 400)
  })

  test("400 on bad outboundId charset", async () => {
    const handler = makeOutboundReceiverHandler(makeDeps())
    const { res, rec } = makeRes()
    await handler(authedReq(validBody({ outboundId: "ob 12345678" /* space disallowed */ })), res, CTX)
    assert.equal(rec.status, 400)
  })

  test("400 on outboundId too short", async () => {
    const handler = makeOutboundReceiverHandler(makeDeps())
    const { res, rec } = makeRes()
    await handler(authedReq(validBody({ outboundId: "ob-1" })), res, CTX)
    assert.equal(rec.status, 400)
  })

  test("400 on channel not 'wechat'", async () => {
    const handler = makeOutboundReceiverHandler(makeDeps())
    const { res, rec } = makeRes()
    await handler(
      authedReq(validBody({ channel: "telegram" as unknown as "wechat" })),
      res,
      CTX,
    )
    assert.equal(rec.status, 400)
  })

  test("400 on blocks empty array", async () => {
    const handler = makeOutboundReceiverHandler(makeDeps())
    const { res, rec } = makeRes()
    await handler(authedReq(validBody({ blocks: [] })), res, CTX)
    assert.equal(rec.status, 400)
  })

  test("400 on unknown block kind", async () => {
    const handler = makeOutboundReceiverHandler(makeDeps())
    const { res, rec } = makeRes()
    await handler(
      authedReq(validBody({ blocks: [{ kind: "weird", text: "x" } as unknown as OutboundReceiverBody["blocks"][number]] })),
      res,
      CTX,
    )
    assert.equal(rec.status, 400)
  })

  test("400 on unknown top-level key (strict)", async () => {
    const handler = makeOutboundReceiverHandler(makeDeps())
    const { res, rec } = makeRes()
    const body = { ...validBody(), bindingUserId: "u-malicious" }
    await handler(authedReq(body), res, CTX)
    assert.equal(rec.status, 400)
  })

  test("accepts >64 streamed text chunks and coalesces before enqueue", async () => {
    const { pool, spy } = makeFakePool({ mode: "enqueue_queued", outboxId: 64 })
    const handler = makeOutboundReceiverHandler(makeDeps({ pool }))
    const { res, rec } = makeRes()
    const streamed = Array.from({ length: 80 }, () => ({ kind: "text" as const, text: "x" }))
    await handler(authedReq(validBody({ blocks: streamed })), res, CTX)
    assert.equal(rec.status, 202)
    assert.equal(spy.calls.length, 1)
    assert.deepEqual(spy.calls[0]!.payload, [{ type: "text", text: "x".repeat(80) }])
  })

  test("400 on blocks beyond hard cap", async () => {
    const handler = makeOutboundReceiverHandler(makeDeps())
    const { res, rec } = makeRes()
    const tooMany = Array.from({ length: 4097 }, () => ({ kind: "text" as const, text: "" }))
    await handler(authedReq(validBody({ blocks: tooMany })), res, CTX)
    assert.equal(rec.status, 400)
  })

  test("413 on body > 256KB", async () => {
    const handler = makeOutboundReceiverHandler(makeDeps())
    const { res, rec } = makeRes()
    // 256KB+1 bytes of 'a' wrapped in {"k":"..."}
    const huge = "a".repeat(256 * 1024 + 1)
    await handler(makeReq({ body: huge, auth: `Bearer ${VALID_TOKEN}` }), res, CTX)
    assert.equal(rec.status, 413)
  })
})

// ─── rate-limit gate ───────────────────────────────────────────────────────

describe("outboundReceiver — rate-limit gate", () => {
  test("429 when checkOutbound returns false", async () => {
    const handler = makeOutboundReceiverHandler(makeDeps({ rateLimiter: blockedRateLimiter }))
    const { res, rec } = makeRes()
    await handler(authedReq(validBody()), res, CTX)
    assert.equal(rec.status, 429)
    assert.match(rec.body, /RATE_LIMIT/)
  })
})

// ─── codex billing sideband ────────────────────────────────────────────────

describe("outboundReceiver — codex billing sideband", () => {
  const billingBody: WechatCodexBillingBody = {
    type: "outbound.codex_billing",
    requestId: "0123456789abcdef0123456789abcdef",
    status: "success",
    durationMs: 123,
    usage: { input_tokens: 11, output_tokens: 22 },
    traceId: "trc-billing-1",
  }

  test("billing bypasses outbound message rate-limit and does not enqueue", async () => {
    const calls: Array<{ body: WechatCodexBillingBody; userId: number; containerId: number }> = []
    const handler = makeOutboundReceiverHandler(
      makeDeps({
        rateLimiter: blockedRateLimiter,
        pool: makeFakePool({ mode: "noop" }).pool,
        handleCodexBilling: async (body, identity) => {
          calls.push({ body, userId: identity.userId, containerId: identity.containerId })
        },
      }),
    )
    const { res, rec } = makeRes()
    await handler(authedReq(billingBody), res, CTX)
    assert.equal(rec.status, 200)
    assert.deepEqual(JSON.parse(rec.body), {
      ok: true,
      accepted: true,
      outcome: "codex_billing",
      scheduled: false,
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.body.requestId, billingBody.requestId)
    assert.equal(calls[0]!.body.usage?.input_tokens, 11)
    assert.equal(calls[0]!.userId, VALID_USER_ID)
    assert.equal(calls[0]!.containerId, 7)
  })

  test("billing is rejected explicitly when handler is not wired", async () => {
    const handler = makeOutboundReceiverHandler(makeDeps())
    const { res, rec } = makeRes()
    await handler(authedReq(billingBody), res, CTX)
    assert.equal(rec.status, 503)
    assert.match(rec.body, /CODEX_BILLING_NOT_WIRED/)
  })

  test("billing schema enforces requestId shape before handler", async () => {
    let called = false
    const handler = makeOutboundReceiverHandler(
      makeDeps({
        handleCodexBilling: async () => {
          called = true
        },
      }),
    )
    const { res, rec } = makeRes()
    await handler(authedReq({ ...billingBody, requestId: "not-hex" }), res, CTX)
    assert.equal(rec.status, 400)
    assert.match(rec.body, /INVALID_BODY/)
    assert.equal(called, false)
  })
})

// ─── render → enqueue happy path ───────────────────────────────────────────

describe("outboundReceiver — enqueue outcome translation", () => {
  test("queued → 202 scheduled:true outcome=queued, enqueue called with payload from text block", async () => {
    const { pool, spy } = makeFakePool({ mode: "enqueue_queued", outboxId: 42 })
    const handler = makeOutboundReceiverHandler(makeDeps({ pool }))
    const { res, rec } = makeRes()
    await handler(authedReq(validBody()), res, CTX)
    assert.equal(rec.status, 202)
    const body = JSON.parse(rec.body)
    assert.equal(body.ok, true)
    assert.equal(body.accepted, true)
    assert.equal(body.outcome, "queued")
    assert.equal(body.scheduled, true)
    assert.equal(body.outboxId, 42)
    assert.equal(spy.calls.length, 1)
    assert.equal(spy.calls[0]!.outboundId, "ob-12345678")
    assert.equal(spy.calls[0]!.payloadLen, 1) // 单条 "你好" 没超 1024,一个 part
  })

  test("pending → 202 scheduled:true outcome=pending", async () => {
    const { pool } = makeFakePool({ mode: "enqueue_pending", outboxId: 8, attempts: 0 })
    const handler = makeOutboundReceiverHandler(makeDeps({ pool }))
    const { res, rec } = makeRes()
    await handler(authedReq(validBody()), res, CTX)
    assert.equal(rec.status, 202)
    const body = JSON.parse(rec.body)
    assert.equal(body.outcome, "pending")
    assert.equal(body.scheduled, true)
    assert.equal(body.outboxId, 8)
  })

  test("already_sent → 200 scheduled:false outcome=already_sent", async () => {
    const { pool } = makeFakePool({ mode: "enqueue_already_sent", outboxId: 5, attempts: 3 })
    const handler = makeOutboundReceiverHandler(makeDeps({ pool }))
    const { res, rec } = makeRes()
    await handler(authedReq(validBody()), res, CTX)
    assert.equal(rec.status, 200)
    const body = JSON.parse(rec.body)
    assert.equal(body.outcome, "already_sent")
    assert.equal(body.scheduled, false)
    assert.equal(body.outboxId, 5)
  })

  test("already_failed → 200 scheduled:false outcome=already_failed", async () => {
    const { pool } = makeFakePool({ mode: "enqueue_already_failed", outboxId: 9, attempts: 10 })
    const handler = makeOutboundReceiverHandler(makeDeps({ pool }))
    const { res, rec } = makeRes()
    await handler(authedReq(validBody()), res, CTX)
    assert.equal(rec.status, 200)
    const body = JSON.parse(rec.body)
    assert.equal(body.outcome, "already_failed")
    assert.equal(body.scheduled, false)
    assert.equal(body.outboxId, 9)
  })

  test("enqueue throws → 500 STORAGE_ERROR", async () => {
    const { pool } = makeFakePool({ mode: "enqueue_throws" })
    const handler = makeOutboundReceiverHandler(makeDeps({ pool }))
    const { res, rec } = makeRes()
    await handler(authedReq(validBody()), res, CTX)
    assert.equal(rec.status, 500)
    assert.match(rec.body, /STORAGE_ERROR/)
  })

  test("wechat_show_tool_calls=false hides process blocks before enqueue", async () => {
    const { pool, spy } = makeFakePool({ mode: "enqueue_queued", outboxId: 42 })
    const handler = makeOutboundReceiverHandler(
      makeDeps({
        pool,
        getWechatShowToolCalls: async () => false,
      }),
    )
    const { res, rec } = makeRes()
    await handler(
      authedReq(
        validBody({
          blocks: [
            { kind: "text", text: "查询中。" },
            { kind: "thinking", text: "need to inspect" },
            { kind: "tool_use", toolName: "Read" },
            { kind: "text", text: "完成。" },
          ],
        }),
      ),
      res,
      CTX,
    )
    assert.equal(rec.status, 202)
    assert.equal(spy.calls.length, 1)
    assert.deepEqual(spy.calls[0]!.payload, [{ type: "text", text: "查询中。完成。" }])
  })

  test("tool preference lookup failure defaults to showing process blocks", async () => {
    const { pool, spy } = makeFakePool({ mode: "enqueue_queued", outboxId: 42 })
    const handler = makeOutboundReceiverHandler(
      makeDeps({
        pool,
        getWechatShowToolCalls: async () => {
          throw new Error("prefs down")
        },
      }),
    )
    const { res, rec } = makeRes()
    await handler(
      authedReq(
        validBody({
          blocks: [
            { kind: "thinking", text: "look up the file" },
            { kind: "text", text: "查询中。" },
            { kind: "tool_use", toolName: "Read" },
          ],
        }),
      ),
      res,
      CTX,
    )
    assert.equal(rec.status, 202)
    assert.equal(spy.calls.length, 1)
    assert.equal(spy.calls[0]!.payloadLen, 3)
    assert.match(String((spy.calls[0]!.payload[0] as { text?: string }).text), /思考过程/)
    assert.match(String((spy.calls[0]!.payload[2] as { text?: string }).text), /读取文件/)
  })

  test("duplicate thinking previews across outbound posts are dropped before enqueue", async () => {
    const { pool, spy } = makeFakePool({ mode: "enqueue_queued", outboxId: 42 })
    const handler = makeOutboundReceiverHandler(makeDeps({ pool }))
    const first = makeRes()
    await handler(
      authedReq(
        validBody({
          outboundId: "ob-thinking-1",
          blocks: [{ kind: "thinking", text: "same reasoning text" }],
        }),
      ),
      first.res,
      CTX,
    )
    assert.equal(first.rec.status, 202)
    assert.equal(spy.calls.length, 1)
    assert.match(String((spy.calls[0]!.payload[0] as { text?: string }).text), /same reasoning text/)

    const second = makeRes()
    await handler(
      authedReq(
        validBody({
          outboundId: "ob-thinking-2",
          blocks: [{ kind: "thinking", text: "same reasoning text" }],
        }),
      ),
      second.res,
      CTX,
    )
    assert.equal(second.rec.status, 200)
    assert.equal(JSON.parse(second.rec.body).outcome, "empty_render")
    assert.equal(spy.calls.length, 1, "second duplicate thinking preview should not enqueue")
  })

  test("normal repeated text across outbound posts is not content-deduped", async () => {
    const { pool, spy } = makeFakePool({ mode: "enqueue_queued", outboxId: 42 })
    const handler = makeOutboundReceiverHandler(makeDeps({ pool }))
    const first = makeRes()
    await handler(
      authedReq(validBody({ outboundId: "ob-text-1", blocks: [{ kind: "text", text: "same final text" }] })),
      first.res,
      CTX,
    )
    const second = makeRes()
    await handler(
      authedReq(validBody({ outboundId: "ob-text-2", blocks: [{ kind: "text", text: "same final text" }] })),
      second.res,
      CTX,
    )
    assert.equal(first.rec.status, 202)
    assert.equal(second.rec.status, 202)
    assert.equal(spy.calls.length, 2)
    assert.deepEqual(spy.calls.map((c) => (c.payload[0] as { text?: string }).text), [
      "same final text",
      "same final text",
    ])
  })
})

// ─── render: empty result → no enqueue ─────────────────────────────────────

describe("outboundReceiver — empty render short-circuit", () => {
  test("only thinking blocks with process hidden → 200 outcome=empty_render, enqueue NOT called", async () => {
    const { pool, spy } = makeFakePool({ mode: "enqueue_queued", outboxId: 1 }) // would-be answer if called
    const handler = makeOutboundReceiverHandler(
      makeDeps({
        pool,
        getWechatShowToolCalls: async () => false,
      }),
    )
    const { res, rec } = makeRes()
    await handler(
      authedReq(
        validBody({
          blocks: [
            { kind: "thinking", text: "internal reasoning" },
            { kind: "thinking", text: "more reasoning" },
          ],
        }),
      ),
      res,
      CTX,
    )
    assert.equal(rec.status, 200)
    const body = JSON.parse(rec.body)
    assert.equal(body.outcome, "empty_render")
    assert.equal(body.scheduled, false)
    assert.equal(spy.calls.length, 0)
  })

  test("only subagent blocks (parentToolUseId set) → empty_render", async () => {
    const { pool, spy } = makeFakePool({ mode: "enqueue_queued", outboxId: 1 })
    const handler = makeOutboundReceiverHandler(makeDeps({ pool }))
    const { res, rec } = makeRes()
    await handler(
      authedReq(
        validBody({
          blocks: [
            { kind: "text", text: "subagent says hi", parentToolUseId: "agent-tool-1" },
            { kind: "tool_use", toolName: "Read", parentToolUseId: "agent-tool-1" },
          ],
        }),
      ),
      res,
      CTX,
    )
    assert.equal(rec.status, 200)
    assert.equal(JSON.parse(rec.body).outcome, "empty_render")
    assert.equal(spy.calls.length, 0)
  })

  test("empty text + only tool_result → empty_render", async () => {
    const { pool, spy } = makeFakePool({ mode: "enqueue_queued", outboxId: 1 })
    const handler = makeOutboundReceiverHandler(makeDeps({ pool }))
    const { res, rec } = makeRes()
    await handler(
      authedReq(
        validBody({
          blocks: [
            { kind: "text", text: "" },
            { kind: "tool_result", toolName: "Read", isError: false },
            { kind: "tool_output_tail", toolUseBlockId: "blk-1", tail: "...", totalBytes: 100, truncatedHead: false },
          ],
        }),
      ),
      res,
      CTX,
    )
    assert.equal(rec.status, 200)
    assert.equal(JSON.parse(rec.body).outcome, "empty_render")
    assert.equal(spy.calls.length, 0)
  })

  test("only tool_use with wechat_show_tool_calls=false → empty_render", async () => {
    const { pool, spy } = makeFakePool({ mode: "enqueue_queued", outboxId: 1 })
    const handler = makeOutboundReceiverHandler(
      makeDeps({
        pool,
        getWechatShowToolCalls: async () => false,
      }),
    )
    const { res, rec } = makeRes()
    await handler(
      authedReq(
        validBody({
          blocks: [{ kind: "tool_use", toolName: "Read" }],
        }),
      ),
      res,
      CTX,
    )
    assert.equal(rec.status, 200)
    assert.equal(JSON.parse(rec.body).outcome, "empty_render")
    assert.equal(spy.calls.length, 0)
  })
})

// ─── trust boundary ────────────────────────────────────────────────────────

describe("outboundReceiver — trust boundary", () => {
  test("bindingUserId in enqueue call always equals String(identity.userId)", async () => {
    // identity.userId=42 from makeRepo defaults.
    const { pool, spy } = makeFakePool({ mode: "enqueue_queued", outboxId: 1 })
    const handler = makeOutboundReceiverHandler(makeDeps({ pool }))
    const { res, rec } = makeRes()
    await handler(authedReq(validBody()), res, CTX)
    assert.equal(rec.status, 202)
    assert.equal(spy.calls[0]!.bindingUserId, "42")
  })

  test("senderId in enqueue call comes from body.peer.meta.senderId (verified pass-through)", async () => {
    const { pool, spy } = makeFakePool({ mode: "enqueue_queued", outboxId: 1 })
    const handler = makeOutboundReceiverHandler(makeDeps({ pool }))
    const { res, rec } = makeRes()
    await handler(
      authedReq(validBody({ peer: { kind: "dm", meta: { senderId: "wx-different-sender" } } })),
      res,
      CTX,
    )
    assert.equal(rec.status, 202)
    assert.equal(spy.calls[0]!.senderId, "wx-different-sender")
  })
})

// ─── renderWechatBlocks pure function ──────────────────────────────────────

describe("renderWechatBlocks pure function", () => {
  test("text block → 1 text IlinkPart (under 1024)", () => {
    const r = renderWechatBlocks([{ kind: "text", text: "hello world" }])
    assert.equal(r.parts.length, 1)
    assert.deepEqual(r.parts[0], { type: "text", text: "hello world" })
    assert.equal(r.dropped, 0)
  })

  test("text block with markdown gets sanitized", () => {
    const r = renderWechatBlocks([{ kind: "text", text: "**bold** `code`" }])
    assert.equal(r.parts.length, 1)
    assert.equal(r.parts[0]!.text, "bold code")
  })

  test("raw UNKNOWN_MODEL API errors are rewritten for WeChat", () => {
    const r = renderWechatBlocks([
      {
        kind: "text",
        text: `API Error: 400 {"error":{"code":"UNKNOWN_MODEL","message":"model 'claude-opus-4-7' not enabled"},"request_id":"req-secret"}`,
      },
    ])
    assert.equal(r.parts.length, 1)
    assert.match(r.parts[0]!.text, /这个模型（claude-opus-4-7）当前不可用/)
    assert.doesNotMatch(r.parts[0]!.text, /request_id|req-secret|UNKNOWN_MODEL|API Error/)
  })

  test("text block > 1024 chars splits into multiple parts", () => {
    const long = "a".repeat(2050)
    const r = renderWechatBlocks([{ kind: "text", text: long }])
    assert.equal(r.parts.length, 3)
    assert.match(r.parts[0]!.text, /^（1\/3）\n/)
    assert.ok(r.parts.every((part) => part.text.length <= 1024))
  })

  test("consecutive text blocks are coalesced into one WeChat bubble", () => {
    const r = renderWechatBlocks([
      { kind: "text", text: "你好" },
      { kind: "text", text: "!" },
      { kind: "text", text: "有什么" },
      { kind: "text", text: "我可以帮你的吗?" },
    ])
    assert.equal(r.parts.length, 1)
    assert.deepEqual(r.parts[0], { type: "text", text: "你好!有什么我可以帮你的吗?" })
  })

  test("coalesced long text still splits into WeChat pages", () => {
    const r = renderWechatBlocks([
      { kind: "text", text: "a".repeat(900) },
      { kind: "text", text: "b".repeat(900) },
    ])
    assert.equal(r.parts.length, 2)
    assert.match(r.parts[0]!.text, /^（1\/2）\n/)
    assert.match(r.parts[1]!.text, /^（2\/2）\n/)
    assert.equal(
      r.parts.map((part) => part.text.replace(/^（\d+\/\d+）\n/, "")).join(""),
      "a".repeat(900) + "b".repeat(900),
    )
  })

  test("tool_use block → tool announcement (single text part)", () => {
    const r = renderWechatBlocks([{ kind: "tool_use", toolName: "Read" }])
    assert.equal(r.parts.length, 1)
    assert.match(r.parts[0]!.text, /读取文件/)
  })

  test("Bash tool_use shows the concrete command", () => {
    const r = renderWechatBlocks([
      { kind: "tool_use", toolName: "Bash", inputJson: { command: "ls -la /tmp" } },
    ])
    assert.equal(r.parts.length, 1)
    assert.match(r.parts[0]!.text, /执行命令/)
    assert.match(r.parts[0]!.text, /命令：ls -la \/tmp/)
  })

  test("tool_use falls back to JSON inputPreview details", () => {
    const r = renderWechatBlocks([
      {
        kind: "tool_use",
        toolName: "mcp__demo__custom_tool",
        inputPreview: JSON.stringify({ query: "微信工具详情" }),
      },
    ])
    assert.equal(r.parts.length, 1)
    assert.match(r.parts[0]!.text, /custom_tool/)
    assert.match(r.parts[0]!.text, /参数：微信工具详情/)
  })

  test("tool_use detail is capped for WeChat", () => {
    const r = renderWechatBlocks([
      { kind: "tool_use", toolName: "Bash", inputJson: { command: "a".repeat(500) } },
    ])
    assert.equal(r.parts.length, 1)
    assert.ok(r.parts[0]!.text.length < 380)
    assert.ok(r.parts[0]!.text.endsWith("…"))
  })

  test("tool_use announcement can be hidden by user preference", () => {
    const r = renderWechatBlocks([
      { kind: "text", text: "查询中。" },
      { kind: "tool_use", toolName: "Bash", inputJson: { command: "pwd" } },
      { kind: "text", text: "完成。" },
    ], { showToolCalls: false })
    assert.deepEqual(r.parts, [{ type: "text", text: "查询中。完成。" }])
    assert.equal(r.dropped, 1)
  })

  test("tool_result block → dropped (P1)", () => {
    const r = renderWechatBlocks([{ kind: "tool_result", toolName: "Read", isError: false }])
    assert.equal(r.parts.length, 0)
    assert.equal(r.dropped, 1)
  })

  test("thinking blocks → coalesced bounded process preview", () => {
    const r = renderWechatBlocks([
      { kind: "thinking", text: "reasoning" },
      { kind: "thinking", text: " with\nsteps" },
      { kind: "text", text: "答案" },
    ])
    assert.equal(r.parts.length, 2)
    assert.match(r.parts[0]!.text, /^💭 思考过程：\nreasoning with steps/)
    assert.equal(r.parts[1]!.text, "答案")
    assert.equal(r.dropped, 0)
  })

  test("thinking preview is capped for WeChat", () => {
    const r = renderWechatBlocks([{ kind: "thinking", text: "a".repeat(900) }])
    assert.equal(r.parts.length, 1)
    assert.match(r.parts[0]!.text, /^💭 思考过程：\n/)
    assert.ok(r.parts[0]!.text.length < 900)
    assert.ok(r.parts[0]!.text.endsWith("…"))
  })

  test("thinking process can be hidden by user preference", () => {
    const r = renderWechatBlocks([
      { kind: "thinking", text: "reasoning..." },
      { kind: "text", text: "done" },
    ], { showToolCalls: false })
    assert.deepEqual(r.parts, [{ type: "text", text: "done" }])
    assert.equal(r.dropped, 1)
  })

  test("tool_output_tail block → dropped (P1)", () => {
    const r = renderWechatBlocks([
      { kind: "tool_output_tail", toolUseBlockId: "blk-1", tail: "...", totalBytes: 100, truncatedHead: false },
    ])
    assert.equal(r.parts.length, 0)
    assert.equal(r.dropped, 1)
  })

  test("parentToolUseId set → block dropped regardless of kind", () => {
    const r = renderWechatBlocks([
      { kind: "text", text: "from subagent", parentToolUseId: "agent-1" },
      { kind: "tool_use", toolName: "Bash", parentToolUseId: "agent-1" },
    ])
    assert.equal(r.parts.length, 0)
    assert.equal(r.dropped, 2)
  })

  test("text block with only markdown noise (sanitize → empty) → 0 parts + 1 dropped", () => {
    // `---` 是 horizontal rule;``` 是 code fence;sanitize 后全剥掉 → cleaned=""
    // renderAssistantText 见 cleaned.length===0 返 [],case 'text' 走 dropped++ 分支
    const r = renderWechatBlocks([{ kind: "text", text: "---\n```\n```\n" }])
    assert.equal(r.parts.length, 0)
    assert.equal(r.dropped, 1)
  })

  test("mixed blocks: text + tool_use + thinking + parentToolUseId text → 3 parts (text + announcement + thinking)", () => {
    const r = renderWechatBlocks([
      { kind: "text", text: "I'll help" },
      { kind: "tool_use", toolName: "Grep" },
      { kind: "thinking", text: "internal" },
      { kind: "text", text: "from subagent", parentToolUseId: "agent-1" },
    ])
    assert.equal(r.parts.length, 3)
    assert.equal(r.parts[0]!.text, "I'll help")
    assert.match(r.parts[1]!.text, /搜索内容/)
    assert.match(r.parts[2]!.text, /思考过程/)
    assert.equal(r.dropped, 1) // parentToolUseId text
  })

  test("empty blocks array → empty result (caller decides empty_render)", () => {
    const r = renderWechatBlocks([])
    assert.equal(r.parts.length, 0)
    assert.equal(r.dropped, 0)
  })
})
