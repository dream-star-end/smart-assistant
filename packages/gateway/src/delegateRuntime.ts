/**
 * Gateway delegate runtime: delegate task/wait, core runner, capacity slots and queue wait, reaper/reconcile, inflight surface
 *
 * Moved verbatim out of Gateway (server.ts) — FINDINGS §7.6, OCV5-473. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. DelegateRuntimeHost lists exactly the Gateway members this code
 * touches (typed from the class itself).
 */
import { fetchIdentityCompatProjection } from '@openclaude/storage'
import { resolveIdentityCompat, assertIdentityCompatReady } from '@openclaude/protocol'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import {
  type OutboundMessage,
  type AgentGroupStatus,
  type DurableAgentGroup,
  type DurableCodexBilling,
  type DurableGoalUsageRecord,
  type GoalStateSnapshot,
  type DurableRuntimeEvent,
  type ReviewVerdict,
  REVIEW_VERDICT_PASS,
  REVIEW_VERDICT_NEEDS_FIX,
  ADVISOR_AGENT_ID,
  AGENT_MODEL_AUTO,
} from '@openclaude/protocol'
import {
  failureClassFromLocalExecutionCode,
  isDelegateTerminalState,
  type DelegateFailureClass,
} from '@openclaude/protocol'
import { mintDelegateTrace, registerDelegateTraceWait, cancelDelegateTraceWait } from './delegateTrace.js'
import { TaskboardCancelledError, taskboardRunControls, type TaskboardRunControl } from './taskboard/runControl.js'
import { readTaskboardDelegateBody, TaskboardBodyTimeoutError } from './taskboard/delegateBody.js'
import { classifyDelegateOutputError } from './errorClassify.js'
import { DELEGATE_CONTEXT_HEADER, verifyDelegateContextToken } from './delegateContext.js'
import type { AgentSession } from './sessionManager.js'
import { isHiddenSystemAgentId, isTeamReviewExecution } from './agentVisibility.js'
import { backfillCronOccurrenceDelegateJobs } from './cron.js'
import { isSendToAgentCallbackComplete } from './sendToAgentCallback.js'
import type { SendToAgentIntent } from './sendToAgentIntentStore.js'
import {
  makeDelegateProgressBlock,
  makeDelegateUsageProgressBlock,
  makeDelegateBlockPassthrough,
  coalesceDelegateTranscript,
  DELEGATE_TRANSCRIPT_WARN_BYTES,
  estimateTranscriptBytes,
  resolveDelegateProgressRouting,
  toNestedDelegateProgressLine,
  formatDelegateParentWorkingDetail,
  type DelegateProgressBlock,
  type DelegateProgressRouting,
} from './delegateProgress.js'
import { getDelegateTimeoutReason, resolveDelegateTimeoutConfig } from './delegateTimeout.js'
import {
  DelegateJobStore,
  DELEGATE_LEASE_HEARTBEAT_MAX_BEATS,
  DELEGATE_LEASE_HEARTBEAT_MS,
  resolveDelegateJobTtlMs,
  resolveDelegateWaitMs,
  type DelegateJobHttpResult,
} from './delegateJobs.js'
import { DelegateResumeRegistry, DELEGATE_RESUME_OCCUPIED_MESSAGE } from './delegateResume.js'
import {
  isDelegateCutoverEffective,
  isDelegateDurableEffective,
  isDelegateInflightSurfaceEffective,
  isDelegateNotifierEffective,
  isDelegateSmEnabled,
} from './delegateSmFlag.js'
import { DelegateInflightSurfaceStore } from './delegateInflightSurface.js'
import { parseParentEngine } from './jobTerminal.js'
import { openDelegateDurableDb } from './delegateDurable.js'
import {
  reconcileDelegateJobsOnBoot,
  restoreResumeOccupancyFromJobs,
} from './delegateReconciler.js'
import {
  DELEGATE_GOAL_REQUIRED_ERROR,
  isPlatformAgentId,
  parseDelegateAllowSelf,
  parseDelegateModel,
  rejectSelfDelegate,
} from './delegateModel.js'
import { resolveDelegateProgressBinding } from './terminalStreamFence.js'
import {
  acquireDelegateGrokRoute,
  delegateGrokMintModelId,
  shouldMintDelegateGrokRoute,
  type DelegateGrokRouteLease,
} from './delegateGrokRoute.js'
import {
  defaultDelegateEngineBilling,
  mapDelegateEngineBillingError,
  resolveDelegateEngineBillingEngine,
  shouldAdmitDelegateEngineBilling,
  type DelegateEngineBillingAdmission,
} from './delegateEngineBilling.js'
import type { DelegateOwnerTurnLocator } from './delegateLateCompletion.js'
import { eventBus, createEvent } from './eventBus.js'
import { parseVerificationVerdict } from './sessionManager.js'
import { resolveDelegateToolsets } from './toolsetIntent.js'
import { isEngineLocalTurnExempt, isModelAuthorityRequired } from './modelAuthority.js'
import { getLocalCatalogView, type LocalExecutionRejectCode } from './modelCatalogClient.js'
import { resolveDelegateCostUsd } from './usageCost.js'
import {
  buildTeamReviewContext,
  parseTeamReviewMode,
  pickReviewerModel,
  type ReviewEvidenceItem,
  type TeamReviewMode,
} from './teamMode.js'
import { resolveLocalExecutionIfEnforced, localExecutionOverride, _buildTurnStatusFrame } from './server.js'
import { DELEGATE_DEFAULT_PREFERRED_MODELS, DELEGATE_GROK_FALLBACK_MODEL, assertKnownExplicitDelegateModel, DELEGATE_QUEUE_MAX_WAITERS, MAX_HIDDEN_DELEGATIONS_PER_TURN, MEMBER_DELEGATIONS_PER_TURN_DEFAULT, PerTurnDelegationGuard, resolveDelegateParentClientSessionId } from './delegatePolicy.js'
import type { Gateway, LocalExecutionDecision } from './server.js'
import type { DelegateGateBlock, RunDelegateInput } from './delegatePolicy.js'

export interface DelegateRuntimeHost {
  _acquireDelegateGrokRoute: Gateway['_acquireDelegateGrokRoute']
  _activeDelegations: Gateway['_activeDelegations']
  _activeDelegationsByParent: Gateway['_activeDelegationsByParent']
  _interruptDelegationsForParent: Gateway['_interruptDelegationsForParent']
  _settlePendingPermissionsForStop: Gateway['_settlePendingPermissionsForStop']
  _activeSendToAgentCallbacks: Gateway['_activeSendToAgentCallbacks']
  _admitDelegateCreate: Gateway['_admitDelegateCreate']
  _applyDelegateCapacityReject: Gateway['_applyDelegateCapacityReject']
  _armDelegateReaper: Gateway['_armDelegateReaper']
  _armDelegateReconcileFollowup: Gateway['_armDelegateReconcileFollowup']
  _armNotifyRetryScheduler: Gateway['_armNotifyRetryScheduler']
  _checkDelegateResourceGate: Gateway['_checkDelegateResourceGate']
  _completeDelegateResumeClaim: Gateway['_completeDelegateResumeClaim']
  _delegateChildAlive: Gateway['_delegateChildAlive']
  _delegateDurablePath: Gateway['_delegateDurablePath']
  _delegateEngineBilling: Gateway['_delegateEngineBilling']
  _delegateJobs: Gateway['_delegateJobs']
  _delegateModelByRunId: Gateway['_delegateModelByRunId']
  _delegateMonotonicMs: Gateway['_delegateMonotonicMs']
  _delegateOwnerByRunId: Gateway['_delegateOwnerByRunId']
  _delegateQueuePollMs: Gateway['_delegateQueuePollMs']
  _delegateQueueWaiters: Gateway['_delegateQueueWaiters']
  _delegateReconcileReady: Gateway['_delegateReconcileReady']
  _delegateResultToHttp: Gateway['_delegateResultToHttp']
  _delegateResume: Gateway['_delegateResume']
  _delegateTimeoutConfig: Gateway['_delegateTimeoutConfig']
  _dispatchDelegateNotify: Gateway['_dispatchDelegateNotify']
  _drainFlagOffCronOriginNotifies: Gateway['_drainFlagOffCronOriginNotifies']
  _dropDelegateInflightSurface: Gateway['_dropDelegateInflightSurface']
  _ensureDelegateInflightSurface: Gateway['_ensureDelegateInflightSurface']
  _ensureDelegateJobStore: Gateway['_ensureDelegateJobStore']
  _forgetDelegateInflight: Gateway['_forgetDelegateInflight']
  _forgetEvictedDelegateResumes: Gateway['_forgetEvictedDelegateResumes']
  _formatDelegateConcurrencyReject: Gateway['_formatDelegateConcurrencyReject']
  _getAgentsConfig: Gateway['_getAgentsConfig']
  _hiddenDelegateGuard: Gateway['_hiddenDelegateGuard']
  _mapLocalExecutionError: Gateway['_mapLocalExecutionError']
  _markDelegateAncestorActivity: Gateway['_markDelegateAncestorActivity']
  _markingDelegateAncestorActivity: Gateway['_markingDelegateAncestorActivity']
  _memberDelegateGuard: Gateway['_memberDelegateGuard']
  _outboundRing: Gateway['_outboundRing']
  _persistSendToAgentIntent: Gateway['_persistSendToAgentIntent']
  _projectDelegateInflightFromJob: Gateway['_projectDelegateInflightFromJob']
  _queueSendToAgentCallback: Gateway['_queueSendToAgentCallback']
  _registerActiveDelegation: Gateway['_registerActiveDelegation']
  _releaseDelegateSlot: Gateway['_releaseDelegateSlot']
  _releasePreadmittedDelegateCapacity: Gateway['_releasePreadmittedDelegateCapacity']
  _resolveDelegateParent: Gateway['_resolveDelegateParent']
  _resolveDelegateParentEngine: Gateway['_resolveDelegateParentEngine']
  _resolveDelegateProgressTarget: Gateway['_resolveDelegateProgressTarget']
  _retryDelegateNotifies: Gateway['_retryDelegateNotifies']
  _runDelegateTask: Gateway['_runDelegateTask']
  _runDelegateTaskCore: Gateway['_runDelegateTaskCore']
  _runLog: Gateway['_runLog']
  _runningDelegationsByParent: Gateway['_runningDelegationsByParent']
  _shuttingDown: Gateway['_shuttingDown']
  _touchDelegateInflightSurface: Gateway['_touchDelegateInflightSurface']
  _tryReserveDelegateSlot: Gateway['_tryReserveDelegateSlot']
  _turnDelegatedNonHiddenByParent: Gateway['_turnDelegatedNonHiddenByParent']
  _waitForDelegateCapacity: Gateway['_waitForDelegateCapacity']
  deliver: Gateway['deliver']
  deps: Gateway['deps']
  getUserId: Gateway['getUserId']
  log: Gateway['log']
  readBody: Gateway['readBody']
  sendError: Gateway['sendError']
  sendJson: Gateway['sendJson']
  sessions: Gateway['sessions']
}

const DELEGATE_MEMORY_CURRENT_FILES = [
  '/sys/fs/cgroup/memory.current',
  '/sys/fs/cgroup/memory/memory.usage_in_bytes',
]

const DELEGATE_MEMORY_MAX_FILES = [
  '/sys/fs/cgroup/memory.max',
  '/sys/fs/cgroup/memory/memory.limit_in_bytes',
]

function readFirstCgroupByteValue(files: readonly string[]): number | null {
  for (const file of files) {
    try {
      const text = readFileSync(file, 'utf8').trim()
      if (!text || text === 'max') continue
      const n = Number(text)
      if (Number.isFinite(n) && n > 0) return n
    } catch {}
  }
  return null
}

function readDelegateMemoryPressure(): { current: number; max: number; ratio: number } | null {
  const current = readFirstCgroupByteValue(DELEGATE_MEMORY_CURRENT_FILES)
  const max = readFirstCgroupByteValue(DELEGATE_MEMORY_MAX_FILES)
  if (!current || !max) return null
  // Docker/cgroup v1 sometimes reports a huge sentinel for "unlimited".
  if (max > Number.MAX_SAFE_INTEGER / 4) return null
  return { current, max, ratio: current / max }
}

// ── delegate 资源闸有界排队 ──────────────────────────────────────────────────
/** 资源闸(并发上限/内存水位)命中时的最长排队等待,超时按原闸形状(429/503)拒绝。
 *  客户端余量:mcp-memory postJsonToGateway 超时 2h,delegate idle/hard 计时在
 *  排队放行**之后**才起表,90s 等待不挤占执行预算。 */
const DELEGATE_QUEUE_WAIT_DEFAULT_MS = 90_000

/** 排队复查间隔(每 2-3s 复查一次两道闸)。 */
const DELEGATE_QUEUE_POLL_DEFAULT_MS = 2_500

/** After a delegate timeout, first allow the cooperative interrupt to drain
 * frames already produced by the model. A non-settling runner is then
 * force-shut down under a diagnostic deadline. That deadline never authorizes
 * materialization: the delegate still waits for the generation's real stdout
 * close barrier and turn settlement before freezing its transcript. */
const DELEGATE_INTERRUPT_DRAIN_DEFAULT_MS = 5_000

const DELEGATE_SHUTDOWN_WAIT_DEFAULT_MS = 8_000

const DELEGATE_OUTPUT_DRAIN_WAIT_DEFAULT_MS = 15_000

const DELEGATE_SUBMIT_SETTLE_DEFAULT_MS = 15_000

function parseDelegateIdempotencyKey(
  body: { idempotencyKey?: unknown; idempotency_key?: unknown },
  headers: IncomingHttpHeaders,
): string | undefined {
  const fromBody =
    (typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()) ||
    (typeof body.idempotency_key === 'string' && body.idempotency_key.trim()) ||
    ''
  if (fromBody) return fromBody
  const header = headers['idempotency-key']
  const raw = Array.isArray(header) ? header[0] : header
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  return undefined
}

