import {
  readLatestCodexNativeHandoff,
  abortableDelay,
  normalisePrompt,
  isInlinePushProcLive,
  writeCodexDelegateTerminalNotification,
  handleCodexChatgptAuthTokensRefresh,
} from './codexLifecycle.js'
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
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type GoalStateSnapshot,
  type ServiceTier,
  type ToolTerminationReason,
  type TurnTokenUsageSnapshot,
  normalizeServiceTierForModel,
} from '@openclaude/protocol'
import { type OpenClaudeConfig } from '@openclaude/storage'
import { type CodexLaunchOverrides, shouldOmitPlatformMcp } from '../codexLaunchOverrides.js'
import type { RepoSnapshot } from '../sessionRepoWorkspace.js'
import {
  _sanitizeThreadId,
  buildCodexEnv,
  type CodexProviderConfigOverride,
} from './codexShared.js'
import { V3_CODEX_RELAY_PREFIX } from '../v3CodexRelay.js'
import { CodexRelayPathDeniedTracker } from './codexRelayPathGuard.js'
import { writeCodexDelegateContext } from './codexDelegateContext.js'
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
  type CodexTokenBreakdown,
  _EMPTY_TOKEN_BREAKDOWN,
  _subtractTokenBreakdown,
  type RuntimeRateLimits,
  type PendingCodexUserInput,
  stripShellWrapper,
} from './codexAppServerProtocol.js'
import {
  type CodexRpcTransportHost,
  platformGoalSignature as platformGoalSignatureImpl,
  syncPlatformGoal as syncPlatformGoalImpl,
  sendPermissionResponse as sendPermissionResponseImpl,
  settlePendingUserInputsForTurn as settlePendingUserInputsForTurnImpl,
  takePendingUserInput as takePendingUserInputImpl,
  compactCurrentThreadForHandoff as compactCurrentThreadForHandoffImpl,
  ensureLaunchOverrides as ensureLaunchOverridesImpl,
  cleanupLaunchOverrides as cleanupLaunchOverridesImpl,
  cleanupHermeticDir as cleanupHermeticDirImpl,
  shutdown as shutdownImpl,
  ensureSpawnedInternal as ensureSpawnedInternalImpl,
  ensureSpawnedRemote as ensureSpawnedRemoteImpl,
  failAllPending as failAllPendingImpl,
  writeRaw as writeRawImpl,
  sendRequest as sendRequestImpl,
  buildCompactResumeParams,
} from './codexRpcTransport.js'
import {
  type CodexTurnExecutionHost,
  emitForcedShutdownResult as emitForcedShutdownResultImpl,
  consumeActiveTurnUsage as consumeActiveTurnUsageImpl,
  buildTurnStartParams as buildTurnStartParamsImpl,
  startNewThread as startNewThreadImpl,
  resetAttemptState as resetAttemptStateImpl,
  verifyTurnServiceTier as verifyTurnServiceTierImpl,
  shouldRetryTurnStart as shouldRetryTurnStartImpl,
  runTurn as runTurnImpl,
} from './codexTurnExecution.js'
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

// ── turn/start 窄路径自动重试(turn-retry 批,2026-07-18)──────────────────
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
  /** Remote lane: the process boundary is the master relay, never a local `codex` child. */
  remote?: CodexRemoteKernelRuntime
}

/**
 * The only thing a remote lane replaces: where bytes come from and go to. Thread/turn/item
 * parsing, usage accounting and terminal semantics stay in this runner.
 */
