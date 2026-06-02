/**
 * v3 commercial wechat inboundDispatcher — Plan PASS 后单测。
 *
 * 覆盖矩阵(对齐 plan §"测试覆盖矩阵"):
 *   - command echo:literal `/` 前缀触发,前导空格不触发,无 transport 调用
 *   - cold_start:resolveContainerEndpoint 抛 ContainerUnreadyError → 反射文案
 *   - container_id_missing:resolver 返 endpoint 无 containerId → permanent reject
 *   - tunnel_unsupported:endpoint.tunnel set 但 transport.supportsTunnel ≠ true
 *   - happy path new session:pointer=null → upsertMasterClientSession 调 1 次,pointer 写
 *   - happy path reuse session:pointer 已存在 → upsertMasterClientSession **不**调用
 *   - Step 1 401 / 500 / network error / retry-recover / 202 retryAfter / 202 malformed body
 *   - Step 2a fail:compensation 调用 + 'ok' / 'failed'
 *   - Step 2b fail newSession:compensation + softDelete 双撤
 *   - Step 2b fail reuseSession:**skipped_reuse**,无 compensation 调用,无 softDelete 调用
 *   - nonce correctness(HMAC 输入 = `inbound:` + containerId)
 *   - idempotencyKey / agentId 透传
 *   - pointer stale skip(setCurrentSessionId 返 false → 仍算 dispatched)
 *   - emoji-safe title slice
 *   - resolver throws non-ColdStart Error → transport_failed
 *
 * Run:
 *   npx tsx --test packages/commercial/src/__tests__/wechatInboundDispatcher.test.ts
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"

import {
  makeInboundDispatcher,
  WECHAT_INBOUND_COMPENSATE_PATH,
  WECHAT_INBOUND_CONTAINER_PATH,
  WECHAT_STOP_CONTAINER_PATH,
  type ContainerTransport,
  type DispatchOutcome,
  type InboundDispatcherDeps,
  type InboundEvent,
} from "../wechat/inboundDispatcher.js"
import { ContainerUnreadyError } from "../ws/userChatBridge.js"
import type { PgConn } from "../wechat/sessionPointer.js"
import type { WechatSessionId } from "../wechat/types.js"

// ─── fixtures ──────────────────────────────────────────────────────────────

const BINDING_UID = "42"
const SENDER_ID = "wx-sender-abc"
const CONTAINER_ID = 7
const BRIDGE_SECRET = "a".repeat(64)
const FIXED_NOW = 1_700_000_000_000
const FIXED_SESSION_ID = "wsess-0123456789abcdef" as WechatSessionId
const FIXED_SESSION_ID_2 = "wsess-fedcba9876543210" as WechatSessionId

function expectedNonce(): string {
  return createHmac("sha256", BRIDGE_SECRET).update(`inbound:${CONTAINER_ID}`).digest("base64url")
}

interface RecordedPost {
  path: string
  headers: Record<string, string>
  bodyJson: string
  bodyParsed: Record<string, unknown>
}

interface TransportSpy {
  posts: RecordedPost[]
}

/**
 * Programmable transport — 每次 post 依 plan 数组弹出响应;
 * plan 用空 → throw "no more responses" 帮助测试发现 over-call。
 *
 * 响应可以是:
 *  - `{ status, bodyText, headers? }`:正常 HTTP 应答
 *  - `{ throw: Error }`:transport 层错(connect refused / timeout)
 *  - `(req) => Response`:函数式响应(便于按 path 路由 step1 vs compensation)
 */
type TransportResponse =
  | { status: number; bodyText: string; headers?: Record<string, string> }
  | { throw: Error }

function makeTransport(
  responses: Array<TransportResponse | ((req: RecordedPost) => TransportResponse)>,
  opts: { supportsTunnel?: boolean } = {},
): { transport: ContainerTransport; spy: TransportSpy } {
  const spy: TransportSpy = { posts: [] }
  let cursor = 0
  const transport: ContainerTransport = {
    supportsTunnel: opts.supportsTunnel,
    async post(endpoint, path, headers, bodyJson, _timeoutMs) {
      const bodyParsed = JSON.parse(bodyJson) as Record<string, unknown>
      const req: RecordedPost = { path, headers: { ...headers }, bodyJson, bodyParsed }
      spy.posts.push(req)
      if (cursor >= responses.length) {
        throw new Error(`transport spy ran out of programmed responses at call #${cursor + 1}`)
      }
      const slot = responses[cursor++]!
      const resolved = typeof slot === "function" ? slot(req) : slot
      if ("throw" in resolved) throw resolved.throw
      return { status: resolved.status, bodyText: resolved.bodyText, headers: resolved.headers }
    },
  }
  return { transport, spy }
}

interface PgSpy {
  getCalls: Array<{ bindingUserId: string }>
  setCalls: Array<{ bindingUserId: string; sessionId: string; now: number; agentId: string | null }>
  runningListCalls: Array<{ bindingUserId: string }>
  runningSetCalls: Array<{ bindingUserId: string; sessionId: string; runId: string; agentId: string | null; now: number }>
  runningClearCalls: Array<{ bindingUserId: string; sessionId: string; runId: string }>
}

/**
 * Fake PG —— 仅实现 sessionPointer 用到的两条 SQL:
 *   SELECT current_session_id FROM wechat_session_pointer WHERE binding_user_id = $1 LIMIT 1
 *   INSERT INTO wechat_session_pointer ... ON CONFLICT DO UPDATE ... WHERE updated_at <= EXCLUDED
 *
 * 用 opts.pointer / opts.applySet 控制返回行为;`throwOnSet` / `throwOnGet` 模拟故障。
 */