function parseDelegateQueueWaitMs(): number {
  const raw = Number(process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : DELEGATE_QUEUE_WAIT_DEFAULT_MS
}

function parseNonNegativeMs(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

function waitForDelegateSettlement(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<{ settled: boolean; error?: unknown }> {
  return new Promise((resolve) => {
    let done = false
    const finish = (result: { settled: boolean; error?: unknown }) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => finish({ settled: false }), timeoutMs)
    promise.then(
      () => finish({ settled: true }),
      (error) => finish({ settled: true, error }),
    )
  })
}

/** `_runDelegateTask` 结果。rejected=闸/校验拒(HTTP 壳映射 4xx/429/503);error=session
 *  创建等意外(映射 500);completed=真正执行完(ok/output/error/timedOut,review 还带 verdict)。 */
export type DelegateTaskResult =
  | {
      kind: 'rejected'
      httpStatus: number
      message: string
      code?: LocalExecutionRejectCode
      failureClass?: DelegateFailureClass
      cancelled?: boolean
      /** Capacity reject lost the race to claimQueued; job is already dispatched. */
      alreadyDispatched?: boolean
    }
  | { kind: 'error'; message: string; failureClass?: DelegateFailureClass }
  | {
      kind: 'completed'
      ok: boolean
      output: string
      error?: string
      timedOut: boolean
      cancelled?: boolean
      actualModel?: string
      runId: string
      verdict?: ReviewVerdict
      /** 从内存 session 抄的用量。taskboard 回写 run;普通 delegate 可忽略。 */
      tokensIn?: number | null
      tokensOut?: number | null
      costUsd?: number | null
      costImprecise?: boolean
      sessionKey?: string
    }

function resolveMemberDelegationsPerTurn(): number {
  const raw = Number(process.env.OPENCLAUDE_TEAM_MEMBER_DELEGATIONS_PER_TURN)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : MEMBER_DELEGATIONS_PER_TURN_DEFAULT
}

/** hidden 审查员每 turn 委派上限。call-time 读 env,不在模块加载期固化。
 *  非法/缺省回落 MAX_HIDDEN_DELEGATIONS_PER_TURN;有限且 >=1 取 floor。 */
function resolveHiddenDelegationsPerTurn(): number {
  const raw = Number(process.env.OPENCLAUDE_HIDDEN_DELEGATIONS_PER_TURN)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : MAX_HIDDEN_DELEGATIONS_PER_TURN
}

export function _isDelegateHttpPath(this: DelegateRuntimeHost, pathname: string): boolean {
  return pathname === '/api/delegate/wait' || /^\/api\/agents\/[^/]+\/delegate$/.test(pathname)
}

export function _hasValidDelegateContext(this: DelegateRuntimeHost, req: IncomingMessage): boolean {
  const raw = req.headers[DELEGATE_CONTEXT_HEADER]
  const token = Array.isArray(raw) ? raw[0] : raw
  return typeof token === 'string' && verifyDelegateContextToken(token) !== null
}

export function _ensureDelegateJobStore(this: DelegateRuntimeHost): DelegateJobStore {
  if (this._delegateJobs) return this._delegateJobs
  const sm = isDelegateSmEnabled()
  const durableOn = isDelegateDurableEffective()
  const durable = durableOn ? openDelegateDurableDb(this._delegateDurablePath) : undefined
  const resume = (this._delegateResume ??= new DelegateResumeRegistry())
  const store = new DelegateJobStore({
    ttlMs: resolveDelegateJobTtlMs(),
    sm,
    durable,
    onDrop: (job) => this._forgetDelegateInflight(job.id),
    onTerminal: (job) => {
      if (job.sessionKey) resume.release(job.sessionKey)
      this._projectDelegateInflightFromJob(job)
      if (isDelegateNotifierEffective()) void this._dispatchDelegateNotify(job)
    },
  })
  this._delegateJobs = store
  if (durableOn) {
    const queueWaitMs = parseDelegateQueueWaitMs()
    const summary = reconcileDelegateJobsOnBoot(store, {
      isChildAlive: (job) => this._delegateChildAlive(job.sessionKey),
      queueWaitMs,
      claimPaused: isDelegateCutoverEffective(),
    })
    if (summary.scanned > 0) {
      this.log.info('delegate durable reconcile', summary)
    }
    restoreResumeOccupancyFromJobs(resume, store)
    const filled = backfillCronOccurrenceDelegateJobs(store)
    if (filled > 0) this.log.info('cron occurrence delegateJobId backfill', { filled })
    this._armDelegateReconcileFollowup(store, queueWaitMs)
    this._armDelegateReaper(store)
    this._delegateReconcileReady = true
    if (isDelegateNotifierEffective()) {
      void this._retryDelegateNotifies().finally(() => this._armNotifyRetryScheduler())
    } else {
      void this._drainFlagOffCronOriginNotifies().finally(() => this._armNotifyRetryScheduler())
    }
  } else {
    this._delegateReconcileReady = true
  }
  if (isDelegateInflightSurfaceEffective()) {
    this._ensureDelegateInflightSurface().rebuildFromJobs(store.listNonTerminal(), {
      dropMissingLive: true,
    })
  }
  return store
}

export function _resolveDelegateParentEngine(
  this: DelegateRuntimeHost,
  sessionKey?: string,
): ReturnType<typeof parseParentEngine> {
  if (!sessionKey) return undefined
  try {
    const session = this.sessions?.getByKey?.(sessionKey) as
      | { runner?: { engineId?: string } }
      | undefined
    return parseParentEngine(session?.runner?.engineId)
  } catch {
    return undefined
  }
}

export type ResolveDelegateProgressTargetArgs = {
    parentSessionKey?: unknown
    sourceAgent?: unknown
  }

/**
 * 解析委派进度路由:沿父链向上追溯到最近的 webchat 祖先会话(取代旧的「父非 webchat
 * 即 null」——那会让二级+嵌套委派的进度整段丢弃,一级卡长时间无进展)。
 *
 * 返回 `DelegateProgressRouting`:
 *   - `target` 与旧实现在**一级(直接 webchat 父)**场景下完全一致 → `.target` 即旧返回值;
 *   - `nested` / `firstLevelRunId` / `ancestorAgentPath` 供 handleDelegateTask 把嵌套进度以
 *     既有帧形态挂到用户可见的**一级**委派卡上(见 toNestedDelegateProgressLine)。
 *
 * 追溯纯逻辑在 resolveDelegateProgressRouting(delegateProgress.ts,可单测);本方法只做
 * SessionManager → 追溯所需最小会话视图的适配。断链/环/超深一律返回 null(丢弃,不抛错)。
 */
export function _resolveDelegateProgressTarget(
  this: DelegateRuntimeHost,
  args: ResolveDelegateProgressTargetArgs,
): DelegateProgressRouting | null {
  const parent =
    typeof args.parentSessionKey === 'string'
      ? this.sessions.getByKey(args.parentSessionKey)
      : undefined
  const profile = parent?._identityCompat?.assets?.profile
  if (
    profile &&
    parent?.userId &&
    process.env.OC_USER_ID &&
    parent.userId !== process.env.OC_USER_ID
  )
    return null
  const sourceAgent =
    profile &&
    parent?.agentId === profile.canonicalAgentId &&
    typeof args.sourceAgent === 'string' &&
    [profile.legacyAgentId, profile.canonicalAgentId].includes(args.sourceAgent)
      ? profile.canonicalAgentId
      : args.sourceAgent
  return resolveDelegateProgressRouting({
    parentSessionKey: args.parentSessionKey,
    sourceAgent,
    maxDepth: 5,
    getSession: (key) => {
      const s = this.sessions.getByKey(key)
      if (!s) return undefined
      return {
        sessionKey: s.sessionKey,
        channel: s.channel,
        peerId: s.peerId,
        agentId: s.agentId,
        userId: s.userId,
        parentSessionKey: s.parentSessionKey,
        progressRunId: s.progressRunId,
      }
    },
  })
}

export type ResolveDelegateParentResult = {
  sessionKey: string
  repoSessionId?: string
  workspaceMode: 'legacy' | 'isolated_v1'
  billingParentTurnKey?: string
  platformGoal?: GoalStateSnapshot | null
  workspaceCwd?: string
  projectId?: string | null
  frozenProjectContext?: import('@openclaude/storage').FrozenProjectContext | null
} | null

export type ResolveDelegateParentArgs = {
    taskboardControl?: TaskboardRunControl
    parentSessionKey?: unknown
    sourceAgent?: unknown
  }

export function _resolveDelegateParent(
  this: DelegateRuntimeHost,
  args: ResolveDelegateParentArgs,
): ResolveDelegateParentResult {
  if (typeof args.parentSessionKey !== 'string' || !args.parentSessionKey) return null
  const parent = this.sessions.getByKey(args.parentSessionKey)
  if (!parent) return null
  if (parent.channel !== 'webchat' && parent.channel !== 'delegate' &&
      !(parent.channel === 'taskboard' && args.taskboardControl && taskboardRunControls.lookup(parent.sessionKey)?.control === args.taskboardControl)) return null
  if (
    typeof args.sourceAgent === 'string' &&
    args.sourceAgent &&
    parent.agentId !== args.sourceAgent &&
    !(
      parent._identityCompat?.assets &&
      [
        parent._identityCompat.assets.profile.legacyAgentId,
        parent._identityCompat.assets.profile.canonicalAgentId,
      ].includes(args.sourceAgent) &&
      parent.agentId === parent._identityCompat.assets.profile.canonicalAgentId
    )
  ) {
    return null
  }
  return {
    sessionKey: parent.sessionKey,
    repoSessionId: parent.repoSessionId ?? parent.peerId,
    workspaceMode: parent.workspaceMode,
    // A nested delegate must keep charging the root user-visible turn. Its
    // direct parent turn is an ephemeral delegate session and has no master
    // tape/anchor of its own.
    billingParentTurnKey: parent._billingParentTurnKey ?? parent._currentTurnKey,
    platformGoal: parent._platformGoal,
    ...(args.taskboardControl ? { workspaceCwd: parent.workspaceCwd, projectId: parent.projectId, frozenProjectContext: parent.frozenProjectContext } : {}),
  }
}

/**
 * A synchronous delegate_task keeps every ancestor runner blocked inside the
 * tool call. Raw child adapter activity is therefore real liveness for the
 * complete delegate subtree, even though it is not parent stdout. Refresh the
 * existing ancestor sessions only; a genuinely silent subtree still reaches
 * the normal idle watchdog.
 *
 * `lastActivityAt` feeds the 15-minute liveness watchdog. Emitting `activity`
 * is required as well: the 30-minute fallback timer only `refresh()`es on
 * that event. The latch above ensures one external trigger walks the chain
 * once (each ancestor emits at most once) and that a cyclic parent pointer
 * cannot stack-overflow.
 */
export function _markDelegateAncestorActivity(
  this: DelegateRuntimeHost,
  parentSessionKey: string | undefined,
): void {
  if (this._markingDelegateAncestorActivity) return
  this._markingDelegateAncestorActivity = true
  try {
    const seen = new Set<string>()
    const now = Date.now()
    let sessionKey = parentSessionKey
    for (let depth = 0; sessionKey && depth < 5 && !seen.has(sessionKey); depth++) {
      seen.add(sessionKey)
      const ancestor = this.sessions.getByKey(sessionKey)
      if (!ancestor) return
      ancestor.runner.lastActivityAt = Math.max(ancestor.runner.lastActivityAt, now)
      try {
        ancestor.runner.emit?.('activity')
      } catch {
        // A throwing listener must not abort the remaining ancestors or
        // surface into the child runner's activity callback.
      }
      sessionKey = ancestor.parentSessionKey
    }
  } finally {
    this._markingDelegateAncestorActivity = false
  }
}

export async function handleDelegateTask(
  this: DelegateRuntimeHost,
  req: IncomingMessage,
  res: ServerResponse,
  targetAgentId: string,
): Promise<void> {
  if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
  const contextHeader = req.headers[DELEGATE_CONTEXT_HEADER]
  const contextRaw = Array.isArray(contextHeader) ? contextHeader[0] : contextHeader
  const entryContext = typeof contextRaw === 'string' ? verifyDelegateContextToken(contextRaw) : null
  const taskboardBinding = entryContext ? taskboardRunControls.lookup(entryContext.sessionKey) : undefined
  if (taskboardBinding?.closed) return this.sendJson(res, 409, { error: 'USER_CANCELLED: task execution has finished', code: 'USER_CANCELLED', failure_class: 'cancelled' })
  const taskboardControl = taskboardBinding?.control ?? undefined
  let leavePending: (() => void) | undefined
  try {
    leavePending = taskboardControl?.enterPending(entryContext!.sessionKey)
  const parentTraceId = entryContext?.traceId
  const body = await readTaskboardDelegateBody(req, (request) => this.readBody(request), taskboardControl)
  let parsed: any
  try {
    parsed = JSON.parse(body)
  } catch {
    return this.sendError(res, 400, 'invalid JSON')
  }
  if (!isPlatformAgentId(targetAgentId)) {
    return this.sendError(
      res,
      400,
      'agentId 只能是平台成员 id(如 coding-assistant)。型号请用 body.model,例如 cursor-grok-4.6-high-fast',
    )
  }
  if (targetAgentId === ADVISOR_AGENT_ID) {
    return this.sendError(
      res,
      403,
      'consult_advisor 只能走 /api/agents/advisor/consult，不能用 delegate',
    )
  }
  const { goal, context, sourceAgent, toolsets } = parsed
  if (!goal) return this.sendError(res, 400, DELEGATE_GOAL_REQUIRED_ERROR)
  const modelNorm = parseDelegateModel(parsed.model)
  if (!modelNorm.ok) return this.sendError(res, 400, modelNorm.error)
  // Flag-off: reject unknown explicit slugs before async job creation / spawn.
  // Flag-on: catalog projection in resolveLocalExecutionIfEnforced remains
  // the authority (catalog-only slugs, catalog-unavailable ≠ unknown).
  if (modelNorm.model && !isModelAuthorityRequired()) {
    try {
      assertKnownExplicitDelegateModel(modelNorm.model)
    } catch (err) {
      const mapped = this._mapLocalExecutionError(err)
      if (mapped) {
        return this.sendJson(res, mapped.httpStatus, {
          error: mapped.message,
          code: mapped.code,
        })
      }
      throw err
    }
  }
  const depthHeader = req.headers['x-delegation-depth']
  const boundContext =
    typeof contextRaw === 'string' && contextRaw.trim()
      ? verifyDelegateContextToken(contextRaw)
      : null
  if (typeof contextRaw === 'string' && contextRaw.trim() && !boundContext) {
    return this.sendError(res, 401, 'invalid delegate context')
  }
  if (parsed.async === true && !boundContext) {
    return this.sendError(res, 401, 'async delegate requires delegate context')
  }
  const depth = boundContext
    ? boundContext.depth
    : depthHeader
      ? Number.parseInt(String(depthHeader), 10)
      : 0
  // P2 批次4 — effort 仅接受 low/medium/high(delegate schema enum),其余(含缺省/非法)
  // → undefined,不动子会话默认档位。防御性白名单(body 非 typebox 校验)。
  const effort =
    typeof parsed.effort === 'string' && ['low', 'medium', 'high'].includes(parsed.effort)
      ? parsed.effort
      : undefined

  // HTTP 入口:解析 body → 结构化 input → _runDelegateTask 核心 → 结果映射回 res。
  // 委派执行核心与 HTTP req/res 解耦(P2 债C),让 gateway 硬编排 review pass
  // (dispatchInbound)能内部直调同一委派路径拿到结构化结果(verdict/output),
  // 无需伪造 req/res。
  const requestUserId = this.getUserId(req)
  const parentSessionKey = boundContext
    ? boundContext.sessionKey
    : typeof parsed.parentSessionKey === 'string'
      ? parsed.parentSessionKey
      : undefined
  const sourceAgentId = boundContext
    ? boundContext.agentId
    : typeof sourceAgent === 'string'
      ? sourceAgent
      : undefined
  if (!entryContext && parentSessionKey && taskboardRunControls.lookup(parentSessionKey)) {
    return this.sendError(res, 403, 'taskboard delegation requires signed caller context')
  }
  const identityProjection = await fetchIdentityCompatProjection()
  taskboardControl?.assertOpen(parentSessionKey)
  const callerExecutionId =
    identityProjection && sourceAgentId
      ? resolveIdentityCompat(sourceAgentId, identityProjection).executionAgentId
      : sourceAgentId
  const targetIdentity = identityProjection
    ? resolveIdentityCompat(targetAgentId, identityProjection)
    : undefined
  if (targetIdentity) assertIdentityCompatReady(targetIdentity)
  const selfCheck = rejectSelfDelegate({
    callerAgentId: callerExecutionId,
    targetAgentId: targetIdentity?.executionAgentId ?? targetAgentId,
    allowSelf: parseDelegateAllowSelf(parsed.allowSelf),
  })
  if (!selfCheck.ok) return this.sendError(res, 400, selfCheck.error)
  // 同步 preflight:mint/resume/占用必须在任何 await 和创建 async job 之前完成,
  // 这样 running 响应已经带着权威 sessionKey,并发 resume 也能立刻 409。
  // 拒绝路径不得产生副作用（不 create job、不 spawn、不 persist intent）。
  const idempotencyKey = parseDelegateIdempotencyKey(parsed, req.headers)
  const resume = (this._delegateResume ??= new DelegateResumeRegistry()).preflight({
    resumeSessionKey: parsed.resumeSessionKey,
    parentSessionKey,
    targetAgentId,
    sourceAgent: sourceAgentId || 'system',
    idempotencyKey,
    identityProjection,
  })
  this._forgetEvictedDelegateResumes(resume.evictedKeys)
  if (!resume.ok) {
    return this.sendError(res, resume.httpStatus, resume.message)
  }
  if (resume.replay && !resume.dispatchGranted) {
    const existing = resume.jobId ? this._delegateJobs?.snapshotOf(resume.jobId) : undefined
    if (existing) {
      return this.sendJson(res, 200, {
        status: isDelegateSmEnabled() && existing.state === 'queued' ? 'queued' : 'running',
        jobId: existing.id,
        agentId: targetAgentId,
        sessionKey: resume.sessionKey,
      })
    }
    return this.sendError(res, 409, DELEGATE_RESUME_OCCUPIED_MESSAGE)
  }
  const callbackOnComplete = isSendToAgentCallbackComplete(parsed.callbackOnComplete)
    ? ('origin-inject' as const)
    : undefined
  const callbackTarget = callbackOnComplete
    ? this._resolveDelegateProgressTarget({ parentSessionKey, sourceAgent: sourceAgentId })?.target
    : undefined
  const runInput: RunDelegateInput = {
    taskboardControl,
    allowSelf: parseDelegateAllowSelf(parsed.allowSelf),
    targetAgentId,
    goal,
    context: typeof context === 'string' ? context : undefined,
    sourceAgent: sourceAgentId,
    toolsets,
    parentSessionKey,
    parentTraceId,
    streamProgress: parsed.streamProgress === true,
    depth,
    effort,
    model: modelNorm.model,
    ...(typeof parsed.reviewMode === 'string' ? { reviewMode: parsed.reviewMode } : {}),
    sessionKey: resume.sessionKey,
    resumable: true,
    resumeMinted: resume.minted,
    callbackOnComplete,
    callbackOriginSessionKey: callbackTarget?.sessionKey,
    callbackOriginUserId: callbackTarget?.userId,
    idempotencyKey,
  }
  // 默认同步:行为与改前完全一致(CCB/Codex 继续堵在 HTTP 上)。仅 `async: true`
  // 才切作业句柄 —— 子任务仍走同一条 _runDelegateTask(idle/hard/祖先活性/深度/并发闸全在)。
  if (parsed.async === true) {
    const sm = isDelegateSmEnabled()
    if (
      sm &&
      isDelegateDurableEffective() &&
      !this._delegateReconcileReady &&
      !this._delegateJobs
    ) {
      this._ensureDelegateJobStore()
    }
    if (sm && isDelegateDurableEffective() && !this._delegateReconcileReady) {
      return this.sendJson(res, 503, {
        error: 'delegate store reconciling',
        failure_class: 'internal',
      })
    }
    const store = this._ensureDelegateJobStore()
    const slotOpts = {
      parentBucketKey: parentSessionKey,
      isReview: isTeamReviewExecution(targetAgentId),
    }
    if (sm) {
      const admit = this._admitDelegateCreate(resume.sessionKey, slotOpts)
      if (admit === 'full') {
        this._delegateResume.abort(resume.sessionKey, resume.minted)
        return this.sendJson(res, 429, {
          error: this._formatDelegateConcurrencyReject({
            isReview: slotOpts.isReview,
            parentBucketKey: slotOpts.parentBucketKey,
            queueFull: true,
          }),
          failure_class: 'capacity_queue_full',
        })
      }
      runInput.capacityReserved = admit === 'slot'
      runInput.capacitySlotOpts = slotOpts
    }
    const created = store.create(targetAgentId, {
      sessionKey: resume.sessionKey,
      parentSessionKey,
      parentTraceId,
      queued: sm,
      kind: callbackOnComplete ? 'send_to_agent' : 'delegate',
      callback: callbackOnComplete ? 'origin-inject' : 'stdout-wait',
      idempotencyKey: sm ? idempotencyKey : undefined,
      parentEngine: isDelegateNotifierEffective()
        ? this._resolveDelegateParentEngine(callbackTarget?.sessionKey ?? parentSessionKey)
        : undefined,
      callbackOriginSessionKey: callbackTarget?.sessionKey,
      callbackOriginUserId: callbackTarget?.userId,
    })
    if ('error' in created) {
      this._delegateResume.abort(resume.sessionKey, resume.minted)
      if (sm && runInput.capacityReserved) this._releaseDelegateSlot(slotOpts)
      if (sm) this._delegateQueueWaiters?.delete(resume.sessionKey)
      return this.sendError(res, 503, 'too many in-flight delegate jobs')
    }
    if (created.reused) {
      this._delegateResume.bindJob(resume.sessionKey, idempotencyKey, created.jobId)
      if (sm && runInput.capacityReserved) this._releaseDelegateSlot(slotOpts)
      if (sm) this._delegateQueueWaiters?.delete(resume.sessionKey)
      const existing = store.snapshotOf(created.jobId)
      this._touchDelegateInflightSurface({
        jobId: created.jobId,
        parentSessionKey,
        agentId: targetAgentId,
        goal,
        state: existing?.state === 'queued' ? 'queued' : 'running',
        userId: callbackTarget?.userId ?? requestUserId,
      })
      return this.sendJson(res, 200, {
        status: existing?.state === 'queued' ? 'queued' : 'running',
        jobId: created.jobId,
        agentId: targetAgentId,
        sessionKey: resume.sessionKey,
      })
    }
    const jobId = created.jobId
    runInput.backgroundJobId = jobId
    this._touchDelegateInflightSurface({
      jobId,
      parentSessionKey,
      agentId: targetAgentId,
      goal,
      state: sm ? 'queued' : 'running',
      userId: callbackTarget?.userId ?? requestUserId,
    })
    this._delegateResume.bindJob(resume.sessionKey, idempotencyKey, jobId)
    if (callbackOnComplete && callbackTarget) {
      const intent: SendToAgentIntent = {
        v: 1,
        jobId,
        originSessionKey: callbackTarget.sessionKey,
        userId: callbackTarget.userId,
        agentId: targetAgentId,
        goal,
        createdAt: Date.now(),
      }
      try {
        await this._persistSendToAgentIntent(intent)
      } catch (err) {
        this._delegateResume.abort(resume.sessionKey, resume.minted)
        store.complete(jobId, {
          httpStatus: 503,
          body: { error: 'background callback persistence unavailable' },
        })
        if (sm && runInput.capacityReserved) this._releaseDelegateSlot(slotOpts)
        if (sm) this._delegateQueueWaiters?.delete(resume.sessionKey)
        this.log.warn('send_to_agent intent persist failed', { jobId }, err as Error)
        return this.sendError(res, 503, 'background callback persistence unavailable')
      }
      this._activeSendToAgentCallbacks.set(jobId, {
        originSessionKey: callbackTarget.sessionKey,
        userId: callbackTarget.userId,
        agentId: targetAgentId,
        goal,
      })
    }
    void this._runDelegateTask(runInput)
      .then((result) => {
        if (runInput._leaseTimer) clearInterval(runInput._leaseTimer)
        const mapped = this._delegateResultToHttp(result, targetAgentId)
        const fence =
          runInput.claimToken && runInput.fencingEpoch !== undefined
            ? { claimToken: runInput.claimToken, fencingEpoch: runInput.fencingEpoch }
            : undefined
        if (result.kind === 'rejected' && result.alreadyDispatched) {
          return
        }
        let winner = false
        if (sm && result.kind === 'rejected' && result.failureClass) {
          const dropped =
            result.failureClass === 'capacity_queue_full' && store.dropIfUnclaimed(jobId)
          if (dropped) {
            this._dropDelegateInflightSurface(jobId)
          } else {
            winner = store.fail(jobId, {
              failureClass: result.failureClass,
              detail: result.message,
              httpStatus: mapped.httpStatus,
              body: mapped.body,
              claimToken: fence?.claimToken,
              fencingEpoch: fence?.fencingEpoch,
              nextState: result.failureClass === 'cancelled' ? 'cancelled' : 'failed',
            })
          }
        } else if (sm) {
          winner = store.complete(jobId, mapped, fence)
        } else {
          store.complete(jobId, mapped)
          winner = true
        }
        if (!winner) return
        const output = result.kind === 'completed' ? result.output : ''
        const error =
          result.kind === 'rejected' || result.kind === 'error'
            ? result.message
            : result.kind === 'completed'
              ? result.error
              : undefined
        this._queueSendToAgentCallback(runInput, {
          jobId,
          agentId: targetAgentId,
          goal,
          output,
          error,
        })
      })
      .catch((err) => {
        if (runInput._leaseTimer) clearInterval(runInput._leaseTimer)
        const message = (err as Error)?.message ?? String(err)
        const fence =
          runInput.claimToken && runInput.fencingEpoch !== undefined
            ? { claimToken: runInput.claimToken, fencingEpoch: runInput.fencingEpoch }
            : undefined
        if (sm) {
          const winner = store.complete(jobId, { httpStatus: 500, body: { error: message } }, fence)
          if (!winner) return
        } else {
          store.complete(jobId, { httpStatus: 500, body: { error: message } })
        }
        this._queueSendToAgentCallback(runInput, {
          jobId,
          agentId: targetAgentId,
          goal,
          error: message,
        })
      })
    return this.sendJson(res, 200, {
      status: 'running',
      jobId,
      agentId: targetAgentId,
      sessionKey: resume.sessionKey,
    })
  }
  const result = await this._runDelegateTask(runInput)
  const mapped = this._delegateResultToHttp(result, targetAgentId)
  return this.sendJson(res, mapped.httpStatus, mapped.body)
  } catch (err) {
    if (err instanceof TaskboardBodyTimeoutError) return this.sendError(res, 408, err.message)
    if (err instanceof TaskboardCancelledError) return this.sendJson(res, 409, { error: err.message, code: err.code, failure_class: 'cancelled' })
    throw err
  } finally {
    leavePending?.()
  }
}

export function _delegateResultToHttp(
  this: DelegateRuntimeHost,
  result: DelegateTaskResult,
  targetAgentId: string,
): DelegateJobHttpResult {
  if (result.kind === 'rejected') {
    const failureClass =
      result.failureClass ??
      (result.code ? failureClassFromLocalExecutionCode(result.code) : undefined)
    return {
      httpStatus: result.httpStatus,
      body: {
        error: result.message,
        ...(result.code ? { code: result.code } : {}),
        ...(failureClass ? { failure_class: failureClass } : {}),
      },
    }
  }
  if (result.kind === 'error') {
    return {
      httpStatus: 500,
      body: {
        error: result.message,
        ...(result.failureClass ? { failure_class: result.failureClass } : {}),
      },
    }
  }
  return {
    httpStatus: 200,
    body: {
      ok: result.ok,
      agentId: targetAgentId,
      output: result.output,
      error: result.error || undefined,
      ...(result.sessionKey ? { sessionKey: result.sessionKey } : {}),
    },
  }
}

export async function handleDelegateWait(
  this: DelegateRuntimeHost,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
  const body = await this.readBody(req)
  let parsed: any
  try {
    parsed = JSON.parse(body)
  } catch {
    return this.sendError(res, 400, 'invalid JSON')
  }
  const jobId = typeof parsed.jobId === 'string' ? parsed.jobId.trim() : ''
  if (!jobId) return this.sendError(res, 400, 'jobId required')
  const waitMs = resolveDelegateWaitMs(parsed.waitMs)
  const store = this._ensureDelegateJobStore()
  const view = await store.wait(jobId, waitMs)
  if (view.status === 'done' || view.status === 'failed') {
    // The parent read this result in-turn; turn-end adoption must not
    // resume-inject it a second time.
    try {
      store.markResultConsumed(jobId)
    } catch (err) {
      this.log.warn('delegate wait consume mark failed', { jobId }, err as Error)
    }
  }
  if (view.status === 'expired') {
    return this.sendJson(res, 404, {
      status: 'expired',
      jobId,
      error: 'delegate job not found or expired',
      ...(view.failure_class ? { failure_class: view.failure_class } : {}),
    })
  }
  if (view.status === 'queued') {
    return this.sendJson(res, 200, {
      status: 'queued',
      jobId,
      state: 'queued',
      ...(view.sessionKey ? { sessionKey: view.sessionKey } : {}),
    })
  }
  if (view.status === 'running') {
    return this.sendJson(res, 200, {
      status: 'running',
      jobId,
      ...(view.sessionKey ? { sessionKey: view.sessionKey } : {}),
    })
  }
  if (view.status === 'failed') {
    const capacity =
      view.failure_class === 'capacity_timeout' || view.failure_class === 'capacity_queue_full'
    return this.sendJson(res, capacity ? 429 : 200, {
      ...view.body,
      status: 'failed',
      jobId,
      httpStatus: view.httpStatus,
      failure_class: view.failure_class,
      failure_detail: view.failure_detail,
      state: view.state,
    })
  }
  return this.sendJson(res, 200, {
    ...view.body,
    status: 'done',
    jobId,
    httpStatus: view.httpStatus,
  })
}

export async function _runDelegateTask(
  this: DelegateRuntimeHost,
  input: RunDelegateInput,
): Promise<DelegateTaskResult> {
  let sessionSpawned = false
  let leave: (() => void) | undefined
  let detachStop: (() => void) | undefined
  try {
    const binding = input.parentSessionKey ? taskboardRunControls.lookup(input.parentSessionKey) : undefined
    if (binding?.closed) throw new TaskboardCancelledError()
    const control = input.taskboardControl ?? binding?.control ?? undefined
    if (control) {
      input.taskboardControl = control
      input.sessionKey ??= `agent:${input.targetAgentId}:delegate:${input.sourceAgent || 'system'}:${Date.now()}-${randomBytes(4).toString('hex')}`
      const key = input.sessionKey
      leave = control.enter(key, key === control.rootSessionKey ? undefined : input.parentSessionKey)
      const stop = () => {
        cancelDelegateTraceWait(this, key)
        this._delegateQueueWaiters?.get(key)?.()
        try { this._settlePendingPermissionsForStop(key) } catch (err) { this.log.warn('taskboard stop permission cleanup failed', { sessionKey: key, err: String(err) }) }
        this._interruptDelegationsForParent(key)
        if (this.sessions.getByKey(key)) this.sessions.interrupt(key, 'user')
      }
      control.signal.addEventListener('abort', stop, { once: true })
      detachStop = () => control.signal.removeEventListener('abort', stop)
      control.assertOpen()
    }
    const result = await this._runDelegateTaskCore(input, {
      onSessionSpawned: () => { sessionSpawned = true },
    })
    if (result.kind === 'completed' && control && input.sessionKey) {
      control.recordResult({ executionId: result.runId, sessionKey: input.sessionKey, agentId: input.targetAgentId, actualModel: result.actualModel, output: result.output, error: result.error, cancelled: result.cancelled, tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd: result.costUsd, costImprecise: result.costImprecise })
    }
    if (result.kind === 'completed' && input.resumable && input.sessionKey) return { ...result, sessionKey: input.sessionKey }
    return result
  } catch (err) {
    if (err instanceof TaskboardCancelledError) return { kind: 'rejected', httpStatus: 409, message: err.message, failureClass: 'cancelled', cancelled: true }
    throw err
  } finally {
    if (input._leaseTimer) clearInterval(input._leaseTimer)
    try {
      this._releasePreadmittedDelegateCapacity(input)
      await this._completeDelegateResumeClaim(input, sessionSpawned)
    } finally {
      if (input.delegationGuardOwnerKey) {
        this._hiddenDelegateGuard.resetForParent(input.delegationGuardOwnerKey)
        this._memberDelegateGuard?.resetForParent(input.delegationGuardOwnerKey)
      }
      detachStop?.()
      leave?.()
    }
  }
}

export async function _runDelegateTaskCore(
  this: DelegateRuntimeHost,
  input: RunDelegateInput,
  hooks?: { onSessionSpawned?: () => void },
): Promise<DelegateTaskResult> {
  const cancelledBeforeSpawn: DelegateTaskResult = { kind: 'rejected', httpStatus: 409, message: 'USER_CANCELLED: stopped before model execution', failureClass: 'cancelled', cancelled: true }
  input.taskboardControl?.assertOpen()
  const { targetAgentId, goal, sourceAgent, toolsets, depth } = input
  let context = input.context
  let isReview = input.isReview === true
  const parentSessionKey = input.parentSessionKey
  /** 审查员本次执行型号(2026-09-04:必须 ≠ 队长/panel 家族;选不出则沿用成员默认绑定)。 */
  let reviewerModelOverride: string | undefined
  let reviewMode: TeamReviewMode = 'execution'

  // 队长自主送审(2026-07-07):目标是隐藏审查员 ⇒ 一律按审查语义执行(资源闸保留槽/
  // 免 per-parent 桶/回传不封顶/结构化 verdict)。单一权威 = 目标身份,不采信调用方自报。
  if (!isReview && isTeamReviewExecution(targetAgentId)) {
    isReview = true
    const parent =
      typeof parentSessionKey === 'string' && parentSessionKey
        ? this.sessions.getByKey(parentSessionKey)
        : undefined
    // 审查仅团队模式 turn 可用:结构化拒绝防非团队会话/嵌套委派误触发额外计费。
    if (!parent?._teamModeTurn) {
      return {
        kind: 'rejected',
        httpStatus: 409,
        message: '质量审查仅在团队模式的队长回合中可用;当前回合请直接完成任务。',
      }
    }
    // 2026-09-04 团队模式重构:审查员不再盲审。
    //   - 证据 = 队长会话本 turn 已完成的成员团队卡(_pendingAgentGroups,turn 末才 drain,
    //     审查发生在 turn 内 → 此刻全在);审查员自己的历史委派行剔除(teamMode.ts 内做)。
    //   - 模式 = 调用方自报 reviewMode(execution/deliberation),只影响任务书模板,
    //     不影响任何闸/计费 → 采信无风险;非法值回落 execution。
    //   - 用户原始需求仍取服务端权威快照,不采信模型自报。
    reviewMode = parseTeamReviewMode(input.reviewMode)
    const evidence: ReviewEvidenceItem[] = (parent._pendingAgentGroups ?? []).map((entry) => ({
      runId: entry.group.runId,
      agentId: entry.group.agentId,
      model: this._delegateModelByRunId?.get(entry.group.runId),
      goal: entry.group.goal,
      status: entry.group.status,
      resultSummary: entry.group.resultSummary,
    }))
    context = buildTeamReviewContext({
      mode: reviewMode,
      userTask: parent._currentTurnUserText ?? '',
      leaderDraft: (context ?? '').trim(),
      evidence,
    })
    // 审查员型号 ≠ 队长本轮型号(同模型审自己盲点重合);审议模式下还要避开 panel 成员
    // (analyst 不能是刚答过题的那位)。catalog 拿不到 / 选不出 → undefined,沿用
    // agents.yaml 里 hidden-reviewer 的默认绑定(降级,仍审查)。
    if (isModelAuthorityRequired()) {
      try {
        const view = await getLocalCatalogView()
        reviewerModelOverride = pickReviewerModel(view, {
          leaderModel: parent.model ?? this.deps.config.defaults.model,
          avoidModels: evidence
            .map((e) => e.model)
            .filter((m): m is string => typeof m === 'string'),
          requireLocalEngines: !isEngineLocalTurnExempt(process.env),
        })
      } catch (err) {
        this.log.warn('team_reviewer_catalog_unavailable', {
          parentSessionKey,
          error: (err as Error)?.message ?? String(err),
        })
      }
    }
    this.log.info('team_review_request', {
      parentSessionKey,
      reviewMode,
      evidenceCount: evidence.length,
      reviewerModel: reviewerModelOverride ?? '(agent default)',
    })
  }

  // Recursion guard: 深度闸必须先于资源闸(超深嵌套是硬错误,不进排队/不占等待名额)。
  if (depth >= 3) {
    return { kind: 'rejected', httpStatus: 400, message: 'delegation depth limit exceeded (max 3)' }
  }

  // Per-turn 委派熔断(两条策略共用 PerTurnDelegationGuard,互斥分派):
  //   - hidden 系统 agent(隐藏审查员)→ 串行硬上限(env OPENCLAUDE_HIDDEN_DELEGATIONS_PER_TURN,默认 3);
  //   - 普通成员(非 hidden 非 review)→ 每 turn 委派上限(env 默认 8),消"串行无上限"债。
  // 计数键优先取 parentSessionKey(delegate 请求里唯一的父上下文,turn 级标识拿不到 ——
  // 依据见 PerTurnDelegationGuard 注释);极端情况下 body 缺 parentSessionKey 时退化为按
  // sourceAgent 计数,由 TTL 清扫兜底回收(无绕过口)。失败/超时的委派同样占额度:每次
  // 尝试都是全额计费的 delegate session。本闸先于资源闸排队:per-turn 额度等不出来 fail
  // fast、不占等待名额(保守偏置)。
  const delegateGuardKey = input.delegationGuardOwnerKey || (
    typeof parentSessionKey === 'string' && parentSessionKey
      ? parentSessionKey
      : `delegate-src:${typeof sourceAgent === 'string' && sourceAgent ? sourceAgent : 'system'}`)
  if (isTeamReviewExecution(targetAgentId)) {
    const hiddenLimit = resolveHiddenDelegationsPerTurn()
    if (!this._hiddenDelegateGuard.tryAcquire(delegateGuardKey, Date.now(), hiddenLimit)) {
      this.log.warn('delegate_hidden_limit', {
        targetAgentId,
        guardKey: delegateGuardKey,
        limit: hiddenLimit,
      })
      return {
        kind: 'rejected',
        httpStatus: 429,
        message: `审查委派已达本轮上限(${hiddenLimit}次),请基于已有审查结论收尾,不要再发起新的审查委派`,
      }
    }
  } else if (!isReview) {
    // 普通成员委派(队长直接派给已安装成员)。isReview 豁免(那是内部硬编排,走 hidden 分支)。
    const memberLimit = resolveMemberDelegationsPerTurn()
    const memberGuard = (this._memberDelegateGuard ??= new PerTurnDelegationGuard(memberLimit))
    if (!memberGuard.tryAcquire(delegateGuardKey)) {
      this.log.warn('delegate_member_limit', {
        targetAgentId,
        guardKey: delegateGuardKey,
        limit: memberLimit,
      })
      return {
        kind: 'rejected',
        httpStatus: 429,
        message: `本轮委派已达上限(${memberLimit} 次/turn)。请先整合已经收到的成员结果,基于现有产出继续推进;若确实还需要更多子任务,合并为更少的委派或分两轮进行,不要在同一轮内持续拆分委派。`,
      }
    }
  }

  // Find target agent
  const cfg = await this._getAgentsConfig()
  input.taskboardControl?.assertOpen()
  const identityProjection = await fetchIdentityCompatProjection()
  input.taskboardControl?.assertOpen()
  const targetIdentity = identityProjection
    ? resolveIdentityCompat(targetAgentId, identityProjection)
    : undefined
  if (targetIdentity) assertIdentityCompatReady(targetIdentity)
  const coreSelfCheck = rejectSelfDelegate({
    callerAgentId:
      typeof sourceAgent === 'string' && identityProjection
        ? resolveIdentityCompat(sourceAgent, identityProjection).executionAgentId
        : sourceAgent,
    targetAgentId: targetIdentity?.executionAgentId ?? targetAgentId,
    allowSelf: input.allowSelf === true || (!input.resumable && sourceAgent === targetAgentId),
  })
  if (!coreSelfCheck.ok) return { kind: 'rejected', httpStatus: 400, message: coreSelfCheck.error }
  const targetAgent = cfg.agents.find(
    (a) => a.id === (targetIdentity?.executionAgentId ?? targetAgentId),
  )
  if (!targetAgent)
    return { kind: 'rejected', httpStatus: 404, message: `agent "${targetAgentId}" not found` }

  // Resolve the delegated member's toolsets the same way the normal message
  // path does: member baseline + on-demand grant (task intent on goal/context)
  // + the leader's explicit `toolsets` as an additive grant of DEFINED toolsets
  // only. This is never fatal — an unknown or non-intersecting request degrades
  // to the merged baseline instead of aborting the whole delegation (the old
  // empty-intersection hard-400 that surfaced as "delegate toolsets not allowed
  // for agent …"). Escalation to "all tools" stays impossible: a configured
  // baseline is only ever extended with toolsets defined in config.toolsets.
  // Security cap (RFC D2.7): the sub-agent's toolsets can never exceed the
  // CALLER's. sourceAgent is injected from OPENCLAUDE_AGENT_ID (trusted, not
  // tool-arg controlled), so a marketplace agent can't spoof a privileged caller.
  // An undefined caller toolset = the trusted platform default (main) → no cap.
  const callerAgent =
    typeof sourceAgent === 'string'
      ? cfg.agents.find(
          (a) =>
            a.id ===
            (identityProjection
              ? resolveIdentityCompat(sourceAgent, identityProjection).executionAgentId
              : sourceAgent),
        )
      : undefined
  const callerToolsets = Array.isArray(callerAgent?.toolsets) ? callerAgent.toolsets : undefined
  const delegateIntentText = [goal, context].filter(Boolean).join('\n')
  const resolvedToolsets = resolveDelegateToolsets(
    targetAgent,
    this.deps.config,
    toolsets,
    delegateIntentText,
    callerToolsets,
  )
  const delegatedAgent =
    resolvedToolsets === undefined ? targetAgent : { ...targetAgent, toolsets: resolvedToolsets }

  // ── 模型权威 §3:delegate 是**无 envelope 的本地 turn** ────────────────────
  // 判定源 = master catalog 投影(归一 / 可用性 / engine 全取投影,不查 baked 表)。
  // 位置有意放在**资源闸之前**:codex delegate 是语义硬冲突(不是"稍后重试"能解决的),
  // 让它先去排队等内存名额、等到了再拒,是纯粹的浪费 + 误导性等待。
  // 也因此,这里必然**先于 getOrCreate/createEngine** —— 结构化拒绝时不会有任何 runner
  // 被 spawn(方案 §3 要求的"创建 runner 前拒",测试 ④/⑤ 断言未 spawn)。
  // 审查委派:调用方 model 忽略,改用 gateway 按「≠ 队长 / ≠ panel 家族」选出的审查员型号
  // (选不出 → undefined → 沿用 hidden-reviewer 成员绑定)。
  const taskboardDefault = input.modelPolicy === 'taskboard-stage-agent-auto' &&
    delegatedAgent.model && delegatedAgent.model !== AGENT_MODEL_AUTO
    ? delegatedAgent.model : undefined
  const requestedModel = isReview ? reviewerModelOverride : input.model || taskboardDefault
  let execAgent = requestedModel ? { ...delegatedAgent, model: requestedModel } : delegatedAgent
  let delegateExec: LocalExecutionDecision | undefined
  // 默认(未显式指定 model、非 review)委派优先 grok-build;只在 selfhost 引擎本地豁免门
  // 开着时插入(生产没有 grok 本地 turn),catalog 无该行时候选循环自然跳过。
  const preferGrokDefault = !requestedModel && !isReview && isEngineLocalTurnExempt(process.env)
  try {
    delegateExec = await resolveLocalExecutionIfEnforced({
      agent: execAgent,
      kind: 'turn',
      model: requestedModel,
      defaultModel: this.deps.config.defaults.model,
      preferredModels: preferGrokDefault ? DELEGATE_DEFAULT_PREFERRED_MODELS : undefined,
    })
  } catch (err) {
    const mapped = this._mapLocalExecutionError(err)
    if (!mapped) throw err
    return {
      kind: 'rejected',
      httpStatus: mapped.httpStatus,
      message: mapped.message,
      code: mapped.code,
    }
  }

  input.taskboardControl?.assertOpen()
  const sessionKey =
    input.sessionKey ?? `agent:${targetAgentId}:delegate:${sourceAgent || 'system'}:${Date.now()}`
  this.log.info('delegate', {
    sourceAgent,
    targetAgentId,
    goalPreview: goal.slice(0, 60),
    depth,
  })

  const progressRouting = this._resolveDelegateProgressTarget({
    parentSessionKey,
    sourceAgent,
  })
  // 进度投递目标 = 最近的 webchat 祖先(一级时即直接 webchat 父,值与旧实现一致)。
  const progressTarget = progressRouting?.target ?? null
  // 嵌套(二级+):直接父是 delegate 会话 → 进度要挂到用户可见的一级委派卡,而非
  // 另开一张卡或(旧行为)整段丢弃。
  const nestedProgress = progressRouting?.nested === true
  const delegateParent = this._resolveDelegateParent({
    taskboardControl: input.taskboardControl,
    parentSessionKey,
    sourceAgent,
  })
  // delegate 计费归因:父**客户端**会话 id(web-*)优先,拿不到才落容器内部
  // parentSessionKey(解析链见 resolveDelegateParentClientSessionId JSDoc)。
  // 随 usageAttribution → runner CLAUDE_CODE_EXTRA_METADATA env → master 计费点
  // 落 usage_records.mode='delegate' / parent_session_id / delegate_agent_id,
  // hidden-reviewer 与嵌套 delegate 同路径打标。
  const parentClientSessionId = input.taskboardControl?.rootSessionKey ?? resolveDelegateParentClientSessionId({
    progressPeerId: progressTarget?.peerId,
    parentRepoSessionId: delegateParent?.repoSessionId,
    parentSessionKey,
  })

  const progressRunId = `dlg-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
  // OCV5-180 B1 — launch 时冻结 exact owner locator {parentSessionId, parentTurnKey,
  // turnIndex}:本次委派的完成卡只允许归属该 turn。收集时若 owner 已 seal(或父会话
  // 已不在内存),凭此 locator 走持久晚到 continuation,不再依赖可变会话状态。
  // parentSessionId 用与 owner turn tape 相同的 webchat client session id
  // (= progressTarget.peerId),保证账务 locator 与 tape sessionId 一致。
  const delegateOwnerLocator: DelegateOwnerTurnLocator | undefined = progressTarget
    ? (() => {
        const ownerSession = this.sessions.getByKey(progressTarget.sessionKey)
        const ownerTurnKey = ownerSession?._currentTurnKey
        if (!ownerSession || !ownerTurnKey) return undefined
        return {
          parentSessionId: progressTarget.peerId,
          parentTurnKey: ownerTurnKey,
          turnIndex:
            ownerSession._currentTurnIndex ??
            (Number.isSafeInteger(ownerSession.turns) ? Math.max(1, ownerSession.turns + 1) : 1),
        }
      })()
    : undefined
  if (delegateOwnerLocator) {
    const map = (this._delegateOwnerByRunId ??= new Map())
    map.set(progressRunId, delegateOwnerLocator)
    if (map.size > 512) {
      const first = map.keys().next().value
      if (first !== undefined) map.delete(first)
    }
  }
  // 2026-09-04 团队模式:记录本次委派实际执行型号(runId → model),供审查任务书标注
  // panel 成员视角(审议模式)。有界 Map(FIFO 512)—— 只服务本 turn 内的审查,不需持久。
  {
    const resolvedModel = delegateExec?.canonicalModel ?? requestedModel ?? execAgent.model
    if (typeof resolvedModel === 'string' && resolvedModel) {
      const map = (this._delegateModelByRunId ??= new Map())
      map.set(progressRunId, resolvedModel)
      if (map.size > 512) {
        const first = map.keys().next().value
        if (first !== undefined) map.delete(first)
      }
    }
  }
  // 嵌套帧复用**一级**委派卡的 runId,把二级进度 append 回用户可见的那张卡;拿不到
  // 一级 runId(如一级未开进度)时退回本委派自身 runId → 独立进度卡兜底(仍可见,不丢)。
  const emitProgressRunId =
    nestedProgress && progressRouting?.firstLevelRunId
      ? progressRouting.firstLevelRunId
      : progressRunId
  // 层级前缀「一级名↳…↳本级名」,给嵌套文本行打标,让用户区分「子 agent 的子委派」。
  const nestLabel = nestedProgress
    ? [...(progressRouting?.ancestorAgentPath ?? []), targetAgentId].join('↳')
    : ''
  // Live lookup each emit: a retry may have moved the parent cmid, and a
  // terminated parent must not keep receiving dispatch:<old>:N frames.
  const emitProgress = (block: DelegateProgressBlock | null) => {
    if (!progressTarget || !block) return
    // 嵌套:把本委派的原始进度帧统一重写成「挂到一级卡上的带层级前缀非终态文本行」
    // (done/error 也降为 text,避免嵌套子委派的终态帧提前关掉一级卡)。返回 null → 丢弃。
    const outBlock = nestedProgress
      ? toNestedDelegateProgressLine(block, {
          runId: emitProgressRunId,
          agentId: targetAgentId,
          label: nestLabel,
        })
      : block
    if (!outBlock) return
    const parentSession = this.sessions.getByKey(progressTarget.sessionKey)
    const liveCmid =
      parentSession?._runningClientMessageId ?? parentSession?._currentDispatch?.clientMessageId
    const binding = resolveDelegateProgressBinding({
      candidate: typeof liveCmid === 'string' ? liveCmid : undefined,
      isFenced: (cmid) =>
        this._outboundRing?.isTurnFenced(progressTarget.sessionKey, cmid) === true,
    })
    const out = {
      type: 'outbound.message' as const,
      sessionKey: progressTarget.sessionKey,
      channel: progressTarget.channel,
      peer: { id: progressTarget.peerId, kind: 'dm' as const },
      ...(binding.clientMessageId ? { clientMessageId: binding.clientMessageId } : {}),
      blocks: [outBlock as any],
      isFinal: false,
      _userId: progressTarget.userId,
    }
    this.deliver(out as OutboundMessage & { _userId?: string })
    // Reuse the parent turn_status working-detail channel (not a new event type):
    // child tool_use/start → live row, while keepalive of the blocking parent
    // Bash/oc-memory delegate would otherwise freeze on 「运行子任务」.
    const liveDetail = formatDelegateParentWorkingDetail({
      block: outBlock,
      agentLabel: targetAgent.displayName || targetAgentId,
      parallelCount: this._activeDelegationsByParent.get(progressTarget.sessionKey)?.size,
    })
    if (liveDetail) {
      this.deliver(
        _buildTurnStatusFrame(
          {
            sessionKey: progressTarget.sessionKey,
            channel: progressTarget.channel,
            peer: { id: progressTarget.peerId, kind: 'dm' },
            ...(progressTarget.userId ? { _userId: progressTarget.userId } : {}),
          },
          { status: 'working', detail: liveDetail },
        ),
      )
    }
    this._touchDelegateInflightSurface({
      // Nested progress hangs on the first-level card: never let the child's
      // jobId/agent/goal rewrite the parent slot identity.
      jobId: nestedProgress ? undefined : input.backgroundJobId,
      progressRunId: emitProgressRunId,
      parentSessionKey: progressTarget.sessionKey,
      agentId: targetAgentId,
      goal,
      state: 'running',
      liveHint: liveDetail ?? '',
      runId: emitProgressRunId,
      userId: progressTarget.userId,
      preserveIdentity: nestedProgress,
      ownerRunId: emitProgressRunId,
    })
  }
  const streamProgress = progressTarget && input.streamProgress === true

  // P2 债C/3.5 — per-parent 分桶键 = 队长(父)会话 sessionKey(仅父在内存 webchat/delegate
  // 时非空;cron/webhook 父 null → 只受全局闸)。review 委派豁免分桶、走保留槽。slotOpts 是
  // 预占/释放的对称口径,过闸后所有释放路径必须用它(否则 per-parent 运行计数漂移锁死)。
  const parentBucketKey = delegateParent?.sessionKey
  // SM 预占(_admitDelegateCreate)用的是 HTTP 层的 raw parentSessionKey;若父会话此刻已
  // 不在内存(delegateParent null)会解析出不同的桶键 → 释放必须沿用预占时的 opts,否则
  // per-parent 计数只增不减。未预占时才按本地解析口径预占/释放。
  const slotOpts =
    input.capacityReserved && input.capacitySlotOpts
      ? input.capacitySlotOpts
      : { parentBucketKey, isReview }

  // ── 资源闸有界排队(并发上限 + 内存水位共用 _waitForDelegateCapacity 收口)──
  // 父→子注册必须先于等待:排队期间用户 Stop 级联(_interruptDelegationsForParent)
  // 才能经 _delegateQueueWaiters 回调打断等待(此时子 session 尚不存在)。
  const unregisterDelegation = this._registerActiveDelegation(
    delegateParent?.sessionKey,
    sessionKey,
  )
  if (input.taskboardControl?.signal.aborted) {
    unregisterDelegation?.()
    this._delegateOwnerByRunId?.delete(progressRunId)
    await input.taskboardControl.waitForDescendants(sessionKey)
    return cancelledBeforeSpawn
  }
  let queuedNoticeSent = false
  // 过闸即接管:预占槽位的释放责任从 input(早退 finally)转到本函数的 slotOpts 释放路径;
  // 'wait' 预占的 waiter 条目由 _waitForDelegateCapacity 自己的 finally 删除。
  const preReserved = input.capacityReserved === true
  input.capacityReserved = false
  input.capacitySlotOpts = undefined
  const gate = preReserved
    ? ({ status: 'ok' } as const)
    : await this._waitForDelegateCapacity({
        sessionKey,
        parentBucketKey,
        isReview,
        onQueued: (blocked) => {
          this.log.info('delegate_queue_wait', {
            targetAgentId,
            reason: blocked.kind,
            waiters: this._delegateQueueWaiters?.size ?? 0,
            depth,
          })
          // 复用既有 delegate progress 通道:start 帧带 goal,前端把这张卡挂回队长的
          // delegate_task 工具卡;排队文案让用户看到"在排队"而不是无声卡住。
          if (streamProgress) {
            queuedNoticeSent = true
            emitProgress(
              makeDelegateProgressBlock({
                runId: progressRunId,
                agentId: targetAgentId,
                phase: 'start',
                text: `排队中:容器资源紧张(${blocked.kind === 'memory' ? '内存水位' : '并发已满'}),等待放行…`,
                goal,
              }),
            )
          }
        },
      })
  if (gate.status !== 'ok') {
    this._delegateOwnerByRunId?.delete(progressRunId)
    unregisterDelegation?.()
    const waitedS = gate.status === 'queue_full' ? 0 : Math.round(gate.waitedMs / 1000)
    let httpStatus: number
    let message: string
    if (gate.status === 'aborted') {
      httpStatus = 503
      message = `delegate 排队等待已被中断(用户停止,已等待 ${waitedS}s)`
    } else if (gate.blocked.kind === 'memory') {
      // 与排队机制引入前的内存闸同形:503 + "delegate resource pressure" 前缀。
      httpStatus = 503
      const base = `delegate resource pressure: memory ${gate.blocked.pct}% >= ${gate.blocked.limitPct}%`
      message =
        gate.status === 'timeout'
          ? `${base}; 已等待 ${waitedS}s 资源仍紧张,请稍后重试`
          : `${base}; please retry later(排队等待者已满 ${DELEGATE_QUEUE_MAX_WAITERS} 个)`
      this.log.warn('delegate_resource_pressure', {
        targetAgentId,
        outcome: gate.status,
        pct: gate.blocked.pct,
        limitPct: gate.blocked.limitPct,
        waitedMs: gate.status === 'timeout' ? gate.waitedMs : 0,
      })
    } else {
      // 与排队机制引入前的并发闸同形:429 + "too many concurrent delegations"。
      httpStatus = 429
      message = this._formatDelegateConcurrencyReject({
        isReview,
        parentBucketKey,
        waitedS: gate.status === 'timeout' ? waitedS : undefined,
        queueFull: gate.status === 'queue_full',
      })
      this.log.warn('delegate_queue_reject', {
        targetAgentId,
        outcome: gate.status,
        waitedMs: gate.status === 'timeout' ? gate.waitedMs : 0,
      })
    }
    // 已发过"排队中"进度卡 → 补终止帧收口卡片,不留悬挂的进行中状态。
    if (queuedNoticeSent) {
      emitProgress(
        makeDelegateProgressBlock({
          runId: progressRunId,
          agentId: targetAgentId,
          phase: 'error',
          isError: true,
          text: message,
          maxLen: 2_000,
        }),
      )
    }
    let failureClass: DelegateFailureClass | undefined
    if (gate.status === 'timeout') failureClass = 'capacity_timeout'
    else if (gate.status === 'queue_full') failureClass = 'capacity_queue_full'
    else if (gate.status === 'aborted') failureClass = 'cancelled'
    else failureClass = 'capacity_timeout'
    return this._applyDelegateCapacityReject(input, {
      httpStatus,
      message,
      failureClass,
      drop: gate.status === 'queue_full',
    })
  }
  const cancelPreparation = async (
    route?: DelegateGrokRouteLease | null,
    admission?: DelegateEngineBillingAdmission | null,
  ): Promise<DelegateTaskResult> => {
    try {
      await input.taskboardControl?.waitForDescendants(sessionKey)
      if (admission) await (this._delegateEngineBilling ?? defaultDelegateEngineBilling).abandon(admission.requestId).catch(() => {})
      if (route) await route.release()
      return cancelledBeforeSpawn
    } finally {
      this._delegateOwnerByRunId?.delete(progressRunId)
      this._releaseDelegateSlot(slotOpts)
      unregisterDelegation?.()
    }
  }
  if (input.taskboardControl?.signal.aborted) return cancelPreparation()
  if (isDelegateSmEnabled() && input.backgroundJobId) {
    const claimed = this._delegateJobs?.claimQueued(input.backgroundJobId)
    if (!claimed?.ok) {
      this._releaseDelegateSlot(slotOpts)
      unregisterDelegation?.()
      if (claimed && claimed.reason === 'cutover_frozen') {
        return {
          kind: 'rejected',
          httpStatus: 503,
          message: 'delegate dispatch frozen for cutover',
          failureClass: 'cutover',
          alreadyDispatched: true,
        }
      }
      const snap = this._delegateJobs?.snapshotOf(input.backgroundJobId)
      if (snap && !isDelegateTerminalState(snap.state)) {
        return {
          kind: 'rejected',
          httpStatus: 429,
          message: 'delegate already claimed',
          alreadyDispatched: true,
        }
      }
      return {
        kind: 'rejected',
        httpStatus: 429,
        message: snap?.failureDetail || 'delegate job was rejected before claim',
        failureClass: snap?.failureClass,
      }
    }
    input.claimToken = claimed.claimToken
    input.fencingEpoch = claimed.fencingEpoch
    const tok = claimed.claimToken
    const epoch = claimed.fencingEpoch
    const jobId = input.backgroundJobId
    let beats = 0
    const timer = setInterval(() => {
      beats += 1
      const capHit = beats > DELEGATE_LEASE_HEARTBEAT_MAX_BEATS
      const ok = !capHit && this._delegateJobs?.casHeartbeat(jobId, tok, epoch)
      if (!ok) {
        clearInterval(timer)
        // Child key is local `sessionKey` (`input.sessionKey ?? generated`).
        // `input.sessionKey` is optional and must not be passed to interrupt().
        if (!sessionKey) {
          this.log.warn('delegate_lease_fence_lost', {
            jobId,
            reason: capHit
              ? 'heartbeat hard-cap 480 (2h) reached; child sessionKey missing'
              : 'casHeartbeat failed; child sessionKey missing',
          })
          return
        }
        try {
          const interrupted = this.sessions.interrupt(sessionKey)
          if (!interrupted) {
            this.log.warn('delegate_lease_fence_lost', {
              jobId,
              sessionKey,
              reason: capHit
                ? 'heartbeat hard-cap 480 (2h) reached; child session not interruptible'
                : 'casHeartbeat failed; child session not interruptible',
            })
          }
        } catch (err) {
          this.log.warn('delegate_lease_fence_interrupt_failed', { jobId, sessionKey }, err)
        }
      }
    }, DELEGATE_LEASE_HEARTBEAT_MS)
    timer.unref()
    input._leaseTimer = timer
  }
  const jobSnapshot = input.backgroundJobId ? this._delegateJobs?.snapshotOf(input.backgroundJobId) : undefined
  input.traceId = jobSnapshot?.traceId ?? input.traceId
  if (jobSnapshot) input.parentTraceId = jobSnapshot.parentTraceId
  let traceMissingReason = 'master-trace-not-configured'
  if (!input.traceId) {
    let traceAborted = false
    const traceWait = registerDelegateTraceWait(this, sessionKey)
    const fence = input.claimToken && input.fencingEpoch !== undefined
      ? { claimToken: input.claimToken, fencingEpoch: input.fencingEpoch }
      : jobSnapshot?.claimToken ? { claimToken: jobSnapshot.claimToken, fencingEpoch: jobSnapshot.fencingEpoch } : undefined
    try {
      const trace = await mintDelegateTrace({
        sessionKey, agentId: targetAgentId, delegateRunId: input.backgroundJobId ?? progressRunId,
        parentTraceId: input.parentTraceId, model: delegateExec?.canonicalModel ?? requestedModel,
      })
      if (!traceWait.isAborted() && trace) {
        if (input.backgroundJobId && (!fence || !this._delegateJobs?.bindTrace(input.backgroundJobId, trace, fence))) {
          traceAborted = true
        } else input.traceId = trace.traceId
      }
    } catch {
      traceMissingReason = 'master-trace-unavailable'
    } finally {
      traceWait.close()
    }
    // Every mint outcome (including timeout/unconfigured) must recheck the owner.
    const current = input.backgroundJobId ? this._delegateJobs?.snapshotOf(input.backgroundJobId) : undefined
    if (input.backgroundJobId && (!current || current.state !== 'running' || !fence ||
        current.claimToken !== fence.claimToken || current.fencingEpoch !== fence.fencingEpoch)) traceAborted = true
    if (traceAborted || traceWait.isAborted() || this._shuttingDown || input.taskboardControl?.signal.aborted) {
      if (input._leaseTimer) clearInterval(input._leaseTimer)
      this._releaseDelegateSlot(slotOpts)
      unregisterDelegation?.()
      return { kind: 'rejected', httpStatus: 409, message: 'delegate cancelled before spawn', failureClass: 'cancelled' }
    }
  }
  if (!input.traceId) this.log.warn('delegate_trace_unbound', {
    parentTraceId: input.parentTraceId, delegateRunId: input.backgroundJobId ?? progressRunId,
    reason: traceMissingReason,
  })
  // ── grok delegate turn:向 master 铸造 relay route(与浏览器 turn 同一账号池)──
  // delegate 是容器本地 turn,没有 bridge 注入 __oc_grok_route;不铸 route 则
  // GrokAdapter 在 spawn 前 fail-closed(GROK_ROUTE_REQUIRED)。放在资源闸之后:
  // 排队期间不占用稀缺的 Grok 订阅槽;mint 失败是零代价结构化拒绝(尚未创建
  // session/runner)。生产(未开引擎本地豁免)在上方 decideLocalExecution 已拒。
  const grokMintModelId = delegateGrokMintModelId({
    canonicalModel: delegateExec?.canonicalModel,
    requestedModel,
    agentModel: execAgent.model,
  })
  const grokDelegate = shouldMintDelegateGrokRoute({
    delegateEngine: delegateExec?.engine,
    requestedModel,
    agentModel: execAgent.model,
  })
  if (input.taskboardControl?.signal.aborted) return cancelPreparation()
  let grokRoute: { baseUrl: string; routeToken: string } | null = null
  let grokRouteLease: DelegateGrokRouteLease | null = null
  if (grokDelegate) {
    if (!grokMintModelId) {
      this._releaseDelegateSlot(slotOpts)
      unregisterDelegation?.()
      return {
        kind: 'rejected',
        httpStatus: 500,
        message: 'Grok 委派暂不可用: missing grok model id',
      }
    }
    const acquired = await (this._acquireDelegateGrokRoute ?? acquireDelegateGrokRoute)({
      modelId: grokMintModelId,
      sessionId: sessionKey,
      log: this.log,
    })
    if (input.taskboardControl?.signal.aborted) return cancelPreparation(acquired.ok ? acquired.lease : null)
    if (!acquired.ok && !requestedModel) {
      // 默认路径(用户没显式要 grok):mint 失败(订阅并发满 / 容器租约上限 / 无账号 /
      // master 通道缺失)不拒,同一请求内回落到 ccb 的 DELEGATE_GROK_FALLBACK_MODEL,
      // 名额继续持有,下方 billing admit(ccb 不进 engine-reported)与 getOrCreate 照常。
      this.log.warn('delegate_grok_fallback', {
        targetAgentId,
        httpStatus: acquired.httpStatus,
        reason: acquired.reason,
        from: grokMintModelId,
        to: DELEGATE_GROK_FALLBACK_MODEL,
      })
      try {
        delegateExec = await resolveLocalExecutionIfEnforced({
          agent: { ...delegatedAgent, model: DELEGATE_GROK_FALLBACK_MODEL },
          kind: 'turn',
          model: DELEGATE_GROK_FALLBACK_MODEL,
          defaultModel: this.deps.config.defaults.model,
        })
      } catch (err) {
        const mapped = this._mapLocalExecutionError(err)
        if (!mapped) {
          this._releaseDelegateSlot(slotOpts)
          unregisterDelegation?.()
          throw err
        }
        this._releaseDelegateSlot(slotOpts)
        unregisterDelegation?.()
        return {
          kind: 'rejected',
          httpStatus: mapped.httpStatus,
          message: mapped.message,
          code: mapped.code,
        }
      }
      // 之后 grokRoute/grokRouteLease 保持 null:submit 不注入 grok route,ccb runner 正常起。
      execAgent = { ...delegatedAgent, model: DELEGATE_GROK_FALLBACK_MODEL }
    } else if (!acquired.ok) {
      // 显式 model 指定 grok:与排队被拒同形,已过闸的并发名额必须在此释放(下方 finally 不会执行)。
      this._releaseDelegateSlot(slotOpts)
      unregisterDelegation?.()
      this.log.warn('delegate_grok_route_denied', {
        targetAgentId,
        httpStatus: acquired.httpStatus,
        reason: acquired.reason,
      })
      return {
        kind: 'rejected',
        httpStatus: acquired.httpStatus,
        message: `Grok 委派暂不可用: ${acquired.reason}`,
      }
    } else {
      grokRoute = { baseUrl: acquired.lease.baseUrl, routeToken: acquired.lease.routeToken }
      grokRouteLease = acquired.lease
    }
  }
  // engine-reported (codex/grok) 委派必须先向 master 签 32-hex requestId +
  // inflight journal,否则 adapter 不 emit billing,usage_records.mode=delegate
  // 永远为空。CCB/GLM 走 anthropicProxy,不进这条。失败 fail-closed,禁止白跑。
  if (input.taskboardControl?.signal.aborted) return cancelPreparation(grokRouteLease)
  const billingApi = this._delegateEngineBilling ?? defaultDelegateEngineBilling
  const engineReported = shouldAdmitDelegateEngineBilling({
    delegateEngine: delegateExec?.engine,
    requestedModel,
    agentModel: execAgent.model,
  })
  let engineBillingAdmission: DelegateEngineBillingAdmission | null = null
  let liveEngineBilling: DurableCodexBilling | null = null
  let liveSettleTask: Promise<void> | null = null
  if (engineReported) {
    const billingModel = delegateExec?.canonicalModel || requestedModel || execAgent.model
    if (!billingModel) {
      if (grokRouteLease) grokRouteLease.release().catch(() => {})
      this._releaseDelegateSlot(slotOpts)
      unregisterDelegation?.()
      return {
        kind: 'rejected',
        httpStatus: 500,
        message: 'engine-reported 委派暂不可用: missing model id',
      }
    }
    try {
      engineBillingAdmission = await billingApi.admit({
        model: billingModel,
        engine: resolveDelegateEngineBillingEngine({
          delegateEngine: delegateExec?.engine,
          model: billingModel,
        }),
        agentId: targetAgentId,
        delegateAgentId: targetAgentId,
        sessionKey,
        ...(parentClientSessionId ? { parentSessionId: parentClientSessionId } : {}),
        ...(delegateParent?.billingParentTurnKey
          ? { parentTurnKey: delegateParent.billingParentTurnKey }
          : {}),
      })
    } catch (err) {
      if (grokRouteLease) grokRouteLease.release().catch(() => {})
      this._releaseDelegateSlot(slotOpts)
      unregisterDelegation?.()
      const mapped = mapDelegateEngineBillingError(err)
      this.log.warn('delegate_engine_billing_admit_failed', {
        targetAgentId,
        model: billingModel,
        err: String(err),
      })
      return {
        kind: 'rejected',
        httpStatus: mapped.httpStatus,
        message: mapped.message,
      }
    }
  }
  if (input.taskboardControl?.signal.aborted) return cancelPreparation(grokRouteLease, engineBillingAdmission)
  // 已过闸:并发名额已在 _tryReserveDelegateSlot 同步预占,此后所有路径必须释放
  // —— 正常路径走下方 finally,session 创建/开始帧投递抛错走本 catch。
  const durableTranscript: unknown[] = []
  const durableRuntimeEvents: DurableRuntimeEvent[] = []
  const durableEngineBillings: DurableCodexBilling[] = []
  const durableGoalUsageRecords: DurableGoalUsageRecord[] = []
  let lastChildActivityAt = Date.now()
  const markChildActivity = () => {
    lastChildActivityAt = Date.now()
    if (session?.channel === 'taskboard') session._taskboardLastActivityAt = lastChildActivityAt
  }
  let session: AgentSession
  let detachAncestorActivity: (() => void) | undefined
  try {
    session = await this.sessions.getOrCreate({
      sessionKey,
      agent: execAgent,
      // flag 未开 → {}(零变化);flag 开 → catalog 投影的 canonicalModel + engine。
      ...localExecutionOverride(delegateExec),
      ...(delegateExec || !requestedModel ? {} : { model: requestedModel }),
      channel: input.channel ?? 'delegate',
      peerId: sourceAgent || 'system',
      repoSessionId: progressTarget?.peerId ?? delegateParent?.repoSessionId,
      workspaceMode: delegateParent?.workspaceMode,
      workspaceCwd: input.workspaceCwd ?? delegateParent?.workspaceCwd,
      projectId: input.projectId ?? delegateParent?.projectId ?? undefined,
      runContext: input.runContext,
      frozenProjectContext: input.frozenProjectContext ?? delegateParent?.frozenProjectContext,
      // 物化直接父指针(已校验的父会话键),供本 delegate 的子委派沿父链向上追溯 webchat 祖先。
      parentSessionKey: delegateParent?.sessionKey,
      title: `[delegate] ${goal.slice(0, 40)}`,
      delegationDepth: depth + 1,
      usageAttribution: {
        mode: 'delegate',
        delegateAgentId: targetAgentId,
        ...(parentClientSessionId ? { parentSessionId: parentClientSessionId } : {}),
        ...(delegateParent?.billingParentTurnKey
          ? { parentTurnKey: delegateParent.billingParentTurnKey }
          : {}),
      },
    })
    if (input.taskboardControl?.signal.aborted) {
      await this.sessions.destroySession(sessionKey)
      return cancelPreparation(grokRouteLease, engineBillingAdmission)
    }
    hooks?.onSessionSpawned?.()
    if (session.channel === 'taskboard') session._taskboardLastActivityAt = lastChildActivityAt
    session._durableDelegateTranscript = durableTranscript
    session._durableDelegateRuntimeEvents = durableRuntimeEvents
    session._durableDelegateEngineBillings = durableEngineBillings
    session._durableDelegateGoalUsageRecords = durableGoalUsageRecords
    session._platformGoal = delegateParent?.platformGoal
      ? structuredClone(delegateParent.platformGoal)
      : null
    const handleChildActivity = () => {
      markChildActivity()
      this._markDelegateAncestorActivity(delegateParent?.sessionKey)
    }
    session.runner.on?.('activity', handleChildActivity)
    detachAncestorActivity = () => session.runner.off?.('activity', handleChildActivity)
    // 回填本委派的进度卡 runId:子委派追溯到**一级**委派时复用它,把嵌套进度挂回同一张卡。
    session.progressRunId = progressRunId
    this._touchDelegateInflightSurface({
      jobId: input.backgroundJobId,
      progressRunId,
      parentSessionKey: progressTarget?.sessionKey ?? parentSessionKey,
      agentId: targetAgentId,
      goal,
      state: 'running',
      runId: progressRunId,
      userId: progressTarget?.userId,
      nested: nestedProgress,
      ownerRunId: nestedProgress ? emitProgressRunId : undefined,
    })
    if (streamProgress) {
      emitProgress(
        makeDelegateProgressBlock({
          runId: progressRunId,
          agentId: targetAgentId,
          phase: 'start',
          text: `开始委派给 ${targetAgentId}: ${goal}`,
          // Correlation key: lets the frontend nest this run's live blocks into
          // the leader's delegate_task tool_use card (matched by agentId+goal)
          // instead of spawning a separate progress card.
          goal,
          jobId: input.backgroundJobId,
        }),
      )
    }
  } catch (err) {
    if (engineBillingAdmission) {
      await billingApi.abandon(engineBillingAdmission.requestId).catch(() => {})
    }
    if (grokRouteLease) grokRouteLease.release().catch(() => {})
    this._releaseDelegateSlot(slotOpts)
    unregisterDelegation?.()
    // flag 未开时 resolveLocalExecutionIfEnforced 是 no-op,显式未知型号在
    // getOrCreate → resolveExecutionModel({explicit:true}) 才抛。必须复用同一
    // 映射,否则会变成 500 且丢失 DELEGATE_MODEL_UNKNOWN。
    const mapped = this._mapLocalExecutionError(err)
    if (mapped) {
      return {
        kind: 'rejected',
        httpStatus: mapped.httpStatus,
        message: mapped.message,
        code: mapped.code,
      }
    }
    return { kind: 'error', message: (err as Error)?.message ?? String(err) }
  }

  // P2 债C — 标记"本 turn 队长实际发生过非隐藏委派"(据此在队长 final 放行前触发硬编排
  // 审查)。审查员自身(isReview / hidden)不置位,避免"审查=组队"的自指。progressTarget
  // 是 webchat 父,null 父(cron/嵌套)不置位。
  if (!isReview && !isHiddenSystemAgentId(targetAgentId) && progressTarget) {
    ;(this._turnDelegatedNonHiddenByParent ??= new Set()).add(progressTarget.sessionKey)
  }

  // Build prompt with context.
  // P2 批次4(1a)— 委派上下文结构化:给非 review 子任务加"产物纪律"preamble。父子同容器
  // 共享 FS(generated/uploads 天然共享)但历史上 prompt 零教学 → 子 agent 常把完整大产物
  // 整段回传,撑爆队长上下文。这里教:大产物落文件、回传只给路径+蒸馏摘要;小结果直接回传。
  // review 委派豁免(其 goal/context 已由 buildTeamReviewContext 精确指定为"审查+输出 VERDICT",
  // 不产文件产物,加纪律只会稀释指令)。这只是模型侧的产物组织建议;平台不再
  // 截断成员回传,所以即使模型没照做,完整输出仍进入队长上下文与 durable transcript。
  const artifactDiscipline = isReview
    ? ''
    : '\n\n【产物纪律】你和委派方在同一台容器、共享文件系统。若本任务会产出大产物(完整代码/长文档/数据文件/报告),请写入 `/home/agent/.openclaude/generated/<描述性文件名>`,回传只给「文件路径 + ≤1500 字的蒸馏摘要」(委派方可用 Read 按路径取回完整内容);小结果(结论/短答案)直接回传即可,不要把超长完整内容整段回传。'
  const prompt =
    (context
      ? `[委派任务]\n\n目标: ${goal}\n\n上下文:\n${context}\n\n请完成上述任务并返回结果摘要。`
      : `[委派任务]\n\n目标: ${goal}\n\n请完成上述任务并返回结果摘要。`) + artifactDiscipline

  const ownBaseline = input.taskboardControl ? {
    input: session.totalInputTokens ?? 0,
    output: session.totalOutputTokens ?? 0,
    cost: (session.totalCostUSD ?? 0) > 0 || !(session.totalInputTokens || session.totalOutputTokens)
      ? session.totalCostUSD ?? 0 : null,
    imprecise: session.costImprecise === true,
  } : undefined
  const _dlgRun = this._runLog.start({
    agentId: targetAgentId,
    sessionKey,
    taskType: 'delegate',
    ...(isReview ? { isReview: true } : {}),
  })
  let output = ''
  let error = ''
  let timedOut = false
  let cancelled = false
  // P2 债C — review 委派结束时从审查输出解析出的结构化裁决(PASS/NEEDS_FIX);
  // 非 review / 解析不出 → undefined(编排据 undefined 走降级放行)。
  let verdict: ReviewVerdict | undefined
  let ownGoalUsageRecord: DurableGoalUsageRecord | undefined
  let submitSettled = false
  const timeoutConfig =
    this._delegateTimeoutConfig ?? resolveDelegateTimeoutConfig(process.env, input.idleTimeoutMs)
  let timeoutTimer: NodeJS.Timeout | null = null
  const clearTimeoutTimer = () => {
    if (timeoutTimer) clearInterval(timeoutTimer)
    timeoutTimer = null
  }
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setInterval(() => {
      const reason = getDelegateTimeoutReason(Date.now(), lastChildActivityAt, timeoutConfig)
      if (!reason) return
      clearTimeoutTimer()
      const err = new Error(reason.message)
      err.name = 'DelegateTimeoutError'
      reject(err)
    }, timeoutConfig.checkIntervalMs)
  })
  if (input.taskboardControl?.signal.aborted) {
    clearTimeoutTimer()
    detachAncestorActivity?.()
    await this.sessions.destroySession(sessionKey)
    return cancelPreparation(grokRouteLease, engineBillingAdmission)
  }
  const submitPromise = this.sessions.submit(
    session,
    prompt,
    (e) => {
      if (e.kind === 'block') durableTranscript.push(e.block)
      else if (e.kind === 'error') durableTranscript.push({ kind: 'error', error: e.error })
      else if (e.kind === 'final') {
        durableTranscript.push({ kind: 'final', meta: e.meta })
        if (session._platformGoal?.status === 'active') {
          ownGoalUsageRecord = {
            runId: progressRunId,
            agentId: targetAgentId,
            engine: session.runner.engineId === 'codex' ? 'codex' : 'ccb',
            inputTokens: e.meta?.inputTokens ?? ownGoalUsageRecord?.inputTokens ?? 0,
            outputTokens: e.meta?.outputTokens ?? ownGoalUsageRecord?.outputTokens ?? 0,
            cacheReadTokens: e.meta?.cacheReadTokens ?? ownGoalUsageRecord?.cacheReadTokens ?? 0,
            cacheCreationTokens:
              e.meta?.cacheCreationTokens ?? ownGoalUsageRecord?.cacheCreationTokens ?? 0,
          }
        }
      } else if (e.kind === 'codex_billing') {
        if (session._platformGoal?.status === 'active') {
          // Billing is emitted before the parser's final event. Preserve it as
          // a crash/exit fallback; a later final event overwrites only fields
          // it actually observed.
          ownGoalUsageRecord = {
            runId: progressRunId,
            agentId: targetAgentId,
            // cursorAdapter also emits durable billing (engine:'cursor');
            // codex/grok billing carries no discriminator.
            engine: e.engine === 'cursor' ? 'cursor' : 'codex',
            inputTokens: e.usage?.input_tokens ?? ownGoalUsageRecord?.inputTokens ?? 0,
            outputTokens: e.usage?.output_tokens ?? ownGoalUsageRecord?.outputTokens ?? 0,
            cacheReadTokens:
              e.usage?.cache_read_input_tokens ?? ownGoalUsageRecord?.cacheReadTokens ?? 0,
            cacheCreationTokens:
              e.usage?.cache_creation_input_tokens ?? ownGoalUsageRecord?.cacheCreationTokens ?? 0,
          }
        }
        if (engineBillingAdmission) {
          const billing = { ...e } as DurableCodexBilling & { kind?: string }
          // biome-ignore lint/performance/noDelete: moved verbatim from server.ts (OCV5-473); pre-existing there
          delete billing.kind
          liveEngineBilling = billing
          // Settle immediately so a frame that arrives after the parent
          // tape was already drained still hits the live v3 settle route
          // (UNIQUE request_id). Failure is persisted to the Auto-Dream-
          // shaped retry queue inside the client.
          liveSettleTask = billingApi.settle(billing).catch((err) => {
            this.log.warn('delegate_engine_billing_settle_failed', {
              targetAgentId,
              sessionKey,
              requestId: billing.requestId,
              err: String(err),
            })
          })
        }
      }
      const progressBlock =
        e.kind === 'usage'
          ? makeDelegateUsageProgressBlock({
              runId: progressRunId,
              usageRunId: progressRunId,
              agentId: targetAgentId,
              usage: e.usage,
            })
          : makeDelegateBlockPassthrough(e, progressRunId, targetAgentId)
      if (progressBlock || e.kind === 'block' || e.kind === 'error') markChildActivity()
      if (!timedOut) {
        if (e.kind === 'block' && e.block.kind === 'text') output += e.block.text
        if (e.kind === 'error') {
          error = e.error
          cancelled = e.errorCode === 'user_cancelled'
          if (cancelled && input.taskboardControl?.rootSessionKey === sessionKey) input.taskboardControl.requestStop()
        }
        if (streamProgress) emitProgress(progressBlock)
      }
    },
    // P2 批次4 — effort 透传:子会话是新建的,首次 submit 的 effortLevel 在 runner
    // spawn 前生效(与顶层会话 safeEffortLevel 同法)。undefined = 不指定 → 成员默认档位。
    input.effort,
    delegateExec?.canonicalModel ?? requestedModel,
    engineBillingAdmission?.requestId,
    input.traceId,
    undefined,
    { platformGoal: session._platformGoal ?? null, ...(grokRoute ? { grokRoute } : {}) },
  )
  try {
    await Promise.race([submitPromise, timeoutPromise])
    submitSettled = true
    clearTimeoutTimer()
    if (!error) {
      const delegatedApiError = classifyDelegateOutputError(output)
      if (delegatedApiError) {
        error = `${delegatedApiError.message}\n\n${delegatedApiError.detail}`
      }
    }
    // P2 债C — review 委派干净完成(无 error)→ 从输出解析结构化 VERDICT 行。解析器
    // 认 PASS/FAIL/PARTIAL/NEEDS_FIX,passed=(verdict==='PASS')。审查员漏输出裁决行 →
    // parsed=null → verdict 保持 undefined → 编排判定"审查未完成"降级放行(fail-safe)。
    if (isReview && !error) {
      const parsedVerdict = parseVerificationVerdict(output)
      if (parsedVerdict) {
        verdict = parsedVerdict.passed ? REVIEW_VERDICT_PASS : REVIEW_VERDICT_NEEDS_FIX
      }
    }
    if (streamProgress) {
      emitProgress(
        makeDelegateProgressBlock({
          runId: progressRunId,
          agentId: targetAgentId,
          phase: error ? 'error' : 'done',
          isError: Boolean(error),
          text: error || output || '子 agent 已完成,无文本输出。',
          // This is the actual terminal child result, not a UI preview.
          // Keep it complete; large content is lazily mounted by the web UI.
          maxLen: Number.MAX_SAFE_INTEGER,
        }),
      )
    }
    this._runLog.complete(_dlgRun, {
      status: error ? 'failed' : 'completed',
      error: error || undefined,
      ...(verdict ? { verdict } : {}),
    })
  } catch (err: any) {
    error = error || err?.message || String(err)
    if (err?.name === 'DelegateTimeoutError') {
      timedOut = true
      clearTimeoutTimer()
      try {
        session.runner.interrupt()
      } catch {}
      // Preserve every frame racing with the timeout. Cooperative interrupt
      // gets one bounded window. If it still has not settled,
      // runner.shutdown() gets a diagnostic deadline and kills the complete
      // process group. Crucially, neither deadline is a persistence cutoff:
      // after shutdown starts we wait for the exact process generation's
      // stdout-close barrier and then for SessionManager to settle the turn.
      // Freezing a delegate card while the spool is still open would turn a
      // temporary runner stall into permanent loss of already-paid output.
      const drainMs = parseNonNegativeMs(
        'OPENCLAUDE_DELEGATE_INTERRUPT_DRAIN_MS',
        DELEGATE_INTERRUPT_DRAIN_DEFAULT_MS,
      )
      let settlement = await waitForDelegateSettlement(submitPromise, drainMs)
      if (!settlement.settled) {
        const shutdown = await waitForDelegateSettlement(
          Promise.resolve().then(() => session.runner.shutdown()),
          parseNonNegativeMs(
            'OPENCLAUDE_DELEGATE_SHUTDOWN_WAIT_MS',
            DELEGATE_SHUTDOWN_WAIT_DEFAULT_MS,
          ),
        )
        if (!shutdown.settled) {
          this.log.error('delegate force shutdown exceeded terminal deadline', {
            targetAgentId,
            sessionKey,
          })
        } else if (shutdown.error !== undefined) {
          this.log.error('delegate force shutdown failed after timeout', {
            targetAgentId,
            sessionKey,
            error: (shutdown.error as Error)?.message ?? String(shutdown.error),
          })
        }
        const drained = await waitForDelegateSettlement(
          session.runner.waitForOutputDrain(),
          parseNonNegativeMs(
            'OPENCLAUDE_DELEGATE_OUTPUT_DRAIN_WAIT_MS',
            DELEGATE_OUTPUT_DRAIN_WAIT_DEFAULT_MS,
          ),
        )
        if (!drained.settled) {
          // A descendant that survived the runner's process-group SIGKILL
          // still owns stdout. Stop waiting: the delegate call must return a
          // result to its caller instead of hanging on an escaped process.
          this.log.error('delegate output drain exceeded terminal deadline', {
            targetAgentId,
            sessionKey,
          })
        }
        // Every wait above is bounded, and an unbounded one here would hand
        // all of that back: a turn the runner never settles would hold this
        // delegate call — and its caller's HTTP request — open forever.
        settlement = await waitForDelegateSettlement(
          submitPromise,
          parseNonNegativeMs(
            'OPENCLAUDE_DELEGATE_SUBMIT_SETTLE_MS',
            DELEGATE_SUBMIT_SETTLE_DEFAULT_MS,
          ),
        )
        if (!settlement.settled) {
          this.log.error('delegate submit never settled after forced shutdown', {
            targetAgentId,
            sessionKey,
          })
        }
      }
      submitSettled = settlement.settled
      if (settlement.error !== undefined && settlement.error !== err) {
        this.log.warn('delegate submit settled after timeout with error', {
          targetAgentId,
          sessionKey,
          error: (settlement.error as Error)?.message ?? String(settlement.error),
        })
      }
    } else {
      // submit() rejected: the engine has a terminal outcome even if it is an error.
      submitSettled = true
    }
    if (streamProgress) {
      emitProgress(
        makeDelegateProgressBlock({
          runId: progressRunId,
          agentId: targetAgentId,
          phase: 'error',
          isError: true,
          text: error,
          maxLen: Number.MAX_SAFE_INTEGER,
        }),
      )
    }
    this._runLog.complete(_dlgRun, { status: 'failed', error })
  } finally {
    await input.taskboardControl?.waitForDescendants(sessionKey)
    clearTimeoutTimer()
    detachAncestorActivity?.()
    if (engineBillingAdmission) {
      if (liveSettleTask) {
        await liveSettleTask
      } else if (liveEngineBilling) {
        try {
          await billingApi.settle(liveEngineBilling)
        } catch (err) {
          this.log.warn('delegate_engine_billing_settle_failed', {
            targetAgentId,
            sessionKey,
            requestId: engineBillingAdmission.requestId,
            err: String(err),
          })
        }
      } else if (submitSettled) {
        // Engine reached a terminal state with no usage: close the journal.
        // Timeout/unsettled must NOT abandon — aborted journals are not
        // reopened by the durable reconciler, and a late codex_billing
        // frame would leak. Leave inflight for tape settle / 24h waiver.
        await billingApi.abandon(engineBillingAdmission.requestId).catch(() => {})
      } else {
        this.log.warn('delegate_engine_billing_kept_inflight', {
          targetAgentId,
          sessionKey,
          requestId: engineBillingAdmission.requestId,
          timedOut,
        })
      }
    }
    // F4:委派子会话 bg bash 的后终态 tail 经 per-session 串行链**异步**持久化,其入
    // _durableDelegateRuntimeEvents 收集器发生在持久化 acked|queued **之后**;下方
    // 摘取该收集器构造 DurableAgentGroup 前,必须 await 该链(且在清收集器引用之前),
    // 否则晚到的 queued tail 会丢出本 group。(不额外 waitForOutputDrain:turn 收尾
    // 已 drain 过 stdout,此处再 drain 会把 drain 边界外的迟到帧误纳入 transcript;
    // 只 await 已解析 tail 的折叠链即可。)
    try {
      await this.sessions.flushSessionTailFolding(session)
    } catch (err) {
      this.log.warn('delegate tail-fold flush before collection failed', {
        sessionKey,
        err: String(err),
      })
    }
    if (session._durableDelegateTranscript === durableTranscript) {
      session._durableDelegateTranscript = undefined
    }
    if (session._durableDelegateRuntimeEvents === durableRuntimeEvents) {
      session._durableDelegateRuntimeEvents = undefined
    }
    if (submitSettled && session._durableDelegateEngineBillings === durableEngineBillings) {
      session._durableDelegateEngineBillings = undefined
    }
    if (session._durableDelegateGoalUsageRecords === durableGoalUsageRecords) {
      session._durableDelegateGoalUsageRecords = undefined
    }
    unregisterDelegation?.()
    this._releaseDelegateSlot(slotOpts)
    // grok delegate 的 master 侧账号槽/路由上下文收尾(release 幂等且内部吞错,
    // 不会因清理失败让已完成的委派翻成失败)。
    if (grokRouteLease) await grokRouteLease.release()
    // 本次 delegate 的子会话(sessionKey 带时间戳,一次性)在生命周期内可能
    // 作为"父"再委派(hidden 审查员 / 嵌套成员);它收尾后计数键永远不会复用,
    // 两个 per-turn 计数器都清理防泄漏。注意清的是子会话自己的键,不动 delegateGuardKey
    //(父会话的额度要跨多次 delegate 累计,turn 边界才复位)。
    this._hiddenDelegateGuard.resetForParent(sessionKey)
    this._memberDelegateGuard?.resetForParent(sessionKey)
    // taskboard / 非 resumable:一次性子会话收尾即销毁(2026-07-07 warm runner 泄漏)。
    // HTTP/MCP resumable 走外层 _completeDelegateResumeClaim:await retireKeepResume
    // (杀 runner,保留 resume-map),占用栅栏在退休完成前不释放。
    if (!input.resumable) {
      const destroy = this.sessions.destroySession(sessionKey).catch((err) =>
        this.log.warn('delegate session destroy failed', { sessionKey, err: String(err) }),
      )
      if (input.taskboardControl) await destroy
    }
  }

  eventBus.emit(
    'agent.completed',
    createEvent('agent.completed', targetAgentId, {
      sessionKey,
      output: output.trim(),
      error: error || undefined,
    }),
  )

  // ── P2 债A — buffer this delegation as a server-authored team card ──
  //
  // A first-level group is buffered on the webchat leader and drains with
  // that turn's tape. Nested groups append their complete transcript to the
  // direct parent delegate's live collector; recursively this produces one
  // top-level card containing every descendant in execution order. If that
  // collector is unexpectedly absent, persist a separate top-level card
  // instead of silently losing the nested reply.
  const status: AgentGroupStatus = timedOut ? 'timeout' : error ? 'failed' : 'ok'
  const resultSummary = error ? error : output.trim()
  const goalUsageRecords = [
    ...(ownGoalUsageRecord ? [ownGoalUsageRecord] : []),
    ...durableGoalUsageRecords,
  ]
  // Engines push one `text` block per streaming delta into durableTranscript
  // (Cursor grok: one per token). Master maps `transcript` 1:1 to the team
  // card's `childBlocks`, and the web client prefers the longer server array
  // over its live-merged local card — so persist the merged form, matching
  // what the live reducers already render.
  const coalescedTranscript = coalesceDelegateTranscript(durableTranscript)
  {
    // INC-20260905-TIMELINE-BLANK diagnostics: a 20–32 MB agent-group tape
    // record was found behind a "blank bottom" report. Log the shape of every
    // oversized durable transcript so the next occurrence is attributable.
    const bytes = estimateTranscriptBytes(coalescedTranscript)
    if (bytes < 0 || bytes >= DELEGATE_TRANSCRIPT_WARN_BYTES || durableTranscript.length >= 2000) {
      const kinds: Record<string, number> = {}
      for (const b of coalescedTranscript) {
        const k = b && typeof b === 'object' ? String((b as { kind?: unknown }).kind ?? '?') : '?'
        kinds[k] = (kinds[k] ?? 0) + 1
      }
      this.log.warn('delegate transcript oversized', {
        runId: progressRunId,
        agentId: targetAgentId,
        parentSessionKey: progressTarget?.sessionKey ?? delegateParent?.sessionKey ?? null,
        rawBlocks: durableTranscript.length,
        coalescedBlocks: coalescedTranscript.length,
        bytes,
        kinds,
      })
    }
  }
  const durableGroup: DurableAgentGroup = {
    runId: progressRunId,
    agentId: targetAgentId,
    goal,
    status,
    ...(resultSummary.length > 0 ? { resultSummary } : {}),
    ...(coalescedTranscript.length > 0 ? { transcript: coalescedTranscript } : {}),
    ...(durableRuntimeEvents.length > 0 ? { runtimeEvents: durableRuntimeEvents } : {}),
    ...(durableEngineBillings.length > 0 || (engineBillingAdmission && !submitSettled)
      ? { engineBillings: durableEngineBillings }
      : {}),
    ...(goalUsageRecords.length > 0 ? { goalUsageRecords } : {}),
    completedAt: Date.now(),
    // P2 债C — 审查员委派行带上裁决,前端渲染「质量审查员 · PASS/未通过」。
    ...(verdict ? { verdict } : {}),
  }
  // OCV5-180 B1 — exact-owner 交付用本 invocation 冻结的 locator 闭包,
  // 不把 FIFO Map 当归属权威。progressTarget 存在但 launch 未能冻结 owner
  // 时不得 ownerless 写入当前(可能已是 T2) turn。
  const deliverDelegateGroupCard = (): void => {
    if (!progressTarget) return
    if (!delegateOwnerLocator) {
      this.log.warn('delegate card dropped: missing frozen owner locator', {
        runId: progressRunId,
      })
      return
    }
    const buffered = this.sessions.bufferPendingAgentGroup(
      progressTarget.sessionKey,
      durableGroup,
      delegateOwnerLocator,
    )
    if (!buffered) {
      this.sessions.deliverLateDelegateAgentGroup({
        owner: delegateOwnerLocator,
        group: durableGroup,
        sessionKey: progressTarget.sessionKey,
      })
    }
  }
  this._delegateOwnerByRunId?.delete(progressRunId)
  if (progressTarget && !nestedProgress) {
    deliverDelegateGroupCard()
  } else if (nestedProgress && delegateParent) {
    const directParent = this.sessions.getByKey(delegateParent.sessionKey)
    if (durableGroup.engineBillings && directParent?._durableDelegateEngineBillings) {
      directParent._durableDelegateEngineBillings.push(
        ...durableGroup.engineBillings.map((billing) => structuredClone(billing)),
      )
    }
    if (durableGroup.goalUsageRecords && directParent?._durableDelegateGoalUsageRecords) {
      directParent._durableDelegateGoalUsageRecords.push(
        ...durableGroup.goalUsageRecords.map((record) => structuredClone(record)),
      )
    }
    const parentTranscript = directParent?._durableDelegateTranscript
    if (Array.isArray(parentTranscript)) {
      // Flatten nested cards into the direct parent's child transcript in
      // execution order. Keep the original child blocks byte-for-byte and
      // add only a structural marker; failed/timeout text is repeated in
      // the marker because raw `kind:error` blocks are not UI-rendered.
      parentTranscript.push({
        kind: 'text',
        text:
          // biome-ignore lint/style/useTemplate: moved verbatim from server.ts (OCV5-473); pre-existing there
          `【嵌套委派 · ${targetAgentId}】\n目标：${goal}\n状态：${status}` +
          (status !== 'ok' && resultSummary ? `\n结果：\n${resultSummary}` : ''),
        _nestedDelegateRunId: progressRunId,
        _nestedDelegateAgentId: targetAgentId,
        _nestedDelegateStatus: status,
        _nestedDelegateCompletedAt: durableGroup.completedAt,
        ...(durableGroup.runtimeEvents
          ? { _nestedDelegateRuntimeEvents: durableGroup.runtimeEvents }
          : {}),
      })
      if (durableGroup.transcript) parentTranscript.push(...durableGroup.transcript)
    } else if (progressTarget) {
      // A broken/old direct-parent collector must degrade to a separate
      // durable card, never to silent loss. Same exact-owner contract: the
      // degraded top-level card still belongs to the frozen owner turn.
      deliverDelegateGroupCard()
    }
  }
  if (isDelegateInflightSurfaceEffective()) {
    try {
      const parentKey = progressTarget?.sessionKey ?? parentSessionKey
      const jobId = DelegateInflightSurfaceStore.resolveJobId(input.backgroundJobId, progressRunId)
      if (jobId && parentKey) {
        const surface = this._ensureDelegateInflightSurface()
        const snap = input.backgroundJobId
          ? this._delegateJobs?.snapshotOf(String(input.backgroundJobId))
          : undefined
        const fence = snap ? { fencingEpoch: snap.fencingEpoch, generation: snap.generation } : {}
        if (!surface.get(jobId)) {
          surface.upsertEnqueue({
            jobId,
            parentSessionKey: parentKey,
            agentId: targetAgentId,
            goal,
            runId: progressRunId,
            state: 'running',
            userId: progressTarget?.userId,
            nested: nestedProgress,
            ownerRunId: nestedProgress ? emitProgressRunId : undefined,
            ...fence,
          })
        }
        surface.foldTerminal({
          jobId,
          group: durableGroup,
          // Job CAS winner is authority: a killed/failed/cancelled job must
          // not be rewritten as completed by a late runner. Same-terminal
          // non-authoritative folds are rejected by the surface so a late
          // runner cannot replace the authoritative failure payload.
          state: snap && isDelegateTerminalState(snap.state) ? snap.state : 'completed',
          parentSessionKey: parentKey,
          userId: progressTarget?.userId,
          ...fence,
        })
      }
    } catch (err) {
      this.log.warn(
        'delegate inflight surface fold failed',
        { jobId: input.backgroundJobId, progressRunId },
        err as Error,
      )
    }
  }

  const priced = await resolveDelegateCostUsd({
    ...session,
    engine: session.providerTag,
    isError: Boolean(error),
  }).catch((err) => {
    if (!input.taskboardControl) throw err
    this.log.warn('taskboard reference price unavailable; preserving paid output', { sessionKey, err: String(err) })
    return { costUsd: null, costImprecise: true }
  })
  return {
    kind: 'completed',
    ok: !error,
    // Every child reply is paid output. Return it to the leader verbatim;
    // artifact-discipline prompting may encourage files but never authorizes
    // the platform to cut the actual response.
    output: output.trim(),
    error: error || undefined,
    timedOut,
    cancelled,
    actualModel: session.runner.model || session.model || undefined,
    runId: progressRunId,
    verdict,
    // destroySession 是 fire-and-forget,此时 session 对象还在内存,用量从这里抄。
    // usage_log 是 eventBus 异步,return 时多半还没落盘,不能只靠它。
    tokensIn: ownBaseline ? (session.totalInputTokens >= ownBaseline.input ? session.totalInputTokens - ownBaseline.input || null : null) : session.totalInputTokens || null,
    tokensOut: ownBaseline ? (session.totalOutputTokens >= ownBaseline.output ? session.totalOutputTokens - ownBaseline.output || null : null) : session.totalOutputTokens || null,
    costUsd: ownBaseline ? (priced.costUsd != null && ownBaseline.cost != null && priced.costUsd >= ownBaseline.cost ? priced.costUsd - ownBaseline.cost : null) : priced.costUsd,
    costImprecise: priced.costImprecise || ownBaseline?.imprecise,
  }
}

/**
 * taskboard 巡检的 delegate 适配器。同进程直调 _runDelegateTask,才能拿到
 * timedOut;sessionKey / channel 走巡检专用形状,不进主会话列表。
 */
export async function _runTaskboardDelegate(
  this: DelegateRuntimeHost,
  input: import('./taskboard/patrol.js').PatrolDelegateInput,
): Promise<import('./taskboard/patrol.js').PatrolDelegateResult> {
  const result = await this._runDelegateTask({
    targetAgentId: input.agentId,
    goal: input.goal,
    context: input.context,
    sourceAgent: 'taskboard',
    modelPolicy: 'taskboard-stage-agent-auto',
    delegationGuardOwnerKey: `taskboard-run:${input.sessionKey}`,
    taskboardControl: input.control,
    toolsets: input.toolsets ?? undefined,
    depth: 0,
    effort: input.effort ?? undefined,
    model: input.model,
    sessionKey: input.sessionKey,
    channel: 'taskboard',
    idleTimeoutMs: input.timeoutSec * 1_000,
    projectId: input.projectId,
    workspaceCwd: input.workspaceCwd,
    runContext: input.runContext,
    frozenProjectContext: input.frozenProjectContext,
  })
  await input.control?.waitForDescendants(input.sessionKey)
  const children = input.control?.childResults() ?? []
  const ownOutput = result.kind === 'completed' ? result.output : ''
  const childOutput = children.map((child) => [
    `### 子任务 · ${child.agentId}`,
    `执行模型：${child.actualModel ?? '未记录'}${child.cancelled ? ' · 已停止' : child.error ? ' · 失败' : ' · 已完成'}`,
    child.output,
    child.error ? `执行说明：${child.error}` : '',
  ].filter(Boolean).join('\n\n')).join('\n\n')
  const output = childOutput ? `## 子任务执行记录\n\n${childOutput}\n\n---\n\n## 主任务结果\n\n${ownOutput}` : ownOutput
  if (result.kind !== 'completed') {
    return { ok: false, output, summaryOutput: ownOutput, error: result.message, cancelled: result.kind === 'rejected' && (result.cancelled === true || result.failureClass === 'cancelled'), usageIncludesDescendants: children.length > 0, costImprecise: true }
  }
  const members = [result, ...children]
  const sumKnown = (field: 'tokensIn' | 'tokensOut' | 'costUsd') => members.every((member) => typeof member[field] === 'number')
    ? members.reduce((sum, member) => sum + (member[field] as number), 0) : null
  return {
    ok: result.ok && !result.timedOut,
    summaryOutput: result.output,
    usageIncludesDescendants: children.length > 0,
    output,
    error: result.error,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    tokensIn: sumKnown('tokensIn'),
    tokensOut: sumKnown('tokensOut'),
    costUsd: sumKnown('costUsd'),
    costImprecise: members.some((member) => member.costImprecise === true) || members.some((member) => member.costUsd == null),
  }
}

