/**
 * Codex app-server protocol helpers: JSON-RPC line classification and replies, user-input / MCP elicitation normalisation, collab-agent summaries, token-usage and rate-limit parsing, shell-wrapper stripping for command summaries.
 *
 * Moved verbatim out of codexAppServerRunner.ts — FINDINGS §8 (cc2), OCV5-474. codexAppServerRunner.ts
 * imports these back and re-exports its former exports, so its import surface is unchanged.
 */
import type { ToolTerminationReason, TurnTokenUsageSnapshot } from '@openclaude/protocol'
import type { ClassifiedErrorCode } from '../errorClassify.js'
import type { CollabAgentPolicy } from './engineAdapter.js'

export interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  method: string
}

export type CodexGoalBlock = {
  blockId: string
  objective?: string
  status?: string
  tokenBudget?: number | null
  tokensUsed?: number
  timeUsedSeconds?: number
  updatedAt?: number
  cleared?: boolean
  platformGoalId?: string
  platformStateRevision?: number
}

type CollabAgentStateSummary = { status: string; message?: string }

function finiteNumber(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
}

export function normalizeCodexGoal(raw: unknown, cleared = false, blockId = 'codex-goal'): CodexGoalBlock {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const goal: CodexGoalBlock = { blockId }
  if (typeof obj.objective === 'string') goal.objective = obj.objective
  if (typeof obj.status === 'string') goal.status = obj.status
  if (obj.tokenBudget === null) {
    goal.tokenBudget = null
  } else {
    const tokenBudget = finiteNumber(obj.tokenBudget)
    if (tokenBudget !== undefined) goal.tokenBudget = tokenBudget
  }
  const tokensUsed = finiteNumber(obj.tokensUsed)
  if (tokensUsed !== undefined) goal.tokensUsed = tokensUsed
  const timeUsedSeconds = finiteNumber(obj.timeUsedSeconds)
  if (timeUsedSeconds !== undefined) goal.timeUsedSeconds = timeUsedSeconds
  const updatedAt = finiteNumber(obj.updatedAt)
  if (updatedAt !== undefined) goal.updatedAt = updatedAt
  if (cleared) goal.cleared = true
  return goal
}

export function collabReceiverThreadIds(item: Record<string, unknown>): string[] {
  return Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : []
}

export function collabAgentsStates(
  item: Record<string, unknown>,
): Record<string, CollabAgentStateSummary> {
  const raw = item.agentsStates
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, CollabAgentStateSummary> = {}
  for (const [threadId, stateUnk] of Object.entries(raw as Record<string, unknown>)) {
    const state =
      stateUnk && typeof stateUnk === 'object' ? (stateUnk as Record<string, unknown>) : {}
    const status = typeof state.status === 'string' ? state.status : ''
    if (!threadId || !status) continue
    const message = typeof state.message === 'string' && state.message ? state.message : undefined
    out[threadId] = message ? { status, message } : { status }
  }
  return out
}

export function collabTool(item: Record<string, unknown>): string {
  return typeof item.tool === 'string' && item.tool ? item.tool : 'unknown'
}

export function collabStatus(item: Record<string, unknown>): string {
  return typeof item.status === 'string' && item.status ? item.status : 'unknown'
}

export function collabPrompt(item: Record<string, unknown>): string {
  return typeof item.prompt === 'string' ? item.prompt : ''
}

export function shortThreadId(threadId: string): string {
  return threadId.length > 12 ? `${threadId.slice(0, 6)}…${threadId.slice(-4)}` : threadId
}

export function collabAgentInput(
  item: Record<string, unknown>,
  description: string,
  policy?: CollabAgentPolicy,
): Record<string, unknown> {
  const prompt = collabPrompt(item)
  const receivers = collabReceiverThreadIds(item)
  const input: Record<string, unknown> = {
    openclaudeOrigin: 'codex-collab',
    ...(policy === 'team-mode-prefer-delegate' ? { openclaudeTeamFallback: true } : {}),
    description: description || prompt || 'Codex 子 Agent',
    codexTool: collabTool(item),
  }
  if (prompt) input.prompt = prompt
  if (receivers.length > 0) input.receiverThreadIds = receivers
  if (typeof item.model === 'string' && item.model) input.model = item.model
  if (typeof item.reasoningEffort === 'string' && item.reasoningEffort) {
    input.reasoningEffort = item.reasoningEffort
  }
  const states = collabAgentsStates(item)
  if (Object.keys(states).length > 0) input.agentsStates = states
  return input
}

