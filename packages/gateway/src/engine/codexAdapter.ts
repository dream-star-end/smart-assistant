/**
 * CodexAdapter — codex(gpt-5.5,app-server 形态)底座的 EngineAdapter 实现(M1a)。
 *
 * 内核 = CodexAppServerRunner(P1f 复活,长驻 `codex app-server` JSON-RPC)。
 * 内核产出的 Anthropic-SDK-shape fake-SDK RunnerMessage 是**本模块内部实现细节**:
 * adapter 内部自建 per-turn CcbMessageParser 实例把 fake-SDK 流转成 EngineEvent,
 * 对外只暴露 canonical EngineEvent / TurnSummary / PartialSnapshot —— 避免重写
 * 内核 1.9k 行已验证事件映射,同时外部 seam 干净(方案 §B)。
 *
 * 硬约束:fake-SDK 形状不得跨出 codexAdapter.ts / codexAppServerRunner.ts。
 *
 * 与 CcbAdapter 的结构差异:
 *   - 无 TelemetryChannel:codex 没有 CCB 的 _oc_telemetry side-channel,
 *     phantomSignals 恒 { apiState: 'unknown' } → 上层沿用 legacy 9-AND 启发式。
 *   - billing 侧信道:codex 是 engine-reported 计费(capabilities.billingMode)。
 *     内核 result 帧携带 server-owned requestId 时,adapter 在 parser.parse **之前**
 *     经独立 'billing' 事件通道 emit EngineBillingEvent(billing 先于 'final',
 *     与 P1f 前 sessionManager 的发射顺序一致)。engineSessionId 由
 *     engine/engineSessionId.ts 唯一 helper 派生(M2 双钱包 settle / turn-waive
 *     的记账键,禁止各处自行 hash)。
 *   - errorKind 分类按 codex 错误形状(401 / token 失效 / 认证失败),分类语料 =
 *     assistantText(内核 failed 路径会先 emit "[turn failed: ...]" delta)+
 *     result 帧的原始 error 字符串(catch 路径不产 delta,只有 result.result)。
 *   - 安全 gate:内核的 agentProvider **强制归一为 'codex-native'**(不透传
 *     agents.yaml 原值)。promptSlots 的 literature scrub(SKILLS_LITERATURE 含
 *     master 凭证通道提示)以 `provider !== 'codex-native'` 判定 —— engine 由
 *     registry 按模型判定后,任意 provider 的 agent 都可能落到 codex 底座,
 *     这里收口保证 codex 路径永远命中 scrub,与 buildCodexEnv 的 env scrub 成对。
 */
import { EventEmitter } from 'node:events'
import type { OpenClaudeConfig } from '@openclaude/storage'
import { CcbMessageParser, type TurnResult } from '../ccbMessageParser.js'
import { createLogger } from '../logger.js'
import type { ExecutionTarget } from '../remoteTarget.js'
import type { SdkMessage } from '../subprocessRunner.js'
import { asCcbSessionTotals } from './ccbAdapter.js'
import { CodexAppServerRunner } from './codexAppServerRunner.js'
import type { CodexProviderConfigOverride } from './codexShared.js'
import type {
  EngineAdapter,
  EngineCapabilities,
  EngineTurnRun,
  TurnParams,
} from './engineAdapter.js'
import type {
  EngineBillingEvent,
  EngineEvent,
  PartialSnapshot,
  PhantomSignals,
  SessionStreamEvent,
  TurnSummary,
} from './engineEvents.js'
import { engineSessionId } from './engineSessionId.js'
import { type EngineCreateOpts, registerEngine } from './registry.js'

const log = createLogger({ module: 'codexAdapter' })

// Codex auth 错误形状(底座私有知识,对位 CcbAdapter 的 AUTH_KEYWORDS_RE):
//   - HTTP 401 / unauthorized:relay 或官方端点的鉴权拒绝
//   - token expired/invalid/revoked、refresh token 失败:账号池 token 失效
//   - `account/chatgptAuthTokens/refresh` 反向 RPC 失败文案(内核 -32603 透传)
// 仅在 result.isError 时匹配,宽词是安全的(与 CCB 侧同一立场)。
const CODEX_AUTH_ERROR_RE =
  /authenticat|credentials|\b401\b|unauthorized|token (?:is )?(?:expired|invalid|revoked)|invalid[ _]?(?:access[ _]?)?token|refresh(?:ing)? (?:the )?token|chatgptauthtokens|not logged in/i

/** codex 错误字符串分类。`lastErrorText` = result 帧的原始 error 字符串
 *  (assistantText 在 catch 路径为空,error 只在 result.result 里)。 */
