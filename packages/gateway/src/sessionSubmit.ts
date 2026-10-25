import type { GrokExecutionDescriptor } from '@openclaude/protocol'
/**
 * Session submit path: submit, getOrCreate / exclusive create, idle finish, external turns, resume-id resolution
 *
 * Moved verbatim out of SessionManager (sessionManager.ts) — FINDINGS §7.6, OCV5-476. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. SessionSubmitHost lists exactly the SessionManager members this code
 * touches (typed from the class itself).
 */
import {
  getDesiredIntelligentUi,
  intelligentUiNeedsRestart,
  isIntelligentUiApplied,
} from './intelligentUiDesired.js'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  resolveRuntimeExecutionAgent,
  IdentityAssetsError,
  type AgentDef,
  getEngineContextMessages,
  getMaxTurnIdx,
  hasPersistedTurnActivity,
  indexTurn,
  MemoryDir,
  type MemoryTurnPolicyDecision,
  classifyMemoryTurnPolicy,
  inheritMemoryTurnPolicy,
  readMemoryTurnPolicy,
  getTurnDispatchByDispatchId,
  reserveTurnIndex,
  paths,
  projectSessionFingerprint,
  loadProjectContext,
  skillOverlayManifestSha256,
  type KernelFileLock,
} from '@openclaude/storage'
import {
  advanceIdleOp,
  boxTurnMayIdle,
  currentIdleSource,
  idleAbandonReason,
  idleApplyStuckReason,
  idleCandidateAgedOut,
  idleOpSettled,
  idleProofWaitMs,
  pruneIdleOps,
  sourceNeedsIdleOp,
  type IdleOp,
  IDLE_COMPACT_PROMPT,
  IdleCompactRejected,
  idleHistoryStillBlocked,
  idleSummaryAccepted,
  nativeShortForOp,
  clearIdleCandidate,
  readIdleCandidate,
  readIdleNative,
  readIdleOp,
  readPendingIdle,
  startIdleOp,
  withIncarnationShutdown,
  writeIdleCandidate,
  writeIdleNative,
  writeIdleOp,
} from './boxIdleCompact.js'
import { fetchBoxIdleProof, type IdleProofResponse } from './engine/boxIdleProofClient.js'
import { notifyBoxUserStop } from './engine/boxUserStopClient.js'
import { IdleTurnTimeoutError, runBoxIdleTurn } from './boxIdleTurn.js'
import {
  cursorSandBoxCcResumeInnerId,
  cursorSandOfficialCcResumeInnerId,
  cursorResumeStoreExists,
  cursorSandResumeInnerId,
  isCursorSandBoxCcResumeId,
  isAnyCursorSandResumeId,
  relocateCursorResumeStore,
  usableCursorResumeId,
} from './engine/cursorAdapter.js'
import { pickResumableId, probeResumeArtifact } from './engine/resumeArtifacts.js'
import type { AutomaticRetryState, CollabAgentPolicy } from './engine/engineAdapter.js'
import type { SessionStreamEvent } from './engine/engineEvents.js'
import {
  createEngine,
  EngineNotEnabledError,
  isEngineEnabled,
  resolveEngine,
} from './engine/registry.js'
import { isEngineLocalTurnExempt, isModelAuthorityRequired } from './modelAuthority.js'
import type { CodexProviderConfigOverride } from './engine/codexShared.js'
import type { GrokRouteOverride } from './engine/grokAdapter.js'
import type { ZcodeRouteOverride } from './engine/zcodeAdapter.js'
import type { AntigravityRouteOverride } from './engine/antigravityAdapter.js'
import { eventBus, createEvent } from './eventBus.js'
import { CCB_PROVIDER_TAG, normalizeEngineTag } from './resumeStore.js'
import { adoptRunContext } from './runContextPersist.js'
import { deriveLosslessTurnKey, getV3MasterSinkOrNull } from './v3MasterSink.js'
import {
  AUTHORITY_TURN_MAX_LIFETIME_MS,
  collectModelHistoryMediaPathHints,
  modelHistorySemanticRole,
  modelHistorySemanticText,
  type GoalStateSnapshot,
  type ServiceTier,
  type SessionWorkspaceMode,
} from '@openclaude/protocol'
import { resolveExecutionModel } from './server.js'
import { isCcbSlashCommandPrompt } from './ccbNativeCompaction.js'
import type { TurnModelAuthority, UsageAttributionTag } from './subprocessRunner.js'
import { startMemoryTurnPolicyLease } from './memoryTurnPolicyLease.js'
import { finalizeEfficiencyTurn, prepareEfficiencyTurnNote } from './agentEfficiencyGuard.js'
import { log } from './sessionManagerLog.js'
import {
  resolveDefaultWorkspaceCwd,
  isCommercialManagedRuntime,
  assertPromptQueueExecutionAdmission,
  normForCompare,
  historicalContextInjectionKey,
  providerGapMessagesAfterOwnTurn,
  buildHistoricalContextPrompt,
  buildNativeModelHandoffPayload,
  shouldAttemptHistoricalContextInjection,
  shouldEmitContextRebuilt,
  pickIdleTimeoutMs,
  shouldTripIdleWatchdog,
  scheduleSessionOutputAssetCollection,
  persistServerAuthoredTurnOutcome,
  activeGoalAttribution,
  RuntimeRecycleDrainingError,
} from './sessionManager.js'
import type {
  SessionManager,
  PromptQueueExternalTurnReservation,
  ChatHistoryMessage,
  PendingExternalExchange,
  AgentSession,
  PromptQueueExecutionFence,
} from './sessionManager.js'

export interface SessionSubmitHost {
  _ccbJsonlExists: SessionManager['_ccbJsonlExists']
  _costImpreciseFor: SessionManager['_costImpreciseFor']
  _cursorWorkspacePath: SessionManager['_cursorWorkspacePath']
  _cursorWorkspacePathForSession: SessionManager['_cursorWorkspacePathForSession']
  _enterSessionCreateGate: SessionManager['_enterSessionCreateGate']
  _forgetResumeEntry: SessionManager['_forgetResumeEntry']
  _getOrCreateExclusive: SessionManager['_getOrCreateExclusive']
  _getRepoSnapshot: SessionManager['_getRepoSnapshot']
  _lastCostFor: SessionManager['_lastCostFor']
  _markResumeRejected: SessionManager['_markResumeRejected']
  _ownsPromptQueueExecutionFence: SessionManager['_ownsPromptQueueExecutionFence']
  _promptQueueDispatchFences: SessionManager['_promptQueueDispatchFences']
  _promptQueueExecutionKeys: SessionManager['_promptQueueExecutionKeys']
  _promptQueueExecutions: SessionManager['_promptQueueExecutions']
  _pushResumeHistory: SessionManager['_pushResumeHistory']
  _releaseGrokResumeHead: SessionManager['_releaseGrokResumeHead']
  _resolveDurableResumeId: SessionManager['_resolveDurableResumeId']
  _resumeIdFor: SessionManager['_resumeIdFor']
  _resumeMap: SessionManager['_resumeMap']
  _resumeMapCostImprecise: SessionManager['_resumeMapCostImprecise']
  _resumeMapHistory: SessionManager['_resumeMapHistory']
  _resumeHeadPromotedFromHistory: SessionManager['_resumeHeadPromotedFromHistory']
  _resumeMapLastCost: SessionManager['_resumeMapLastCost']
  _resumeMapProvider: SessionManager['_resumeMapProvider']
  _resumeMapTimestamps: SessionManager['_resumeMapTimestamps']
  _resumeRejectedIds: SessionManager['_resumeRejectedIds']
  _saveResumeMap: SessionManager['_saveResumeMap']
  _sessionIdToKey: SessionManager['_sessionIdToKey']
  _trackPersistence: SessionManager['_trackPersistence']
  applyIdleResetIfRequested: SessionManager['applyIdleResetIfRequested']
  awaitResumeMapFlush: SessionManager['awaitResumeMapFlush']
  beginClientTurn: SessionManager['beginClientTurn']
  config: SessionManager['config']
  endClientTurn: SessionManager['endClientTurn']
  finishIdleUnderLock: SessionManager['finishIdleUnderLock']
  getOrCreate: SessionManager['getOrCreate']
  isRuntimeRecycleDraining: SessionManager['isRuntimeRecycleDraining']
  onCcbTaskNotification: SessionManager['onCcbTaskNotification']
  onCcbTaskNotificationDelivered: SessionManager['onCcbTaskNotificationDelivered']
  runOneTurnWithRetry: SessionManager['runOneTurnWithRetry']
  scheduleIdleDrain: SessionManager['scheduleIdleDrain']
  sessions: SessionManager['sessions']
}

// OCV5-297 idle helpers: module level so finishIdleUnderLock needs no `this` state.
/** Source proof is gone but an op is unfinished: only its own idle-turn
 * evidence (egress failed, or runner shut down + unseen past grace) settles
 * it. Never dispatches. */
async function settleStrandedIdleOp(
  session: AgentSession,
  op: IdleOp,
  recoveryDir: string,
): Promise<void> {
  // OCV5-620: apply-stuck settles even when a summary is prepared (that case
  // is intentionally excluded from idleAbandonReason).
  const evidenced = withIncarnationShutdown(recoveryDir, op)
  const applyStuck = idleApplyStuckReason(recoveryDir, evidenced)
  if (applyStuck) {
    log.warn('box idle op abandoned', {
      sessionKey: session.sessionKey,
      revision: op.revision,
      reason: applyStuck,
    })
    writeSettledIdleOp(recoveryDir, {
      ...evidenced,
      disposition: 'abandoned',
      abandonReason: applyStuck,
    })
    return
  }
  if (op.summaryText || readIdleNative(recoveryDir, op.sourceSessionId, op.revision)?.summaryText)
    return
  const idleProof = await fetchBoxIdleProof({
    sessionId: op.sourceSessionId,
    turnKey: op.idleTurnKey,
  })
  // Same authoritative evidence as a live op; a missing native file alone
  // does not prove nothing was sent. Otherwise only the operator reset exits.
  const reason = idleAbandonReason(evidenced, idleProof)
  if (!reason) return
  log.warn('box idle op abandoned', {
    sessionKey: session.sessionKey,
    revision: op.revision,
    reason,
  })
  writeSettledIdleOp(recoveryDir, { ...evidenced, disposition: 'abandoned', abandonReason: reason })
}

/** OCV5-377 (commercial uid 4, 10-11): the Box model answered an idle summary
 * turn with a tool call. Its CLI stayed parked on that handoff after the CCB
 * runner was killed; nothing can ever answer it, the open handoff kept the
 * source and summary proofs pending, and every next message of the session
 * was refused (IDLE_HISTORY_PENDING). Once the runner is proven dead, ask
 * egress to stop that run, as a browser Stop does (container-scoped, this
 * session and idle turn key only); its proof then reads failed and the op
 * settles as idle_turn_failed. Nothing is sent to a model. */
const IDLE_TURN_STOP_WAIT_MS = 30_000

async function stopParkedIdleTurn(op: IdleOp): Promise<void> {
  if (idleOpSettled(op) || op.summaryText || typeof op.runnerKilledAt !== 'number') return
  // Bounded: this runs under session.lock on the submit path. A stop that is
  // still running on egress past the budget completes there; the op then
  // settles on a later pass (Codex r1).
  const outcome = await notifyBoxUserStop(
    { sessionId: op.sourceSessionId, turnKey: op.idleTurnKey },
    { timeoutMs: IDLE_TURN_STOP_WAIT_MS },
  ).catch(() => 'pending' as const)
  if (outcome !== 'skipped') {
    log.info('box idle turn stop requested', {
      sessionKey: op.sessionKey,
      revision: op.revision,
      outcome,
    })
  }
}

/** Persist an op; once settled, rotate old settled files for the session. */
function writeSettledIdleOp(recoveryDir: string, op: IdleOp): void {
  writeIdleOp(recoveryDir, op)
  if (idleOpSettled(op)) pruneIdleOps(recoveryDir, op.sessionKey)
}

/** Bounded wait on a pending proof (1s, 2s, 4s, … within the budget). */
async function waitBoxIdleProof(input: {
  sessionId: string
  turnKey: string
}): Promise<IdleProofResponse> {
  const deadline = Date.now() + idleProofWaitMs()
  let delay = 1000
  for (;;) {
    const proof = await fetchBoxIdleProof(input)
    if (proof.status !== 'pending' || Date.now() + delay > deadline) return proof
    await new Promise((resolve) => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, 8000)
  }
}

async function computeSessionContextFingerprint(
  projectId: string | null | undefined,
  assetsRevision?: number,
): Promise<string> {
  const id = typeof projectId === 'string' ? projectId.trim() : ''
  if (!id) return projectSessionFingerprint({ projectId: null })
  try {
    const snap = await loadProjectContext(id)
    return projectSessionFingerprint({
      projectId: id,
      contextVersion: snap.version,
      assetsRevision,
      projectMdSha256:
        snap.meta.contentManifest?.projectMdSha256 ?? snap.meta.instructionsSha256 ?? null,
      skillManifestSha256: skillOverlayManifestSha256(snap.meta.contentManifest?.skills ?? []),
      officialMemoryManifestSha256: snap.meta.promotion.manifestSha256 ?? null,
    })
  } catch {
    return projectSessionFingerprint({ projectId: id, assetsRevision })
  }
}

function normalizeToolsetListForCompare(toolsets: unknown): string[] | undefined {
  if (!Array.isArray(toolsets) || toolsets.length === 0) return undefined
  const out: string[] = []
  for (const value of toolsets) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed || out.includes(trimmed)) continue
    out.push(trimmed)
  }
  return out.length > 0 ? out.sort() : undefined
}

function sameToolsetsForCompare(a: unknown, b: unknown): boolean {
  const left = normalizeToolsetListForCompare(a)
  const right = normalizeToolsetListForCompare(b)
  if (!left && !right) return true
  if (!left || !right) return false
  return left.length === right.length && left.every((value, idx) => value === right[idx])
}