export function summarizeCollabControl(item: Record<string, unknown>): string {
  const tool = collabTool(item)
  const status = collabStatus(item)
  const receivers = collabReceiverThreadIds(item)
  const states = collabAgentsStates(item)
  const parts = [`${tool}: ${status}`]
  if (receivers.length > 0) parts.push(`receivers: ${receivers.map(shortThreadId).join(', ')}`)
  const stateLines = Object.entries(states).map(([threadId, state]) => {
    const msg = state.message ? ` — ${state.message}` : ''
    return `${shortThreadId(threadId)}: ${state.status}${msg}`
  })
  if (stateLines.length > 0) parts.push(stateLines.join('\n'))
  return parts.join('\n')
}

export function isTerminalCollabAgentStatus(status: string): boolean {
  return (
    status === 'completed' || status === 'errored' || status === 'shutdown' || status === 'notFound'
  )
}

export function isErrorCollabAgentStatus(status: string): boolean {
  return status === 'errored' || status === 'notFound'
}

export function codexToolOutcome(item: Record<string, unknown>): {
  isError: boolean
  terminationReason?: ToolTerminationReason
} {
  const status = typeof item.status === 'string' ? item.status.toLowerCase() : ''
  if (status === 'cancelled' || status === 'canceled' || status === 'interrupted') {
    return { isError: true, terminationReason: 'cancelled' }
  }
  if (
    status === 'failed' ||
    status === 'error' ||
    status === 'errored' ||
    (item.error !== undefined && item.error !== null)
  ) {
    return { isError: true, terminationReason: 'tool_error' }
  }
  return { isError: false }
}

/** Structured error produced by `sendRequest` when codex replies with a
 *  JSON-RPC error frame. Callers can branch on `rpcCode` / `rpcMessage` /
 *  `rpcMethod` without re-parsing `message`; the human-readable `message`
 *  is preserved (`"<method> -> <code>: <message>"`) for log/UI use. */
export interface JsonRpcCallError extends Error {
  rpcCode: number
  rpcMessage: string
  rpcMethod: string
}

/** Detect codex's "thread/resume against a thread whose rollout is no longer
 *  on disk" failure mode. Triggered when v3 commercial containers idle-rebuild
 *  and their `~/.codex/sessions/...` JSONL is wiped while master gateway still
 *  holds the old `thread_id` in resume-map.json. The fix is a transparent
 *  thread/start fallback (see runTurn attach block).
 *
 *  Three guards (Codex review #019e0b72 BLOCKER 1):
 *   - `rpcMethod === 'thread/resume'` — only this method can produce the
 *     missing-rollout case; other methods returning -32600 mean something else.
 *   - `rpcCode === -32600` — JSON-RPC "Invalid Request" code that codex 0.125
 *     reuses for missing rollout (verified via spike).
 *   - `/no rollout found/i` — text guard so a future codex release that
 *     repurposes -32600 for protocol/schema drift (e.g. param shape change)
 *     won't be silently downgraded into "start a fresh thread". Drift should
 *     surface as a hard error instead. */
export function isMissingRolloutError(err: unknown): err is JsonRpcCallError {
  if (!(err instanceof Error)) return false
  const e = err as Partial<JsonRpcCallError>
  return (
    e.rpcMethod === 'thread/resume' &&
    e.rpcCode === -32600 &&
    typeof e.rpcMessage === 'string' &&
    /no rollout found/i.test(e.rpcMessage)
  )
}

/** Detect codex's "clear a goal on a thread that has none" failure mode.
 *  syncPlatformGoal sends a clearing `thread/goal/set` (objective: null) for
 *  every session whose platform goal state is absent/cleared; codex 0.125
 *  rejects that with -32600 "no goal exists" when the thread never had a
 *  goal. The desired end state (no goal upstream) already holds, so the
 *  clear is idempotent success — treating it as fatal killed every turn on
 *  goalless sessions (2026-07-17 outage).
 *
 *  Same three guards as isMissingRolloutError: method + code + text, so a
 *  future codex release repurposing -32600 for schema drift on this method
 *  still surfaces as a hard error. */
export function isGoalAlreadyClearedError(err: unknown): err is JsonRpcCallError {
  if (!(err instanceof Error)) return false
  const e = err as Partial<JsonRpcCallError>
  return (
    e.rpcMethod === 'thread/goal/set' &&
    e.rpcCode === -32600 &&
    typeof e.rpcMessage === 'string' &&
    /no goal exists/i.test(e.rpcMessage)
  )
}

