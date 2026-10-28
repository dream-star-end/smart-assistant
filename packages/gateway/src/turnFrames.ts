/**
 * Turn status / error / interrupt frame builders and private-routing stripping
 *
 * Moved verbatim out of server.ts (FINDINGS §7.6, OCV5-484); server.ts re-exports
 * these names, so importers are unchanged.
 */
import type { IncomingHttpHeaders } from 'node:http'
import {
  type OutboundError,
  type OutboundMessage,
  type OutboundTurnStatus,
  type SysContextRebuilt,
  type Peer,
  newTraceId,
  parseTraceIdCandidate,
  isClientMessageId,
  isDisplayableServerMessage,
  turnErrorSemantics,
} from '@openclaude/protocol'
import { classifiedMessageForCode, classifyRunError } from './errorClassify.js'
import type {
  GatewayEngineErrorEvent,
  GatewayTerminalErrorCode,
  GatewayTurnPhase,
  TurnRetryMeta,
} from './ccbMessageParser.js'
import type { Logger } from './logger.js'

// ── turn-alive-heartbeat (Plan 1) — autoResumeFromHello judgment helper ──

/**
 * Decide whether `autoResumeFromHello` should push a synthetic
 * turn-interrupted `isFinal` to the resuming peer.
 *
 * Background — why this is its own helper(not inlined at the call site):
 *
 * The old judgment was `peerInFlight && !runner.isRunning`. That treats
 * `runner.isRunning` as "turn ended" authority, but `runner.isRunning` is
 * **process-level** truth(`subprocessRunner.ts`: `proc !== null && !closed
 * || starting`). The CCB subprocess can legitimately be in `isRunning=false`
 * mid-turn during these windows:
 *
 *   1. phantom-turn retry — `sessionManager.ts` ~L1386-1424:
 *      `runner.shutdown()` is called and a fresh runner spawned, all inside
 *      the same `submit()` call's try-block.
 *   2. auth-refresh restart — `sessionManager.ts` ~L1445: token refresh
 *      forces a runner restart, also inside the same `submit()`.
 *   3. effort / model swap shutdown — `sessionManager.ts` ~L1196:
 *      `runner.shutdown()` to flip CLI flags, then respawn.
 *
 * If a WS hello arrives in any of these ms-wide windows with `peer.inFlight
 * = true`, the old code pushed a synthetic `isFinal` and the client cleared
 * its sending state — but the CCB respawn then continued the same turn,
 * stranding the user with a "turn is over" UI while gateway was still
 * working. That is the bug Plan 1 fixes.
 *
 * The correct authority is **turn-level**, not process-level:
 * `AgentSession._activeTurnCount` counts in-flight `submit()` promises and
 * stays > 0 across all the windows above(they're inside `submit()`'s
 * try / finally). See `AgentSession._activeTurnCount` jsdoc for the
 * counter's full contract.
 *
 * ── team-durability(2026-07-07)改判据 ──
 *
 * 旧判据还看 `runner.isRunning`(peerInFlight && isRunning → 不推)。这在 warm
 * runner 架构下是死条件:codex app-server 与 warm CCB runner 在 turn **之间**
 * 常驻(isRunning 恒 true),导致"turn 已在服务端正常结束、客户端错过终态帧还
 * 挂着发送态"的会话永远等不到对账 —— 2026-07-07 团队模式事故里客户端重连 6 次
 * 都没被救回,spinner 无限计数。turn 是否在飞的真值源是两个 turn 级计数,进程级
 * isRunning 不再参与判定:turn 活着 ⇒ 必有 submit 在飞 ⇒ engine counter > 0;
 * 团队模式 review 编排窗口(engine turn 已结束、编排未收尾)⇒ client counter > 0。
 * 旧判据护住的三个 respawn 窗口(phantom-turn / auth-refresh / effort swap)全在
 * submit try/finally 内,engine counter 覆盖,语义无回退。
 *
 * Decision table:
 *
 * | peerInFlight | engineTurnCount | clientTurnCount | result |
 * |--------------|-----------------|-----------------|--------|
 * | false        | *               | *               | false (nothing stuck to clear) |
 * | true         | > 0             | *               | false (engine turn in flight) |
 * | true         | *               | > 0             | false (turn 编排在飞,含 review pass) |
 * | true         | 0/undefined     | 0/undefined     | **true** (turn 已终结,客户端悬空) |
 *
 * counters are `undefined` for historical session objects / test fakes —
 * treat as 0(`?? 0`).
 *
 * Exported as `_`-prefixed test seam — single-call-site internal helper,
 * underscore signals "do not import from outside gateway". Pure function,
 * no side effects, no logging — caller owns observability.
 */