function makeFakePg(opts: {
  /** SELECT 返回的 current_session_id;null = 行不存在 */
  pointer: string | null
  pointerAgentId?: string
  /** INSERT/UPDATE 是否真生效;false 模拟 stale skip */
  applySet?: boolean
  runningSessions?: Array<{ sessionId: string; runId: string; agentId?: string }>
  throwOnGet?: Error
  throwOnSet?: Error
}): { pg: PgConn; spy: PgSpy } {
  const spy: PgSpy = { getCalls: [], setCalls: [], runningListCalls: [], runningSetCalls: [], runningClearCalls: [] }
  const pg: PgConn = {
    async query<R extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params: ReadonlyArray<unknown> = [],
    ): Promise<{ rows: R[]; rowCount: number | null }> {
      if (/SELECT current_session_id(?:,\s*current_agent_id)? FROM wechat_session_pointer/i.test(sql)) {
        if (opts.throwOnGet) throw opts.throwOnGet
        spy.getCalls.push({ bindingUserId: String(params[0]) })
        if (opts.pointer === null) {
          return { rows: [] as R[], rowCount: 0 }
        }
        return {
          rows: [{
            current_session_id: opts.pointer,
            current_agent_id: opts.pointerAgentId ?? null,
          } as unknown as R],
          rowCount: 1,
        }
      }
      if (/INSERT INTO wechat_session_pointer/i.test(sql)) {
        if (opts.throwOnSet) throw opts.throwOnSet
        spy.setCalls.push({
          bindingUserId: String(params[0]),
          sessionId: String(params[1]),
          now: Number(params[2]),
          agentId: params[3] === null ? null : String(params[3]),
        })
        const applied = opts.applySet ?? true
        return { rows: [] as R[], rowCount: applied ? 1 : 0 }
      }
      if (/SELECT session_id, run_id, agent_id\s+FROM wechat_running_sessions/i.test(sql)) {
        spy.runningListCalls.push({ bindingUserId: String(params[0]) })
        return {
          rows: (opts.runningSessions ?? []).map((s) => ({
            session_id: s.sessionId,
            run_id: s.runId,
            agent_id: s.agentId ?? null,
          })) as unknown as R[],
          rowCount: opts.runningSessions?.length ?? 0,
        }
      }
      if (/INSERT INTO wechat_running_sessions/i.test(sql)) {
        spy.runningSetCalls.push({
          bindingUserId: String(params[0]),
          sessionId: String(params[1]),
          runId: String(params[2]),
          agentId: params[3] === null ? null : String(params[3]),
          now: Number(params[4]),
        })
        return { rows: [] as R[], rowCount: 1 }
      }
      if (/DELETE FROM wechat_running_sessions/i.test(sql)) {
        spy.runningClearCalls.push({
          bindingUserId: String(params[0]),
          sessionId: String(params[1]),
          runId: String(params[2]),
        })
        return { rows: [] as R[], rowCount: 1 }
      }
      throw new Error(`makeFakePg: unhandled SQL: ${sql.slice(0, 80)}`)
    },
  }
  return { pg, spy }
}

interface StorageSpy {
  upsertCalls: Array<{
    sessionId: string
    userId: string
    agentId: string
    originChannel: string
    title: string
    createdAt: number
    lastAt: number
  }>
  softDeleteCalls: Array<{ sessionId: string; userId: string }>
}

function makeStorageSpies(opts: {
  upsertThrows?: Error
  softDeleteThrows?: Error
} = {}): {
  upsertMasterClientSession: InboundDispatcherDeps["upsertMasterClientSession"]
  softDeleteMasterSession: InboundDispatcherDeps["softDeleteMasterSession"]
  spy: StorageSpy
} {
  const spy: StorageSpy = { upsertCalls: [], softDeleteCalls: [] }
  return {
    spy,
    async upsertMasterClientSession(params) {
      spy.upsertCalls.push({ ...params })
      if (opts.upsertThrows) throw opts.upsertThrows
    },
    async softDeleteMasterSession(sessionId, userId) {
      spy.softDeleteCalls.push({ sessionId, userId })
      if (opts.softDeleteThrows) throw opts.softDeleteThrows
    },
  }
}

function makeResolver(
  endpoint:
    | { host: string; port: number; containerId?: number; tunnel?: unknown }
    | { throw: Error },
): InboundDispatcherDeps["resolveContainerEndpoint"] {
  return (async (_uid: bigint) => {
    if ("throw" in endpoint) throw endpoint.throw
    // 测试用 `unknown` tunnel shape;dispatcher 只看 `tunnel !== undefined`,不读内容,
    // 故 cast 安全(避免在 test 文件构造完整 NodeAgentTarget mock)
    return endpoint
  }) as InboundDispatcherDeps["resolveContainerEndpoint"]
}

function makeDeps(overrides: Partial<InboundDispatcherDeps> = {}): InboundDispatcherDeps {
  const storage = makeStorageSpies()
  return {
    pgPool: makeFakePg({ pointer: null }).pg,
    resolveContainerEndpoint: makeResolver({
      host: "10.0.0.5",
      port: 18789,
      containerId: CONTAINER_ID,
    }),
    bridgeSecret: BRIDGE_SECRET,
    upsertMasterClientSession: storage.upsertMasterClientSession,
    softDeleteMasterSession: storage.softDeleteMasterSession,
    transport: makeTransport([{ status: 200, bodyText: '{"ok":true,"dispatched":true}' }]).transport,
    newSessionId: () => FIXED_SESSION_ID,
    now: () => FIXED_NOW,
    newRequestId: () => "req-fixed",
    step1RetryBackoffMs: 0, // 测试不等
    ...overrides,
  }
}

function makeEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    bindingUserId: BINDING_UID,
    senderId: SENDER_ID,
    text: "你好",
    idempotencyKey: "wx-msg-87",
    agentId: "main",
    receivedAt: FIXED_NOW - 100,
    traceId: "trc-1",
    ...overrides,
  }
}

// ─── 0. command echo ───────────────────────────────────────────────────────

describe("inboundDispatcher — command echo", () => {
  test("text='/list' → command_echo, no transport call", async () => {
    const { transport, spy: tSpy } = makeTransport([
      { throw: new Error("transport should not be called") },
    ])
    const d = makeInboundDispatcher(makeDeps({ transport }))
    const r = await d.dispatch(makeEvent({ text: "/list" }))
    assert.equal(r.kind, "command_echo")
    if (r.kind === "command_echo") {
      assert.equal(r.reply, "暂不支持这个命令。发送 /help 查看微信里可用的命令，或直接发送问题。")
    }
    assert.equal(tSpy.posts.length, 0)
  })

  test("text='/' single slash → command_echo", async () => {
    const d = makeInboundDispatcher(makeDeps())
    const r = await d.dispatch(makeEvent({ text: "/" }))
    assert.equal(r.kind, "command_echo")
  })

  test("text='  /list' (leading space) → NOT command (空格强制走入容器)", async () => {
    // 这条会真发到容器;只验证不是 command_echo
    const pg = makeFakePg({ pointer: null })
    const d = makeInboundDispatcher(
      makeDeps({
        pgPool: pg.pg,
        transport: makeTransport([{ status: 200, bodyText: '{"ok":true}' }]).transport,
      }),
    )
    const r = await d.dispatch(makeEvent({ text: "  /list" }))
    assert.notEqual(r.kind, "command_echo")
  })
})