/** Runner message shape used by sessionManager.ts (subset of SdkMessage). */
export interface RunnerMessage {
  type: string
  subtype?: string
  session_id?: string | null
  /** PR2 v1.0.66 — emitResult 透传的 turn requestId,只 codex result 帧带,
   *  sessionManager 据此识别这是 codex turn 终态,转发到 outbound.codex_billing 帧。
   *  非 codex 路径 / 非 result 帧均不带。 */
  requestId?: string
  message?: {
    role?: string
    content?: Array<{
      type: string
      text?: string
      id?: string
      name?: string
      input?: unknown
      tool_use_id?: string
      content?: string | unknown
      is_error?: boolean
      /** OpenClaude-only structured metadata on synthetic codex tool_result rows. */
      exit_code?: number
      termination_reason?: ToolTerminationReason
    }>
  }
  result?: string
  /** Parsed final agentMessage for turns started with outputSchema. The
   * stream may contain abandoned schema-attempt deltas, so only the completed
   * item is authoritative. */
  structured_output?: unknown
  total_cost_usd?: number
  duration_ms?: number
  is_error?: boolean
  // Anthropic-style usage shape — ccbMessageParser._handleResult reads
  // `input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens`.
  // We additionally surface `reasoning_output_tokens` (codex-only field) so
  // PR2 billing can decide whether to fold it into output billing or split
  // it out. Other readers ignore the extra field.
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    reasoning_output_tokens?: number
    total_tokens?: number
  }
  /** Issue A v1.0.108 — codex `account/rateLimits/updated` 快照(0..100% pct + ISO
   *  reset)。仅 codex result 帧带,sessionManager 透传到 outbound.codex_billing
   *  的 rateLimits 字段,master.userChatBridge 落库 claude_accounts.quota_*。 */
  rateLimits?: RuntimeRateLimits
  /** LOW-2(2026-07-03)— codex turn 终态映射到 CCB result 行的 stop_reason 口径,
   *  ccbMessageParser._handleResult 读取后随 final meta 下发(此前 codex 路径恒缺,
   *  会触发 telemetry 的"willCallApi fired but no stop_reason"误告警):
   *    turn status 'completed'   → 'end_turn'
   *    turn status 'interrupted' → 'interrupted'(用户主动 stop;无 Anthropic 等价枚举)
   *    failed / unexpected / catch 路径 → 不带(保持 is_error 语义,不伪造终态)。 */
  stop_reason?: string
  /** Billing-only stable terminal classification. Unlike stop_reason this
   * distinguishes an explicit user interrupt from process/deploy shutdown. */
  billing_terminal_code?: 'USER_CANCELLED' | 'CODEX_ERROR'
  /** turn-retry 批 — runner 现场对 error 文本做的结构化分类(gateway 共享
   *  classifyRunError,非 'unknown' 才带)。ccbMessageParser / server 据此派生
   *  outbound.error.code(权威语义在 protocol turnErrorTaxonomy)。仅 is_error
   *  result 帧带。 */
  errorClass?: ClassifiedErrorCode
  event?: unknown
}

/** codex `ThreadTokenUsage.{last,total}` shape — schema at
 *  /tmp/codex-protocol/v2/ThreadTokenUsageUpdatedNotification.json. */
