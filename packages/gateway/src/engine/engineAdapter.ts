/**
 * engineAdapter — EngineAdapter 契约(形式化原 SubprocessRunner 的 de-facto
 * EventEmitter 契约,底座差异全部收口在 adapter 内)。
 *
 * events(adapter 对外 emit,sessionManager / getOrCreate 消费):
 *   - 'session_id' (id: string)      底座原生可续传 id(CCB session_id / codex thread_id)
 *   - 'spawn'      ({ resumed })     子进程/后端启动;resumed=true 表示带历史态恢复
 *   - 'exit'       ({ code, signal, crashed })
 *   - 'error'      (err: Error)     底座进程级错误(spawn 失败等)
 *   - 'parse_error'({ line, err })  底座输出解析失败(CCB stdout 非法 JSONL)
 *   - 'overflow'   (info)           非用户可见 stderr 缓冲异常超限强杀
 *   - 'activity'   ()               底座每条原始消息(turn 内 30-min 硬背书 timer 的
 *                                   refresh 信号 —— 与旧 runner 'message' 逐条对齐,
 *                                   包括 parser 会忽略的消息)
 *   - 'billing'    (EngineBillingEvent) engine-reported 计费侧信道(M1 codex 接线)
 *
 * 硬约束:底座原生消息形状(CCB stream-json SdkMessage、codex fake-SDK
 * RunnerMessage)只允许存在于各 adapter 内部,不得跨出 engine/ 模块。
 */
import type { EventEmitter } from 'node:events'
import type { OpenClaudeConfig } from '@openclaude/storage'
import type { GoalStateSnapshot, OutboundContentBlock } from '@openclaude/protocol'
import type { ExecutionTarget } from '../remoteTarget.js'
import type { TurnModelAuthority, UsageAttributionTag } from '../subprocessRunner.js'
import type {
  EngineEvent,
  DurableRuntimeEvent,
  PartialSnapshot,
  PhantomSignals,
  TurnSummary,
} from './engineEvents.js'

/** 能力声明 —— 消灭 provider 字符串 if/else 散点;server/bridge/billing 按能力分支。 */
export interface EngineCapabilities {
  /** 'proxy' = 上游代理旁路计费(CCB/anthropicProxy);
   *  'engine-reported' = runner 上报 billing 帧 → master bridge settle(codex)。 */
  billingMode: 'proxy' | 'engine-reported'
  supportsEffort: boolean
  resumeKind: 'ccb-session' | 'codex-thread'
  needsServerRequestId: boolean
}

/**
 * Session 级跨 turn 累计的 engine 中立契约(M0 Codex 评审 nit①)。
 * `_lastCcbCumulativeCost` 之类的底座私有 delta 基线字段**不在**本契约里 ——
 * CCB 兼容子契约(CcbSessionTotals,含该字段)收在 engine/ccbAdapter.ts,
 * 新底座不被迫认识 CCB 私有字段。adapter 可 mutate 此引用(totalCostUSD +=
 * delta / turns += 1),单一权威仍是 AgentSession 对象。
 */
export interface EngineSessionTotals {
  totalCostUSD: number
  turns: number
}

export type CollabAgentPolicy = 'team-mode-prefer-delegate'

/** Mutable turn-scoped counter shared by adapter-internal and orchestrator
 * retries. The browser/master persist only values, never this object. */
export interface AutomaticRetryState {
  rootClientMessageId: string
  attempt: number
  max: number
}

/** 一次 turn 的入参。spec 契约字段之外,M0 为保 CCB 成本 delta 基线逐字节不变,
 *  额外携带 sessionTotals ref / toolUseIdToName(spec 明示允许 totals ref 方案)。 */
