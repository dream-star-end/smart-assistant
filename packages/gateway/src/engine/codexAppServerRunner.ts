import { readLatestCodexNativeHandoff, runnerShutdownTimeoutMs, waitForCloseWithin, killCodexProcessGroup } from './codexLifecycle.js'
export { readLatestCodexNativeHandoff } from './codexLifecycle.js'
import { CodexNativeContext } from './codexNativeContext.js'
import { withFreshPromptPrivacy } from '../promptPrivacyRuntime.js'
import type { PromptPrivacyPolicy } from '@openclaude/protocol'
import { identityCompatEnvironment, type IdentityCompatRuntimeContext } from '@openclaude/storage'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
// Test-only override of the spawn used to launch `codex app-server`. See
// codexRunner.ts `__setCodexSpawnForTests` for rationale; same pattern here.
let _spawnFn: typeof spawn = spawn
export function __setCodexAppServerSpawnForTests(fn: typeof spawn | null): void {
  _spawnFn = fn ?? spawn
}
import { _codexMemoryTurnEnv } from './codexMemoryTurnEnv.js'
export { _codexMemoryTurnEnv } from './codexMemoryTurnEnv.js'
import { EventEmitter } from 'node:events'
import type { IntelligentUiApplied } from '../promptSlots.js'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUTOMATIC_TURN_RETRY_MAX,
  type CallTokenUsageSnapshot,
  type GoalStateSnapshot,
  type ToolTerminationReason,
  type TurnTokenUsageSnapshot,
  codexTransportModelId,
  isToolExitCode,
  turnErrorSemantics,
} from '@openclaude/protocol'
import { type OpenClaudeConfig, paths } from '@openclaude/storage'
import { type CodexLaunchOverrides, buildCodexLaunchOverrides } from '../codexLaunchOverrides.js'
import type { RepoSnapshot } from '../sessionRepoWorkspace.js'
import {
  _sanitizeThreadId,
  buildCodexEnv,
  buildCodexLongContextArgs,
  buildCodexModelCatalogArgs,
  buildCodexMultiAgentDisableArgs,
  buildCodexProviderConfigArgs,
  buildCodexReasoningSummaryArgs,
  buildCodexTelemetryHardeningArgs,
  type CodexProviderConfigOverride,
  codexReasoningEffortConfig,
  copyImagePathsToPublicDir,
} from './codexShared.js'
import { V3_CODEX_RELAY_PREFIX } from '../v3CodexRelay.js'
import { CodexRelayPathDeniedTracker } from './codexRelayPathGuard.js'
import { shouldOmitPlatformMcp } from '../codexLaunchOverrides.js'
import { writeCodexDelegateContext } from './codexDelegateContext.js'
import {
  buildAdvisorReadOnlyArgs, buildCodexThreadPolicyParams,
  buildCodexTurnPolicyParams, readAdvisorReadOnlyConfig,
} from './codexAdvisorReadOnly.js'
import {
  buildHermeticDenial,
  isHermeticExecutionMethod,
} from './codexHermeticPolicy.js'
import { createLogger } from '../logger.js'
import { type ClassifiedErrorCode, classifyRunError } from '../errorClassify.js'
import { withCodexTurnTrace } from '../relayTrace.js'
import type {
  AutomaticRetryState,
  CollabAgentPolicy,
  NativeModelHandoffArtifact,
} from './engineAdapter.js'
import {
  type PendingRequest,
  type CodexGoalBlock,
  normalizeCodexGoal,
  collabReceiverThreadIds,
  collabAgentsStates,
  collabTool,
  collabStatus,
  collabPrompt,
  shortThreadId,
  collabAgentInput,
  summarizeCollabControl,
  isTerminalCollabAgentStatus,
  isErrorCollabAgentStatus,
  codexToolOutcome,
  type JsonRpcCallError,
  isMissingRolloutError,
  isGoalAlreadyClearedError,
  type RunnerMessage,
  type CodexTokenBreakdown,
  _EMPTY_TOKEN_BREAKDOWN,
  _coerceTokenBreakdown,
  _subtractTokenBreakdown,
  _codexUsageToAnthropicShape,
  _codexTurnUsageSnapshot,
  _SUPPRESSED_ITEM_TYPES,
  _normaliseCodexItemType,
  _isContextCompactionItem,
  _stringifyItemBounded,
  type RuntimeRateLimits,
  _parseCodexRateLimits,
  type PendingCodexUserInput,
  _classifyJsonRpcLine,
  jsonRpcResult,
  jsonRpcMethodNotFound,
  jsonRpcInvalidParams,
  asRecord,
  codexReverseRpcKey,
  normalizeCodexUserInput,
  buildMcpElicitationContent,
  summarizeCommandForDescription,
  stripShellWrapper,
} from './codexAppServerProtocol.js'
import {
  type CodexNotificationHost,
  type TurnRetryMeta,
  buildServerRequestAutoApproval as buildServerRequestAutoApprovalImpl,
  handleRequestUserInput as handleRequestUserInputImpl,
  handleLine as handleLineImpl,
  emitPlanBlock as emitPlanBlockImpl,
  emitGoalBlock as emitGoalBlockImpl,
  handleNotification as handleNotificationImpl,
  handleContextCompactionItem as handleContextCompactionItemImpl,
  rememberCollabSpawnReceivers as rememberCollabSpawnReceiversImpl,
  handleCollabAgentToolStarted as handleCollabAgentToolStartedImpl,
  maybeEmitCompletedCollabAgentGroups as maybeEmitCompletedCollabAgentGroupsImpl,
  handleCollabAgentToolCompleted as handleCollabAgentToolCompletedImpl,
  handleItemStarted as handleItemStartedImpl,
  handleItemCompleted as handleItemCompletedImpl,
  emitAssistantToolUse as emitAssistantToolUseImpl,
  bindItemCallUsageEpochFromItem as bindItemCallUsageEpochFromItemImpl,
  bindItemCallUsageEpoch as bindItemCallUsageEpochImpl,
  callUsageRecord as callUsageRecordImpl,
  emitCallUsageEpoch as emitCallUsageEpochImpl,
  recordCallUsageTarget as recordCallUsageTargetImpl,
  recordCallUsageSnapshot as recordCallUsageSnapshotImpl,
  sameTokenBreakdown as sameTokenBreakdownImpl,
  emitToolResult as emitToolResultImpl,
  emitTurnStatus as emitTurnStatusImpl,
  emitRetryingStatus as emitRetryingStatusImpl,
  _consumeRateLimitsForEmit as _consumeRateLimitsForEmitImpl,
  emitResult as emitResultImpl,
} from './codexAppServerNotifications.js'
import { rememberImageStderr, redactImageUpstream } from './imageGenerationFailure.js'
export {
  isMissingRolloutError,
  isGoalAlreadyClearedError,
  _codexUsageToAnthropicShape,
  _stringifyItemBounded,
  _CODEX_5H_WINDOW_MINS,
  _CODEX_7D_WINDOW_MINS,
  _parseCodexRateLimits,
  _classifyJsonRpcLine,
  summarizeCommandForDescription,
} from './codexAppServerProtocol.js'
export type { JsonRpcCallError, RuntimeRateLimits } from './codexAppServerProtocol.js'

export const log = createLogger({ module: 'codexAppServerRunner' })

const guardedStdin = new WeakSet<object>()
function guardStdinErrors(stdin: {
  on?: (event: 'error', fn: (err: Error) => void) => unknown
}): void {
  if (guardedStdin.has(stdin)) return
  guardedStdin.add(stdin)
  if (typeof stdin.on !== 'function') return
  stdin.on('error', () => {
    /* swallow async EPIPE so a settled write cannot become uncaughtException */
  })
}

const RUNNER_SHUTDOWN_GRACE_DEFAULT_MS = 3_000
const RUNNER_SHUTDOWN_FINAL_DRAIN_DEFAULT_MS = 3_000

const NATIVE_COMPACTION_TIMEOUT_MS = 15 * 60_000

// ── turn/start 窄路径自动重试(turn-retry 批,2026-07-18)──────────────────
// 只重试 **turn/start 请求本身被拒**的窄路径(app-server 明确 JSON-RPC application
// error + retryable 语义 + 本 attempt 零可观测输出/零 usage/零终态帧)。**status=
// 'failed' 一律不重试**:实测②——failed 后 user input 已落 thread(rollout
// response_item 在 API 调用前落盘且不回滚),重发 turn/start 会重复 user input。
/** 第 N 次失败后、第 N+1 次尝试前的基础退避(index = 失败的 attempt 序号 − 1)。 */
const RETRY_BACKOFFS_MS = [2_000, 5_000] as const
const RETRY_JITTER_MS = 500


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
//     requests too — recognized approval / MCP elicitation requests are
//     answered in-process; unknown methods still fail fast with -32601).
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
  catalog?: import('../gatewayRuntimeServices.js').CatalogRuntimePort
  systemHelpContextFile?: string
  sessionKey: string
  agentId: string
  cwd: string
  /** Previously captured codex thread_id — continue the conversation. Caller
   *  must ensure this is a codex thread_id, not a CCB session id; sessionManager
   *  enforces this via provider-tagged resume map. */
  resumeSessionId?: string
  /** Durable-artifact ladder hook: when thread/resume fails with "no rollout
   *  found" for `staleThreadId`, return a prior thread id whose rollout still
   *  exists (or undefined). Lets a container rebuild that lost only the newest
   *  rollout keep the conversation instead of thread/start from scratch. */
  resolveResumeFallback?: (staleThreadId: string) => string | undefined
  /** Agent model id from agents.yaml (e.g. `gpt-5-codex`). Forwarded to
   *  thread/start/resume so codex picks the right model. */
  model?: string
  // ── Platform context injection (parity with SubprocessRunner / CodexRunner) ──
  /** Path to agent's persona file (CLAUDE.md / SOUL.md). */
  identityCompat?: IdentityCompatRuntimeContext
  persona?: string
  /** Effective provider for `buildPromptContext` provider-keyed slot logic. */
  agentProvider?: string
  /** Initial effort level for the RESEARCH slot activation. */
  effortLevel?: string
  /** Gateway config; required for platform context injection. */
  config?: OpenClaudeConfig
  /** Forwarded to mcp-memory env so delegate_task can enforce recursion caps. */
  delegationDepth?: number
  /** Per-turn default. SessionManager resets this before every submit. */
  conversationMode?: 'default' | 'plan'
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
  projectId?: string
  runContext?: import('../runContextPersist.js').RunContextDescriptor
  frozenProjectContext?: import('@openclaude/storage').FrozenProjectContext | null
  /** snapshot provider。由 SessionManager 注入(`this._getRepoSnapshot`),
   *  内部读 `_repoWorkspace.getRepoSnapshot(sessionId)`。返 null = 无绑定;
   *  返 ready = 已绑定可用;返 cloning/failed/pending = 不可用,运行时回退 opts.cwd。 */
  getRepoSnapshot?: (sessionId: string) => RepoSnapshot | null
  /** One-shot audit isolation: empty cwd, no platform prompt/MCP/tools/network. */
  hermeticNoTools?: boolean
  /** Codex app-server turn/start structured output contract. */
  structuredOutputSchema?: Readonly<Record<string, unknown>>
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
  collabAgentPolicy?: CollabAgentPolicy
  queueTurn?: boolean
  traceId?: string
  automaticRetryState?: AutomaticRetryState
  readOnly?: boolean
}

export class PromptQueueRunnerInvariantError extends Error {
  readonly code = 'PROMPT_QUEUE_RUNNER_INVARIANT'
  constructor(message: string) {
    super(message)
    this.name = 'PromptQueueRunnerInvariantError'
  }
}

export function assertPromptQueueRunnerAdmission(
  queueTurn: boolean,
  processing: boolean,
  queuedTurns: number,
): void {
  if (queueTurn && (processing || queuedTurns > 0)) {
    throw new PromptQueueRunnerInvariantError(
      `queue turn cannot enter Codex runner backlog (processing=${processing}, queued=${queuedTurns})`,
    )
  }
}