export interface CodexTokenBreakdown {
  cachedInputTokens: number
  inputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export const _EMPTY_TOKEN_BREAKDOWN: Readonly<CodexTokenBreakdown> = Object.freeze({
  cachedInputTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
})

/** Defensive coerce: ThreadTokenUsageUpdatedNotification.params.tokenUsage.{last,total}.
 *  All numeric fields are required per schema, but a malformed frame should
 *  never throw — coerce non-numbers to 0 and clamp negatives. */
export function _coerceTokenBreakdown(v: unknown): CodexTokenBreakdown {
  if (!v || typeof v !== 'object') return { ..._EMPTY_TOKEN_BREAKDOWN }
  const o = v as Record<string, unknown>
  const num = (k: string) => {
    const n = o[k]
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0
  }
  return {
    cachedInputTokens: num('cachedInputTokens'),
    inputTokens: num('inputTokens'),
    outputTokens: num('outputTokens'),
    reasoningOutputTokens: num('reasoningOutputTokens'),
    totalTokens: num('totalTokens'),
  }
}

/** Compute per-turn delta = current cumulative thread total - prior turn's
 *  cumulative total. Codex's `total` is monotonic across the thread, so taking
 *  the most-recent total minus the snapshot at last completed turn boundary
 *  yields the active turn's actual usage independent of how many notifications
 *  arrive during the turn (multi-LLM-call agentic turns issue one notification
 *  per server-side call). Clamp to 0 to defend against any rare retrograde
 *  updates (codex shouldn't emit them; defense in depth). */
export function _subtractTokenBreakdown(
  a: CodexTokenBreakdown,
  b: CodexTokenBreakdown,
): CodexTokenBreakdown {
  return {
    cachedInputTokens: Math.max(0, a.cachedInputTokens - b.cachedInputTokens),
    inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
    outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
    reasoningOutputTokens: Math.max(0, a.reasoningOutputTokens - b.reasoningOutputTokens),
    totalTokens: Math.max(0, a.totalTokens - b.totalTokens),
  }
}

/** Convert a codex turn-delta breakdown to the Anthropic-shaped `usage` object
 *  that ccbMessageParser._handleResult and downstream billing.calculator read.
 *
 *  Token-shape gotcha that bit production billing (Issue C):
 *    - Codex `inputTokens` is the **total** prompt counted by OpenAI,
 *      cached + non-cached. Reference: openai/codex `non_cached_input =
 *      input_tokens - cached_input_tokens` in `protocol/src/protocol.rs`.
 *    - Anthropic `input_tokens` is **disjoint** from `cache_read_input_tokens`.
 *    - calculator.computeCost adds them, so passing raw codex inputTokens
 *      double-charges the cached portion.
 *  Subtract here at the boundary so the rest of the pipeline can trust the
 *  Anthropic-shape contract.
 *
 *  _coerceTokenBreakdown already guarantees both fields are finite ≥ 0, so
 *  Math.max(0, ...) on the subtraction is sufficient (covers any rare frame
 *  where cached > input, e.g. stale-baseline edge after self-heal). */
export function _codexUsageToAnthropicShape(turn: CodexTokenBreakdown): {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  reasoning_output_tokens: number
  total_tokens: number
} {
  return {
    input_tokens: Math.max(0, turn.inputTokens - turn.cachedInputTokens),
    output_tokens: turn.outputTokens,
    cache_read_input_tokens: turn.cachedInputTokens,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: turn.reasoningOutputTokens,
    total_tokens: turn.totalTokens,
  }
}

export function _codexTurnUsageSnapshot(turn: CodexTokenBreakdown): TurnTokenUsageSnapshot {
  return {
    totalTokens: turn.totalTokens,
    inputTokens: Math.max(0, turn.inputTokens - turn.cachedInputTokens),
    outputTokens: turn.outputTokens,
    cacheReadTokens: turn.cachedInputTokens,
  }
}

/** ThreadItem.type values that are server-internal echoes (not real tool
 *  invocations) and therefore must not surface in the UI. `userMessage` is
 *  the codex echoing back what we just sent; `hookPrompt` is a system hook
 *  (e.g. session-init scaffolding). Either one as a tool card produces the
 *  ugly "CODEX:USERMESSAGE" dump boss flagged. */
export const _SUPPRESSED_ITEM_TYPES = new Set<string>(['userMessage', 'hookPrompt'])

export function _normaliseCodexItemType(type: unknown): string | null {
  if (type === 'context_compaction') return 'contextCompaction'
  return typeof type === 'string' ? type : null
}

export function _isContextCompactionItem(item: unknown): item is Record<string, unknown> {
  if (!item || typeof item !== 'object') return false
  return _normaliseCodexItemType((item as Record<string, unknown>).type) === 'contextCompaction'
}

/** Full item JSON. The old 2,000-character preview budget silently discarded
 * paid tool/MCP output; Turn Tape now handles transport/storage size instead. */
export function _stringifyItemBounded(item: unknown, _legacyBudget?: number): string {
  return JSON.stringify(item) ?? 'null'
}

/** Issue A v1.0.108 — Anthropic-shape 配额快照(0..100% + ISO8601 reset)。
 *  落到 OutboundCodexBilling.rateLimits 字段,master.userChatBridge 直接传 quota.ts。
 *  字段全 optional,允许 plan 类型只有单窗口的情况(e.g. free 只发 7d)。 */
export interface RuntimeRateLimits {
  util5h?: number
  reset5h?: string
  util7d?: number
  reset7d?: string
}

/** codex 5h 窗口对应 windowDurationMins 值(5 * 60)。schema:int64 minutes。 */
export const _CODEX_5H_WINDOW_MINS = 300

/** codex 7d 窗口对应 windowDurationMins 值(7 * 24 * 60)。 */
export const _CODEX_7D_WINDOW_MINS = 10080

/** 解析 codex `account/rateLimits/updated` 通知的 RateLimitSnapshot。
 *
 *  schema(/tmp/codex-protocol/v2/AccountRateLimitsUpdatedNotification.json):
 *    RateLimitSnapshot { credits?, limitId?, limitName?, planType?,
 *                        primary?: RateLimitWindow, rateLimitReachedType?,
 *                        secondary?: RateLimitWindow }
 *    RateLimitWindow { usedPercent: int, resetsAt?: int64 epoch sec,
 *                      windowDurationMins?: int64 }
 *
 *  桶路由:
 *   - `windowDurationMins === 300` → 5h
 *   - `windowDurationMins === 10080` → 7d
 *   - 双窗口都缺 duration 时 fallback `primary=5h secondary=7d`
 *     (实测 plus/pro 双窗口 plan 上 codex 这个顺序稳定)
 *   - **单窗口且无 duration 时拒绝写入**(Codex review NEEDS-FIX 1):
 *     免费/usage-based plan 可能只有 1 个窗口,语义不明,宁可不写也不要写错桶
 *
 *  Returns null 当 snapshot 完全无可用窗口。 */
export function _parseCodexRateLimits(rl: unknown): RuntimeRateLimits | null {
  if (!rl || typeof rl !== 'object') return null
  const r = rl as Record<string, unknown>
  const primary =
    r.primary && typeof r.primary === 'object' ? (r.primary as Record<string, unknown>) : null
  const secondary =
    r.secondary && typeof r.secondary === 'object' ? (r.secondary as Record<string, unknown>) : null

  // 提取每个 window 的 duration(可缺/可 null)
  const primaryMins =
    primary && typeof primary.windowDurationMins === 'number' ? primary.windowDurationMins : null
  const secondaryMins =
    secondary && typeof secondary.windowDurationMins === 'number'
      ? secondary.windowDurationMins
      : null

  // Codex review NEEDS-FIX 1:fallback 仅在双窗口都存在且都无 duration 时启用。
  // 单窗口 + 无 duration:返回 null,避免把 7d-only plan 错写成 5h。
  const eligibleFallback =
    primary !== null && secondary !== null && primaryMins === null && secondaryMins === null

  const out: RuntimeRateLimits = {}
  const writeWindow = (win: Record<string, unknown>, bucket: '5h' | '7d'): void => {
    const usedPercent =
      typeof win.usedPercent === 'number' && Number.isFinite(win.usedPercent)
        ? win.usedPercent
        : null
    const resetsAt =
      typeof win.resetsAt === 'number' && Number.isFinite(win.resetsAt) && win.resetsAt > 0
        ? win.resetsAt
        : null
    if (usedPercent !== null) {
      const clamped = Math.max(0, Math.min(100, usedPercent))
      if (bucket === '5h') out.util5h = clamped
      else out.util7d = clamped
    }
    if (resetsAt !== null) {
      // schema 单位 epoch seconds(int64);> 1e12 视为已经是 ms(防御性兼容)
      const ms = resetsAt >= 1e12 ? resetsAt : resetsAt * 1000
      // Codex review NEEDS-FIX:容器侧 JSON-RPC 任意输入,Date 越界(>±8.64e15 ms)
      // 会让 toISOString 抛 RangeError。new Date(invalid) 的 getTime() 返 NaN,
      // 用此判定避免崩 — 不可解析就丢这个 reset 字段(util 仍写)。
      const d = new Date(ms)
      if (Number.isFinite(d.getTime())) {
        const iso = d.toISOString()
        if (bucket === '5h') out.reset5h = iso
        else out.reset7d = iso
      }
    }
  }

  for (const [slot, win, mins] of [
    ['primary', primary, primaryMins] as const,
    ['secondary', secondary, secondaryMins] as const,
  ]) {
    if (!win) continue
    let bucket: '5h' | '7d' | null = null
    if (mins === _CODEX_5H_WINDOW_MINS) bucket = '5h'
    else if (mins === _CODEX_7D_WINDOW_MINS) bucket = '7d'
    else if (mins === null && eligibleFallback) bucket = slot === 'primary' ? '5h' : '7d'
    if (bucket === null) continue
    writeWindow(win, bucket)
  }

  return Object.keys(out).length === 0 ? null : out
}

type JsonRpcLine =
  | {
      kind: 'response'
      id: number | string
      result?: unknown
      error?: { code: number; message: string }
    }
  | { kind: 'server-request'; id: number | string; method: string; params?: unknown }
  | { kind: 'notification'; method: string; params?: unknown }
  | { kind: 'unknown' }

export interface PendingCodexUserInput {
  /** Exact app-server reverse-RPC id. Must be echoed without string coercion. */
  rpcId: number | string
  /** Canonical key used only for duplicate detection while the RPC is pending. */
  rpcKey: string
  turnId: string
  itemId: string
  /** Existing AskUserQuestion answers are keyed by question text; Codex's
   * response is keyed by this stable question id. */
  questions: Array<{ id: string; question: string }>
}

interface NormalizedCodexUserInput {
  threadId: string
  turnId: string
  itemId: string
  questions: Array<{ id: string; question: string }>
  input: Record<string, unknown>
}

/**
 * Classify a JSON-RPC line. Codex app-server uses bidirectional JSON-RPC 2.0:
 *   - Response: { id, result } or { id, error } — reply to one of our requests.
 *   - Server request: { id, method, params } — server expects a response.
 *   - Notification: { method, params } — fire-and-forget event.
 * Anything else (including non-JSON) is `unknown` and surfaced via parse_error.
 */
export function _classifyJsonRpcLine(line: string): JsonRpcLine {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { kind: 'unknown' }
  }
  if (!parsed || typeof parsed !== 'object') return { kind: 'unknown' }
  const m = parsed as Record<string, unknown>
  if (typeof m.method === 'string') {
    if ('id' in m && (typeof m.id === 'number' || typeof m.id === 'string')) {
      return {
        kind: 'server-request',
        id: m.id as number | string,
        method: m.method,
        params: m.params,
      }
    }
    return { kind: 'notification', method: m.method, params: m.params }
  }
  if (
    'id' in m &&
    (typeof m.id === 'number' || typeof m.id === 'string') &&
    ('result' in m || 'error' in m)
  ) {
    return {
      kind: 'response',
      id: m.id as number | string,
      result: m.result,
      error: m.error as { code: number; message: string } | undefined,
    }
  }
  return { kind: 'unknown' }
}