describe("inboundDispatcher — stop command bridge", () => {
  test("stop with no current session returns local no-op reply and does not POST", async () => {
    const { transport, spy: tSpy } = makeTransport([
      { throw: new Error("transport should not be called") },
    ])
    const d = makeInboundDispatcher(
      makeDeps({
        pgPool: makeFakePg({ pointer: null }).pg,
        transport,
      }),
    )
    const r = await d.stop(makeEvent({ text: "/stop" }))
    assert.equal(r.kind, "command_echo")
    assert.equal(r.interrupted, false)
    assert.match(r.reply, /没有可中断/)
    assert.equal(tSpy.posts.length, 0)
  })

  test("stop posts current wsess to container stop endpoint", async () => {
    const pg = makeFakePg({ pointer: FIXED_SESSION_ID })
    const { transport, spy: tSpy } = makeTransport([
      { status: 200, bodyText: '{"ok":true,"interrupted":true}' },
    ])
    const d = makeInboundDispatcher(
      makeDeps({
        pgPool: pg.pg,
        transport,
      }),
    )
    const r = await d.stop(makeEvent({ text: "/stop" }))
    assert.equal(r.interrupted, true)
    assert.match(r.reply, /已发送中断/)
    assert.equal(tSpy.posts.length, 1)
    assert.equal(tSpy.posts[0]!.path, WECHAT_STOP_CONTAINER_PATH)
    assert.equal(tSpy.posts[0]!.bodyParsed.userId, "c:42")
    assert.deepEqual(tSpy.posts[0]!.bodyParsed.peer, { kind: "dm", id: FIXED_SESSION_ID })
    assert.equal(tSpy.posts[0]!.bodyParsed.agentId, "main")
    assert.equal(tSpy.posts[0]!.headers["x-openclaude-inbound-nonce"], expectedNonce())
  })

  test("stop targets running sessions before current pointer and clears interrupted rows", async () => {
    const pg = makeFakePg({
      pointer: FIXED_SESSION_ID,
      runningSessions: [
        { sessionId: FIXED_SESSION_ID_2, runId: "run-2", agentId: "coder" },
        { sessionId: FIXED_SESSION_ID, runId: "run-1", agentId: "main" },
      ],
    })
    const { transport, spy: tSpy } = makeTransport([
      { status: 200, bodyText: '{"ok":true,"interrupted":true}' },
      { status: 200, bodyText: '{"ok":true,"interrupted":true}' },
    ])
    const d = makeInboundDispatcher(makeDeps({ pgPool: pg.pg, transport }))
    const r = await d.stop(makeEvent({ text: "/stop" }))
    assert.equal(r.interrupted, true)
    assert.match(r.reply, /2\/2/)
    assert.equal(pg.spy.getCalls.length, 1)
    assert.equal(tSpy.posts.length, 2)
    assert.deepEqual(tSpy.posts.map((p) => p.bodyParsed.peer), [
      { kind: "dm", id: FIXED_SESSION_ID_2 },
      { kind: "dm", id: FIXED_SESSION_ID },
    ])
    assert.deepEqual(tSpy.posts.map((p) => p.bodyParsed.agentId), ["coder", "main"])
    assert.deepEqual(pg.spy.runningClearCalls.map((c) => c.sessionId), [
      FIXED_SESSION_ID_2,
      FIXED_SESSION_ID,
    ])
  })

  test("stop merges current pointer fallback when stale tracked rows are present", async () => {
    const pg = makeFakePg({
      pointer: FIXED_SESSION_ID,
      runningSessions: [
        { sessionId: FIXED_SESSION_ID_2, runId: "run-stale", agentId: "coder" },
      ],
    })
    const { transport, spy: tSpy } = makeTransport([
      { status: 200, bodyText: '{"ok":true,"interrupted":false}' },
      { status: 200, bodyText: '{"ok":true,"interrupted":true}' },
    ])
    const d = makeInboundDispatcher(makeDeps({ pgPool: pg.pg, transport }))
    const r = await d.stop(makeEvent({ text: "/stop" }))
    assert.equal(r.interrupted, true)
    assert.match(r.reply, /1\/2/)
    assert.equal(pg.spy.getCalls.length, 1)
    assert.equal(tSpy.posts.length, 2)
    assert.deepEqual(tSpy.posts.map((p) => p.bodyParsed.peer), [
      { kind: "dm", id: FIXED_SESSION_ID_2 },
      { kind: "dm", id: FIXED_SESSION_ID },
    ])
    assert.deepEqual(pg.spy.runningClearCalls, [
      { bindingUserId: "42", sessionId: FIXED_SESSION_ID_2, runId: "run-stale" },
    ])
  })
})

// ─── 1. cold start / resolver ──────────────────────────────────────────────

describe("inboundDispatcher — resolver / cold start", () => {
  test("ContainerUnreadyError → cold_start with reply 文案", async () => {
    const d = makeInboundDispatcher(
      makeDeps({
        resolveContainerEndpoint: makeResolver({ throw: new ContainerUnreadyError(5, "provisioning") }),
      }),
    )
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "cold_start")
    if (r.kind === "cold_start") {
      assert.equal(r.reason, "provisioning")
      assert.equal(r.retryAfterSec, 5)
      assert.equal(r.coldStartReply, "正在唤醒你的 OpenClaude 容器，通常几秒钟。请稍后再发一次消息。")
    }
  })

  test("resolver throws non-ColdStart Error → transport_failed step1 retryable", async () => {
    const d = makeInboundDispatcher(
      makeDeps({
        resolveContainerEndpoint: makeResolver({ throw: new Error("docker daemon down") }),
      }),
    )
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "transport_failed")
    if (r.kind === "transport_failed") {
      assert.equal(r.phase, "step1")
      assert.equal(r.retryable, true)
      assert.ok(r.errMessage.includes("docker daemon down"))
    }
  })

  test("resolver returns no containerId → container_rejected status=0 retryable=false", async () => {
    const d = makeInboundDispatcher(
      makeDeps({
        resolveContainerEndpoint: makeResolver({ host: "10.0.0.5", port: 18789 }),
      }),
    )
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "container_rejected")
    if (r.kind === "container_rejected") {
      assert.equal(r.status, 0)
      assert.equal(r.retryable, false)
      assert.equal(r.errMessage, "container_id_missing_from_resolver")
    }
  })
})

// ─── 2. tunnel ──────────────────────────────────────────────────────────────

describe("inboundDispatcher — tunnel transport", () => {
  test("endpoint.tunnel set but transport.supportsTunnel=undefined → tunnel_unsupported", async () => {
    const { transport } = makeTransport([
      { throw: new Error("should not be called") },
    ])
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        resolveContainerEndpoint: makeResolver({
          host: "10.0.0.5",
          port: 18789,
          containerId: CONTAINER_ID,
          tunnel: { hostId: "remote-host", containerInternalId: "abc", nodeAgent: {} },
        }),
      }),
    )
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "tunnel_unsupported")
  })

  test("endpoint.tunnel set + transport.supportsTunnel=true → 走 happy path", async () => {
    const { transport, spy } = makeTransport([
      { status: 200, bodyText: '{"ok":true}' },
    ], { supportsTunnel: true })
    const storage = makeStorageSpies()
    const pg = makeFakePg({ pointer: null })
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        pgPool: pg.pg,
        upsertMasterClientSession: storage.upsertMasterClientSession,
        softDeleteMasterSession: storage.softDeleteMasterSession,
        resolveContainerEndpoint: makeResolver({
          host: "10.0.0.5",
          port: 18789,
          containerId: CONTAINER_ID,
          tunnel: { hostId: "remote-host", containerInternalId: "abc", nodeAgent: {} },
        }),
      }),
    )
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "dispatched")
    assert.equal(spy.posts.length, 1)
  })
})

// ─── 3. happy path new + reuse session ─────────────────────────────────────