/** 内存水位读取的实例挂钩:生产=模块级 readDelegateMemoryPressure(cgroup 文件),
 *  测试直接覆写本方法注入假读数。 */
export function _readDelegateMemoryPressure(
  this: DelegateRuntimeHost,
): { current: number; max: number; ratio: number } | null {
  return readDelegateMemoryPressure()
}

export type TryReserveDelegateSlotOpts = {
    parentBucketKey?: string
    isReview?: boolean
  }

/** 预占一个并发名额(判定+自增在同一同步段,单线程下原子,等待者间无超发);
 *  被闸拦截则返回原因、不占名额。P2 债C:非 review + 有父桶 → 同步 bump per-parent 运行计数。 */
export function _tryReserveDelegateSlot(
  this: DelegateRuntimeHost,
  opts?: TryReserveDelegateSlotOpts,
): DelegateGateBlock | null {
  const blocked = this._checkDelegateResourceGate(opts)
  if (blocked) return blocked
  this._activeDelegations++
  if (opts && !opts.isReview && opts.parentBucketKey) {
    const m = (this._runningDelegationsByParent ??= new Map())
    m.set(opts.parentBucketKey, (m.get(opts.parentBucketKey) ?? 0) + 1)
  }
  return null
}

export type ReleaseDelegateSlotOpts = {
    parentBucketKey?: string
    isReview?: boolean
  }