export function jsonRpcResult(id: number | string, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

export function jsonRpcMethodNotFound(id: number | string, method: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message: `method '${method}' not implemented by openclaude-gateway`,
    },
  })
}

export function jsonRpcInvalidParams(id: number | string, method: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32602,
      message: `invalid params for '${method}'`,
    },
  })
}

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

export function codexReverseRpcKey(id: number | string): string {
  return JSON.stringify([typeof id, id])
}

/** Project Codex 0.144/0.149 ToolRequestUserInputParams onto the already-shipped
 * CCB AskUserQuestion input shape. Codex has no multiSelect request field;
 * every model-facing option list is mutually exclusive, so the projection is
 * explicitly single-select. Protocol-only fields are retained as harmless
 * metadata inside the existing question objects (no second wire model). */
export function normalizeCodexUserInput(paramsUnk: unknown): NormalizedCodexUserInput | null {
  const params = asRecord(paramsUnk)
  const threadId = typeof params.threadId === 'string' ? params.threadId : ''
  const turnId = typeof params.turnId === 'string' ? params.turnId : ''
  const itemId = typeof params.itemId === 'string' ? params.itemId : ''
  if (!threadId || !turnId || !itemId || !Array.isArray(params.questions)) return null

  const inputQuestions: Array<Record<string, unknown>> = []
  const questions: Array<{ id: string; question: string }> = []
  for (const questionUnk of params.questions) {
    const question = asRecord(questionUnk)
    const id = typeof question.id === 'string' ? question.id : ''
    const header = typeof question.header === 'string' ? question.header : ''
    const text = typeof question.question === 'string' ? question.question : ''
    if (!id || !text || typeof question.header !== 'string') return null

    const rawOptions = question.options
    if (rawOptions !== null && rawOptions !== undefined && !Array.isArray(rawOptions)) return null
    const options: Array<{ label: string; description: string }> = []
    for (const optionUnk of Array.isArray(rawOptions) ? rawOptions : []) {
      const option = asRecord(optionUnk)
      if (typeof option.label !== 'string' || typeof option.description !== 'string') return null
      options.push({ label: option.label, description: option.description })
    }

    questions.push({ id, question: text })
    inputQuestions.push({
      id,
      header,
      question: text,
      multiSelect: false,
      isOther: question.isOther === true,
      isSecret: question.isSecret === true,
      options,
    })
  }
  if (questions.length === 0) return null

  const isBlocking = params.isBlocking
  if (isBlocking !== undefined && typeof isBlocking !== 'boolean') return null
  const autoResolutionMs = params.autoResolutionMs
  if (
    autoResolutionMs !== undefined &&
    autoResolutionMs !== null &&
    (typeof autoResolutionMs !== 'number' ||
      !Number.isSafeInteger(autoResolutionMs) ||
      autoResolutionMs < 60_000 ||
      autoResolutionMs > 240_000)
  ) {
    return null
  }

  // 0.149 makes isBlocking authoritative and deprecates autoResolutionMs.
  // Legacy 0.144 requests omit isBlocking, so preserve their old duration
  // semantics. A new non-blocking request without a usable legacy duration
  // receives the platform minimum instead of becoming accidentally blocking.
  const effectiveAutoResolutionMs =
    isBlocking === true
      ? undefined
      : isBlocking === false
        ? typeof autoResolutionMs === 'number'
          ? autoResolutionMs
          : 60_000
        : typeof autoResolutionMs === 'number'
          ? autoResolutionMs
          : undefined

  return {
    threadId,
    turnId,
    itemId,
    questions,
    input: {
      questions: inputQuestions,
      ...(typeof effectiveAutoResolutionMs === 'number'
        ? { autoResolutionMs: effectiveAutoResolutionMs }
        : {}),
    },
  }
}