export interface TurnParams {
  input: string | Array<{ type: string; [k: string]: unknown }>
  /** PG coordinator-originated turn. Adapters may use this to enforce that
   * no hidden runner-local queue forms behind the platform claim. */
  queueTurn?: boolean
  /** PR2 v1.0.66 — server-owned requestId(engine-reported 计费关联用;CCB noop 透传)。 */
  requestId?: string
  /** Stable logical paid-turn key shared by persistence and proxy billing. */
  turnKey?: string
  /** Trusted delegate billing attribution captured when the AgentSession was
   * created. CCB already consumes this tag at runner spawn; engine-reported
   * adapters carry it on their billing sideband. */
  usageAttribution?: UsageAttributionTag
  /**
   * 模型权威批次 §4 —— 本 turn 的 master 签名 authority + turn lease bundle。
   *
   * 有值 = bridge turn(inbound 帧带 `__oc_model_authority`,gateway 验签后原样带下来);
   * 无值 = 本地路径 turn(cron/synthetic/delegate)→ CCB 侧自取 `x-oc-local-catalog` token。
   *
   * 只有 CCB 路径消费:gateway 先验签/消费短 authority,runner 再经
   * ANTHROPIC_CUSTOM_HEADERS 把长 lease 挂到每个 `/v1/messages`;codex 路径的请求绑定
   * 走 bridge journal / codex-relay,不读本字段(engine 中立 = 允许底座忽略)。
   */
  modelAuthority?: TurnModelAuthority
  traceId?: string
  /** V3 v7 — canonical assistant/thinking row id(见 sessionManager.runOneTurnWithRetry)。 */
  assistantMessageId?: string
  thinkingMessageId?: string
  /** V3 v7.1 — canonical tool row id factory。 */
  toolMessageIdFactory?: (blockId: string) => string
  /** One turn-wide sequence shared by engine projections and delegation cards. */
  nextDurableEventOrdinal?: () => number
  /** OpenClaude team-mode hint for Codex native collaboration tool calls. */
  collabAgentPolicy?: CollabAgentPolicy
  automaticRetryState?: AutomaticRetryState
  /** turn 事件流(内容事件 + tool_use/result_detected)。同步、按底座输出顺序回调。 */
  onEvent: (e: EngineEvent) => void
  /** Runtime output that legitimately arrives after the engine's terminal
   * result. The orchestrator must durably continue the finalized turn before
   * surfacing the projected live block. */
  onPostTerminalRuntimeEvent?: (
    event: DurableRuntimeEvent,
    block: OutboundContentBlock,
  ) => void
  /**
   * Session 级跨 turn 累计(engine 中立;见 EngineSessionTotals)。CCB 路径
   * parser 直接 mutate 此引用(totalCostUSD += delta / turns += 1,另经
   * CcbSessionTotals 兼容子契约维护 _lastCcbCumulativeCost 基线),与迁移前
   * sessionManager 传 `sessionTotals: session` 完全一致 —— 单一权威仍是
   * AgentSession 对象,auth/phantom 回滚由 sessionManager 就地恢复。
   */
  sessionTotals: EngineSessionTotals
  /** 跨 turn 的 tool_use id → name 映射(session 拥有,submit 每 turn clear)。 */
  toolUseIdToName: Map<string, string>
}

/**
 * 一次 turn 的运行句柄。turn-scoped(等价旧 _runOneTurn 里的 parser 闭包),
 * 避免 stale detach / 交叠 turn 场景下跨 turn 误读误清(旧代码
 * `session._currentParser === parser` identity guard 的对位物,guard 收在 adapter 内)。
 */