describe("inboundDispatcher — happy path", () => {
  test("new session: pointer=null → upsert called, pointer set, outcome dispatched newSession=true", async () => {
    const { transport, spy: tSpy } = makeTransport([
      { status: 200, bodyText: '{"ok":true,"dispatched":true}' },
    ])
    const storage = makeStorageSpies()
    const pg = makeFakePg({ pointer: null })
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        pgPool: pg.pg,
        upsertMasterClientSession: storage.upsertMasterClientSession,
        softDeleteMasterSession: storage.softDeleteMasterSession,
      }),
    )
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "dispatched")
    if (r.kind === "dispatched") {
      assert.equal(r.sessionId, FIXED_SESSION_ID)
      assert.equal(r.newSession, true)
    }
    // Step 1 调一次
    assert.equal(tSpy.posts.length, 1)
    assert.equal(tSpy.posts[0]!.path, WECHAT_INBOUND_CONTAINER_PATH)
    // master sqlite 写一次,字段稳定
    assert.equal(storage.spy.upsertCalls.length, 1)
    const u = storage.spy.upsertCalls[0]!
    assert.equal(u.sessionId, FIXED_SESSION_ID)
    assert.equal(u.userId, "c:42")
    assert.equal(u.agentId, "main")
    assert.equal(u.originChannel, "wechat")
    assert.equal(u.createdAt, FIXED_NOW)
    assert.equal(u.lastAt, FIXED_NOW)
    assert.equal(u.title, "你好")
    // pointer 写一次
    assert.equal(pg.spy.setCalls.length, 1)
    assert.equal(pg.spy.setCalls[0]!.sessionId, FIXED_SESSION_ID)
    assert.equal(pg.spy.setCalls[0]!.now, FIXED_NOW)
    assert.equal(pg.spy.runningSetCalls.length, 1)
    assert.equal(pg.spy.runningSetCalls[0]!.sessionId, FIXED_SESSION_ID)
  })

  test("deduplicated Step1 response adopts original wsess before master pointer/upsert", async () => {
    const originalSessionId = FIXED_SESSION_ID
    const retryAllocatedSessionId = FIXED_SESSION_ID_2
    const { transport, spy: tSpy } = makeTransport([
      {
        status: 200,
        bodyText: JSON.stringify({
          ok: true,
          deduplicated: true,
          started: true,
          sessionId: originalSessionId,
          traceId: "orig-run",
        }),
      },
    ])
    const storage = makeStorageSpies()
    const pg = makeFakePg({ pointer: null })
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        pgPool: pg.pg,
        upsertMasterClientSession: storage.upsertMasterClientSession,
        softDeleteMasterSession: storage.softDeleteMasterSession,
        newSessionId: () => retryAllocatedSessionId,
      }),
    )
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "dispatched")
    if (r.kind === "dispatched") {
      assert.equal(r.sessionId, originalSessionId)
      assert.equal(r.newSession, true)
    }
    assert.equal(tSpy.posts[0]!.bodyParsed.peer.id, retryAllocatedSessionId)
    assert.equal(storage.spy.upsertCalls[0]!.sessionId, originalSessionId)
    assert.equal(pg.spy.setCalls[0]!.sessionId, originalSessionId)
    assert.deepEqual(pg.spy.runningSetCalls.map((c) => ({
      sessionId: c.sessionId,
      runId: c.runId,
    })), [{ sessionId: originalSessionId, runId: "orig-run" }])
  })

  test("Step1 routed agentId is persisted for web hello and /stop targets", async () => {
    const { transport } = makeTransport([
      {
        status: 200,
        bodyText: JSON.stringify({
          ok: true,
          started: true,
          sessionKey: `agent:codex:webchat:dm:${FIXED_SESSION_ID}`,
          agentId: "codex",
          traceId: "codex-run",
        }),
      },
    ])
    const storage = makeStorageSpies()
    const pg = makeFakePg({ pointer: null })
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        pgPool: pg.pg,
        upsertMasterClientSession: storage.upsertMasterClientSession,
        softDeleteMasterSession: storage.softDeleteMasterSession,
      }),
    )
    const r = await d.dispatch(makeEvent({ agentId: "main" }))
    assert.equal(r.kind, "dispatched")
    assert.equal(storage.spy.upsertCalls[0]!.agentId, "codex")
    assert.equal(pg.spy.setCalls[0]!.agentId, "codex")
    assert.deepEqual(pg.spy.runningSetCalls.map((c) => ({
      sessionId: c.sessionId,
      runId: c.runId,
      agentId: c.agentId,
    })), [{ sessionId: FIXED_SESSION_ID, runId: "codex-run", agentId: "codex" }])
  })

  test("Step1 started=false is surfaced and does not mark a running session", async () => {
    const { transport } = makeTransport([
      {
        status: 200,
        bodyText: JSON.stringify({
          ok: true,
          started: false,
          traceId: "fast-fail-run",
        }),
      },
    ])
    const storage = makeStorageSpies()
    const pg = makeFakePg({ pointer: null })
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        pgPool: pg.pg,
        upsertMasterClientSession: storage.upsertMasterClientSession,
        softDeleteMasterSession: storage.softDeleteMasterSession,
      }),
    )
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "dispatched")
    if (r.kind === "dispatched") {
      assert.equal(r.started, false)
    }
    assert.equal(pg.spy.runningSetCalls.length, 0)
  })

  test("deduplicated older wsess does not move an existing current pointer backwards", async () => {
    const oldDedupedSessionId = FIXED_SESSION_ID
    const currentSessionId = FIXED_SESSION_ID_2
    const { transport } = makeTransport([
      {
        status: 200,
        bodyText: JSON.stringify({
          ok: true,
          deduplicated: true,
          started: true,
          sessionId: oldDedupedSessionId,
          traceId: "old-run",
        }),
      },
    ])
    const storage = makeStorageSpies()
    const pg = makeFakePg({ pointer: currentSessionId })
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        pgPool: pg.pg,
        upsertMasterClientSession: storage.upsertMasterClientSession,
        softDeleteMasterSession: storage.softDeleteMasterSession,
      }),
    )
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "dispatched")
    if (r.kind === "dispatched") {
      assert.equal(r.sessionId, oldDedupedSessionId)
      assert.equal(r.newSession, false)
    }
    assert.equal(storage.spy.upsertCalls.length, 1)
    assert.equal(storage.spy.upsertCalls[0]!.sessionId, oldDedupedSessionId)
    assert.equal(pg.spy.setCalls.length, 0)
    assert.deepEqual(pg.spy.runningSetCalls.map((c) => ({
      sessionId: c.sessionId,
      runId: c.runId,
    })), [{ sessionId: oldDedupedSessionId, runId: "old-run" }])
  })

  test("reuse session: pointer=existing → upsert NOT called, pointer touched, dispatched newSession=false", async () => {
    const { transport } = makeTransport([
      { status: 200, bodyText: '{"ok":true}' },
    ])
    const storage = makeStorageSpies()
    const pg = makeFakePg({ pointer: "wsess-aaaaaaaaaaaaaaaa" })
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        pgPool: pg.pg,
        upsertMasterClientSession: storage.upsertMasterClientSession,
        softDeleteMasterSession: storage.softDeleteMasterSession,
      }),
    )
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "dispatched")
    if (r.kind === "dispatched") {
      assert.equal(r.sessionId, "wsess-aaaaaaaaaaaaaaaa")
      assert.equal(r.newSession, false)
    }
    assert.equal(storage.spy.upsertCalls.length, 0)
    assert.equal(pg.spy.setCalls.length, 1)
  })

  test("pointer stale skip (setCurrentSessionId returns false) → still dispatched", async () => {
    const { transport } = makeTransport([{ status: 200, bodyText: "{}" }])
    const storage = makeStorageSpies()
    const pg = makeFakePg({ pointer: "wsess-aaaaaaaaaaaaaaaa", applySet: false })
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        pgPool: pg.pg,
        upsertMasterClientSession: storage.upsertMasterClientSession,
        softDeleteMasterSession: storage.softDeleteMasterSession,
      }),
    )
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "dispatched")
  })
})