/** 释放一个已预占的并发名额(全局 + per-parent)。所有过闸后的路径必须经此释放,
 *  与 _tryReserveDelegateSlot 的增量口径严格对称(否则 per-parent 计数漂移锁死后续委派)。 */
export function _releaseDelegateSlot(
  this: DelegateRuntimeHost,
  opts?: ReleaseDelegateSlotOpts,
): void {
  this._activeDelegations--
  if (opts && !opts.isReview && opts.parentBucketKey) {
    const m = (this._runningDelegationsByParent ??= new Map())
    const cur = m.get(opts.parentBucketKey) ?? 0
    if (cur <= 1) m.delete(opts.parentBucketKey)
    else m.set(opts.parentBucketKey, cur - 1)
  }
}

export type WaitForDelegateCapacityResult = | { status: 'ok' }
  | { status: 'queue_full'; blocked: DelegateGateBlock }
  | { status: 'timeout'; blocked: DelegateGateBlock; waitedMs: number }
  | { status: 'aborted'; waitedMs: number }

export type WaitForDelegateCapacityArgs = {
    sessionKey: string
    /** P2 债C/3.5 — per-parent 分桶键(队长会话 sessionKey);缺省 → 只走全局闸。 */
    parentBucketKey?: string
    /** P2 债C — review 委派:走保留槽、豁免 per-parent 桶。 */
    isReview?: boolean
    onQueued?: (blocked: DelegateGateBlock) => void
  }