export interface CodexRemoteKernelRuntime {
  readonly child: ChildProcessWithoutNullStreams
  /** This turn's admission (tool catalog + master admit) — nothing may cross the lane before it. */
  ready(): Promise<void>
  /** Platform instructions for the native thread (the container tool-naming notice is appended). */
  instructions(platformPrompt: string): string
  /** Stop the lane after the container has proven its local tool host stopped. */
  stop(): Promise<void>
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
  serviceTier?: ServiceTier | null
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
  private initializedPayload: unknown = undefined
  private resetInitializedState(): void { this.initialized = false; this.initializedPayload = undefined }
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
  /** Native thread instructions for a remote lane (already carrying the tool-naming notice). */
  private remoteInstructions: string | null = null

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
  private _serviceTier: ServiceTier | null = null
  get serviceTier(): ServiceTier | null {
    return this._serviceTier
  }
  /** OCV5-798: serviceTier is sent per turn via turn/start `serviceTierForTurn`; never restarts proc. */
  setServiceTier(tier: ServiceTier | null, model: string | undefined): 'unchanged' {
    this._serviceTier = normalizeServiceTierForModel(model ?? this.opts.model, tier)
    return 'unchanged'
  }

  setModel(model: string | undefined): void {
    if (this.opts.model !== model) this.nativeContext.reset()
    this.opts.model = model
    this._serviceTier = normalizeServiceTierForModel(model, this._serviceTier)
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
    return platformGoalSignatureImpl.call(this as unknown as CodexRpcTransportHost)
  }

  private syncPlatformGoal(): Promise<void> {
    return syncPlatformGoalImpl.call(this as unknown as CodexRpcTransportHost)
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
    return sendPermissionResponseImpl.call(this as unknown as CodexRpcTransportHost, requestId, responseUnk)
  }

  private takePendingUserInput(requestId: string): PendingCodexUserInput | null {
    return takePendingUserInputImpl.call(this as unknown as CodexRpcTransportHost, requestId)
  }