export function classifyCodexErrorKind(
  result: { isError: boolean; assistantText: string },
  lastErrorText: string | null,
): 'auth' | 'other' | undefined {
  if (!result.isError) return undefined
  const corpus = `${result.assistantText}\n${lastErrorText ?? ''}`
  return CODEX_AUTH_ERROR_RE.test(corpus) ? 'auth' : 'other'
}

/** codex 无 telemetry → 恒 unknown,上层 phantom 判定走 legacy 启发式兜底。 */
const CODEX_PHANTOM_SIGNALS: Readonly<PhantomSignals> = Object.freeze({
  apiState: 'unknown' as const,
  skipReason: null,
})

/** per-turn 上下文(parser + 本 turn 最近一条 result error 原文)。 */
interface CodexTurnContext {
  parser: CcbMessageParser
  lastErrorText: string | null
}

function buildTurnSummary(result: TurnResult, ctx: CodexTurnContext): TurnSummary {
  const errorKind = classifyCodexErrorKind(result, ctx.lastErrorText)
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
    // codex 的 stale-thread 自愈在内核内(thread/resume -32600 "no rollout
    // found" → 透明 thread/start + 重发 session_id),不经 resume-map 逐出路径;
    // parser 的 staleResumeId 检测词是 CCB 专属,codex 帧恒 false — 直通。
    staleResumeId: result.staleResumeId,
    phantomSignals: { ...CODEX_PHANTOM_SIGNALS },
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

/**
 * 从内核 result 帧构造 EngineBillingEvent。字段清洗逻辑与 P1f 删除前
 * sessionManager 的 codex_billing 发射块逐条件一致(typeof 防御 → undefined
 * 字段不进 payload;rateLimits 数值必须 Number.isFinite,防 NaN/Infinity 被
 * JSON 序列化成 null 进 wire)。
 */
export function buildCodexBillingEvent(
  msg: Record<string, unknown>,
  requestId: string,
  sessionEngineId: string,
): EngineBillingEvent {
  const isOk = msg.is_error !== true
  const errReason =
    !isOk && typeof msg.result === 'string' && msg.result.length > 0 ? msg.result : undefined
  const u = msg.usage as
    | {
        input_tokens?: unknown
        output_tokens?: unknown
        cache_read_input_tokens?: unknown
        cache_creation_input_tokens?: unknown
        reasoning_output_tokens?: unknown
      }
    | undefined
  const usagePayload =
    u && typeof u === 'object'
      ? {
          ...(typeof u.input_tokens === 'number' ? { input_tokens: u.input_tokens } : {}),
          ...(typeof u.output_tokens === 'number' ? { output_tokens: u.output_tokens } : {}),
          ...(typeof u.cache_read_input_tokens === 'number'
            ? { cache_read_input_tokens: u.cache_read_input_tokens }
            : {}),
          ...(typeof u.cache_creation_input_tokens === 'number'
            ? { cache_creation_input_tokens: u.cache_creation_input_tokens }
            : {}),
          ...(typeof u.reasoning_output_tokens === 'number'
            ? { reasoning_output_tokens: u.reasoning_output_tokens }
            : {}),
        }
      : undefined
  const rl = msg.rateLimits
  const rateLimitsPayload =
    rl && typeof rl === 'object'
      ? (() => {
          const r = rl as Record<string, unknown>
          const out: { util5h?: number; reset5h?: string; util7d?: number; reset7d?: string } = {}
          if (typeof r.util5h === 'number' && Number.isFinite(r.util5h)) out.util5h = r.util5h
          if (typeof r.reset5h === 'string') out.reset5h = r.reset5h
          if (typeof r.util7d === 'number' && Number.isFinite(r.util7d)) out.util7d = r.util7d
          if (typeof r.reset7d === 'string') out.reset7d = r.reset7d
          return Object.keys(out).length > 0 ? out : undefined
        })()
      : undefined
  return {
    requestId,
    engineSessionId: sessionEngineId,
    status: isOk ? 'success' : 'error',
    durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : 0,
    ...(usagePayload && Object.keys(usagePayload).length > 0 ? { usage: usagePayload } : {}),
    ...(errReason ? { errorReason: errReason } : {}),
    ...(rateLimitsPayload ? { rateLimits: rateLimitsPayload } : {}),
  }
}

/** 内核事件直通转发清单(getOrCreate / _runOneTurn 消费面)。内核不产
 *  'overflow' / 'stderr' / 'telemetry'(stderr 在内核内直接进日志)。 */
const FORWARDED_KERNEL_EVENTS = ['spawn', 'exit', 'error', 'parse_error'] as const

export class CodexAdapter extends EventEmitter implements EngineAdapter {
  readonly engineId = 'codex'
  readonly capabilities: EngineCapabilities = {
    billingMode: 'engine-reported',
    supportsEffort: true,
    resumeKind: 'codex-thread',
    needsServerRequestId: true,
  }

  private readonly kernel: CodexAppServerRunner
  /** engineSessionId(sessionKey) 固化 —— billing 事件的记账键(M2 settle/waive)。 */
  private readonly _engineSessionId: string

  /** 最近一次内核上报的 codex thread id(nativeSessionId 权威;内核无公开 getter)。 */
  private _threadId: string | null

  /** stdout 路由目标 / watchdog 作用域 —— 语义与 CcbAdapter 完全一致(见彼处注释):
   *  _routeTurn 跨 turn 保留直到下一次 submitTurn 替换;_activeTurn 在 turn 终态
   *  经 identity guard 清空。 */
  private _routeTurn: CodexTurnContext | null = null
  private _activeTurn: CodexTurnContext | null = null

  // toolsets / executionTarget:codex 内核不支持,adapter 侧 stash 满足契约。
  private _toolsets: string[] | undefined
  private _executionTarget: ExecutionTarget = { kind: 'local' }

  /** @param kernelOverride 测试注入结构等价 fake(生产恒为内部构造的内核)。 */
  constructor(opts: EngineCreateOpts, kernelOverride?: CodexAppServerRunner) {
    super()
    this._engineSessionId = engineSessionId(opts.sessionKey)
    this._threadId = opts.resumeSessionId ?? null
    this._toolsets = opts.agentToolsets
    this.kernel =
      kernelOverride ??
      new CodexAppServerRunner({
        sessionKey: opts.sessionKey,
        agentId: opts.agentId,
        cwd: opts.agentBaseDir,
        resumeSessionId: opts.resumeSessionId,
        model: opts.model,
        persona: opts.persona,
        // 安全 gate(见文件头):engine 路由后任意 provider 的 agent 都可能落到
        // codex 底座,这里强制 'codex-native' 让 promptSlots 的 literature scrub
        // 与 GPT understand_image 提示段按 codex 语义生效,不受 agents.yaml 摆布。
        agentProvider: 'codex-native',
        effortLevel: opts.effortLevel,
        config: opts.config,
        delegationDepth: opts.delegationDepth,
        sessionId: opts.sessionId,
        getRepoSnapshot: opts.getRepoSnapshot,
      })
    // 常驻 stdout 路由(每 session 恰一个)。'activity' 先于 parse emit,对 parser
    // 会忽略的帧同样计活 —— 与 CcbAdapter / 旧 handleMessage 时序逐条对齐。
    this.kernel.on('message', (msg: Record<string, unknown>) => {
      this.emit('activity')
      const turn = this._routeTurn
      if (turn && msg && typeof msg === 'object' && msg.type === 'result') {
        if (msg.is_error === true && typeof msg.result === 'string') {
          turn.lastErrorText = msg.result
        }
        // billing 侧信道:仅"尚未终态的当前 turn"的 result 且带 server-owned
        // requestId 才发(旧 `!detached` guard 的对位物 —— idle/error 已收尾的
        // turn 不再补发,防撞二次 settle)。emit 先于 parse → billing 先于 final。
        const requestId = msg.requestId
        if (
          typeof requestId === 'string' &&
          requestId.length > 0 &&
          this._activeTurn === turn &&
          !turn.parser.finalized
        ) {
          this.emit('billing', buildCodexBillingEvent(msg, requestId, this._engineSessionId))
        }
      }
      // fake-SDK RunnerMessage 是 SdkMessage 子集(内核注释明示),cast 内聚在此。
      turn?.parser.parse(msg as unknown as SdkMessage)
    })
    this.kernel.on('session_id', (id: string) => {
      this._threadId = typeof id === 'string' && id ? id : null
      this.emit('session_id', id)
    })
    for (const name of FORWARDED_KERNEL_EVENTS) {
      this.kernel.on(name, (...args: unknown[]) => {
        this.emit(name, ...args)
      })
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  start(): Promise<void> {
    return this.kernel.start()
  }

  submitTurn(params: TurnParams): EngineTurnRun {
    let resolveSummary!: (s: TurnSummary | null) => void
    const summary = new Promise<TurnSummary | null>((res) => {
      resolveSummary = res
    })
    const ctx: CodexTurnContext = { parser: null as unknown as CcbMessageParser, lastErrorText: null }
    const parser = new CcbMessageParser({
      toolUseIdToName: params.toolUseIdToName,
      onEvent: (e: SessionStreamEvent) => params.onEvent(e as EngineEvent),
      assistantMessageId: params.assistantMessageId,
      thinkingMessageId: params.thinkingMessageId,
      toolMessageIdFactory: params.toolMessageIdFactory,
      onToolUse: (tool) => params.onEvent({ kind: 'tool_use_detected', tool }),
      onToolResult: (result) => params.onEvent({ kind: 'tool_result_detected', result }),
      onFinish: (result) => {
        if (this._activeTurn === ctx) this._activeTurn = null
        resolveSummary(result ? buildTurnSummary(result, ctx) : null)
      },
      // 成本 delta 基线:codex result 帧 total_cost_usd 恒 0(计费走 billing
      // 侧信道 + master settle),parser 仍按 CCB 语义 mutate totals —— cost 恒 0
      // delta、turns += 1,与 P1f 前 codex 路径共用 parser 的行为逐字节一致。
      sessionTotals: asCcbSessionTotals(params.sessionTotals),
    })
    ctx.parser = parser
    this._routeTurn = ctx
    this._activeTurn = ctx
    const submitted = this.kernel.submit(
      params.input as string | Array<{ type: string; text?: string }>,
      params.requestId,
    )
    return {
      submitted,
      summary,
      end: () => {
        parser.finish()
      },
      getPartialSnapshot: () => snapshotOf(parser),
      getPhantomSignals: () => ({ ...CODEX_PHANTOM_SIGNALS }),
      get finalized() {
        return parser.finalized
      },
      get pendingToolCalls() {
        return parser.pendingToolCalls
      },
    }
  }

  interrupt(): boolean {
    return this.kernel.interrupt()
  }

  shutdown(): Promise<void> {
    return this.kernel.shutdown()
  }

  // ── resume ─────────────────────────────────────────────────────────────

  get nativeSessionId(): string | null {
    return this._threadId
  }

  clearSessionId(): void {
    this._threadId = null
    this.kernel.clearSessionId()
  }

  // ── setters ────────────────────────────────────────────────────────────

  setModel(model: string | undefined): void {
    this.kernel.setModel(model)
  }

  get model(): string | undefined {
    return this.kernel.model
  }

  setEffortLevel(level: string | undefined): void {
    this.kernel.setEffortLevel(level)
  }

  get effortLevel(): string | undefined {
    return this.kernel.effortLevel
  }

  setTraceId(traceId: string | undefined): void {
    this.kernel.setTraceId(traceId)
  }

  updateConfig(config: OpenClaudeConfig): void {
    this.kernel.updateConfig(config)
  }

  setToolsets(toolsets: string[] | undefined): void {
    // codex 内核无 toolset gating(CCB --toolsets 是 CCB 私有概念)。stash 满足
    // 契约 + submit() 的 change-detection 不再触发无谓 shutdown 循环。
    this._toolsets = toolsets
  }

  get toolsets(): string[] | undefined {
    return this._toolsets
  }

  setExecutionTarget(target: ExecutionTarget): void {
    if (target.kind !== 'local') {
      // remote 执行目标是 SubprocessRunner(ssh ControlMaster)私有能力。
      log.warn('codex engine does not support remote execution target; keeping local', {
        requested: target.kind,
      })
      return
    }
    this._executionTarget = target
  }

  get executionTarget(): ExecutionTarget {
    return this._executionTarget
  }

  /** M1b/M2 relay 接线口:master 下发的 per-turn provider 路由覆盖(API relay
   *  账号组)。直通内核;route 变化由内核在下一 turn 判定并自重启进程。 */
  setCodexRoute(route: CodexProviderConfigOverride | null | undefined): void {
    this.kernel.setCodexRoute(route)
  }

  /** codex plan 模式(conversationMode)直通口。M1a 未接 server 线,恒 default。 */
  setConversationMode(mode: 'default' | 'plan' | undefined): void {
    this.kernel.setConversationMode(mode)
  }

  // ── permission ─────────────────────────────────────────────────────────

  sendPermissionResponse(requestId: string, response: unknown): boolean {
    // approvalPolicy=never + sandbox danger-full-access(容器即沙箱);app-server
    // 反向 approval/elicitation 请求在内核 handleLine 内受控 auto-approve。
    return this.kernel.sendPermissionResponse(requestId, response)
  }

  // ── runtime state ──────────────────────────────────────────────────────

  getPartialSnapshot(): PartialSnapshot {
    return this._activeTurn ? snapshotOf(this._activeTurn.parser) : EMPTY_SNAPSHOT
  }

  get pendingToolCalls(): number {
    return this._activeTurn?.parser.pendingToolCalls ?? 0
  }

  get isRunning(): boolean {
    return this.kernel.isRunning
  }

  get lastActivityAt(): number {
    return this.kernel.lastActivityAt
  }

  set lastActivityAt(ts: number) {
    this.kernel.lastActivityAt = ts
  }

  getBoundRepoBinding(): { selectionVersion: number; workspaceDir: string } | null {
    return this.kernel.getBoundRepoBinding()
  }
}

// ── registry 注册(import 本模块即生效;sessionManager 顶部显式 import)──────
registerEngine('codex', (opts) => new CodexAdapter(opts))