export function _shouldPushTurnInterruptedFinal(
  peerInFlight: boolean | undefined,
  engineTurnCount: number | undefined,
  clientTurnCount: number | undefined,
): boolean {
  if (!peerInFlight) return false
  if ((engineTurnCount ?? 0) > 0) return false
  if ((clientTurnCount ?? 0) > 0) return false
  return true
}

// ── V3 S12e CG7 — turn-level trace helpers ──

/**
 * Compute the per-turn trace context at dispatchInbound entry.
 *
 * ── CG7 traceId 双权威源收口(2026-07-10)──
 *
 * turnTraceId 是本 turn 钉在**每一个 outbound 帧**、并折进 messages[i].usage.traceId
 * 成为前端底部"请求ID"展示、也作为 submit 传参传给 runner 的 canonical。它的**唯一
 * 权威源是 master**,不是容器 gateway 自铸。三级优先:
 *
 *   1. master 注入 frame.traceId(权威)—— v5 商业版容器 gateway 只从 master 桥
 *      (commercial userChatBridge CG2a)经 secret 闸收帧。master 在 inbound.message
 *      入口 `newTraceId()` 铸造 canonical,rewrite 注入到转发帧的 `traceId` 字段,并
 *      **同步登记 PG turn_traces 表(CG2d)** —— 那是运维"请求ID一键定位"的唯一持久
 *      落点。容器必须原样采用 master 注入值作为 turnTraceId,前端底部展示的请求ID 才
 *      能与 turn_traces 对上。历史 bug:此函数曾无条件 `newTraceId()` 自铸、无视 master
 *      注入,导致底部请求ID(自造)查 turn_traces(master 登记)查不到(实锤会话
 *      webmrevafa0pvo3qm:底部 cc395cf5… vs turn_traces 5e08cfbc…)。
 *   2. 自铸(fallback)—— 个人版直连场景 master 不注入 frame.traceId(缺省),或注入
 *      值畸形/伪造时,回落 `newTraceId()` 自铸,保证 turn 一定有合法 canonical。
 *   3. clientTraceId 永远只是 observation echo,**绝不**参与 turnTraceId 选取。若 client
 *      提供且合法则原样回显供 submit 层日志关联;非法只记 issue 枚举。
 *
 * 信任边界:容器 gateway 信任 frame.traceId 的前提是 secret 闸保证"只有 master 能送帧"
 * (v5 商业版)。个人版直连场景客户端理论上能在 inbound JSON 里塞 traceId —— 但
 * turnTraceId 只是观测/关联 id(个人版无 master turn_traces 可被冒充),且
 * `parseTraceIdCandidate` 兜底畸形/伪造值(格式合法性 + anti-log-injection),故"信任 +
 * 格式校验"的组合在两种部署形态下都安全。
 *
 * Anti-log-injection:所有 warn ctx 只带 `issue` 枚举,绝不带 raw candidate 值。
 */
export function _buildTurnTraceContext(
  masterRaw: unknown,
  clientRaw: unknown,
  log: Logger,
): { traceId: string; clientTraceId?: string } {
  // ── 权威:master 注入 frame.traceId(合法则直接采用,不再自铸)──
  let turnTraceId: string | undefined
  if (masterRaw !== undefined) {
    const parsedMaster = parseTraceIdCandidate(masterRaw)
    if (parsedMaster.ok) {
      turnTraceId = parsedMaster.traceId
    } else {
      // master 注入值畸形/伪造:回落自铸,只记 issue 枚举(anti-log-injection)。
      log.warn('inbound.master_trace_invalid', { issue: parsedMaster.issue })
    }
  }
  // ── fallback:无 master 注入 / master 注入非法 → 自铸 ──
  if (turnTraceId === undefined) {
    turnTraceId = newTraceId()
  }

  // ── clientTraceId:observation-only echo,与 turnTraceId 选取完全解耦 ──
  if (clientRaw !== undefined) {
    const parsed = parseTraceIdCandidate(clientRaw)
    if (parsed.ok) {
      return { traceId: turnTraceId, clientTraceId: parsed.traceId }
    }
    log.warn('inbound.client_trace_invalid', { issue: parsed.issue })
  }
  return { traceId: turnTraceId }
}

