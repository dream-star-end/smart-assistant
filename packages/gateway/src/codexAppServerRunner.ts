import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
// Test-only override of the spawn used to launch `codex app-server`. See
// codexRunner.ts `__setCodexSpawnForTests` for rationale; same pattern here.
let _spawnFn: typeof spawn = spawn
export function __setCodexAppServerSpawnForTests(fn: typeof spawn | null): void {
  _spawnFn = fn ?? spawn
}
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type OpenClaudeConfig, paths } from '@openclaude/storage'
import { type CodexLaunchOverrides, buildCodexLaunchOverrides } from './codexLaunchOverrides.js'
import type { RepoSnapshot } from './sessionRepoWorkspace.js'
import { _sanitizeThreadId, buildCodexEnv, copyImagePathsToPublicDir } from './codexRunner.js'
import { createLogger } from './logger.js'

const log = createLogger({ module: 'codexAppServerRunner' })

// ───────────────────────────────────────────────
// CodexAppServerRunner
//
// Drop-in replacement for the legacy CodexRunner that talks to a long-lived
// `codex app-server --listen stdio://` JSON-RPC subprocess instead of spawning
// `codex exec` per turn. Wins over CodexRunner:
//   1. Token-level streaming via `item/agentMessage/delta` notifications, so
//      the web client can render assistant text as it arrives instead of
//      waiting for `item.completed agent_message` at end of turn.
//   2. Native `imageGeneration` thread item with `savedPath` field, removing
//      the directory-baseline-diff dance the exec runner relied on (codex
//      `--json` exec stream omits image_gen events).
//
// Emits the same SubprocessRunner-shaped events sessionManager subscribes to:
//   session_id, spawn, exit, message, error, telemetry, parse_error
// Exposes the same public surface (start/submit/shutdown/interrupt/
// updateConfig/setEffortLevel/sendPermissionResponse, isRunning getter,
// lastActivityAt + effortLevel fields) so it slots in via the existing
// `as unknown as SubprocessRunner` cast in sessionManager.
//
// Protocol notes (codex app-server v2 — verified against schemas at
// /tmp/codex-protocol/v2 and live spike on 2026-04-30):
//   - Line-delimited JSON-RPC 2.0 over stdio, bidirectional (server can issue
//     requests too — we always reply -32601 method-not-found because there is
//     no UI back-channel for permission/approval prompts in OpenClaude).
//   - Handshake: `initialize { clientInfo: { name, version } }` once per proc.
//   - Thread create: `thread/start { approvalPolicy: 'never', sandbox: 'danger-full-access', cwd, model? }`.
//     Resume: `thread/resume { threadId, approvalPolicy, sandbox, cwd?, model? }`.
//   - Turn: `turn/start { threadId, input: [{type:'text', text}] }` returns
//     `{ turn: { id, status:'inProgress' } }`. Turn id captured for filtering
//     and `turn/interrupt`.
//   - Notifications during a turn:
//       item/started / item/completed { threadId, turnId, item }
//       item/agentMessage/delta       { threadId, turnId, itemId, delta }
//       turn/completed                { threadId, turn: { id, status, durationMs, error? } }
//     status enum: completed | interrupted | failed | inProgress.
// ───────────────────────────────────────────────

export interface CodexAppServerRunnerOpts {
  sessionKey: string
  agentId: string
  cwd: string
  /** Previously captured codex thread_id — continue the conversation. Caller
   *  must ensure this is a codex thread_id, not a CCB session id; sessionManager
   *  enforces this via provider-tagged resume map. */
  resumeSessionId?: string
  /** Agent model id from agents.yaml (e.g. `gpt-5-codex`). Forwarded to
   *  thread/start/resume so codex picks the right model. */
  model?: string
  // ── Platform context injection (parity with SubprocessRunner / CodexRunner) ──
  /** Path to agent's persona file (CLAUDE.md / SOUL.md). */
  persona?: string
  /** Effective provider for `buildPromptContext` provider-keyed slot logic. */
  agentProvider?: string
  /** Initial effort level for the RESEARCH slot activation. */
  effortLevel?: string
  /** Gateway config; required for platform context injection. */
  config?: OpenClaudeConfig
  /** Forwarded to mcp-memory env so delegate_task can enforce recursion caps. */
  delegationDepth?: number
  /** V3 S12e CG8 telemetry — turn-level trace id stash,parity with
   *  SubprocessRunnerOpts.traceId。Codex app-server 是长驻进程,这个值当前
   *  **不**透传给子进程(env 未注入,JSON-RPC 协议也没 trace 字段);仅用于满足
   *  `sessionManager.submit()` 调 `runner.setTraceId(traceId)` 的 contract,
   *  避免 codex 路径 `TypeError: setTraceId is not a function`。getter 让
   *  调用方/单测能回读最近一次 stash 的 trace。如果未来要把 trace 注入 codex
   *  环境,改在 `ensureSpawned()` 拼 spawn env 处加 `OPENCLAUDE_TRACE_ID`(或给
   *  `buildCodexEnv()` 扩参)即可;`ensureLaunchOverrides()` 管的是 argv /
   *  config / token files,不是子进程 env。 */
  traceId?: string
  // ── Phase 5 GitHub session repo workspace integration ──
  /** Session id (peerId)。和 SubprocessRunner.opts.sessionId 同语义,被 runner
   *  作为 key 反查 `getRepoSnapshot()`,得到当前 turn 应该绑定的 repo workspace。
   *  legacy caller(测试或没 sessionManager 的代码路径)可不传,此时整个 repo 绑
   *  定能力关闭,行为退回 v1.0.0 老样:cwd 永远 = opts.cwd,REPO slot 不注入。 */
  sessionId?: string
  /** snapshot provider。由 SessionManager 注入(`this._getRepoSnapshot`),
   *  内部读 `_repoWorkspace.getRepoSnapshot(sessionId)`。返 null = 无绑定;
   *  返 ready = 已绑定可用;返 cloning/failed/pending = 不可用,运行时回退 opts.cwd。 */
  getRepoSnapshot?: (sessionId: string) => RepoSnapshot | null
}

interface QueuedTurn {
  prompt: string
  resolve: () => void
  reject: (err: Error) => void
  /** PR2 v1.0.66 — server-owned per-turn id 从 sessionManager.submit() 透传过来。
   *  挂在 queue entry 上(不是 runner instance 字段),因为同一 runner 多 turn
   *  并存于队列,runner global 字段会被后到的 turn 覆盖,导致 emitResult 错关
   *  错的 inflight 行。runTurn(opts.requestId) 从 closure 拿,emitResult 也从同
   *  一 closure 拿,不读 instance 字段。 */
  requestId?: string
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  method: string
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

/** Runner message shape used by sessionManager.ts (subset of SdkMessage). */
interface RunnerMessage {
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
    }>
  }
  result?: string
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
  }
  /** Issue A v1.0.108 — codex `account/rateLimits/updated` 快照(0..100% pct + ISO
   *  reset)。仅 codex result 帧带,sessionManager 透传到 outbound.codex_billing
   *  的 rateLimits 字段,master.userChatBridge 落库 claude_accounts.quota_*。 */
  rateLimits?: RuntimeRateLimits
  event?: unknown
}

/** codex `ThreadTokenUsage.{last,total}` shape — schema at
 *  /tmp/codex-protocol/v2/ThreadTokenUsageUpdatedNotification.json. */