function chooseApprovalString(options: unknown[]): string {
  const strings = options.filter((v): v is string => typeof v === 'string')
  const preferred = [
    'approve',
    'always_allow',
    'allow',
    'approved',
    'accept',
    'approved_for_session',
    'yes',
  ]
  for (const p of preferred) {
    const hit = strings.find((s) => s.toLowerCase().includes(p))
    if (hit) return hit
  }
  return (
    strings.find((s) => !/decline|deny|denied|cancel|abort|reject/i.test(s)) ?? strings[0] ?? ''
  )
}

function buildMcpElicitationFieldValue(schemaUnk: unknown): unknown {
  const schema = asRecord(schemaUnk)
  if ('default' in schema && schema.default !== undefined && schema.default !== null) {
    return schema.default
  }

  if (Array.isArray(schema.enum)) {
    return chooseApprovalString(schema.enum)
  }
  if (Array.isArray(schema.oneOf)) {
    return chooseApprovalString(schema.oneOf.map((o) => asRecord(o).const))
  }
  const items = asRecord(schema.items)
  if (Array.isArray(items.anyOf)) {
    return [chooseApprovalString(items.anyOf.map((o) => asRecord(o).const))]
  }
  if (Array.isArray(items.enum)) {
    return [chooseApprovalString(items.enum)]
  }

  switch (schema.type) {
    case 'boolean':
      return true
    case 'number':
    case 'integer':
      return 0
    case 'array':
      return []
    case 'string':
      return ''
    default:
      return null
  }
}