/** Build the exact structured error wire frame used by dispatchInbound.
 *  参数形状为 GatewayEngineErrorEvent(engine 原生 error 事件 ⊆ 该形状):
 *  sessionManager 经 _asEngineErrorEvent 发射的 gateway 权威终态码在此恢复精度。 */
export function _buildEngineErrorFrame(
  routing: ReturnType<typeof _inheritOutboundRouting>,
  event: GatewayEngineErrorEvent,
): OutboundError & { _userId?: string } {
  if (event.errorCode === 'user_cancelled') {
    // event.error 是 gateway 自产的受控停止文案(「本轮已由用户停止。」),不是
    // 上游原文;detail 保留原值 —— 旧前端 rolling 兼容窗口按该 detail 反推取消。
    return {
      type: 'outbound.error',
      ...routing,
      code: 'user_cancelled',
      message: event.error,
      detail: event.error,
      isFinal: false,
    }
  }
  // gateway 权威终态码(handleExit 分类的 runner_crashed/service_restart、tape
  // AUTH_ERROR、持久化降级 session_persist_unavailable)直接透传,不再被下面的
  // 原文正则分类压成 upstream_failed(E4.2)。
  if (event.errorCode) {
    const detail = _safeErrorFrameDetail(event.errorCode, event.error, routing.traceId)
    return {
      type: 'outbound.error',
      ...routing,
      code: event.errorCode,
      message: GATEWAY_TERMINAL_CODE_MESSAGES[event.errorCode],
      ...(detail !== undefined ? { detail } : {}),
      isFinal: false,
    }
  }
  const preClass = event.errorClass
  const classified =
    preClass && preClass !== 'unknown'
      ? { code: preClass, message: classifiedMessageForCode(preClass) }
      : classifyRunError(event.error)
  const code = classified.code === 'unknown' ? 'upstream_failed' : classified.code
  const detail = _safeErrorFrameDetail(code, event.error, routing.traceId)
  return {
    type: 'outbound.error',
    ...routing,
    code,
    message:
      classified.code === 'unknown' ? '任务执行暂时中断，请直接重试本条消息' : classified.message,
    ...(detail !== undefined ? { detail } : {}),
    isFinal: false,
  }
}

/**
 * 早期拒帧(创建 runner 之前的模型路由 / 本地执行拒绝)的结构化双帧构造。
 *
 * 返回**有序**二元组 `[结构化 outbound.error, 兼容 [error] final]`,调用方按序
 * deliver():新客户端识别 outbound.error 渲染红卡 + CTA、按相邻 frameSeq 抑制其后
 * 的裸 `[error]` 文本;旧客户端无视 outbound.error,仍靠 `[error]` final 终止本
 * turn(终止器语义不变)。此处尚无主 `out`,路由字段手工继承入参。
 *
 * `_` 前缀 = 契约测试 seam(锁双帧顺序 + 路由一致)。
 */
export function _earlyRejectErrorFrames(args: {
  sessionKey: string
  channel: string
  peer: Peer
  userId: string
  traceId: string
  code: OutboundError['code']
  message: string
  legacyErrorText: string
}): readonly [OutboundError & { _userId?: string }, OutboundMessage & { _userId?: string }] {
  const structured: OutboundError & { _userId?: string } = {
    type: 'outbound.error',
    sessionKey: args.sessionKey,
    channel: args.channel,
    peer: args.peer,
    code: args.code,
    recoveryDisposition: 'terminal',
    message: args.message,
    isFinal: false,
    traceId: args.traceId,
    _userId: args.userId,
  }
  const legacyFinal: OutboundMessage & { _userId?: string } = {
    type: 'outbound.message',
    sessionKey: args.sessionKey,
    channel: args.channel,
    peer: args.peer,
    blocks: [{ kind: 'text', text: args.legacyErrorText }],
    isFinal: true,
    traceId: args.traceId,
    _userId: args.userId,
  }
  return [structured, legacyFinal] as const
}

