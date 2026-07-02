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
  EngineEvent,
  PartialSnapshot,
  PhantomSignals,
  SessionStreamEvent,
  TurnSummary,
} from './engineEvents.js'
import { type EngineCreateOpts, registerEngine } from './registry.js'

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

/** CCB 错误字符串分类(底座私有知识,从 sessionManager 下沉)。
 *  与迁移前 sessionManager.onFinish 的 isAuthError 判定逐条件一致。 */
export function classifyCcbErrorKind(result: {
  isError: boolean
  assistantText: string
}): 'auth' | 'other' | undefined {
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
    },
    assistantText: result.assistantText,
    thinkingText: result.thinkingText,
    assistantSegments: result.assistantSegments,
    thinkingSegments: result.thinkingSegments,
    tools: result.tools,
    stopReason: result.stopReason,
    numTurns: result.numTurns,
    isError: result.isError,
    ...(errorKind ? { errorKind } : {}),
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
    completedTools: [...parser.completedTools],
    assistantSegments: parser.assistantSegments.map((s) => ({ ...s })),
    thinkingSegments: parser.thinkingSegments.map((s) => ({ ...s })),
  }
}

const EMPTY_SNAPSHOT: PartialSnapshot = {
  assistantText: '',
  thinkingText: '',
  completedTools: [],
  assistantSegments: [],
  thinkingSegments: [],
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

  /** @param runnerOverride 测试注入结构等价 fake(生产恒为内部构造的 SubprocessRunner)。 */
  constructor(opts: EngineCreateOpts, runnerOverride?: SubprocessRunner) {
    super()
    this.runner = runnerOverride ?? new SubprocessRunner(opts)
    // 常驻 stdout 路由(每 session 恰一个,替代旧 per-turn 'message' 闭包链)。
    // 'activity' 先于 parse emit —— 对位旧 handleMessage 里 timer.refresh() 在
    // parser.parse 之前的顺序,且对 parser 会忽略的消息(system init 等)同样计活。
    this.runner.on('message', (msg: SdkMessage) => {
      this.emit('activity')
      this._routeTurn?.parser.parse(msg)
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
      onEvent: (e: SessionStreamEvent) => params.onEvent(e as EngineEvent),
      assistantMessageId: params.assistantMessageId,
      thinkingMessageId: params.thinkingMessageId,
      toolMessageIdFactory: params.toolMessageIdFactory,
      // 旧 parser 回调升格为一等事件,与内容事件同一条同步顺序流:
      // tool_use_detected 先于 finalized tool_use block,tool_result block 先于
      // tool_result_detected —— 与旧回调触发点逐一对位。
      onToolUse: (tool) => params.onEvent({ kind: 'tool_use_detected', tool }),
      onToolResult: (result) => params.onEvent({ kind: 'tool_result_detected', result }),
      onFinish: (result) => {
        // parser.finish() 幂等 → onFinish 恰好一次。identity guard:只有当
        // activeTurn 仍指向本 turn 才清(防 stale end 误清后继 turn)。
        if (this._activeTurn === ctx) this._activeTurn = null
        resolveSummary(result ? buildTurnSummary(result, telemetry) : null)
      },
      // CCB 成本 delta 基线:parser 直接 mutate session 引用,行为逐字节不变
      // (见 TurnParams.sessionTotals / CcbSessionTotals 注释)。
      sessionTotals: asCcbSessionTotals(params.sessionTotals),
    })
    const ctx: CcbTurnContext = { parser, telemetry }
    this._routeTurn = ctx
    this._activeTurn = ctx
    // PR2 v1.0.66 — requestId 挂 queue entry(CCB 路径 noop 透传)。
    const submitted = this.runner.submit(params.input, params.requestId)
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

  interrupt(): boolean {
    return this.runner.interrupt()
  }

  shutdown(): Promise<void> {
    return this.runner.shutdown()
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