/**
 * delegate 资源闸有界排队:命中「并发 ≥ 上限」或「内存 ≥ 阈值」→ 轮询复查等待
 * 放行,而非立即 429/503(历史实况:并行 fanout 同秒双拒,队长收 503 后放弃委派
 * 自己兜底)。放行时已同步预占并发名额,调用方所有后续路径必须负责释放。
 *
 * 溯源:P5(f7453f4d)曾为旧重团队轨实现过"撞闸排队"(teamRunStore DB FIFO 队列),
 * 07-02 双轨清理(1ca107a8)删除旧 team_run 子系统时**连带**删除(非有意废弃)。
 * 本实现改为进程内等待收口:gateway 是容器内单进程,内存计数即权威,无需 DB 队列,
 * 且对所有 delegate(普通成员/hidden 审查员/嵌套)统一生效。
 *
 * 边界:
 * - 等待封顶 OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS(默认 90s)→ 'timeout';
 * - 排队人数封顶 DELEGATE_QUEUE_MAX_WAITERS(8,防雪崩)→ 'queue_full'(不等待);
 * - 用户 Stop 级联经 _delegateQueueWaiters 回调即时唤醒 → 'aborted';
 * - 无放行顺序保证(非 FIFO):等待者靠轮询抢占,依赖公平性的场景目前不存在。
 */
