/**
 * v3 commercial wechat broker — slice 4c singleton 单测。
 *
 * 覆盖矩阵(Plan v2 review PASS 后):
 *   - lifecycle:start / stop / start→stop→start / start 幂等 / stop 等 inFlight
 *   - onInbound:never-throw 契约、disabled gate、dispatcher 抛 → broker_failed、
 *               command_echo / cold_start 触 sendText fire-and-forget、其他 outcome 透传
 *   - sendReflection:binding 缺 / contextToken 缺 / sendText 同步 throw / 返 ok=false
 *   - outboundHandler:disabled 403 + 安全头 / enabled 透传 inner
 *   - reconcile:single snapshot、orphan softDelete 调用、softDelete 抛不影响其他、
 *               disabled 跳过、grace 期透传
 *   - housekeeping:调 runHousekeeping、disabled 跳过、runHousekeeping 抛不崩
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/wechatBroker.test.ts
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import type { IncomingMessage, ServerResponse } from "node:http"
import { Readable } from "node:stream"
import type { Pool } from "pg"

import {
  makeWechatBroker,
  type BrokerDeps,
  type BrokerInboundOutcome,
} from "../wechat/broker.js"
import type {
  DispatchOutcome,
  InboundDispatcher,
  InboundEvent,
} from "../wechat/inboundDispatcher.js"
import type {
  OutboundReceiverCtx,
  OutboundReceiverHandler,
} from "../wechat/outboundReceiver.js"
import type { SendResult, SendTextFn, GetBindingFn } from "../wechat/outboxWorker.js"
import type { WechatSessionId } from "../wechat/types.js"

// ─── fixtures ──────────────────────────────────────────────────────────────

const FIXED_NOW = 1_700_000_000_000
const SESSION_A = "wsess-aaaaaaaaaaaaaaaa" as WechatSessionId
const SESSION_B = "wsess-bbbbbbbbbbbbbbbb" as WechatSessionId

function makeEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    bindingUserId: "42",
    senderId: "wx-sender-1",
    text: "你好",
    idempotencyKey: "wx-msg-1",
    agentId: "main",
    receivedAt: FIXED_NOW - 100,
    traceId: "trc-1",
    ...overrides,
  }
}

interface DispatcherSpy {
  calls: InboundEvent[]
  stopCalls: InboundEvent[]
}

function makeDispatcher(
  responder:
    | DispatchOutcome
    | ((evt: InboundEvent) => DispatchOutcome | Promise<DispatchOutcome>)
    | { throw: Error },
): { dispatcher: InboundDispatcher; spy: DispatcherSpy } {
  const spy: DispatcherSpy = { calls: [], stopCalls: [] }
  const dispatcher: InboundDispatcher = {
    async dispatch(evt: InboundEvent): Promise<DispatchOutcome> {
      spy.calls.push(evt)
      if (typeof responder === "object" && responder !== null && "throw" in responder) {
        throw responder.throw
      }
      if (typeof responder === "function") {
        return await responder(evt)
      }
      return responder
    },
    async stop(evt: InboundEvent) {
      spy.stopCalls.push(evt)
      return { kind: "command_echo", interrupted: true, reply: "已发送中断指令。" }
    },
  }
  return { dispatcher, spy }
}

interface ReceiverSpy {
  calls: Array<{ method: string; url: string; ctx: OutboundReceiverCtx }>
}

function makeReceiverHandler(): { handler: OutboundReceiverHandler; spy: ReceiverSpy } {
  const spy: ReceiverSpy = { calls: [] }
  const handler: OutboundReceiverHandler = async (req, res, ctx) => {
    spy.calls.push({ method: req.method ?? "?", url: req.url ?? "?", ctx })
    res.writeHead(200, { "content-type": "application/json" })
    res.end('{"ok":true,"inner":true}')
  }
  return { handler, spy }
}

interface SendTextSpy {
  calls: Parameters<SendTextFn>[0][]
}

function makeSendText(
  responder:
    | SendResult
    | ((p: Parameters<SendTextFn>[0]) => SendResult | Promise<SendResult>)
    | { throwSync: Error }
    | { throwAsync: Error },
): { sendText: SendTextFn; spy: SendTextSpy } {
  const spy: SendTextSpy = { calls: [] }
  const sendText: SendTextFn = (p) => {
    spy.calls.push(p)
    if (responder && typeof responder === "object" && "throwSync" in responder) {
      throw responder.throwSync
    }
    if (responder && typeof responder === "object" && "throwAsync" in responder) {
      return Promise.reject(responder.throwAsync)
    }
    if (typeof responder === "function") {
      return Promise.resolve().then(() => responder(p))
    }
    return Promise.resolve(responder as SendResult)
  }
  return { sendText, spy }
}

interface BindingSpy {
  calls: string[]
}

function makeGetBinding(
  result: { botToken: string; contextTokens: Record<string, string> } | null | { throw: Error },
): { getBinding: GetBindingFn; spy: BindingSpy } {
  const spy: BindingSpy = { calls: [] }
  const getBinding: GetBindingFn = async (uid) => {
    spy.calls.push(uid)
    if (result && typeof result === "object" && "throw" in result) throw result.throw
    return result
  }
  return { getBinding, spy }
}

interface AllRowsSpy {
  calls: number
}

function makeAllMasterWsessRows(
  rows: Array<{ id: WechatSessionId; userId: string; createdAt: number }>,
): { fn: BrokerDeps["allMasterWsessRows"]; spy: AllRowsSpy } {
  const spy: AllRowsSpy = { calls: 0 }
  const fn = async () => {
    spy.calls++
    return rows
  }
  return { fn, spy }
}

interface SoftDelSpy {
  calls: Array<{ sessionId: WechatSessionId; userId: string }>
}

function makeSoftDelete(opts: { throwFor?: WechatSessionId } = {}): {
  fn: BrokerDeps["softDeleteMasterSession"]
  spy: SoftDelSpy
} {
  const spy: SoftDelSpy = { calls: [] }
  const fn = async (sessionId: WechatSessionId, userId: string) => {
    spy.calls.push({ sessionId, userId })
    if (opts.throwFor && sessionId === opts.throwFor) {
      throw new Error(`simulated softDelete failure for ${sessionId}`)
    }
  }
  return { fn, spy }
}

/**
 * Fake Pool — broker 主要走 sessionPointer.activeWsessIdsFromPg + outboxWorker housekeeping。
 * 这里覆盖最小 SQL 集:
 *   - SELECT current_session_id FROM wechat_session_pointer → 返 `activeIds`
 *   - 其他 SQL → 0 rows rowCount=0(housekeeping 等 DELETE/UPDATE 都不会真生效,这是测试期望)
 */
