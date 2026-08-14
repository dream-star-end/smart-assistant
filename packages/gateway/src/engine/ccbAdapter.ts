/**
 * CcbAdapter — CCB(claude-code-best)底座的 EngineAdapter 实现。
 *
 * 组合 SubprocessRunner(spawn/stdin/stdout 归它,argv/env/wire 帧零改动)+
 * per-turn CcbMessageParser(解析语义零改动)。从 sessionManager._runOneTurn
 * 下沉进本 adapter 的 CCB 私有逻辑:
 *   - parser 构造与生命周期(per-turn 实例;turn 结束后保留路由给 bg-bash
 *     bash_output_tail,直到下一次 submitTurn 替换 —— 旧 _currentMessageListener 语义)
 *   - TelemetryChannel 每 turn 实例(→ TurnSummary.phantomSignals / diagnostics)
 *   - auth 错误分类(AUTH_KEYWORDS_RE / AUTH_ERROR_PREFIX_RE → errorKind:'auth')
 *   - staleResumeId 透传
 *   - interrupt / sendPermissionResponse 的 stdin control_request 协议(在 runner 内,保持)
 *
 * engine 中立编排(idle timer / phantom 判定 / 回滚 / cron 桥接 / waive / 持久化)
 * 留在 sessionManager,经 EngineEvent / TurnSummary / PartialSnapshot 消费。
 *
 * 硬约束:CCB stream-json SdkMessage 形状不跨出本模块。
 */
import { EventEmitter } from 'node:events'
import { TURN_LEASE_RENEW_AFTER_MS, type GoalStateSnapshot } from '@openclaude/protocol'
import type { OpenClaudeConfig } from '@openclaude/storage'
import { CcbMessageParser, type TurnResult } from '../ccbMessageParser.js'
import type { ExecutionTarget } from '../remoteTarget.js'
import {
  SubprocessRunner,
  type PermissionResponse,
  type SdkMessage,
} from '../subprocessRunner.js'
import { TelemetryChannel, type OcTelemetryEvent } from '../telemetryChannel.js'
import type {
  EngineAdapter,
  EngineCapabilities,
  EngineSessionTotals,
  EngineTurnRun,
  TurnParams,
} from './engineAdapter.js'
import type {
  DurableRuntimeEvent,
  EngineEvent,
  PartialSnapshot,
  PhantomSignals,
  SessionStreamEvent,
  TurnSummary,
} from './engineEvents.js'
import { type EngineCreateOpts, registerEngine } from './registry.js'
import { createLogger } from '../logger.js'
import { renewTurnLease } from '../masterTurnLease.js'

const log = createLogger({ module: 'ccbAdapter' })

// Auth error keywords — only matched when result.isError is true, so safe to be broad.
// Covers CCB's auth-related error strings from src/services/api/errors.ts:
//   INVALID_API_KEY_ERROR_MESSAGE           = 'Not logged in · Please run /login'
//   INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL  = 'Invalid API key · Fix external API key'
//   TOKEN_REVOKED_ERROR_MESSAGE             = 'OAuth token revoked · Please run /login'
//   OAUTH_ORG_NOT_ALLOWED_ERROR_MESSAGE     = 'Your account does not have access to Claude Code. Please run /login.'
//   Generic 401/403 handler                 = 'Please run /login · API Error: ...' / 'Failed to authenticate. ...'
//   ORG_DISABLED_ERROR_MESSAGE_ENV_KEY(_WITH_OAUTH) = 'Your ANTHROPIC_API_KEY belongs to a disabled organization · ...'
// The `run /login` substring is the common signal across all CCB login-required
// paths; the rest catch status-code / revoke / org-disabled phrasings that
// don't necessarily include a /login prompt.
const AUTH_KEYWORDS_RE =
  /authenticat|credentials|401|unauthorized|run \/login|token (?:has been )?revoked|invalid api key|organization has been disabled/i
// CCB's exact error prefix when API auth fails — safe to match even without isError flag.
const AUTH_ERROR_PREFIX_RE = /^Failed to authenticate\b/
const MODEL_AUTHORITY_INVALID_RE = /\bMODEL_AUTHORITY_INVALID\b/

function containsModelAuthorityInvalid(value: unknown): boolean {
  if (typeof value === 'string') return MODEL_AUTHORITY_INVALID_RE.test(value)
  try {
    return MODEL_AUTHORITY_INVALID_RE.test(JSON.stringify(value))
  } catch {
    return false
  }
}