export async function _waitForDelegateCapacity(
  this: DelegateRuntimeHost,
  args: WaitForDelegateCapacityArgs,
): Promise<
  WaitForDelegateCapacityResult
> {
  const reserveOpts = { parentBucketKey: args.parentBucketKey, isReview: args.isReview }
  const first = this._tryReserveDelegateSlot(reserveOpts)
  if (!first) {
    // SM 'wait' 预占的占位 waiter 在这里放行 → 必须一并删除,否则占位永久计入
    // DELEGATE_QUEUE_MAX_WAITERS(后续全部 queue_full)。只碰已存在的表:无压力快路径
    // 不得初始化等待者表(delegateResourceQueue 契约)。
    this._delegateQueueWaiters?.delete(args.sessionKey)
    return { status: 'ok' }
  }
  const waiters = (this._delegateQueueWaiters ??= new Map())
  const preAdmitted = waiters.has(args.sessionKey)
  if (!preAdmitted && waiters.size >= DELEGATE_QUEUE_MAX_WAITERS) {
    return { status: 'queue_full', blocked: first }
  }
  const waitBudgetMs = parseDelegateQueueWaitMs()
  const pollMs = Math.max(1, this._delegateQueuePollMs ?? DELEGATE_QUEUE_POLL_DEFAULT_MS)
  const clock = this._delegateMonotonicMs ?? (() => Number(process.hrtime.bigint() / 1_000_000n))
  const startedAt = clock()
  let aborted = false
  let wake: (() => void) | null = null
  const prevAbort = waiters.get(args.sessionKey)
  waiters.set(args.sessionKey, () => {
    aborted = true
    wake?.()
    prevAbort?.()
  })
  try {
    args.onQueued?.(first)
    let lastBlocked = first
    while (true) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = null
          resolve()
        }, pollMs)
        wake = () => {
          clearTimeout(timer)
          wake = null
          resolve()
        }
      })
      if (aborted || this._shuttingDown) {
        return { status: 'aborted', waitedMs: clock() - startedAt }
      }
      const blocked = this._tryReserveDelegateSlot(reserveOpts)
      if (!blocked) return { status: 'ok' }
      lastBlocked = blocked
      if (clock() - startedAt >= waitBudgetMs) {
        return { status: 'timeout', blocked: lastBlocked, waitedMs: clock() - startedAt }
      }
    }
  } finally {
    waiters.delete(args.sessionKey)
  }
}