/**
 * Copy the routing tuple(+ public traceId)from the main `out` frame onto a
 * derived outbound frame(outbound.error / outbound.permission_request /
 * outbound.codex_billing).
 *
 * **Explicit field list — not a spread.** We deliberately do NOT
 * `...out` here, because future additions to `out` that are *not* routing
 * fields(e.g. block accumulators, per-turn meta)would otherwise leak into
 * every derived frame. This helper is the single audit point for known
 * routing fields:
 *
 *   - `sessionKey` / `channel` / `peer` — public schema fields used by
 *     `deliver()` to compute peerKey + ring slot.
 *   - `clientMessageId`                — exact browser turn identity.
 *   - `traceId`                        — CG7 public schema field.
 *   - `_userId`                        — private routing stamp consumed by
 *     `_stripPrivateRoutingFields` inside `deliver()`.
 *
 * Adding a new routing field requires updating this helper explicitly. That
 * is the desired property — accidental drift between main and derived frames
 * is the failure mode CG7 is closing.
 */
export function _inheritOutboundRouting(out: OutboundMessage & { _userId?: string }): {
  sessionKey: string
  channel: string
  peer: Peer
  clientMessageId?: string
  _userId?: string
  traceId?: string
} {
  return {
    sessionKey: out.sessionKey,
    channel: out.channel,
    peer: out.peer,
    ...(out.clientMessageId ? { clientMessageId: out.clientMessageId } : {}),
    ...(out._userId ? { _userId: out._userId } : {}),
    ...(out.traceId ? { traceId: out.traceId } : {}),
  }
}

/**
 * GET /api/sessions 的 live/内存会话列表过滤。
 *
 * 巡检 key 必须走 `isPatrolSessionKey`(CORRECTIONS §1.3/§1.4):kind 段是
 * `taskboard`,若只排除 `delegate`,default 用户会把 stageId 误当成 peerId 放进
 * 侧栏。内部委派同样不是用户聊天会话。
 */
/** Matches the client's 16-minute prepare wait with margin. */
const MODEL_SWITCH_FAILURE_REPLAY_MS = 30 * 60_000

/** Replay a prepared native model-switch onto a reconnecting socket.
 *  Ring `peekReplay(fromSeq=0)` is intentionally no_buffer to avoid
 *  duplicate assistant deltas; this control frame is idempotent by requestId. */
export function preparedModelSwitchCatchupFrame(
  session: {
    sessionKey: string
    _modelSwitchTransition?: {
      id: string
      sourceModel: string
      targetModel: string
      state: 'preparing' | 'prepared' | 'consuming'
      expiresAt?: number
    }
    _modelSwitchFailure?: {
      id: string
      sourceModel: string
      targetModel: string
      errorCode: string
      message: string
      at: number
    }
  },
  now = Date.now(),
): Record<string, unknown> | null {
  const transition = session._modelSwitchTransition
  const failure = session._modelSwitchFailure
  if (!transition && failure && now - failure.at < MODEL_SWITCH_FAILURE_REPLAY_MS) {
    // The client matches by requestId, so replaying a failure it already
    // received (or never asked about) is a no-op.
    return {
      type: 'outbound.model_switch.prepared',
      requestId: failure.id,
      sessionKey: session.sessionKey,
      sourceModel: failure.sourceModel,
      targetModel: failure.targetModel,
      status: 'failed',
      errorCode: failure.errorCode,
      message: failure.message,
      ts: now,
    }
  }
  if (!transition || transition.state !== 'prepared') return null
  if (typeof transition.expiresAt === 'number' && now >= transition.expiresAt) return null
  return {
    type: 'outbound.model_switch.prepared',
    requestId: transition.id,
    sessionKey: session.sessionKey,
    sourceModel: transition.sourceModel,
    targetModel: transition.targetModel,
    status: 'completed',
    ts: now,
  }
}