export interface EngineTurnRun {
  /** 底层 submit(stdin 写入/请求发出)的结果。失败(spawn 失败、crash-loop
   *  backoff)时 reject —— 对位旧 `runner.submit(...).catch(...)`。 */
  submitted: Promise<void>
  /** turn 汇总。正常终态(底座 result 行)resolve TurnSummary;异常终态
   *  (error/exit/timeout 路径经 end() 强制收尾)resolve null(= 旧 onFinish(null))。
   *  永不 reject。 */
  summary: Promise<TurnSummary | null>
  /** 强制结束本 turn(幂等)。等价旧 detach() 里的 parser.finish():触发 summary
   *  以当前累积态 resolve(有 result 行则带汇总,否则 null)。只作用于本 turn。 */
  end(): void
  /** crash/interrupt 部分持久化数据源(本 turn 的实时快照,数组为拷贝)。 */
  getPartialSnapshot(): PartialSnapshot
  /** phantom 三态信号(turn 异常终态、summary=null 时仍可读 —— 旧代码在
   *  onFinish(null) 里同样消费 telemetry signals)。 */
  getPhantomSignals(): PhantomSignals
  /** 本 turn 是否已终态(= 旧 parser.finalized)。 */
  readonly finalized: boolean
  /** 本 turn 未完成的 tool call 数(= 旧 parser.pendingToolCalls)。 */
  readonly pendingToolCalls: number
}

/**
 * EngineAdapter — 每个 AgentSession 一个实例(getOrCreate 经 registry factory 构造)。
 *
 * "runtime passthrough" 段是 sessionManager/server 既有引用面的直通口
 * (effort/model/toolsets/executionTarget/lastActivityAt/repoBinding),
 * M0 保持与 SubprocessRunner 同名同语义,后续底座各自实现或声明不支持。
 */
export interface EngineAdapter extends EventEmitter {
  readonly engineId: string // 'ccb' | 'codex'
  readonly capabilities: EngineCapabilities

  // ── lifecycle ──
  start(): Promise<void>
  submitTurn(params: TurnParams): EngineTurnRun
  /** 中断当前 turn(CCB: stdin control_request interrupt)。false = 无活进程。 */
  interrupt(): boolean
  shutdown(): Promise<void>
  /** Resolves only after the current process generation's stdout has closed.
   * `shutdown()` itself is deliberately bounded for process supervision, so
   * terminal persistence must additionally await this barrier before freezing
   * a paid turn's immutable tape. */
  waitForOutputDrain(): Promise<void>

  // ── resume ──
  /** 底座原生可续传 id(CCB session_id / codex thread_id);未知为 null。 */
  readonly nativeSessionId: string | null
  clearSessionId(): void

  // ── setters(与原 SubprocessRunner 对齐;均为 opts mutator,重启后生效)──
  setModel(model: string | undefined): void
  readonly model: string | undefined
  setEffortLevel(level: string | undefined): void
  readonly effortLevel: string | undefined
  setTraceId(traceId: string | undefined): void
  /** Synchronize the platform-authoritative session goal. Called only at a
   * SessionManager lock boundary, never as a turn interruption mechanism. */
  setGoalState(goal: GoalStateSnapshot | null): Promise<void>
  updateConfig(config: OpenClaudeConfig): void
  setToolsets(toolsets: string[] | undefined): void
  readonly toolsets: string[] | undefined
  setExecutionTarget(target: ExecutionTarget): void
  readonly executionTarget: ExecutionTarget

  // ── permission ──
  sendPermissionResponse(requestId: string, response: unknown): boolean

  // ── runtime state ──
  /** 当前 turn 的部分快照(无活跃 turn 时为空快照)。crash-flush 优先用
   *  EngineTurnRun.getPartialSnapshot()(turn-scoped,防交叠 turn 误读)。 */
  getPartialSnapshot(): PartialSnapshot
  /** 当前活跃 turn 的未完成 tool call 数(idle watchdog 阈值选择用;turn 间为 0)。 */
  readonly pendingToolCalls: number
  readonly isRunning: boolean
  /** 底座最近输出活动时间戳(liveness watchdog 读;submit 开始时会重置写入)。 */
  lastActivityAt: number
  /** Phase 5:当前活跃进程 spawn 时绑定的 ready repo snapshot(recycle 决策用)。 */
  getBoundRepoBinding(): { selectionVersion: number; workspaceDir: string } | null
}