/**
 * SM: undo whatever `_admitDelegateCreate` reserved for this input (running slot or
 * waiter entry) when `_runDelegateTaskCore` rejects BEFORE reaching the capacity gate
 * (depth / per-turn guard / agent not found / catalog reject / team-review 409 …).
 *
 * 2026-09-06 事故:这些早退路径原本不释放 → `_activeDelegations` 与 per-parent 计数
 * 只增不减(6 个 MODEL_CATALOG_UNAVAILABLE 拒绝 = 6 个幽灵槽位),随后所有委派
 * `too many concurrent delegations (in-use 7/7)` 等满 300s 后 429。
 * Idempotent:释放后清 flag,重复调用无副作用(与 gate 后的 finally 释放互斥)。
 */
export function _releasePreadmittedDelegateCapacity(
  this: DelegateRuntimeHost,
  input: RunDelegateInput,
): void {
  if (input.capacityReserved) {
    this._releaseDelegateSlot(input.capacitySlotOpts)
    input.capacityReserved = false
  }
  if (input.capacitySlotOpts && input.sessionKey) {
    this._delegateQueueWaiters?.delete(input.sessionKey)
  }
  input.capacitySlotOpts = undefined
}

/**
 * SM: admit Enqueue and job create in one synchronous step.
 * 'slot' = already reserved a running slot; 'wait' = reserved a waiter; 'full' = no row.
 */