// ─── 4. Step 1 失败分流 ──────────────────────────────────────────────────────

describe("inboundDispatcher — Step 1 failure", () => {
  test("status 401 → container_rejected retryable=false", async () => {
    const { transport } = makeTransport([
      { status: 401, bodyText: '{"error":{"code":"UNAUTHORIZED"}}' },
      // 401 不会走 retry(只有 transport 层错才 retry)
    ])
    const d = makeInboundDispatcher(makeDeps({ transport }))
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "container_rejected")
    if (r.kind === "container_rejected") {
      assert.equal(r.status, 401)
      assert.equal(r.retryable, false)
    }
  })

  test("status 500 → container_rejected retryable=true", async () => {
    const { transport } = makeTransport([
      { status: 500, bodyText: "internal" },
    ])
    const d = makeInboundDispatcher(makeDeps({ transport }))
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "container_rejected")
    if (r.kind === "container_rejected") {
      assert.equal(r.status, 500)
      assert.equal(r.retryable, true)
    }
  })

  test("transport throws on both attempts → transport_failed step1 retryable=true", async () => {
    const { transport, spy } = makeTransport([
      { throw: new Error("ECONNREFUSED") },
      { throw: new Error("ECONNREFUSED again") },
    ])
    const d = makeInboundDispatcher(makeDeps({ transport }))
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "transport_failed")
    if (r.kind === "transport_failed") {
      assert.equal(r.phase, "step1")
      assert.equal(r.retryable, true)
      assert.ok(r.errMessage.includes("ECONNREFUSED"))
    }
    assert.equal(spy.posts.length, 2) // 1 try + 1 retry
  })

  test("transport throws once then succeeds → dispatched", async () => {
    const { transport, spy } = makeTransport([
      { throw: new Error("ETIMEDOUT") },
      { status: 200, bodyText: "{}" },
    ])
    const storage = makeStorageSpies()
    const pg = makeFakePg({ pointer: null })
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        pgPool: pg.pg,
        upsertMasterClientSession: storage.upsertMasterClientSession,
        softDeleteMasterSession: storage.softDeleteMasterSession,
      }),
    )
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "dispatched")
    assert.equal(spy.posts.length, 2)
  })

  test("status 202 with body retryAfterSec → cold_start", async () => {
    const { transport } = makeTransport([
      { status: 202, bodyText: '{"ok":true,"coldStarting":true,"retryAfterSec":7}' },
    ])
    const d = makeInboundDispatcher(makeDeps({ transport }))
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "cold_start")
    if (r.kind === "cold_start") {
      assert.equal(r.retryAfterSec, 7)
      assert.equal(r.reason, "container_internal_cold")
    }
  })

  test("status 202 with body retryAfterMs → cold_start ceil to sec", async () => {
    const { transport } = makeTransport([
      { status: 202, bodyText: '{"retryAfterMs":3500}' },
    ])
    const d = makeInboundDispatcher(makeDeps({ transport }))
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "cold_start")
    if (r.kind === "cold_start") {
      assert.equal(r.retryAfterSec, 4) // ceil(3500/1000)
    }
  })

  test("status 202 malformed body → fallback retryAfterSec=3", async () => {
    const { transport } = makeTransport([
      { status: 202, bodyText: "not-json-at-all" },
    ])
    const d = makeInboundDispatcher(makeDeps({ transport }))
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "cold_start")
    if (r.kind === "cold_start") {
      assert.equal(r.retryAfterSec, 3)
    }
  })

  test("status 202 with Retry-After header → cold_start", async () => {
    const { transport } = makeTransport([
      { status: 202, bodyText: "{}", headers: { "retry-after": "8" } },
    ])
    const d = makeInboundDispatcher(makeDeps({ transport }))
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "cold_start")
    if (r.kind === "cold_start") {
      assert.equal(r.retryAfterSec, 8)
    }
  })

  test("status 202 retryAfterSec clamps to 60", async () => {
    const { transport } = makeTransport([
      { status: 202, bodyText: '{"retryAfterSec":9999}' },
    ])
    const d = makeInboundDispatcher(makeDeps({ transport }))
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "cold_start")
    if (r.kind === "cold_start") {
      assert.equal(r.retryAfterSec, 60)
    }
  })
})

// ─── 5. Step 2a failure (master sqlite) ──────────────────────────────────

describe("inboundDispatcher — Step 2a master sqlite failure", () => {
  test("upsert throws → compensation called → step2_failed compensation=ok", async () => {
    const { transport, spy: tSpy } = makeTransport([
      { status: 200, bodyText: "{}" }, // step1
      { status: 200, bodyText: '{"ok":true}' }, // compensation
    ])
    const storage = makeStorageSpies({ upsertThrows: new Error("disk full") })
    const pg = makeFakePg({ pointer: null })
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        pgPool: pg.pg,
        upsertMasterClientSession: storage.upsertMasterClientSession,
        softDeleteMasterSession: storage.softDeleteMasterSession,
      }),
    )
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "step2_failed")
    if (r.kind === "step2_failed") {
      assert.equal(r.phase, "master_sqlite")
      assert.equal(r.compensation, "ok")
      assert.ok(r.errMessage.includes("disk full"))
    }
    assert.equal(tSpy.posts.length, 2)
    assert.equal(tSpy.posts[1]!.path, WECHAT_INBOUND_COMPENSATE_PATH)
    // pg pointer NOT written (failed before Step 2b)
    assert.equal(pg.spy.setCalls.length, 0)
    // softDelete NOT called (Step 2a 失败时还没 upsert 成功,无需撤)
    assert.equal(storage.spy.softDeleteCalls.length, 0)
  })

  test("compensation status 500 → compensation=failed", async () => {
    const { transport } = makeTransport([
      { status: 200, bodyText: "{}" }, // step1
      { status: 500, bodyText: "compensation handler crashed" }, // compensation
    ])
    const storage = makeStorageSpies({ upsertThrows: new Error("boom") })
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        upsertMasterClientSession: storage.upsertMasterClientSession,
        softDeleteMasterSession: storage.softDeleteMasterSession,
      }),
    )
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "step2_failed")
    if (r.kind === "step2_failed") assert.equal(r.compensation, "failed")
  })

  test("compensation 200 body {ok:false} → compensation=failed", async () => {
    const { transport } = makeTransport([
      { status: 200, bodyText: "{}" },
      { status: 200, bodyText: '{"ok":false,"code":"INTERNAL"}' },
    ])
    const storage = makeStorageSpies({ upsertThrows: new Error("boom") })
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        upsertMasterClientSession: storage.upsertMasterClientSession,
        softDeleteMasterSession: storage.softDeleteMasterSession,
      }),
    )
    const r = await d.dispatch(makeEvent())
    if (r.kind === "step2_failed") assert.equal(r.compensation, "failed")
    else assert.fail(`expected step2_failed, got ${r.kind}`)
  })

  test("compensation transport throws → compensation=failed", async () => {
    const { transport } = makeTransport([
      { status: 200, bodyText: "{}" },
      { throw: new Error("network down") },
    ])
    const storage = makeStorageSpies({ upsertThrows: new Error("boom") })
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        upsertMasterClientSession: storage.upsertMasterClientSession,
        softDeleteMasterSession: storage.softDeleteMasterSession,
      }),
    )
    const r = await d.dispatch(makeEvent())
    if (r.kind === "step2_failed") assert.equal(r.compensation, "failed")
    else assert.fail(`expected step2_failed, got ${r.kind}`)
  })
})