/**
 * Strip the private routing-only fields from any outbound-shaped frame,
 * returning the wire-safe frame and the stripped values.
 *
 * Private fields(all underscore-prefixed):
 *   - `_userId`           — caller-stamped, used by deliver() to scope peerKey
 *   - `_traceId`          — CG7 will stamp(turn-level trace)
 *   - `_connectionTraceId`— CG7 will stamp(connection-level trace)
 *   - `_peerId`           — legacy routing helper(some callers stash this)
 *
 * Why explicit destructure(not a blacklist loop): the field set is small,
 * fixed, and each one has clear ownership.  An explicit destructure creates
 * a single audit point for known private fields — adding a new private field
 * forces an update here, which is the moment we want to review it. (A
 * future typo'd field name on the producer side still requires its own care;
 * this helper is the *known fields* audit point, not a typo shield.)
 *
 * Type-honest generic: returns `Omit<T, '_userId' | ...>` so callers see the
 * private fields removed in the type system, not just at runtime. Two callers
 * use this:
 *   - `deliver()` for `OutboundMessage`-shaped frames(adapter + WS branches)
 *   - `_sendStampedSessionFrame()` for `outbound.permission_request` /
 *     `outbound.permission_settled` / `outbound.model_switch.prepared`
 *     direct-send paths — these frames extend
 *     the same routing tuple but aren't typed as `OutboundMessage`, so we widen
 *     the input to any `Record<string, unknown>` superset.
 */
export type PrivateRoutingFields = {
  _userId?: string
  _traceId?: string
  _connectionTraceId?: string
  _peerId?: string
}

export function _stripPrivateRoutingFields<T extends Record<string, unknown>>(
  out: T,
): {
  wire: Omit<T, '_userId' | '_traceId' | '_connectionTraceId' | '_peerId'>
  userId?: string
  traceId?: string
  connectionTraceId?: string
  peerId?: string
} {
  const { _userId, _traceId, _connectionTraceId, _peerId, ...wire } = out as T &
    PrivateRoutingFields
  return {
    wire: wire as Omit<T, '_userId' | '_traceId' | '_connectionTraceId' | '_peerId'>,
    userId: _userId,
    traceId: _traceId,
    connectionTraceId: _connectionTraceId,
    peerId: _peerId,
  }
}

/**
 * 构造完整 outbound.turn_status wire 帧(带路由继承)。显式按判别联合分支构造,
 * 避免把 union 型 status 字段 spread 进单个 literal(TS 无法归约回 OutboundTurnStatus
 * 判别联合)。`ts`/`frameSeq` 交给 deliver() 落地 stamp。
 */
export function _buildTurnStatusFrame(
  routing: ReturnType<typeof _inheritOutboundRouting>,
  phase: GatewayTurnPhase,
): OutboundTurnStatus & { _userId?: string } {
  if (phase && typeof phase === 'object') {
    if (phase.status === 'working') {
      return {
        type: 'outbound.turn_status',
        ...routing,
        status: 'working',
        ...(phase.detail ? { detail: phase.detail } : {}),
      }
    }
    return { type: 'outbound.turn_status', ...routing, status: 'retrying', retry: phase.retry }
  }
  return { type: 'outbound.turn_status', ...routing, status: phase }
}

/**
 * GatewayTurnPhase → OutboundTurnStatus 判别联合的 status 分支字段。
 * retrying 形态展平为 `status:'retrying'` + 平级 `retry`;compacting/null 为
 * `status` 本身。给「拼装未类型化 wire 对象」的路径用(autoResume 的 JSON.stringify)。
 */
/**
 * Phase to re-send on a reconnect hello, or undefined when nothing should be
 * sent (runner idle: the ring / synthetic isFinal own the terminal state).
 * A running turn always gets its authoritative phase, including null: the
 * startup phase's clear frame may have been emitted while no browser was
 * attached, and without this the tab keeps showing 「正在启动引擎」 until the
 * next content frame (INC-20261028-STALE-ENGINE-STARTING).
 */