export function _admitDelegateCreate(
  this: DelegateRuntimeHost,
  sessionKey: string,
  opts: { parentBucketKey?: string; isReview?: boolean },
): 'slot' | 'wait' | 'full' {
  const blocked = this._tryReserveDelegateSlot(opts)
  if (!blocked) return 'slot'
  const waiters = (this._delegateQueueWaiters ??= new Map())
  if (waiters.size >= DELEGATE_QUEUE_MAX_WAITERS) return 'full'
  waiters.set(sessionKey, () => {})
  return 'wait'
}

export type ApplyDelegateCapacityRejectArgs = {
    httpStatus: number
    message: string
    failureClass?: DelegateFailureClass
    drop: boolean
  }

/**
 * Capacity reject must not leave an executable job, and must not fail a job
 * that already lost the race to claimQueued. Single-threaded Map ops make
 * settle vs claim exclusive; this just chooses drop / fail / already-dispatched
 * on the production write path (not later in the async `.then`).
 */
export function _applyDelegateCapacityReject(
  this: DelegateRuntimeHost,
  input: RunDelegateInput,
  args: ApplyDelegateCapacityRejectArgs,
): DelegateTaskResult {
  const jobId = input.backgroundJobId
  const store = this._delegateJobs
  if (jobId && store) {
    if (store.smEnabled) {
      const outcome = store.settleCapacityReject(jobId, {
        failureClass: args.failureClass ?? 'capacity_timeout',
        detail: args.message,
        httpStatus: args.httpStatus,
        drop: args.drop,
        nextState: args.failureClass === 'cancelled' ? 'cancelled' : 'failed',
      })
      if (outcome === 'claimed') {
        return {
          kind: 'rejected',
          httpStatus: args.httpStatus,
          message: args.message,
          failureClass: args.failureClass,
          alreadyDispatched: true,
        }
      }
    } else {
      store.complete(jobId, {
        httpStatus: args.httpStatus,
        body: {
          error: args.message,
          ...(args.failureClass ? { failure_class: args.failureClass } : {}),
        },
      })
    }
  }
  return {
    kind: 'rejected',
    httpStatus: args.httpStatus,
    message: args.message,
    failureClass: args.failureClass,
  }
}