export class CodexAppServerRunner extends EventEmitter {
  private nativeContext = new CodexNativeContext((event) => this.emit('context_observation', event), (status) => this.emitTurnStatus(status))
  private threadId: string | null
  private proc: ChildProcessWithoutNullStreams | null = null
  private nextRequestId = 0
  private pending = new Map<number, PendingRequest>()
  private nextUserInputRequestId = 0
  /** Browser-facing permission request id → exact Codex reverse-RPC context. */
  private pendingUserInputs = new Map<string, PendingCodexUserInput>()
  /** Exact reverse-RPC id → browser-facing id. Prevents duplicate cards if a
   * transport replays the same still-pending request. */
  private pendingUserInputIdsByRpc = new Map<string, string>()
  private queue: QueuedTurn[] = []
  private processing = false
  private shuttingDown = false
  private spawnEmitted = false
  private initialized = false
  /** Captured from this queue entry; never inferred from a rewritten prompt. */
  private advisorReadOnly = false
  /** Tool/MCP schemas are process-scoped, so both policy transitions recycle. */
  private spawnedAdvisorReadOnly: boolean | null = null
  private advisorReadOnlyConfig: Record<string, unknown> | undefined
  /**
   * USER_CANCELLED 只发 turn/interrupt、不杀进程。合作式 summary 到达后
   * sessionManager 会跳过 shutdown,下一 turn ensureSpawned 会复用已经
   * websocket/relay 死掉的 PID。置位后下一 ensureSpawned 必须 recycle。
   */
  private staleProcGeneration = false
  /**
   * OCV5-435: a Stop that arrives while a queued/starting turn has no turn id
   * yet (spawn, thread/start|resume, before turn/start answers). It used to be
   * dropped, so the turn ran to completion. runTurn consumes it: before
   * turn/start the turn ends as USER_CANCELLED without starting; once the id
   * arrives it is interrupted at once. Cleared when runTurn returns.
   */
  private pendingStartInterrupt = false
  /** True iff the *current* app-server proc has done thread/start or
   *  thread/resume for this.threadId. Cleared when the proc dies. Distinct
   *  from `initialized` (which tracks the JSON-RPC handshake) — re-spawning
   *  the proc requires re-attaching even when threadId is known. */
  private attached = false
  private activeTurnId: string | null = null
  private platformGoal: GoalStateSnapshot | null = null
  /** Distinguishes "the platform has never supplied goal state" from an
   *  explicit null snapshot, which means clear Codex's native goal. */
  private platformGoalInitialized = false
  private syncedPlatformGoalSignature: string | null = null
  private syncedPlatformGoal: GoalStateSnapshot | null = null
  /** Promise wired into `turn/completed` notification handling. Set by runTurn
   *  before sending `turn/start`, resolved by handleNotification on
   *  `turn/completed` for the matching turnId. */
  private pendingNativeCompaction: {
    startedAt: number
    resolve: () => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  } | null = null
  private currentTurnCompleter: {
    resolve: (turn: {
      status?: string
      durationMs?: number
      /** turn-retry 批 — codex turn/completed 的 turn.error 除 message 外还带
       *  codexErrorInfo(实测值形如 "other");透传进内部日志,不进用户面。 */
      error?: { message?: string; codexErrorInfo?: unknown }
    }) => void
    reject: (err: Error) => void
  } | null = null
  /** Request id of the currently executing paid turn. Needed to settle usage
   * correctly if shutdown wins the race with turn/completed. */
  private activeRequestId: string | undefined
  private forcedShutdownResultEmitted = false
  private stdoutBuf = ''
  /** Current app-server generation's full stdio-close barrier. */
  private outputDrainPromise: Promise<void> = Promise.resolve()
  private resolveOutputDrain: (() => void) | null = null
  /** Accumulated assistant text for the current turn — used to dedupe
   *  imageGeneration savedPath emissions against text the model already
   *  surfaced via deltas. */
  private currentAssistantBuf = ''
  /** Authoritative completed agentMessage for an outputSchema turn. Codex may
   *  stream an abandoned schema attempt before its final valid JSON item, so
   *  the concatenated delta buffer cannot be parsed as structured output. */
  private hasCurrentStructuredOutput = false
  private currentStructuredOutput: unknown
  /** Accumulated raw plan draft for codex item/plan/delta notifications. */
  private currentPlanDraft = ''
  /** Per-turn collaboration mode. SessionManager resets it before every submit. */
  private conversationMode: 'default' | 'plan' = 'default'
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
  // ── turn-retry 批:per-attempt 台账(单调 flags,fail-closed 重试门)──────
  /** 本 attempt 是否已越过任一对外「可观测输出」边界(assistant text / thinking /
   *  reasoning delta、plan/goal 块)。任一置位 → turn/start 窄路径重试禁止(重试
   *  会重复已展示内容)。resetAttemptState 复位。 */
  private attemptHadObservableOutput = false
  /** 本 attempt 是否已越过任一 tool_use / tool_result / permission(requestUserInput)/
   *  item handler 注册边界。置位 → 重试禁止。resetAttemptState 复位。 */
  private attemptHadToolOrPermission = false
  /** 本 attempt 是否已 emit 过任一 billing/result 终态帧(emitResult / 强制关停)。
   *  置位 → 重试禁止(已记账,重发会二次 settle)。resetAttemptState 复位。 */
  private attemptEmittedTerminal = false
  /** 退避 sleep 的中断句柄。非空 = 正处于 turn/start 重试退避窗口;interrupt() 在此
   *  期间(activeTurnId 为 null)也接受,abort 后 runTurn 走 USER_CANCELLED 终态。 */
  private pendingRetryAbort: AbortController | null = null
  /** 审计 R8 — 本次退避窗口内 proc 是否已经崩溃/关闭。proc close/error 回调唤醒退避
   *  时置位;runTurn 的 proc-gone 门据此把终态判为 crashed(而非 interrupt 的
   *  USER_CANCELLED)。close 已把 proc 置 null(门的 `!this.proc` 分支即可命中),
   *  但 error 早于 close 且刻意不清 proc(留到 close 收尾以吸收晚到 stdout),故需要
   *  这个独立标记让 error 唤醒的退避也走 proc-gone 终态。安装每个退避控制器时复位。 */
  private retryBackoffProcGone = false
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

  /** V5 CG(2026-07-10)— 本 turn 内已发过 `tool_use` 帧的 codex item id 集合,
   *  用于维护「tool_use / tool_result 成对」这个前端渲染不变量。
   *
   *  取证根因:codex 的 `subAgentActivity` item 只经 `item/completed` 到达
   *  (handleItemCompleted 尾部通用兜底 → emitToolResult),**从不发 `item/started`**
   *  —— handleItemStarted 对未知类型本会走通用 `emitAssistantToolUse('codex:<type>')`,
   *  既然实测前端拿到孤儿 result 而无配对 use,说明 codex 根本没为它触发 started
   *  (它把子 agent 的 started/completed 建模成 item 内部的 `kind` 字段,协议层只发
   *  一次/多次 item/completed)。孤儿 tool_result 到前端后 toolName 兜底成 'unknown'、
   *  inputJson=null,渲染成裸 JSON 卡。
   *
   *  收口(消一整类而非单个 subAgentActivity):emitAssistantToolUse 处登记 id,
   *  emitToolResult 发现 id 未配对时先补发一帧 tool_use 再发 result —— 任何 codex
   *  item 类型(现有 + 未来新增)都保证成对到达前端。同一 id 的后续 result(如
   *  subAgentActivity 的 kind=started 后跟 kind=completed)因 id 已在集合中,不再
   *  重复补发 tool_use,只追加 result 到同一张卡。
   *
   *  生命周期:per-turn。runTurn 顶部清空,shutdown 清空——codex 每 turn 重排 item
   *  id,跨 turn 保留会既泄漏又可能与新 turn 的 id 撞车漏发 tool_use。 */
  private emittedToolUseIds = new Set<string>()
  /** Per-turn model-call attribution. Item notifications bind to an epoch
   * synchronously (first-write-wins) before async item handlers run. */
  private callUsageEpoch = 0
  private itemCallUsageEpoch = new Map<string, number>()
  private callUsageByEpoch = new Map<
    number,
    { callId: string; targetIds: Set<string>; usage?: TurnTokenUsageSnapshot }
  >()

  /** Per-reasoning-item state for `item/reasoning/*` notifications. Both raw
   * text and summary deltas are paid model output and are therefore emitted
   * in arrival order; the state only suppresses a leading empty paragraph
   * before the first real delta. Cleared at every turn boundary. */
  private reasoningItemState: Map<string, { sawContent: boolean }> = new Map()
  /** Codex 0.137 collaboration APIs model subagents as thread receivers.
   *  The web UI, however, already has a stable Agent-card contract keyed by
   *  the spawning tool_use id. Keep a small per-turn reverse index so later
   *  wait/join control items can close the original Agent card when every
   *  receiver thread reaches a terminal state. */
  private collabReceiverToSpawnId = new Map<string, string>()
  private collabSpawnReceivers = new Map<string, Set<string>>()
  private completedCollabSpawnResults = new Set<string>()
  /** Active turn's collaboration policy. Set from the queued turn/runTurn arg
   *  (not from a cross-turn caller-global) so queued turns cannot overwrite
   *  one another before drain() starts processing them. */
  private currentCollabAgentPolicy: CollabAgentPolicy | undefined = undefined

  /** mkdtempSync'd dir holding the per-spawn `extra-prompt.md`. Created lazily
   *  in `ensureSpawned()` whenever a fresh app-server process needs platform
   *  context, cleaned on `shutdown()` and on proc close. */
  private sessionDir: string | null = null
  private hermeticDir: string | null = null
  /** Cached overrides for the lifetime of the current proc. Cleared together
   *  with `sessionDir` so the next post-shutdown spawn lazy-rebuilds. */
  private cachedOverrides: CodexLaunchOverrides | null = null
  private codexRouteConfig: CodexProviderConfigOverride | null = null
  private spawnedProviderSignature: string | null = null

  // ── Phase 5 GitHub session repo binding(parity with SubprocessRunner)──
  /** ready 状态下记录当前生效的 repo binding — selectionVersion 给
   *  sessionManager.recyclePeerForRepoChange 用作版本对比依据;workspaceDir 仅
   *  做诊断/日志(真用作 cwd 的是 runTurn 顶部一次取的 effectiveCwd)。
   *  非 ready / 无 binding / 无 sessionId 注入 = null。 */
  private _boundRepoBinding: { selectionVersion: number; workspaceDir: string } | null = null