export function _helloTurnStatusResendPhase(
  runnerIsRunning: boolean,
  currentTurnStatus: GatewayTurnPhase | undefined,
): GatewayTurnPhase | undefined {
  if (!runnerIsRunning) return undefined
  return currentTurnStatus ?? null
}

export function _turnStatusWireFields(
  phase: GatewayTurnPhase,
):
  | { status: 'compacting' | 'waiting_for_user' | 'engine_starting' | 'engine_resuming' | null }
  | { status: 'retrying'; retry: TurnRetryMeta }
  | { status: 'working'; detail?: string } {
  if (phase && typeof phase === 'object') {
    if (phase.status === 'working') {
      return phase.detail ? { status: 'working', detail: phase.detail } : { status: 'working' }
    }
    return { status: 'retrying', retry: phase.retry }
  }
  return { status: phase }
}

/**
 * 构造 sys.context_rebuilt 提示帧(§2.3 boss 硬指标 3)。
 *
 * 路由三件套 + `_userId` + 可选 traceId 从主 `out` 继承(_inheritOutboundRouting,
 * deliver() 会 strip 掉 `_userId`);`ts` 交给 deliver() 落地统一 stamp。返回带
 * `_userId` 私有字段的帧,直接喂 `deliver()`。
 */
export function _buildContextRebuiltFrame(
  out: OutboundMessage & { _userId?: string },
  agentId: string,
  messageCount: number,
  reason?: 'engine-switch' | 'native-resume-loss',
  clientMessageId?: string,
): SysContextRebuilt & { _userId?: string } {
  return {
    type: 'sys.context_rebuilt',
    ...(reason ? { reason } : {}),
    ...(clientMessageId ? { clientMessageId, noticeId: `${clientMessageId}:${agentId}` } : {}),
    ..._inheritOutboundRouting(out),
    agentId,
    messageCount,
  }
}

/** Match a bounded client history hint against the server-owned lock owner.
 * The browser may name candidates, but only the exact runtime marker can
 * authorize a cold replay. Malformed/oversized lists degrade to ordinary
 * cursor replay. */
export function _matchActiveTurnReplayCandidate(
  runningClientMessageId: string | undefined,
  rawCandidates: unknown,
): string | undefined {
  if (!isClientMessageId(runningClientMessageId)) return undefined
  if (
    !Array.isArray(rawCandidates) ||
    rawCandidates.length === 0 ||
    rawCandidates.length > ACTIVE_TURN_REPLAY_CANDIDATE_MAX
  ) {
    return undefined
  }
  return rawCandidates.some(
    (candidate) => isClientMessageId(candidate) && candidate === runningClientMessageId,
  )
    ? runningClientMessageId
    : undefined
}

/** OCV5-427: the exact-turn replay a hello may still get on this socket.
 * One per socket and turn; a repeat ask returns undefined so the caller
 * falls back to the cursor replay instead of resending the whole turn. */
export function _unservedActiveTurnReplay(
  served: WeakMap<object, Set<string>>,
  socket: object,
  sessionKey: string,
  matchedClientMessageId: string | undefined,
): string | undefined {
  if (!matchedClientMessageId) return undefined
  return served.get(socket)?.has(`${sessionKey}\u0000${matchedClientMessageId}`)
    ? undefined
    : matchedClientMessageId
}

/** OCV5-427: record an exact-turn replay that was actually sent on `socket`. */
export function _noteActiveTurnReplayServed(
  served: WeakMap<object, Set<string>>,
  socket: object,
  sessionKey: string,
  clientMessageId: string,
): void {
  let keys = served.get(socket)
  if (!keys) {
    keys = new Set()
    served.set(socket, keys)
  }
  keys.add(`${sessionKey}\u0000${clientMessageId}`)
}

/**
 * Identity-bound hello path: ring miss (or V5 master-authoritative lookup which
 * always returns unknown) while this cmid is not `_runningClientMessageId`.
 *
 * Keep `turn_state_unknown` only for the dispatchInbound-before-submit window
 * (counters > 0 but running id not bound yet). Otherwise the producer is gone
 * from this process and leaving unknown keeps the client on 「思考中」 forever.
 */