// ─── 6. Step 2b failure (pg pointer) ─────────────────────────────────────

describe("inboundDispatcher — Step 2b PG pointer failure", () => {
  test("newSession: pointer write throws → compensation + softDelete called → step2_failed pg_pointer compensation=ok", async () => {
    const { transport, spy: tSpy } = makeTransport([
      { status: 200, bodyText: "{}" }, // step1
      { status: 200, bodyText: '{"ok":true}' }, // compensation
    ])
    const storage = makeStorageSpies()
    const pg = makeFakePg({ pointer: null, throwOnSet: new Error("PG conn lost") })
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        pgPool: pg.pg,
        upsertMasterClientSession: storage.upsertMasterClientSession,
        softDeleteMasterSession: storage.softDeleteMasterSession,
      }),
    )
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "step2_failed")
    if (r.kind === "step2_failed") {
      assert.equal(r.phase, "pg_pointer")
      assert.equal(r.compensation, "ok")
    }
    assert.equal(tSpy.posts.length, 2)
    assert.equal(tSpy.posts[1]!.path, WECHAT_INBOUND_COMPENSATE_PATH)
    // softDelete 调用了
    assert.equal(storage.spy.softDeleteCalls.length, 1)
    assert.equal(storage.spy.softDeleteCalls[0]!.sessionId, FIXED_SESSION_ID)
    assert.equal(storage.spy.softDeleteCalls[0]!.userId, "c:42")
  })

  test("reuseSession: pointer write throws → SKIP compensation, SKIP softDelete → compensation=skipped_reuse", async () => {
    const { transport, spy: tSpy } = makeTransport([
      { status: 200, bodyText: "{}" }, // step1 only
      { throw: new Error("should not call compensation on reuse path") }, // safety
    ])
    const storage = makeStorageSpies()
    const pg = makeFakePg({
      pointer: "wsess-aaaaaaaaaaaaaaaa",
      throwOnSet: new Error("PG conn lost"),
    })
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        pgPool: pg.pg,
        upsertMasterClientSession: storage.upsertMasterClientSession,
        softDeleteMasterSession: storage.softDeleteMasterSession,
      }),
    )
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "step2_failed")
    if (r.kind === "step2_failed") {
      assert.equal(r.phase, "pg_pointer")
      assert.equal(r.compensation, "skipped_reuse")
    }
    // 只有 step1 这一次 POST,无 compensation
    assert.equal(tSpy.posts.length, 1)
    assert.equal(storage.spy.softDeleteCalls.length, 0)
  })

  test("newSession Step 2b fail + softDelete also throws → outcome 仍然是 step2_failed compensation=ok", async () => {
    const { transport } = makeTransport([
      { status: 200, bodyText: "{}" },
      { status: 200, bodyText: '{"ok":true}' },
    ])
    const storage = makeStorageSpies({ softDeleteThrows: new Error("sqlite locked") })
    const pg = makeFakePg({ pointer: null, throwOnSet: new Error("PG conn lost") })
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        pgPool: pg.pg,
        upsertMasterClientSession: storage.upsertMasterClientSession,
        softDeleteMasterSession: storage.softDeleteMasterSession,
      }),
    )
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "step2_failed")
    if (r.kind === "step2_failed") {
      // compensation 字段反映容器侧补偿状况(ok),master softDelete 失败仅 log,不改 outcome
      assert.equal(r.compensation, "ok")
    }
  })
})

// ─── 7. Wire body / headers correctness ─────────────────────────────────