function makeFakePool(opts: {
  activeIds?: string[]
  pointerSessionId?: string | null
  deletePointerRowCount?: number
} = {}): { pool: Pool; calls: string[] } {
  const calls: string[] = []
  const activeIds = opts.activeIds ?? []
  const respond = (sql: string): { rows: Record<string, unknown>[]; rowCount: number | null } => {
    calls.push(sql)
    if (/SELECT current_session_id FROM wechat_session_pointer WHERE binding_user_id/i.test(sql)) {
      if (opts.pointerSessionId) {
        return { rows: [{ current_session_id: opts.pointerSessionId }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    if (/DELETE FROM wechat_session_pointer WHERE binding_user_id/i.test(sql)) {
      return {
        rows: [],
        rowCount: opts.deletePointerRowCount ?? (opts.pointerSessionId ? 1 : 0),
      }
    }
    if (/SELECT current_session_id FROM wechat_session_pointer/i.test(sql)) {
      return {
        rows: activeIds.map((id) => ({ current_session_id: id })),
        rowCount: activeIds.length,
      }
    }
    // outboxWorker.runHousekeeping / pickOne 路径都走这里 — 0 rows ok
    return { rows: [], rowCount: 0 }
  }
  const fakeClient = {
    query: async (sql: string, _params?: ReadonlyArray<unknown>) => respond(sql),
    release: () => {},
  }
  const pool = {
    query: async (sql: string, _params?: ReadonlyArray<unknown>) => respond(sql),
    connect: async () => fakeClient,
  } as unknown as Pool
  return { pool, calls }
}

interface BaseDepsOverrides {
  dispatcher?: InboundDispatcher
  outboundReceiver?: OutboundReceiverHandler
  sendText?: SendTextFn
  wechatUxCommands?: BrokerDeps["wechatUxCommands"]
  wechatProcessVisibility?: BrokerDeps["wechatProcessVisibility"]
  saveWechatImages?: BrokerDeps["saveWechatImages"]
  getBinding?: GetBindingFn
  allMasterWsessRows?: BrokerDeps["allMasterWsessRows"]
  softDeleteMasterSession?: BrokerDeps["softDeleteMasterSession"]
  brokerEnabled?: () => boolean
  pool?: Pool
  now?: () => number
  reconcileIntervalMs?: number
  housekeepingIntervalMs?: number
  reconcileGraceMs?: number
  outboxWorker?: BrokerDeps["outboxWorker"]
}

function makeDeps(overrides: BaseDepsOverrides = {}): BrokerDeps {
  const dispatcher = overrides.dispatcher ?? makeDispatcher({
    kind: "dispatched",
    sessionId: SESSION_A,
    newSession: false,
  }).dispatcher
  const outboundReceiver = overrides.outboundReceiver ?? makeReceiverHandler().handler
  const sendText = overrides.sendText ?? makeSendText({ ok: true }).sendText
  const getBinding =
    overrides.getBinding ?? makeGetBinding({ botToken: "tok", contextTokens: { "wx-sender-1": "ctx-1" } }).getBinding
  const allMasterWsessRows = overrides.allMasterWsessRows ?? makeAllMasterWsessRows([]).fn
  const softDeleteMasterSession = overrides.softDeleteMasterSession ?? makeSoftDelete().fn
  const brokerEnabled = overrides.brokerEnabled ?? (() => true)
  const pool = overrides.pool ?? makeFakePool().pool
  return {
    pgPool: pool,
    dispatcher,
    outboundReceiver,
    allMasterWsessRows,
    softDeleteMasterSession,
    sendText,
    wechatUxCommands: overrides.wechatUxCommands,
    wechatProcessVisibility: overrides.wechatProcessVisibility,
    saveWechatImages: overrides.saveWechatImages,
    getBinding,
    brokerEnabled,
    now: overrides.now ?? (() => FIXED_NOW),
    reconcileIntervalMs: overrides.reconcileIntervalMs,
    housekeepingIntervalMs: overrides.housekeepingIntervalMs,
    reconcileGraceMs: overrides.reconcileGraceMs,
    outboxWorker: overrides.outboxWorker,
  }
}

// ─── HTTP fixture helpers(参 wechatOutboundReceiver.test.ts 同款) ────────────

function makeReq(opts: { method?: string; url?: string; auth?: string } = {}): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage
  req.method = opts.method ?? "POST"
  req.url = opts.url ?? "/internal/v3/wechat-outbound"
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

const CTX: OutboundReceiverCtx = { hostUuid: "host-1", boundIp: "172.30.0.5" }

/** 等下一个 microtask flush — fire-and-forget reflection 是 microtask 异步。 */
async function flushMicrotasks(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
  }
}

// ─── 1. lifecycle ──────────────────────────────────────────────────────────

describe("wechatBroker — lifecycle", () => {
  test("start() 启动后 stop() 能干净停下来,不抛", async () => {
    const broker = makeWechatBroker(makeDeps())
    broker.start()
    await broker.stop()
    // 走到这里没抛即可。
    assert.ok(true)
  })

  test("start() 是幂等的:连续 start 两次不会双开 timer", async () => {
    const allRows = makeAllMasterWsessRows([])
    const broker = makeWechatBroker(
      makeDeps({
        allMasterWsessRows: allRows.fn,
        reconcileIntervalMs: 60_000, // 大值,避免 schedule 后再触发干扰断言
      }),
    )
    broker.start()
    broker.start() // 不应该再启动一次
    // 给 setTimeout(0) 跑一遍
    await new Promise((r) => setTimeout(r, 20))
    await broker.stop()
    // 首轮 reconcile tick 应该只跑一次,而不是两次(否则 spy.calls=2)
    assert.equal(allRows.spy.calls, 1, `expected 1 reconcile call, got ${allRows.spy.calls}`)
  })

  test("start → stop → start 循环:第二次 start 必须重置 stopFlag(否则 timer 不再 schedule)", async () => {
    const allRows = makeAllMasterWsessRows([])
    const broker = makeWechatBroker(
      makeDeps({ allMasterWsessRows: allRows.fn, reconcileIntervalMs: 60_000 }),
    )
    broker.start()
    await new Promise((r) => setTimeout(r, 10))
    await broker.stop()
    const callsAfterFirst = allRows.spy.calls
    assert.ok(callsAfterFirst >= 1)

    broker.start()
    await new Promise((r) => setTimeout(r, 10))
    await broker.stop()
    // 第二轮启动后 reconcile 必须再跑过一次
    assert.ok(
      allRows.spy.calls > callsAfterFirst,
      `expected reconcile to run again after restart, got ${allRows.spy.calls}`,
    )
  })

  test("stop() 等 inFlight reconcile 跑完后再返回(slow allMasterWsessRows)", async () => {
    let resolveSlow: (() => void) | undefined
    const slow = new Promise<void>((r) => {
      resolveSlow = r
    })
    let rowsResolved = false
    const allMasterWsessRows: BrokerDeps["allMasterWsessRows"] = async () => {
      await slow
      rowsResolved = true
      return []
    }
    const broker = makeWechatBroker(
      makeDeps({ allMasterWsessRows, reconcileIntervalMs: 60_000 }),
    )
    broker.start()
    // 让 setTimeout(0) 把 tickReconcile 推进 inFlight
    await new Promise((r) => setTimeout(r, 5))
    const stopPromise = broker.stop()
    // 立刻 resolve slow tick
    resolveSlow!()
    await stopPromise
    assert.equal(rowsResolved, true, "stop() 应该等 inFlight tickReconcile 走完")
  })

  test("brokerEnabled = false 启动:reconcile / housekeeping tick 跳过(allMasterWsessRows 不被调)", async () => {
    const allRows = makeAllMasterWsessRows([])
    const broker = makeWechatBroker(
      makeDeps({
        brokerEnabled: () => false,
        allMasterWsessRows: allRows.fn,
        reconcileIntervalMs: 60_000,
      }),
    )
    broker.start()
    await new Promise((r) => setTimeout(r, 10))
    await broker.stop()
    assert.equal(allRows.spy.calls, 0, "disabled 状态下 reconcile 不应触发")
  })

  test("brokerEnabled() callback 抛 → broker 视为 disabled(防御性兜底)", async () => {
    const allRows = makeAllMasterWsessRows([])
    const broker = makeWechatBroker(
      makeDeps({
        brokerEnabled: () => {
          throw new Error("config service down")
        },
        allMasterWsessRows: allRows.fn,
        reconcileIntervalMs: 60_000,
      }),
    )
    broker.start()
    await new Promise((r) => setTimeout(r, 10))
    await broker.stop()
    assert.equal(allRows.spy.calls, 0)
  })

  test("stop() 不抛即使 start() 未被调用过", async () => {
    const broker = makeWechatBroker(makeDeps())
    await broker.stop()
    assert.ok(true)
  })

  test("stop() 多次连续调用也不抛(幂等)", async () => {
    const broker = makeWechatBroker(makeDeps())
    broker.start()
    await broker.stop()
    await broker.stop()
    assert.ok(true)
  })

  test("start/stop race:start() 在 stop() inFlight 期间调入 → await stop 完成后 broker 已重启", async () => {
    // Codex r5 IMPORTANT#1:旧实现 start() 看到 inFlight 就早退,等 stop 完成留下
    // stopFlag=true、timer 都已清,重启意图被吞掉。新实现用 stoppingPromise +
    // restartRequested 双 flag,在 stop 的 finally 里完成重启。
    let resolveSlow: (() => void) | undefined
    const slow = new Promise<void>((r) => {
      resolveSlow = r
    })
    let secondTickRan = false
    let tickCount = 0
    const allMasterWsessRows: BrokerDeps["allMasterWsessRows"] = async () => {
      tickCount++
      if (tickCount === 1) {
        // 第一次 tick 卡住直到测试 release
        await slow
      } else {
        // 第二次 tick = 重启后 doStart 调度的第一次 tick
        secondTickRan = true
      }
      return []
    }
    const broker = makeWechatBroker(
      makeDeps({ allMasterWsessRows, reconcileIntervalMs: 60_000 }),
    )

    broker.start()
    // 让 setTimeout(0) 把第一次 tickReconcile 推进 inFlight
    await new Promise((r) => setTimeout(r, 10))

    // 此刻 reconcileInFlight 非空(等 slow);开始 stop 但不 await
    const stopPromise = broker.stop()
    // stop 还在 await Promise.allSettled([inFlight]) → 在此 race window 内调 start
    broker.start()
    // release 第一轮 tick → IIFE 完成 → finally 看到 restartRequested=true → doStart
    resolveSlow!()
    await stopPromise

    // 等第二轮 reconcile tick(由 doStart 调度的 delay=0 setTimeout)走起来
    await new Promise((r) => setTimeout(r, 20))

    // 最终清理
    await broker.stop()

    assert.equal(
      secondTickRan,
      true,
      "stop 完成后 broker 应该已经重启并跑了第二轮 reconcile tick",
    )
  })

  test("start/stop race:start → stop → stop 双 stop 取消 pending restart(最后动作=stop 时不能 RUNNING 收尾)", async () => {
    // start; stopP=stop; start (此时 restartRequested=true); stop (第二次,应该取消
    // restartRequested);await stopP;期望:broker 停止,**没有**重启。
    let resolveSlow: (() => void) | undefined
    const slow = new Promise<void>((r) => {
      resolveSlow = r
    })
    let tickCount = 0
    const allMasterWsessRows: BrokerDeps["allMasterWsessRows"] = async () => {
      tickCount++
      if (tickCount === 1) await slow
      return []
    }
    const broker = makeWechatBroker(
      makeDeps({ allMasterWsessRows, reconcileIntervalMs: 60_000 }),
    )

    broker.start()
    await new Promise((r) => setTimeout(r, 10))

    const stopPromise1 = broker.stop()
    broker.start() // 在 stop 进行中 → restartRequested=true
    const stopPromise2 = broker.stop() // 第二次 stop → 取消 restartRequested

    resolveSlow!()
    await Promise.all([stopPromise1, stopPromise2])

    // 给 setTimeout 机会调度新一轮 tick(若错误地重启了的话)
    await new Promise((r) => setTimeout(r, 30))

    // 必须停在 1 — 不能有第二轮 tick(意味着没重启)
    assert.equal(tickCount, 1, `expected tickCount=1 (no restart), got ${tickCount}`)
  })
})

// ─── 2. onInbound ──────────────────────────────────────────────────────────

describe("wechatBroker — onInbound", () => {
  test("brokerEnabled = false → broker_disabled,不触 dispatcher", async () => {
    const { dispatcher, spy } = makeDispatcher({
      kind: "dispatched",
      sessionId: SESSION_A,
      newSession: false,
    })
    const broker = makeWechatBroker(
      makeDeps({ dispatcher, brokerEnabled: () => false }),
    )
    const r: BrokerInboundOutcome = await broker.onInbound(makeEvent())
    assert.equal(r.kind, "broker_disabled")
    assert.equal(spy.calls.length, 0)
  })

  test("brokerEnabled() 抛 → broker_disabled,never throw", async () => {
    const { dispatcher, spy } = makeDispatcher({
      kind: "dispatched",
      sessionId: SESSION_A,
      newSession: false,
    })
    const broker = makeWechatBroker(
      makeDeps({
        dispatcher,
        brokerEnabled: () => {
          throw new Error("flag service down")
        },
      }),
    )
    const r = await broker.onInbound(makeEvent())
    assert.equal(r.kind, "broker_disabled")
    assert.equal(spy.calls.length, 0)
  })

  test("dispatcher 抛 → broker_failed,never throw 出 broker", async () => {
    const { sendText, spy: sendSpy } = makeSendText({ ok: true })
    const { dispatcher } = makeDispatcher({ throw: new Error("dispatcher crashed") })
    const broker = makeWechatBroker(makeDeps({ dispatcher, sendText }))
    const r = await broker.onInbound(makeEvent())
    assert.equal(r.kind, "broker_failed")
    if (r.kind === "broker_failed") {
      assert.ok(r.errMessage.includes("dispatcher crashed"))
    }
    await flushMicrotasks()
    assert.equal(sendSpy.calls.length, 1)
    assert.match(sendSpy.calls[0]!.text, /没能送到执行环境/)
  })

  // ── bindingUserId 归一(commercial canonical `c:N` → dispatcher raw `N`) ──
  //
  // 这条契约的两侧:
  //   - dispatcher 期待 raw digit(BigInt() + MASTER_USER_PREFIX + bindingUserId
  //     的内部使用、gateway compensate handler 的 ^[1-9][0-9]{0,18}$ regex)
  //   - reflection 经 getBinding 查 master sqlite wechat_bindings.user_id,
  //     该列 v3 commercial 存 `c:N` canonical 形式
  //
  // broker 在 onInbound 中做翻译:dispatch 路径用 raw,reflection 路径用 canonical。
  // 这俩测试同时锁住这两边契约,任何一边走样都会触发。
  test("bindingUserId 归一:'c:1' → dispatcher 收到 '1',reflection getBinding 收到 'c:1'", async () => {
    const { sendText, spy: sendSpy } = makeSendText({ ok: true })
    // dispatcher 命令短路 → 走 command_echo,触发 reflection 路径
    const { dispatcher, spy: dispSpy } = makeDispatcher({
      kind: "command_echo",
      reply: "echo",
    })
    const { getBinding, spy: getBindingSpy } = makeGetBinding({
      botToken: "tok",
      contextTokens: { "wx-sender-1": "ctx-1" },
    })
    const broker = makeWechatBroker(
      makeDeps({ dispatcher, sendText, getBinding }),
    )
    const r = await broker.onInbound(makeEvent({ bindingUserId: "c:1", text: "/echo" }))
    assert.equal(r.kind, "command_echo")
    await flushMicrotasks()
    // dispatcher 看到的是 normalized raw digit
    assert.equal(dispSpy.calls.length, 1)
    assert.equal(
      dispSpy.calls[0]!.bindingUserId,
      "1",
      "dispatcher 必须收到 raw digit(c: 前缀被 broker 剥掉)",
    )
    // reflection 看到的是 canonical c:N(用于 sqlite getBinding 主键)
    assert.deepEqual(
      getBindingSpy.calls,
      ["c:1"],
      "getBinding 必须收到 commercial canonical 形式(c:1),与 wechat_bindings.user_id 主键对齐",
    )
    // 反射 sendText 走出去
    assert.equal(sendSpy.calls.length, 1)
  })

  test("bindingUserId 归一:裸 '42'(无 c: 前缀)幂等透传给 dispatcher 和 reflection", async () => {
    const { sendText, spy: sendSpy } = makeSendText({ ok: true })
    const { dispatcher, spy: dispSpy } = makeDispatcher({
      kind: "command_echo",
      reply: "echo",
    })
    const { getBinding, spy: getBindingSpy } = makeGetBinding({
      botToken: "tok",
      contextTokens: { "wx-sender-1": "ctx-1" },
    })
    const broker = makeWechatBroker(
      makeDeps({ dispatcher, sendText, getBinding }),
    )
    const r = await broker.onInbound(makeEvent({ bindingUserId: "42", text: "/echo" }))
    assert.equal(r.kind, "command_echo")
    await flushMicrotasks()
    assert.equal(dispSpy.calls[0]!.bindingUserId, "42", "无前缀输入幂等")
    assert.deepEqual(
      getBindingSpy.calls,
      ["42"],
      "无前缀输入下 reflection 也传 raw digit(测试 fixture / personal-OC 历史路径)",
    )
    assert.equal(sendSpy.calls.length, 1)
  })

  test("bindingUserId 非法形式(如 'c:abc')→ broker_failed,dispatcher 不被触", async () => {
    const { dispatcher, spy: dispSpy } = makeDispatcher({
      kind: "command_echo",
      reply: "echo",
    })
    const broker = makeWechatBroker(makeDeps({ dispatcher }))
    const r = await broker.onInbound(makeEvent({ bindingUserId: "c:abc" }))
    assert.equal(r.kind, "broker_failed")
    if (r.kind === "broker_failed") {
      assert.ok(
        r.errMessage.includes("invalid bindingUserId"),
        "errMessage 应明确指向非法 bindingUserId",
      )
    }
    assert.equal(
      dispSpy.calls.length,
      0,
      "非法形式必须在 broker 入口拦截,不能让 dispatcher BigInt() 抛",
    )
  })

  test("dispatcher → dispatched outcome 透传,并发送实时过程链接反射", async () => {
    const { sendText, spy: sendSpy } = makeSendText({ ok: true })
    const { dispatcher } = makeDispatcher({
      kind: "dispatched",
      sessionId: SESSION_A,
      newSession: true,
    })
    const broker = makeWechatBroker(makeDeps({ dispatcher, sendText }))
    const r = await broker.onInbound(makeEvent())
    assert.equal(r.kind, "dispatched")
    await flushMicrotasks()
    assert.equal(sendSpy.calls.length, 1)
    assert.match(sendSpy.calls[0]!.text, /实时过程：https:\/\/claudeai\.chat\/\?session=wsess-/)
    assert.match(sendSpy.calls[0]!.text, /\/stop/)
  })

  test("dispatcher started=false outcome does not send stale realtime process link", async () => {
    const { sendText, spy: sendSpy } = makeSendText({ ok: true })
    const { dispatcher } = makeDispatcher({
      kind: "dispatched",
      sessionId: SESSION_A,
      newSession: true,
      started: false,
    } as DispatchOutcome)
    const broker = makeWechatBroker(makeDeps({ dispatcher, sendText }))
    const r = await broker.onInbound(makeEvent({ text: "会触发快速失败" }))
    assert.equal(r.kind, "dispatched")
    await flushMicrotasks()
    assert.equal(sendSpy.calls.length, 0)
  })

  test("dispatcher pre-dispatch failure sends visible retry hint instead of going silent", async () => {
    const { sendText, spy: sendSpy } = makeSendText({ ok: true })
    const { dispatcher } = makeDispatcher({
      kind: "transport_failed",
      phase: "step1",
      retryable: true,
      errMessage: "connect ECONNREFUSED",
    })
    const broker = makeWechatBroker(makeDeps({ dispatcher, sendText }))
    const r = await broker.onInbound(makeEvent({ text: "hello" }))
    assert.equal(r.kind, "transport_failed")
    await flushMicrotasks()
    assert.equal(sendSpy.calls.length, 1)
    assert.match(sendSpy.calls[0]!.text, /稍后重试/)
    assert.doesNotMatch(sendSpy.calls[0]!.text, /实时过程/)
  })

  test("broker-local /stop delegates to dispatcher.stop and reflects result", async () => {
    const { sendText, spy: sendSpy } = makeSendText({ ok: true })
    const { dispatcher, spy: dispSpy } = makeDispatcher({
      kind: "dispatched",
      sessionId: SESSION_A,
      newSession: false,
    })
    const broker = makeWechatBroker(makeDeps({ dispatcher, sendText }))
    const r = await broker.onInbound(makeEvent({ text: "/stop" }))
    assert.equal(r.kind, "command_echo")
    if (r.kind === "command_echo") assert.match(r.reply, /已发送中断/)
    assert.equal(dispSpy.calls.length, 0)
    assert.equal(dispSpy.stopCalls.length, 1)
    await flushMicrotasks()
    assert.equal(sendSpy.calls.length, 1)
    assert.match(sendSpy.calls[0]!.text, /已发送中断/)
  })

  test("audit insert sees duplicate (account_id,message_id) → duplicate_audit and dispatcher is skipped", async () => {
    const { dispatcher, spy: dispSpy } = makeDispatcher({
      kind: "dispatched",
      sessionId: SESSION_A,
      newSession: false,
    })
    const pool = {
      query: async (sql: string) => {
        if (/SELECT 1 FROM wechat_audit/i.test(sql)) return { rows: [{ "?column?": 1 }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      },
      connect: async () => ({
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => {},
      }),
    } as unknown as Pool
    const broker = makeWechatBroker(makeDeps({ dispatcher, pool }))
    const r = await broker.onInbound(makeEvent({
      accountId: "acct-audit",
      messageId: "msg-dupe",
      rawPayload: { seq: "msg-dupe" },
      itemTypes: "text",
    }))
    assert.equal(r.kind, "duplicate_audit")
    assert.equal(dispSpy.calls.length, 0)
  })

  test("duplicate audit drops /model before local command handler runs", async () => {
    const { dispatcher, spy: dispSpy } = makeDispatcher({
      kind: "dispatched",
      sessionId: SESSION_A,
      newSession: false,
    })
    let modelCommandCalls = 0
    const pool = {
      query: async (sql: string) => {
        if (/SELECT 1 FROM wechat_audit/i.test(sql)) return { rows: [{ "?column?": 1 }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      },
      connect: async () => ({
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => {},
      }),
    } as unknown as Pool
    const broker = makeWechatBroker(
      makeDeps({
        dispatcher,
        pool,
        wechatUxCommands: {
          handleModelCommand: async () => {
            modelCommandCalls++
            return "should not run"
          },
        },
      }),
    )
    const r = await broker.onInbound(makeEvent({
      text: "/model",
      accountId: "acct-audit",
      messageId: "msg-dupe",
    }))
    assert.equal(r.kind, "duplicate_audit")
    assert.equal(dispSpy.calls.length, 0)
    assert.equal(modelCommandCalls, 0)
  })

  test("audit insert is committed after successful dispatch and uses raw digit binding_user_id", async () => {
    const events: Array<{ kind: "sql"; sql: string; params?: ReadonlyArray<unknown> } | { kind: "dispatch" }> = []
    const pool = {
      query: async (sql: string, params?: ReadonlyArray<unknown>) => {
        events.push({ kind: "sql", sql, params })
        if (/SELECT 1 FROM wechat_audit/i.test(sql)) return { rows: [], rowCount: 0 }
        if (/INSERT INTO wechat_audit/i.test(sql)) return { rows: [], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      },
      connect: async () => ({
        query: async (sql: string, params?: ReadonlyArray<unknown>) => {
          events.push({ kind: "sql", sql, params })
          return { rows: [], rowCount: 0 }
        },
        release: () => {},
      }),
    } as unknown as Pool
    const { dispatcher, spy: dispSpy } = makeDispatcher(() => {
      events.push({ kind: "dispatch" })
      return { kind: "dispatched", sessionId: SESSION_A, newSession: false }
    })
    const broker = makeWechatBroker(makeDeps({ dispatcher, pool }))
    const r = await broker.onInbound(makeEvent({
      bindingUserId: "c:42",
      accountId: "acct-audit-ok",
      messageId: "msg-ok",
      rawPayload: { seq: "msg-ok" },
      itemTypes: "text",
    }))
    assert.equal(r.kind, "dispatched")
    assert.equal(dispSpy.calls.length, 1)
    assert.equal(dispSpy.calls[0]!.bindingUserId, "42")
    const dispatchIdx = events.findIndex((e) => e.kind === "dispatch")
    const insertIdx = events.findIndex((e) => e.kind === "sql" && /INSERT INTO wechat_audit/i.test(e.sql))
    assert.ok(dispatchIdx >= 0 && insertIdx > dispatchIdx, "audit row should be committed only after dispatch success")
    const audit = events[insertIdx]! as { kind: "sql"; sql: string; params?: ReadonlyArray<unknown> }
    assert.ok(audit, "expected audit insert SQL")
    assert.equal(audit!.params?.[0], "42")
    assert.equal(audit!.params?.[1], "acct-audit-ok")
    assert.equal(audit!.params?.[3], "msg-ok")
  })

  test("broker-local /help reflects rich WeChat help and skips dispatcher", async () => {
    const { dispatcher, spy: dispSpy } = makeDispatcher({
      kind: "dispatched",
      sessionId: SESSION_A,
      newSession: false,
    })
    const { sendText, spy: sendSpy } = makeSendText({ ok: true })
    const broker = makeWechatBroker(makeDeps({ dispatcher, sendText }))
    const r = await broker.onInbound(makeEvent({ text: "/help" }))
    assert.equal(r.kind, "command_echo")
    if (r.kind === "command_echo") {
      assert.match(r.reply, /\/model 2/)
    }
    assert.equal(dispSpy.calls.length, 0)
    await flushMicrotasks()
    assert.equal(sendSpy.calls.length, 1)
    assert.match(sendSpy.calls[0]!.text, /微信里可以这样用 OpenClaude/)
    assert.match(sendSpy.calls[0]!.text, /\/stop/)
    assert.match(sendSpy.calls[0]!.text, /实时过程/)
    assert.doesNotMatch(sendSpy.calls[0]!.text, /\/总结/)
    assert.doesNotMatch(sendSpy.calls[0]!.text, /\/status/)
  })

  test("broker-local /过程 reads current process visibility and skips dispatcher", async () => {
    const { dispatcher, spy: dispSpy } = makeDispatcher({
      kind: "dispatched",
      sessionId: SESSION_A,
      newSession: false,
    })
    const getCalls: string[] = []
    const broker = makeWechatBroker(
      makeDeps({
        dispatcher,
        wechatProcessVisibility: {
          getShowToolCalls: async (bindingUserId) => {
            getCalls.push(bindingUserId)
            return true
          },
          setShowToolCalls: async () => {
            throw new Error("should not set")
          },
        },
      }),
    )
    const r = await broker.onInbound(makeEvent({ bindingUserId: "c:42", text: "/过程" }))
    assert.equal(r.kind, "command_echo")
    if (r.kind === "command_echo") {
      assert.match(r.reply, /当前微信过程显示:开启/)
      assert.match(r.reply, /\/过程 开 或 \/过程 关/)
    }
    assert.deepEqual(getCalls, ["42"])
    assert.equal(dispSpy.calls.length, 0)
  })

  test("broker-local /过程 关 disables process visibility and skips dispatcher", async () => {
    const { dispatcher, spy: dispSpy } = makeDispatcher({
      kind: "dispatched",
      sessionId: SESSION_A,
      newSession: false,
    })
    const setCalls: Array<{ bindingUserId: string; show: boolean }> = []
    const broker = makeWechatBroker(
      makeDeps({
        dispatcher,
        wechatProcessVisibility: {
          getShowToolCalls: async () => true,
          setShowToolCalls: async (bindingUserId, show) => {
            setCalls.push({ bindingUserId, show })
          },
        },
      }),
    )
    const r = await broker.onInbound(makeEvent({ bindingUserId: "c:42", text: "/过程 关" }))
    assert.equal(r.kind, "command_echo")
    if (r.kind === "command_echo") assert.match(r.reply, /已关闭微信过程显示/)
    assert.deepEqual(setCalls, [{ bindingUserId: "42", show: false }])
    assert.equal(dispSpy.calls.length, 0)
  })

  test("broker-local /过程 on enables process visibility and skips dispatcher", async () => {
    const { dispatcher, spy: dispSpy } = makeDispatcher({
      kind: "dispatched",
      sessionId: SESSION_A,
      newSession: false,
    })
    const setCalls: Array<{ bindingUserId: string; show: boolean }> = []
    const broker = makeWechatBroker(
      makeDeps({
        dispatcher,
        wechatProcessVisibility: {
          getShowToolCalls: async () => false,
          setShowToolCalls: async (bindingUserId, show) => {
            setCalls.push({ bindingUserId, show })
          },
        },
      }),
    )
    const r = await broker.onInbound(makeEvent({ text: "/过程 on" }))
    assert.equal(r.kind, "command_echo")
    if (r.kind === "command_echo") assert.match(r.reply, /已开启微信过程显示/)
    assert.deepEqual(setCalls, [{ bindingUserId: "42", show: true }])
    assert.equal(dispSpy.calls.length, 0)
  })

  test("broker-local /过程 rejects invalid args without touching preference or dispatcher", async () => {
    const { dispatcher, spy: dispSpy } = makeDispatcher({
      kind: "dispatched",
      sessionId: SESSION_A,
      newSession: false,
    })
    let touched = false
    const broker = makeWechatBroker(
      makeDeps({
        dispatcher,
        wechatProcessVisibility: {
          getShowToolCalls: async () => {
            touched = true
            return true
          },
          setShowToolCalls: async () => {
            touched = true
          },
        },
      }),
    )
    const r = await broker.onInbound(makeEvent({ text: "/过程 maybe" }))
    assert.equal(r.kind, "command_echo")
    if (r.kind === "command_echo") assert.equal(r.reply, "用法:/过程 开 或 /过程 关")
    assert.equal(touched, false)
    assert.equal(dispSpy.calls.length, 0)
  })

  test("broker-local /过程 preference failure returns friendly fallback and skips dispatcher", async () => {
    const { dispatcher, spy: dispSpy } = makeDispatcher({
      kind: "dispatched",
      sessionId: SESSION_A,
      newSession: false,
    })
    const broker = makeWechatBroker(
      makeDeps({
        dispatcher,
        wechatProcessVisibility: {
          getShowToolCalls: async () => {
            throw new Error("preferences db down")
          },
          setShowToolCalls: async () => {},
        },
      }),
    )
    const r = await broker.onInbound(makeEvent({ text: "/过程" }))
    assert.equal(r.kind, "command_echo")
    if (r.kind === "command_echo") assert.match(r.reply, /暂时无法更新微信过程显示设置/)
    assert.equal(dispSpy.calls.length, 0)
  })

  test("reverted prompt shortcut /总结 falls through to dispatcher unchanged", async () => {
    const { dispatcher, spy: dispSpy } = makeDispatcher((evt) => ({
      kind: "command_echo",
      reply: `dispatcher saw:${evt.text}`,
    }))
    const broker = makeWechatBroker(makeDeps({ dispatcher }))
    const r = await broker.onInbound(makeEvent({ text: "/总结" }))
    assert.equal(r.kind, "command_echo")
    assert.equal(dispSpy.calls.length, 1)
    assert.equal(dispSpy.calls[0]!.text, "/总结")
    if (r.kind === "command_echo") assert.equal(r.reply, "dispatcher saw:/总结")
  })

  test("broker-local /new deletes commercial pointer, soft-deletes previous master wsess, and skips dispatcher", async () => {
    const { dispatcher, spy: dispSpy } = makeDispatcher({
      kind: "dispatched",
      sessionId: SESSION_B,
      newSession: false,
    })
    const fake = makeFakePool({
      pointerSessionId: SESSION_A,
      deletePointerRowCount: 1,
    })
    const { sendText, spy: sendSpy } = makeSendText({ ok: true })
    const soft = makeSoftDelete()
    const broker = makeWechatBroker(
      makeDeps({
        dispatcher,
        pool: fake.pool,
        sendText,
        softDeleteMasterSession: soft.fn,
      }),
    )
    const r = await broker.onInbound(makeEvent({
      bindingUserId: "c:42",
      text: "/new",
      accountId: "acct-new",
      messageId: "msg-new",
    }))
    assert.equal(r.kind, "command_echo")
    if (r.kind === "command_echo") assert.match(r.reply, /已开启新会话/)
    assert.equal(dispSpy.calls.length, 0)
    assert.equal(soft.spy.calls.length, 1)
    assert.deepEqual(soft.spy.calls[0], { sessionId: SESSION_A, userId: "c:42" })
    assert.ok(
      fake.calls.some((sql) => /DELETE FROM wechat_session_pointer WHERE binding_user_id/i.test(sql)),
      "expected /new to delete commercial session pointer",
    )
    await flushMicrotasks()
    assert.equal(sendSpy.calls.length, 1)
    assert.equal(sendSpy.calls[0]!.text, "已开启新会话。下一条消息将由全新的 agent 处理。")
  })

  test("broker-local /new without existing pointer still succeeds and skips soft-delete", async () => {
    const { dispatcher, spy: dispSpy } = makeDispatcher({
      kind: "dispatched",
      sessionId: SESSION_B,
      newSession: false,
    })
    const fake = makeFakePool({ pointerSessionId: null, deletePointerRowCount: 0 })
    const soft = makeSoftDelete()
    const broker = makeWechatBroker(
      makeDeps({
        dispatcher,
        pool: fake.pool,
        softDeleteMasterSession: soft.fn,
      }),
    )
    const r = await broker.onInbound(makeEvent({ text: "/new" }))
    assert.equal(r.kind, "command_echo")
    if (r.kind === "command_echo") assert.match(r.reply, /已开启新会话/)
    assert.equal(dispSpy.calls.length, 0)
    assert.equal(soft.spy.calls.length, 0)
    assert.ok(
      fake.calls.some((sql) => /DELETE FROM wechat_session_pointer WHERE binding_user_id/i.test(sql)),
      "expected missing pointer path to still issue DELETE",
    )
  })

  test("broker-local /model delegates to model command deps, reflects reply, skips dispatcher", async () => {
    const { dispatcher, spy: dispSpy } = makeDispatcher({
      kind: "dispatched",
      sessionId: SESSION_A,
      newSession: false,
    })
    const { sendText, spy: sendSpy } = makeSendText({ ok: true })
    const seenTexts: string[] = []
    const broker = makeWechatBroker(
      makeDeps({
        dispatcher,
        sendText,
        wechatUxCommands: {
          handleModelCommand: async (evt) => {
            seenTexts.push(evt.text)
            return "模型列表: 1. Sonnet"
          },
        },
      }),
    )
    const r = await broker.onInbound(makeEvent({ text: "/model 1" }))
    assert.equal(r.kind, "command_echo")
    assert.deepEqual(seenTexts, ["/model 1"])
    assert.equal(dispSpy.calls.length, 0)
    await flushMicrotasks()
    assert.equal(sendSpy.calls[0]!.text, "模型列表: 1. Sonnet")
  })

  test("broker-local /model resolver failure returns friendly fallback, not dispatcher", async () => {
    const { dispatcher, spy: dispSpy } = makeDispatcher({
      kind: "dispatched",
      sessionId: SESSION_A,
      newSession: false,
    })
    const broker = makeWechatBroker(
      makeDeps({
        dispatcher,
        wechatUxCommands: {
          handleModelCommand: async () => {
            throw new Error("pricing db down")
          },
        },
      }),
    )
    const r = await broker.onInbound(makeEvent({ text: "/model" }))
    assert.equal(r.kind, "command_echo")
    if (r.kind === "command_echo") {
      assert.match(r.reply, /暂时无法读取模型列表/)
    }
    assert.equal(dispSpy.calls.length, 0)
  })

  test("non-text-only inbound gets friendly prompt and skips dispatcher", async () => {
    const { dispatcher, spy: dispSpy } = makeDispatcher({
      kind: "dispatched",
      sessionId: SESSION_A,
      newSession: false,
    })
    const broker = makeWechatBroker(makeDeps({ dispatcher }))
    const r = await broker.onInbound(makeEvent({ text: "", itemTypes: "image" }))
    assert.equal(r.kind, "command_echo")
    if (r.kind === "command_echo") {
      assert.match(r.reply, /收到了一条图片消息/)
      assert.match(r.reply, /无法解析这条附件/)
    }
    assert.equal(dispSpy.calls.length, 0)
  })

  test("image inbound with extracted attachment is prepared, enriched, and dispatched", async () => {
    const saveCalls: Parameters<NonNullable<BrokerDeps["saveWechatImages"]>>[0][] = []
    const { sendText, spy: sendSpy } = makeSendText({ ok: true })
    const { dispatcher, spy: dispSpy } = makeDispatcher({
      kind: "dispatched",
      sessionId: SESSION_A,
      newSession: false,
    })
    const broker = makeWechatBroker(
      makeDeps({
        dispatcher,
        sendText,
        saveWechatImages: async (args) => {
          saveCalls.push(args)
          return {
            promptText: "请识别图片\n`/home/agent/.openclaude/uploads/wechat-a.jpg`",
            count: 1,
          }
        },
      }),
    )
    const r = await broker.onInbound(makeEvent({
      text: "",
      itemTypes: "image",
      imageAttachments: [
        {
          fullUrl: "https://novac2c.cdn.weixin.qq.com/c2c/download?x=1",
          aesKeyHex: "00112233445566778899aabbccddeeff",
        },
      ],
    }))
    assert.equal(r.kind, "dispatched")
    assert.equal(saveCalls.length, 1)
    assert.equal(saveCalls[0]!.bindingUserId, "42")
    assert.equal(saveCalls[0]!.images.length, 1)
    assert.equal(dispSpy.calls.length, 1)
    assert.match(dispSpy.calls[0]!.text, /understand_image|wechat-a\\.jpg|识别图片/)
    await flushMicrotasks()
    assert.equal(sendSpy.calls.length, 2)
    assert.equal(sendSpy.calls[0]!.text, "收到图片，正在识别…")
    assert.match(sendSpy.calls[1]!.text, /实时过程/)
  })

  test("image prepare failure returns retryable friendly message and skips dispatcher", async () => {
    const inserts: string[] = []
    const pool = {
      query: async (sql: string) => {
        if (/SELECT 1 FROM wechat_audit/i.test(sql)) return { rows: [], rowCount: 0 }
        if (/INSERT INTO wechat_audit/i.test(sql)) inserts.push(sql)
        return { rows: [], rowCount: 0 }
      },
      connect: async () => ({
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => {},
      }),
    } as unknown as Pool
    const { dispatcher, spy: dispSpy } = makeDispatcher({
      kind: "dispatched",
      sessionId: SESSION_A,
      newSession: false,
    })
    const { sendText, spy: sendSpy } = makeSendText({ ok: true })
    const broker = makeWechatBroker(
      makeDeps({
        dispatcher,
        sendText,
        pool,
        saveWechatImages: async () => {
          throw new Error("cdn rejected")
        },
      }),
    )
    const r = await broker.onInbound(makeEvent({
      accountId: "acct-img",
      messageId: "msg-img",
      text: "",
      itemTypes: "image",
      imageAttachments: [
        {
          fullUrl: "https://novac2c.cdn.weixin.qq.com/c2c/download?x=1",
          aesKeyHex: "00112233445566778899aabbccddeeff",
        },
      ],
    }))
    assert.equal(r.kind, "command_echo")
    if (r.kind === "command_echo") assert.match(r.reply, /图片下载\/识别准备失败/)
    assert.equal(dispSpy.calls.length, 0)
    assert.equal(inserts.length, 1)
    await flushMicrotasks()
    assert.deepEqual(sendSpy.calls.map((c) => c.text), [
      "收到图片，正在识别…",
      "图片下载/识别准备失败，请重新发送图片，或在网页端上传后继续。",
    ])
  })

  test("dispatcher failure does not commit audit row, so redelivery can retry", async () => {
    const queries: Array<{ sql: string; params?: ReadonlyArray<unknown> }> = []
    const pool = {
      query: async (sql: string, params?: ReadonlyArray<unknown>) => {
        queries.push({ sql, params })
        if (/SELECT 1 FROM wechat_audit/i.test(sql)) return { rows: [], rowCount: 0 }
        if (/INSERT INTO wechat_audit/i.test(sql)) return { rows: [], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      },
      connect: async () => ({
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => {},
      }),
    } as unknown as Pool
    const { dispatcher } = makeDispatcher({ throw: new Error("dispatcher down") })
    const broker = makeWechatBroker(makeDeps({ dispatcher, pool }))
    const r = await broker.onInbound(makeEvent({
      accountId: "acct-audit-fail",
      messageId: "msg-retry",
      rawPayload: { seq: "msg-retry" },
      itemTypes: "text",
    }))
    assert.equal(r.kind, "broker_failed")
    assert.equal(
      queries.some((q) => /INSERT INTO wechat_audit/i.test(q.sql)),
      false,
      "failed dispatch must not create a committed audit dedupe row",
    )
  })

  test("dispatcher → command_echo → outcome 透传 + sendText fire-and-forget reply", async () => {
    const { sendText, spy: sendSpy } = makeSendText({ ok: true })
    const { dispatcher } = makeDispatcher({
      kind: "command_echo",
      reply: "当前微信通道暂不支持命令,请直接发送消息。",
    })
    const broker = makeWechatBroker(makeDeps({ dispatcher, sendText }))
    const r = await broker.onInbound(makeEvent({ text: "/list" }))
    assert.equal(r.kind, "command_echo")
    if (r.kind === "command_echo") {
      assert.equal(r.reply, "当前微信通道暂不支持命令,请直接发送消息。")
    }
    await flushMicrotasks()
    assert.equal(sendSpy.calls.length, 1)
    assert.notEqual(sendSpy.calls[0]!.text, "已收到，正在思考…")
    assert.equal(sendSpy.calls[0]!.botToken, "tok")
    assert.equal(sendSpy.calls[0]!.toUserId, "wx-sender-1")
    assert.equal(sendSpy.calls[0]!.contextToken, "ctx-1")
    assert.equal(sendSpy.calls[0]!.text, "当前微信通道暂不支持命令,请直接发送消息。")
  })

  test("dispatcher → cold_start → outcome 透传 + sendText fire-and-forget coldStartReply", async () => {
    const { sendText, spy: sendSpy } = makeSendText({ ok: true })
    const { dispatcher } = makeDispatcher({
      kind: "cold_start",
      reason: "provisioning",
      retryAfterSec: 5,
      coldStartReply: "正在唤醒,稍等几秒...",
    })
    const broker = makeWechatBroker(makeDeps({ dispatcher, sendText }))
    const r = await broker.onInbound(makeEvent())
    assert.equal(r.kind, "cold_start")
    await flushMicrotasks()
    assert.equal(sendSpy.calls.length, 1)
    assert.equal(sendSpy.calls[0]!.text, "正在唤醒,稍等几秒...")
  })

  test("反射:getBinding 返 null → log + drop,sendText 不被调", async () => {
    const { sendText, spy: sendSpy } = makeSendText({ ok: true })
    const { getBinding } = makeGetBinding(null)
    const { dispatcher } = makeDispatcher({
      kind: "command_echo",
      reply: "x",
    })
    const broker = makeWechatBroker(makeDeps({ dispatcher, sendText, getBinding }))
    const r = await broker.onInbound(makeEvent({ text: "/x" }))
    assert.equal(r.kind, "command_echo")
    await flushMicrotasks()
    assert.equal(sendSpy.calls.length, 0)
  })

  test("反射:contextTokens 不含本 senderId → log + drop,sendText 不被调", async () => {
    const { sendText, spy: sendSpy } = makeSendText({ ok: true })
    const { getBinding } = makeGetBinding({
      botToken: "tok",
      contextTokens: { "other-sender": "ctx-other" },
    })
    const { dispatcher } = makeDispatcher({ kind: "command_echo", reply: "x" })
    const broker = makeWechatBroker(makeDeps({ dispatcher, sendText, getBinding }))
    const r = await broker.onInbound(makeEvent({ senderId: "wx-sender-missing", text: "/x" }))
    assert.equal(r.kind, "command_echo")
    await flushMicrotasks()
    assert.equal(sendSpy.calls.length, 0)
  })

  test("反射:sendText **同步** throw 不冒泡(Promise.resolve().then 包裹)", async () => {
    // 关键测试:测试 Codex residual risk #3 — sendText 在返回 Promise 前同步 throw。
    const { sendText } = makeSendText({ throwSync: new Error("synchronous boom") })
    const { dispatcher } = makeDispatcher({ kind: "command_echo", reply: "x" })
    const broker = makeWechatBroker(makeDeps({ dispatcher, sendText }))
    // 不应 throw。如果 sendText 同步 throw 冒泡过 fire-and-forget 包裹层,
    // 这里 await 会变 reject;能走到下面 assert.equal 即说明没冒泡。
    const r = await broker.onInbound(makeEvent({ text: "/x" }))
    assert.equal(r.kind, "command_echo")
    await flushMicrotasks()
  })

  test("反射:sendText **异步** reject 不影响 onInbound 返回(swallow + log)", async () => {
    const { sendText } = makeSendText({ throwAsync: new Error("async boom") })
    const { dispatcher } = makeDispatcher({ kind: "command_echo", reply: "x" })
    const broker = makeWechatBroker(makeDeps({ dispatcher, sendText }))
    const r = await broker.onInbound(makeEvent({ text: "/x" }))
    assert.equal(r.kind, "command_echo")
    await flushMicrotasks()
  })

  test("反射:sendText 返 ok=false permanent → 不冒泡,outcome 不变", async () => {
    const { sendText, spy } = makeSendText({ ok: false, permanent: true, errMessage: "bad ctx" })
    const { dispatcher } = makeDispatcher({ kind: "command_echo", reply: "x" })
    const broker = makeWechatBroker(makeDeps({ dispatcher, sendText }))
    const r = await broker.onInbound(makeEvent({ text: "/x" }))
    assert.equal(r.kind, "command_echo")
    await flushMicrotasks()
    assert.equal(spy.calls.length, 1) // 调过一次,返失败
  })

  test("反射:getBinding throw 不影响 onInbound 返回", async () => {
    const { getBinding } = makeGetBinding({ throw: new Error("master sqlite down") })
    const { dispatcher } = makeDispatcher({ kind: "command_echo", reply: "x" })
    const broker = makeWechatBroker(makeDeps({ dispatcher, getBinding }))
    const r = await broker.onInbound(makeEvent({ text: "/x" }))
    assert.equal(r.kind, "command_echo")
    await flushMicrotasks()
  })
})

describe("wechatBroker — cleanupBinding", () => {
  test("deletes pointer and terminal-fails queued/sending outbox without deleting tombstones", async () => {
    const queries: Array<{ sql: string; params?: ReadonlyArray<unknown> }> = []
    const pool = {
      query: async (sql: string, params?: ReadonlyArray<unknown>) => {
        queries.push({ sql, params })
        if (/DELETE FROM wechat_session_pointer/i.test(sql)) return { rows: [], rowCount: 1 }
        if (/UPDATE wechat_outbox/i.test(sql)) return { rows: [], rowCount: 2 }
        return { rows: [], rowCount: 0 }
      },
      connect: async () => ({
        query: async (sql: string, params?: ReadonlyArray<unknown>) => {
          queries.push({ sql, params })
          return { rows: [], rowCount: 0 }
        },
        release: () => {},
      }),
    } as unknown as Pool
    const broker = makeWechatBroker(makeDeps({ pool, outboxWorker: { maxAttempts: 7 } }))
    const result = await broker.cleanupBinding("c:42")

    assert.deepEqual(result, { pointerDeleted: true, outboxFailed: 2 })
    const del = queries.find((q) => /DELETE FROM wechat_session_pointer/i.test(q.sql))
    const upd = queries.find((q) => /UPDATE wechat_outbox/i.test(q.sql))
    assert.ok(del)
    assert.ok(upd)
    assert.equal(del!.params?.[0], "42")
    assert.equal(upd!.params?.[0], "42")
    assert.equal(upd!.params?.[1], 7)
    assert.match(upd!.sql, /status\s+IN\s+\('queued',\s*'sending'\)/i)
    assert.doesNotMatch(upd!.sql, /DELETE\s+FROM\s+wechat_outbox/i)
  })

  test("rejects invalid binding ids before touching PG", async () => {
    const fake = makeFakePool()
    const broker = makeWechatBroker(makeDeps({ pool: fake.pool }))
    await assert.rejects(broker.cleanupBinding("c:abc"), /invalid bindingUserId/)
    assert.equal(fake.calls.length, 0)
  })
})

// ─── 3. outboundHandler ────────────────────────────────────────────────────

describe("wechatBroker — outboundHandler gate", () => {
  test("disabled → 403 WECHAT_BROKER_DISABLED + 安全头 + 不触 inner receiver", async () => {
    const { handler: inner, spy: innerSpy } = makeReceiverHandler()
    const broker = makeWechatBroker(
      makeDeps({ outboundReceiver: inner, brokerEnabled: () => false }),
    )
    const { res, rec } = makeRes()
    await broker.outboundHandler(makeReq(), res, CTX)
    assert.equal(rec.status, 403)
    assert.ok(rec.body.includes("WECHAT_BROKER_DISABLED"))
    // 安全头
    assert.equal(rec.headers["strict-transport-security"], "max-age=31536000; includeSubDomains")
    assert.equal(rec.headers["content-security-policy"], "default-src 'none'")
    assert.equal(rec.headers["x-content-type-options"], "nosniff")
    assert.equal(rec.headers["x-frame-options"], "DENY")
    // request id 标准头
    assert.ok(typeof rec.headers["x-request-id"] === "string")
    // 内部不被调
    assert.equal(innerSpy.calls.length, 0)
  })

  test("enabled → 透传到 inner outboundReceiver(ctx 原样)", async () => {
    const { handler: inner, spy: innerSpy } = makeReceiverHandler()
    const broker = makeWechatBroker(
      makeDeps({ outboundReceiver: inner, brokerEnabled: () => true }),
    )
    const { res, rec } = makeRes()
    await broker.outboundHandler(makeReq(), res, CTX)
    assert.equal(rec.status, 200)
    assert.equal(rec.body, '{"ok":true,"inner":true}')
    assert.equal(innerSpy.calls.length, 1)
    assert.equal(innerSpy.calls[0]!.ctx.hostUuid, CTX.hostUuid)
    assert.equal(innerSpy.calls[0]!.ctx.boundIp, CTX.boundIp)
  })
})

// ─── 4. reconcile ──────────────────────────────────────────────────────────

describe("wechatBroker — reconcile", () => {
  /**
   * 触发**单次** reconcile tick — 启动 broker(delay=0)、等 tick 跑完、立即 stop。
   * 大 reconcileIntervalMs 防止第二轮 tick 干扰断言。
   */
  async function runOneReconcileTick(deps: BrokerDeps): Promise<void> {
    const broker = makeWechatBroker(deps)
    broker.start()
    await new Promise((r) => setTimeout(r, 20))
    await broker.stop()
  }

  test("allMasterWsessRows 空 → 无 softDelete 调用", async () => {
    const all = makeAllMasterWsessRows([])
    const soft = makeSoftDelete()
    await runOneReconcileTick(
      makeDeps({
        allMasterWsessRows: all.fn,
        softDeleteMasterSession: soft.fn,
        reconcileIntervalMs: 60_000,
      }),
    )
    assert.equal(soft.spy.calls.length, 0)
  })

  test("2 个 master rows,PG active 含 1 个,grace 过期 → 仅 orphan 被 softDelete", async () => {
    // SESSION_A 在 active,SESSION_B 不在 → 仅 B 是 orphan(且 createdAt < now - grace)
    const cutoffNow = FIXED_NOW
    const graceMs = 1000
    const all = makeAllMasterWsessRows([
      { id: SESSION_A, userId: "c:1", createdAt: cutoffNow - 10_000 },
      { id: SESSION_B, userId: "c:2", createdAt: cutoffNow - 10_000 },
    ])
    const soft = makeSoftDelete()
    const pool = makeFakePool({ activeIds: [SESSION_A] }).pool
    await runOneReconcileTick(
      makeDeps({
        allMasterWsessRows: all.fn,
        softDeleteMasterSession: soft.fn,
        pool,
        reconcileIntervalMs: 60_000,
        reconcileGraceMs: graceMs,
        now: () => cutoffNow,
      }),
    )
    assert.equal(soft.spy.calls.length, 1)
    assert.equal(soft.spy.calls[0]!.sessionId, SESSION_B)
    assert.equal(soft.spy.calls[0]!.userId, "c:2")
  })

  test("softDelete 抛 → 其他 orphan 仍处理", async () => {
    const cutoffNow = FIXED_NOW
    const all = makeAllMasterWsessRows([
      { id: SESSION_A, userId: "c:1", createdAt: cutoffNow - 10_000 },
      { id: SESSION_B, userId: "c:2", createdAt: cutoffNow - 10_000 },
    ])
    const soft = makeSoftDelete({ throwFor: SESSION_A })
    // 两个都不在 PG active,都是 orphan
    const pool = makeFakePool({ activeIds: [] }).pool
    await runOneReconcileTick(
      makeDeps({
        allMasterWsessRows: all.fn,
        softDeleteMasterSession: soft.fn,
        pool,
        reconcileIntervalMs: 60_000,
        reconcileGraceMs: 1000,
        now: () => cutoffNow,
      }),
    )
    // 两次都被调过(即使 A 抛了)
    assert.equal(soft.spy.calls.length, 2)
  })

  test("disabled 状态 reconcile tick 跳过(allMasterWsessRows 不被调)", async () => {
    const all = makeAllMasterWsessRows([])
    await runOneReconcileTick(
      makeDeps({
        allMasterWsessRows: all.fn,
        brokerEnabled: () => false,
        reconcileIntervalMs: 60_000,
      }),
    )
    assert.equal(all.spy.calls, 0)
  })

  test("single snapshot — allMasterWsessRows 单次 tick 内只被调 1 次(不双拉)", async () => {
    const all = makeAllMasterWsessRows([
      { id: SESSION_A, userId: "c:1", createdAt: FIXED_NOW - 100_000 },
    ])
    await runOneReconcileTick(
      makeDeps({
        allMasterWsessRows: all.fn,
        pool: makeFakePool({ activeIds: [] }).pool,
        reconcileIntervalMs: 60_000,
        reconcileGraceMs: 1000,
        now: () => FIXED_NOW,
      }),
    )
    assert.equal(all.spy.calls, 1, `expected 1 fetch per tick, got ${all.spy.calls}`)
  })

  test("grace 期未过 → row 不算 orphan(createdAt > now - grace)", async () => {
    const now = FIXED_NOW
    const grace = 10_000
    const all = makeAllMasterWsessRows([
      { id: SESSION_B, userId: "c:2", createdAt: now - 1_000 }, // 在 grace 期内
    ])
    const soft = makeSoftDelete()
    await runOneReconcileTick(
      makeDeps({
        allMasterWsessRows: all.fn,
        softDeleteMasterSession: soft.fn,
        pool: makeFakePool({ activeIds: [] }).pool,
        reconcileIntervalMs: 60_000,
        reconcileGraceMs: grace,
        now: () => now,
      }),
    )
    assert.equal(soft.spy.calls.length, 0)
  })

  test("allMasterWsessRows 抛 → reconcile 安全退出,不调 softDelete,broker 仍能继续", async () => {
    const soft = makeSoftDelete()
    const broker = makeWechatBroker(
      makeDeps({
        allMasterWsessRows: async () => {
          throw new Error("master sqlite down")
        },
        softDeleteMasterSession: soft.fn,
        reconcileIntervalMs: 60_000,
      }),
    )
    broker.start()
    await new Promise((r) => setTimeout(r, 20))
    await broker.stop()
    assert.equal(soft.spy.calls.length, 0)
  })

  test("activeWsessIdsFromPg(pgPool 查 wechat_session_pointer)抛 → reconcile 安全退出,不调 softDelete", async () => {
    // Codex r5 NIT:broker.ts:352 已 try/catch,加直接覆盖测试。
    const all = makeAllMasterWsessRows([
      { id: SESSION_A, userId: "c:1", createdAt: FIXED_NOW - 100_000 },
    ])
    const soft = makeSoftDelete()
    // pool 在 SELECT current_session_id 时直接抛
    const pool = {
      query: async (sql: string) => {
        if (/SELECT current_session_id FROM wechat_session_pointer/i.test(sql)) {
          throw new Error("pg connection refused")
        }
        return { rows: [], rowCount: 0 }
      },
      connect: async () => ({
        query: async (sql: string) => {
          if (/SELECT current_session_id FROM wechat_session_pointer/i.test(sql)) {
            throw new Error("pg connection refused")
          }
          return { rows: [], rowCount: 0 }
        },
        release: () => {},
      }),
    } as unknown as Pool

    const broker = makeWechatBroker(
      makeDeps({
        allMasterWsessRows: all.fn,
        softDeleteMasterSession: soft.fn,
        pool,
        reconcileIntervalMs: 60_000,
        reconcileGraceMs: 1000,
        now: () => FIXED_NOW,
      }),
    )
    broker.start()
    await new Promise((r) => setTimeout(r, 20))
    await broker.stop()
    // rows 拉到了,但 activeWsess 查 PG 失败 → reconcile 早退,softDelete 不被调
    assert.equal(all.spy.calls, 1)
    assert.equal(soft.spy.calls.length, 0)
  })
})

// ─── 5. housekeeping ──────────────────────────────────────────────────────

describe("wechatBroker — housekeeping", () => {
  test("housekeeping tick 调 runHousekeeping(fake pool 记录到 SQL)", async () => {
    const fake = makeFakePool()
    const broker = makeWechatBroker(
      makeDeps({
        pool: fake.pool,
        housekeepingIntervalMs: 60_000,
        reconcileIntervalMs: 60_000,
      }),
    )
    broker.start()
    await new Promise((r) => setTimeout(r, 20))
    await broker.stop()
    // housekeeping 应该至少触过 releaseStaleSending / dropAgedPending / purgeSent / purgeFailed 之一
    const housekeepingHit = fake.calls.some(
      (sql) =>
        /UPDATE wechat_outbox SET[\s\S]+status\s*=\s*'queued'/i.test(sql) ||
        /UPDATE wechat_outbox SET[\s\S]+status\s*=\s*'failed'/i.test(sql) ||
        /DELETE FROM wechat_outbox/i.test(sql),
    )
    assert.ok(housekeepingHit, `expected housekeeping SQL hit; got: ${fake.calls.join("|")}`)
  })

  test("disabled 状态 housekeeping tick 跳过", async () => {
    const fake = makeFakePool()
    const broker = makeWechatBroker(
      makeDeps({
        pool: fake.pool,
        brokerEnabled: () => false,
        housekeepingIntervalMs: 60_000,
        reconcileIntervalMs: 60_000,
      }),
    )
    broker.start()
    await new Promise((r) => setTimeout(r, 20))
    await broker.stop()
    // 不能跑过 housekeeping。注意:outboxWorker.pickOne 也是 UPDATE wechat_outbox SET status='sending'(不受
    // brokerEnabled gate 影响,设计上残存 queued 行允许继续 drain)。这里只查 housekeeping 特征 SQL:
    //   - releaseStaleSending → UPDATE ... SET status='queued'
    //   - dropAgedPending     → UPDATE ... SET status='failed'
    //   - purgeSent/Failed    → DELETE FROM wechat_outbox
    const housekeepingSql = fake.calls.find(
      (sql) =>
        /UPDATE wechat_outbox SET[\s\S]+status\s*=\s*'queued'/i.test(sql) ||
        /UPDATE wechat_outbox SET[\s\S]+status\s*=\s*'failed'/i.test(sql) ||
        /DELETE FROM wechat_outbox/i.test(sql),
    )
    assert.equal(housekeepingSql, undefined)
  })

  test("runHousekeeping 抛 → broker 不崩,后续 tick 仍可继续", async () => {
    // pool 在 housekeeping 第一条 SQL(releaseStaleSending UPDATE)就抛
    let firstHouseError = true
    const respond = (sql: string): { rows: Record<string, unknown>[]; rowCount: number | null } => {
      if (firstHouseError && /UPDATE wechat_outbox/i.test(sql)) {
        firstHouseError = false
        throw new Error("simulated pool failure")
      }
      if (/SELECT current_session_id FROM wechat_session_pointer/i.test(sql)) {
        return { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 0 }
    }
    const pool = {
      query: async (sql: string) => respond(sql),
      connect: async () => ({
        query: async (sql: string) => respond(sql),
        release: () => {},
      }),
    } as unknown as Pool

    const broker = makeWechatBroker(
      makeDeps({
        pool,
        housekeepingIntervalMs: 60_000,
        reconcileIntervalMs: 60_000,
      }),
    )
    broker.start()
    await new Promise((r) => setTimeout(r, 20))
    await broker.stop()
    assert.ok(true) // 没崩即过
  })
})