function redactModelAuthorityRuntimeEvents(
  events: readonly DurableRuntimeEvent[],
): DurableRuntimeEvent[] {
  return events.map((event) =>
    containsModelAuthorityInvalid(event.payload)
      ? {
          ordinal: event.ordinal,
          observedAt: event.observedAt,
          source: event.source,
          payload: {
            type: 'platform_error',
            code: 'MODEL_AUTHORITY_EXPIRED',
          },
        }
      : structuredClone(event),
  )
}

/** CCB 错误字符串分类(底座私有知识,从 sessionManager 下沉)。
 *  与迁移前 sessionManager.onFinish 的 isAuthError 判定逐条件一致。 */
export function classifyCcbErrorKind(result: {
  isError: boolean
  assistantText: string
  errorDetail?: string
}): 'auth' | 'model_authority' | 'other' | undefined {
  if (
    containsModelAuthorityInvalid(result.assistantText) ||
    containsModelAuthorityInvalid(result.errorDetail)
  ) {
    return 'model_authority'
  }
  const isAuth =
    (result.isError && AUTH_KEYWORDS_RE.test(result.assistantText)) ||
    AUTH_ERROR_PREFIX_RE.test(result.assistantText)
  if (isAuth) return 'auth'
  return result.isError ? 'other' : undefined
}

/**
 * CCB 兼容子契约(M0 Codex 评审 nit①):在 engine 中立的 EngineSessionTotals 之上
 * 追加 CCB 私有的成本 delta 基线字段。`_lastCcbCumulativeCost` 是"CCB 进程累计
 * cost 的上一次取值"(per-turn delta = cumulative − baseline),属底座私有知识,
 * 不进 TurnParams 公开契约 —— CodexAdapter 等新底座不被迫实现它。
 */
export interface CcbSessionTotals extends EngineSessionTotals {
  _lastCcbCumulativeCost: number
}

/**
 * 把 engine 中立 totals 收窄为 CCB 兼容形态(CcbMessageParser 需要 delta 基线
 * 字段)。AgentSession 恒带该字段(初始化于 getOrCreate);裸 EngineSessionTotals
 * (理论上的新 caller / 测试 stub)就地补 0 —— 与 fresh session 的种子值一致,
 * parser 的 `cumulative < baseline` 回退逻辑保证首个 result 语义正确。
 * 就地 mutate(非拷贝):单一权威必须仍是传入的引用本身。
 */
export function asCcbSessionTotals(totals: EngineSessionTotals): CcbSessionTotals {
  const t = totals as EngineSessionTotals & { _lastCcbCumulativeCost?: number }
  if (typeof t._lastCcbCumulativeCost !== 'number') t._lastCcbCumulativeCost = 0
  return t as CcbSessionTotals
}

/** per-turn 上下文(旧 _runOneTurn 里 parser + telemetry 闭包的对位物)。 */
interface CcbTurnContext {
  parser: CcbMessageParser
  telemetry: TelemetryChannel
  /**
   * F3 — 本 turn **明确拥有**的 Bash tool_use_id 集(只收 name==='Bash' 的工具)。
   * 用于 bash_output_tail 路由的 fail-closed 判定:全局 origin map 若把某 id 逐出,
   * 只有当"当前 _routeTurn 明确拥有它"才允许回落 _routeTurn,否则丢弃(绝不把归属
   * 不明的 tail 灌进当前 turn)。per-turn 不设上限(受本 turn 工具数天然约束)。
   */
  ownedBashToolUseIds: Set<string>
  stopLeaseRenewal?: () => void
}

function toPhantomSignals(telemetry: TelemetryChannel): PhantomSignals {
  const signals = telemetry.getTurnSignals()
  return { apiState: signals.apiState, skipReason: signals.skipReason }
}