describe("inboundDispatcher — wire correctness", () => {
  test("nonce header = HMAC(secret, 'inbound:' + containerId)", async () => {
    const { transport, spy } = makeTransport([{ status: 200, bodyText: "{}" }])
    const d = makeInboundDispatcher(makeDeps({ transport }))
    await d.dispatch(makeEvent())
    assert.equal(spy.posts[0]!.headers["x-openclaude-inbound-nonce"], expectedNonce())
    assert.equal(spy.posts[0]!.headers["x-openclaude-container-id"], String(CONTAINER_ID))
  })

  test("body idempotencyKey === evt.idempotencyKey", async () => {
    const { transport, spy } = makeTransport([{ status: 200, bodyText: "{}" }])
    const d = makeInboundDispatcher(makeDeps({ transport }))
    await d.dispatch(makeEvent({ idempotencyKey: "wx-seq-999" }))
    assert.equal(spy.posts[0]!.bodyParsed.idempotencyKey, "wx-seq-999")
  })

  test("body userId === 'c:' + bindingUserId (matches container handler c:<uid> regex)", async () => {
    const { transport, spy } = makeTransport([{ status: 200, bodyText: "{}" }])
    const d = makeInboundDispatcher(makeDeps({ transport }))
    await d.dispatch(makeEvent({ bindingUserId: "777" }))
    assert.equal(spy.posts[0]!.bodyParsed.userId, "c:777")
  })

  test("body peer.kind === 'dm' and peer.id === sessionId (broker 保证 1:1)", async () => {
    const { transport, spy } = makeTransport([{ status: 200, bodyText: "{}" }])
    const d = makeInboundDispatcher(makeDeps({ transport }))
    await d.dispatch(makeEvent())
    const peer = spy.posts[0]!.bodyParsed.peer as Record<string, unknown>
    assert.equal(peer.kind, "dm")
    assert.equal(peer.id, FIXED_SESSION_ID)
  })

  test("body peer.displayName === senderId (P1.7 slice 7c senderId carrier — outbox 需要)", async () => {
    // 设计契约:dispatcher 必须把 inbound senderId 透传进 wireBody.peer.displayName,
    // 容器侧 OutboundMessage.peer.displayName 才能保留到 v3WechatOutbound.send 读它构造
    // peer.meta.senderId POST 给 master /internal/v3/wechat-outbound(BodySchema 要求)。
    // 若 dispatcher 漏传,容器→master 出站会 zod 校验失败,WeChat 用户收不到 AI 回复。
    const { transport, spy } = makeTransport([{ status: 200, bodyText: "{}" }])
    const d = makeInboundDispatcher(makeDeps({ transport }))
    await d.dispatch(makeEvent())
    const peer = spy.posts[0]!.bodyParsed.peer as Record<string, unknown>
    assert.equal(peer.displayName, SENDER_ID)
  })

  test("body peer.displayName tracks per-event senderId override", async () => {
    // 多个 senderId 共享同一 bindingUserId(同一微信公众号下不同 follower 给 boss 发消息)
    // 时,每次 dispatch 的 wireBody.peer.displayName 必须等于本次 evt.senderId,而非任何
    // 缓存值或 pointer 复用 senderId。这条 lock-in:displayName 跟 evt 走,不跟 sessionId 走。
    const { transport, spy } = makeTransport([
      { status: 200, bodyText: "{}" },
      { status: 200, bodyText: "{}" },
    ])
    const d = makeInboundDispatcher(makeDeps({ transport }))
    await d.dispatch(makeEvent({ senderId: "wx-sender-alice" }))
    await d.dispatch(makeEvent({ senderId: "wx-sender-bob", idempotencyKey: "wx-seq-2" }))
    const peer0 = spy.posts[0]!.bodyParsed.peer as Record<string, unknown>
    const peer1 = spy.posts[1]!.bodyParsed.peer as Record<string, unknown>
    assert.equal(peer0.displayName, "wx-sender-alice")
    assert.equal(peer1.displayName, "wx-sender-bob")
  })

  test("body peer.id === reused sessionId when pointer existed", async () => {
    const { transport, spy } = makeTransport([{ status: 200, bodyText: "{}" }])
    const pg = makeFakePg({ pointer: "wsess-bbbbbbbbbbbbbbbb" })
    const d = makeInboundDispatcher(makeDeps({ transport, pgPool: pg.pg }))
    await d.dispatch(makeEvent())
    const peer = spy.posts[0]!.bodyParsed.peer as Record<string, unknown>
    assert.equal(peer.id, "wsess-bbbbbbbbbbbbbbbb")
  })

  test("body ts === evt.receivedAt (not dispatchNow)", async () => {
    const { transport, spy } = makeTransport([{ status: 200, bodyText: "{}" }])
    // 故意让 now() ≠ receivedAt,确认 wire body ts 取 receivedAt 而非 dispatchNow
    const d = makeInboundDispatcher(makeDeps({ transport, now: () => FIXED_NOW + 5_000 }))
    await d.dispatch(makeEvent({ receivedAt: FIXED_NOW }))
    assert.equal(spy.posts[0]!.bodyParsed.ts, FIXED_NOW)
  })

  test("resolveModel result is included in container wire body", async () => {
    const { transport, spy } = makeTransport([{ status: 200, bodyText: "{}" }])
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        resolveModel: async (bindingUserId) => {
          assert.equal(bindingUserId, BINDING_UID)
          return "claude-sonnet-4-6"
        },
      }),
    )
    await d.dispatch(makeEvent())
    assert.equal(spy.posts[0]!.bodyParsed.model, "claude-sonnet-4-6")
  })

  test("resolveModel null omits model field for backward compatibility", async () => {
    const { transport, spy } = makeTransport([{ status: 200, bodyText: "{}" }])
    const d = makeInboundDispatcher(makeDeps({ transport, resolveModel: async () => null }))
    await d.dispatch(makeEvent())
    assert.equal("model" in spy.posts[0]!.bodyParsed, false)
  })

  test("resolveModel throw is logged/ignored and still dispatches", async () => {
    const { transport, spy } = makeTransport([{ status: 200, bodyText: "{}" }])
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        resolveModel: async () => {
          throw new Error("prefs db down")
        },
      }),
    )
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "dispatched")
    assert.equal("model" in spy.posts[0]!.bodyParsed, false)
  })

  test("gpt model prepares Codex turn and injects requestId + api relay route", async () => {
    const { transport, spy } = makeTransport([{ status: 200, bodyText: "{}" }])
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        resolveModel: async () => "gpt-5.5",
        prepareCodexTurn: async (args) => {
          assert.equal(args.containerId, CONTAINER_ID)
          assert.equal(args.bindingUserId, BINDING_UID)
          assert.equal(args.userId, BigInt(BINDING_UID))
          assert.equal(args.modelId, "gpt-5.5")
          assert.equal(args.agentId, "main")
          return {
            kind: "ready",
            requestId: "0123456789abcdef0123456789abcdef",
            routeFrame: {
              baseUrl: "http://127.0.0.1:18789/internal/v3/codex-relay/route/abc",
              modelProvider: "route_provider",
              providerName: null,
              wireApi: "responses",
              preferredAuthMethod: "apikey",
              disableResponseStorage: true,
            },
          }
        },
      }),
    )
    await d.dispatch(makeEvent())
    assert.equal(spy.posts[0]!.bodyParsed.model, "gpt-5.5")
    assert.equal(spy.posts[0]!.bodyParsed.requestId, "0123456789abcdef0123456789abcdef")
    assert.deepEqual(
      spy.posts[0]!.bodyParsed.__oc_codex_route,
      {
        baseUrl: "http://127.0.0.1:18789/internal/v3/codex-relay/route/abc",
        modelProvider: "route_provider",
        providerName: null,
        wireApi: "responses",
        preferredAuthMethod: "apikey",
        disableResponseStorage: true,
      },
    )
  })

  test("non-gpt model does not prepare Codex turn", async () => {
    const { transport, spy } = makeTransport([{ status: 200, bodyText: "{}" }])
    let prepareCalls = 0
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        resolveModel: async () => "claude-sonnet-4-6",
        prepareCodexTurn: async () => {
          prepareCalls++
          throw new Error("should not be called")
        },
      }),
    )
    await d.dispatch(makeEvent())
    assert.equal(prepareCalls, 0)
    assert.equal("requestId" in spy.posts[0]!.bodyParsed, false)
    assert.equal("__oc_codex_route" in spy.posts[0]!.bodyParsed, false)
  })

  test("prepareCodexTurn unavailable returns local reply and does not POST", async () => {
    const { transport, spy } = makeTransport([{ status: 200, bodyText: "{}" }])
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        resolveModel: async () => "gpt-5.5",
        prepareCodexTurn: async () => ({ kind: "unavailable", reply: "GPT unavailable" }),
      }),
    )
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "command_echo")
    if (r.kind === "command_echo") assert.equal(r.reply, "GPT unavailable")
    assert.equal(spy.posts.length, 0)
  })

  test("definite Step1 4xx failure aborts prepared Codex turn", async () => {
    const { transport } = makeTransport([{ status: 400, bodyText: "bad route" }])
    const failed: string[] = []
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        resolveModel: async () => "gpt-5.5",
        prepareCodexTurn: async () => ({
          kind: "ready",
          requestId: "0123456789abcdef0123456789abcdef",
          routeFrame: {
            baseUrl: "http://127.0.0.1:18789/internal/v3/codex-relay/route/abc",
            modelProvider: "route_provider",
            providerName: null,
            wireApi: "responses",
            preferredAuthMethod: "apikey",
            disableResponseStorage: true,
          },
        }),
        failCodexTurn: async (requestId, reason) => {
          failed.push(`${requestId}:${reason}`)
        },
      }),
    )
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "container_rejected")
    assert.deepEqual(failed, ["0123456789abcdef0123456789abcdef:wechat_container_rejected_400"])
  })

  test("ambiguous Step1 transport failure leaves prepared Codex turn for timeout cleanup", async () => {
    const { transport } = makeTransport([
      { throw: new Error("timeout 1") },
      { throw: new Error("timeout 2") },
    ])
    let failCalls = 0
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        resolveModel: async () => "gpt-5.5",
        prepareCodexTurn: async () => ({
          kind: "ready",
          requestId: "0123456789abcdef0123456789abcdef",
          routeFrame: {
            baseUrl: "http://127.0.0.1:18789/internal/v3/codex-relay/route/abc",
            modelProvider: "route_provider",
            providerName: null,
            wireApi: "responses",
            preferredAuthMethod: "apikey",
            disableResponseStorage: true,
          },
        }),
        failCodexTurn: async () => {
          failCalls++
        },
      }),
    )
    const r = await d.dispatch(makeEvent())
    assert.equal(r.kind, "transport_failed")
    assert.equal(failCalls, 0)
  })

  test("body content === { text } (no kind / no rawItemTypes / no sessionMeta)", async () => {
    const { transport, spy } = makeTransport([{ status: 200, bodyText: "{}" }])
    const d = makeInboundDispatcher(makeDeps({ transport }))
    await d.dispatch(makeEvent({ text: "你好" }))
    const body = spy.posts[0]!.bodyParsed as Record<string, unknown>
    assert.deepEqual(body.content, { text: "你好" })
    assert.equal("rawItemTypes" in body, false)
    assert.equal("sessionMeta" in body, false)
    assert.equal("wechatBindingUserId" in body, false)
    assert.equal("wechatSenderId" in body, false)
    assert.equal("wechatMessageId" in body, false)
    assert.equal("wechatTs" in body, false)
    assert.equal("sessionId" in body, false)
  })

  test("file-send request gets WeChat outbound attachment guidance in dispatch text", async () => {
    const { transport, spy } = makeTransport([{ status: 200, bodyText: "{}" }])
    const d = makeInboundDispatcher(makeDeps({ transport }))
    await d.dispatch(makeEvent({ text: "随便发我一个文件" }))
    const body = spy.posts[0]!.bodyParsed as Record<string, unknown>
    const content = body.content as { text: string }
    assert.match(content.text, /^随便发我一个文件/)
    assert.match(content.text, /微信通道系统提示：发送附件/)
    assert.match(content.text, /\/home\/agent\/\.openclaude\/generated\/<安全文件名\.ext>/)
    assert.match(content.text, /example\.txt/)
    assert.match(content.text, /不要声称已经发给用户/)
  })

  test("non-attachment text with similar verb is not polluted by file-send guidance", async () => {
    const { transport, spy } = makeTransport([{ status: 200, bodyText: "{}" }])
    const d = makeInboundDispatcher(makeDeps({ transport }))
    await d.dispatch(makeEvent({ text: "发散思维一下，讲讲产品设计" }))
    const body = spy.posts[0]!.bodyParsed as Record<string, unknown>
    assert.deepEqual(body.content, { text: "发散思维一下，讲讲产品设计" })
  })

  test("agentId defaults to 'main' when omitted", async () => {
    const { transport, spy } = makeTransport([{ status: 200, bodyText: "{}" }])
    const storage = makeStorageSpies()
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        upsertMasterClientSession: storage.upsertMasterClientSession,
        softDeleteMasterSession: storage.softDeleteMasterSession,
      }),
    )
    const evt: InboundEvent = {
      bindingUserId: BINDING_UID,
      senderId: SENDER_ID,
      text: "你好",
      idempotencyKey: "k1",
      receivedAt: FIXED_NOW,
    }
    await d.dispatch(evt)
    assert.equal(spy.posts[0]!.bodyParsed.agentId, "main")
    assert.equal(storage.spy.upsertCalls[0]!.agentId, "main")
  })

  test("agentId override transparently passed", async () => {
    const { transport, spy } = makeTransport([{ status: 200, bodyText: "{}" }])
    const storage = makeStorageSpies()
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        upsertMasterClientSession: storage.upsertMasterClientSession,
        softDeleteMasterSession: storage.softDeleteMasterSession,
      }),
    )
    await d.dispatch(makeEvent({ agentId: "codex" }))
    assert.equal(spy.posts[0]!.bodyParsed.agentId, "codex")
    assert.equal(storage.spy.upsertCalls[0]!.agentId, "codex")
  })

  test("createdAt === lastAt in upsert (stable now() timestamp)", async () => {
    let counter = 0
    const { transport } = makeTransport([{ status: 200, bodyText: "{}" }])
    const storage = makeStorageSpies()
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        upsertMasterClientSession: storage.upsertMasterClientSession,
        softDeleteMasterSession: storage.softDeleteMasterSession,
        now: () => FIXED_NOW + counter++, // 每次调用 +1
      }),
    )
    await d.dispatch(makeEvent())
    const u = storage.spy.upsertCalls[0]!
    // 即使 now() 每次调用都 +1,upsert 收到的 createdAt 和 lastAt 必须相等
    // (dispatcher 实现要 pin 一次 now() 用到底)
    assert.equal(u.createdAt, u.lastAt)
  })
})