export function buildMcpElicitationContent(paramsUnk: unknown): Record<string, unknown> | null {
  const params = asRecord(paramsUnk)
  if (params.mode !== 'form') return null
  const requestedSchema = asRecord(params.requestedSchema)
  const properties = asRecord(requestedSchema.properties)
  const required = Array.isArray(requestedSchema.required)
    ? requestedSchema.required.filter((v): v is string => typeof v === 'string')
    : Object.keys(properties)
  const out: Record<string, unknown> = {}
  for (const key of required) {
    if (!(key in properties)) continue
    out[key] = buildMcpElicitationFieldValue(properties[key])
  }
  return out
}

/**
 * LOW-1(2026-07-03)— Bash 卡 description:取命令首个非空行做摘要,≤60 字符
 * (超长截 59 + '…')。空命令返回 ''(caller 不带 description 字段)。
 */
export function summarizeCommandForDescription(cmd: string): string {
  const firstLine = cmd
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (firstLine === undefined) return ''
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine
}

/**
 * V5 CG(2026-07-10)— Codex 把每条 shell 命令包成 `/bin/bash -lc <arg>` 再执行,
 * 剥掉包装让前端 Bash 卡显示用户原始命令。历史实现只有一条正则,只认「单引号
 * 整体包裹」一种形状(`-lc '...'`),生产实测漏掉两类真实包装,原样透传进前端卡
 * (露出 `/bin/bash -lc` 包装体 + 转义符,非常丑):
 *   ① 双引号包裹:`/bin/bash -lc "printf 'cwd=%s\n' \"$PWD\" && …"`(内含 \" 转义)
 *   ② 单/双引号段相邻拼接:`/bin/bash -lc 'rm -f x && echo '"'已清理'"`(结尾非单引号)
 *
 * 根因在「用正则抠一种引号形状」这个思路本身 —— shell 引号是可任意拼接/嵌套的
 * 词法,不是单一正则能覆盖的一类。因此把剥包装升级成一个最小 POSIX shell 单词
 * 解析器:识别 `/bin/(ba)?sh -lc`(或 `-c`)前缀后,对剩余部分做真正的引号解析
 * (单引号原文 / 双引号内仅 \\ \" \$ \` 转义 / 裸段反斜杠转义 / 相邻段拼接),
 * **当整体恰好构成一个 shell word 时**返回解包后的命令;解析失败(未闭合引号)
 * 或不止一个 word 时,保守只剥前缀返回剩余原文——比露出完整包装体面。
 *
 * `'\''`(单引号内嵌单引号的标准转义,如 `it's`→`'it'\''s'`)天然被覆盖:解析器
 * 吞整个 word(含外层引号),`'it'` 收 SQ 段 "it" → 裸 `\'` 转义出一个 `'` → `'s'`
 * 收 SQ 段 "s",拼成 `it's`,无需旧实现那样对 `'\''` 做二次字符串替换。
 */