  private settlePendingUserInputsForTurn(turnId: string, reason: string): number {
    return settlePendingUserInputsForTurnImpl.call(this as unknown as CodexRpcTransportHost, turnId, reason)
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
    // A remote thread's rollout lives on the node; there is no local artifact to export.
    if (this.opts.remote) throw new Error('CODEX_REMOTE_COMPACTION_UNSUPPORTED')
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
          await this.sendRequest(
            'thread/resume',
            buildCompactResumeParams(sourceThread, cwd, this.opts.model, this.cachedOverrides?.instructionsContent),
          )
          assertCurrent()
          this.attached = true
        }
        assertCurrent()
        return this.compactCurrentThreadForHandoff()
      }, { assertCurrent, beforeOwnedShutdown: () => { assertCurrent(); expectedGeneration++ } })
    } finally { this.compactPrivacyPreparing = false }
  }
  private compactCurrentThreadForHandoff(): Promise<NativeModelHandoffArtifact> {
    return compactCurrentThreadForHandoffImpl.call(this as unknown as CodexRpcTransportHost)
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
      this.pendingRetryAbort.abort('user-stop')
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
      this.pendingRetryAbort.abort('proc-gone')
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
  private ensureLaunchOverrides(repoSnap: RepoSnapshot | null): Promise<CodexLaunchOverrides | null> {
    return ensureLaunchOverridesImpl.call(this as unknown as CodexRpcTransportHost, repoSnap)
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

  private cleanupLaunchOverrides(): void {
    cleanupLaunchOverridesImpl.call(this as unknown as CodexRpcTransportHost)
  }

  private cleanupHermeticDir(): void {
    cleanupHermeticDirImpl.call(this as unknown as CodexRpcTransportHost)
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
    serviceTier: ServiceTier | null = null,
  ): Promise<void> {
    const turnTraceId = traceId === null ? undefined : traceId ?? this.opts.traceId
    this.lastActivityAt = Date.now()
    if (!this.spawnEmitted) {
      this.spawnEmitted = true
      this.emit('spawn', { resumed: this.threadId != null })
    }
    const prompt = normalisePrompt(textOrBlocks)
    assertPromptQueueRunnerAdmission(queueTurn, this.processing, this.queue.length)
    const turnTier = readOnly ? null : normalizeServiceTierForModel(this.opts.model, serviceTier)
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
        serviceTier: turnTier,
      })
      void this.drain()
    })
  }

  shutdown(opts?: { keepQueuedTurns?: boolean }): Promise<void> {
    return shutdownImpl.call(this as unknown as CodexRpcTransportHost, opts)
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
        turn.serviceTier ?? null,
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

  private getSpawnFn(): typeof spawn {
    return _spawnFn
  }

  private getHostProcessEnv(): NodeJS.ProcessEnv {
    return process.env
  }

  private buildCodexSpawnEnv(): NodeJS.ProcessEnv {
    return {
      ...buildCodexEnv(),
      ...identityCompatEnvironment(this.opts.identityCompat),
      OPENCLAUDE_AGENT_ID: this.opts.agentId,
      ..._codexMemoryTurnEnv(this.opts.agentId, this.opts.sessionKey, {
        gatewayPort: this.opts.config?.gateway.port,
        contextFile: this.cachedOverrides?.delegateContextFile,
        systemHelpContextFile: this.opts.systemHelpContextFile,
      }),
    }
  }

  private resolveChatgptRelayBaseUrl(): string | undefined {
    const relayPort = this.opts.config?.gateway?.port
    return typeof relayPort === 'number' && relayPort > 0
      ? `http://127.0.0.1:${relayPort}${V3_CODEX_RELAY_PREFIX}/backend-api/codex`
      : undefined
  }

  private onTransportProcessClose(
    proc: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
    remote: boolean,
  ): void {
    if (this.proc !== proc) {
      if (!remote) {
        log.info('codex app-server stale proc close ignored', {
          sessionKey: this.opts.sessionKey,
          code,
          signal,
        })
      }
      return
    }
    log.info(remote ? 'codex remote lane close' : 'codex app-server proc close', {
      sessionKey: this.opts.sessionKey,
      code,
      signal,
    })
    if (this.stdoutBuf.length > 0) {
      const trailing = this.stdoutBuf.trim()
      this.stdoutBuf = ''
      if (trailing) this.handleLine(trailing)
    }
    this.resolveOutputDrain?.()
    this.resolveOutputDrain = null
    if (!remote) this.handleStderrChunk(proc, '\n', true)
    const wasShutdown = this.shuttingDown
    const closeReason = remote
      ? `codex remote lane closed code=${code} signal=${signal ?? ''}`
      : `codex app-server exited code=${code} signal=${signal ?? ''}`
    if (wasShutdown) this.emitForcedShutdownResult(closeReason)
    this.failAllPending(closeReason)
    this.wakeRetryBackoffOnProcGone()
    this.proc = null
    this.spawnedProviderSignature = null
    this.resetInitializedState()
    this.attached = false
    if (!remote) {
      this.syncedPlatformGoalSignature = null
      this.syncedPlatformGoal = null
    }
    this.activeTurnId = null
    this.stdoutBuf = ''
    if (remote) this.remoteInstructions = null
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
  }

  private _ensureSpawnedInternal(
    repoSnap: RepoSnapshot | null,
    effectiveCwd: string,
  ): Promise<void> {
    return ensureSpawnedInternalImpl.call(this as unknown as CodexRpcTransportHost, repoSnap, effectiveCwd)
  }

  private _ensureSpawnedRemote(): Promise<void> {
    return ensureSpawnedRemoteImpl.call(this as unknown as CodexRpcTransportHost)
  }

  private failAllPending(reason: string): void {
    failAllPendingImpl.call(this as unknown as CodexRpcTransportHost, reason)
  }

  private emitForcedShutdownResult(reason: string): void {
    emitForcedShutdownResultImpl.call(this as unknown as CodexTurnExecutionHost, reason)
  }

  private consumeActiveTurnUsage(): CodexTokenBreakdown | null {
    return consumeActiveTurnUsageImpl.call(this as unknown as CodexTurnExecutionHost)
  }

  private async _handleChatgptAuthTokensRefresh(
    id: string | number,
    params: unknown,
  ): Promise<void> {
    await handleCodexChatgptAuthTokensRefresh({
      id,
      params,
      sessionKey: this.opts.sessionKey,
      writeRaw: (line) => this.writeRaw(line),
      warn: (msg, meta) => log.warn(msg, meta),
    })
  }

  private writeRaw(line: string): boolean {
    return writeRawImpl.call(this as unknown as CodexRpcTransportHost, line)
  }

  async writeDelegateTerminalNotification(
    line: string,
  ): Promise<{ ok: boolean; processAlive: boolean; unknown?: boolean }> {
    return writeCodexDelegateTerminalNotification(
      this.proc,
      (candidate) => this.isInlinePushProcLive(candidate),
      line,
    )
  }

  private isInlinePushProcLive(proc: ChildProcessWithoutNullStreams | null): boolean {
    return isInlinePushProcLive(proc, this.proc)
  }

  /**
   * Parent-turn ingest proof for InlinePush. queue/processing/completer are
   * admission, not ingest: turn/start may still reject. The only ACK is a
   * turn id returned by turn/start (activeTurnId).
   */
  get hasIngestedParentTurn(): boolean {
    return this.activeTurnId != null
  }

  private sendRequest(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    return sendRequestImpl.call(this as unknown as CodexRpcTransportHost, method, params, signal)
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

  private buildTurnStartParams(
    prompt: string,
    serviceTier: ServiceTier | null = this._serviceTier,
  ): Record<string, unknown> {
    return buildTurnStartParamsImpl.call(this as unknown as CodexTurnExecutionHost, prompt, serviceTier)
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
  /**
   * A remote kernel recycled for a privacy/identity/UI refresh keeps its native thread, so the
   * freshly built instructions must cross on resume too — otherwise the node keeps the old ones.
   */
  private remoteResumeParams(threadId: string): Record<string, unknown> {
    if (this.remoteInstructions === null) throw new Error('CODEX_REMOTE_CONTEXT_UNAVAILABLE')
    return { threadId, baseInstructions: this.remoteInstructions }
  }

  private _startNewThread(effectiveCwd: string, preheatGeneration?: number): Promise<void> {
    return startNewThreadImpl.call(this as unknown as CodexTurnExecutionHost, effectiveCwd, preheatGeneration)
  }

  private resetAttemptState(): void {
    resetAttemptStateImpl.call(this as unknown as CodexTurnExecutionHost)
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
    return abortableDelay(ms, signal)
  }
  private verifyTurnServiceTier(readOnly: boolean, serviceTier: ServiceTier | null): Promise<void> {
    return verifyTurnServiceTierImpl.call(this as unknown as CodexTurnExecutionHost, readOnly, serviceTier)
  }

  private classifyRunErrorCode(errStr: string | undefined): ClassifiedErrorCode {
    return classifyRunError(errStr).code
  }

  private runWithTurnTrace<T>(
    threadId: string | null,
    traceId: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    return withCodexTurnTrace(threadId, traceId, fn)
  }

  private async recycleAfterUserCancelled(): Promise<void> {
    await this.recycleProcKeepQueue('user-cancelled')
  }

  private shouldRetryTurnStart(err: unknown, retryState: AutomaticRetryState): boolean {
    return shouldRetryTurnStartImpl.call(this as unknown as CodexTurnExecutionHost, err, retryState)
  }

  private runTurn(
    prompt: string,
    requestId?: string,
    collabAgentPolicy?: CollabAgentPolicy,
    automaticRetryState?: AutomaticRetryState,
    traceId?: string | null,
    readOnly = false,
    turnServiceTier: ServiceTier | null = this._serviceTier,
  ): Promise<void> {
    return runTurnImpl.call(
      this as unknown as CodexTurnExecutionHost,
      prompt,
      requestId,
      collabAgentPolicy,
      automaticRetryState,
      traceId,
      readOnly,
      turnServiceTier,
    )
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


// Re-export internal helpers for the test harness — the test patches
// `_classifyJsonRpcLine` to feed synthetic JSON-RPC frames.
export { _sanitizeThreadId, stripShellWrapper }
