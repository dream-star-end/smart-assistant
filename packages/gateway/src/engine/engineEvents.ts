/**
 * engineEvents — Engine 适配层的中立事件/汇总类型(权威源)。
 *
 * M0(v5-engine-adapter-PLAN §engineEvents.ts):
 *   - 原 ccbMessageParser.ts 的内容/turn 生命周期类型(SessionStreamEvent 的
 *     block/final/error/permission_request/turn_status 变体,及 PermissionRequest/
 *     DetectedToolUse/DetectedToolResult/TurnToolEntry/SegmentRecord)整体迁到本模块;
 *     ccbMessageParser.ts 保留 re-export,存量 import 不动。
 *   - `EngineEvent` 在上述内容事件之外,把 parser 的 DetectedToolUse/DetectedToolResult
 *     回调升格为一等事件(`tool_use_detected` / `tool_result_detected`),作为 cron 桥接
 *     与 tool.called 指标的 engine 中立来源。这两个 kind 只在 sessionManager 编排层
 *     消费,**绝不下发** server.ts 的 outbound 流(与旧 parser 回调语义一致)。
 *   - `EngineBillingEvent`:engine-reported 计费侧信道(原 kind:'codex_billing' 语义),
 *     不在 EngineEvent 联合里;adapter 经独立 'billing' 事件通道 emit。wire 帧名
 *     `outbound.codex_billing` 不变。
 *   - `TurnSummary` / `PartialSnapshot`:submitTurn 汇总与 crash/interrupt 部分持久化
 *     的显式契约(承接原 TurnResult 直读语义)。
 *
 * 硬约束:底座原生消息形状(CCB stream-json SdkMessage、codex fake-SDK RunnerMessage)
 * 只允许存在于各 adapter 内部,不得出现在本模块的任何类型里。
 */
import type { OutboundContentBlock } from '@openclaude/protocol'

/** Permission request from the engine (CCB: stdio control_request protocol) */
export interface PermissionRequest {
  requestId: string
  toolName: string
  toolUseId?: string
  input: Record<string, unknown>
  /** Suggested permission rules the user can adopt */
  permissionSuggestions?: unknown[]
}

/** Detected tool_use that may need bridging (CronCreate, CronDelete, etc.) */
export interface DetectedToolUse {
  name: string
  id: string
  input: Record<string, any>
}

/** Detected tool_result for completed tool calls */
export interface DetectedToolResult {
  toolUseId: string
  toolName: string
  preview: string
  isError: boolean
  /** ms between tool_use finalization and tool_result arrival.
   *  0 if the tool_use was not observed in this parser (e.g. stale result). */
  durationMs: number
  /** Truncated preview of tool input at finalization (<=500 chars). */
  inputPreview?: string
}

/** Snapshot of one completed top-level tool call within a turn. Captured by
 *  the parser so SessionManager can hand it to v3MasterSink, which writes it
 *  as a server-authored 'tool' message — the durable copy that survives
 *  refresh / mobile-bg recovery. Subagent-issued tools (parentToolUseId set)
 *  are intentionally excluded; their durability is owned by the parent
 *  Agent card and tracked separately (Phase 2). */
export interface TurnToolEntry {
  /** Anthropic tool_use_id — also serves as the stable client blockId */
  toolUseId: string
  /** Same value as toolUseId, kept as a separate field so server-authored
   *  payloads can refer to it by an explicit name without overloading
   *  toolUseId across protocol layers. */
  blockId: string
  toolName: string
  /** Possibly-capped tool input. May be a structured object or a JSON-encoded
   *  string when the original exceeded the parser's input-json byte cap. */
  inputJson: unknown
  /** Truncated string preview of the input for compact rendering */
  inputPreview: string
  /** Tool stdout / textual output, capped by the parser */
  output: string
  isError: boolean
  /** ms between tool_use finalization and tool_result arrival; 0 if unknown */
  durationMs: number
  /** Wall-clock timestamp (Date.now ms) when the tool_result arrived */
  ts: number
  /** Fix B (2026-05-25) — wall-clock timestamp (Date.now ms) when the parser
   *  FIRST OBSERVED the tool_use content_block_start (or assistant snapshot,
   *  whichever fires first on the runner path being used). This is the tool
   *  card's APPEARANCE time, distinct from `ts` (tool_result COMPLETION
   *  time). Master prefers this for the persisted row's ts so parallel-tool
   *  refresh order matches the live emit order; falls back to a computed
   *  offset when absent (pre-Fix-B gateway). Plan §3.5.4. */
  arrivedAt: number
  inputTruncated?: boolean
  outputTruncated?: boolean
}

/** One assistant/thinking text segment within a turn. A new segment starts
 *  after a tool_use boundary, but ONLY if the previous segment has actual
 *  content (pattern `tool → text` keeps text in s0; pattern `text → tool → text`
 *  splits into s0 + s1). Pure tool turns produce no segments. */
export interface SegmentRecord {
  index: number
  text: string
  ts: number
}

/** turn 终态 meta(原 SessionStreamEvent 'final' 变体的 meta,逐字段不变)。 */
export interface EngineFinalMeta {
  cost?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  totalCost?: number
  turn?: number
  /** Anthropic API stop_reason, extracted from CCB result row.
   *  Values: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'
   *  | 'pause_turn' | 'refusal'. Used by sessionManager for phantom
   *  judgment and by frontend for empty-turn notice text. */
  stopReason?: string
}

/**
 * 内容/turn 生命周期事件(engine 中立)。原 SessionStreamEvent 除 codex_billing
 * 之外的全部变体,形状逐字段不变 —— server.ts 的 outbound 分发逻辑零改动。
 */