function buildTurnSummary(result: TurnResult, telemetry: TelemetryChannel): TurnSummary {
  const errorKind = classifyCcbErrorKind(result)
  const apiResp = telemetry.getTurnApiResponse()
  const lastTool = telemetry.getLastToolPreUse()
  return {
    usage: {
      cost: result.cost,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheCreationTokens: result.cacheCreationTokens,
      totalTokens: result.totalTokens,
    },
    assistantText: errorKind === 'model_authority' ? '' : result.assistantText,
    thinkingText: result.thinkingText,
    assistantSegments: errorKind === 'model_authority' ? [] : result.assistantSegments,
    thinkingSegments: result.thinkingSegments,
    tools: result.tools,
    runtimeEvents: errorKind === 'model_authority'
      ? redactModelAuthorityRuntimeEvents(result.runtimeEvents)
      : result.runtimeEvents,
    stopReason: result.stopReason,
    numTurns: result.numTurns,
    isError: result.isError,
    ...(errorKind ? { errorKind } : {}),
    // 审计 R3:与 codexAdapter 对称,把 TurnResult.errorClass 复制到 TurnSummary。
    // CCB result 帧不产 errorClass(恒 undefined,不落),此处仅保证映射对称、不丢字段。
    ...(result.errorClass !== undefined ? { errorClass: result.errorClass } : {}),
    ...(errorKind === 'model_authority'
      ? { errorDetail: 'MODEL_AUTHORITY_EXPIRED' }
      : result.errorDetail !== undefined
        ? { errorDetail: result.errorDetail }
        : {}),
    staleResumeId: result.staleResumeId,
    phantomSignals: toPhantomSignals(telemetry),
    // apiState='called' 且零输出时 sessionManager 的 warn 日志字段(与旧代码
    // 直读 TelemetryChannel 的取值逐项一致)。
    diagnostics: {
      hadApiResponse: !!apiResp,
      apiRespStopReason: apiResp?.data.stopReason,
      lastToolPreUse: lastTool?.data.toolName,
      toolErrorCount: telemetry.getToolErrors().length,
    },
  }
}

function snapshotOf(parser: CcbMessageParser): PartialSnapshot {
  return {
    assistantText: parser.assistantBuf,
    thinkingText: parser.thinkingBuf,
    completedTools: parser.snapshotToolsForPersistence(),
    assistantSegments: parser.assistantSegments.map((s) => ({ ...s })),
    thinkingSegments: parser.thinkingSegments.map((s) => ({ ...s })),
    runtimeEvents: redactModelAuthorityRuntimeEvents(parser.runtimeEvents),
  }
}

const EMPTY_SNAPSHOT: PartialSnapshot = {
  assistantText: '',
  thinkingText: '',
  completedTools: [],
  assistantSegments: [],
  thinkingSegments: [],
  runtimeEvents: [],
}

/** runner 事件直通转发清单(getOrCreate / _runOneTurn 消费面)。 */
const FORWARDED_RUNNER_EVENTS = [
  'session_id',
  'spawn',
  'exit',
  'error',
  'parse_error',
  'overflow',
  'stderr',
] as const

export class CcbAdapter extends EventEmitter implements EngineAdapter {
  readonly engineId = 'ccb'
  readonly capabilities: EngineCapabilities = {
    billingMode: 'proxy',
    supportsEffort: true,
    resumeKind: 'ccb-session',
    needsServerRequestId: false,
    historyMode: 'native-resume',
  }

  private readonly runner: SubprocessRunner

  /**
   * stdout 路由目标 = 最近一次 submitTurn 的 turn 上下文。turn 结束后**保留**
   * (CCB bg bash 的 bash_output_tail 在 turn 终态后仍持续 emit,finalized parser
   * 只放行 tail → block 事件继续流向旧 turn 的 onEvent → deliver),直到下一次
   * submitTurn 替换 —— 与旧 session._currentMessageListener 的跨 turn 保留语义一致,
   * 旧闭包链在替换时可被 GC。
   */
  private _routeTurn: CcbTurnContext | null = null
  /**
   * watchdog / telemetry 作用域 = 尚未终态的当前 turn。turn 终态(onFinish)时
   * identity-guard 清空(旧 `session._currentParser === parser` guard 的对位物):
   * pendingToolCalls 归 0、telemetry 停止 ingest。
   */
  private _activeTurn: CcbTurnContext | null = null
  /**
   * A0/F3 owner attribution:Bash tool_use_id → 发起它的 turn 上下文。CCB bg bash 的
   * bash_output_tail 在后续 turn 期间仍持续 emit,若一律按 _routeTurn(最近一次
   * submitTurn)路由,turn1 的 bg bash tail 会被错误灌进 turn2 的活跃 parser
   * (记进 turn2 的 runtimeEvents/tape)。靠本 map 把 tail 路由回**发起 turn**的
   * (已 finalized)parser → onPostFinalRuntimeEvent → 正确 ownerTurnKey。
   * F3:只登记 name==='Bash' 的 tool_use_id(仅它产 bash_output_tail);命中即刷新
   * LRU 位置;超上限逐出最旧;shutdown(await runner 停产后)清空。
   */
  private readonly _toolOriginByUseId = new Map<string, CcbTurnContext>()
  private static readonly TOOL_ORIGIN_MAX = 256
  /** F3:归属不明 tail 丢弃告警的限频闸(每 30s 最多 warn 一次,防洪泛 warn)。 */
  private _lastDroppedTailWarnAt = 0