// ─── 8. title derivation ─────────────────────────────────────────────────

describe("inboundDispatcher — title derivation", () => {
  test("normal text → first 30 chars", async () => {
    const { transport, spy } = makeTransport([{ status: 200, bodyText: "{}" }])
    const storage = makeStorageSpies()
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        upsertMasterClientSession: storage.upsertMasterClientSession,
        softDeleteMasterSession: storage.softDeleteMasterSession,
      }),
    )
    const longText = "你好世界," + "a".repeat(100)
    await d.dispatch(makeEvent({ text: longText }))
    const title = storage.spy.upsertCalls[0]!.title
    assert.equal(Array.from(title).length, 30)
  })

  test("whitespace only → DEFAULT title '微信会话'", async () => {
    const { transport } = makeTransport([{ status: 200, bodyText: "{}" }])
    const storage = makeStorageSpies()
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        upsertMasterClientSession: storage.upsertMasterClientSession,
        softDeleteMasterSession: storage.softDeleteMasterSession,
      }),
    )
    await d.dispatch(makeEvent({ text: "   \n\t " }))
    assert.equal(storage.spy.upsertCalls[0]!.title, "微信会话")
  })

  test("surrogate-pair emoji not split", async () => {
    const { transport } = makeTransport([{ status: 200, bodyText: "{}" }])
    const storage = makeStorageSpies()
    const d = makeInboundDispatcher(
      makeDeps({
        transport,
        upsertMasterClientSession: storage.upsertMasterClientSession,
        softDeleteMasterSession: storage.softDeleteMasterSession,
      }),
    )
    // 🚀 是 U+1F680 (surrogate pair),naive slice(0,1) 会取半个 surrogate 出乱码
    await d.dispatch(makeEvent({ text: "🚀".repeat(50) }))
    const title = storage.spy.upsertCalls[0]!.title
    // 30 code points = 30 个 🚀
    assert.equal(Array.from(title).length, 30)
    // 每个 code point 都是完整的 🚀
    for (const cp of Array.from(title)) {
      assert.equal(cp, "🚀")
    }
  })
})