function extractHistoryText(msg: ChatHistoryMessage): string {
  if (typeof msg.text === 'string') return msg.text
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part) => {
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text
          return typeof text === 'string' ? text : ''
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * Persist the authoritative server-authored assistant text for a turn.
 *
 * Two-mode dispatch:
 *
 *   1. v3 commercial (container has OPENCLAUDE_V3_MASTER_BASE_URL +
 *      OPENCLAUDE_V3_CONTAINER_TOKEN env): send via the container→master
 *      sink (V3MasterSink). Master writes to its own SQLite where the
 *      authoritative session row lives. The sink stages every v2 turn
 *      before its first network attempt and retains all non-410 failures.
 *      **userId is irrelevant on this path** — master derives it
 *      from the verified container identity, so we don't even bother
 *      looking it up here.
 *
 *   2. personal version / dev (no v3 sink configured): legacy path —
 *      `appendServerAuthoredMessageDurable` writes to the local SQLite
 *      with the local outbox fallback for DB-unavailable transients.
 *      Needs a userId because client_sessions is keyed (id, user_id) and
 *      the local DB IS authoritative for personal mode. Falls back to
 *      `getClientSession` lookup when the AgentSession didn't carry
 *      userId (cron pre-warm, legacy webchat callers).
 *
 * Returns Promise<boolean> that always resolves: true means 'acked'(权威库确认
 * 落库)或 legacy 'skipped'(该模式下无可落之物,非失败——逐值保持三态化前的既有
 * 布尔语义);false means 'queued'(仅可靠排队)或 'dropped'(写失败)。需要区分
 * 四态的调用方(tail 折叠)直接用 persistServerAuthoredTurnOutcome。
 * Errors are logged internally. Callers MUST track it so shutdown can
 * await pending writes via SessionManager.awaitPendingPersistence();
 * a process exit before the durable enqueue lands on disk would
 * silently lose the turn (Codex R2 BLOCK-1, the original bug we're
 * fixing — we cannot close the loop with fire-and-forget here).
 * Turn-end accounting paths (eventBus emits, FTS5 indexing) still
 * don't `await` it — they continue in parallel; the pending-set is
 * what makes shutdown wait, not the call sites.
 *
 * 本函数是 `persistServerAuthoredTurnOutcome` 的**布尔适配层**:`'acked'|'skipped'` 折成
 * true,`'queued'|'dropped'` 折成 false —— 与四态化前的既有语义**逐值一致**(sink 路径
 * ok→acked→true / queued|dropped→false;legacy 路径 undefined→skipped→true /
 * applied|already_exists→acked→true / queued_to_outbox→queued→false / 其余→dropped→false)。
 * 主 turn final 只认 acked 的判定完全不受影响。需要区分"已可靠排队 / 未持久化 / 永久丢弃"
 * 的调用方(如 post-terminal tail 折叠)改调 Outcome 版本。
 */
function persistServerAuthoredTurn(
  args: Parameters<typeof persistServerAuthoredTurnOutcome>[0],
): Promise<boolean> {
  return persistServerAuthoredTurnOutcome(args).then((r) => r === 'acked' || r === 'skipped')
}

class TurnIdleTimeoutError extends Error {
  readonly code = 'TURN_IDLE_TIMEOUT'
}

class TurnHardLimitError extends Error {
  readonly code = 'TURN_HARD_LIMIT'
  constructor() {
    super('turn reached the platform 12 hour execution limit')
  }
}

export async function submit(
  this: SessionSubmitHost,
  session: AgentSession,
  userTextOrBlocks: string | Array<{ type: string; [key: string]: unknown }>,
  onEvent: (e: SessionStreamEvent) => void,
  effortLevel?: string | null,
  model?: string,
  requestId?: string,
  traceId?: string,
  conversationMode?: 'default' | 'plan',
  opts?: {
    historicalMessages?: unknown[]
    /** v5 codex route 消费链(A1):dispatchInbound 校验后的 per-turn provider
     *  路由覆盖。每 turn 显式 set(null = 清除 stale route);仅 codex engine
     *  runner 实现 setCodexRoute,其余 runner duck-type 缺方法 → noop。 */
    codexRoute?: CodexProviderConfigOverride | null
    /** Grok CLI receives only this one-turn opaque loopback relay route. */
    grokRoute?: GrokRouteOverride | null
    grokExecutionDescriptor?: GrokExecutionDescriptor
    /** Master-authored recovery fence for a first-event silent engine turn.
     * Only Grok currently consumes it; arbitrary client input cannot set it. */
    resetNativeSession?: boolean
    /** ZCode CLI receives only this one-turn opaque loopback Anthropic relay. */
    zcodeRoute?: ZcodeRouteOverride | null
    /** Antigravity CLI: one-turn relay route + limited Google token (OCV5-415). */
    antigravityRoute?: AntigravityRouteOverride | null
    /** OCV5-434 GPT Fast, turn-level (frames.ts InboundMessage.serviceTier). 'fast' | null
     *  (explicit standard); omitted = leave the runner's current tier. Runners that do not
     *  implement setServiceTier ignore it. */
    serviceTier?: ServiceTier | null
    /** Master-authored platform goal snapshot for this exact turn. null
     * explicitly clears stale engine state; omission is for legacy callers. */
    platformGoal?: GoalStateSnapshot | null
    /** Chat project this turn resolved at its start; see AgentSession.turnChatProjectId. */
    turnChatProjectId?: string | null
    toolsets?: string[]
    collabAgentPolicy?: CollabAgentPolicy
    /** 模型权威批次 §4:本 turn 的上游请求凭据(master 签名 authority + turn lease)。
     *  只有 **bridge turn** 有(server.ts dispatchInbound 从验签产物 TurnExecutionDescriptor
     *  原样取出);cron/synthetic/delegate/train 等本地路径 submit 不传 —— CCB runner
     *  自取 `x-oc-local-catalog` token(方案 §3/§4),清位语义在 runner 内单一收口。 */
    modelAuthority?: TurnModelAuthority
    /** Remaining spendable credits (fen) captured at master admission. */
    creditBudgetFen?: bigint
    /** 长会话热尾巴+归档 §2.3:历史上下文兜底注入**成功后**回调,让上层
     *  (server.ts)发 sys.context_rebuilt 提示帧(boss 硬指标 3:引擎无法原生续接、
     *  走兜底注入时主动提醒用户)。仅 webchat leader turn 传;delegate/cron/train
     *  submit 不传 → 无用户可见提示。gateway-authored 决策,不进 engine event 流。 */
    emitContextRebuilt?: (info: { messageCount: number }) => void
    /** Active-turn reconnect lifecycle for one validated webchat user row.
     * Hooks are isolated from turn correctness: SessionManager logs and
     * ignores hook failures and always releases session.lock. */
    replayLifecycle?: {
      clientMessageId: string
      onStart: () => void
      onBeforeRelease: (unhandledError: unknown | undefined) => void
      onEnd: () => void
    }
    /** RFC-v5-durable-turn-dispatch §3 — durable inbox 准入身份(server.ts
     * dispatchInbound 从验签 descriptor 取出)。仅 webchat-DM durable turn 传;
     * 驱动 inbox running(先于模型)+ turn-end tape 带 dispatchId/attemptNo。 */
    dispatchContext?: AgentSession['_currentDispatch']
    /** Lifecycle owned by the PG prompt-queue coordinator. The reservation
     * hook runs after the real durable turn id is minted and before either
     * engine receives input. */
    queueLifecycle?: {
      readonly queueTurn: true
      onTurnReserved(reservation: {
        turnIndex: number
        turnKey: string
        traceId?: string
      }): Promise<void>
    }
    /** Token returned by beginPromptQueueExecutionFence(). */
    queueExecutionFence?: PromptQueueExecutionFence
    /** Shared browser/master/gateway automatic retry lineage. */
    automaticRetryState?: AutomaticRetryState
    /** Exact prepared-switch generation carried by the first target turn. */
    modelSwitchId?: string
    /** Native compact command authored by prepareModelSwitch itself. */
    modelSwitchInternal?: string
  },
): Promise<void> {
  const submitStartedAt = performance.now()
  // Resolve/rebuild a warm legacy runner under the existing creation gate,
  // before taking the per-turn lock. Never change its durable session key.
  // prepareModelSwitch owns this runner while performing native compaction.
  // It must not re-enter the creation gate that rejects concurrent switches;
  // the existing queue ownership and locked fresh-identity gates still apply.
  const preparingSwitchCompact =
    session._modelSwitchTransition?.state === 'preparing' &&
    opts?.modelSwitchInternal === session._modelSwitchTransition.id
  if (session._identityCreationOpts && !preparingSwitchCompact) {
    session = await this.getOrCreate({
      ...session._identityCreationOpts,
      ...(model ? { model } : {}),
      modelSwitchId: opts?.modelSwitchId,
      promptQueueExecutionFence: opts?.queueExecutionFence,
    })
  }
  if (this.isRuntimeRecycleDraining()) throw new RuntimeRecycleDrainingError()
  // Commercial PG is the only authoritative history. Never execute a paid
  // turn when the lossless container→master sink failed to initialize: the
  // legacy SQLite fallback is intentionally personal-only and is invisible
  // after a commercial relogin.
  if (isCommercialManagedRuntime() && getV3MasterSinkOrNull() === null) {
    log.error('commercial turn rejected: lossless sink unavailable', {
      sessionKey: session.sessionKey,
      agentId: session.agentId,
      channel: session.channel,
    })
    // Do not add a persistence-specific user notice. The turn never ran or
    // billed, and exposing a synthetic terminal frame would itself become
    // an unacknowledged reply that disappears after reconnect.
    return
  }
  // ── P0 计费旁路封堵(fail-closed 钱安全兜底,gateway seam 单一收口)────
  // engine-reported 计费的底座(codex,capabilities.needsServerRequestId=true)
  // 依赖 master bridge 注入的 server-owned requestId 关联 preCheck / inflight
  // journal / settle。commercial 运行时下 requestId 缺失 ⇒ 该 turn 绕过了
  // master 的 codex 分类(bridge 没做 preCheck、没开 journal)⇒ CodexAdapter
  // 不 emit billing ⇒ 免费 codex。此处按 capability 判定(不散点 engine 字符串
  // if/else),宁可拒 turn 也不静默白跑:任何入口(webchat/cron/tasks/delegate)
  // 落到 codex engine 都必须持有 server-owned requestId。
  // 个人版 / 测试环境(无 commercial env)不受影响 —— 无 bridge 也能跑 codex。
  // seam 合同校验的是**形状**而非仅存在性(Codex 复审 nit):bridge 生成的
  // server-owned requestId 恒为 32 hex;空串/畸形值同样意味着没走 bridge 的
  // preCheck/journal 路径,一律 fail-closed。
  if (
    session.runner.capabilities.needsServerRequestId &&
    !(typeof requestId === 'string' && /^[0-9a-f]{32}$/.test(requestId)) &&
    isCommercialManagedRuntime() &&
    // selfhost 豁免门(OC_SELFHOST_ENGINE_LOCAL_TURNS=1):单租户自用部署显式接受
    // 无 bridge 计费编排的 engine-reported turn(与 decideLocalExecution 真值表同源,
    // 语义/代价见 modelAuthority.isEngineLocalTurnExempt)。生产不设 -> fail-closed 不变。
    !isEngineLocalTurnExempt() &&
    opts?.modelSwitchInternal === undefined
  ) {
    log.error('codex turn rejected: missing/malformed server-owned requestId (billing guard)', {
      sessionKey: session.sessionKey,
      agentId: session.agentId,
      engineId: session.runner.engineId,
      requestIdShape: requestId === undefined ? 'undefined' : `len=${String(requestId).length}`,
      ...(traceId ? { traceId } : {}),
    })
    onEvent({
      kind: 'error',
      error:
        'CODEX_BILLING_GUARD: codex turn requires a server-owned requestId in commercial runtime — turn rejected (fail-closed)',
    })
    return
  }
  let transition = session._modelSwitchTransition
  if (
    transition?.state === 'prepared' &&
    transition.expiresAt !== undefined &&
    Date.now() >= transition.expiresAt
  ) {
    if (model === transition.sourceModel && opts?.modelSwitchId === undefined) {
      session._modelSwitchTransition = undefined
      transition = undefined
    } else {
      throw new Error('MODEL_SWITCH_EXPIRED')
    }
  }
  const internalSwitchCompact =
    transition !== undefined && opts?.modelSwitchInternal === transition.id
  let consumingModelSwitch = false
  if (transition && !internalSwitchCompact) {
    if (
      transition.state !== 'prepared' ||
      model !== transition.targetModel ||
      opts?.modelSwitchId !== transition.id
    ) {
      throw new Error('MODEL_SWITCH_IN_PROGRESS')
    }
    transition.state = 'consuming'
    consumingModelSwitch = true
  }

  if (opts?.creditBudgetFen !== undefined) {
    session._turnCreditBudgetFen = opts.creditBudgetFen
  }

  // 闭包捕获:即便后面再有 submit 也不会改这个常量
  const desiredEffort: string | undefined = effortLevel === null ? undefined : effortLevel
  const callerSpecifiedEffort = effortLevel !== undefined
  const desiredModel: string | undefined = model
  const callerSpecifiedModel = model !== undefined
  const callerSpecifiedToolsets = Object.prototype.hasOwnProperty.call(opts ?? {}, 'toolsets')
  const desiredToolsets = normalizeToolsetListForCompare(opts?.toolsets)

  const queueTurn = opts?.queueLifecycle !== undefined
  const ownsDispatchFence = this._ownsPromptQueueExecutionFence(
    session.sessionKey,
    opts?.queueExecutionFence,
  )
  if (opts?.queueExecutionFence && !ownsDispatchFence) {
    throw new Error('PROMPT_QUEUE_EXECUTION_INVARIANT: stale queue execution fence')
  }
  assertPromptQueueExecutionAdmission(
    queueTurn,
    session._activeTurnCount ?? 0,
    session._activeClientTurnCount ?? 0,
    this._promptQueueExecutions.has(session) ||
      this._promptQueueExecutionKeys.has(session.sessionKey) ||
      (this._promptQueueDispatchFences.has(session.sessionKey) && !ownsDispatchFence),
  )

  const prev = session.lock
  let release: () => void = () => {}
  let memoryTurnBarrier: KernelFileLock | undefined
  let memoryTurnPolicy: MemoryTurnPolicyDecision | undefined
  let memoryTurnPolicyLease: { stop: () => Promise<void> } | undefined
  let replayLifecycleStarted = false
  let unhandledTurnError: unknown | undefined
  const logicalTurnAbort = new AbortController()
  let logicalTurnRun: Promise<void> | null = null
  if (queueTurn) {
    this._promptQueueExecutions.add(session)
    this._promptQueueExecutionKeys.add(session.sessionKey)
  }
  session.lock = new Promise<void>((r) => (release = r))
  // turn-alive-heartbeat (Plan 1) — turn-level inFlight 真值源 ++。详见
  // AgentSession._activeTurnCount 注释。位置:lock 新建后、`await prev`
  // 前,即 **submit() 已接受、即将串行化执行** 的一刻起算。注意 scope:
  // 这覆盖 submit() 内的全部 subprocess respawn 窗口(phantom-turn /
  // auth-refresh / effort+model swap),但**不**覆盖 dispatchInbound 在
  // submit() 之前的预处理阶段(mkdir / writeFile / parseDocument 等),
  // 那是另一类同症状窗口,留作 Plan 1 follow-up。对应 -- 在下方 finally
  // 里 release() 旁边,保证 submit() promise settled(return / throw 都
  // 走 finally)前归零。
  session._activeTurnCount = (session._activeTurnCount ?? 0) + 1
  try {
    await prev
    log.info('turn_pipeline_timing', { traceId, stage: 'submit_lock_acquired', elapsedMs: performance.now() - submitStartedAt })
    if (opts?.modelSwitchInternal === undefined) await this.applyIdleResetIfRequested(session)
    const pendingIdle = readPendingIdle(paths.home, session.sessionKey)
    const idleCandidate = readIdleCandidate(paths.home, session.sessionKey)
    if ((pendingIdle || idleCandidate) && opts?.modelSwitchInternal === undefined) {
      await this.finishIdleUnderLock(session, {
        sessionId: pendingIdle?.sourceSessionId ?? idleCandidate!.sessionId,
        turnKey: pendingIdle?.sourceTurnKey ?? idleCandidate!.turnKey,
      })
      const still = readIdleCandidate(paths.home, session.sessionKey)
      const recovered = pendingIdle
        ? readIdleOp(paths.home, session.sessionKey, pendingIdle.revision)
        : undefined
      if (idleHistoryStillBlocked({ candidate: still, pending: pendingIdle, recovered })) {
        throw new IdleCompactRejected('IDLE_HISTORY_PENDING')
      }
    }
    session._boxContextOwner =
      opts?.modelAuthority?.executionDescriptor &&
      typeof (opts.modelAuthority.executionDescriptor as { contextOwner?: unknown })
        .contextOwner === 'string'
        ? (opts.modelAuthority.executionDescriptor as { contextOwner: string }).contextOwner
        : undefined
    // A deferred dispatch can be cancelled while its predecessor owns the lock.
    // Fence it before resume promotion / runner reconfiguration, not only before
    // submitTurn. This read does not replace the final queued -> running CAS:
    // a cancellation after this read is still handled by that authoritative CAS.
    if (opts?.dispatchContext) {
      const ctx = opts.dispatchContext
      // Lookup errors propagate fail-closed through the existing catch/finally.
      const current = await getTurnDispatchByDispatchId(ctx.dispatchId, ctx.attemptNo)
      if (
        current?.state === 'rejected' &&
        current.userId === ctx.userId &&
        current.sessionId === ctx.sessionId &&
        current.clientMessageId === ctx.clientMessageId &&
        current.dispatchId === ctx.dispatchId &&
        current.attemptNo === ctx.attemptNo
      ) {
        return
      }
    }
    // Every execution, including direct warm submits, explicit models, cron
    // and delegates, crosses this fresh authority gate AFTER its predecessor.
    // A successful getOrCreate/display sync is not permission for this turn.
    // Hermetic advisor/Auto-Dream sessions skip marketplace identity the same
    // way getOrCreate does — fetching it here would fail-closed the no-tools path.
    const hermeticNoTools = session._identityCreationOpts?.hermeticNoTools === true
    const admission = hermeticNoTools
      ? { agent: session._identityCreationOpts?.agent ?? { id: session.agentId }, context: {} }
      : await resolveRuntimeExecutionAgent(
          session._identityCreationOpts?.agent ?? { id: session.agentId },
        )
    if (admission.agent.id !== session.agentId) {
      throw new Error('COMPAT_CONFIG_CONFLICT: runner identity changed; reopen this session')
    }
    if (
      admission.context.assets &&
      session.providerTag !== 'ccb' &&
      admission.context.assets.effectivePermissionMode !== undefined &&
      admission.context.assets.effectivePermissionMode !== 'bypassPermissions'
    ) {
      throw new IdentityAssetsError(
        'COMPAT_PERMISSION_CONFLICT',
        'COMPAT_PERMISSION_CONFLICT: selected engine cannot enforce the registered permission mode',
      )
    }
    if (
      admission.context.assets &&
      session._identityAgentFingerprint !== JSON.stringify(admission.agent)
    ) {
      throw new Error(
        'COMPAT_CONFIG_CONFLICT: execution configuration changed while awaiting the safe turn boundary; retry',
      )
    }
    if (session._identityCompat) {
      const changed = session._identityCompat.fingerprint !== admission.context.fingerprint
      Object.assign(
        session._identityCompat,
        { assets: undefined, fingerprint: undefined },
        admission.context,
      )
      if (changed) await session.runner.shutdown() // native id is deliberately retained
    } else if (admission.context.assets && session.channel !== 'auto-dream') {
      throw new Error('COMPAT_CONFIG_CONFLICT: runner has no validated identity context')
    }
    // Browser Stop must own the complete logical turn, including the gap
    // between engine attempts while an automatic retry is backing off.
    session._externalTurnAbort = logicalTurnAbort
    if (opts?.replayLifecycle) {
      replayLifecycleStarted = true
      session._runningClientMessageId = opts.replayLifecycle.clientMessageId
      try {
        opts.replayLifecycle.onStart()
      } catch (err) {
        log.warn('active-turn replay start hook failed', { sessionKey: session.sessionKey }, err)
      }
    }
    // V5 native Write/Edit bypasses MemoryDir's userspace CAS lock. Hold a
    // shared kernel barrier for the complete foreground turn so Auto-Dream's
    // exclusive batch/recovery can neither overwrite nor roll back a live
    // model edit. The hermetic Auto-Dream model turn has no tools/memory and
    // must release before its later exclusive apply phase.
    if (isCommercialManagedRuntime() && session.channel !== 'auto-dream') {
      memoryTurnBarrier = await new MemoryDir(session.agentId).acquireSharedBarrier({
        totalBudgetMs: 60_000,
        perAttemptMs: 5_000,
        retryDelayMs: 100,
      })
    }
    // V3 S12e CG8 — contract C(best-effort)stash latest turn trace on runner
    // so that ANY re-spawn triggered inside this turn — effort/model change
    // shutdown(下方 effortChanged/modelChanged 分支)、phantom restart
    // (runOneTurnWithRetry)、auth refresh restart — picks it up via
    // `OPENCLAUDE_TRACE_ID` env at next spawn time. No effect on a long-lived
    // CCB process(env is read at fork); 后续 turn CCB 内部 trace 接收待 S11c
    // stdin JSON-RPC 扩展。Lock 保证 setTraceId 与并发 submit() 串行,不会
    // 跨 turn 互踩。
    log.info('turn_pipeline_timing', { traceId, stage: 'memory_barrier_acquired', elapsedMs: performance.now() - submitStartedAt })
    // OCV5-570: the runner also puts this trace on the turn's egress requests, so a trace-less turn
    // clears it rather than inheriting the previous turn's value. A defined trace keeps the hard call
    // (a runner missing the mandatory mutator must fail loudly); the clear is optional-called so test
    // doubles that never carried a trace keep working.
    if (traceId !== undefined) session.runner.setTraceId(traceId)
    else session.runner.setTraceId?.(undefined)
    // 市场使用信号(skillUsageReporter)读点:本 turn 的 canonical traceId 落到 session,
    // 供 tool.called(hub skill_view)上报方在 turn 执行期同步取到评分归因键。**无条件**
    // 赋值(含 undefined):清除上一 turn 残留,避免把旧 traceId 误配到本 turn 的使用事件。
    // 与上面的 runner.setTraceId 同点、同 lock 串行;单一权威仍是 master 注入的 turnTraceId。
    session._currentTurnTraceId = traceId
    // v5 codex route(A1):与 effort/model 同点、同 lock 串行地在 turn 启动前
    // 应用。CodexAppServerRunner 在 runTurn 顶部比对 route 签名,变化时自行
    // shutdown + respawn(spawn 期 -c 参数),这里只 stash,不参与下方
    // effort/model 的合并 shutdown。
    const maybeSetCodexRoute = (session.runner as any).setCodexRoute
    if (typeof maybeSetCodexRoute === 'function') {
      maybeSetCodexRoute.call(session.runner, opts?.codexRoute ?? null)
    }
    const maybeSetGrokRoute = (session.runner as any).setGrokRoute
    if (typeof maybeSetGrokRoute === 'function') {
      maybeSetGrokRoute.call(session.runner, opts?.grokRoute ?? null)
    }
    const maybeSetZcodeRoute = (session.runner as any).setZcodeRoute
    if (typeof maybeSetZcodeRoute === 'function') {
      maybeSetZcodeRoute.call(session.runner, opts?.zcodeRoute ?? null)
    }
    const maybeSetAntigravityRoute = (session.runner as any).setAntigravityRoute
    if (typeof maybeSetAntigravityRoute === 'function') {
      maybeSetAntigravityRoute.call(session.runner, opts?.antigravityRoute ?? null)
    }
    // effort + model 应用都必须在本 turn 真正启动**之前**完成,且必须在 prev 之后:
    //   - prev 之前:可能中断别人的 in-flight turn
    //   - 本 turn 之后:env / cli args 已被 CCB 启动时读完,改也无效
    // 同时受 lock chain 保护,后到的 submit 想 set 别的 effort/model 也得排在我们后面。
    // 把 effort/model 的 needsRestart 信号合并 → 一次 shutdown(下次 submit 自动 spawn 用新 effort+model)。
    const effortChanged = callerSpecifiedEffort && session.runner.effortLevel !== desiredEffort
    const modelChanged = callerSpecifiedModel && session.runner.model !== desiredModel
    const runnerToolsets = (session.runner as any).toolsets
    const maybeSetToolsets = (session.runner as any).setToolsets
    const toolsetsChanged =
      callerSpecifiedToolsets &&
      typeof maybeSetToolsets === 'function' &&
      !sameToolsetsForCompare(runnerToolsets, desiredToolsets)
    // Intelligent UI(OCV5-361):CCB/Codex 的系统提示在 spawn 时写死;开关切换后第一轮
    // 并入同一次 shutdown → 本次 submit 以 resume 重启并重建提示。拉取失败不重启。
    // 按内容指纹比(输入预测 OCV5-375 与组件协议同在这一段,单关其中一个也要重建)。
    const iuiApplied = (session.runner as { promptIntelligentUi?: unknown }).promptIntelligentUi
    const iuiChanged =
      isIntelligentUiApplied(iuiApplied) &&
      intelligentUiNeedsRestart(
        iuiApplied,
        await getDesiredIntelligentUi(session.sessionKey).catch(() => undefined),
      )
    if (effortChanged) session.runner.setEffortLevel(desiredEffort)
    if (modelChanged) {
      session.runner.setModel(desiredModel)
      // 同步更新 session.model,outbound 帧 / metrics / audit 都靠它,避免
      // 下次 spawn 前的窗口期 stale。runner.model 要等 spawn 才生效;但 shutdown
      // 已让 runner 死,窗口期内不会产生新 metrics —— session.model 提前对齐安全。
      // 最后兜底用 glm-5.3-zai(平台默认、v5 合法的静态 key 模型)。
      // 不再硬编码 claude-opus-4-7 —— Claude 官方模型已下线,那会造出非法默认 → spawn 失败。
      session.model = desiredModel ?? this.config.defaults.model ?? 'deepseek-v4-flash'
    }
    if (toolsetsChanged) {
      maybeSetToolsets.call(session.runner, desiredToolsets)
    }
    // OCV5-434 GPT Fast: applied after the model switch so the runner judges this turn's
    // effective model. CCB reads it from env at spawn (→ same single shutdown as effort);
    // Codex sends it per turn and never asks for a restart.
    const maybeSetServiceTier = (
      session.runner as {
        setServiceTier?: (tier: ServiceTier | null, model: string | undefined) => string
      }
    ).setServiceTier
    const serviceTierChanged =
      Object.prototype.hasOwnProperty.call(opts ?? {}, 'serviceTier') &&
      typeof maybeSetServiceTier === 'function' &&
      maybeSetServiceTier.call(
        session.runner,
        opts?.serviceTier === 'fast' ? 'fast' : null,
        modelChanged ? desiredModel : session.runner.model,
      ) === 'restart'
    if (effortChanged || modelChanged || toolsetsChanged || iuiChanged || serviceTierChanged) {
      try {
        await session.runner.shutdown()
        // Delta tracker reset happens automatically on the next 'spawn' event
        // when SubprocessRunner auto-respawns on the next submit().
      } catch (err) {
        log.warn(
          'effort/model/toolsets-change shutdown failed',
          // CG7 — traceId tagged so submit-layer failures join the turn's
          // outbound trace; ...(traceId ? ... : {}) keeps legacy callers
          // (no traceId arg) from inserting a `traceId: undefined` key.
          {
            sessionKey: session.sessionKey,
            effortChanged,
            modelChanged,
            toolsetsChanged,
            iuiChanged,
            serviceTierChanged,
            ...(traceId ? { traceId } : {}),
          },
          err,
        )
      }
    }
    if (Object.prototype.hasOwnProperty.call(opts ?? {}, 'platformGoal')) {
      const goal = opts?.platformGoal ? structuredClone(opts.platformGoal) : null
      session._platformGoal = goal
      await session.runner.setGoalState(goal)
    }
    // Under the turn lock: this turn's outputs go to the project it resolved
    // at start, even if a queued next message resolved another one.
    session.turnChatProjectId = Object.prototype.hasOwnProperty.call(
      opts ?? {},
      'turnChatProjectId',
    )
      ? opts?.turnChatProjectId
      : undefined
    session.lastUsedAt = Date.now()
    // Clear tool use mappings from previous turn to prevent unbounded growth
    session.toolUseIdToName.clear()
    // Reset per-turn accumulators for FTS5 indexing
    session.currentUserText =
      typeof userTextOrBlocks === 'string'
        ? userTextOrBlocks
        : userTextOrBlocks
            .filter((b) => b.type === 'text')
            .map((b) => (b as any).text ?? '')
            .join('\n')
    memoryTurnPolicy = session.parentSessionKey
      ? inheritMemoryTurnPolicy(await readMemoryTurnPolicy(session.parentSessionKey))
      : classifyMemoryTurnPolicy(session.currentUserText, session.channel)
    // Write before any model submission. A stale allow from a prior turn must
    // never survive an I/O failure into this turn, so failure aborts before
    // the runner sees input.
    memoryTurnPolicyLease = await startMemoryTurnPolicyLease({
      sessionKey: session.sessionKey,
      decision: memoryTurnPolicy,
      logicalTurnAbort,
      interrupt: () => session.runner.interrupt(),
      onRefreshFailure: (err) => {
        log.error('memory turn policy refresh failed; interrupting turn', {
          sessionKey: session.sessionKey,
          reason: memoryTurnPolicy?.reason,
          err: String(err),
        })
      },
    })
    session.currentAssistantBuf = ''
    // Reset activity baseline so idle timeout measures from turn start, not last stdout
    session.runner.lastActivityAt = Date.now()
    // Resume the per-session turn counter from the FTS index on the first
    // turn of this in-memory Session. `getOrCreate` initializes
    // `session.turns = 0` for every fresh AgentSession, so without this
    // every gateway/CCB lifecycle would start writing turn_idx 1, 2, 3 …
    // colliding with already-persisted rows for the same sessionKey and
    // breaking the frontend's per-(session_id, turn_idx) dedupe.
    // Must run BEFORE the auto-name block below: the auto-name guard
    // checks `session.turns === 0`, and we only want auto-name to fire
    // for genuinely-new sessions (no FTS history), not for resumed ones.
    // Legacy fallback: rows persisted before the FTS sessId was tightened
    // to sessionKey were keyed by ccbSessionId. The resume-map preserves
    // the last-known sessionKey→ccbSessionId mapping across restarts, so
    // we pass both ids and take the global max — otherwise pre-existing
    // sessions would silently restart turn_idx from 1.
    if (session.turns === 0) {
      const legacyId = this._resumeMap.get(session.sessionKey)
      const ids =
        legacyId && legacyId !== session.sessionKey
          ? [session.sessionKey, legacyId]
          : [session.sessionKey]
      session.turns = await getMaxTurnIdx(ids)
    }
    let runnerPayload = userTextOrBlocks
    const skipPromptRewrite =
      opts?.modelSwitchInternal !== undefined || isCcbSlashCommandPrompt(runnerPayload)
    try {
      if (!skipPromptRewrite) {
        const efficiencyNote = await prepareEfficiencyTurnNote(
          session,
          session.currentUserText ?? '',
        )
        if (efficiencyNote && typeof runnerPayload === 'string') {
          runnerPayload = `${efficiencyNote}\n\n${runnerPayload}`
        }
      }
    } catch (err) {
      log.debug('efficiency guard prepare failed', {
        sessionKey: session.sessionKey,
        err: String(err),
      })
    }
    const masterHistoricalMessages = Array.isArray(opts?.historicalMessages)
      ? opts.historicalMessages
      : null
    const mergePendingExternalHistory = (messages: unknown[]): unknown[] => {
      const pending = session._pendingExternalExchanges
      if (!pending?.length) return messages
      const ids = new Set(
        messages
          .filter(
            (raw): raw is { id: string } =>
              !!raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string',
          )
          .map((raw) => raw.id),
      )
      const remaining: PendingExternalExchange[] = []
      const merged = [...messages]
      for (const exchange of pending) {
        if (ids.has(exchange.assistant.id)) continue
        remaining.push(exchange)
        const hasEquivalentUser = merged.some((raw) => {
          if (!raw || typeof raw !== 'object') return false
          const msg = raw as ChatHistoryMessage
          return (
            msg.role === 'user' &&
            normForCompare(extractHistoryText(msg)) === normForCompare(exchange.user.text)
          )
        })
        if (!hasEquivalentUser && !ids.has(exchange.user.id)) merged.push(exchange.user)
        merged.push(exchange.assistant)
        ids.add(exchange.assistant.id)
      }
      session._pendingExternalExchanges = remaining.length > 0 ? remaining : undefined
      return merged
    }
    const effectiveMasterHistoricalMessages = masterHistoricalMessages
      ? mergePendingExternalHistory(masterHistoricalMessages)
      : null
    const contextOverflowHistoryChars =
      effectiveMasterHistoricalMessages?.reduce<number>((total, raw) => {
        if (!raw || typeof raw !== 'object') return total
        const msg = raw as ChatHistoryMessage
        if (msg.system === true || !modelHistorySemanticRole(msg)) return total
        return total + modelHistorySemanticText(msg).length
      }, 0) ?? 0
    const contextOverflowRetryInputs =
      effectiveMasterHistoricalMessages &&
      typeof userTextOrBlocks === 'string' &&
      contextOverflowHistoryChars > 0
        ? [4, 16, 64]
            .map((divisor) =>
              buildHistoricalContextPrompt(
                effectiveMasterHistoricalMessages,
                userTextOrBlocks,
                Math.max(1, Math.ceil(contextOverflowHistoryChars / divisor)),
              ),
            )
            .filter((prompt): prompt is string => prompt !== null)
        : []
    if (opts?.resetNativeSession === true && session.providerTag === 'grok') {
      await session.runner.shutdown()
      this._resumeMap.delete(session.sessionKey)
      this._resumeMapTimestamps.delete(session.sessionKey)
      this._resumeMapProvider.delete(session.sessionKey)
      this._resumeMapLastCost.delete(session.sessionKey)
      this._resumeMapHistory.delete(session.sessionKey)
      session.ccbSessionId = null
      session.runner.clearSessionId()
      this._saveResumeMap()
      await this.awaitResumeMapFlush()
      session._historicalContextInjected = false
      session._historicalContextInjectedKey = undefined
      session._contextRebuildNotice = 'native-resume-loss'
      log.warn('automatic recovery reset poisoned Grok native session', {
        sessionKey: session.sessionKey,
      })
    }
    const spawnCwd = this._cursorWorkspacePathForSession(session)
    const liveNativeId = session.runner.nativeSessionId
    const liveBoxId =
      session.providerTag === 'cursor' ? cursorSandBoxCcResumeInnerId(liveNativeId) : undefined
    const liveSandJsonlId =
      session.providerTag === 'cursor'
        ? (cursorSandResumeInnerId(liveNativeId) ?? cursorSandOfficialCcResumeInnerId(liveNativeId))
        : undefined
    const usableCursorId =
      session.providerTag === 'cursor'
        ? liveBoxId
          ? (liveNativeId ?? undefined)
          : liveSandJsonlId && this._ccbJsonlExists(liveSandJsonlId)
            ? (liveNativeId ?? undefined)
            : usableCursorResumeId({
                workspacePath: spawnCwd,
                liveId: liveNativeId,
                mappedId: this._resumeMap.get(session.sessionKey),
              })
        : undefined
    let providerResumeId =
      usableCursorId ?? this._resumeIdFor(session.sessionKey, session.providerTag, spawnCwd)
    if (
      providerResumeId &&
      session.runner.isResumeIdCompatible &&
      !session.runner.isResumeIdCompatible(providerResumeId)
    ) {
      log.info(
        'native resume belongs to a different engine transport — rebuilding bounded history',
        {
          sessionKey: session.sessionKey,
          provider: session.providerTag,
        },
      )
      session._forceHistoricalContextOnFirstTurn = true
      session._contextRebuildNotice ??= 'native-resume-loss'
      providerResumeId = undefined
    }
    if (session._forceHistoricalContextOnFirstTurn) providerResumeId = undefined
    const injectionKey = historicalContextInjectionKey({
      messages: effectiveMasterHistoricalMessages,
      peerId: session.peerId,
      agentId: session.agentId,
      hasProviderResumeId: !!providerResumeId,
    })
    // OCV5-556: when this agent's own last answer is in the window, the native
    // session already holds everything up to it. Keep the resume and inject only
    // the rows after it; a full replay into a fresh session is the fallback.
    // A head the ladder promoted from history may predate that answer (the
    // newer conversation lost its transcript), so it always gets the full rebuild.
    const providerGapDelta =
      providerResumeId &&
      injectionKey !== null &&
      effectiveMasterHistoricalMessages &&
      this._resumeHeadPromotedFromHistory.get(session.sessionKey) !== providerResumeId
        ? providerGapMessagesAfterOwnTurn({
            messages: effectiveMasterHistoricalMessages,
            peerId: session.peerId,
            agentId: session.agentId,
          })
        : null
    if (providerGapDelta) {
      log.info('master history gap kept native resume; injecting missing rows only', {
        sessionKey: session.sessionKey,
        provider: session.providerTag,
        injectionKey,
        missingCount: providerGapDelta.length,
      })
    } else if (providerResumeId && injectionKey !== null) {
      log.warn('master history gap invalidated native resume before context rebuild', {
        sessionKey: session.sessionKey,
        provider: session.providerTag,
        injectionKey,
      })
      await session.runner.shutdown()
      this._resumeMap.delete(session.sessionKey)
      this._resumeMapTimestamps.delete(session.sessionKey)
      this._resumeMapProvider.delete(session.sessionKey)
      this._resumeMapLastCost.delete(session.sessionKey)
      this._resumeMapCostImprecise.delete(session.sessionKey)
      this._resumeMapHistory.delete(session.sessionKey)
      session.ccbSessionId = null
      session.runner.clearSessionId?.()
      this._saveResumeMap()
      session._historicalContextInjected = false
      session._historicalContextInjectedKey = undefined
      session._contextRebuildNotice = 'native-resume-loss'
      providerResumeId = undefined
    }
    const nativeHandoff =
      consumingModelSwitch &&
      transition &&
      transition.sourceEngine !== session.providerTag &&
      transition.summaryText &&
      transition.summaryInjected !== true
        ? transition
        : null
    if (nativeHandoff) {
      let historyForMedia = effectiveMasterHistoricalMessages
      if (!historyForMedia) {
        try {
          historyForMedia = mergePendingExternalHistory(
            (await getEngineContextMessages(session.peerId, session.userId ?? 'default', {
              contextWindow:
                opts?.modelAuthority?.executionDescriptor.contextWindow ??
                (session.providerTag === 'codex' ? null : undefined),
              engine: session.providerTag,
              currentUserText: typeof userTextOrBlocks === 'string' ? userTextOrBlocks : '',
              ...(opts?.replayLifecycle?.clientMessageId
                ? { excludeClientMessageId: opts.replayLifecycle.clientMessageId }
                : {}),
            })) ?? [],
          )
        } catch {
          historyForMedia = []
        }
      }
      const mediaPathHints = collectModelHistoryMediaPathHints(
        historyForMedia,
        nativeHandoff.summaryText ?? '',
      )
      runnerPayload = buildNativeModelHandoffPayload(
        nativeHandoff.summaryText!,
        userTextOrBlocks,
        mediaPathHints,
      )
      nativeHandoff.summaryInjected = true
      session._historicalContextInjected = true
      session._historicalContextInjectedKey = `native-switch:${nativeHandoff.id}`
      session._contextRebuildNotice = undefined
      session._forceHistoricalContextOnFirstTurn = false
    }
    if (
      !nativeHandoff &&
      opts?.modelSwitchInternal === undefined &&
      !isCcbSlashCommandPrompt(userTextOrBlocks) &&
      shouldAttemptHistoricalContextInjection({
        alreadyInjected: session._historicalContextInjected,
        lastInjectedKey: session._historicalContextInjectedKey,
        injectionKey,
        channel: session.channel,
        userTextOrBlocks,
        hasProviderResumeId: !!providerResumeId,
      })
    ) {
      try {
        const historyMessages =
          providerGapDelta ??
          effectiveMasterHistoricalMessages ??
          mergePendingExternalHistory(
            (await getEngineContextMessages(session.peerId, session.userId ?? 'default', {
              contextWindow:
                opts?.modelAuthority?.executionDescriptor.contextWindow ??
                (session.providerTag === 'codex' ? null : undefined),
              engine: session.providerTag,
              currentUserText: typeof userTextOrBlocks === 'string' ? userTextOrBlocks : '',
              ...(opts?.replayLifecycle?.clientMessageId
                ? { excludeClientMessageId: opts.replayLifecycle.clientMessageId }
                : {}),
            })) ?? [],
          )
        const hasHistoricalContextRows =
          historyMessages && typeof userTextOrBlocks === 'string'
            ? buildHistoricalContextPrompt(historyMessages, userTextOrBlocks) !== null
            : false
        const historicalPrompt =
          historyMessages && typeof userTextOrBlocks === 'string'
            ? buildHistoricalContextPrompt(
                historyMessages,
                userTextOrBlocks,
                undefined,
                session.runner.capabilities.maxPromptBytes,
              )
            : null
        if (historicalPrompt) {
          runnerPayload = historicalPrompt
          session._historicalContextInjected = true
          session._historicalContextInjectedKey = injectionKey ?? 'local:no-provider-resume'
          const injectedCount = Array.isArray(historyMessages) ? historyMessages.length : 0
          log.info('injected historical context for provider switch / non-native resume', {
            sessionKey: session.sessionKey,
            provider: session.providerTag,
            source: masterHistoricalMessages ? 'master-frame' : 'local-storage',
            mode: providerGapDelta ? 'gap-delta-on-native-resume' : 'full-rebuild',
            injectionKey: session._historicalContextInjectedKey,
            messageCount: injectedCount,
          })
          // §2.3 boss 硬指标 3:兜底注入成功 = 引擎无法原生续接、上下文被重建 → 主动
          // 提醒用户(仅当上层传了回调,即 webchat leader turn;内部子 turn 不提醒)。
          // 回调抛错不能打断 turn —— 提示是尽力而为的 UX,吞掉即可。
          // A delta on top of a kept native resume rebuilds nothing.
          const shouldNotifyContextRebuilt = !providerGapDelta && shouldEmitContextRebuilt({
            historyMode: session.runner.capabilities.historyMode,
            reason: session._contextRebuildNotice,
          })
          if (shouldNotifyContextRebuilt) {
            try {
              opts?.emitContextRebuilt?.({ messageCount: injectedCount })
            } catch (emitErr) {
              log.warn(
                'emit sys.context_rebuilt failed',
                { sessionKey: session.sessionKey },
                emitErr,
              )
            }
          }
          session._contextRebuildNotice = undefined
          session._forceHistoricalContextOnFirstTurn = false
        } else if (!hasHistoricalContextRows) {
          // A replacement runner owns this reason only for its first
          // successful history lookup. A fresh conversation can have no
          // semantic rows beyond the optimistic current user message, so
          // there is nothing to rebuild or announce. Consume the reason now
          // instead of leaking it into a later turn that has nothing to rebuild.
          //
          // The uncapped classification above remains non-null when eligible
          // history exists but does not fit the provider's byte cap. Keep
          // the reason in that case for a later successful rebuild notice.
          session._contextRebuildNotice = undefined
          session._forceHistoricalContextOnFirstTurn = false
        }
      } catch (err) {
        log.warn('historical context injection failed', { sessionKey: session.sessionKey }, err)
      }
    }
    // Auto-name session from first user turn
    if (session.turns === 0 && session.currentUserText) {
      const title = session.currentUserText.slice(0, 50).replace(/\s+/g, ' ').trim()
      if (title) session.title = title
    }
    // Liveness-based timeout with state-aware thresholds.
    // `lastActivityAt` is refreshed on EVERY stdout chunk (subprocessRunner
    // handleStdout:505) — this includes CCB's _oc_telemetry side-channel
    // events (tool.preUse fires just before each tool.call, turn.apiResponse
    // after each stream, etc.), so a live subprocess keeps refreshing even
    // during long tools that produce no content blocks.
    // 阈值策略集中在文件顶部的 `pickIdleTimeoutMs` 里(见对应注释),这里
    // 只负责按当前 turn 的运行时状态查表 + 触发 reject。_runOneTurn 内还有
    // 一个 30-min 硬背书 timer 作为兜底,不在本路径管。
    const CHECK_INTERVAL = 15_000 // check every 15s
    const logicalTurnStartedAt = Date.now()
    let livenessTimer: NodeJS.Timeout | null = null
    const livenessPromise = new Promise<never>((_, reject) => {
      livenessTimer = setInterval(() => {
        if (Date.now() - logicalTurnStartedAt >= AUTHORITY_TURN_MAX_LIFETIME_MS) {
          const error = new TurnHardLimitError()
          logicalTurnAbort.abort(error)
          reject(error)
          return
        }
        // A blocking Codex requestUserInput is an explicit human wait, not
        // engine silence. Keep checking the immutable 12h hard limit above,
        // but never turn a pending question into LIVENESS_TIMEOUT/waiver.
        const idleMs = Date.now() - session.runner.lastActivityAt
        // pendingToolCalls 经 adapter 读当前活跃 turn 的 parser(turn 间为 0),
        // 语义与旧 session._currentParser?.pendingToolCalls 一致。
        const threshold = pickIdleTimeoutMs(
          session.currentTurnStatus,
          session.runner.pendingToolCalls,
          session.providerTag,
          session.model,
        )
        if (
          shouldTripIdleWatchdog({
            waitingForUserInput: session.runner.waitingForUserInput === true,
            idleMs,
            thresholdMs: threshold,
          })
        ) {
          const error = new TurnIdleTimeoutError(
            `idle timeout (${Math.round(idleMs / 1000)}s no output)`,
          )
          logicalTurnAbort.abort(error)
          reject(error)
        }
      }, CHECK_INTERVAL)
    })
    log.info('turn_pipeline_timing', { traceId, stage: 'context_ready', elapsedMs: performance.now() - submitStartedAt })
    logicalTurnRun = this.runOneTurnWithRetry(
      session,
      runnerPayload,
      onEvent,
      requestId,
      traceId,
      opts?.collabAgentPolicy,
      opts?.modelAuthority,
      opts?.replayLifecycle?.clientMessageId,
      opts?.dispatchContext,
      opts?.queueLifecycle,
      logicalTurnAbort.signal,
      consumingModelSwitch ? [] : contextOverflowRetryInputs,
      opts?.automaticRetryState,
      consumingModelSwitch ? transition : undefined,
      opts?.grokExecutionDescriptor,
    )
    try {
      await Promise.race([logicalTurnRun, livenessPromise])
    } finally {
      if (livenessTimer) clearInterval(livenessTimer)
    }
  } catch (err: any) {
    if (err instanceof TurnIdleTimeoutError || err?.code === 'TURN_IDLE_TIMEOUT') {
      const persistTimedOutTurn = session._persistActiveTurn
      // Actually interrupt the runner so the subprocess stops
      try {
        session.runner.interrupt()
      } catch {}
      // Extract idle seconds from the inner error so the user-facing
      // message reflects the actual silence duration (avoids confusing
      // mismatch with the inner 30-min idle timer's fixed wording).
      const m = /\((\d+)s/.exec(String(err?.message))
      const minutes = m ? Math.round(Number(m[1]) / 60) : null
      const detail = minutes ? `约 ${minutes} 分钟无输出` : '长时间无输出'
      const reason = `任务${detail}，已中断。本轮已自动免单，积分将原路退回；请重试。`
      if (persistTimedOutTurn) {
        const persistence = persistTimedOutTurn(
          'interrupted',
          reason,
          'LIVENESS_TIMEOUT',
          'idle_timeout',
        )
        this._trackPersistence(persistence)
        await persistence
      } else {
        onEvent({ kind: 'error', error: reason })
      }
      await logicalTurnRun?.catch((runErr) => {
        if (runErr !== logicalTurnAbort.signal.reason) throw runErr
      })
      log.error(
        'idle timeout, interrupted',
        { sessionKey: session.sessionKey, ...(traceId ? { traceId } : {}) },
        err,
      )
    } else if (err instanceof TurnHardLimitError || err?.code === 'TURN_HARD_LIMIT') {
      const persistLimitedTurn = session._persistActiveTurn
      try {
        session.runner.interrupt()
      } catch {}
      const reason =
        '任务已达到 12 小时运行上限，系统已中断。本轮已自动免单，积分将原路退回；请重新发起。'
      if (persistLimitedTurn) {
        const persistence = persistLimitedTurn('interrupted', reason, 'TURN_LIMIT', 'turn_limit')
        this._trackPersistence(persistence)
        await persistence
      } else {
        onEvent({ kind: 'error', error: reason })
      }
      await logicalTurnRun?.catch((runErr) => {
        if (runErr !== logicalTurnAbort.signal.reason) throw runErr
      })
      log.warn('turn hard limit reached, interrupted', {
        sessionKey: session.sessionKey,
        ...(traceId ? { traceId } : {}),
      })
    } else {
      unhandledTurnError = err
      throw err
    }
  } finally {
    if (
      consumingModelSwitch &&
      transition &&
      session._modelSwitchTransition === transition &&
      transition.state === 'consuming'
    ) {
      transition.state = 'prepared'
      transition.summaryInjected = false
    }
    await finalizeEfficiencyTurn(session).catch((err) => {
      log.debug('efficiency guard finalize failed', {
        sessionKey: session.sessionKey,
        err: String(err),
      })
    })
    await memoryTurnPolicyLease?.stop().catch((err) => {
      log.warn('memory turn policy cleanup failed', {
        sessionKey: session.sessionKey,
        err: String(err),
      })
    })
    await memoryTurnBarrier?.release().catch(() => {})
    // turn-alive-heartbeat (Plan 1) — turn-level inFlight 真值源 --。
    // 配对的 ++ 在 submit() 头部。`?? 0` 容忍字段缺失:历史 session 对象 /
    // 测试 fake / 未来误删初始化的场景。`Math.max(0, n - 1)` 是 defense-in-
    // depth:单 async function 的 finally 不会双跑,但消费侧
    // (`_shouldPushTurnInterruptedFinal`)也把负数当 0,生产侧顺势对齐,
    // 让真值源不依赖外部不变量。release() 之前归零,保证下一个 await prev
    // 的 submit 看到的是干净状态。
    try {
      if (replayLifecycleStarted) {
        try {
          opts?.replayLifecycle?.onBeforeRelease(unhandledTurnError)
        } catch (err) {
          log.warn(
            'active-turn replay before-release hook failed',
            { sessionKey: session.sessionKey },
            err,
          )
        }
      }
    } finally {
      try {
        if (replayLifecycleStarted) {
          try {
            opts?.replayLifecycle?.onEnd()
          } catch (err) {
            log.warn('active-turn replay end hook failed', { sessionKey: session.sessionKey }, err)
          }
        }
      } finally {
        if (
          opts?.replayLifecycle &&
          session._runningClientMessageId === opts.replayLifecycle.clientMessageId
        ) {
          session._runningClientMessageId = undefined
        }
        if (session._externalTurnAbort === logicalTurnAbort) {
          session._externalTurnAbort = undefined
        }
        const idleSessionId = session.runner.nativeSessionId ?? undefined
        const idleTurnKey = session._currentTurnKey
        // OCV5-297: only record the durable candidate while holding the lock
        // (cheap, and it blocks a following submit until handled). Proof,
        // compaction and settlement run after release in scheduleIdleDrain.
        let idleFollowUp = false
        if (
          unhandledTurnError === undefined &&
          idleSessionId &&
          idleTurnKey &&
          opts?.modelSwitchInternal === undefined
        ) {
          try {
            if (boxTurnMayIdle({ model: session.model, contextOwner: session._boxContextOwner })) {
              writeIdleCandidate(paths.home, {
                v: 1,
                sessionKey: session.sessionKey,
                sessionId: idleSessionId,
                turnKey: idleTurnKey,
                createdAt: Date.now(),
              })
            }
            idleFollowUp = currentIdleSource(paths.home, session.sessionKey) !== undefined
          } catch (idleErr) {
            if (!(idleErr instanceof IdleCompactRejected)) {
              log.warn('idle compact failed closed', { sessionKey: session.sessionKey }, idleErr)
            }
          }
        }
        session._activeTurnCount = Math.max(0, (session._activeTurnCount ?? 0) - 1)
        session._currentTurnKey = undefined
        session._currentTurnIndex = undefined
        session._currentDispatch = undefined
        session._turnCreditBudgetFen = undefined
        if (queueTurn) {
          this._promptQueueExecutions.delete(session)
          this._promptQueueExecutionKeys.delete(session.sessionKey)
        }
        release()
        if (idleFollowUp) this.scheduleIdleDrain(session)
      }
    }
  }
}

export async function _getOrCreateExclusive(
  this: SessionSubmitHost,
  opts: Parameters<SessionManager['getOrCreate']>[0],
): Promise<AgentSession> {
  const ownsDispatchFence = this._ownsPromptQueueExecutionFence(
    opts.sessionKey,
    opts.promptQueueExecutionFence,
  )
  if (
    (opts.promptQueueExecutionFence && !ownsDispatchFence) ||
    (this._promptQueueDispatchFences.has(opts.sessionKey) && !ownsDispatchFence)
  ) {
    throw new Error('PROMPT_QUEUE_EXECUTION_INVARIANT: queue preflight owns this logical session')
  }
  // Identity construction outlives an individual dispatch/switch. Never retain
  // their one-use admission credentials in the reusable session template.
  const {
    promptQueueExecutionFence: _fence,
    modelSwitchId: _switchId,
    preheatOnly: _preheatOnly,
    ...identityCreationOpts
  } = opts
  // Hermetic advisor/Auto-Dream sessions have no persona or identity overlay.
  // Fetching marketplace identity here would fail-closed the no-tools path
  // whenever master sync is briefly unavailable.
  const identity = opts.hermeticNoTools
    ? { agent: opts.agent, context: {} }
    : await resolveRuntimeExecutionAgent(opts.agent)
  opts = { ...opts, agent: identity.agent }
  const identityAgentFingerprint = identity.context.assets ? JSON.stringify(opts.agent) : undefined
  // 新建时 null 等同 undefined(都让 CCB 用模型默认)
  const initialEffort: string | undefined = opts.effortLevel === null ? undefined : opts.effortLevel

  // ── M1a engine 判定(取代 providerTag 二值假设)────────────────────────
  // 统一执行模型准入 + engine 解析都在这里一次收口:
  //   - resolveExecutionModel:agent.model / 入站 model 可能是已下线模型,
  //     收敛到白名单内(白名单只拦入站帧、agent.model 绕过的教训)。
  //   - resolveEngine:model→engine 映射 + agentDef.provider 显式 pin 的单一
  //     权威(gpt-5.5 → 'codex';codex-native pin 仅接受 app-server 形态)。
  //   - executionAuthority(有则唯一权威):master 签名 descriptor 的 canonicalModel /
  //     engine 直接落地,两个 baked 表(ALLOWED_INBOUND_MODELS / MODEL_ENGINE_MAP)
  //     在该 turn **完全不参与** —— 判定单点化(方案 §2)。
  const executionModel = resolveExecutionModel(
    opts.model ?? opts.agent.model,
    this.config.defaults.model,
    opts.executionAuthority,
    { explicit: typeof opts.model === 'string' && opts.model !== '' },
  )
  // flag 门(§3):托管 + OC_MODEL_AUTHORITY=1 时,**无 master 权威一律不许创建 runner**。
  // 判定放在 resolveEngine 内部(engine 判定的单一收口),这里只把 flag 传进去 ——
  // 于是"所有无 envelope 的 runner 创建入口"的完整性不再依赖人工枚举:createEngine 的
  // 唯一调用者就是本函数,任何漏取 catalog 投影的入口都会在这里 fail-closed 炸出来。
  const engineId = resolveEngine(executionModel, opts.agent, opts.executionAuthority, {
    requireAuthority: isModelAuthorityRequired(),
  })
  // CCB consumes --permission-mode. The other current engine adapters run
  // fixed full-auto/force and cannot truthfully enforce a narrower profile.
  if (
    identity.context.assets &&
    engineId !== 'ccb' &&
    identity.context.assets.effectivePermissionMode !== undefined &&
    identity.context.assets.effectivePermissionMode !== 'bypassPermissions'
  ) {
    throw new IdentityAssetsError(
      'COMPAT_PERMISSION_CONFLICT',
      'COMPAT_PERMISSION_CONFLICT: selected engine cannot enforce the registered permission mode',
    )
  }
  let existing = this.sessions.get(opts.sessionKey)
  // This runs under the creation gate. A late speculative lookup must not
  // overwrite a real first turn that created its runner while projection awaited.
  if (opts.preheatOnly && existing) return existing
  if (existing?._modelSwitchTransition) {
    const transition = existing._modelSwitchTransition
    if (
      transition.state === 'prepared' &&
      transition.expiresAt !== undefined &&
      Date.now() >= transition.expiresAt
    ) {
      if (executionModel === transition.sourceModel && opts.modelSwitchId === undefined) {
        existing._modelSwitchTransition = undefined
      } else {
        throw new Error('MODEL_SWITCH_EXPIRED')
      }
    }
  }
  if (existing?._modelSwitchTransition) {
    const transition = existing._modelSwitchTransition
    const matchesPreparedTarget =
      transition.state === 'prepared' &&
      transition.targetModel === executionModel &&
      opts.modelSwitchId === transition.id
    if (!matchesPreparedTarget) {
      throw new Error('MODEL_SWITCH_IN_PROGRESS')
    }
  }
  const previousEngine =
    existing?.providerTag ?? normalizeEngineTag(this._resumeMapProvider.get(opts.sessionKey))
  let contextRebuildNotice: AgentSession['_contextRebuildNotice'] =
    previousEngine && previousEngine !== engineId ? 'engine-switch' : undefined
  const workspaceMode = opts.workspaceMode ?? existing?.workspaceMode ?? 'legacy'
  let identityRefreshSession: AgentSession | undefined
  try {
    if (existing) {
      // 跨 engine 切换判定:只有"caller 明确给了 model"/"有 master 权威"/"agent 显式 pin
      // 到 codex-native"时 engine 判定才是权威;无模型调用沿用现存 engine(见 opts.model
      // JSDoc)。authority 在场必权威 —— master 说这个 turn 跑 codex,就不能因为 caller
      // 没显式带 model 而沿用现存 ccb runner(那正是执行与计费分裂的形状)。
      const desiredEngine =
        opts.model !== undefined ||
        opts.executionAuthority !== undefined ||
        opts.agent.provider === 'codex-native'
          ? engineId
          : existing.providerTag
      const workspaceModeChanged =
        opts.workspaceMode !== undefined && existing.workspaceMode !== workspaceMode
      const workspaceCwdChanged =
        opts.workspaceCwd !== undefined && existing.workspaceCwd !== opts.workspaceCwd
      const nextProjectId =
        opts.projectId === undefined ? (existing.projectId ?? null) : opts.projectId
      const projectIdChanged =
        opts.projectId !== undefined && (existing.projectId ?? null) !== (opts.projectId ?? null)
      const cursorTransportChanged = Boolean(
        (opts.model !== undefined || opts.executionAuthority !== undefined) &&
          existing.runner.requiresReopenForModel?.(executionModel),
      )
      const nextFingerprint =
        opts.contextFingerprint ??
        (await computeSessionContextFingerprint(nextProjectId, opts.assetsRevision))
      // Fingerprint ticks (project.md / assets) are re-injected each spawn via
      // prompt slots. Replacing the runner for that would drop Cursor's live
      // native session and force a visible history replay on ordinary follow-ups.
      if (
        existing.agentId !== opts.agent.id ||
        existing._identityAgentFingerprint !== identityAgentFingerprint ||
        existing.providerTag !== desiredEngine ||
        cursorTransportChanged ||
        workspaceModeChanged ||
        workspaceCwdChanged ||
        projectIdChanged
      ) {
        const replacementNotice: NonNullable<AgentSession['_contextRebuildNotice']> =
          existing.providerTag !== desiredEngine ? 'engine-switch' : 'native-resume-loss'
        contextRebuildNotice = replacementNotice
        if (
          this._promptQueueExecutionKeys.has(opts.sessionKey) ||
          (this._promptQueueDispatchFences.has(opts.sessionKey) && !ownsDispatchFence)
        ) {
          throw new Error(
            'PROMPT_QUEUE_EXECUTION_INVARIANT: engine switch cannot replace an active queue session',
          )
        }
        // 旧 session 在 shutdown() 完成前仍留在 map;无票 inbound 不得沿用其 model。
        // 放在不变量检查之后:检查失败不会留下粘滞 _replacing。
        existing._replacing = true
        // Same logical client session, but the desired engine changed (model
        // switch across engines, or agent switched between CCB and Codex).
        // Native resume ids are engine-specific, so tear down the old runner
        // and let the fresh one receive a compact transcript preamble on its
        // first submit().
        try {
          await existing.lock
          const canonical = this.sessions.get(opts.sessionKey)
          if (canonical && canonical !== existing) {
            const desiredEngineNow =
              opts.model !== undefined ||
              opts.executionAuthority !== undefined ||
              opts.agent.provider === 'codex-native'
                ? engineId
                : canonical.providerTag
            const stillNeedsReplace =
              canonical.agentId !== opts.agent.id ||
              canonical._identityAgentFingerprint !== identityAgentFingerprint ||
              canonical.providerTag !== desiredEngineNow ||
              Boolean(
                (opts.model !== undefined || opts.executionAuthority !== undefined) &&
                  canonical.runner.requiresReopenForModel?.(executionModel),
              ) ||
              (opts.workspaceMode !== undefined && canonical.workspaceMode !== workspaceMode) ||
              (opts.workspaceCwd !== undefined && canonical.workspaceCwd !== opts.workspaceCwd) ||
              (opts.projectId !== undefined &&
                (canonical.projectId ?? null) !== (opts.projectId ?? null))
            if (!stillNeedsReplace) {
              canonical.lastUsedAt = Date.now()
              if (opts.title && (!canonical.title || canonical.title === 'New conversation'))
                canonical.title = opts.title
              if (opts.userId && !canonical.userId) canonical.userId = opts.userId
              if (opts.repoSessionId && !canonical.repoSessionId)
                canonical.repoSessionId = opts.repoSessionId
              if (opts.parentSessionKey && !canonical.parentSessionKey)
                canonical.parentSessionKey = opts.parentSessionKey
              if (opts.projectId !== undefined) canonical.projectId = opts.projectId
              if (nextFingerprint) canonical.contextFingerprint = nextFingerprint
              if (opts.runContext) canonical.runContext = opts.runContext
              canonical._identityCreationOpts = identityCreationOpts
              return canonical
            }
            existing = canonical
            existing._replacing = true
          }
          // Identity-only runner refresh keeps the logical owner held by
          // begin/endClientTurn and B1; general engine/workspace switches don't.
          if (
            identity.context.assets &&
            existing._identityCompat?.assets &&
            JSON.stringify(identity.context.assets.profile) ===
              JSON.stringify(existing._identityCompat.assets.profile) &&
            existing.agentId === opts.agent.id &&
            existing._identityAgentFingerprint !== identityAgentFingerprint &&
            existing.providerTag === engineId &&
            existing.model === executionModel &&
            !cursorTransportChanged &&
            !workspaceModeChanged &&
            !workspaceCwdChanged &&
            !projectIdChanged &&
            existing.workspaceCwd ===
              (opts.workspaceCwd ??
                opts.agent.cwd ??
                resolveDefaultWorkspaceCwd(workspaceMode, opts.repoSessionId ?? opts.peerId))
          )
            identityRefreshSession = existing
          try {
            const legacyId = this._resumeMap.get(opts.sessionKey)
            const ids =
              legacyId && legacyId !== opts.sessionKey
                ? [opts.sessionKey, legacyId]
                : [opts.sessionKey]
            // Native resume ids are process/thread handles, not turn evidence:
            // Codex app-server can emit one during an untouched browser prewarm.
            // Durable reservations are the authority for attempted real turns;
            // FTS/meta inside the helper cover pre-reservation legacy history.
            const hadPriorProviderState =
              existing.turns > 0 || (await hasPersistedTurnActivity(ids))
            // Browser creation persists the UI-default engine before the first
            // real turn. Switching that untouched prewarm to Cursor is not a
            // provider-context rebuild and must not create a notice. The durable
            // reservation table is checked here (after existing.lock), rather
            // than inferring freshness from an empty selected-history snapshot:
            // current-input budgeting can legitimately select [] for old chats.
            contextRebuildNotice = hadPriorProviderState ? replacementNotice : undefined
          } catch (historyErr) {
            // Failure to prove freshness must preserve the exceptional notice.
            // Suppressing a real provider switch is worse than a best-effort
            // notice; runner replacement itself must still continue.
            log.warn(
              'session-replacement prior-turn read failed; preserving rebuild notice',
              {
                sessionKey: opts.sessionKey,
                replacementNotice,
              },
              historyErr,
            )
          }
          await existing.runner.shutdown()
        } catch (err) {
          if (identityRefreshSession) throw err
          log.warn(
            'session-replacement shutdown failed',
            {
              sessionKey: opts.sessionKey,
              engineChanged: existing.providerTag !== desiredEngine,
              workspaceModeChanged,
            },
            err,
          )
        }
        if (!identityRefreshSession && this.sessions.get(opts.sessionKey) === existing) {
          this.sessions.delete(opts.sessionKey)
        }
      } else {
        existing.lastUsedAt = Date.now()
        if (opts.title && (!existing.title || existing.title === 'New conversation'))
          existing.title = opts.title
        // Adopt a userId from a later call if the session was first created
        // without one (e.g. cron pre-warmed, then a webchat user attached).
        // Never *overwrite* an already-set userId — doing so would enable a
        // different authenticated user to redirect another user's persistence.
        if (opts.userId && !existing.userId) existing.userId = opts.userId
        if (opts.repoSessionId && !existing.repoSessionId)
          existing.repoSessionId = opts.repoSessionId
        if (opts.parentSessionKey && !existing.parentSessionKey)
          existing.parentSessionKey = opts.parentSessionKey
        if (opts.projectId !== undefined) existing.projectId = opts.projectId
        if (nextFingerprint) existing.contextFingerprint = nextFingerprint
        if (opts.runContext)
          existing.runContext = adoptRunContext(existing.runContext, opts.runContext)
        existing._identityCreationOpts = identityCreationOpts
        return existing
      }
    }
    // 显式 pin 的 agent cwd(如 repo session)优先,永不被 workspace 缺省覆盖;
    // 仅在没有显式 cwd 时用 OPENCLAUDE_DEFAULT_WORKSPACE(存在且是目录)/否则 process.cwd()。
    const repoSessionId = opts.repoSessionId ?? opts.peerId
    const cwd =
      opts.workspaceCwd ??
      opts.agent.cwd ??
      resolveDefaultWorkspaceCwd(workspaceMode, repoSessionId)
    const persona = opts.hermeticNoTools
      ? undefined
      : (opts.agent.persona ?? paths.agentClaudeMd(opts.agent.id))
    // M0/M1a engine 适配层:runner 构造收口到 registry factory。
    //   - executionModel / engineId 已在函数头部一次收口(见上方注释)——
    //     teardown 判定与构造用同一份解析结果,不会出现"比较用 A、spawn 用 B"。
    //   - createEngine 对未注册 engine fail-closed 抛错(原 v5 channel 硬闸的
    //     语义升级形态:任何 channel 都不会把未注册 engine 静默落到 CCB)。
    const hadSameProviderResume =
      Boolean(this._resumeMap.get(opts.sessionKey)) &&
      normalizeEngineTag(this._resumeMapProvider.get(opts.sessionKey)) === engineId
    const mappedResumeId = opts.hermeticNoTools
      ? undefined
      : this._resumeIdFor(
          opts.sessionKey,
          engineId,
          this._cursorWorkspacePath(cwd, repoSessionId, Boolean(opts.projectId)),
        )
    if (!isEngineEnabled(engineId)) throw new EngineNotEnabledError(engineId)
    const runner = createEngine(engineId, {
      sessionKey: opts.sessionKey,
      agentId: opts.agent.id,
      agentBaseDir: cwd,
      config: this.config,
      persona,
      identityCompat: opts.hermeticNoTools ? undefined : identity.context,
      model: executionModel,
      permissionMode: identity.context.assets
        ? identity.context.assets.effectivePermissionMode
        : (opts.agent.permissionMode ?? this.config.defaults.permissionMode),
      agentProvider: opts.agent.provider,
      agentMcpServers: opts.agent.mcpServers,
      agentToolsets: opts.agent.toolsets ?? this.config.defaults.toolsets,
      delegationDepth: opts.delegationDepth,
      // Symmetrically: only resume from an id produced by the SAME engine
      // (resume-map 按 engine 维度隔离,防 codex thread_id 与 CCB session_id
      // 互喂)。_resumeIdFor also drops the entry silently when the CCB JSONL
      // was wiped (pre-2026-04-22 v3 containers' tmpfs was ephemeral).
      resumeSessionId: mappedResumeId,
      resolveResumeFallback: (staleId: string) => {
        const promoted = this._resolveDurableResumeId(
          opts.sessionKey,
          engineId,
          undefined,
          this._cursorWorkspacePath(cwd, repoSessionId, Boolean(opts.projectId)),
          { exclude: staleId, syncRunner: false },
        )
        return promoted && promoted !== staleId ? promoted : undefined
      },
      effortLevel: initialEffort,
      // Phase 5:repoSessionId 默认等于 peerId;delegate_task 可传父 webchat
      // session id 作为 repo lookup key,但不改变 delegate 自己的 peerId。
      // getRepoSnapshot 由 Gateway 构造器注入。
      sessionId: repoSessionId,
      projectId: opts.projectId ?? undefined,
      runContext: opts.runContext,
      frozenProjectContext: opts.frozenProjectContext,
      getRepoSnapshot: this._getRepoSnapshot,
      workload: opts.workload,
      skillTrainRunId: opts.skillTrainRunId,
      skillEvalMode: opts.skillEvalMode,
      skillEvalExclude: opts.skillEvalExclude,
      skillEvalDraft: opts.skillEvalDraft,
      usageAttribution: opts.usageAttribution,
      hermeticNoTools: opts.hermeticNoTools,
      advisorExecutionLock: opts.advisorExecutionLock,
      structuredOutputSchema: opts.structuredOutputSchema,
    })
    const resumeTransportMismatch =
      !opts.hermeticNoTools &&
      hadSameProviderResume &&
      (!mappedResumeId ||
        Boolean(runner.isResumeIdCompatible && !runner.isResumeIdCompatible(mappedResumeId)))
    if (resumeTransportMismatch) contextRebuildNotice = 'native-resume-loss'
    const now = Date.now()
    const session: AgentSession = identityRefreshSession ?? {
      _identityAgentFingerprint: identityAgentFingerprint,
      _identityCreationOpts: identityCreationOpts,
      _identityCompat: opts.hermeticNoTools ? undefined : identity.context,
      sessionKey: opts.sessionKey,
      agentId: opts.agent.id,
      channel: opts.channel ?? 'webchat',
      peerId: opts.peerId ?? 'unknown',
      userId: opts.userId,
      workspaceMode,
      workspaceCwd: cwd,
      projectId: opts.projectId,
      contextFingerprint:
        opts.contextFingerprint ??
        (await computeSessionContextFingerprint(opts.projectId, opts.assetsRevision)),
      runContext: opts.runContext,
      frozenProjectContext: opts.frozenProjectContext,
      repoSessionId,
      title: opts.title ?? 'New conversation',
      // delegate 子会话的直接父指针(webchat/普通会话为 undefined)。物化父链使委派进度
      // 可向上追溯 webchat 祖先;不影响 _sessionIdToKey / peerId 身份。
      parentSessionKey: opts.parentSessionKey,
      _billingParentTurnKey: opts.usageAttribution?.parentTurnKey,
      _usageAttribution: opts.usageAttribution ? { ...opts.usageAttribution } : undefined,
      startedAt: now,
      runner,
      ccbSessionId: null,
      lock: Promise.resolve(),
      lastUsedAt: now,
      // If we are about to --resume a CCB whose historical cumulative was
      // persisted in the resume-map, seed both the session-total AND the
      // delta-baseline with the same value. The delta-baseline keeps the first
      // post-resume per-turn delta correct; the session-total keeps aggregate
      // cost events (final.meta.totalCost, cost.recorded.sessionTotalCostUsd)
      // continuous across gateway restarts. For fresh sessions both are 0.
      // Provider-gated: if the persisted entry came from a different provider
      // (e.g. CCB → codex-native switch on the same sessionKey), we drop to
      // 0 so codex doesn't inherit CCB's historical cost as its own baseline.
      // NOTE: token counts are NOT persisted across gateway restarts — they
      // will start at 0 after a resume. This is a known limitation; fixing it
      // requires persisting per-token totals which we do not currently do.
      totalCostUSD: this._lastCostFor(opts.sessionKey, engineId) ?? 0,
      costImprecise: this._costImpreciseFor(opts.sessionKey, engineId),
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      turns: 0,
      _lastCcbCumulativeCost: this._lastCostFor(opts.sessionKey, engineId) ?? 0,
      // 与 runner 同一份白名单收敛结果(见上方 executionModel 注释)。
      model: executionModel,
      ...(existing?._modelSwitchTransition
        ? { _modelSwitchTransition: existing._modelSwitchTransition }
        : {}),
      toolUseIdToName: new Map(),
      executionTarget: { kind: 'local' },
      // Phase 5 G.0 → M1a:固化 engine 路由信息(字段名保留 providerTag),
      //   recyclePeerForRepoChange / pickIdleTimeoutMs 用它
      //   走 codex 专属重置分支(避免 instanceof / runner.constructor.name)。
      providerTag: engineId,
      agentProvider: opts.agent.provider,
      _contextRebuildNotice: contextRebuildNotice,
      _forceHistoricalContextOnFirstTurn: resumeTransportMismatch || undefined,
    }
    if (identityRefreshSession) {
      // Publish only after construction succeeds; never overwrite counters,
      // lock, owner evidence or cumulative state with fresh-session defaults.
      session.runner = runner
      session._identityAgentFingerprint = identityAgentFingerprint
      session._identityCreationOpts = identityCreationOpts
      session._identityCompat = identity.context
      session.agentProvider = opts.agent.provider
      session._contextRebuildNotice = contextRebuildNotice
      session._forceHistoricalContextOnFirstTurn = resumeTransportMismatch || undefined
      // These markers describe a runner's native context, not the logical
      // owner. Let the existing resume/history gate evaluate the new runner:
      // a valid native resume still skips replay; a cold runner gets history.
      session._historicalContextInjected = false
      session._historicalContextInjectedKey = undefined
      session.lastUsedAt = now
    }
    runner.on(
      'task_notification',
      (payload: {
        taskId: string
        status: string
        outputFile: string
        summary: string
        toolUseId?: string
      }) => {
        if (session.runner !== runner) return
        this.onCcbTaskNotification?.(session, payload)
      },
    )
    runner.on(
      'task_notification_delivered',
      (payload: {
        taskId: string
        deliveredBy: 'ccb-mid-turn'
      }) => {
        if (session.runner !== runner) return
        this.onCcbTaskNotificationDelivered?.(session, payload)
      },
    )
    runner.on('session_id', (id: string) => {
      if (session.runner !== runner) return
      // Durable-artifact ladder: when the engine mints a NEW id for this
      // session (fresh spawn after the previous id failed to resume, codex
      // missing-rollout self-heal, cursor sand re-spawn…), keep the previous
      // same-provider id so a rebuild that leaves the new id transcript-less
      // can still resume the older one instead of replaying history.
      const prevId = session.ccbSessionId ?? this._resumeMap.get(opts.sessionKey)
      const prevProv = normalizeEngineTag(this._resumeMapProvider.get(opts.sessionKey))
      if (prevId && prevId !== id) {
        if (prevProv !== engineId) {
          this._resumeMapHistory.delete(opts.sessionKey)
        } else if (
          probeResumeArtifact(engineId, prevId, {
            workspacePath: this._cursorWorkspacePathForSession(session),
          }).exists
        ) {
          // Only durable ids earn a ladder slot; a head that never landed on
          // disk (the incident shape) has nothing to fall back to.
          this._pushResumeHistory(opts.sessionKey, prevId)
        }
      }
      if (this._resumeHeadPromotedFromHistory.get(opts.sessionKey) !== id) {
        this._resumeHeadPromotedFromHistory.delete(opts.sessionKey)
      }
      session.ccbSessionId = id
      // Remember which provider produced this id — the next getOrCreate on
      // this sessionKey (possibly after a gateway restart switching providers)
      // uses the tag to decide whether to pass the id through as --resume.
      this._resumeMapProvider.set(opts.sessionKey, engineId)
      // Persist session→ccbSessionId mapping for resume after gateway restart
      this._saveResumeMap()
    })
    // Reset per-process cost-delta baseline in lock-step with subprocess
    // lifecycle. The emit is synchronous and happens before any stdout listener
    // is attached on the runner, so this listener runs strictly before any
    // parser message of the new CCB — no race with a queued next turn.
    //
    // Fresh CCB:   getTotalCost() starts at 0 → reset baseline to 0.
    // Resumed CCB: CCB's restoreCostStateForSession sets STATE.totalCostUSD
    //              to the persisted historical cumulative, so the next
    //              `result` will report (historical + new). To compute the
    //              correct per-turn delta we keep our baseline equal to that
    //              historical value.
    //
    // Baseline equality guarantees:
    //   - AUTH/PHANTOM/effort-change (graceful shutdown): onFinish rollback
    //     restores baseline to the last successful turn's cumulative, and
    //     CCB's costHook (process.on('exit')) persists STATE.totalCostUSD at
    //     the same point → values match.
    //   - gateway-restart: _resumeMapLastCost is written after every
    //     successful turn (see _saveResumeMap call in onFinish success path),
    //     matching CCB's per-exit persistence.
    //   - CRASH: CCB may die before its exit hook runs, in which case its
    //     persisted cumulative may lag behind the gateway's baseline by 1+
    //     turns. The parser's `< 0` fallback (treats newCumulative as full
    //     delta when newCumulative < baseline) recovers accuracy for the
    //     specific respawned turn, but the historical lag is unrecoverable
    //     from gateway's side. This is accepted as best-effort behaviour;
    //     a stricter fix would require CCB to persist STATE.totalCostUSD on
    //     every turn, not only at exit.
    runner.on('spawn', (info: { resumed: boolean }) => {
      if (session.runner !== runner) return
      if (!info.resumed) {
        session._lastCcbCumulativeCost = 0
      }
    })
    // Monitor subprocess crashes — emit event so gateway can notify connected clients
    runner.on('exit', (info: { code: number | null; signal: string | null; crashed: boolean }) => {
      if (session.runner !== runner) return
      // 子进程退出 → 清空 turn_status 缓存。crashed/正常 exit 都清:正常 exit
      // 意味着没有 in-flight turn(也就不会还有 compacting);crashed 期间如果
      // 恰好在 compact 中,这帧 cache 没有 turn_status:null 来源(子进程死了
      // 不会再 emit setSDKStatus(null)),不清会让后续 autoResumeFromHello
      // 误推 compacting 给重连客户端。
      session.currentTurnStatus = null
      if (info.crashed) {
        log.warn('subprocess crashed', {
          sessionKey: opts.sessionKey,
          code: info.code,
          signal: info.signal,
        })
        // If the most recent turn failed because the --resume session id on
        // disk is stale (CCB: "No conversation found with session ID: ..."),
        // evict the entry so the next submit() starts a fresh CCB session.
        // Without this, every restart re-spawns CCB with the same dead id,
        // producing the same error, and the subprocess never boots.
        if (session._pendingStaleResumeClear) {
          session._pendingStaleResumeClear = false
          const staleId = session.ccbSessionId ?? this._resumeMap.get(opts.sessionKey)
          // The head at this point is usually the id CCB minted for the spawn
          // that then died without writing a transcript; it must never be
          // re-picked either. The id CCB actually refused was already marked
          // from the error text in finalizeTurn (_markResumeRejectedFromError).
          this._markResumeRejected(opts.sessionKey, staleId)
          // Durable-artifact ladder first: the engine just told us the head id
          // is gone; a prior same-provider id may still have its transcript.
          const promoted = session.runner.setResumeSessionId
            ? this._resolveDurableResumeId(
                opts.sessionKey,
                engineId,
                undefined,
                this._cursorWorkspacePathForSession(session),
                { exclude: staleId ?? undefined },
              )
            : undefined
          if (promoted && promoted !== staleId) {
            // _resolveDurableResumeId already synced session.ccbSessionId,
            // runner.setResumeSessionId and persisted the map.
          } else {
            this._forgetResumeEntry(opts.sessionKey)
            session.ccbSessionId = null
            // Also forget the id inside the runner — otherwise submit()'s next
            // start() reads it back as resumeSessionId and --resume the same
            // dead id again.
            session.runner.clearSessionId?.()
            this._saveResumeMap()
          }
        } else if (session.ccbSessionId) {
          // Ensure the session stays in resume-map so it can be restored on next submit()
          // (SubprocessRunner.submit() auto-restarts with --resume when proc is null)
          this._resumeMap.set(opts.sessionKey, session.ccbSessionId)
          this._saveResumeMap()
        }
        // Notify via eventBus so gateway can push a reconnect hint to the client
        eventBus.emit(
          'session.crashed',
          createEvent('session.crashed', session.agentId, {
            sessionKey: opts.sessionKey,
            peerId: session.peerId,
            ccbSessionId: session.ccbSessionId,
          }),
        )
      }
    })
    this.sessions.set(opts.sessionKey, session)
    // Phase 5:peer (= sessionId) → sessionKey 反查索引,recyclePeerForRepo* 入口用。
    // peerId === sessionId 是协议约定;同 peerId 应只有一条活 session,理论上不会 overwrite。
    // opts.peerId 可空(cron/webhook 等无 peer 调用)→ 用 session.peerId(已 fallback 'unknown')。
    // 'unknown' 是 fallback 占位,GitHub repo 流程只走 webchat,该路径必有真 peerId。
    if (opts.peerId) {
      this._sessionIdToKey.set(opts.peerId, opts.sessionKey)
    }
    return session
  } finally {
    if (identityRefreshSession) identityRefreshSession._replacing = false
  }
}

export async function getOrCreate(
  this: SessionSubmitHost,
  opts: {
    sessionKey: string
    agent: AgentDef
    channel?: string
    peerId?: string
    /**
     * M1a 跨 engine 切模型:入站帧的 desired model(server.ts dispatchInbound
     * 传 safeModel;已过 ALLOWED_INBOUND_MODELS 白名单)。参与 engine 判定 ——
     * 同一 sessionKey 上 glm-5.2 ↔ gpt-5.5 切换会在这里被 resolveEngine 判出
     * engine 变化,走 provider-switch teardown + compact transcript preamble
     * 路径。缺省(cron / pre-warm / hello 等无模型语境)时**不参与比较**,
     * 沿用现存 session 的 engine,防止无模型调用把用户刚切换的 engine 踢回
     * agent 默认。新建 session 时缺省回落 agent.model。
     */
    model?: string
    /** Exact generation returned by control.session.prepare_model_switch. */
    modelSwitchId?: string
    /**
     * **master 的执行权威**(docs/V5_MODEL_AUTHORITY_PLAN.md §2/§3)。两个来源:
     *   - `source:'bridge_signed'`:server.ts dispatchInbound 从验签通过的 inbound
     *     authority(签名 descriptor)取出;
     *   - `source:'local_catalog'`:无 envelope 的本地路径(cron/synthetic/delegate/
     *     wechat/prewarm)在**创建 runner 之前**从 master catalog 投影现取
     *     (server.ts `resolveLocalExecutionIfEnforced`)。
     *
     * 存在 → 该 turn 的 canonicalModel + engine **全部取自它**,容器不再查 baked
     * 白名单/MODEL_ENGINE_MAP(两处 baked 表是 master 之外的第二信任源,与 catalog
     * 快照必然漂移)。
     *
     * 缺省的语义按 flag 分岔(registry.resolveEngine 的 requireAuthority 门):
     *   - flag 未开(个人版 / 过渡期)→ 现状 baked 判定,**行为零变化**;
     *   - flag 开(托管)→ **fail-closed 抛 ModelAuthorityRequiredError**(= 调用方漏了
     *     catalog 判定,不许回落 baked)。
     */
    executionAuthority?: {
      canonicalModel: string
      engine: 'ccb' | 'codex' | 'grok' | 'cursor' | 'zcode' | 'antigravity'
      source?: 'bridge_signed' | 'local_catalog'
    }
    /**
     * Authenticated userId owning the client_sessions row. When provided,
     * stored on the resulting AgentSession so the durable server-authored-
     * append path can bypass the `getClientSession` short-circuit on
     * first-turn races (Phase 0.4 P1-3). Optional for backwards compatibility:
     * cron/webhook/pre-warm callers that don't have a user context can omit it.
     */
    userId?: string
    /**
     * Optional repo/workspace lookup key used only by runner getRepoSnapshot().
     * Keep AgentSession.peerId and _sessionIdToKey keyed by opts.peerId; delegate
     * sessions use this to inherit a parent webchat repo binding without
     * impersonating that parent session identity.
     */
    repoSessionId?: string
    /** Database-authoritative default cwd policy injected by the commercial
     * master. Missing means legacy for prewarm/personal callers. */
    workspaceMode?: SessionWorkspaceMode
    /** Explicit cwd for project workspace (taskboard / bound chat). */
    workspaceCwd?: string
    /** Pass null to unbind an existing session. */
    projectId?: string | null
    contextFingerprint?: string
    assetsRevision?: number
    runContext?: import('./runContextPersist.js').RunContextDescriptor
    frozenProjectContext?: import('@openclaude/storage').FrozenProjectContext | null
    /**
     * 直接父会话键(仅 delegate 子会话传入,已由 handleDelegateTask 经 _resolveDelegateParent
     * 校验存在于内存 + channel 合法 + sourceAgent 匹配)。物化到 AgentSession.parentSessionKey,
     * 供委派进度沿父链向上追溯 webchat 祖先。webchat/普通会话不传。
     */
    parentSessionKey?: string
    title?: string
    delegationDepth?: number
    /** 仅用于**新建** runner 时初始化 CLAUDE_CODE_EFFORT_LEVEL:
     *    - string         : 用作初始值
     *    - null/undefined : 让 CCB 用模型默认 effort
     *
     *  既存 session 的 effort 切换走 submit(effortLevel) — 在那里和 turn 入队
     *  原子串行,避免 getOrCreate→submit 之间的窗口期被另一条并发消息覆盖。 */
    effortLevel?: string | null
    /** Accepted queue grant fence acquired before any session/preflight work. */
    promptQueueExecutionFence?: PromptQueueExecutionFence
    /**
     * Workload tag → CCB `--workload <tag>` → `cc_workload=<tag>` in the
     * billing-header attribution block. Set this to `'cron'` for
     * cron-initiated sessions so Anthropic can serve them at lower QoS and
     * keep automated traffic from competing with interactive calls for
     * rate-limit headroom.
     *
     * Runner creation-time attribute — read only on fresh-spawn, ignored on
     * existing-session reuse. CCB sanitizer requires `[a-z0-9_-]{0,32}`.
     */
    workload?: string
    /**
     * SkillOpt training run id. Set ONLY for a skill-training session; forwarded to
     * the runner → mcp-memory env so the draft-only `skill_propose` tool is exposed
     * and bound to this run. Spawn-time attribute (preserved across model respawn).
     */
    skillTrainRunId?: string
    /** Skill-eval 会话(隔离跑分):标记 + arm 控制,透传 runner env/prompt slots。 */
    skillEvalMode?: boolean
    skillEvalExclude?: string
    skillEvalDraft?: { name: string; dir: string }
    /** V5 Auto-Dream one-shot isolation profile (CCB only). */
    hermeticNoTools?: boolean
    /** Frozen CCB advisor model/provider/profile; last catalog ticket must match. */
    advisorExecutionLock?: import('./advisorMode.js').AdvisorConsultExecution
    /** Static CCB --json-schema contract for one-shot structured output. */
    structuredOutputSchema?: Readonly<Record<string, unknown>>
    /** delegate 子会话计费归因(仅 handleDelegateTask 设置)→ runner
     *  CLAUDE_CODE_EXTRA_METADATA env → master 计费点落
     *  usage_records.mode/parent_session_id/delegate_agent_id。
     *  Spawn-time attribute(delegate sessionKey 带时间戳一次性,不存在复用)。 */
    usageAttribution?: UsageAttributionTag
  },
): Promise<AgentSession> {
  return this._enterSessionCreateGate(opts.sessionKey, () => this._getOrCreateExclusive(opts))
}

/**
 * Idle while the caller owns session.lock. Never calls public submit.
 * The op file is the dispatch claim: only its creator may send one summary.
 * A later call applies a stored capsule and does not reserve another turn.
 *
 * OCV5-297: works only from durable state (candidate / pending op) — the
 * candidate itself is written by the source turn's submit. Nothing here
 * settles on wall-clock alone; an op is abandoned only on authoritative
 * evidence (egress `failed`, or the CCB idle turn ended and egress still
 * has no row after IDLE_STOPPED_GRACE_MS).
 */
export async function finishIdleUnderLock(
  this: SessionSubmitHost,
  session: AgentSession,
  source: {
    sessionId: string
    turnKey: string
  },
  recoveryDir: string = paths.home,
): Promise<void> {
  if (session._idleRunning) return
  const pending = readPendingIdle(recoveryDir, session.sessionKey)
  if (!pending && !readIdleCandidate(recoveryDir, session.sessionKey)) return
  // OCV5-377: stop an idle summary turn parked on a tool call before reading
  // proofs; its open handoff keeps both proofs pending (see stopParkedIdleTurn).
  if (pending) await stopParkedIdleTurn(withIncarnationShutdown(recoveryDir, pending))
  const proof = await waitBoxIdleProof({ sessionId: source.sessionId, turnKey: source.turnKey })
  if (proof.status === 'skipped') {
    // Not configured / invalid identity. Safe to drop only a bare candidate:
    // no op exists, so no summary was dispatched and nothing can arrive late.
    log.error('box idle proof unavailable', {
      sessionKey: session.sessionKey,
      reason: proof.reason,
      pendingOp: Boolean(pending),
    })
    if (!pending) clearIdleCandidate(recoveryDir, session.sessionKey)
    return
  }
  if (proof.status === 'not_found' || proof.status === 'failed') {
    // The source turn produced no Box result: nothing to compact.
    clearIdleCandidate(recoveryDir, session.sessionKey)
    if (!pending) return
    await settleStrandedIdleOp(session, pending, recoveryDir)
    return
  }
  if (proof.status !== 'terminal' && proof.status !== 'terminal_set') {
    // OCV5-620: source proof stayed non-terminal; age out the candidate so
    // submit is not blocked forever, and settle any apply-stuck pending op.
    const stuckCand = readIdleCandidate(recoveryDir, session.sessionKey)
    if (stuckCand && idleCandidateAgedOut(stuckCand)) {
      log.warn('box idle candidate aged out', {
        sessionKey: session.sessionKey,
        createdAt: stuckCand.createdAt,
        proofStatus: proof.status,
      })
      clearIdleCandidate(recoveryDir, session.sessionKey)
      if (pending) await settleStrandedIdleOp(session, pending, recoveryDir)
    }
    return
  }
  // Dispatch gate: a new op is created only when the leaf says the real
  // context needs it (or OC_BOX_IDLE_COMPACT_ALWAYS=1). An op that already
  // exists for this revision is always driven to settlement.
  if (!readIdleOp(recoveryDir, session.sessionKey, proof.revision) && !sourceNeedsIdleOp(proof)) {
    clearIdleCandidate(recoveryDir, session.sessionKey)
    return
  }
  const started = startIdleOp({
    dir: recoveryDir,
    sessionKey: session.sessionKey,
    sourceSessionId: source.sessionId,
    sourceTurnKey: source.turnKey,
    revision: proof.revision,
    idleTurnKey: createHash('sha256')
      .update(`${session.sessionKey}:${proof.revision}`)
      .digest('hex'),
    frozenTail: [],
    attachments: [],
  })
  let op = withIncarnationShutdown(recoveryDir, started.op)
  if (idleOpSettled(op)) {
    clearIdleCandidate(recoveryDir, session.sessionKey)
    return
  }
  const native = readIdleNative(recoveryDir, source.sessionId, proof.revision)
  if (
    nativeShortForOp(native, {
      idleTurnKey: op.idleTurnKey,
      revision: proof.revision,
      sourceSessionId: source.sessionId,
    })
  ) {
    clearIdleCandidate(recoveryDir, session.sessionKey)
    writeSettledIdleOp(recoveryDir, { ...op, disposition: 'short' })
    return
  }
  if (native?.frozenTail.length)
    op = { ...op, frozenTail: native.frozenTail, attachments: native.attachments }
  const summaryProof = await fetchBoxIdleProof({
    sessionId: source.sessionId,
    turnKey: op.idleTurnKey,
  })
  const abandon = native?.summaryText ? undefined : idleAbandonReason(op, summaryProof)
  if (abandon) {
    log.warn('box idle op abandoned', {
      sessionKey: session.sessionKey,
      revision: op.revision,
      reason: abandon,
    })
    clearIdleCandidate(recoveryDir, session.sessionKey)
    writeSettledIdleOp(recoveryDir, { ...op, disposition: 'abandoned', abandonReason: abandon })
    return
  }
  // OCV5-620: prepared summary that never received a matching apply receipt.
  const applyStuckEarly = idleApplyStuckReason(recoveryDir, {
    ...op,
    ...(native?.summaryText && !op.summaryText ? { summaryText: native.summaryText } : {}),
  })
  if (applyStuckEarly) {
    log.warn('box idle op abandoned', {
      sessionKey: session.sessionKey,
      revision: op.revision,
      reason: applyStuckEarly,
    })
    clearIdleCandidate(recoveryDir, session.sessionKey)
    writeSettledIdleOp(recoveryDir, {
      ...op,
      ...(native?.summaryText && !op.summaryText ? { summaryText: native.summaryText } : {}),
      disposition: 'abandoned',
      abandonReason: applyStuckEarly,
    })
    return
  }
  const accepted = idleSummaryAccepted(summaryProof, {
    sessionId: source.sessionId,
    idleTurnKey: op.idleTurnKey,
    nativeSummary: native?.summaryText,
  })
  if (accepted) {
    op = {
      ...op,
      summaryText: accepted.summaryText,
      capsuleSha256: accepted.capsuleSha256,
    }
    if (!native?.summaryText) {
      writeIdleNative(recoveryDir, {
        v: 1,
        opId: op.idleTurnKey,
        revision: op.revision,
        sessionId: source.sessionId,
        summaryText: accepted.summaryText,
        modelCalls: native?.modelCalls ?? 1,
        modelStarted: true,
        frozenTail: op.frozenTail,
        attachments: op.attachments,
      })
    }
  }
  let step = advanceIdleOp({
    op,
    proof,
    allowDispatch:
      started.ownedDispatch && !op.summaryText && !native?.summaryText && !native?.modelStarted,
  })
  const needsApply = Boolean(
    step.op.summaryText && step.op.receiptDigest !== step.op.artifact?.digest,
  )
  if (step.callModel || needsApply) {
    if (!readIdleNative(recoveryDir, source.sessionId, proof.revision)) {
      writeIdleNative(recoveryDir, {
        v: 1,
        opId: step.op.idleTurnKey,
        revision: step.op.revision,
        sessionId: source.sessionId,
        ...(step.op.summaryText ? { summaryText: step.op.summaryText } : {}),
        modelCalls: 0,
        frozenTail: step.op.frozenTail,
        attachments: step.op.attachments,
      })
    }
    session._idleRunning = true
    session._idleInternalTurns = (session._idleInternalTurns ?? 0) + 1
    try {
      const settled = await runBoxIdleTurn(session.runner, {
        input: IDLE_COMPACT_PROMPT,
        turnKey: step.op.idleTurnKey,
        onEvent: () => {},
        sessionTotals: session,
        toolUseIdToName: session.toolUseIdToName ?? new Map(),
      })
      const receipt = settled?.nativeIdleReceipt
      const after = readIdleNative(recoveryDir, source.sessionId, proof.revision)
      if (
        nativeShortForOp(after, {
          idleTurnKey: step.op.idleTurnKey,
          revision: proof.revision,
          sourceSessionId: source.sessionId,
        })
      ) {
        clearIdleCandidate(recoveryDir, session.sessionKey)
        step = { ...step, op: { ...step.op, disposition: 'short' } }
      } else if (!step.op.summaryText && after?.summaryText) {
        const again = await fetchBoxIdleProof({
          sessionId: source.sessionId,
          turnKey: step.op.idleTurnKey,
        })
        const confirmed = idleSummaryAccepted(again, {
          sessionId: source.sessionId,
          idleTurnKey: step.op.idleTurnKey,
          nativeSummary: after.summaryText,
        })
        if (confirmed) {
          step = advanceIdleOp({
            op: {
              ...step.op,
              summaryText: confirmed.summaryText,
              capsuleSha256: confirmed.capsuleSha256,
              frozenTail: after.frozenTail.length ? after.frozenTail : step.op.frozenTail,
              attachments: after.attachments,
            },
            proof,
            allowDispatch: false,
          })
          if (step.op.artifact && step.op.receiptDigest !== step.op.artifact.digest) {
            const applied = await runBoxIdleTurn(session.runner, {
              input: IDLE_COMPACT_PROMPT,
              turnKey: step.op.idleTurnKey,
              onEvent: () => {},
              sessionTotals: session,
              toolUseIdToName: session.toolUseIdToName ?? new Map(),
            })
            const applyReceipt = applied?.nativeIdleReceipt
            if (
              applyReceipt &&
              applyReceipt.opId === step.op.idleTurnKey &&
              applyReceipt.digest === step.op.artifact.digest
            ) {
              step = { ...step, op: { ...step.op, receiptDigest: applyReceipt.digest } }
              clearIdleCandidate(recoveryDir, session.sessionKey)
            }
          }
        }
      }
      if (
        receipt &&
        receipt.opId === step.op.idleTurnKey &&
        step.op.artifact &&
        receipt.digest === step.op.artifact.digest
      ) {
        step = { ...step, op: { ...step.op, receiptDigest: receipt.digest } }
        clearIdleCandidate(recoveryDir, session.sessionKey)
      }
      // OCV5-319: CCB ends the idle turn normally when its summary request
      // was refused (e.g. Box egress BOX_PARAMETER_UNMAPPED on the
      // thinking-disabled compact fallback). No summary arrived and none can
      // be re-dispatched, so this is the same "ended without result" as a
      // thrown turn: shut the child down and record it, or the op never
      // settles and every next message fails with IDLE_HISTORY_PENDING.
      if (
        step.callModel &&
        !step.op.summaryText &&
        !idleOpSettled(step.op) &&
        !readIdleNative(recoveryDir, source.sessionId, proof.revision)?.summaryText
      ) {
        const killed =
          typeof session.runner.shutdown === 'function' &&
          (await session.runner.shutdown().then(
            () => true,
            () => false,
          ))
        if (killed) step = { ...step, op: { ...step.op, runnerKilledAt: Date.now() } }
        if (killed) await stopParkedIdleTurn(step.op)
        log.warn('box idle turn ended without result', {
          sessionKey: session.sessionKey,
          revision: step.op.revision,
          timeout: false,
          noSummary: true,
          runnerKilled: killed,
        })
      }
    } catch (idleErr) {
      // Timeout, crash or error: never a result and never a re-dispatch
      // (ownedDispatch is one-shot). Only a confirmed shutdown of the CCB
      // runner is recorded as evidence that it can no longer send the
      // compact request; a later `not_found` past the grace window then
      // proves nothing was sent. Without it the op waits for egress proof
      // or the operator reset.
      let killed = idleErr instanceof IdleTurnTimeoutError && idleErr.killed
      if (!killed && typeof session.runner.shutdown === 'function') {
        killed = await session.runner.shutdown().then(
          () => true,
          () => false,
        )
      }
      if (killed) step = { ...step, op: { ...step.op, runnerKilledAt: Date.now() } }
      if (killed) await stopParkedIdleTurn(step.op)
      log.warn(
        'box idle turn ended without result',
        {
          sessionKey: session.sessionKey,
          revision: step.op.revision,
          timeout: idleErr instanceof IdleTurnTimeoutError,
          runnerKilled: killed,
        },
        idleErr,
      )
    } finally {
      session._idleRunning = false
      session._idleInternalTurns = Math.max(0, (session._idleInternalTurns ?? 0) - 1)
    }
  }
  // OCV5-620: after apply attempts, age out a still-unsettled prepared summary.
  const applyStuckFinal = idleApplyStuckReason(recoveryDir, step.op)
  if (applyStuckFinal) {
    log.warn('box idle op abandoned', {
      sessionKey: session.sessionKey,
      revision: step.op.revision,
      reason: applyStuckFinal,
    })
    clearIdleCandidate(recoveryDir, session.sessionKey)
    step = {
      ...step,
      op: { ...step.op, disposition: 'abandoned', abandonReason: applyStuckFinal },
    }
  }
  writeSettledIdleOp(recoveryDir, step.op)
}

/** Record a platform-executed turn (for example a trusted Image 2 edit)
 * without asking the language-model runner to execute it. The turn shares
 * the same lock/counter/persistence contract as model turns, then clears
 * the native resume id so the next submit rebuilds from master history and
 * sees this external exchange. */
export async function recordExternalTurn(
  this: SessionSubmitHost,
  session: AgentSession,
  args: {
    userText: string
    assistantText: string
    requestId: string
    traceId?: string
    model?: string
    /** Chat project this external turn resolved at its start (not via submit, so passed here). */
    chatProjectId?: string | null
  },
  reservation?: PromptQueueExternalTurnReservation,
): Promise<{ turnIndex: number; messageId: string }> {
  // Caller owns session.lock through beginExternalTurn().
  {
    let turnIndex: number
    let turnKey: string
    if (reservation) {
      turnIndex = reservation.turnIndex
      const expectedTurnKey = deriveLosslessTurnKey({
        sessionId: session.peerId,
        agentId: session.agentId,
        turnIndex,
        status: 'completed',
        text: '',
      })
      if (reservation.turnKey !== expectedTurnKey) {
        throw new Error('prompt queue external turn reservation does not match session identity')
      }
      turnKey = reservation.turnKey
    } else {
      const legacyId = this._resumeMap.get(session.sessionKey)
      turnIndex = await reserveTurnIndex(session.sessionKey, {
        minimumLastTurn: session.turns,
        legacySessionIds: legacyId && legacyId !== session.sessionKey ? [legacyId] : [],
      })
      turnKey = deriveLosslessTurnKey({
        sessionId: session.peerId,
        agentId: session.agentId,
        turnIndex,
        status: 'completed',
        text: args.assistantText,
      })
    }
    session.turns = turnIndex
    session.currentUserText = args.userText
    session.currentAssistantBuf = args.assistantText
    session.lastUsedAt = Date.now()
    void indexTurn(session.sessionKey, turnIndex, args.userText, args.assistantText).catch((err) =>
      log.warn('external turn index failed', { sessionKey: session.sessionKey, turnIndex }, err),
    )
    const persistence = persistServerAuthoredTurn({
      sessionKey: session.sessionKey,
      peerId: session.peerId,
      agentId: session.agentId,
      userId: session.userId,
      turnIndex,
      ...activeGoalAttribution(session),
      turnKey,
      text: args.assistantText,
      status: 'completed',
      requestId: args.requestId,
      usage: {
        turn: turnIndex,
        ...(args.model ? { model: args.model } : {}),
        ...(args.traceId ? { traceId: args.traceId } : {}),
      },
    })
    this._trackPersistence(persistence)
    scheduleSessionOutputAssetCollection({
      userId: session.userId,
      ...(Object.prototype.hasOwnProperty.call(args, 'chatProjectId')
        ? { chatProjectId: args.chatProjectId }
        : {}),
      sessionId: session.peerId,
      assistantText: args.assistantText,
      sessionKey: session.sessionKey,
      traceId: args.traceId,
    })
    const messageId = `srv-${session.peerId}-${session.agentId}-t${turnIndex}`
    const createdAt = Date.now()
    // Preserve the paid exchange in the next provider context even while
    // master ACK is pending. Otherwise a transient sink outage would make
    // the next model turn forget output that is safely present in the local
    // spool but not yet refresh-visible.
    ;(session._pendingExternalExchanges ??= []).push({
      user: {
        id: `external-${args.requestId}-user`,
        role: 'user',
        text: args.userText,
        status: 'completed',
        ts: createdAt - 1,
      },
      assistant: {
        id: messageId,
        role: 'assistant',
        text: args.assistantText,
        status: 'completed',
        ts: createdAt,
      },
    })
    if (!(await persistence)) {
      throw new Error('external turn is durably queued but master has not acknowledged it')
    }

    // The native provider thread did not execute this turn. Force a clean
    // resume so the next user message receives master history (including
    // the external assistant row) instead of continuing a stale thread.
    this._resumeMap.delete(session.sessionKey)
    this._resumeMapTimestamps.delete(session.sessionKey)
    this._resumeMapProvider.delete(session.sessionKey)
    this._resumeMapLastCost.delete(session.sessionKey)
    this._resumeMapCostImprecise.delete(session.sessionKey)
    this._resumeMapHistory.delete(session.sessionKey)
    session.ccbSessionId = null
    session.runner.clearSessionId?.()
    this._saveResumeMap()
    if (session.runner.isRunning) await session.runner.shutdown()
    session._historicalContextInjected = false
    session._historicalContextInjectedKey = undefined
    return {
      turnIndex,
      messageId,
    }
  }
}

/** Acquire the per-session turn lock for platform work that runs outside
 * the model runner. Stop requests abort its signal, and the returned finish
 * callback releases both the lock and reconnect-visible activity count. */
export async function beginExternalTurn(
  this: SessionSubmitHost,
  session: AgentSession,
  opts?: {
    queueTurn?: boolean
    queueExecutionFence?: PromptQueueExecutionFence
    clientMessageId?: string
  },
): Promise<{
  signal: AbortSignal
  finish: (outcome: 'completed' | 'errored') => void
}> {
  if (this.isRuntimeRecycleDraining()) throw new RuntimeRecycleDrainingError()
  const queueTurn = opts?.queueTurn === true
  const ownsDispatchFence = this._ownsPromptQueueExecutionFence(
    session.sessionKey,
    opts?.queueExecutionFence,
  )
  if (opts?.queueExecutionFence && !ownsDispatchFence) {
    throw new Error('PROMPT_QUEUE_EXECUTION_INVARIANT: stale queue execution fence')
  }
  const prev = session.lock
  let release: () => void = () => {}
  this.beginClientTurn(session)
  try {
    assertPromptQueueExecutionAdmission(
      queueTurn,
      session._activeTurnCount ?? 0,
      session._activeClientTurnCount ?? 0,
      this._promptQueueExecutions.has(session) ||
        this._promptQueueExecutionKeys.has(session.sessionKey) ||
        (this._promptQueueDispatchFences.has(session.sessionKey) && !ownsDispatchFence),
    )
  } catch (err) {
    this.endClientTurn(session, 'errored')
    throw err
  }
  if (queueTurn) {
    this._promptQueueExecutions.add(session)
    this._promptQueueExecutionKeys.add(session.sessionKey)
  }
  session.lock = new Promise<void>((resolve) => {
    release = resolve
  })
  const controller = new AbortController()
  try {
    await prev
  } catch (err) {
    this.endClientTurn(session, 'errored')
    if (queueTurn) {
      this._promptQueueExecutions.delete(session)
      this._promptQueueExecutionKeys.delete(session.sessionKey)
    }
    release()
    throw err
  }
  session._externalTurnAbort = controller
  if (opts?.clientMessageId) {
    session._runningClientMessageId = opts.clientMessageId
  }
  let finished = false
  return {
    signal: controller.signal,
    finish: (outcome) => {
      if (finished) return
      finished = true
      if (session._externalTurnAbort === controller) session._externalTurnAbort = undefined
      if (session._runningClientMessageId === opts?.clientMessageId) {
        session._runningClientMessageId = undefined
      }
      session._currentTurnKey = undefined
      session._currentTurnIndex = undefined
      this.endClientTurn(session, outcome)
      if (queueTurn) {
        this._promptQueueExecutions.delete(session)
        this._promptQueueExecutionKeys.delete(session.sessionKey)
      }
      release()
    },
  }
}

/** Return the resumable id for this session iff the persisted entry was
 *  produced by `wantProvider`. Cross-provider mismatches return undefined
 *  so we never feed a CCB session_id to codex (or vice versa).
 *
 *  Durable-artifact gate (all engines): the head id must have a transcript
 *  on disk (CCB / Cursor Sand JSONL, Codex rollout, Grok session dir, native
 *  Cursor store.db at the spawn cwd). When it does not — the CLI emitted
 *  `session_id` and died before writing, or the container was rebuilt
 *  mid-spawn — walk the per-session history ladder and promote the newest
 *  prior id whose artifact exists, instead of dropping straight to lossy
 *  history replay. Only when nothing on the ladder is resumable is the
 *  entry dropped (UI history stays visible in the DB; the engine simply has
 *  no native memory — unavoidable when every transcript is gone).
 *
 *  Native Cursor keeps its special case: a store.db missing at *this* cwd is
 *  first a hash-relocation problem, not staleness. */
export function _resumeIdFor(
  this: SessionSubmitHost,
  sessionKey: string,
  wantProvider: string,
  workspacePath?: string,
): string | undefined {
  const id = this._resumeMap.get(sessionKey)
  if (!id) return undefined
  let tag = normalizeEngineTag(this._resumeMapProvider.get(sessionKey))
  // A false "no transcript" drop used to delete the provider and let the
  // live-session overlay save the same id back as implicit ccb. The Fast
  // transcript is still on disk; a positive Grok artifact puts the tag back.
  // An unknown probe has no path and must not retag a real ccb id.
  if (tag !== wantProvider && wantProvider === 'grok' && tag === CCB_PROVIDER_TAG) {
    const recovered = probeResumeArtifact('grok', id)
    if (recovered.exists && recovered.path) {
      this._resumeMapProvider.set(sessionKey, 'grok')
      tag = 'grok'
      this._saveResumeMap()
    }
  }
  if (tag !== wantProvider) return undefined

  if (tag === 'cursor' && isCursorSandBoxCcResumeId(id)) {
    if (!cursorSandBoxCcResumeInnerId(id)) {
      log.warn('resume-map Cursor box Claude entry is malformed — dropping silently', {
        sessionKey,
        resumeId: id,
      })
      this._forgetResumeEntry(sessionKey)
      this._saveResumeMap()
      return undefined
    }
    // The JSONL is on the account box, not in this container.
    return id
  }

  if (tag === 'cursor' && isAnyCursorSandResumeId(id)) {
    const sandJsonlId = cursorSandResumeInnerId(id) ?? cursorSandOfficialCcResumeInnerId(id)
    if (!sandJsonlId) {
      log.warn('resume-map Cursor Sand entry is malformed — dropping silently', {
        sessionKey,
        resumeId: id,
      })
      this._forgetResumeEntry(sessionKey)
      this._saveResumeMap()
      return undefined
    }
    if (this._ccbJsonlExists(sandJsonlId)) return id
    const promoted = this._resolveDurableResumeId(sessionKey, tag, undefined, workspacePath)
    if (promoted) return promoted
    log.warn('resume-map Cursor Sand entry points to missing JSONL — dropping silently', {
      sessionKey,
      resumeId: id,
    })
    this._forgetResumeEntry(sessionKey)
    this._saveResumeMap()
    return undefined
  }

  if (tag === 'cursor') {
    if (!workspacePath) return id
    if (cursorResumeStoreExists(workspacePath, id)) return id
    // Do not drop the map: spawn cwd is the resume authority, and a
    // recomputed overlay can hash to a different chats/ dir than the live
    // CLI. Deleting here forces historical replay on the next follow-up
    // even when store.db is still on disk.
    // isolated_v1 次轮绑项目会改 spawn cwd → md5 目录对不上。旧 store 还在
    // 时迁到当前哈希再 --resume;失败才走 history 梯子;再失败才跳过 lookup。
    const relocated = relocateCursorResumeStore({
      resumeId: id,
      currentWorkspacePath: workspacePath,
      sessionKey,
    })
    if (relocated) {
      log.info('relocated Cursor resume store to current workspace', {
        sessionKey,
        resumeId: id,
        relocated: relocated.relocated,
      })
      return id
    }
    const promoted = this._resolveDurableResumeId(sessionKey, tag, undefined, workspacePath)
    if (promoted) return promoted
    log.warn('resume-map Cursor store not at this workspace — keeping map, skipping this lookup', {
      sessionKey,
      resumeId: id,
    })
    return undefined
  }

  // CCB / codex / grok / zcode: single durable-artifact gate + history ladder.
  const resolved = this._resolveDurableResumeId(sessionKey, tag, id, workspacePath)
  if (resolved) return resolved
  log.warn('resume-map entry has no durable transcript on disk — dropping silently', {
    sessionKey,
    provider: tag,
    resumeId: id,
  })
  if (tag === 'grok') this._releaseGrokResumeHead(sessionKey)
  this._forgetResumeEntry(sessionKey)
  this._saveResumeMap()
  return undefined
}

/**
 * Engine-agnostic durable-artifact fallback. When the mapped head id has no
 * durable transcript on disk, walk the per-session history ladder and promote
 * the newest id that positively exists. Returns the id to resume with, or
 * undefined when nothing on the ladder is resumable (caller then falls back
 * to history replay exactly as before).
 *
 * Head ids whose artifact is *unknown* (engine we cannot probe, unreadable fs)
 * are returned as-is — conservative, same as `_ccbJsonlExists`.
 */
export function _resolveDurableResumeId(
  this: SessionSubmitHost,
  sessionKey: string,
  provider: string,
  head: string | undefined,
  workspacePath?: string,
  opts?: {
    /** Id the engine just rejected at runtime — never re-pick it even if its
     *  artifact looks present (non-empty file ≠ resumable conversation). */
    exclude?: string
    /** Default true: steer the live adapter via setResumeSessionId. Pass
     *  false when the caller IS the engine (codex resolveResumeFallback runs
     *  inside the kernel's own attach path and sets threadId itself). */
    syncRunner?: boolean
  },
): string | undefined {
  const exclude = opts?.exclude
  const rejected = this._resumeRejectedIds.get(sessionKey)
  const history = (this._resumeMapHistory.get(sessionKey) ?? []).filter(
    (h) => h !== exclude && h !== head && !rejected?.has(h),
  )
  const headCandidate = head && head !== exclude && !rejected?.has(head) ? head : undefined
  const picked = pickResumableId(provider, headCandidate, history, {
    workspacePath,
  })
  if (!picked) return undefined
  if (picked.fromHistory) {
    log.warn('resume-map head has no durable transcript — promoting prior id from history', {
      sessionKey,
      provider,
      staleId: head ?? exclude ?? null,
      promotedId: picked.id,
      artifact: picked.probe.path,
    })
    // Promote in place: the dead head is dropped (not kept in history — it
    // has nothing to resume), the promoted id becomes head, remaining
    // history keeps only ids older than the promoted one.
    const idx = history.indexOf(picked.id)
    this._resumeMap.set(sessionKey, picked.id)
    this._resumeHeadPromotedFromHistory.set(sessionKey, picked.id)
    this._resumeMapProvider.set(sessionKey, provider)
    this._resumeMapHistory.set(sessionKey, history.slice(idx + 1))
    // Sync the live session BEFORE saving: _saveResumeMap overlays live
    // sessions onto the map, so an unsynced session.ccbSessionId would write
    // the dead head straight back (review B2). The runner must follow too,
    // otherwise the next spawn still --resumes the dead id.
    const live = this.sessions.get(sessionKey)
    if (live && live.providerTag === provider) {
      live.ccbSessionId = picked.id
      if (opts?.syncRunner !== false) live.runner.setResumeSessionId?.(picked.id)
    }
    this._saveResumeMap()
  }
  return picked.id
}