interface CodexTokenBreakdown {
  cachedInputTokens: number
  inputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

const _EMPTY_TOKEN_BREAKDOWN: Readonly<CodexTokenBreakdown> = Object.freeze({
  cachedInputTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
})

/** Defensive coerce: ThreadTokenUsageUpdatedNotification.params.tokenUsage.{last,total}.
 *  All numeric fields are required per schema, but a malformed frame should
 *  never throw — coerce non-numbers to 0 and clamp negatives. */
function _coerceTokenBreakdown(v: unknown): CodexTokenBreakdown {
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
function _subtractTokenBreakdown(
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
} {
  return {
    input_tokens: Math.max(0, turn.inputTokens - turn.cachedInputTokens),
    output_tokens: turn.outputTokens,
    cache_read_input_tokens: turn.cachedInputTokens,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: turn.reasoningOutputTokens,
  }
}

/** ThreadItem.type values that are server-internal echoes (not real tool
 *  invocations) and therefore must not surface in the UI. `userMessage` is
 *  the codex echoing back what we just sent; `hookPrompt` is a system hook
 *  (e.g. session-init scaffolding). Either one as a tool card produces the
 *  ugly "CODEX:USERMESSAGE" dump boss flagged. */
const _SUPPRESSED_ITEM_TYPES = new Set<string>(['userMessage', 'hookPrompt'])

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

export class CodexAppServerRunner extends EventEmitter {
  private threadId: string | null
  private proc: ChildProcessWithoutNullStreams | null = null
  private nextRequestId = 0
  private pending = new Map<number, PendingRequest>()
  private queue: QueuedTurn[] = []
  private processing = false
  private shuttingDown = false
  private spawnEmitted = false
  private initialized = false
  /** True iff the *current* app-server proc has done thread/start or
   *  thread/resume for this.threadId. Cleared when the proc dies. Distinct
   *  from `initialized` (which tracks the JSON-RPC handshake) — re-spawning
   *  the proc requires re-attaching even when threadId is known. */
  private attached = false
  private activeTurnId: string | null = null
  /** Promise wired into `turn/completed` notification handling. Set by runTurn
   *  before sending `turn/start`, resolved by handleNotification on
   *  `turn/completed` for the matching turnId. */
  private currentTurnCompleter: {
    resolve: (turn: { status?: string; durationMs?: number; error?: { message?: string } }) => void
    reject: (err: Error) => void
  } | null = null
  private stdoutBuf = ''
  /** Accumulated assistant text for the current turn — used to dedupe
   *  imageGeneration savedPath emissions against text the model already
   *  surfaced via deltas. */
  private currentAssistantBuf = ''
  /** Cumulative thread `tokenUsage.total` snapshot at the moment the last
   *  turn completed — i.e. the baseline against which we compute the next
   *  turn's delta. null on first turn after construction (treated as
   *  EMPTY = all zeros). Intentionally preserved across shutdown() so that
   *  a proc respawn + thread/resume doesn't over-bill the first
   *  resumed-turn by the entire prior-thread total. Only re-instantiating
   *  the runner class (new conversation) resets to null. Caveat: if the
   *  runner instance is GC'd and a fresh CodexAppServerRunner is created
   *  for the same threadId (e.g. server restart), we lose the baseline
   *  and the first turn over-bills — accepted PR1 trade-off; see PR2 for
   *  potential persistence-layer fix. */
  private priorTurnTotal: CodexTokenBreakdown | null = null
  /** Most-recent cumulative `tokenUsage.total` observed during the active
   *  turn. Updated on every `thread/tokenUsage/updated` notification;
   *  promoted to priorTurnTotal on `turn/completed`. */
  private activeTurnTotal: CodexTokenBreakdown | null = null
  /** Per-turn delta computed from activeTurnTotal − priorTurnTotal. Read
   *  by emitResult on turn/completed; null if no token notifications were
   *  received this turn (codex bug or zero-LLM turn). */
  private currentTurnUsage: CodexTokenBreakdown | null = null
  /** Issue A v1.0.108 — 最新 codex `account/rateLimits/updated` 快照,piggy-back
   *  到下一个 emitResult。**故意不在 turn 边界 clear**:让 init 阶段 / 上一 turn
   *  完成后 / 任意时刻收到的最新值粘住。
   *  后发 race(turn/completed 之后才到 notification)落到下一 turn 的 billing 帧。 */
  private latestRateLimits: RuntimeRateLimits | null = null
  /** Issue A v1.0.108 round-2 — 上次 emitResult 真正带出去的快照 JSON 序列化。
   *  emitResult 现场对比 latestRateLimits 是否与已发出的相等,相等则**不带 rateLimits**,
   *  避免下游 quota.ts 在 30s 后把同一份旧数据再 UPDATE 一遍把 quota_updated_at 假刷新
   *  成 NOW(admin UI 误以为 Codex 刚刚观测过)。
   *  仅当 latestRateLimits 真正改变(收到新的 account/rateLimits/updated 通知)才带。 */
  private lastEmittedRateLimitsJson: string | null = null
  /** In-flight `handleItemCompleted` promises for the current turn. codex
   *  emits `item/completed` then `turn/completed` back-to-back; the
   *  per-item handler is async (file IO for imageGeneration base64 decode,
   *  copyImagePathsToPublicDir for savedPath, etc.) so without tracking,
   *  `runTurn` would snapshot `currentAssistantBuf` and emit `result`
   *  before the handler appends the text_delta / fires emitToolResult.
   *  Drained in `runTurn` (both happy and catch paths) before emitResult. */
  private inflightItemHandlers: Set<Promise<void>> = new Set()

  /** mkdtempSync'd dir holding the per-spawn `extra-prompt.md`. Created lazily
   *  in `ensureSpawned()` whenever a fresh app-server process needs platform
   *  context, cleaned on `shutdown()` and on proc close. */
  private sessionDir: string | null = null
  /** Cached overrides for the lifetime of the current proc. Cleared together
   *  with `sessionDir` so the next post-shutdown spawn lazy-rebuilds. */
  private cachedOverrides: CodexLaunchOverrides | null = null

  // ── Phase 5 GitHub session repo binding(parity with SubprocessRunner)──
  /** ready 状态下记录当前生效的 repo binding — selectionVersion 给
   *  sessionManager.recyclePeerForRepoChange 用作版本对比依据;workspaceDir 仅
   *  做诊断/日志(真用作 cwd 的是 runTurn 顶部一次取的 effectiveCwd)。
   *  非 ready / 无 binding / 无 sessionId 注入 = null。 */
  private _boundRepoBinding: { selectionVersion: number; workspaceDir: string } | null = null

  // ── SubprocessRunner interface parity (referenced by sessionManager.ts) ──
  public lastActivityAt: number = Date.now()
  public effortLevel: string | undefined = undefined

  get isRunning(): boolean {
    return this.proc != null || this.processing
  }

  updateConfig(config: OpenClaudeConfig): void {
    // codex itself doesn't read gateway config, but the platform-context
    // injection path does. Accept the new config and invalidate the cached
    // overrides so the NEXT spawn (after a shutdown/respawn cycle) rebuilds
    // with the new values. A currently-running mcp-memory child has the old
    // token baked in; full propagation requires the codex proc to respawn.
    this.opts = { ...this.opts, config }
    this.cachedOverrides = null
  }

  setEffortLevel(level: string | undefined): void {
    // codex CLI manages its own effort flag; we don't pass it to thread/start.
    // We DO record it on the runner so a subsequent ensureLaunchOverrides()
    // (after shutdown clears the cache) reflects the new value when
    // buildPromptContext renders the RESEARCH slot.
    this.effortLevel = level
  }

  // ── model getter / setter (parity with CodexRunner / SubprocessRunner) ──
  // sessionManager.submit 在 InboundMessage 带 model 且与 runner.model 不同时调
  // runner.setModel,缺方法 → TypeError → turn 永不 complete → 用户卡 "思考中"。
  // runTurn 在 ensureSpawned 后 attach 阶段读 `this.opts.model`,塞进 thread/start
  // 或 thread/resume 的 model 字段,所以 setModel 只改 opts 即可,下次 attach 生效。
  // 不在这里 spawn / shutdown — caller (sessionManager) 通过 shutdown() 触发
  // 重启,这是 SubprocessRunner.setModel 既定契约。
  get model(): string | undefined {
    return this.opts.model
  }
  setModel(model: string | undefined): void {
    this.opts.model = model
  }

  // ── traceId getter / setter (parity with SubprocessRunner; V3 S12e CG8) ──
  // sessionManager.submit() L1131 在 traceId 非空时硬调 `runner.setTraceId(traceId)`。
  // 缺方法 → TypeError → turn 永不 complete → 用户卡 "思考中"(2026-05-11 v1.0.123 复现)。
  // 这是 setModel 同型 bug 第二次踩坑;若再加第三个 sessionManager-side 必调 mutator,
  // runnerContractParity.test.ts 会先把谁漏 parity 暴露出来。
  // codex app-server 是长驻进程,trace id 当前不透传给子进程,只做 opts stash —
  // SubprocessRunner 那条 OPENCLAUDE_TRACE_ID env 注入路径并不适用。
  get traceId(): string | undefined {
    return this.opts.traceId
  }
  setTraceId(traceId: string | undefined): void {
    this.opts.traceId = traceId
  }

  // ── Phase 5 GitHub session repo binding (parity with SubprocessRunner) ──

  /** Public getter consumed by sessionManager.recyclePeerForRepoChange:
   *  比对 selectionVersion 决定是否需要 shutdown+reset。null = 当前没有 ready
   *  绑定(从未绑定 / 绑定 cloning|failed / sessionId 未注入)。 */
  getBoundRepoBinding(): { selectionVersion: number; workspaceDir: string } | null {
    return this._boundRepoBinding
  }

  /** Forget per-thread / per-spawn cached state so the next turn rebuilds from
   *  scratch。Used by sessionManager.recyclePeerForRepoChange when repo binding
   *  version changes:
   *    - threadId:next spawn must walk fresh `thread/start` rather than
   *      `thread/resume` against a thread whose context belongs to the
   *      *previous* repo.
   *    - 三个 token usage baselines:不清,新 thread 的第一个
   *      `thread/tokenUsage/updated` 会减去旧 thread 的 totals → underbilling
   *      或 clamp-to-zero。
   *    - sessionDir + cachedOverrides:不清,recycle 在 isRunning=true 路径上
   *      shutdown() 会顺手清,但 isRunning=false 路径(proc 已死 / 未起)上
   *      sessionManager 跳过 shutdown,旧 instructions 文件仍被缓存为下一轮
   *      spawn 的 REPO slot 来源,导致物理 cwd 与系统提示分裂(本次修复要
   *      根治的就是这个)。这里直接复用现成的 cleanupLaunchOverrides() helper。
   *
   *  接口名 / 语义与 SubprocessRunner.clearSessionId 对齐(symmetric polymorphism)。 */
  clearSessionId(): void {
    this.threadId = null
    this.priorTurnTotal = null
    this.activeTurnTotal = null
    this.currentTurnUsage = null
    this.cleanupLaunchOverrides()
  }

  /** 读当前 session 的 repo snapshot。turn 顶部一次取,贯穿 ensureSpawned /
   *  thread/start / thread/resume / launch overrides 四个消费点,避免它们各自取
   *  的瞬间不一致(撕裂窗口)。 */
  private _currentRepoSnapshot(): RepoSnapshot | null {
    if (!this.opts.sessionId || !this.opts.getRepoSnapshot) return null
    try {
      return this.opts.getRepoSnapshot(this.opts.sessionId)
    } catch (err) {
      log.warn(
        'getRepoSnapshot threw; treating as no-bind',
        { sessionKey: this.opts.sessionKey, err: (err as Error).message },
      )
      return null
    }
  }

  /** 把 snapshot 折算成本 turn 的有效 cwd,顺手更新 _boundRepoBinding。
   *  ready+workspaceDir → 用 workspaceDir + 记录 binding;其它 → 回退 opts.cwd
   *  + binding=null。返回值是 spawn / thread/start / thread/resume 都用的 cwd。 */
  private _applyRepoBindingFromSnapshot(snap: RepoSnapshot | null): string {
    if (snap?.status === 'ready' && snap.workspaceDir) {
      this._boundRepoBinding = {
        selectionVersion: snap.selectionVersion,
        workspaceDir: snap.workspaceDir,
      }
      return snap.workspaceDir
    }
    this._boundRepoBinding = null
    return this.opts.cwd
  }

  sendPermissionResponse(_requestId: string, _response: unknown): boolean {
    // Same rationale as CodexRunner: app-server is launched with
    // approvalPolicy=never + sandbox=danger-full-access, so it never asks for
    // approval. If future codex versions emit a request anyway, the
    // server-request branch in handleLine answers method-not-found.
    return false
  }

  interrupt(): boolean {
    if (!this.proc || this.proc.killed) return false
    if (!this.threadId || !this.activeTurnId) return false
    void this.sendRequest('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.activeTurnId,
    }).catch((err) => {
      // Common case: the turn already completed between us deciding to
      // interrupt and the request landing. Codex returns -32602/etc — we
      // log at warn and move on; runTurn will settle via turn/completed
      // (status=completed) anyway.
      log.warn('turn/interrupt failed', {
        sessionKey: this.opts.sessionKey,
        err: (err as Error).message,
      })
    })
    return true
  }

  constructor(private opts: CodexAppServerRunnerOpts) {
    super()
    this.threadId = opts.resumeSessionId ?? null
    this.effortLevel = opts.effortLevel
    // attached is intentionally false on construction even if we have a
    // resumed threadId — the first turn must explicitly thread/resume into
    // the freshly spawned proc.
  }

  /** Lazy-build codex launch overrides for the next `app-server` spawn. The
   *  overrides outlive a single turn (the proc is long-lived), so the cache
   *  is only invalidated in `shutdown()` / proc close / `updateConfig()`.
   *  Returns null when `opts.config` is missing (legacy "naked codex" path).
   *
   *  `repoSnap` 由 caller(`ensureSpawned`)从 turn 顶部的单一 snapshot 透传过来,
   *  保证 launch overrides 的 REPO slot 与 spawn cwd / thread/start.cwd 用同一份。 */
  private async ensureLaunchOverrides(
    repoSnap: RepoSnapshot | null,
  ): Promise<CodexLaunchOverrides | null> {
    if (!this.opts.config) return null
    if (this.cachedOverrides && this.sessionDir) return this.cachedOverrides
    // Cache miss with an existing sessionDir means updateConfig invalidated
    // cachedOverrides while the dir was still bound. ensureLaunchOverrides is
    // only called from ensureSpawned (proc===null guard), so by the time we
    // reach this point the previous proc has exited.
    if (this.sessionDir) {
      try {
        rmSync(this.sessionDir, { recursive: true, force: true })
      } catch (err) {
        log.warn('codex app-server stale sessionDir cleanup failed', {
          sessionDir: this.sessionDir,
          err: (err as Error).message,
        })
      }
      this.sessionDir = null
    }
    const dir = mkdtempSync(join(tmpdir(), 'oc-codex-app-'))
    try {
      const overrides = await buildCodexLaunchOverrides({
        agentId: this.opts.agentId,
        persona: this.opts.persona,
        provider: this.opts.agentProvider,
        model: this.opts.model,
        effortLevel: this.effortLevel,
        sessionDir: dir,
        claudeCodePath: this.opts.config.auth.claudeCodePath,
        gatewayPort: this.opts.config.gateway.port,
        gatewayToken: this.opts.config.gateway.accessToken,
        delegationDepth: this.opts.delegationDepth,
        // Phase 5:把 turn 顶部的 snapshot 一路透传到 buildPromptContext 的 REPO slot,
        // 让 codex 系统提示中带上仓库元信息(parity with SubprocessRunner)。
        repoSnapshot: repoSnap,
      })
      writeFileSync(overrides.instructionsFile, overrides.instructionsContent, 'utf8')
      // v3 hardening — see codexRunner.ts for rationale (token never in argv).
      if (overrides.tokenFile && overrides.tokenContent !== null) {
        writeFileSync(overrides.tokenFile, overrides.tokenContent, { mode: 0o600 })
      }
      this.sessionDir = dir
      this.cachedOverrides = overrides
      return overrides
    } catch (err) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* swallow */
      }
      throw err
    }
  }

  /** Cleanup helper shared by `shutdown()` and the proc close handler so
   *  override teardown happens regardless of which path tears the proc down
   *  first. Idempotent. */
  private cleanupLaunchOverrides(): void {
    if (this.sessionDir) {
      try {
        rmSync(this.sessionDir, { recursive: true, force: true })
      } catch (err) {
        log.warn('codex app-server session dir cleanup failed', {
          sessionDir: this.sessionDir,
          err: (err as Error).message,
        })
      }
      this.sessionDir = null
    }
    this.cachedOverrides = null
  }

  async start(): Promise<void> {
    // Subprocess is lazily spawned on first turn (matches CodexRunner
    // semantics — sessionManager polls isRunning and wires up runner.on()
    // listeners between start and submit, so emitting spawn synchronously is
    // expected). The actual `codex app-server` proc starts on first runTurn.
    this.emit('spawn', { resumed: this.threadId != null })
  }

  async submit(
    textOrBlocks: string | Array<{ type: string; text?: string }>,
    /** PR2 v1.0.66 — 见 QueuedTurn.requestId 注释。 */
    requestId?: string,
  ): Promise<void> {
    this.lastActivityAt = Date.now()
    if (!this.spawnEmitted) {
      this.spawnEmitted = true
      this.emit('spawn', { resumed: this.threadId != null })
    }
    const prompt = normalisePrompt(textOrBlocks)
    return new Promise((resolve, reject) => {
      this.queue.push({ prompt, resolve, reject, requestId })
      void this.drain()
    })
  }

  async shutdown(): Promise<void> {
    // Same transient-shutdown semantics as CodexRunner: kill the current
    // proc, drain queue, but allow subsequent submit() to respawn. effort
    // switching and auth-token refresh paths rely on this.
    this.shuttingDown = true
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      const p = this.proc
      setTimeout(() => {
        if (p && !p.killed) {
          try {
            p.kill('SIGKILL')
          } catch {
            /* ignore */
          }
        }
      }, 3000)
    }
    const pending = this.queue
    this.queue = []
    for (const q of pending) q.reject(new Error('CodexAppServerRunner shutdown'))
    // Reject any in-flight JSON-RPC requests so callers don't hang forever.
    for (const [, p] of this.pending) {
      p.reject(new Error('CodexAppServerRunner shutdown'))
    }
    this.pending.clear()
    // Reject the in-flight turn (if any) so runTurn's await-completer doesn't
    // wedge — the proc.close handler also does this, but shutdown can be
    // called before the close event fires (race).
    if (this.currentTurnCompleter) {
      this.currentTurnCompleter.reject(new Error('CodexAppServerRunner shutdown'))
      this.currentTurnCompleter = null
    }
    this.activeTurnId = null
    this.initialized = false
    this.attached = false
    this.proc = null
    this.stdoutBuf = ''
    // Clear in-flight token state. priorTurnTotal is INTENTIONALLY preserved
    // across shutdown — codex's thread token totals are server-side and
    // monotonic, so when the same instance respawns and resumes the thread,
    // the next `thread/tokenUsage/updated.total` value will still include
    // every prior turn's tokens. Resetting our baseline would over-bill the
    // first turn after a respawn by the entire thread total.
    //
    // Mid-turn shutdown: if activeTurnTotal has a value (we received at least
    // one tokenUsage notification this turn before being killed), promote it
    // to priorTurnTotal so the NEXT turn's delta baseline accounts for the
    // tokens consumed by the killed turn. Without this, those tokens would
    // be attributed to the next turn (skewing its bill upward) or lost if
    // there is no next turn. The killed turn itself is NOT billed — its
    // emitResult goes through the catch path with no usagePayload.
    if (this.activeTurnTotal !== null) {
      this.priorTurnTotal = this.activeTurnTotal
    }
    this.activeTurnTotal = null
    this.currentTurnUsage = null
    // Tear down the per-spawn launch overrides so the next post-shutdown
    // submit() rebuilds against a fresh sessionDir. Re-using a stale
    // overrides reference after we rmSync the dir would point codex at a
    // deleted file on respawn.
    this.cleanupLaunchOverrides()
    this.emit('exit', { code: 0, signal: null, crashed: false })
    this.shuttingDown = false
  }

  // ─── internals ────────────────────────────────

  private async drain(): Promise<void> {
    if (this.processing || this.shuttingDown) return
    const turn = this.queue.shift()
    if (!turn) return
    this.processing = true
    try {
      await this.runTurn(turn.prompt, turn.requestId)
      turn.resolve()
    } catch (err) {
      turn.reject(err as Error)
    } finally {
      this.processing = false
      void this.drain()
    }
  }

  private async ensureSpawned(
    repoSnap: RepoSnapshot | null,
    effectiveCwd: string,
  ): Promise<void> {
    if (this.proc && !this.proc.killed && this.initialized) return
    if (this.proc && !this.proc.killed && !this.initialized) {
      // Spawn happened but initialize is in flight — caller will await.
      return
    }
    // Clear any partial-line residue from a prior proc (Codex review
    // #019dde20 BLOCKER round 3): stdoutBuf is runner-scoped, so without
    // this, a fragment like '{"jsonrpc":"2.0",' left by the old proc would
    // get prepended to the new proc's first stdout chunk and corrupt the
    // initialize response.
    this.stdoutBuf = ''
    // Build platform context overrides BEFORE spawn so the long-lived
    // app-server proc has model_instructions_file + mcp-memory available
    // from its very first turn. Failure here is non-fatal — fall back to
    // naked launch (same graceful-degradation stance as subprocessRunner's
    // "skip built-in MCP" branch).
    //
    // Phase 5:repoSnap 来自 runTurn 顶部一次取的 snapshot,贯穿到
    // buildCodexLaunchOverrides 内 buildPromptContext 的 REPO slot。
    let argvOverrides: string[] = []
    try {
      const overrides = await this.ensureLaunchOverrides(repoSnap)
      if (overrides) argvOverrides = overrides.argvOverrides
    } catch (err) {
      log.warn(
        'codex app-server launch overrides build failed; spawning without platform context',
        {
          sessionKey: this.opts.sessionKey,
          err: (err as Error).message,
        },
      )
    }
    // `codex app-server` accepts `-c key=value` overrides. They must precede
    // `--listen` so clap's positional/option parser sees the stdio:// last.
    const args = ['app-server', ...argvOverrides, '--listen', 'stdio://']
    // Phase 5:spawn cwd 用 effectiveCwd(ready 时 = repo workspaceDir,其它 = opts.cwd)。
    // 虽然 codex app-server 本质是个 JSON-RPC 服务,proc 自身 cwd 大多数子命令不直接用,
    // 但保持与 thread/start.cwd 一致避免任何"哪边是真值"的混淆。
    const proc = _spawnFn('codex', args, {
      cwd: effectiveCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildCodexEnv(),
    }) as ChildProcessWithoutNullStreams
    this.proc = proc
    proc.stdout.on('data', (chunk: Buffer) => {
      // Identity guard (Codex review #019dde20 BLOCKER round 2): a stale
      // stdout frame from a discarded proc must NOT be parsed against the new
      // runner state. Without this, an old proc's queued `item/agentMessage/
      // delta` could land while a fresh `turn/start` is in flight and the
      // early-adopt path would attribute the old turn's text to the new turn.
      if (this.proc !== proc) return
      this.lastActivityAt = Date.now()
      this.stdoutBuf += chunk.toString('utf8')
      let nl = this.stdoutBuf.indexOf('\n')
      while (nl >= 0) {
        const line = this.stdoutBuf.slice(0, nl).trim()
        this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
        if (line) this.handleLine(line)
        nl = this.stdoutBuf.indexOf('\n')
      }
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      // Same identity guard rationale as stdout — stderr is just structured
      // log, but mis-attributing an old proc's stderr to the current session
      // is misleading in the journal.
      if (this.proc !== proc) return
      this.lastActivityAt = Date.now()
      // Codex app-server logs structured errors to stderr; surface them at
      // warn level so the journal has them but they don't fail the turn —
      // the JSON-RPC error response is the source of truth for failures.
      log.warn('codex app-server stderr', {
        sessionKey: this.opts.sessionKey,
        line: chunk.toString('utf8').trim().slice(0, 1024),
      })
    })
    proc.on('error', (err) => {
      // Identity check: a delayed error from a discarded proc must not corrupt
      // a freshly spawned one. shutdown() (or a previous close) may have already
      // re-pointed `this.proc` at a new child by the time this fires.
      if (this.proc !== proc) {
        log.info('codex app-server stale proc error ignored', {
          sessionKey: this.opts.sessionKey,
          err: err.message,
        })
        return
      }
      log.error('codex app-server proc error', { err: err.message })
      this.emit('error', err)
      this.failAllPending(`codex app-server process error: ${err.message}`)
      this.proc = null
      this.initialized = false
      this.attached = false
      // stdoutBuf cleared so any partial-line residue doesn't poison the
      // next proc's first response (see ensureSpawned for fuller comment).
      this.stdoutBuf = ''
    })
    proc.on('close', (code, signal) => {
      // Identity check: see the `error` handler comment. Without this, the
      // sequence shutdown → submit → respawn → old-proc-close-fires would
      // null out the new proc and reject its pending requests.
      if (this.proc !== proc) {
        log.info('codex app-server stale proc close ignored', {
          sessionKey: this.opts.sessionKey,
          code,
          signal,
        })
        return
      }
      log.info('codex app-server proc close', {
        sessionKey: this.opts.sessionKey,
        code,
        signal,
      })
      const wasShutdown = this.shuttingDown
      // Reject any remaining pending JSON-RPC requests AND the in-flight turn
      // promise so callers don't hang. emitResult is the responsibility of
      // runTurn's catch — we just unwedge promises here.
      if (!wasShutdown) {
        this.failAllPending(`codex app-server exited code=${code} signal=${signal ?? ''}`)
      }
      this.proc = null
      this.initialized = false
      this.attached = false
      this.activeTurnId = null
      // Clear stdoutBuf so the next proc's first response isn't prepended
      // with a partial line residue from this dying proc.
      this.stdoutBuf = ''
      // Drop the launch overrides cache too — the dir contents are tied to
      // the dead proc, and the next ensureSpawned() will lazy-rebuild a
      // fresh dir. Not strictly required (shutdown already covers the
      // explicit-stop path) but matches the symmetry "proc gone → context
      // regenerated" so a crash-respawn can't reuse a stale path.
      this.cleanupLaunchOverrides()
      this.emit('exit', {
        code: code ?? 0,
        signal,
        crashed: code != null && code !== 0 && !wasShutdown,
      })
    })

    // JSON-RPC handshake. Codex schema lists `clientInfo: { name, version }`
    // (verified by spike). We call the proc fresh-spawned so writes won't
    // EPIPE.
    await this.sendRequest('initialize', {
      clientInfo: { name: 'openclaude-gateway', version: '1.0' },
    })
    this.initialized = true
  }

  private failAllPending(reason: string): void {
    for (const [, p] of this.pending) {
      p.reject(new Error(reason))
    }
    this.pending.clear()
    if (this.currentTurnCompleter) {
      this.currentTurnCompleter.reject(new Error(reason))
      this.currentTurnCompleter = null
    }
  }

  /**
   * Forward codex's `account/chatgptAuthTokens/refresh` reverse-RPC to the
   * v3 master HTTP endpoint.
   *
   * V3 commercial topology: each container's gateway has no DB / KMS /
   * refresh_token. Refresh state lives on master. Container env carries:
   *   - OPENCLAUDE_V3_MASTER_BASE_URL = e.g. http://172.30.0.1:18791 (self-host)
   *     or https://commercial-v3.host:18443 (remote-host with mTLS — but in
   *     v3 the container always reaches its own host, so plain http loopback)
   *   - OPENCLAUDE_V3_CONTAINER_TOKEN = `oc-v3.<containerId>.<secret>` bearer
   *
   * Both env are required. Missing either → reply -32601 (matches the legacy
   * "not implemented" semantics so codex's failure path is unchanged on
   * non-v3 setups). Real failures (HTTP non-2xx, network) → -32603 internal
   * error so codex / container log clearly distinguish "not wired" from
   * "wired but broken".
   *
   * Response body shape from master matches codex's
   * `ChatgptAuthTokensRefreshResponse` schema 1:1
   * (`accessToken`, `chatgptAccountId`, `chatgptPlanType?`).
   */
  private async _handleChatgptAuthTokensRefresh(
    id: string | number,
    params: unknown,
  ): Promise<void> {
    const baseUrl = process.env.OPENCLAUDE_V3_MASTER_BASE_URL
    const token = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
    if (!baseUrl || !token) {
      // Not running under v3 commercial — preserve legacy "not implemented"
      // semantics so personal-version codex paths fail the same way.
      this.writeRaw(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message:
              "method 'account/chatgptAuthTokens/refresh' not implemented by openclaude-gateway",
          },
        }),
      )
      return
    }
    const url = `${baseUrl.replace(/\/+$/, '')}/internal/v3/codex/token-refresh`
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(params ?? {}),
      })
      const text = await resp.text()
      if (resp.status >= 200 && resp.status < 300) {
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch (err) {
          log.warn('codex token refresh: master 2xx but body not JSON', {
            sessionKey: this.opts.sessionKey,
            status: resp.status,
            err: (err as Error).message,
          })
          this.writeRaw(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              error: {
                code: -32603,
                message: 'codex token refresh: master returned non-JSON body',
              },
            }),
          )
          return
        }
        // Pass through — master already shaped to ChatgptAuthTokensRefreshResponse.
        this.writeRaw(JSON.stringify({ jsonrpc: '2.0', id, result: parsed }))
        return
      }
      // Non-2xx — surface master's error code/message for log diagnosis but
      // collapse to JSON-RPC -32603. Codex will treat this as a hard refresh
      // failure (turn fails); the container's next attempt will hit master
      // anew (no caching here).
      log.warn('codex token refresh: master returned non-2xx', {
        sessionKey: this.opts.sessionKey,
        status: resp.status,
        body: text.slice(0, 512),
      })
      this.writeRaw(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: `codex token refresh failed: master returned ${resp.status}`,
          },
        }),
      )
    } catch (err) {
      log.warn('codex token refresh: master fetch threw', {
        sessionKey: this.opts.sessionKey,
        err: (err as Error).message,
      })
      this.writeRaw(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: `codex token refresh failed: ${(err as Error).message}`,
          },
        }),
      )
    }
  }

  private writeRaw(line: string): void {
    if (!this.proc || this.proc.killed) return
    try {
      this.proc.stdin.write(`${line}\n`)
    } catch (err) {
      // EPIPE if proc died between our check and write — fail pending so
      // callers settle.
      log.warn('codex app-server stdin write failed', {
        err: (err as Error).message,
      })
    }
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextRequestId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.writeRaw(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  private handleLine(line: string): void {
    const msg = _classifyJsonRpcLine(line)
    if (msg.kind === 'unknown') {
      this.emit('parse_error', { line, error: 'unknown JSON-RPC shape' })
      return
    }
    if (msg.kind === 'response') {
      const numId = typeof msg.id === 'number' ? msg.id : Number(msg.id)
      const p = this.pending.get(numId)
      if (!p) {
        log.warn('orphan JSON-RPC response', {
          sessionKey: this.opts.sessionKey,
          id: msg.id,
        })
        return
      }
      this.pending.delete(numId)
      if (msg.error) {
        // Structured reject: keep the human message for log/UI use, but also
        // attach `rpcCode` / `rpcMessage` / `rpcMethod` so callers can branch
        // on protocol-level fields without re-parsing the message string. The
        // self-heal in runTurn (attach → thread/resume → -32600 "no rollout
        // found") relies on these fields to avoid swallowing unrelated
        // -32600 Invalid Request errors (e.g. schema/protocol drift) as a
        // missing-rollout case (Codex review #019e0b72 BLOCKER 1).
        const err = new Error(
          `${p.method} -> ${msg.error.code}: ${msg.error.message}`,
        ) as JsonRpcCallError
        err.rpcCode = msg.error.code
        err.rpcMessage = msg.error.message
        err.rpcMethod = p.method
        p.reject(err)
      } else {
        p.resolve(msg.result)
      }
      return
    }
    if (msg.kind === 'server-request') {
      // Two reverse-RPC methods we recognize:
      //   - `account/chatgptAuthTokens/refresh` (codex 401-recovery): forward
      //     to v3 master HTTP endpoint, reply with the new token. Without
      //     this every codex 401 fails the turn.
      //   - All others (permission prompts, MCP elicitations, etc.) — reply
      //     -32601 method-not-found because we run approvalPolicy=never and
      //     have no UI back-channel.
      if (msg.method === 'account/chatgptAuthTokens/refresh') {
        // Async fire-and-forget; we reply to codex in the callback. Errors
        // here become a JSON-RPC error frame back to codex.
        void this._handleChatgptAuthTokensRefresh(msg.id, msg.params)
        return
      }
      this.writeRaw(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: -32601,
            message: `method '${msg.method}' not implemented by openclaude-gateway`,
          },
        }),
      )
      return
    }
    if (msg.kind === 'notification') {
      this.handleNotification(msg.method, msg.params)
      return
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (!params || typeof params !== 'object') return
    const p = params as Record<string, unknown>
    const turnId = typeof p.turnId === 'string' ? p.turnId : undefined

    // Filter turn-scoped notifications. codex may emit notifications for
    // system-internal turns (compaction, hooks) that the client should ignore.
    //
    // Subtle ordering issue (Codex review #019dde20 MAJOR 3): turn/start is a
    // request whose Promise resolution is a microtask, but stdout `data`
    // events deliver subsequent notifications synchronously inside the same
    // chunk. So a notification carrying the turnId can arrive (and run
    // through handleNotification) BEFORE runTurn assigns activeTurnId from
    // the resolved request. To avoid dropping early tokens/items, when a turn
    // is in flight (`currentTurnCompleter` set) and `activeTurnId` is still
    // null, we adopt the first turnId we see.
    if (turnId) {
      if (this.activeTurnId === null) {
        if (this.currentTurnCompleter) {
          this.activeTurnId = turnId
        } else {
          // No turn in flight → server-internal turn we don't track. Drop.
          return
        }
      } else if (turnId !== this.activeTurnId) {
        return
      }
    }

    if (method === 'item/agentMessage/delta') {
      const delta = typeof p.delta === 'string' ? p.delta : ''
      if (!delta) return
      this.currentAssistantBuf += delta
      this.emit('message', {
        type: 'stream_event',
        session_id: this.threadId,
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: delta },
        },
      } as unknown as RunnerMessage)
      return
    }
    if (method === 'item/started') {
      this.handleItemStarted(p.item)
      return
    }
    if (method === 'item/completed') {
      // Track the async handler so `runTurn` can drain pending file IO /
      // emits before snapshotting `currentAssistantBuf` and emitting result.
      // codex sends item/completed before turn/completed; without this,
      // imageGeneration's base64 writeFile (or any other async item path)
      // can race past the result frame, leaving the UI with empty output.
      const itemUnk = p.item
      const itemId =
        itemUnk && typeof itemUnk === 'object'
          ? typeof (itemUnk as Record<string, unknown>).id === 'string'
            ? ((itemUnk as Record<string, unknown>).id as string)
            : '<no-id>'
          : '<no-id>'
      const itemType =
        itemUnk && typeof itemUnk === 'object'
          ? typeof (itemUnk as Record<string, unknown>).type === 'string'
            ? ((itemUnk as Record<string, unknown>).type as string)
            : '<no-type>'
          : '<no-type>'
      const handler = this.handleItemCompleted(itemUnk)
        .catch((err) => {
          // Belt + suspenders: handleItemCompleted's per-branch logic already
          // logs+falls back on business errors (image copy/write failures emit
          // a "[image copy failed: ...]" note). Anything escaping here is an
          // unexpected throw — log enough to triage but don't poison runner
          // state (don't reject the turn, don't disturb the next item).
          log.warn('codex handleItemCompleted threw', {
            sessionKey: this.opts.sessionKey,
            itemType,
            itemId,
            err: (err as Error).message,
          })
        })
        .finally(() => {
          this.inflightItemHandlers.delete(handler)
        })
      this.inflightItemHandlers.add(handler)
      return
    }
    if (method === 'turn/completed') {
      // Per schema: { threadId, turn: { id, status, durationMs, error? } }
      const turn = p.turn as Record<string, unknown> | undefined
      if (!turn) return
      // Defensive: even though we already filtered turnId above (via top-level
      // p.turnId), turn.id is the authoritative id on this notification —
      // re-check.
      const tid = typeof turn.id === 'string' ? turn.id : undefined
      if (tid && this.activeTurnId && tid !== this.activeTurnId) return
      if (this.currentTurnCompleter) {
        this.currentTurnCompleter.resolve(
          turn as Parameters<typeof this.currentTurnCompleter.resolve>[0],
        )
        this.currentTurnCompleter = null
      }
      return
    }
    if (method === 'thread/tokenUsage/updated') {
      // Schema: ThreadTokenUsageUpdatedNotification — { threadId, turnId,
      // tokenUsage: { last, total, modelContextWindow? } }. Both `last` and
      // `total` are TokenUsageBreakdown (cachedInputTokens, inputTokens,
      // outputTokens, reasoningOutputTokens, totalTokens).
      //
      // Strategy (per Codex review v2): use `total` for idempotent snapshots
      // — it's monotonically growing across the thread, so overwriting our
      // activeTurnTotal on every notification is safe even if codex emits
      // duplicate frames. Per-turn delta = activeTurnTotal − priorTurnTotal
      // is computed at turn/completed time, decoupling notification-frame
      // count from the billed amount.
      const tu = p.tokenUsage as Record<string, unknown> | undefined
      if (!tu) return
      const total = _coerceTokenBreakdown(tu.total)
      // Bootstrap baseline on the FIRST notification of a fresh runner
      // instance attached to a thread with prior history (e.g. server hot-
      // reload mid-conversation, sessionManager constructs a new
      // CodexAppServerRunner with resumeSessionId). Without this, priorTurnTotal
      // would be null and the next turn's delta = full thread total → massive
      // over-bill. `tokenUsage.last` is "tokens used by the most recent LLM
      // call", so `total - last` ≈ "everything before this most recent call"
      // ≈ correct baseline IF this is the first call of the turn. Multi-call
      // turns whose runner happens to be constructed mid-turn (essentially
      // impossible given current sessionManager wiring) would undercount;
      // accepted defensive trade-off.
      if (this.priorTurnTotal === null && this.activeTurnTotal === null) {
        const last = _coerceTokenBreakdown(tu.last)
        this.priorTurnTotal = _subtractTokenBreakdown(total, last)
      }
      this.activeTurnTotal = total
      return
    }
    if (method === 'account/rateLimits/updated') {
      // Issue A v1.0.108 — schema 强制 params.rateLimits = RateLimitSnapshot;
      // 兼容早期 codex 版本可能把 snapshot 直接放在 params 顶层(spike 实测见过),
      // hit 顶层 fallback 时 debug log 一次方便后续协议漂移诊断(Codex review MINOR 5)。
      let rl: unknown = p.rateLimits
      if ((!rl || typeof rl !== 'object') && (p.primary || p.secondary)) {
        rl = p
        log.debug('codex account/rateLimits/updated: top-level snapshot fallback', {
          sessionKey: this.opts.sessionKey,
        })
      }
      const parsed = _parseCodexRateLimits(rl)
      if (parsed) this.latestRateLimits = parsed
      return
    }
    // Other notifications (turn/started, plan/delta, config-warning, etc.)
    // are dropped — they are observability/UI hints that don't gate the
    // turn lifecycle.
  }

  private handleItemStarted(itemUnk: unknown): void {
    if (!itemUnk || typeof itemUnk !== 'object') return
    const item = itemUnk as Record<string, unknown>
    const itemId = typeof item.id === 'string' ? item.id : `codex-${Date.now()}`
    const itemType = item.type
    if (itemType === 'commandExecution') {
      const cmd = typeof item.command === 'string' ? item.command : ''
      this.emitAssistantToolUse(itemId, 'Bash', {
        command: stripShellWrapper(cmd),
        description: 'codex commandExecution',
      })
      return
    }
    if (itemType === 'fileChange') {
      const changes = Array.isArray(item.changes) ? (item.changes as unknown[]) : []
      const first = (changes[0] ?? {}) as Record<string, unknown>
      const kind = (first.kind as { type?: string } | undefined)?.type
      const name = kind === 'add' ? 'Write' : 'Edit'
      this.emitAssistantToolUse(itemId, name, {
        file_path: typeof first.path === 'string' ? first.path : '',
        kind,
        changes,
      })
      return
    }
    // agentMessage / reasoning are streamed via deltas; nothing to surface
    // here. userMessage / hookPrompt are server-internal echoes — also
    // suppressed (otherwise they emit as ugly "CODEX:USERMESSAGE" tool
    // cards). Other types (mcpToolCall, webSearch, imageGeneration, plan,
    // dynamicToolCall, collabAgentToolCall, contextCompaction, etc.)
    // surface as `codex:<type>` tool_use so the frontend's
    // _CODEX_TYPE_META table can render them with friendly icons +
    // labels.
    if (typeof itemType !== 'string') return
    if (_SUPPRESSED_ITEM_TYPES.has(itemType)) return
    if (itemType === 'agentMessage' || itemType === 'reasoning') return
    this.emitAssistantToolUse(itemId, `codex:${itemType}`, item)
  }

  private async handleItemCompleted(itemUnk: unknown): Promise<void> {
    if (!itemUnk || typeof itemUnk !== 'object') return
    const item = itemUnk as Record<string, unknown>
    const itemId = typeof item.id === 'string' ? item.id : `codex-${Date.now()}`
    const itemType = item.type
    // Mirror handleItemStarted suppression — userMessage/hookPrompt have no
    // tool_use card to attach a result to, and the generic JSON.stringify
    // fallback at the bottom of this function would dump the echo content
    // into a pseudo-tool-result.
    if (typeof itemType === 'string' && _SUPPRESSED_ITEM_TYPES.has(itemType)) return
    if (itemType === 'commandExecution') {
      const out = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''
      const exit = typeof item.exitCode === 'number' ? item.exitCode : undefined
      this.emitToolResult(itemId, out, exit != null && exit !== 0)
      return
    }
    if (itemType === 'fileChange') {
      const changes = Array.isArray(item.changes) ? (item.changes as unknown[]) : []
      const summary = changes
        .map((c) => {
          const o = c as Record<string, unknown>
          const k = (o.kind as { type?: string } | undefined)?.type
          return `${k ?? 'change'}: ${o.path ?? ''}`
        })
        .join('\n')
      this.emitToolResult(itemId, summary || 'file changes applied', false)
      return
    }
    if (itemType === 'imageGeneration') {
      // codex's image_gen tool emits two notification shapes depending on the
      // upstream auth mode (verified 2026-05-03 via JSON-RPC spike vs codex
      // 0.125.0):
      //   - auth_mode=chatgpt (full OAuth + refresh_token): item carries BOTH
      //     `savedPath` (absolute path under <CODEX_HOME>/generated_images/...)
      //     AND `result` (base64 PNG bytes).
      //   - auth_mode=chatgptAuthTokens (commercial pool, token-only): item
      //     carries `result` only — `savedPath` is absent. Codex still writes
      //     the PNG to the same on-disk location, but the path is not surfaced
      //     in the protocol frame.
      // Without the base64 fallback, commercial-pool users see imageGeneration
      // stuck at the started event's `status: in_progress`, no image rendered.
      const saved = typeof item.savedPath === 'string' ? item.savedPath : ''
      const resultB64 = typeof item.result === 'string' ? item.result : ''
      if (!this.threadId || (!saved && !resultB64)) {
        this.emitToolResult(itemId, JSON.stringify(item).slice(0, 2000), false)
        return
      }
      let publicPaths: string[] = []
      let failedNames: string[] = []
      try {
        if (saved) {
          const { copied, failedNames: f } = await copyImagePathsToPublicDir(
            this.threadId,
            [saved],
            paths.generatedDir,
          )
          publicPaths = copied.map((c) => c.publicPath)
          failedNames = f
        } else {
          // Decode base64 PNG bytes from item.result and write to public dir
          // directly. Mirrors copyImagePathsToPublicDir's naming pattern
          // (`codex-<sanitizedThreadId>-<basename>`) so the file appears in the
          // same place as the savedPath path.
          const safeThread = _sanitizeThreadId(this.threadId)
          // Sanitize itemId before using as filename — it arrives over the wire
          // and must not introduce path separators or shell metacharacters even
          // though codex's observed form is `ig_<hex>`.
          const safeItemId = itemId.replace(/[^A-Za-z0-9._-]/g, '')
          const baseName = `${safeItemId || `image-${Date.now()}`}.png`
          const dst = join(paths.generatedDir, `codex-${safeThread}-${baseName}`)
          try {
            await mkdir(paths.generatedDir, { recursive: true })
            await writeFile(dst, Buffer.from(resultB64, 'base64'))
            publicPaths = [dst]
          } catch (err) {
            log.warn('codex image base64 write failed', {
              sessionKey: this.opts.sessionKey,
              dst,
              err: (err as Error).message,
            })
            failedNames = [baseName]
          }
        }
        const newEmits = publicPaths.filter((p) => !this.currentAssistantBuf.includes(p))
        if (newEmits.length > 0) {
          // Surrounding blank lines so frontend's "absolute path on its own
          // line → render attachment" recognizer matches each path.
          const text = `\n\n${newEmits.join('\n')}\n`
          this.currentAssistantBuf += text
          this.emit('message', {
            type: 'stream_event',
            session_id: this.threadId,
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text },
            },
          } as unknown as RunnerMessage)
        }
        if (failedNames.length > 0) {
          const note = `\n\n[image copy failed: ${failedNames.join(', ')}]\n`
          this.currentAssistantBuf += note
          this.emit('message', {
            type: 'stream_event',
            session_id: this.threadId,
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: note },
            },
          } as unknown as RunnerMessage)
        }
      } catch (err) {
        log.warn('codex app-server image copy failed', {
          sessionKey: this.opts.sessionKey,
          err: (err as Error).message,
        })
      }
      // Also emit the original tool_result for the imageGeneration card so
      // the UI's tool-call panel reflects the call. Prefer the codex on-disk
      // path when available, otherwise the public path we just wrote.
      const summary = saved || publicPaths[0] || '<base64>'
      this.emitToolResult(itemId, `imageGeneration → ${summary}`, false)
      return
    }
    if (itemType === 'agentMessage' || itemType === 'reasoning') {
      // Already streamed via deltas; no separate tool_result needed.
      return
    }
    // Generic completion for unknown item types
    this.emitToolResult(itemId, JSON.stringify(item).slice(0, 2000), false)
  }

  /** Spawn a brand-new codex thread and wire its id into runner state +
   *  resume-map. Used both for the "first ever turn" path and the "old
   *  thread_id has no rollout, transparently restart" self-heal. Caller is
   *  responsible for setting `this.attached = true` after this resolves —
   *  attach state is per-proc, not per-thread.
   *
   *  v3 token usage reset (Codex review #019e0b90 BLOCKER 1): on the self-heal
   *  path the runner instance has been alive across the dead thread, so the
   *  thread-scoped token-usage baselines (`priorTurnTotal`/`activeTurnTotal`/
   *  `currentTurnUsage`) carry stale totals from the old thread. The new
   *  thread's first `thread/tokenUsage/updated` frame would otherwise be
   *  diffed against the old thread's baseline → underbilling or clamp-to-zero.
   *  Resetting all three here is a no-op on the cold-start path (they're
   *  already null on construction) and load-bearing on the self-heal path. */
  private async _startNewThread(effectiveCwd: string): Promise<void> {
    // Phase 5:effectiveCwd 由 runTurn 顶部一次取的 snapshot 折算而来,
    // 与 ensureSpawned cwd / launch overrides 的 REPO slot 保持一致。
    const res = (await this.sendRequest('thread/start', {
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      cwd: effectiveCwd,
      ...(this.opts.model ? { model: this.opts.model } : {}),
    })) as { thread?: { id?: string } } | undefined
    const tid = res?.thread?.id
    if (typeof tid !== 'string' || !tid) {
      throw new Error('thread/start did not return thread.id')
    }
    this.threadId = tid
    this.priorTurnTotal = null
    this.activeTurnTotal = null
    this.currentTurnUsage = null
    // sessionManager listens for this and writes the new id (+ provider tag)
    // to resume-map.json, so the *next* turn against this sessionKey resumes
    // against the fresh thread instead of looping back into -32600.
    this.emit('session_id', tid)
  }

  private async runTurn(prompt: string, requestId?: string): Promise<void> {
    const startedAt = Date.now()
    // Phase 5:turn 顶部一次性取 snapshot,贯穿 ensureSpawned / thread/start /
    // thread/resume / launch overrides 四个消费点。任何中途读 snapshot 的写法
    // 都会出现撕裂窗口(spawn cwd 用了 ready,attach cwd 拿到 cloning 之类)。
    const repoSnap = this._currentRepoSnapshot()
    const effectiveCwd = this._applyRepoBindingFromSnapshot(repoSnap)
    log.info('codex app-server turn start', {
      sessionKey: this.opts.sessionKey,
      resumed: this.threadId != null,
      promptChars: prompt.length,
      effectiveCwd,
      repoBound: this._boundRepoBinding != null,
    })
    this.currentAssistantBuf = ''
    // Per-turn token state: cleared at turn-start so a partial state from a
    // crashed prior turn never bleeds into this turn's billing. priorTurnTotal
    // is intentionally NOT cleared — it's the cumulative-thread baseline that
    // must persist across turns. activeTurnTotal/currentTurnUsage are
    // refreshed by `thread/tokenUsage/updated` notifications during the turn.
    this.activeTurnTotal = null
    this.currentTurnUsage = null

    try {
      await this.ensureSpawned(repoSnap, effectiveCwd)

      // Each fresh app-server proc must explicitly attach a thread before
      // turn/start. `attached` is per-proc (cleared on close/error), so this
      // fires correctly on:
      //   1. first turn after construction (no threadId → thread/start)
      //   2. first turn after construction with resumeSessionId (thread/resume)
      //   3. first turn after proc respawn (shutdown / crash) — re-attach via
      //      thread/resume against the captured threadId.
      if (!this.attached) {
        if (!this.threadId) {
          await this._startNewThread(effectiveCwd)
        } else {
          try {
            await this.sendRequest('thread/resume', {
              threadId: this.threadId,
              approvalPolicy: 'never',
              sandbox: 'danger-full-access',
              cwd: effectiveCwd,
              ...(this.opts.model ? { model: this.opts.model } : {}),
            })
          } catch (err) {
            // Self-heal "no rollout found for thread id" (-32600). Caused by
            // master sessionManager persisting `thread_id` across container
            // rebuilds while the codex `~/.codex/sessions/...` rollout JSONL
            // lives only in the per-container ephemeral layer. Without this,
            // every fresh container's first GPT turn ended in a 31ms empty
            // result frame and the user saw "未收到回复" (Codex review
            // #019e0b72 BLOCKER 1, root cause confirmed by user).
            //
            // Trade-off: we lose conversation context for that one turn since
            // the rollout really is gone. emit('session_id') feeds the new
            // tid back into sessionManager → resume-map, so subsequent turns
            // recover normally. Any other thread/resume error (proc died,
            // schema drift, etc.) re-throws so the outer catch surfaces it
            // as ok=false rather than masking it with a fresh thread.
            if (!isMissingRolloutError(err)) throw err
            log.warn('codex thread/resume missing rollout — restarting fresh', {
              sessionKey: this.opts.sessionKey,
              staleThreadId: this.threadId,
              rpcMessage: (err as JsonRpcCallError).rpcMessage,
            })
            this.threadId = null
            await this._startNewThread(effectiveCwd)
          }
        }
        this.attached = true
      }

      // Set up the completion box BEFORE turn/start so a fast turn/completed
      // notification (rare but possible) doesn't slip past us.
      const completed = new Promise<{
        status?: string
        durationMs?: number
        error?: { message?: string }
      }>((resolve, reject) => {
        this.currentTurnCompleter = { resolve, reject }
      })

      const tres = (await this.sendRequest('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text: prompt }],
      })) as { turn?: { id?: string } } | undefined
      const turnId = tres?.turn?.id
      if (typeof turnId !== 'string' || !turnId) {
        throw new Error('turn/start did not return turn.id')
      }
      this.activeTurnId = turnId

      const turn = await completed

      // Drain any in-flight item-completed handlers (e.g. imageGeneration's
      // base64 decode + writeFile, copyImagePathsToPublicDir for savedPath)
      // that are still pending. codex emits item/completed before
      // turn/completed, so by the time `await completed` resolves all of
      // this turn's item handlers are already registered in the Set —
      // a single snapshot Promise.allSettled is sufficient (no loop). Without
      // this, currentAssistantBuf may snapshot empty for emitResult, and
      // the handler's text_delta / tool_result frames arrive AFTER the
      // result frame, by which point ccbMessageParser has already finalized
      // and the frontend drops or mis-orders them.
      if (this.inflightItemHandlers.size > 0) {
        await Promise.allSettled([...this.inflightItemHandlers])
      }

      this.activeTurnId = null

      const durationMs = Date.now() - startedAt
      const status = turn?.status
      // Compute per-turn usage delta from the most recent
      // thread/tokenUsage/updated snapshot we observed during this turn.
      // If codex never emitted one (e.g. an empty/no-LLM turn or a cancelled
      // turn before the first call settled), fall through with usage=undefined.
      let turnUsage: CodexTokenBreakdown | null = null
      if (this.activeTurnTotal) {
        const baseline = this.priorTurnTotal ?? _EMPTY_TOKEN_BREAKDOWN
        turnUsage = _subtractTokenBreakdown(this.activeTurnTotal, baseline)
        this.currentTurnUsage = turnUsage
        // Promote the active total to the new baseline only on a settled turn
        // — for failed/interrupted turns the codex thread state may still
        // include partially-charged tokens, which is fine to baseline against.
        this.priorTurnTotal = this.activeTurnTotal
      }
      this.activeTurnTotal = null
      log.info('codex app-server turn end', {
        sessionKey: this.opts.sessionKey,
        status,
        durationMs,
        assistantChars: this.currentAssistantBuf.length,
        ...(turnUsage
          ? {
              inputTokens: turnUsage.inputTokens,
              outputTokens: turnUsage.outputTokens,
              cachedInputTokens: turnUsage.cachedInputTokens,
              reasoningOutputTokens: turnUsage.reasoningOutputTokens,
            }
          : {}),
      })

      const usagePayload = turnUsage ? _codexUsageToAnthropicShape(turnUsage) : undefined
      // Issue A v1.0.108 — snapshot 当前最新已知 rateLimits piggy-back 到 billing 帧。
      // **故意不 clear** this.latestRateLimits:让快照粘在 runner instance 上,后到
      // notification 也能被下一 turn 带出。
      // round-2 dedup(Codex review NEEDS-FIX 2):若与上次真正发出的快照相等(JSON 序列化对比),
      // 则不带 rateLimits — 避免下游 quota.ts 在 30s throttle 过期后把同一份旧值再写一次,
      // 把 quota_updated_at 假刷新成 NOW 误导 admin UI 以为 Codex 刚观测过。
      const rateLimitsPayload = this._consumeRateLimitsForEmit()

      if (status === 'completed') {
        this.emitResult({
          durationMs,
          ok: true,
          text: this.currentAssistantBuf,
          usage: usagePayload,
          requestId,
          rateLimits: rateLimitsPayload,
        })
      } else if (status === 'failed') {
        const errMsg = turn?.error?.message ?? 'codex turn failed'
        // Surface error in the stream so the UI shows something — without
        // this, a failed turn after deltas would leave the user wondering.
        this.emit('message', {
          type: 'stream_event',
          session_id: this.threadId,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: `\n\n[turn failed: ${errMsg}]\n` },
          },
        } as unknown as RunnerMessage)
        this.emitResult({
          durationMs,
          ok: false,
          error: errMsg,
          usage: usagePayload,
          requestId,
          rateLimits: rateLimitsPayload,
        })
      } else if (status === 'interrupted') {
        // Bill partial work on interrupted turns: codex already charged for
        // tokens before the user hit stop, so emit the delta we observed.
        this.emitResult({
          durationMs,
          ok: false,
          error: 'codex turn interrupted',
          usage: usagePayload,
          requestId,
          rateLimits: rateLimitsPayload,
        })
      } else {
        this.emitResult({
          durationMs,
          ok: false,
          error: `codex turn unexpected status=${status ?? 'unknown'}`,
          usage: usagePayload,
          requestId,
          rateLimits: rateLimitsPayload,
        })
      }
    } catch (err) {
      // Best-effort drain on the error path too. If turn/start failed
      // before any item/completed arrived this is a no-op; if codex
      // crashed mid-turn after firing item/completed, draining keeps
      // the order of emit calls (their text_delta / tool_result before
      // our error result frame) consistent with the happy path.
      // Promise.allSettled never throws, so this can't shadow the
      // original `err` we're about to surface.
      if (this.inflightItemHandlers.size > 0) {
        await Promise.allSettled([...this.inflightItemHandlers])
      }
      this.activeTurnId = null
      this.currentTurnCompleter = null
      const durationMs = Date.now() - startedAt
      log.error('codex app-server turn failed', {
        sessionKey: this.opts.sessionKey,
        err: (err as Error).message,
      })
      this.emitResult({
        durationMs,
        ok: false,
        error: `codex app-server: ${(err as Error).message}`,
        requestId,
        // Issue A v1.0.108 — catch 路径也走 dedup helper(notification 与 turn 异常
        // 不耦合,init 阶段可能已经收到过快照,但若上一 turn 已发同值就别再发)。
        rateLimits: this._consumeRateLimitsForEmit(),
      })
      // Do NOT re-throw — drain() catches and rejects the queue entry, but
      // upstream sessionManager handles errors via the result message above.
    }
  }

  private emitAssistantToolUse(id: string, name: string, input: unknown): void {
    this.emit('message', {
      type: 'assistant',
      session_id: this.threadId,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input }],
      },
    } satisfies RunnerMessage)
  }

  private emitToolResult(toolUseId: string, content: string, isError: boolean): void {
    this.emit('message', {
      type: 'user',
      session_id: this.threadId,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content,
            is_error: isError,
          },
        ],
      },
    } satisfies RunnerMessage)
  }

  /** Issue A v1.0.108 round-2 — 决定本次 emitResult 是否带 rateLimits。
   *  规则:latestRateLimits 为 null → 没快照,返 undefined。
   *  否则与 lastEmittedRateLimitsJson 比较:
   *   - 不同(包括首次)→ 带,且更新 lastEmittedRateLimitsJson 记忆
   *   - 相同 → 不带(避免下游 quota_updated_at 假刷新)
   *  JSON 序列化对比要求 _parseCodexRateLimits 输出 key 顺序稳定 — 当前实现按
   *  primary→secondary、字段按写入顺序固定,序列化稳定。 */
  private _consumeRateLimitsForEmit(): RuntimeRateLimits | undefined {
    if (this.latestRateLimits === null) return undefined
    const json = JSON.stringify(this.latestRateLimits)
    if (json === this.lastEmittedRateLimitsJson) return undefined
    this.lastEmittedRateLimitsJson = json
    return this.latestRateLimits
  }

  private emitResult(opts: {
    durationMs: number
    ok: boolean
    text?: string
    error?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      reasoning_output_tokens?: number
    }
    /** PR2 v1.0.66 — caller(runTurn)从 closure 拿;不读 instance 字段防 race。 */
    requestId?: string
    /** Issue A v1.0.108 — runTurn 在 emitResult 现场从 instance 字段拿最新已知
     *  rateLimits 快照传进来。null/undefined → 不带本字段。 */
    rateLimits?: RuntimeRateLimits
  }): void {
    const msg: RunnerMessage = {
      type: 'result',
      subtype: opts.ok ? 'success' : 'error_during_execution',
      session_id: this.threadId,
      total_cost_usd: 0,
      duration_ms: opts.durationMs,
      is_error: !opts.ok,
      result: opts.ok ? (opts.text ?? '') : (opts.error ?? 'codex error'),
      usage: opts.usage,
      requestId: opts.requestId,
      ...(opts.rateLimits ? { rateLimits: opts.rateLimits } : {}),
    }
    this.emit('message', msg)
  }
}

function normalisePrompt(input: string | Array<{ type: string; text?: string }>): string {
  if (typeof input === 'string') return input
  const parts: string[] = []
  for (const b of input) {
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

/**
 * Codex wraps every shell command in `/bin/bash -lc '...'`. Strip that wrapper
 * for a cleaner display — the ccb Bash tool card shows the raw user command.
 */
function stripShellWrapper(cmd: string): string {
  const m = cmd.match(/^\/bin\/bash\s+-lc\s+'([\s\S]*)'$/)
  if (m) return m[1].replace(/'\\''/g, "'")
  return cmd
}

// Re-export internal helpers for the test harness — the test patches
// `_classifyJsonRpcLine` to feed synthetic JSON-RPC frames.
export { _sanitizeThreadId }