export function stripShellWrapper(cmd: string): string {
  // 前缀:/bin/bash 或 /bin/sh,-lc 或 -c(允许 l 可选、多空白)。宽松匹配容忍漂移。
  const m = cmd.match(/^\/bin\/(?:ba)?sh\s+-l?c\s+([\s\S]*)$/)
  if (!m) return cmd
  const rest = m[1]
  const words = tokenizeShellWords(rest)
  // 恰好一个 word → 解包成功返回;解析失败(null)/ 多 word / 空 → 只剥前缀返回原文。
  if (words && words.length === 1) return words[0]
  return rest
}

/**
 * 最小 POSIX shell 单词分词器,服务于 {@link stripShellWrapper}。返回 word 数组;
 * 遇未闭合引号返回 null(解析失败,让调用方走保守路径)。规则:
 *   - 引号外空白(空格 / Tab / 换行)分词,连续空白折叠,不产生空 word。
 *   - 单引号内全字面(含反斜杠),直到下一个单引号。
 *   - 双引号内反斜杠仅对 `\ " $ \`` 及换行(续行)生效,其余反斜杠字面保留
 *     (故 `\n` 原样保留成 `\n`,不误解析成换行)。
 *   - 裸段反斜杠转义下一字符;反斜杠+换行=续行(整体删除);末尾孤立反斜杠字面。
 *   - 相邻的不同引号 / 裸段拼进同一个 word(shell 词法)。
 */
function tokenizeShellWords(input: string): string[] | null {
  const words: string[] = []
  let buf = ''
  let inWord = false
  let i = 0
  const n = input.length
  while (i < n) {
    const ch = input[i]
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (inWord) {
        words.push(buf)
        buf = ''
        inWord = false
      }
      i++
      continue
    }
    if (ch === "'") {
      inWord = true
      i++
      let closed = false
      while (i < n) {
        if (input[i] === "'") {
          closed = true
          i++
          break
        }
        buf += input[i]
        i++
      }
      if (!closed) return null // 未闭合单引号
      continue
    }
    if (ch === '"') {
      inWord = true
      i++
      let closed = false
      while (i < n) {
        const c = input[i]
        if (c === '"') {
          closed = true
          i++
          break
        }
        if (c === '\\' && i + 1 < n) {
          const nx = input[i + 1]
          if (nx === '\\' || nx === '"' || nx === '$' || nx === '`') {
            buf += nx
            i += 2
            continue
          }
          if (nx === '\n') {
            i += 2 // 续行:反斜杠+换行整体删除
            continue
          }
          buf += c // 其余:反斜杠字面保留(如 \n)
          i++
          continue
        }
        buf += c
        i++
      }
      if (!closed) return null // 未闭合双引号
      continue
    }
    if (ch === '\\') {
      inWord = true
      if (i + 1 < n) {
        const nx = input[i + 1]
        if (nx === '\n') {
          i += 2 // 续行
          continue
        }
        buf += nx
        i += 2
        continue
      }
      buf += ch // 末尾孤立反斜杠字面
      i++
      continue
    }
    inWord = true
    buf += ch
    i++
  }
  if (inWord) words.push(buf)
  return words
}