  /** @param runnerOverride 测试注入结构等价 fake(生产恒为内部构造的 SubprocessRunner)。 */
  constructor(opts: EngineCreateOpts, runnerOverride?: SubprocessRunner) {
    super()
    this.runner = runnerOverride ?? new SubprocessRunner(opts)
    // 常驻 stdout 路由(每 session 恰一个,替代旧 per-turn 'message' 闭包链)。
    // 'activity' 先于 parse emit —— 对位旧 handleMessage 里 timer.refresh() 在
    // parser.parse 之前的顺序,且对 parser 会忽略的消息(system init 等)同样计活。
    this.runner.on('message', (msg: SdkMessage) => {
      this.emit('activity')
      this._routeMessage(msg)
    })
    // telemetry 只喂尚未终态的当前 turn(旧 per-turn 'telemetry' 监听在 detach()
    // 卸载 → turn 间事件丢弃,语义一致)。
    this.runner.on('telemetry', (ev: OcTelemetryEvent) => {
      this._activeTurn?.telemetry.ingest(ev)
    })
    for (const name of FORWARDED_RUNNER_EVENTS) {
      this.runner.on(name, (...args: unknown[]) => {
        this.emit(name, ...args)
      })
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  start(): Promise<void> {
    return this.runner.start()
  }

  submitTurn(params: TurnParams): EngineTurnRun {
    const telemetry = new TelemetryChannel()
    let resolveSummary!: (s: TurnSummary | null) => void
    const summary = new Promise<TurnSummary | null>((res) => {
      resolveSummary = res
    })
    const parser = new CcbMessageParser({
      toolUseIdToName: params.toolUseIdToName,
      // parser 只会产出内容事件(codex_billing 变体无生产者),向 EngineEvent 收窄安全。
      onEvent: (e: SessionStreamEvent) => {
        // A platform lease rejection is not a provider-login failure and its
        // raw internal response must not become a red user-facing card. The
        // terminal result below emits one normalized, waived outcome.
        if (e.kind === 'error' && containsModelAuthorityInvalid(e.error)) return
        params.onEvent(e as EngineEvent)
      },
      assistantMessageId: params.assistantMessageId,
      thinkingMessageId: params.thinkingMessageId,
      toolMessageIdFactory: params.toolMessageIdFactory,
      nextDurableEventOrdinal: params.nextDurableEventOrdinal,
      // 旧 parser 回调升格为一等事件,与内容事件同一条同步顺序流:
      // tool_use_detected 先于 finalized tool_use block,tool_result block 先于
      // tool_result_detected —— 与旧回调触发点逐一对位。
      // 主 agent-only 桥接事件(与登记解耦,见下方 onBashToolObserved)。
      onToolUse: (tool) => params.onEvent({ kind: 'tool_use_detected', tool }),
      // F5:所有 Bash tool_use(含子 agent)的归属登记入口 —— 只登记 tool_use_id → 本
      // turn ctx(fail-closed:非 Bash id 绝不进 origin map),供 tail 归位(活跃 turn /
      // post-terminal 皆然)。不触发 host bridge(那是 onToolUse 的职责)。
      onBashToolObserved: (toolUseId) => {
        ctx.ownedBashToolUseIds.add(toolUseId)
        this._registerToolOrigin(toolUseId, ctx)
      },
      onToolResult: (result) => params.onEvent({ kind: 'tool_result_detected', result }),
      onPostFinalRuntimeEvent: params.onPostTerminalRuntimeEvent,
      onFinish: (result) => {
        // parser.finish() 幂等 → onFinish 恰好一次。identity guard:只有当
        // activeTurn 仍指向本 turn 才清(防 stale end 误清后继 turn)。
        if (this._activeTurn === ctx) this._activeTurn = null
        ctx.stopLeaseRenewal?.()
        resolveSummary(result ? buildTurnSummary(result, telemetry) : null)
      },
      // CCB 成本 delta 基线:parser 直接 mutate session 引用,行为逐字节不变
      // (见 TurnParams.sessionTotals / CcbSessionTotals 注释)。
      sessionTotals: asCcbSessionTotals(params.sessionTotals),
    })
    const ctx: CcbTurnContext = { parser, telemetry, ownedBashToolUseIds: new Set() }
    this._routeTurn = ctx
    this._activeTurn = ctx
    // PR2 v1.0.66 — requestId 挂 queue entry(CCB 路径 noop 透传)。
    // 模型权威批次 §4 — modelAuthority 由 runner.submit 转成本 turn 的
    // ANTHROPIC_CUSTOM_HEADERS(先于 user message 写 stdin);无值 = 本地路径,
    // runner 侧自取 local_catalog token 并清位(单一收口,adapter 不做判定)。
    const submitted = this.runner
      .submit(params.input, params.requestId, params.modelAuthority, params.turnKey)
      .then(() => {
        if (params.modelAuthority && params.turnKey && this._activeTurn === ctx) {
          ctx.stopLeaseRenewal = this._startLeaseRenewal(
            ctx,
            params.turnKey,
            params.modelAuthority.leaseEnvelope,
          )
        }
      })
    return {
      submitted,
      summary,
      end: () => {
        parser.finish()
      },
      getPartialSnapshot: () => snapshotOf(parser),
      getPhantomSignals: () => toPhantomSignals(telemetry),
      get finalized() {
        return parser.finalized
      },
      get pendingToolCalls() {
        return parser.pendingToolCalls
      },
    }
  }

  private _startLeaseRenewal(
    ctx: CcbTurnContext,
    turnKey: string,
    initialLease: string,
  ): () => void {
    let stopped = false
    let timer: NodeJS.Timeout | null = null
    let currentLease = initialLease
    let failures = 0
    const schedule = (delayMs: number): void => {
      if (stopped) return
      timer = setTimeout(() => void run(), delayMs)
      timer.unref?.()
    }
    const run = async (): Promise<void> => {
      if (stopped || this._activeTurn !== ctx) return
      try {
        const renewed = await renewTurnLease(turnKey, currentLease)
        if (stopped || this._activeTurn !== ctx) return
        await this.runner.updateTurnLease(renewed.lease)
        currentLease = renewed.lease
        failures = 0
        log.info('rolling turn lease renewed', { turnKey, expiresAt: renewed.expiresAt })
        schedule(TURN_LEASE_RENEW_AFTER_MS)
      } catch (err) {
        failures++
        if (failures === 1 || failures % 10 === 0) {
          log.warn('rolling turn lease renewal failed; retrying', {
            turnKey,
            failures,
            error: (err as Error).message,
          })
        }
        // Initial renewal starts with 20 minutes of lease headroom. A one-minute
        // retry cadence tolerates control-plane deploys without request floods.
        schedule(60_000)
      }
    }
    schedule(TURN_LEASE_RENEW_AFTER_MS)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    }
  }

  /** A0/F3:登记 Bash tool_use_id → 本 turn ctx(LRU:重复/命中先删再插刷新位置,
   *  超上限逐出最旧)。仅 onToolUse 对 name==='Bash' 的工具调用。 */
  private _registerToolOrigin(toolUseId: string, ctx: CcbTurnContext): void {
    if (!toolUseId) return
    const map = this._toolOriginByUseId
    if (map.has(toolUseId)) map.delete(toolUseId)
    map.set(toolUseId, ctx)
    while (map.size > CcbAdapter.TOOL_ORIGIN_MAX) {
      const oldest = map.keys().next().value as string | undefined
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

  /**
   * F3 stdout 路由(常驻,每 session 一个)。非 bash_output_tail 消息逐字节维持
   * _routeTurn 路由不变;bash_output_tail 走 fail-closed 归属:
   *   - origin map 命中(发起它的 Bash turn 仍在册)→ 刷新 LRU 位置,路由回 origin
   *     (无论 origin 是过去 turn 还是当前 _routeTurn);
   *   - 未命中(被 LRU 逐出 / 从未登记 / 子 agent 工具)→ 仅当当前 _routeTurn **明确
   *     拥有**该 Bash id 才回落,否则**丢弃 + 限频 warn(fail-closed)**,绝不把归属
   *     不明的 tail 灌进当前 turn(那正是 owner attribution bug 的成因)。
   */
  private _routeMessage(msg: SdkMessage): void {
    const m = msg as { type?: unknown; subtype?: unknown; tool_use_id?: unknown }
    if (m?.type !== 'system' || m?.subtype !== 'bash_output_tail') {
      // 非 tail:逐字节维持 _routeTurn 路由。
      this._routeTurn?.parser.parse(msg)
      return
    }
    const toolUseId = m.tool_use_id
    if (typeof toolUseId !== 'string' || toolUseId.length === 0) {
      // 无 tool_use_id 的 tail:无法归属,parser 侧 bashOutputTailBlock 也会得 null
      // (不产 block/tape),送当前 _routeTurn 维持既有无害行为。
      this._routeTurn?.parser.parse(msg)
      return
    }
    const origin = this._toolOriginByUseId.get(toolUseId)
    if (origin) {
      // 命中:刷新 LRU 位置,路由回发起 turn(已 finalized 则走 onPostFinalRuntimeEvent)。
      this._toolOriginByUseId.delete(toolUseId)
      this._toolOriginByUseId.set(toolUseId, origin)
      origin.parser.parse(msg)
      return
    }
    // 未命中:仅当当前 turn 明确拥有该 Bash id 才回落;否则 fail-closed 丢弃。
    if (this._routeTurn?.ownedBashToolUseIds.has(toolUseId)) {
      this._routeTurn.parser.parse(msg)
      return
    }
    this._warnDroppedTail(toolUseId)
  }

  /** F3:归属不明 tail 丢弃的限频 warn(每 30s 至多一次,防洪泛日志)。 */
  private _warnDroppedTail(toolUseId: string): void {
    const now = Date.now()
    if (now - this._lastDroppedTailWarnAt < 30_000) return
    this._lastDroppedTailWarnAt = now
    log.warn('dropped unattributable bash_output_tail (fail-closed)', { toolUseId })
  }

  interrupt(): boolean {
    return this.runner.interrupt()
  }

  async shutdown(): Promise<void> {
    // F3⑤:先 await 底座停产出(SIGTERM+SIGKILL 链走完),drain 期间的尾帧仍能按
    // origin map 正确归位;**之后**再清 map,避免清早了让尾 tail 落回 fail-closed 丢弃。
    await this.runner.shutdown()
    this._toolOriginByUseId.clear()
  }

  waitForOutputDrain(): Promise<void> {
    return this.runner.waitForOutputDrain()
  }

  // ── resume ─────────────────────────────────────────────────────────────

  get nativeSessionId(): string | null {
    return this.runner.sessionId
  }

  clearSessionId(): void {
    this.runner.clearSessionId()
  }

  // ── setters(SubprocessRunner 直通)────────────────────────────────────

  setModel(model: string | undefined): void {
    this.runner.setModel(model)
  }

  get model(): string | undefined {
    return this.runner.model
  }

  setEffortLevel(level: string | undefined): void {
    this.runner.setEffortLevel(level)
  }

  get effortLevel(): string | undefined {
    return this.runner.effortLevel
  }

  setTraceId(traceId: string | undefined): void {
    this.runner.setTraceId(traceId)
  }

  async setGoalState(goal: GoalStateSnapshot | null): Promise<void> {
    const changed = this.runner.setGoalState(goal)
    if (changed && this.runner.isRunning) await this.runner.shutdown()
  }

  updateConfig(config: OpenClaudeConfig): void {
    this.runner.updateConfig(config)
  }

  setToolsets(toolsets: string[] | undefined): void {
    this.runner.setToolsets(toolsets)
  }

  get toolsets(): string[] | undefined {
    return this.runner.toolsets
  }

  setExecutionTarget(target: ExecutionTarget): void {
    this.runner.setExecutionTarget(target)
  }

  get executionTarget(): ExecutionTarget {
    return this.runner.executionTarget
  }

  // ── permission ─────────────────────────────────────────────────────────

  sendPermissionResponse(requestId: string, response: unknown): boolean {
    return this.runner.sendPermissionResponse(requestId, response as PermissionResponse)
  }

  // ── runtime state ──────────────────────────────────────────────────────

  getPartialSnapshot(): PartialSnapshot {
    return this._activeTurn ? snapshotOf(this._activeTurn.parser) : EMPTY_SNAPSHOT
  }

  get pendingToolCalls(): number {
    return this._activeTurn?.parser.pendingToolCalls ?? 0
  }

  get isRunning(): boolean {
    return this.runner.isRunning
  }

  get lastActivityAt(): number {
    return this.runner.lastActivityAt
  }

  set lastActivityAt(ts: number) {
    this.runner.lastActivityAt = ts
  }

  getBoundRepoBinding(): { selectionVersion: number; workspaceDir: string } | null {
    return this.runner.getBoundRepoBinding()
  }
}

// ── registry 注册(import 本模块即生效;sessionManager 顶部显式 import)──────
registerEngine('ccb', (opts) => new CcbAdapter(opts))