  // ── SubprocessRunner interface parity (referenced by sessionManager.ts) ──
  public lastActivityAt: number = Date.now()
  public effortLevel: string | undefined = undefined
  /** Intelligent UI(OCV5-361):当前 app-server 的 instructions 里 INTELLIGENT_UI 段的指纹(没有 = false)。 */
  private _promptIntelligentUi: IntelligentUiApplied | undefined = undefined
  private _promptPolicyFingerprint: string | undefined
  private promptPolicy: PromptPrivacyPolicy | undefined
  get promptPolicyFingerprint(): string | undefined { return this._promptPolicyFingerprint }
  assertPromptPrivacyStopped(): void {
    if (this.proc) throw new Error("助手隐私刷新仍在等待旧进程终结，请稍后重试。")
  }
  setPromptPrivacy(policy: PromptPrivacyPolicy): void { this.promptPolicy = structuredClone(policy) }
  clearPromptPrivacy(): void { this.promptPolicy = undefined }
  get promptIntelligentUi(): IntelligentUiApplied | undefined {
    return this._promptIntelligentUi
  }
  private relayDeniedTracker: CodexRelayPathDeniedTracker

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
    // v1.0.200 起 effort 主通道改成 codex argv:`ensureSpawned` 调
    // `codexReasoningEffortConfig(this.model,this.effortLevel)` 拼
    // `-c model_reasoning_effort=...` 透传给 `codex app-server`。Codex 0.144
    // 原生接受 max；缺省按具体 GPT-5.6 型号默认值,不再一律强制 high。
    //
    // RESEARCH slot 仍由 buildPromptContext 单独维护,仅在 effortLevel === 'max'
    // 时注入"科研模式"提示文本(主要服务 Opus/DeepSeek 异常 max payload);
    // GPT-5.6 max effort 走 argv；RESEARCH slot 的 prompt 仅是跨引擎兼容补充。
    //
    // setEffortLevel 仍只 stash on this — 长寿 `codex app-server` 进程不接受
    // 运行时切档,值在下次 spawn 生效;sessionManager.submit 会在切档时显式
    // shutdown(),让下一 turn ensureSpawned() 读到新值。
    this.effortLevel = level
  }

  setConversationMode(mode: 'default' | 'plan' | undefined): void {
    this.conversationMode = mode === 'plan' ? 'plan' : 'default'
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
    if (this.opts.model !== model) this.nativeContext.reset()
    this.opts.model = model
  }

  setCodexRoute(route: CodexProviderConfigOverride | null | undefined): void {
    this.codexRouteConfig = route ?? null
  }

  private codexRouteSignature(): string {
    return JSON.stringify(this.codexRouteConfig ?? null)
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

  async setGoalState(goal: GoalStateSnapshot | null): Promise<void> {
    this.platformGoalInitialized = true
    this.platformGoal = goal ? structuredClone(goal) : null
    if (this.proc && this.attached && this.threadId && this.activeTurnId === null) {
      await this.syncPlatformGoal()
    }
  }

  private platformGoalSignature(): string {
    const goal = this.platformGoal
    if (!goal || goal.status === 'cleared') return 'cleared'
    return JSON.stringify({
      goalId: goal.goalId,
      stateRevision: goal.stateRevision,
      objective: goal.objective,
      status: goal.status,
      tokenBudget: goal.tokenBudget,
    })
  }

  private async syncPlatformGoal(): Promise<void> {
    if (!this.platformGoalInitialized || !this.threadId || !this.attached) return
    const signature = this.platformGoalSignature()
    if (signature === this.syncedPlatformGoalSignature) return
    const goal = this.platformGoal
    const cleared = !goal || goal.status === 'cleared'
    // app-server can deliver the matching notification synchronously from the
    // same stdout chunk before this request Promise resumes. Stage the platform
    // generation first so that notification is correlated to the mutation that
    // caused it; restore the last successful stamp if the request itself fails.
    const previousSignature = this.syncedPlatformGoalSignature
    const previousGoal = this.syncedPlatformGoal
    this.syncedPlatformGoalSignature = signature
    // Keep a cleared platform snapshot for correlation so Codex's native
    // thread/goal/cleared notification updates the existing card in place.
    this.syncedPlatformGoal = goal ? structuredClone(goal) : null
    try {
      await this.sendRequest('thread/goal/set', {
        threadId: this.threadId,
        objective: cleared ? null : goal.objective,
        status: cleared ? null : goal.status === 'completed' ? 'complete' : goal.status,
        tokenBudget: cleared ? null : goal.tokenBudget,
      })
    } catch (err) {
      // Clearing a goal the app-server never had = the desired state already
      // holds; keep the staged 'cleared' stamp so the next turn short-circuits
      // on signature instead of re-issuing the doomed RPC.
      if (cleared && isGoalAlreadyClearedError(err)) {
        log.info('codex thread/goal/set: no goal upstream — treating clear as no-op', {
          sessionKey: this.opts.sessionKey,
          threadId: this.threadId,
        })
        return
      }
      // SessionManager serializes setGoalState under the session lock, so no
      // newer sync can legitimately supersede this staged value here.
      this.syncedPlatformGoalSignature = previousSignature
      this.syncedPlatformGoal = previousGoal
      throw err
    }
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
    this.settleAllPendingUserInputs('session id cleared')
    this.threadId = null
    this.priorTurnTotal = null
    this.activeTurnTotal = null
    this.currentTurnUsage = null
    this.resetCallUsageAttribution()
    this.syncedPlatformGoalSignature = null
    this.syncedPlatformGoal = null
    this.cleanupLaunchOverrides()
  }

  /** Steer the next attach at a prior thread whose rollout is known to exist
   *  on disk. Same bookkeeping as clearSessionId, but with a target id so the
   *  next runTurn does thread/resume instead of thread/start. */
  setResumeSessionId(sessionId: string): void {
    this.clearSessionId()
    this.threadId = sessionId
  }

  /** 读当前 session 的 repo snapshot。turn 顶部一次取,贯穿 ensureSpawned /
   *  thread/start / thread/resume / launch overrides 四个消费点,避免它们各自取
   *  的瞬间不一致(撕裂窗口)。 */
  private _currentRepoSnapshot(): RepoSnapshot | null {
    if (!this.opts.sessionId || !this.opts.getRepoSnapshot) return null
    try {
      return this.opts.getRepoSnapshot(this.opts.sessionId)
    } catch (err) {
      if (this.opts.hermeticNoTools) throw err
      log.warn('getRepoSnapshot threw; treating as no-bind', {
        sessionKey: this.opts.sessionKey,
        err: (err as Error).message,
      })
      return null
    }
  }

  /** 把 snapshot 折算成本 turn 的有效 cwd,顺手更新 _boundRepoBinding。
   *  ready+workspaceDir → 用 workspaceDir + 记录 binding;其它 → 回退 opts.cwd
   *  + binding=null。返回值是 spawn / thread/start / thread/resume 都用的 cwd。 */
  private _applyRepoBindingFromSnapshot(snap: RepoSnapshot | null): string {
    if (this.opts.hermeticNoTools) {
      this._boundRepoBinding = null
      if (!this.hermeticDir) this.hermeticDir = mkdtempSync(join(tmpdir(), 'oc-codex-hermetic-'))
      return this.hermeticDir
    }
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

  sendPermissionResponse(requestId: string, responseUnk: unknown): boolean {
    const pending = this.pendingUserInputs.get(requestId)
    if (!pending) return false

    const response = asRecord(responseUnk)
    const codexAnswers: Record<string, { answers: string[] }> = {}
    if (response.behavior === 'allow') {
      // server.ts already ran sanitizeAskUserQuestionUpdatedInput. Keep a
      // defensive type/nonblank check here because EngineAdapter is a public
      // seam and tests/other channels may call it directly.
      const updatedInput = asRecord(response.updatedInput)
      const answersByQuestionText = asRecord(updatedInput.answers)
      for (const question of pending.questions) {
        const answer = answersByQuestionText[question.question]
        if (typeof answer !== 'string' || answer.trim().length === 0) continue
        // Codex 0.144/0.149 has no multiSelect input field. Its response still
        // uses an array so future/internal callers can express more than one
        // value; the existing AskUserQuestion card supplies one string.
        codexAnswers[question.id] = { answers: [answer] }
      }
    }

    // A browser deny (or an allow whose already-sanitized answers somehow
    // vanished) is represented by the schema-valid empty answers map. Codex
    // app-server uses the same empty response after a client-side RPC error,
    // so the model receives an explicit no-answer result instead of hanging.
    const written = this.writeRaw(jsonRpcResult(pending.rpcId, { answers: codexAnswers }))
    if (!written) return false
    this.takePendingUserInput(requestId)
    // Resume from human wait with a fresh liveness window, without waiting
    // for upstream stdout. The status message below also emits adapter
    // activity, renewing the independent 30min idle backstop.
    this.lastActivityAt = Date.now()
    this.emitUserInputWaitStatus()
    return true
  }

  private takePendingUserInput(requestId: string): PendingCodexUserInput | null {
    const pending = this.pendingUserInputs.get(requestId)
    if (!pending) return null
    this.pendingUserInputs.delete(requestId)
    this.pendingUserInputIdsByRpc.delete(pending.rpcKey)
    return pending
  }

  private settlePendingUserInputsForTurn(turnId: string, reason: string): number {
    const requestIds = [...this.pendingUserInputs.entries()]
      .filter(([, pending]) => pending.turnId === turnId)
      .map(([requestId]) => requestId)
    for (const requestId of requestIds) {
      const pending = this.takePendingUserInput(requestId)
      if (!pending) continue
      this.writeRaw(jsonRpcResult(pending.rpcId, { answers: {} }))
    }
    if (requestIds.length > 0) {
      this.emitUserInputWaitStatus()
      log.info('codex requestUserInput settled without browser answer', {
        sessionKey: this.opts.sessionKey,
        turnId,
        count: requestIds.length,
        reason,
      })
    }
    return requestIds.length
  }

  private settleAllPendingUserInputs(reason: string): void {
    const turnIds = new Set([...this.pendingUserInputs.values()].map((pending) => pending.turnId))
    for (const turnId of turnIds) this.settlePendingUserInputsForTurn(turnId, reason)
  }

  private clearPendingUserInputs(): void {
    const hadPending = this.pendingUserInputs.size > 0
    this.pendingUserInputs.clear()
    this.pendingUserInputIdsByRpc.clear()
    if (hadPending) this.emitUserInputWaitStatus()
  }

  get waitingForUserInput(): boolean {
    return this.pendingUserInputs.size > 0
  }

  private emitUserInputWaitStatus(): void {
    this.emitTurnStatus(this.pendingUserInputs.size > 0 ? 'waiting_for_user' : null)
  }

  private compactPrivacyPreparing = false
  async compactForHandoff(): Promise<NativeModelHandoffArtifact> {
    if (!this.proc || !this.attached || !this.threadId) throw new Error('CODEX_NATIVE_COMPACTION_SESSION_NOT_READY')
    if (this.processing || this.currentTurnCompleter || this.pendingNativeCompaction || this.compactPrivacyPreparing) throw new Error('CODEX_NATIVE_COMPACTION_BUSY')
    const sourceThread = this.threadId
    let expectedGeneration = this._preheatGeneration
    const assertCurrent = () => {
      if (this._preheatGeneration !== expectedGeneration) throw new Error('CODEX_NATIVE_COMPACTION_INTERRUPTED')
    }
    this.compactPrivacyPreparing = true
    try {
      return await withFreshPromptPrivacy(this, this.opts.sessionId, async () => {
        if (this.threadId !== sourceThread) throw new Error('CODEX_NATIVE_COMPACTION_SESSION_CHANGED')
        if (!this.proc || !this.attached) {
          const repo = this._currentRepoSnapshot()
          const cwd = this._applyRepoBindingFromSnapshot(repo)
          await this.ensureSpawned(repo, cwd)
          assertCurrent()
          const transportModel = codexTransportModelId(this.opts.model)
          await this.sendRequest('thread/resume', {
              ...(this.cachedOverrides?.instructionsContent !== undefined ? { baseInstructions: this.cachedOverrides.instructionsContent } : {}),
            threadId: sourceThread, approvalPolicy: 'never', sandbox: 'danger-full-access', cwd,
            ...(transportModel ? { model: transportModel } : {}),
          })
          assertCurrent()
          this.attached = true
        }
        assertCurrent()
        return this.compactCurrentThreadForHandoff()
      }, { assertCurrent, beforeOwnedShutdown: () => { assertCurrent(); expectedGeneration++ } })
    } finally { this.compactPrivacyPreparing = false }
  }
  private async compactCurrentThreadForHandoff(): Promise<NativeModelHandoffArtifact> {
    if (!this.proc || !this.attached || !this.threadId) {
      throw new Error('CODEX_NATIVE_COMPACTION_SESSION_NOT_READY')
    }
    if (this.processing || this.currentTurnCompleter || this.pendingNativeCompaction) {
      throw new Error('CODEX_NATIVE_COMPACTION_BUSY')
    }
    const compactStartedAt = Date.now()
    const completed = new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        if (this.pendingNativeCompaction?.startedAt !== compactStartedAt) return
        this.pendingNativeCompaction = null
        rejectPromise(new Error('CODEX_NATIVE_COMPACTION_TIMEOUT'))
      }, NATIVE_COMPACTION_TIMEOUT_MS)
      timer.unref?.()
      this.pendingNativeCompaction = {
        startedAt: compactStartedAt,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      }
    })
    try {
      await this.sendRequest('thread/compact/start', { threadId: this.threadId })
      await completed
      const result = (await this.sendRequest('thread/read', {
        threadId: this.threadId,
        includeTurns: false,
      })) as { thread?: { path?: unknown } }
      const rolloutPath = result.thread?.path
      if (typeof rolloutPath !== 'string' || !rolloutPath) {
        throw new Error('CODEX_NATIVE_COMPACTION_PATH_MISSING')
      }
      return await readLatestCodexNativeHandoff(rolloutPath, compactStartedAt)
    } catch (error) {
      this.clearPendingNativeCompaction(compactStartedAt)
      throw error
    }
  }

  private clearPendingNativeCompaction(compactStartedAt: number): void {
    const pending = this.pendingNativeCompaction
    if (!pending || pending.startedAt !== compactStartedAt) return
    this.pendingNativeCompaction = null
    clearTimeout(pending.timer)
  }

  interrupt(): boolean {
    if (this.nativeContext.running) {
      this.pendingStartInterrupt = true
      this.nativeContext.abort(new Error('Native context compaction interrupted'))
      return true
    }
    if (this.compactPrivacyPreparing) {
      void this.shutdown()
      return true
    }
    // 审计 R8:退避窗口内 activeTurnId 为 null 但有重试待发 —— 中断退避,runTurn 的
    // backoff sleep 立即以「已中断」返回,走 USER_CANCELLED 终态并清 retrying 状态帧。
    // **必须先于 proc 存活守卫**:proc 已死但退避 sleep 仍在跑时(如 crash 与 close
    // 之间的窗口),用户 stop 也要能立即中断退避,否则要等满退避才收尾。
    this.staleProcGeneration = true
    if (this.pendingRetryAbort) {
      this.pendingRetryAbort.abort()
      return true
    }
    const hadPendingUserInput = this.pendingUserInputs.size > 0
    if (hadPendingUserInput) this.settleAllPendingUserInputs('runner interrupt')
    if (!this.activeTurnId && (this.processing || this.queue.length > 0)) {
      this.pendingStartInterrupt = true
      return true
    }
    if (!this.proc || this.proc.killed) return hadPendingUserInput
    if (!this.threadId || !this.activeTurnId) return hadPendingUserInput
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

  /** 审计 R8 — proc 在 turn/start 重试退避窗口内崩溃/关闭时唤醒退避 sleep,让 runTurn
   *  的 proc-gone 门立即转 crashed 终态(不再等满退避)。非退避期(pendingRetryAbort
   *  为 null)是 no-op;置 retryBackoffProcGone 与 interrupt 的用户取消路径区分终态。
   *  幂等(AbortController.abort 幂等)。proc close/error 回调各调用一次。 */
  private wakeRetryBackoffOnProcGone(): void {
    if (this.pendingRetryAbort) {
      this.retryBackoffProcGone = true
      this.pendingRetryAbort.abort()
    }
  }

  constructor(private opts: CodexAppServerRunnerOpts) {
    super()
    this.threadId = opts.resumeSessionId ?? null
    this.effortLevel = opts.effortLevel
    this.setConversationMode(opts.conversationMode)
    this.relayDeniedTracker = new CodexRelayPathDeniedTracker(
      shouldOmitPlatformMcp(opts.agentId, opts.sessionKey),
    )
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
    if (this.opts.hermeticNoTools) return null
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
    const privacyGeneration = this._preheatGeneration
    const dir = mkdtempSync(join(tmpdir(), 'oc-codex-app-'))
    try {
      const overrides = await buildCodexLaunchOverrides({
        catalog: this.opts.catalog,
        systemHelpContextFile: this.opts.systemHelpContextFile,
        promptPolicy: this.promptPolicy,
        agentId: this.opts.agentId,
        sessionKey: this.opts.sessionKey,
        persona: this.opts.persona,
        identityCompat: this.opts.identityCompat,
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
        sessionId: this.opts.sessionId,
        projectId: this.opts.projectId,
        runContext: this.opts.runContext,
        frozenProjectContext: this.opts.frozenProjectContext,
        cwd: this.opts.cwd,
        readOnly: this.advisorReadOnly,
      })
      if (privacyGeneration !== this._preheatGeneration) throw new Error('PROMPT_PRIVACY_SPAWN_STALE')
      writeFileSync(overrides.instructionsFile, overrides.instructionsContent, 'utf8')
      // v3 hardening — see codexRunner.ts for rationale (token never in argv).
      if (overrides.tokenFile && overrides.tokenContent !== null) {
        writeFileSync(overrides.tokenFile, overrides.tokenContent, { mode: 0o600 })
      }
      if (overrides.delegateContextFile && overrides.delegateContextContent !== null) {
        writeFileSync(overrides.delegateContextFile, overrides.delegateContextContent, {
          mode: 0o600,
        })
      }
      this._promptIntelligentUi = overrides.intelligentUiApplied
      this._promptPolicyFingerprint = overrides.promptPolicyFingerprint
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

  private consultTurnBinding:
    | { turnKey: string; turnIndex: number; configVersion: string }
    | undefined
  private pendingConsultRespawn = false

  setConsultTurn(
    binding: { turnKey: string; turnIndex: number; configVersion: string } | undefined,
  ): void {
    const prev = this.consultTurnBinding?.turnKey
    this.consultTurnBinding = binding
    if (binding && prev && prev !== binding.turnKey && this.proc) {
      this.pendingConsultRespawn = true
    }
  }

  /** The app-server process is long-lived. Advisor-mode parents mint a v2
   * turn token; changing origin turnKey forces a respawn so MCP env cannot
   * reread a later turn's file. */
  private refreshDelegateContext(traceId?: string): void {
    writeCodexDelegateContext({
      file: this.cachedOverrides?.delegateContextFile,
      agentId: this.opts.agentId,
      sessionKey: this.opts.sessionKey,
      depth: this.opts.delegationDepth ?? 0,
      consultTurn: this.consultTurnBinding,
      traceId,
    })
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

  private cleanupHermeticDir(): void {
    if (!this.hermeticDir) return
    try {
      rmSync(this.hermeticDir, { recursive: true, force: true })
    } catch (err) {
      log.warn('codex hermetic cwd cleanup failed', {
        sessionKey: this.opts.sessionKey,
        err: (err as Error).message,
      })
    }
    this.hermeticDir = null
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
    collabAgentPolicy?: CollabAgentPolicy,
    queueTurn = false,
    automaticRetryState?: AutomaticRetryState,
    traceId?: string | null,
    readOnly = false,
  ): Promise<void> {
    const turnTraceId = traceId === null ? undefined : traceId ?? this.opts.traceId
    this.lastActivityAt = Date.now()
    if (!this.spawnEmitted) {
      this.spawnEmitted = true
      this.emit('spawn', { resumed: this.threadId != null })
    }
    const prompt = normalisePrompt(textOrBlocks)
    assertPromptQueueRunnerAdmission(queueTurn, this.processing, this.queue.length)
    return new Promise((resolve, reject) => {
      this.queue.push({
        prompt,
        resolve,
        reject,
        requestId,
        collabAgentPolicy,
        queueTurn,
        traceId: turnTraceId,
        automaticRetryState,
        readOnly,
      })
      void this.drain()
    })
  }

  async shutdown(opts?: { keepQueuedTurns?: boolean }): Promise<void> {
    // Same transient-shutdown semantics as CodexRunner: kill the current
    // proc, drain queue, but allow subsequent submit() to respawn. effort
    // switching and auth-token refresh paths rely on this.
    const preserveNativeUsage = this.nativeContext.running
    this.shuttingDown = true
    this.nativeContext.abort(new Error('Native context compaction interrupted'))
    this._preheatGeneration++
    this._preheatPromise = null
    this._preheatedSignature = null
    if (this._unannouncedPreheatThread) {
      this._unannouncedPreheatThread = false
      this.clearSessionId()
    }
    // Hung initialize/preheat shares _spawnPromise with submit(). Drop it and
    // reject pending JSON-RPC before waiting for the process so waiters fail
    // closed instead of inheriting a never-settling handshake.
    this._spawnPromise = null
    for (const [, p] of this.pending) {
      p.reject(new Error('CodexAppServerRunner shutdown'))
    }
    this.pending.clear()
    // turn-retry 批:若正卡在 turn/start 重试退避,唤醒它(abortableDelay 立即返回)。
    // runTurn 的退避后 proc-gone 门会据 shuttingDown 转终态,不把 turn/start 发进
    // 即将被 kill 的管道(否则 sendRequest 无人 settle → 挂死)。
    if (this.pendingRetryAbort) {
      this.pendingRetryAbort.abort()
      this.pendingRetryAbort = null
    }
    if (!opts?.keepQueuedTurns) {
      const pendingQueue = this.queue
      this.queue = []
      for (const q of pendingQueue) q.reject(new Error('CodexAppServerRunner shutdown'))
    }
    if (this.pendingNativeCompaction) {
      const pending = this.pendingNativeCompaction
      this.pendingNativeCompaction = null
      clearTimeout(pending.timer)
      pending.reject(new Error('CODEX_NATIVE_COMPACTION_INTERRUPTED'))
    }
    // Resolve app-server reverse requests while stdin is still writable. This
    // mirrors a browser deny and prevents requestUserInput from surviving a
    // transient runner recycle in either pending map.
    this.settleAllPendingUserInputs('runner shutdown')
    const proc = this.proc
    if (proc) {
      let resolveClose!: () => void
      const closePromise = new Promise<void>((resolve) => {
        resolveClose = resolve
      })
      const onClose = () => resolveClose()
      proc.once('close', onClose)
      if (proc.exitCode === null && proc.signalCode === null) {
        killCodexProcessGroup(proc, 'SIGTERM')
      }
      let closed = await waitForCloseWithin(
        closePromise,
        runnerShutdownTimeoutMs(
          'OPENCLAUDE_RUNNER_SHUTDOWN_GRACE_MS',
          RUNNER_SHUTDOWN_GRACE_DEFAULT_MS,
        ),
      )
      if (!closed) {
        killCodexProcessGroup(proc, 'SIGKILL')
        closed = await waitForCloseWithin(
          closePromise,
          runnerShutdownTimeoutMs(
            'OPENCLAUDE_RUNNER_SHUTDOWN_FINAL_DRAIN_MS',
            RUNNER_SHUTDOWN_FINAL_DRAIN_DEFAULT_MS,
          ),
        )
      }
      if (!closed) {
        proc.removeListener('close', onClose)
        log.error('codex app-server close did not arrive after process-group SIGKILL', {
          sessionKey: this.opts.sessionKey,
          pid: proc.pid,
        })
        // Keep the exact process identity and stdout parser attached. A
        // descendant may still own the pipe; clearing `this.proc` here used to
        // discard those late bytes and let SessionManager finalize a partial
        // immutable tape. The normal close handler will finish billing and the
        // tape whenever the pipe actually closes. New submits remain queued
        // behind `shuttingDown` rather than racing this unfinished turn.
        return
      }
    }
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
    this.currentCollabAgentPolicy = undefined
    this.initialized = false
    this.attached = false
    this.syncedPlatformGoalSignature = null
    this.syncedPlatformGoal = null
    // The proc close event (awaited above) is the stdout-drained boundary.
    // Only now may we clear the identity pointer; clearing it earlier made the
    // stdout identity guard discard bytes already emitted by Codex.
    if (this.proc === proc) this.proc = null
    this.spawnedProviderSignature = null
    this.stdoutBuf = ''
    // Per-turn 配对台账随进程一起丢弃(下一 turn 会在 runTurn 顶部重新清空)。
    this.emittedToolUseIds.clear()
    // Clear in-flight token state. priorTurnTotal is INTENTIONALLY preserved
    // across shutdown — codex's thread token totals are server-side and
    // monotonic, so when the same instance respawns and resumes the thread,
    // the next `thread/tokenUsage/updated.total` value will still include
    // every prior turn's tokens. Resetting our baseline would over-bill the
    // first turn after a respawn by the entire thread total.
    //
    // Native preflight has no user turn completer: after stdout drains its
    // caller emits the original failure/Stop with this still-unconsumed usage.
    if (!preserveNativeUsage) {
      this.activeTurnTotal = null
      this.currentTurnUsage = null
    }
    this.resetCallUsageAttribution()
    // Tear down the per-spawn launch overrides so the next post-shutdown
    // submit() rebuilds against a fresh sessionDir. Re-using a stale
    // overrides reference after we rmSync the dir would point codex at a
    // deleted file on respawn.
    this.cleanupLaunchOverrides()
    this.cleanupHermeticDir()
    this.shuttingDown = false
  }

  /** Capture-by-value barrier for the current app-server generation. */
  waitForOutputDrain(): Promise<void> {
    return this.outputDrainPromise
  }

  // ─── internals ────────────────────────────────

  private async drain(): Promise<void> {
    if (this.processing || this.shuttingDown) return
    const turn = this.queue.shift()
    if (!turn) return
    this.processing = true
    try {
      await this.runTurn(
        turn.prompt,
        turn.requestId,
        turn.collabAgentPolicy,
        turn.automaticRetryState,
        turn.traceId ?? null,
        turn.readOnly === true,
      )
      turn.resolve()
    } catch (err) {
      turn.reject(err as Error)
    } finally {
      this.processing = false
      void this.drain()
    }
  }

  private buildInitializeParams(): Record<string, unknown> {
    return {
      clientInfo: { name: 'openclaude-gateway', version: '1.0' },
      capabilities: {
        experimentalApi: true,
      },
    }
  }

  /** Shared in-flight spawn+initialize. Without it, a second caller arriving
   * while initialize is pending returned early and could proceed before the
   * app-server finished the handshake (preheat + submit race). */
  private _spawnPromise: Promise<void> | null = null
  private _preheatPromise: Promise<void> | null = null
  private _preheatGeneration = 0
  private _unannouncedPreheatThread = false
  private _preheatedSignature: string | null = null

  private preheatSignature(snap: RepoSnapshot | null, cwd: string): string {
    return JSON.stringify([this.opts.model ?? '', this.effortLevel, this.codexRouteSignature(),
      snap?.selectionVersion ?? 0, cwd])
  }
  private recycleInflight: Promise<void> | null = null

  /**
   * Kill the current app-server without rejecting already-queued turns.
   * Used after interrupt (stale hung PID) and after a cooperative USER_CANCELLED
   * so the next submit cannot reuse a websocket-dead process.
   * One-shot: overlapping WS stderr / interrupt-fence join the same inflight.
   */
  private async recycleProcKeepQueue(reason: string): Promise<void> {
    if (this.recycleInflight) return this.recycleInflight
    const run = this.recycleProcKeepQueueOnce(reason)
    this.recycleInflight = run
    try {
      await run
    } finally {
      if (this.recycleInflight === run) this.recycleInflight = null
    }
  }

  private async recycleProcKeepQueueOnce(reason: string): Promise<void> {
    log.info('codex app-server recycle proc', {
      sessionKey: this.opts.sessionKey,
      reason,
      pid: this.proc?.pid ?? null,
    })
    try {
      await this.shutdown({ keepQueuedTurns: true })
    } finally {
      this.staleProcGeneration = false
      void this.drain()
    }
  }

  private async ensureSpawned(repoSnap: RepoSnapshot | null, effectiveCwd: string): Promise<void> {
    if (this.staleProcGeneration && this.proc) {
      await this.recycleProcKeepQueue('interrupt-fence')
    }
    if (!this.proc) this.staleProcGeneration = false
    if (this.proc && !this.proc.killed && this.initialized) return
    const inflight = this._spawnPromise
    if (inflight) return inflight
    const spawned = this._ensureSpawnedInternal(repoSnap, effectiveCwd)
    this._spawnPromise = spawned
    try {
      await spawned
    } finally {
      if (this._spawnPromise === spawned) this._spawnPromise = null
    }
  }

  /** Prepare only process + fresh thread. Never resume/compact/turn/start.
   * A speculative thread remains volatile until a real turn claims it. */
  async preheat(): Promise<void> {
    if (this._preheatPromise) return this._preheatPromise
    if (this.processing || this.queue.length || this._preheatedSignature !== null) return
    const generation = this._preheatGeneration
    const work = (async () => {
      const repoSnap = this._currentRepoSnapshot()
      const effectiveCwd = this._applyRepoBindingFromSnapshot(repoSnap)
      const signature = this.preheatSignature(repoSnap, effectiveCwd)
      await this.ensureSpawned(repoSnap, effectiveCwd)
      if (generation !== this._preheatGeneration) throw new Error('CODEX_PREHEAT_STALE')
      if (!this.threadId && !this.attached) {
        await this._startNewThread(effectiveCwd, generation)
        if (generation !== this._preheatGeneration) throw new Error('CODEX_PREHEAT_STALE')
        this.attached = true
      }
      this._preheatedSignature = signature
    })()
    this._preheatPromise = work
    try { await work } finally {
      if (this._preheatPromise === work) this._preheatPromise = null
    }
  }

  private async _ensureSpawnedInternal(
    repoSnap: RepoSnapshot | null,
    effectiveCwd: string,
  ): Promise<void> {
    let generation = this._preheatGeneration
    if (this.proc && !this.proc.killed && this.initialized) return
    if (this.proc && !this.proc.killed && !this.initialized) {
      // In-flight initialize is fully covered by the shared _spawnPromise, so
      // reaching here means a previous initialize FAILED and left a live but
      // never-initialized proc. It would poison every later ensureSpawned
      // (this branch used to return "success"); tear it down and respawn.
      log.warn('codex app-server alive but uninitialized — replacing process', {
        sessionKey: this.opts.sessionKey,
      })
      await this.shutdown()
      if (this._preheatGeneration !== generation + 1) throw new Error('CODEX_SPAWN_STALE')
      generation = this._preheatGeneration
    }
    // Clear any partial-line residue from a prior proc (Codex review
    // #019dde20 BLOCKER round 3): stdoutBuf is runner-scoped, so without
    // this, a fragment like '{"jsonrpc":"2.0",' left by the old proc would
    // get prepended to the new proc's first stdout chunk and corrupt the
    // initialize response.
    this.stdoutBuf = ''
    this.relayDeniedTracker.reset()
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
      if (this.opts.hermeticNoTools) {
        argvOverrides = [
          '-c',
          'mcp_servers={}',
          '-c',
          'features.shell_tool=false',
          '-c',
          'features.unified_exec=false',
          '-c',
          'features.apps=false',
          '-c',
          'features.plugins=false',
          '-c',
          'features.browser_use=false',
          '-c',
          'features.browser_use_external=false',
          '-c',
          'features.computer_use=false',
          '-c',
          'features.image_generation=false',
          '-c',
          'features.multi_agent=false',
          '-c',
          'features.multi_agent_v2=false',
        ]
      } else {
        const launchStartedAt = performance.now()
    const overrides = await this.ensureLaunchOverrides(repoSnap)
    log.info('codex_turn_timing', { traceId: this.opts.traceId, threadId: this.threadId,
      stage: 'launch_context_ready', durationMs: performance.now() - launchStartedAt })
        if (overrides) argvOverrides = overrides.argvOverrides
      }
    } catch (err) {
      if (this.promptPolicy) throw err
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
    //
    // effort 进 codex argv 主通道。共享 protocol 按型号给出合法档位与默认值:
    // Sol 缺省 low、Terra/Luna 缺省 medium；用户显式 max 原样透传。
    const providerSignature = this.codexRouteSignature()
    const providerArgs = buildCodexProviderConfigArgs(process.env, this.codexRouteConfig)
    const modelCatalogArgs = buildCodexModelCatalogArgs(this.opts.model)
    const longContextArgs = buildCodexLongContextArgs(this.opts.model)
    const effortArgs = codexReasoningEffortConfig(this.opts.model, this.effortLevel)
    // T3:reasoning summary 与 effort 是同一 provider 的推理配置,co-locate 在这里
    // 一起拼(仅 codex-native/gpt-5.5 官方 OAuth 路径生效,env 可秒关)。让队长思考
    // 阶段吐 summary → thinking 卡可见。
    const reasoningSummaryArgs = buildCodexReasoningSummaryArgs(
      this.opts.agentProvider,
      process.env,
    )
    // T1:每次 spawn 无条件关闭 codex 原生多 agent(features.multi_agent_v2),与
    // telemetry hardening 同为"无条件安全兜底"——即便 launch overrides 构建失败走
    // naked launch,原生 spawnAgent 也不会复活来绕开 delegate_task。见 helper 注释。
    const multiAgentDisableArgs = buildCodexMultiAgentDisableArgs(process.env)
    // Codex 原生 request_user_input 默认只在 plan mode 暴露。V5 普通对话也必须
    // 走同一条“暂停当前 turn → 专用 Ask UI → 回写答案后续跑”的交互链，不能退回
    // busy 期间不可点击的 Markdown options 卡。与 multi-agent/telemetry 一样无条件
    // 注入，确保 platform context 构建失败走 naked launch 时仍可提问。
    const requestUserInputArgs = this.opts.hermeticNoTools
      ? []
      : ['-c', 'features.default_mode_request_user_input=true']
    // Codex 0.144 can parse a model-authored apply_patch while its custom-tool
    // input is still arriving and emit cumulative structured
    // `item/fileChange/patchUpdated` snapshots. Without this feature the first
    // fileChange item is only visible after the complete patch has been
    // generated, which leaves large edits looking frozen for minutes.
    const applyPatchStreamingArgs = this.opts.hermeticNoTools
      ? []
      : ['-c', 'features.apply_patch_streaming_events=true']
    // v5 telemetry-block C1(配置面双保险):遥测/自更新关闭 + chatgpt_base_url
    // 指向容器 loopback relay。**每次 spawn 无条件追加**(不挂 provider override
    // 成功路径)——即便本 turn 无 route override / managed_config 被非法值整份丢弃,
    // codex 的遥测直连仍被这组 `-c` 拦下。chatgpt_base_url 的 loopback base 用
    // 容器 gateway 端口(config.gateway.port,与 official_oauth route override 的
    // base_url 同拼法);config 缺失(legacy naked 路径)→ 省略该键,仍留 managed
    // _config 兜底。
    const relayPort = this.opts.config?.gateway?.port
    const chatgptRelayBaseUrl =
      typeof relayPort === 'number' && relayPort > 0
        ? `http://127.0.0.1:${relayPort}${V3_CODEX_RELAY_PREFIX}/backend-api/codex`
        : undefined
    const telemetryArgs = buildCodexTelemetryHardeningArgs(chatgptRelayBaseUrl)
    // 阶段 agent / 巡检会话不挂平台 MCP skills。chatgpt_base_url 仍指向 relay,
    // 但 apps/plugins/MCP 关闭后 rmcp 不应再打 allowlist 外路径。放在 argv 末尾
    // 覆盖 launch overrides 里可能注入的 mcp_servers.openclaude_memory.*。
    const omitPlatformMcp = shouldOmitPlatformMcp(this.opts.agentId, this.opts.sessionKey)
    const stageAgentArgs = omitPlatformMcp
      ? ['-c', 'mcp_servers={}', '-c', 'features.apps=false', '-c', 'features.plugins=false']
      : []
    const args = [
      'app-server',
      // Register the platform server. Inherited server tables are explicitly
      // disabled after initialize because empty TOML maps merge with them.
      ...(this.advisorReadOnly ? ['-c', 'mcp_servers={}'] : []),
      ...argvOverrides,
      ...providerArgs,
      ...modelCatalogArgs,
      ...longContextArgs,
      ...effortArgs,
      ...reasoningSummaryArgs,
      ...multiAgentDisableArgs,
      ...requestUserInputArgs,
      ...applyPatchStreamingArgs,
      ...telemetryArgs,
      ...stageAgentArgs,
      ...(this.advisorReadOnly ? buildAdvisorReadOnlyArgs() : []),
      '--listen',
      'stdio://',
    ]
    // Phase 5:spawn cwd 用 effectiveCwd(ready 时 = repo workspaceDir,其它 = opts.cwd)。
    // 虽然 codex app-server 本质是个 JSON-RPC 服务,proc 自身 cwd 大多数子命令不直接用,
    // 但保持与 thread/start.cwd 一致避免任何"哪边是真值"的混淆。
    if (generation !== this._preheatGeneration) throw new Error('CODEX_SPAWN_STALE')
    const proc = _spawnFn('codex', args, {
      cwd: effectiveCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      // buildCodexEnv() scrub 掉全部 OPENCLAUDE_*(安全红线,防内部 token/URL 泄漏给
      // codex/chatgpt 后端)。但 oc-memory CLI(模型经 bash 调,继承本进程 env)需要知道
      // 自己是哪个 agent 才能读写正确的 MEMORY.md/USER.md/archival —— 否则非 main agent
      // 跑在 codex(gpt-5.5)上会回落 'main'、污染 main 的记忆(memory CLI 化引入的缺口)。
      // 用**非 OPENCLAUDE_ 前缀**的 OC_AGENT_ID 显式注入(不被 scrub):agent-id 不是密钥
      // (模型本就从 persona/SOUL 知道自己是谁),暴露给 codex shell 零敏感。旧 MCP 是靠
      // mcp_servers.X.env 显式注入 agent-id 才没这问题;CLI 走 ambient env 需本行补齐。
      env: {
        ...buildCodexEnv(),
        ...identityCompatEnvironment(this.opts.identityCompat),
        OPENCLAUDE_AGENT_ID: this.opts.agentId,
        ..._codexMemoryTurnEnv(this.opts.agentId, this.opts.sessionKey, {
          gatewayPort: this.opts.config?.gateway.port,
          contextFile: this.cachedOverrides?.delegateContextFile,
          systemHelpContextFile: this.opts.systemHelpContextFile,
        }),
      },
    }) as ChildProcessWithoutNullStreams
    this.proc = proc
    this.spawnedAdvisorReadOnly = this.advisorReadOnly
    proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (this.proc !== proc) return
      log.warn('codex app-server stdin error', {
        sessionKey: this.opts.sessionKey,
        err: err.message,
        code: err.code,
      })
    })
    this.outputDrainPromise = new Promise<void>((resolve) => {
      this.resolveOutputDrain = resolve
    })
    this.spawnedProviderSignature = providerSignature
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
      this.handleStderrChunk(proc, chunk.toString('utf8'))
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
      // 审计 R8:proc 在 turn/start 重试退避窗口内出错 → 唤醒退避,让 runTurn 立即转
      // crashed 终态(retryBackoffProcGone,不误判 USER_CANCELLED)。error 刻意不清
      // this.proc(晚到 stdout 留到 close 收尾),故 proc-gone 门靠标记而非 `!this.proc`。
      this.wakeRetryBackoffOnProcGone()
      // `error` can precede `close`. Keep the exact process identity, pending
      // turn, and partial JSON line alive until the stdio-drained close
      // boundary; otherwise late paid output is silently discarded.
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
      // Preserve a final complete JSON-RPC object even if the process died
      // before writing its trailing newline.
      if (this.stdoutBuf.length > 0) {
        const trailing = this.stdoutBuf.trim()
        this.stdoutBuf = ''
        if (trailing) this.handleLine(trailing)
      }
      this.resolveOutputDrain?.()
      this.resolveOutputDrain = null
      this.handleStderrChunk(proc, '\n', true)
      const wasShutdown = this.shuttingDown
      // Reject any remaining pending JSON-RPC requests AND the in-flight turn
      // promise so callers don't hang. emitResult is the responsibility of
      // runTurn's catch — we just unwedge promises here.
      const closeReason = `codex app-server exited code=${code} signal=${signal ?? ''}`
      if (wasShutdown) this.emitForcedShutdownResult(closeReason)
      this.failAllPending(closeReason)
      // 审计 R8:proc 关闭时唤醒仍在跑的退避 sleep,让 runTurn 立即转终态(否则要等满
      // 退避才命中下面 proc=null 的 proc-gone 门)。shutdown 路径已在 shutdown() 里 abort
      // 过(幂等);crash 路径这里是唯一唤醒点。
      this.wakeRetryBackoffOnProcGone()
      this.proc = null
      this.spawnedProviderSignature = null
      this.initialized = false
      this.attached = false
      this.syncedPlatformGoalSignature = null
      this.syncedPlatformGoal = null
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
      // Intentional recycle/shutdown must not surface SIGTERM as SERVICE_RESTART
      // on a follow-up turn that already installed its exit listener (OCV5-224).
      if (!wasShutdown) {
        this.emit('exit', {
          code: code ?? 0,
          signal,
          crashed: code != null && code !== 0,
        })
      }
      if (wasShutdown) this.shuttingDown = false
    })

    // JSON-RPC handshake. `collaborationMode` and related plan-first fields
    // are gated behind Codex's experimental API capability, so declare it
    // before any turn/start call. We call the proc fresh-spawned so writes
    // won't EPIPE.
    const initializeStartedAt = performance.now()
    try {
      const initialized = await this.sendRequest('initialize', this.buildInitializeParams())
      this.advisorReadOnlyConfig = await readAdvisorReadOnlyConfig(this.advisorReadOnly, initialized,
        () => this.sendRequest('config/read', { cwd: effectiveCwd, includeLayers: false }),
        this.cachedOverrides?.tokenFile != null)
      log.info('codex_turn_timing', { traceId: this.opts.traceId, threadId: this.threadId,
        stage: 'initialize_ready', durationMs: performance.now() - initializeStartedAt })
    } catch (err) {
      // A live but never-initialized app-server must not survive: later
      // ensureSpawned calls would see proc-alive and (historically) skip the
      // handshake. Tear it down before rethrowing so the next call respawns.
      try {
        await this.shutdown()
      } catch {
        /* teardown is best-effort on a failed handshake */
      }
      throw err
    }
    this.initialized = true
  }

  private failAllPending(reason: string): void {
    this.nativeContext.abort(new Error(reason))
    for (const [, p] of this.pending) {
      p.reject(new Error(reason))
    }
    this.pending.clear()
    if (this.currentTurnCompleter) {
      this.currentTurnCompleter.reject(new Error(reason))
      this.currentTurnCompleter = null
    }
    // The process is already gone at this boundary, so a JSON-RPC response is
    // impossible. Still clear both indexes to prevent stale ids from leaking
    // into a later app-server generation.
    this.clearPendingUserInputs()
  }

  /** Emit one synthetic terminal result after a forced process shutdown. This
   * runs only at the stdout `close` boundary, so every preceding notification
   * has already updated `activeTurnTotal` and the parser buffers. */
  private emitForcedShutdownResult(reason: string): void {
    if (this.forcedShutdownResultEmitted) return
    if (!this.currentTurnCompleter && this.activeTurnId === null) return
    this.forcedShutdownResultEmitted = true
    const turnUsage = this.consumeActiveTurnUsage()
    const usage = turnUsage ? _codexUsageToAnthropicShape(turnUsage) : undefined
    this.emitResult({
      durationMs: 0,
      ok: false,
      error: reason,
      usage,
      requestId: this.activeRequestId,
      rateLimits: this._consumeRateLimitsForEmit(),
      stopReason: 'interrupted',
    })
  }

  /** Move the latest cumulative usage snapshot into this turn exactly once.
   * Normal, crash, and forced-stop paths share this so killed-turn usage can
   * never be promoted into the next baseline without a billing frame. */
  private consumeActiveTurnUsage(): CodexTokenBreakdown | null {
    if (this.activeTurnTotal === null) return null
    const baseline = this.priorTurnTotal ?? _EMPTY_TOKEN_BREAKDOWN
    const delta = _subtractTokenBreakdown(this.activeTurnTotal, baseline)
    this.currentTurnUsage = delta
    this.priorTurnTotal = this.activeTurnTotal
    this.activeTurnTotal = null
    return delta
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

  private writeRaw(line: string): boolean {
    if (!this.isInlinePushProcLive(this.proc)) return false
    try {
      this.proc!.stdin.write(`${line}\n`)
      return true
    } catch (err) {
      // EPIPE if proc died between our check and write — fail pending so
      // callers settle.
      log.warn('codex app-server stdin write failed', {
        err: (err as Error).message,
      })
      return false
    }
  }

  /**
   * R3 档 A: JSON-RPC notification `delegate/terminal` over the existing
   * app-server stdin. Official mechanism only — does not patch the Codex
   * binary. Unknown notifications may be ignored by app-server (gap reported).
   */
  async writeDelegateTerminalNotification(
    line: string,
  ): Promise<{ ok: boolean; processAlive: boolean; unknown?: boolean }> {
    const proc = this.proc
    if (!this.isInlinePushProcLive(proc) || !proc) return { ok: false, processAlive: false }
    const stdin = proc.stdin
    if (!stdin || stdin.writable === false || stdin.destroyed) {
      return { ok: false, processAlive: true }
    }
    guardStdinErrors(stdin)
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => finish(new Error('codex stdin write timeout')), 2_000)
        timer.unref?.()
        const finish = (err?: Error | null): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (typeof stdin.off === 'function') stdin.off('error', onError)
          if (typeof proc.off === 'function') proc.off('close', onClose)
          if (err) reject(err)
          else resolve()
        }
        const onError = (err: Error): void => finish(err)
        const onClose = (): void => finish(new Error('codex process closed during inline push'))
        if (typeof stdin.once === 'function') stdin.once('error', onError)
        if (typeof proc.once === 'function') proc.once('close', onClose)
        try {
          // write()===false is backpressure: the chunk is already in the
          // buffer and the caller must wait for drain/callback. It is not
          // a failure (Node 22 Writable.write). Only the callback/error
          // path settles this chunk.
          stdin.write(`${line}\n`, (err) => finish(err))
        } catch (err) {
          finish(err as Error)
        }
      })
      if (!this.isInlinePushProcLive(proc) || this.proc !== proc) {
        return { ok: false, processAlive: false }
      }
      return { ok: true, processAlive: true }
    } catch (err) {
      const live = this.isInlinePushProcLive(this.proc)
      const message = err instanceof Error ? err.message : ''
      if (live && message.includes('stdin write timeout')) {
        return { ok: false, processAlive: true, unknown: true }
      }
      return { ok: false, processAlive: live }
    }
  }

  private isInlinePushProcLive(proc: ChildProcessWithoutNullStreams | null): boolean {
    if (!proc || this.proc !== proc) return false
    if (proc.killed || proc.exitCode != null || proc.signalCode != null) return false
    return true
  }

  /**
   * Parent-turn ingest proof for InlinePush. queue/processing/completer are
   * admission, not ingest: turn/start may still reject. The only ACK is a
   * turn id returned by turn/start (activeTurnId).
   */
  get hasIngestedParentTurn(): boolean {
    return this.activeTurnId != null
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextRequestId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.writeRaw(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  private buildServerRequestAutoApproval(method: string, params: unknown): unknown | null {
    return buildServerRequestAutoApprovalImpl.call(this as unknown as CodexNotificationHost, method, params)
  }

  private handleRequestUserInput(id: number | string, paramsUnk: unknown): void {
    handleRequestUserInputImpl.call(this as unknown as CodexNotificationHost, id, paramsUnk)
  }

  private handleLine(line: string): void {
    handleLineImpl.call(this as unknown as CodexNotificationHost, line)
  }

  private emitPlanBlock(plan: {
      text?: string
      explanation?: string
      steps?: Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' }>
      partial?: boolean
    }, callTargetId?: string): void {
    emitPlanBlockImpl.call(this as unknown as CodexNotificationHost, plan, callTargetId)
  }

  private emitGoalBlock(goal: CodexGoalBlock): void {
    emitGoalBlockImpl.call(this as unknown as CodexNotificationHost, goal)
  }

  private buildTurnStartParams(prompt: string): Record<string, unknown> {
    return buildCodexTurnPolicyParams(prompt, this.threadId, {
      ...this.opts, effortLevel: this.effortLevel,
      mode: this.conversationMode, readOnly: this.advisorReadOnly,
    })
  }

  private handleNotification(method: string, params: unknown): void {
    handleNotificationImpl.call(this as unknown as CodexNotificationHost, method, params)
  }

  private handleContextCompactionItem(method: string, itemUnk: unknown): void {
    handleContextCompactionItemImpl.call(this as unknown as CodexNotificationHost, method, itemUnk)
  }

  private rememberCollabSpawnReceivers(spawnId: string, receiverThreadIds: string[]): void {
    rememberCollabSpawnReceiversImpl.call(this as unknown as CodexNotificationHost, spawnId, receiverThreadIds)
  }

  private handleCollabAgentToolStarted(itemId: string, item: Record<string, unknown>, policy?: CollabAgentPolicy): void {
    handleCollabAgentToolStartedImpl.call(this as unknown as CodexNotificationHost, itemId, item, policy)
  }

  private maybeEmitCompletedCollabAgentGroups(item: Record<string, unknown>): void {
    maybeEmitCompletedCollabAgentGroupsImpl.call(this as unknown as CodexNotificationHost, item)
  }

  private handleCollabAgentToolCompleted(itemId: string, item: Record<string, unknown>): void {
    handleCollabAgentToolCompletedImpl.call(this as unknown as CodexNotificationHost, itemId, item)
  }

  private handleItemStarted(itemUnk: unknown): void {
    handleItemStartedImpl.call(this as unknown as CodexNotificationHost, itemUnk)
  }

  private handleItemCompleted(itemUnk: unknown): Promise<void> {
    return handleItemCompletedImpl.call(this as unknown as CodexNotificationHost, itemUnk)
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
  private async _startNewThread(effectiveCwd: string, preheatGeneration?: number): Promise<void> {
    // Phase 5:effectiveCwd 由 runTurn 顶部一次取的 snapshot 折算而来,
    // 与 ensureSpawned cwd / launch overrides 的 REPO slot 保持一致。
    const res = (await this.sendRequest('thread/start', {
      ...buildCodexThreadPolicyParams(effectiveCwd, this.opts.model,
        this.advisorReadOnly, this.advisorReadOnlyConfig, this.opts.hermeticNoTools),
    })) as { thread?: { id?: string } } | undefined
    const tid = res?.thread?.id
    if (typeof tid !== 'string' || !tid) {
      throw new Error('thread/start did not return thread.id')
    }
    if (preheatGeneration !== undefined && preheatGeneration !== this._preheatGeneration) {
      throw new Error('CODEX_PREHEAT_STALE')
    }
    this.threadId = tid
    this.priorTurnTotal = null
    this.activeTurnTotal = null
    this.currentTurnUsage = null
    this.resetCallUsageAttribution()
    this.syncedPlatformGoalSignature = null
    this.syncedPlatformGoal = null
    // sessionManager listens for this and writes the new id (+ provider tag)
    // to resume-map.json, so the *next* turn against this sessionKey resumes
    // against the fresh thread instead of looping back into -32600.
    if (preheatGeneration === undefined) this.emit('session_id', tid)
    else this._unannouncedPreheatThread = true
  }

  /** turn-retry 批 — 每个 attempt 起点集中复位 per-attempt 态。**保留
   *  priorTurnTotal**(跨 attempt/turn 的累计基线)。activeTurnTotal 先断言 delta
   *  为零再清(重试路径下 turn/start 被拒前不可能有 tokenUsage 通知);非零=底座
   *  异常,promote 而非丢弃,防漏账。pendingUserInputs 断言空(串行 runner 不变量)。 */
  private resetAttemptState(): void {
    if (this.pendingUserInputs.size > 0) {
      // 到达 attempt 起点仍有挂起 reverse-request → 违反串行 runner 不变量。settle
      // 掉(no-answer)后再继续,绝不带进新 attempt。
      log.error('resetAttemptState: pendingUserInputs not empty at attempt boundary', {
        sessionKey: this.opts.sessionKey,
        count: this.pendingUserInputs.size,
      })
      this.settleAllPendingUserInputs('attempt reset')
    }
    if (this.activeTurnTotal !== null) {
      const delta = _subtractTokenBreakdown(
        this.activeTurnTotal,
        this.priorTurnTotal ?? _EMPTY_TOKEN_BREAKDOWN,
      )
      if (!this._isZeroBreakdown(delta)) {
        // 理论不可达(重试门已保证零 usage);真发生则 promote 到 priorTurnTotal 保账,
        // 不静默丢。
        log.error('resetAttemptState: non-zero usage delta at attempt boundary — promoting', {
          sessionKey: this.opts.sessionKey,
          delta,
        })
        this.priorTurnTotal = this.activeTurnTotal
      }
      this.activeTurnTotal = null
    }
    this.currentTurnCompleter = null
    this.activeTurnId = null
    this.currentAssistantBuf = ''
    this.hasCurrentStructuredOutput = false
    this.currentStructuredOutput = undefined
    this.currentPlanDraft = ''
    this.reasoningItemState.clear()
    this.emittedToolUseIds.clear()
    this.inflightItemHandlers.clear()
    this.collabReceiverToSpawnId.clear()
    this.collabSpawnReceivers.clear()
    this.completedCollabSpawnResults.clear()
    this.currentTurnUsage = null
    this.resetCallUsageAttribution()
    this.attemptHadObservableOutput = false
    this.attemptHadToolOrPermission = false
    this.attemptEmittedTerminal = false; rememberImageStderr(this, null)
  }

  /**
   * Parse stderr by complete lines. Split PATH_NOT_ALLOWED packets must not
   * refresh idle; only stage/patrol sessions abort after consecutive denials.
   * @internal tests call this via feedStderrForTests.
   */
  private handleStderrChunk(proc: unknown, chunk: string, ignoreIdentity = false): void {
    if (!ignoreIdentity && this.proc !== proc) return
    const result = this.relayDeniedTracker.consume(chunk)
    for (const line of result.completeLines) {
      rememberImageStderr(this, line); log.warn('codex app-server stderr', {
        sessionKey: this.opts.sessionKey,
        line: redactImageUpstream(line).slice(0, 1024),
      })
    }
    if (result.deniedLines > 0) {
      log.warn('codex relay path denied', {
        sessionKey: this.opts.sessionKey,
        count: result.consecutiveDenied,
      })
    }
    if (result.activityLines > 0) this.lastActivityAt = Date.now()
    if (result.abortWebsocketDirect) this.abortTurnForChatgptWebsocketDirect()
    else if (result.abort) this.abortTurnForRelayPathDenied()
  }

  /** @internal */
  feedStderrForTests(chunk: string): void {
    this.handleStderrChunk(this.proc, chunk, true)
  }

  private abortTurnForRelayPathDenied(): void {
    const err = new Error('CODEX_RELAY_PATH_DENIED: MCP/relay path not allowed; aborting turn')
    err.name = 'CodexRelayPathDeniedError'
    if (this.currentTurnCompleter) {
      this.currentTurnCompleter.reject(err)
      this.currentTurnCompleter = null
    }
    void this.shutdown()
  }

  private abortTurnForChatgptWebsocketDirect(): void {
    if (this.recycleInflight) return
    const err = new Error(
      'CODEX_CHATGPT_WS_DIRECT: Codex Responses websocket bypassed loopback relay (wss://chatgpt.com); aborting turn',
    )
    err.name = 'CodexChatgptWebsocketDirectError'
    if (this.currentTurnCompleter) {
      const completer = this.currentTurnCompleter
      this.currentTurnCompleter = null
      try {
        completer.reject(err)
      } catch {
        /* already settled */
      }
    }
    this.staleProcGeneration = true
    void this.recycleProcKeepQueue('chatgpt-ws-direct')
  }

  private _isZeroBreakdown(b: CodexTokenBreakdown): boolean {
    return (
      b.totalTokens === 0 &&
      b.inputTokens === 0 &&
      b.outputTokens === 0 &&
      b.cachedInputTokens === 0 &&
      b.reasoningOutputTokens === 0
    )
  }

  private resetCallUsageAttribution(): void {
    this.callUsageEpoch = 0
    this.itemCallUsageEpoch.clear()
    this.callUsageByEpoch.clear()
  }

  /** consumeActiveTurnUsage 口径下,本 attempt 是否零 usage —— **不 consume**
   *  (不 promote priorTurnTotal),仅 peek,供重试门判定。 */
  private activeAttemptUsageIsZero(): boolean {
    if (this.activeTurnTotal === null) return true
    const delta = _subtractTokenBreakdown(
      this.activeTurnTotal,
      this.priorTurnTotal ?? _EMPTY_TOKEN_BREAKDOWN,
    )
    return this._isZeroBreakdown(delta)
  }

  /** 退避基础延迟(index = 失败的 attempt 序号 − 1)+ 0..RETRY_JITTER_MS 抖动。
   *  抽成方法便于测试 override(与既有 ensureSpawned/sendRequest override 同模式)。 */
  private computeRetryDelayMs(failedAttempt: number): number {
    const base =
      RETRY_BACKOFFS_MS[failedAttempt - 1] ?? RETRY_BACKOFFS_MS[RETRY_BACKOFFS_MS.length - 1]
    return base + Math.floor(Math.random() * (RETRY_JITTER_MS + 1))
  }

  /** 可中断退避 sleep。resolve(true)=被 interrupt() abort;resolve(false)=正常睡满。 */
  private abortableDelay(ms: number, signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (signal.aborted) {
        resolve(true)
        return
      }
      const onAbort = () => {
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve(false)
      }, ms)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** turn/start 窄路径自动重试门。**全部**满足才允许重试(fail-closed):
   *   1. 共享自动重试额度尚未用尽;
   *   2. err 是明确的 JSON-RPC application error(有 rpcCode/rpcMessage 且
   *      rpcMethod==='turn/start');transport 断连/进程 exit/超时形状(裸 Error,
   *      无 rpcCode)一律不算;
   *   3. app-server 子进程仍存活;
   *   4. 未获得/未 adopt 任何 turnId(activeTurnId 为 null)且 completer 未被任何
   *      提前到达的 turn 通知 settle(currentTurnCompleter 非空)——任一破坏 = 结局
   *      未知,不重试;
   *   5. classifyRunError(rpcMessage) 命中 retryable 语义(turnErrorSemantics);
   *   6. 本 attempt 两台账 flag 均 false、usage 为零、未 emit 过终态帧;
   *   7. pendingUserInputs 为空(非空 = 违反门,放弃重试走终态,不静默清)。 */
  private shouldRetryTurnStart(err: unknown, retryState: AutomaticRetryState): boolean {
    if (retryState.attempt >= retryState.max) return false
    const e = err as Partial<JsonRpcCallError> | null | undefined
    if (
      !e ||
      typeof e.rpcCode !== 'number' ||
      typeof e.rpcMessage !== 'string' ||
      e.rpcMethod !== 'turn/start'
    ) {
      return false
    }
    if (!this.proc || this.proc.killed) return false
    if (this.activeTurnId !== null) return false
    if (this.currentTurnCompleter === null) return false
    if (!turnErrorSemantics(classifyRunError(e.rpcMessage).code).retryable) return false
    if (this.attemptHadObservableOutput || this.attemptHadToolOrPermission) return false
    if (this.attemptEmittedTerminal) return false
    if (!this.activeAttemptUsageIsZero()) return false
    if (this.pendingUserInputs.size > 0) return false
    return true
  }

  private async runTurn(
    prompt: string,
    requestId?: string,
    collabAgentPolicy?: CollabAgentPolicy,
    automaticRetryState?: AutomaticRetryState,
    traceId?: string | null,
    readOnly = false,
  ): Promise<void> {
    const turnTraceId = traceId === null ? undefined : traceId ?? this.opts.traceId
    const startedAt = Date.now()
    const timingStartedAt = performance.now()
    // Join speculative preparation; a failed warmup falls back to normal preparation.
    if (this._preheatPromise) await this._preheatPromise.catch(() => {})
    this.advisorReadOnly = readOnly
    const seenDeltas = new Set<string>()
    const observeFirstDelta = (message: any): void => {
      const delta = message?.event?.delta
      const stage = delta?.type === 'text_delta' && delta.text?.length ? 'first_text_delta'
        : delta?.type === 'thinking_delta' && delta.thinking?.length ? 'first_reasoning_delta' : null
      if (!stage || seenDeltas.has(stage) || message.session_id !== this.threadId) return
      seenDeltas.add(stage)
      log.info('codex_turn_timing', { traceId: turnTraceId, threadId: this.threadId,
        stage, elapsedMs: performance.now() - timingStartedAt })
    }
    this.on('message', observeFirstDelta)
    this.activeRequestId = requestId
    this.forcedShutdownResultEmitted = false
    // Serial runner invariant: no reverse request from the previous turn may
    // be carried into this one. Normally turn/completed already performed the
    // same cleanup; this is a defensive boundary for unusual protocol order.
    this.settleAllPendingUserInputs('next turn started')
    // Phase 5:turn 顶部一次性取 snapshot,贯穿 ensureSpawned / thread/start /
    // thread/resume / launch overrides 四个消费点。任何中途读 snapshot 的写法
    // 都会出现撕裂窗口(spawn cwd 用了 ready,attach cwd 拿到 cloning 之类)。
    const repoSnap = this._currentRepoSnapshot()
    let effectiveCwd = this._applyRepoBindingFromSnapshot(repoSnap)
    log.info('codex app-server turn start', {
      traceId: turnTraceId,
      sessionKey: this.opts.sessionKey,
      resumed: this.threadId != null,
      pid: this.proc?.pid ?? null,
      reusedProc: Boolean(this.proc && this.initialized && !this.staleProcGeneration),
      promptChars: prompt.length,
      effectiveCwd,
      repoBound: this._boundRepoBinding != null,
    })
    // Per-attempt 态(currentAssistantBuf / currentPlanDraft / reasoningItemState /
    // emittedToolUseIds / collab maps / activeTurnTotal / currentTurnUsage / 三个
    // 台账 flag)的复位统一交给 resetAttemptState(在每个 attempt 起点调用)。
    // priorTurnTotal 跨 turn 保留(累计基线),不在此清。这里只做 turn 级一次性准备。
    this.currentCollabAgentPolicy = collabAgentPolicy

    const retryState = automaticRetryState ?? {
      rootClientMessageId: `local-${this.opts.sessionKey}`,
      attempt: 0,
      max: AUTOMATIC_TURN_RETRY_MAX,
    }
    try {
      if (
        this.proc &&
        !this.proc.killed &&
        ((this.spawnedAdvisorReadOnly !== null && this.spawnedAdvisorReadOnly !== readOnly) ||
          (this.spawnedProviderSignature !== null &&
          this.spawnedProviderSignature !== this.codexRouteSignature()) ||
          (this._preheatedSignature !== null &&
            this._preheatedSignature !== this.preheatSignature(repoSnap, effectiveCwd)))
      ) {
        // Route changes require a fresh Codex app-server process because
        // provider/base_url are launch-time CLI args. Do not let this restart
        // reject already-queued turns for the same session; only the current
        // runner process is being replaced.
        const queuedTurns = this.queue
        this.queue = []
        try {
          await this.shutdown()
          effectiveCwd = this._applyRepoBindingFromSnapshot(repoSnap)
        } finally {
          if (queuedTurns.length > 0) {
            this.queue = queuedTurns.concat(this.queue)
          }
        }
      }
      // A route-change shutdown above clears active turn state; restore this
      // queued turn's policy before the actual turn/start notifications arrive.
      this.currentCollabAgentPolicy = collabAgentPolicy
      if (this.pendingConsultRespawn) {
        this.pendingConsultRespawn = false
        await this.shutdown()
        this.shuttingDown = false
      }
      const reusedProcess = Boolean(this.proc && this.initialized && !this.staleProcGeneration)
      await this.ensureSpawned(repoSnap, effectiveCwd)
      log.info('codex_turn_timing', { traceId: turnTraceId, threadId: this.threadId,
        stage: 'engine_ready', reusedProcess, elapsedMs: performance.now() - timingStartedAt })
      const threadStartedAt = performance.now()
      this.refreshDelegateContext(turnTraceId)

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
              ...(this.cachedOverrides?.instructionsContent !== undefined ? { baseInstructions: this.cachedOverrides.instructionsContent } : {}),
              threadId: this.threadId,
              ...buildCodexThreadPolicyParams(effectiveCwd, this.opts.model,
                this.advisorReadOnly, this.advisorReadOnlyConfig),
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
            const staleThreadId = this.threadId
            const fallback = staleThreadId
              ? this.opts.resolveResumeFallback?.(staleThreadId)
              : undefined
            if (fallback && fallback !== staleThreadId) {
              log.warn('codex thread/resume missing rollout — resuming prior durable thread', {
                sessionKey: this.opts.sessionKey,
                staleThreadId,
                fallbackThreadId: fallback,
              })
              // Switching native thread: thread-scoped token ledger must be
              // re-seeded from the fallback thread's own history (same reset
              // _startNewThread does), otherwise the first usage frame is
              // diffed against the dead thread's cumulative total (B1).
              this.threadId = fallback
              this.priorTurnTotal = null
              this.activeTurnTotal = null
              this.currentTurnUsage = null
              this.resetCallUsageAttribution()
              this.syncedPlatformGoalSignature = null
              this.syncedPlatformGoal = null
              try {
                await this.sendRequest('thread/resume', {
              ...(this.cachedOverrides?.instructionsContent !== undefined ? { baseInstructions: this.cachedOverrides.instructionsContent } : {}),
                  threadId: fallback,
                  ...buildCodexThreadPolicyParams(effectiveCwd, this.opts.model,
                    this.advisorReadOnly, this.advisorReadOnlyConfig),
                })
                this.emit('session_id', fallback)
                this.attached = true
              } catch (err2) {
                if (!isMissingRolloutError(err2)) throw err2
                log.warn('codex fallback thread also missing rollout — restarting fresh', {
                  sessionKey: this.opts.sessionKey,
                  fallbackThreadId: fallback,
                })
                this.threadId = null
                await this._startNewThread(effectiveCwd)
              }
            } else {
              log.warn('codex thread/resume missing rollout — restarting fresh', {
                sessionKey: this.opts.sessionKey,
                staleThreadId,
                rpcMessage: (err as JsonRpcCallError).rpcMessage,
              })
              this.threadId = null
              await this._startNewThread(effectiveCwd)
            }
          }
        }
        this.attached = true
      }

      const preheatedThreadClaimed = Boolean(this._unannouncedPreheatThread && this.threadId)
      if (this._unannouncedPreheatThread && this.threadId) {
        this._unannouncedPreheatThread = false
        this.emit('session_id', this.threadId)
      }
      this._preheatedSignature = null
      log.info('codex_turn_timing', { traceId: turnTraceId, threadId: this.threadId,
        stage: 'thread_ready', preheatedThreadClaimed, durationMs: performance.now() - threadStartedAt, elapsedMs: performance.now() - timingStartedAt })
      await this.syncPlatformGoal()

      this.nativeContext.beginTurn()
      // ── attempt 循环 ──────────────────────────────────────────────────
      // 仅「turn/start 请求本身被拒」的窄路径可循环重试(shouldRetryTurnStart 门)。
      // 一旦 turn/start 成功返回 turn.id,turn 进入执行,后续任何失败(status=
      // 'failed'/interrupted/异常)都**不**在此循环内重试 —— 直接 return 或抛给外
      // 层 catch 走终态(实测②:turn 一旦开始,user input 已落 thread,重发会重复)。
      for (;;) {
        // 每个 attempt 起点集中复位 per-attempt 态(见 resetAttemptState)。
        this.resetAttemptState()
        if (!this.pendingStartInterrupt) {
          await this.nativeContext.compactIfNeeded({
            threadId: this.threadId, traceId: turnTraceId,
            timeoutMs: NATIVE_COMPACTION_TIMEOUT_MS,
            send: () => this.sendRequest('thread/compact/start', { threadId: this.threadId }),
            drainFailure: async () => {
              const drained = this.outputDrainPromise
              if (!this.shuttingDown) await this.recycleProcKeepQueue('native-context-compaction-failed')
              await drained
            },
          })
        }

        // Set up the completion box BEFORE turn/start so a fast turn/completed
        // notification (rare but possible) doesn't slip past us.
        const completed = new Promise<{
          status?: string
          durationMs?: number
          error?: { message?: string; codexErrorInfo?: unknown }
        }>((resolve, reject) => {
          this.currentTurnCompleter = { resolve, reject }
        })

        if (this.pendingStartInterrupt) {
          // OCV5-435: stopped before turn/start — never start it.
          this.pendingStartInterrupt = false
          this.currentTurnCompleter = null
          void completed.catch(() => {})
          this.emitResult({
            durationMs: Date.now() - startedAt,
            ok: false,
            error: 'codex turn interrupted',
            requestId,
            rateLimits: this._consumeRateLimitsForEmit(),
            stopReason: 'interrupted',
            terminalCode: 'USER_CANCELLED',
          })
          return
        }

        let tres: { turn?: { id?: string } } | undefined
        try {
          log.info('codex_turn_timing', { traceId: turnTraceId, threadId: this.threadId,
            stage: 'turn_start_sent', elapsedMs: performance.now() - timingStartedAt })
          tres = (await withCodexTurnTrace(this.threadId, turnTraceId, () =>
            this.sendRequest('turn/start', this.buildTurnStartParams(prompt)))) as
            | { turn?: { id?: string } }
            | undefined
        } catch (startErr) {
          if (this.shouldRetryTurnStart(startErr, retryState)) {
            // 本 attempt 的 completed promise 就此放弃(无人 await)。必须立即
            // 解除 completer 并挂 no-op catch:否则退避期间 close-only 路径
            // (close → failAllPending)会 reject 一个无人接的 Promise →
            // unhandled rejection(gateway 无全局守卫,Node 默认可升级为进程
            // 退出,codex 子进程崩溃就此放大成整个 gateway 退出)。
            this.currentTurnCompleter = null
            void completed.catch(() => {})
            const nextAttempt = retryState.attempt + 1
            retryState.attempt = nextAttempt
            const delayMs = this.computeRetryDelayMs(nextAttempt)
            const cls = classifyRunError((startErr as JsonRpcCallError).rpcMessage).code
            log.warn('codex turn/start rejected — auto-retrying (narrow path)', {
              sessionKey: this.opts.sessionKey,
              attempt: nextAttempt,
              nextAttempt,
              delayMs,
              errorClass: cls,
              rpcCode: (startErr as JsonRpcCallError).rpcCode,
            })
            // 排定重试:进入退避前发 retrying 侧信道帧;所有退出路径(成功进入下一
            // attempt / interrupt / 异常)经 finally 保证清 status:null,且在 turn/start
            // 重发**前**清(不等 final)。
            this.emitRetryingStatus({
              attempt: nextAttempt,
              max: retryState.max,
              delayMs,
              retryAt: Date.now() + delayMs,
            })
            const controller = new AbortController()
            this.pendingRetryAbort = controller
            // 审计 R8:每个退避窗口起点复位 proc-gone 标记(仅本窗口内 close/error 置位)。
            this.retryBackoffProcGone = false
            let interruptedDuringBackoff = false
            try {
              interruptedDuringBackoff = await this.abortableDelay(delayMs, controller.signal)
            } finally {
              this.pendingRetryAbort = null
              this.emitTurnStatus(null)
            }
            // proc 在退避期间消失(crash close 置 proc=null / error 唤醒置
            // retryBackoffProcGone / shutdown kill)→ 绝不把 turn/start 重发进死管道
            // (writeRaw 静默失败、pending 无人 settle → runTurn 挂死)。转外层 catch
            // 走终态(parser finalized 会与可能的 forced result 去重)。必须先于
            // interrupt 判定:shutdown abort 与 proc-gone 唤醒的退避都走这里,不误报成
            // USER_CANCELLED。审计 R8:retryBackoffProcGone 捕获 error 早于 close(proc
            // 尚未置 null)的窗口,让其也判为 crashed 而非用户取消。
            if (!this.proc || this.proc.killed || this.shuttingDown || this.retryBackoffProcGone) {
              throw new Error('codex app-server gone during retry backoff')
            }
            if (interruptedDuringBackoff) {
              // 用户在退避窗口内 interrupt():终止后继 attempt,走 USER_CANCELLED 终态
              // (载荷对齐既有 interrupted 分支)。此路径无 turn 执行 → 无 partial usage。
              this.activeTurnId = null
              this.currentTurnCompleter = null
              const cancelUsage = this.consumeActiveTurnUsage()
              this.emitResult({
                durationMs: Date.now() - startedAt,
                ok: false,
                error: 'codex turn interrupted',
                usage: cancelUsage ? _codexUsageToAnthropicShape(cancelUsage) : undefined,
                requestId,
                rateLimits: this._consumeRateLimitsForEmit(),
                stopReason: 'interrupted',
                terminalCode: 'USER_CANCELLED',
              })
              return
            }
            continue
          }
          // 不满足重试门 → 抛给外层 catch 走终态(fail closed)。
          throw startErr
        }

        log.info('codex_turn_timing', { traceId: turnTraceId, threadId: this.threadId,
          stage: 'turn_start_accepted', elapsedMs: performance.now() - timingStartedAt })
        const turnId = tres?.turn?.id
        if (typeof turnId !== 'string' || !turnId) {
          throw new Error('turn/start did not return turn.id')
        }
        this.activeTurnId = turnId
        if (this.pendingStartInterrupt) {
          // OCV5-435: stopped while turn/start was in flight — interrupt now.
          this.pendingStartInterrupt = false
          this.interrupt()
        }

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
        const turnUsage = this.consumeActiveTurnUsage()
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
            // LOW-2:codex 'completed' = 正常终态 → Anthropic 口径 'end_turn'。
            stopReason: 'end_turn',
          })
        } else if (status === 'failed') {
          const errMsg = turn?.error?.message ?? 'codex turn failed'
          const codexErrorInfo = turn?.error?.codexErrorInfo
          // turn-retry 批:**不再注入裸文本** `[turn failed: ...]` text_delta —— 错误
          // 只走结构化 errorClass + result 帧,不污染 assistant 正文(codexAdapter 的
          // errorKind 分类改由 result.result → lastErrorText 承载)。
          // **status='failed' 一律不自动重发 turn/start**(实测②:input 已落 thread,
          // rollout response_item 在 API 调用前落盘且不回滚,持久化视图里失败 turn 记为
          // completed/error:null 无法事后区分;重发 = 重复 user input)。thread/rollback
          // 事后回滚方案登记为债(见 playbook turn-retry 批)。
          const errorClass = this.classifyErrorClass(errMsg)
          log.error('codex app-server turn failed status', {
            sessionKey: this.opts.sessionKey,
            errMsg,
            ...(errorClass ? { errorClass } : {}),
            // codexErrorInfo(turn.error 的附加字段,实测值 "other")仅进内部日志,
            // 不进用户面。
            ...(codexErrorInfo !== undefined ? { codexErrorInfo } : {}),
          })
          this.emitResult({
            durationMs,
            ok: false,
            error: errMsg,
            usage: usagePayload,
            requestId,
            rateLimits: rateLimitsPayload,
            ...(errorClass ? { errorClass } : {}),
          })
        } else if (status === 'interrupted') {
          // Reap the app-server BEFORE publishing USER_CANCELLED so a follow-up
          // submit cannot inherit this proc's SIGTERM as SERVICE_RESTART.
          this.activeTurnId = null
          this.currentTurnCompleter = null
          await this.recycleProcKeepQueue('user-cancelled')
          this.emitResult({
            durationMs,
            ok: false,
            error: 'codex turn interrupted',
            usage: usagePayload,
            requestId,
            rateLimits: rateLimitsPayload,
            stopReason: 'interrupted',
            terminalCode: 'USER_CANCELLED',
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
        // turn 已终态(completed/failed/interrupted/unexpected)→ 退出 attempt 循环。
        return
      }
    } catch (err) {
      if (this.recycleInflight) await this.recycleInflight
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
      const failedTurnUsage = this.consumeActiveTurnUsage()
      this.settleAllPendingUserInputs('turn failed')
      this.activeTurnId = null
      this.currentTurnCompleter = null
      const durationMs = Date.now() - startedAt
      if (this.pendingStartInterrupt) {
        // OCV5-442: the user stopped this turn before it had an id, and it then
        // failed before starting — typically the gateway's shutdown escalation
        // after the Stop grace while the app-server was still initializing. The
        // outcome is the user's Stop, as in the "stopped before turn/start" branch.
        this.pendingStartInterrupt = false
        log.info('codex turn stopped before start', {
          sessionKey: this.opts.sessionKey,
          err: (err as Error).message,
        })
        this.emitResult({
          durationMs,
          ok: false,
          error: 'codex turn interrupted',
          usage: failedTurnUsage ? _codexUsageToAnthropicShape(failedTurnUsage) : undefined,
          requestId,
          rateLimits: this._consumeRateLimitsForEmit(),
          stopReason: 'interrupted',
          terminalCode: 'USER_CANCELLED',
        })
        return
      }
      // turn-retry 批:catch 路径也结构化分类(非 unknown 才带 errorClass)。此路径
      // 覆盖 turn/start 拒绝但**不满足重试门**、attach/spawn 失败、mid-turn 异常等。
      const errMsg = `codex app-server: ${(err as Error).message}`
      const errorClass = this.classifyErrorClass(errMsg)
      log.error('codex app-server turn failed', {
        sessionKey: this.opts.sessionKey,
        err: (err as Error).message,
        ...(errorClass ? { errorClass } : {}),
      })
      this.emitResult({
        durationMs,
        ok: false,
        error: errMsg,
        usage: failedTurnUsage ? _codexUsageToAnthropicShape(failedTurnUsage) : undefined,
        requestId,
        // Issue A v1.0.108 — catch 路径也走 dedup helper(notification 与 turn 异常
        // 不耦合,init 阶段可能已经收到过快照,但若上一 turn 已发同值就别再发)。
        rateLimits: this._consumeRateLimitsForEmit(),
        ...(errorClass ? { errorClass } : {}),
      })
      // Do NOT re-throw — drain() catches and rejects the queue entry, but
      // upstream sessionManager handles errors via the result message above.
    } finally {
      this.off('message', observeFirstDelta)
      this.currentCollabAgentPolicy = undefined
      this.activeRequestId = undefined
      this.pendingStartInterrupt = false
    }
  }

  private emitAssistantToolUse(id: string, name: string, input: unknown): void {
    emitAssistantToolUseImpl.call(this as unknown as CodexNotificationHost, id, name, input)
  }

  private bindItemCallUsageEpochFromItem(item: unknown): void {
    bindItemCallUsageEpochFromItemImpl.call(this as unknown as CodexNotificationHost, item)
  }

  private bindItemCallUsageEpoch(itemId: string): number {
    return bindItemCallUsageEpochImpl.call(this as unknown as CodexNotificationHost, itemId)
  }

  private callUsageRecord(epoch: number): {
    callId: string
    targetIds: Set<string>
    usage?: TurnTokenUsageSnapshot
  } {
    return callUsageRecordImpl.call(this as unknown as CodexNotificationHost, epoch)
  }

  private emitCallUsageEpoch(epoch: number): void {
    emitCallUsageEpochImpl.call(this as unknown as CodexNotificationHost, epoch)
  }

  private recordCallUsageTarget(itemId: string): void {
    recordCallUsageTargetImpl.call(this as unknown as CodexNotificationHost, itemId)
  }

  private recordCallUsageSnapshot(last: CodexTokenBreakdown, duplicateTotal: boolean): void {
    recordCallUsageSnapshotImpl.call(this as unknown as CodexNotificationHost, last, duplicateTotal)
  }

  private sameTokenBreakdown(a: CodexTokenBreakdown, b: CodexTokenBreakdown): boolean {
    return sameTokenBreakdownImpl.call(this as unknown as CodexNotificationHost, a, b)
  }

  /** V5 CG(2026-07-10)— tool_use/tool_result 成对不变量的唯一守卫点(见
   *  {@link emittedToolUseIds} 注释)。`orphanPairing` 由「本会兜底出孤儿 result」
   *  的调用点(handleItemCompleted 通用兜底)传入,给补发的 tool_use 一个像样的
   *  `codex:<type>` 名字与原始 item 载荷;不传时退化为 `codex:unknown`/`{}`,仍
   *  保证成对(防御任何未预料的孤儿路径,总比裸 result 体面)。 */
  private emitToolResult(toolUseId: string, content: string, isError: boolean, orphanPairing?: { name: string; input: unknown }, engineMeta?: { exitCode?: number; terminationReason?: ToolTerminationReason }): void {
    emitToolResultImpl.call(this as unknown as CodexNotificationHost, toolUseId, content, isError, orphanPairing, engineMeta)
  }

  private emitTurnStatus(status: 'compacting' | 'waiting_for_user' | null): void {
    emitTurnStatusImpl.call(this as unknown as CodexNotificationHost, status)
  }

  /** turn-retry 批 — 发射 fake-SDK `retrying` 状态帧(与 compacting 同 stdout 形状,
   *  ccbMessageParser 的 subtype:'status' 分支消费 retry 载荷并映射成 gateway
   *  turn_status.retrying)。**本帧自身不置台账 flag**(侧信道,不算 turn 输出)。
   *  清除走 emitTurnStatus(null)。 */
  private emitRetryingStatus(retry: TurnRetryMeta): void {
    emitRetryingStatusImpl.call(this as unknown as CodexNotificationHost, retry)
  }

  /** Issue A v1.0.108 round-2 — 决定本次 emitResult 是否带 rateLimits。
   *  规则:latestRateLimits 为 null → 没快照,返 undefined。
   *  否则与 lastEmittedRateLimitsJson 比较:
   *   - 不同(包括首次)→ 带,且更新 lastEmittedRateLimitsJson 记忆
   *   - 相同 → 不带(避免下游 quota_updated_at 假刷新)
   *  JSON 序列化对比要求 _parseCodexRateLimits 输出 key 顺序稳定 — 当前实现按
   *  primary→secondary、字段按写入顺序固定,序列化稳定。 */
  private _consumeRateLimitsForEmit(): RuntimeRateLimits | undefined {
    return _consumeRateLimitsForEmitImpl.call(this as unknown as CodexNotificationHost)
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
      total_tokens?: number
    }
    /** PR2 v1.0.66 — caller(runTurn)从 closure 拿;不读 instance 字段防 race。 */
    requestId?: string
    /** Issue A v1.0.108 — runTurn 在 emitResult 现场从 instance 字段拿最新已知
     *  rateLimits 快照传进来。null/undefined → 不带本字段。 */
    rateLimits?: RuntimeRateLimits
    /** LOW-2(2026-07-03)— caller 按 turn status 映射(见 RunnerMessage.stop_reason
     *  注释);不传 → result 行不带 stop_reason(failed / 异常路径)。 */
    stopReason?: string
    terminalCode?: 'USER_CANCELLED' | 'CODEX_ERROR'
    /** turn-retry 批 — 非 'unknown' 的结构化错误码(classifyRunError 产物)。 */
    errorClass?: ClassifiedErrorCode
  }): void {
    emitResultImpl.call(this as unknown as CodexNotificationHost, opts)
  }

  /** turn-retry 批 — error 文本结构化分类;'unknown' 归 undefined(不带 errorClass,
   *  caller 走既有裸 error 展示,UX 不变)。 */
  private classifyErrorClass(errStr: string | undefined): ClassifiedErrorCode | undefined {
    const code = classifyRunError(errStr).code
    return code === 'unknown' ? undefined : code
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

// Re-export internal helpers for the test harness — the test patches
// `_classifyJsonRpcLine` to feed synthetic JSON-RPC frames.
export { _sanitizeThreadId, stripShellWrapper }