export function _shouldInterruptUnknownInFlight(input: {
  runningClientMessageId?: string | null
  admittingClientMessageId?: string | null
  inFlightClientMessageId: string
  engineTurnCount?: number
  clientTurnCount?: number
}): boolean {
  if (!input.inFlightClientMessageId) return false
  if (input.runningClientMessageId === input.inFlightClientMessageId) return false
  if (input.admittingClientMessageId === input.inFlightClientMessageId) return false
  if (
    !input.runningClientMessageId &&
    !input.admittingClientMessageId &&
    ((input.engineTurnCount ?? 0) > 0 || (input.clientTurnCount ?? 0) > 0)
  ) {
    return false
  }
  return true
}

/** gateway 权威预分类码(非 errorClassify 产物)的受控中文文案。errorClassify 的
 *  PATTERNS 只覆盖 provider 原文可识别的码;这些码由编排层(handleExit / tape
 *  终态 / 持久化降级)直接盖章,文案在此单点维护(全角标点,与前端风格对齐)。 */
export const GATEWAY_TERMINAL_CODE_MESSAGES: Record<
  Exclude<GatewayTerminalErrorCode, 'user_cancelled'>,
  string
> = {
  runner_crashed: '执行环境意外中断，你的消息已保留，请直接重试本条消息',
  service_restart: '服务正在更新，本轮已中断，请直接重试本条消息',
  engine_error: '任务执行遇到内部错误，请直接重试本条消息',
  auth_error: '模型服务认证失败，请重新登录或检查凭据后重试',
  session_persist_unavailable: '回复已生成，但会话存储暂时不可用，内容已安全排队待写入',
}

/** E4.3 — detail 收口:默认不下发原始 event.error。仅当该码在 taxonomy 中
 *  allowPublicServerMessage 且文本过 isDisplayableServerMessage 守卫时携带
 *  服务端说明;否则只带 traceId(若有)供用户反馈时关联日志。原文只进日志。 */
export function _safeErrorFrameDetail(
  code: string,
  rawError: string,
  traceId: string | undefined,
): string | undefined {
  if (
    turnErrorSemantics(code).allowPublicServerMessage === true &&
    isDisplayableServerMessage(rawError)
  ) {
    return rawError
  }
  return traceId || undefined
}

// ── V3 S12e CG6 — connection-level trace helpers ──

/**
 * Parse the connection-level trace id from the WS upgrade request headers.
 *
 * Contract:
 *   - `headers` must be a Node `IncomingMessage.headers` value
 *     (keys already lowercased, values `string | string[] | undefined`). We do
 *     NOT case-insensitive match — runtime Node http already canonicalises,
 *     and the symmetric Go side(node-agent CG5)uses CanonicalMIMEHeaderKey
 *     against the *upper-case* header constant for the same reason.
 *   - Multi-value headers(`string[]`)take the first value, matching the Go
 *     ParseHeader "first value unwrap" rule(see protocol/testdata fixture).
 *   - On any `parseTraceIdCandidate` failure we synthesise a fresh
 *     `newTraceId()` so WS upgrade never blocks on bad header — and emit a
 *     `warn` carrying ONLY the issue enum, never the raw header value
 *     (anti-log-injection / log-size DoS).
 *
 * Returns: always a valid trace id string(either the client-supplied one or
 * a fresh fallback).
 *
 * Exported as `_` prefixed test seam — single-call-site internal helper, the
 * underscore signals "do not import from outside gateway".
 */
export function _parseConnectionTraceIdFromUpgrade(
  headers: IncomingHttpHeaders,
  log: Logger,
): string {
  const raw = headers['x-connection-trace-id']
  const candidate = Array.isArray(raw) ? raw[0] : raw
  const result = parseTraceIdCandidate(candidate)
  if (result.ok) return result.traceId
  log.warn('ws.upgrade.connection_trace_invalid', { issue: result.issue })
  return newTraceId()
}

// ── active-turn cold replay candidate matching ──

export const ACTIVE_TURN_REPLAY_CANDIDATE_MAX = 32