export type EngineContentEvent =
  | { kind: 'block'; block: OutboundContentBlock }
  | { kind: 'final'; meta?: EngineFinalMeta }
  | { kind: 'error'; error: string }
  | { kind: 'permission_request'; request: PermissionRequest }
  // 当前 turn 的 backend-side 非流式阶段状态(目前仅 'compacting' / null)。
  // CCB 由 stdout `{type:'system', subtype:'status', status:'compacting'|null}`
  // 触发,gateway 上层包装成 `outbound.turn_status` 帧推给前端。受控枚举,
  // 不透传任意底座内部状态 —— 防协议被底座私有状态污染。
  | { kind: 'turn_status'; status: 'compacting' | null }

/**
 * EngineAdapter → sessionManager 的 canonical 事件模型。
 *
 * `tool_use_detected` / `tool_result_detected` 是编排层专用(cron 桥接 +
 * tool.called 指标),sessionManager 在 _runOneTurn 里就地消费,不进 outbound 流。
 */
export type EngineEvent =
  | EngineContentEvent
  | { kind: 'tool_use_detected'; tool: DetectedToolUse }
  | { kind: 'tool_result_detected'; result: DetectedToolResult }

/**
 * Engine-reported 计费侧信道(原 SessionStreamEvent kind:'codex_billing' 的
 * payload 语义,逐字段不变)。billingMode:'engine-reported' 的 adapter 在 turn
 * 终态经独立 'billing' 事件通道 emit;server.ts 仍包装为 outbound.codex_billing
 * wire 帧(帧名不变)。M0 阶段无 emitter(CCB 是 proxy 计费),M1 CodexAdapter 接线。
 */
export interface EngineBillingEvent {
  requestId: string
  status: 'success' | 'error'
  durationMs: number
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    reasoning_output_tokens?: number
  }
  errorReason?: string
  // Issue A v1.0.108 — codex account/rateLimits/updated 快照,piggy-back 到 billing
  // 终态帧让 master.userChatBridge 落库到 claude_accounts。utilization 0..100,
  // resetsAt ISO8601(runner 已把 epoch sec 转 ISO,bridge 不再二次解析)。
  rateLimits?: {
    util5h?: number
    reset5h?: string
    util7d?: number
    reset7d?: string
  }
}

/**
 * 兼容联合:原 ccbMessageParser.SessionStreamEvent,形状逐变体不变。
 * server.ts / cron / skillTrain 等存量消费方继续以此为 onEvent 签名;
 * codex_billing 变体保留(PR2 v1.0.66 wire 语义),但 M0 无生产者。
 */
export type SessionStreamEvent =
  | EngineContentEvent
  | ({ kind: 'codex_billing' } & EngineBillingEvent)

/** 底座对"本 turn 是否真调了模型 API"的一等信号(CCB 由 TelemetryChannel 提供;
 *  其他 engine 缺省 'unknown' → 上层沿用 legacy 9-AND phantom 启发式,R7 永不 fail-closed)。 */
export interface PhantomSignals {
  apiState: 'called' | 'skipped' | 'unknown'
  /** apiState === 'skipped' 时底座报告的原因(如 slash command)。 */
  skipReason: string | null
}

/** apiState='called' 但 turn 无 stop_reason 且零输出时的诊断快照(warn 日志用)。
 *  字段值与旧 sessionManager 直读 TelemetryChannel 的日志字段逐项对应。 */
export interface TurnIncompleteDiagnostics {
  hadApiResponse: boolean
  apiRespStopReason?: unknown
  lastToolPreUse?: unknown
  toolErrorCount: number
}

/**
 * TurnSummary — engine 中立的 turn 汇总(承接原 TurnResult 直读语义)。
 * submitTurn 的 summary promise 在 turn 正常终态(底座 result 行)时 resolve 本结构;
 * 异常终态(error/exit/timeout 强制 finish)resolve null,与旧 onFinish(null) 对齐。
 */
export interface TurnSummary {
  usage: {
    cost: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
  }
  assistantText: string
  thinkingText: string
  assistantSegments: SegmentRecord[]
  thinkingSegments: SegmentRecord[]
  tools: TurnToolEntry[]
  stopReason: string | null
  numTurns: number | null
  isError: boolean
  /** 错误分类。'auth' 触发 sessionManager 的 token-refresh + 回滚重试路径。
   *  错误字符串是底座私有知识(CCB: AUTH_KEYWORDS_RE / AUTH_ERROR_PREFIX_RE),
   *  分类逻辑下沉在各 adapter 内。 */
  errorKind?: 'auth' | 'other'
  /** 底座报告 --resume/thread id 已失效(CCB: "No conversation found with
   *  session ID")。sessionManager 据此逐出 resume-map 条目。 */
  staleResumeId: boolean
  phantomSignals: PhantomSignals
  /** CCB telemetry 诊断快照(incomplete warn 日志用);其他 engine 可缺省。 */
  diagnostics?: TurnIncompleteDiagnostics
}

/**
 * crash/interrupt 部分持久化数据源(对应旧 sessionManager 直读
 * parser.assistantBuf / thinkingBuf / completedTools / *Segments)。
 * 返回值为快照拷贝(数组均为 fresh copy),caller 可安全持有。
 */
export interface PartialSnapshot {
  assistantText: string
  thinkingText: string
  completedTools: TurnToolEntry[]
  assistantSegments: SegmentRecord[]
  thinkingSegments: SegmentRecord[]
}
