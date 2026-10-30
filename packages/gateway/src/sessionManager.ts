import type { PreheatPreparation } from './speculativePreheat.js'
import { renderHistoricalContextJsonPrompt } from './historicalContextPrompt.js'
import { isBoxApiModel } from '@openclaude/protocol'
import { getDesiredIntelligentUi, intelligentUiNeedsRestart, isIntelligentUiApplied } from './intelligentUiDesired.js'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve as resolvePath } from 'node:path'
import {
  resolveRuntimeExecutionAgent,
  IdentityAssetsError,
  type IdentityCompatRuntimeContext,
  type AgentDef,
  type OpenClaudeConfig,
  appendServerAuthoredMessageDurable,
  getClientSession,
  getEngineContextMessages,
  getMaxTurnIdx,
  hasPersistedTurnActivity,
  indexTurn,
  MemoryDir,
  type MemoryTurnPolicyDecision,
  classifyMemoryTurnPolicy,
  inheritMemoryTurnPolicy,
  readMemoryTurnPolicy,
  recordTurnDispatchRunning,
  getTurnDispatchByDispatchId,
  reserveTurnIndex,
  recordMemoryUsageEvent,
  paths,
  projectSessionFingerprint,
  loadProjectContext,
  skillOverlayManifestSha256,
  type KernelFileLock,
  upsertSessionMeta,
} from '@openclaude/storage'
// M0 engine 适配层:CCB 私有件(parser/telemetry/auth 分类)已下沉 CcbAdapter,
// 本文件只消费 engine 中立契约(EngineAdapter / EngineEvent / TurnSummary /
// PartialSnapshot)。ccbAdapter / codexAdapter 的 import 兼有 registry 注册副作用
// ('ccb' / 'codex' factory)。
import {
  abandonAllIdle,
  advanceIdleOp,
  boxTurnMayIdle,
  consumeIdleReset,
  currentIdleSource,
  idleAbandonReason,
  idleOpSettled,
  idleProofWaitMs,
  pruneIdleOps,
  readIdleReset,
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

import { isCcbUserCancellationDiagnostic } from './engine/ccbAdapter.js'
import { isBoxGptWebCatalogModel } from './engine/cursorBoxCc.js'
import './engine/codexAdapter.js'
import './engine/grokAdapter.js'
import { decideEngineCwd } from './engineCwd.js'
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
import './engine/zcodeAdapter.js'
import './engine/antigravityAdapter.js'
import {
  RESUME_HISTORY_MAX,
  pickResumableId,
  probeResumeArtifact,
} from './engine/resumeArtifacts.js'
import type {
  AutomaticRetryState,
  CollabAgentPolicy,
  EngineAdapter,
  EngineTurnRun,
} from './engine/engineAdapter.js'
import type {
  DurableRuntimeEvent,
  EngineBillingEvent,
  EngineExternalBillingEvent,
  EngineEvent,
  EngineFinalMeta,
  SegmentRecord,
  SessionStreamEvent,
  TurnSummary,
  TurnToolEntry,
} from './engine/engineEvents.js'
import { createEngine, EngineNotEnabledError, isEngineEnabled, resolveEngine } from './engine/registry.js'
import { isEngineLocalTurnExempt, isModelAuthorityRequired } from './modelAuthority.js'
import type { CodexProviderConfigOverride } from './engine/codexShared.js'
import type { GrokRouteOverride } from './engine/grokAdapter.js'
import type { ZcodeRouteOverride } from './engine/zcodeAdapter.js'
import type { AntigravityRouteOverride } from './engine/antigravityAdapter.js'
import { eventBus, createEvent } from './eventBus.js'
import { beginMemoryTurnTracking } from './memoryTurnObserver.js'
import {
  createTurnUsageRecorder,
  mapTurnTerminalStatus,
  type TurnTerminalStatus,
} from './turnUsage.js'
import { emptyCompletedTurnAssistantText, shouldFailClosedEmptyModelTurn } from './emptyCompletedTurn.js'
import { applyPlatformCostIfMissing } from './usageCost.js'
import {
  CCB_PROVIDER_TAG,
  CCB_RESUME_HISTORY_CONTEXT_VERSION,
  normalizeEngineTag,
  ResumeStore,
} from './resumeStore.js'
import { collectSessionOutputAssets } from './projectAssetCollector.js'
import { adoptRunContext } from './runContextPersist.js'
import {
  deriveLosslessTurnKey,
  getV3MasterSinkOrNull,
  type V3MasterSinkPayload,
} from './v3MasterSink.js'
import { failClosedOnRunningCasMiss } from './turnDispatchInbox.js'
import {
  AUTOMATIC_TURN_RETRY_MAX,
  assessTurnRecoveryTape,
  type CallTokenUsageSnapshot,
  AUTHORITY_TURN_MAX_LIFETIME_MS,
  collectModelHistoryMediaPathHints,
  modelHistoryRoleLabel,
  modelHistorySemanticRole,
  modelHistorySemanticText,
  type ModelHistorySemanticRole,
  type TurnWaiveReason,
  type DurableAgentGroup,
  type DurableGoalUsageRecord,
  type GoalStateSnapshot,
  type OutboundContentBlock,
  type ServiceTier,
  type SessionWorkspaceMode,
} from '@openclaude/protocol'
import { resolveExecutionModel } from './server.js'
import {
  buildLateDelegateContinuationArgs,
  isValidDelegateOwnerLocator,
  lateDelegateGroupIdentity,
  type DelegateOwnerTurnLocator,
} from './delegateLateCompletion.js'
import { classifyRunError } from './errorClassify.js'
import type {
  GatewayEngineErrorEvent,
  GatewayTerminalErrorCode,
  GatewayTurnPhase,
  ModelProgressPhase,
} from './ccbMessageParser.js'
import { isCcbSlashCommandPrompt } from './ccbNativeCompaction.js'
import {
  type ExecutionTarget,
  type RemoteTargetController,
  RemoteTargetUnavailableError,
} from './remoteTarget.js'
import type { RepoSnapshot } from './sessionRepoWorkspace.js'
import type { TurnModelAuthority, UsageAttributionTag } from './subprocessRunner.js'
import { isPatrolSessionKey } from './taskboard/domain.js'
import { startMemoryTurnPolicyLease } from './memoryTurnPolicyLease.js'
import {
  applyEfficiencyToolObservation,
  finalizeEfficiencyTurn,
  prepareEfficiencyTurnNote,
} from './agentEfficiencyGuard.js'
import {
  advanceTransientBreaker,
  formatTransientCircuitOpenError,
  resolveTransientBreakerThreshold,
} from './transientRetryCircuit.js'
import { log } from './sessionManagerLog.js'
import { type TurnRunnerHost, _runOneTurn as _runOneTurnImpl, runOneTurnWithRetry as runOneTurnWithRetryImpl } from './sessionTurnRunner.js'
import { type SessionSubmitHost, submit as submitImpl, _getOrCreateExclusive as _getOrCreateExclusiveImpl, getOrCreate as getOrCreateImpl, finishIdleUnderLock as finishIdleUnderLockImpl, recordExternalTurn as recordExternalTurnImpl, beginExternalTurn as beginExternalTurnImpl, _resumeIdFor as _resumeIdForImpl, _resolveDurableResumeId as _resolveDurableResumeIdImpl } from './sessionSubmit.js'
import { type SessionTailHost, _persistTailBatch as _persistTailBatchImpl, _dispatchPostTerminalRuntimeEvent as _dispatchPostTerminalRuntimeEventImpl, _foldPostTerminalTail as _foldPostTerminalTailImpl, _drainTailFolding as _drainTailFoldingImpl, _drainTailPersistQueue as _drainTailPersistQueueImpl, _buildTailCapMarker as _buildTailCapMarkerImpl, _scheduleTailPersistWorker as _scheduleTailPersistWorkerImpl, _chainTailPersist as _chainTailPersistImpl, _trackPersistence as _trackPersistenceImpl, _warnMissingPostTerminalOwner as _warnMissingPostTerminalOwnerImpl } from './sessionTail.js'
import { type SessionAgentGroupsHost, deliverLateDelegateAgentGroup as deliverLateDelegateAgentGroupImpl, bufferPendingAgentGroup as bufferPendingAgentGroupImpl, drainPendingAgentGroups as drainPendingAgentGroupsImpl, _settleDrainedOwnerGroups as _settleDrainedOwnerGroupsImpl, _claimDrainedOwnerGroups as _claimDrainedOwnerGroupsImpl, _sealOwnerTurn as _sealOwnerTurnImpl, _runOnOwnerChain as _runOnOwnerChainImpl, _admitExactOwnerRun as _admitExactOwnerRunImpl, _matchLiveSessionsOwnerRun as _matchLiveSessionsOwnerRunImpl, _matchLiveOwnerRun as _matchLiveOwnerRunImpl, _trimExactOwnerRuns as _trimExactOwnerRunsImpl } from './sessionAgentGroups.js'
import { type SessionLifecycleHost, preheatRunner as preheatRunnerImpl, recyclePeerForRepoChange as recyclePeerForRepoChangeImpl, recyclePeerForRepoUnbind as recyclePeerForRepoUnbindImpl, startEvictionLoop as startEvictionLoopImpl, shutdownAll as shutdownAllImpl, destroySession as destroySessionImpl, retireKeepResume as retireKeepResumeImpl, scheduleIdleDrain as scheduleIdleDrainImpl, applyIdleResetIfRequested as applyIdleResetIfRequestedImpl, _ccbJsonlExists as _ccbJsonlExistsImpl, _cursorWorkspacePath as _cursorWorkspacePathImpl, setExecutionTarget as setExecutionTargetImpl, prepareModelSwitch as prepareModelSwitchImpl, armRuntimeRecycleDrain as armRuntimeRecycleDrainImpl } from './sessionLifecycle.js'
// Moved to ./sessionTypes.js (FINDINGS §7.6, OCV5-480); re-exported for existing importers.
export type { AgentSession } from './sessionTypes.js'
import type { AgentSession } from './sessionTypes.js'
// Moved to ./sessionTurnOutcome.js (FINDINGS §7.6, OCV5-480); re-exported for existing importers.
export { persistServerAuthoredTurnOutcome } from './sessionTurnOutcome.js'
import { persistServerAuthoredTurnOutcome } from './sessionTurnOutcome.js'


/**
 * generic 引擎失败(非 auth、非 terminalOverride 控制码)的 tape errorCode 细分。
 *
 * 命中 classifyRunError 的语义码就落**小写语义码**(model_capacity /
 * rate_limited / upstream_failed / insufficient_credits),让回看/遥测能区分
 * 失败种类;未命中保持历史 `'ENGINE_ERROR'`(值域不变,零迁移)。
 *
 * **大写控制码路径(AUTH_ERROR / NO_RESPONSE / PHANTOM_TURN / IDLE_TIMEOUT /
 * LIVENESS_TIMEOUT / TURN_LIMIT / USER_CANCELLED …)不经本函数** —— 免单查询
 * (internalTurnWaive)按大写码精确匹配存量,细分只作用于原本会写 'ENGINE_ERROR'
 * 的那一支。`_` 前缀 = 契约测试 seam。
 */
export function _tapeErrorCodeForGenericFailure(detail: string | undefined): string {
  const cls = classifyRunError(detail)
  return cls.code === 'unknown' ? 'ENGINE_ERROR' : cls.code
}

/**
 * E4.2 — tape 大写终态控制码 → wire 可透传的 gateway 权威终态码。
 *
 * 只映射 wire OutboundError.code 枚举里存在的码(user_cancelled / runner_crashed /
 * service_restart / auth_error / engine_error);免单/静默恢复类(NO_RESPONSE /
 * LIVENESS_TIMEOUT / IDLE_TIMEOUT / TURN_LIMIT …)刻意不映射 —— 它们有独立的
 * waiver 展示分支,error 事件保持无 errorCode 走既有 classify 兜底。
 * `_` 前缀 = 契约测试 seam。
 */
export function _wireTerminalCodeForTape(
  code: string | undefined,
): GatewayTerminalErrorCode | undefined {
  switch (code) {
    case 'USER_CANCELLED':
      return 'user_cancelled'
    case 'RUNNER_CRASHED':
      return 'runner_crashed'
    case 'SERVICE_RESTART':
      return 'service_restart'
    case 'AUTH_ERROR':
      return 'auth_error'
    case 'ENGINE_ERROR':
      return 'engine_error'
    default:
      return undefined
  }
}

/** E6 — queued_to_outbox 降级终态的用户向说明(受控文案,全角标点)。 */
export const SESSION_PERSIST_QUEUED_NOTICE =
  '回复已生成，但会话存储暂时不可用，内容已安全排队待写入。稍后刷新即可看到完整记录。'

/**
 * 缺省 agent 工作目录(agent 未显式 pin cwd 时用)。
 *
 * 设计 §3.2:商业版容器里 supervisor 注入 OPENCLAUDE_DEFAULT_WORKSPACE =
 * /home/agent/.openclaude/workspace(在 data named volume 内,容器重建后文件仍在);
 * entrypoint 负责创建持久化根目录。legacy 模式只在「env 已设 **且** 目录已存在」
 * 时采用它,否则回落 process.cwd()(个人版/宿主机不设该 env → 行为与改造前一致)。
 * isolated_v1 只在该根目录内按可信 client session id 惰性创建 `sessions/<id>`;
 * 根目录缺失时 fail closed,不把隔离会话悄悄落回共享 cwd。
 */
export function resolveDefaultWorkspaceCwd(
  workspaceMode: SessionWorkspaceMode = 'legacy',
  sessionId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const ws = env.OPENCLAUDE_DEFAULT_WORKSPACE?.trim()
  let baseDir: string | null = null
  if (ws) {
    try {
      if (statSync(ws).isDirectory()) baseDir = ws
    } catch {
      // 目录不存在/不可 stat → 回落现状
    }
  }
  if (workspaceMode === 'legacy') return baseDir ?? process.cwd()
  if (baseDir === null) {
    throw new Error('isolated session workspace requires OPENCLAUDE_DEFAULT_WORKSPACE')
  }
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{8,50}$/.test(sessionId)) {
    throw new Error('isolated session workspace requires a valid client session id')
  }
  const sessionDir = join(baseDir, 'sessions', sessionId)
  mkdirSync(sessionDir, { recursive: true })
  return sessionDir
}

/**
 * 是否运行在 commercial 托管运行时(v3/v5 商业版容器 / master 实例)。
 *
 * 判定复用仓内既有惯例(不新造信号):
 *   - `OPENCLAUDE_V3_MASTER_BASE_URL` + `OPENCLAUDE_V3_CONTAINER_TOKEN` 成对
 *     出现 = v3supervisor spawn 的商业容器(与 v3MasterSink.readV3MasterSinkConfig /
 *     codexAppServerRunner token-refresh 同一判定,双 env 均由 supervisor 注入);
 *   - `OC_RUNTIME_CHANNEL` 存在 = commercial 实例 channel 标签(runtimeChannel.ts
 *     单一权威;systemd EnvironmentFile 注入,个人版永不设置)。
 *
 * 消费点:submit() 的 codex 计费 fail-closed guard(P0 计费旁路封堵)。个人版 /
 * 测试环境两组信号都缺省 → guard 关闭,codex 无 requestId 也照跑(无 bridge 场景)。
 */
export function isCommercialManagedRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OC_RUNTIME_CHANNEL !== undefined && env.OC_RUNTIME_CHANNEL.trim() !== '') return true
  return Boolean(env.OPENCLAUDE_V3_MASTER_BASE_URL && env.OPENCLAUDE_V3_CONTAINER_TOKEN)
}

export function assertPromptQueueExecutionAdmission(
  queueTurn: boolean,
  activeSubmits: number,
  activeClientTurns: number,
  queueExecutionActive = false,
): void {
  if (queueTurn && (activeSubmits !== 0 || activeClientTurns !== 1)) {
    throw new Error(
      `PROMPT_QUEUE_EXECUTION_INVARIANT: expected one client turn and no queued submit ` +
        `(client=${activeClientTurns}, submit=${activeSubmits})`,
    )
  }
  if (queueExecutionActive) {
    throw new Error('PROMPT_QUEUE_EXECUTION_INVARIANT: queue execution already owns this session')
  }
}

export interface PromptQueueExternalTurnReservation {
  turnIndex: number
  turnKey: string
}

export type ChatHistoryMessage = {
  id?: unknown
  role?: unknown
  text?: unknown
  content?: unknown
  status?: unknown
  system?: unknown
}

export type PendingExternalExchange = {
  user: { id: string; role: 'user'; text: string; status: 'completed'; ts: number }
  assistant: { id: string; role: 'assistant'; text: string; status: 'completed'; ts: number }
}

export function normForCompare(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * Assistant-role notices master writes itself (no engine produced them, so no
 * native session is missing them): the automatic-recovery give-up card
 * (pgSessionsBackend appendRecoveryGiveUpTerminalCard), the dispatch
 * reconciler's visible fallback, and the degraded-tape placeholder.
 * OCV5-556: a give-up card as the latest assistant row was read as another
 * agent's answer, which dropped the native resume and replayed 70 messages.
 */
const SERVER_NOTICE_ASSISTANT_ID_PREFIXES = [
  'm-recovery-giveup-',
  'visible-fallback:',
  'tape-degraded:',
] as const

function isServerNoticeAssistantId(id: string): boolean {
  return SERVER_NOTICE_ASSISTANT_ID_PREFIXES.some((prefix) => id.startsWith(prefix))
}

/** Index of the latest assistant row an engine turn produced (server notices skipped). */
function latestEngineAssistantIndex(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const raw = messages[i]
    if (!raw || typeof raw !== 'object') continue
    const msg = raw as ChatHistoryMessage & { id?: unknown }
    if (msg.system === true) continue
    if (msg.role !== 'assistant') continue
    const id = typeof msg.id === 'string' ? msg.id : ''
    if (id && isServerNoticeAssistantId(id)) continue
    return i
  }
  return -1
}

function latestAssistantMessageId(messages: unknown[]): string | null {
  const index = latestEngineAssistantIndex(messages)
  if (index < 0) return null
  const id = (messages[index] as { id?: unknown }).id
  return typeof id === 'string' && id ? id : null
}

function ownAgentAssistantPrefix(peerId: string, agentId: string): string {
  return `srv-${peerId}-${agentId}-t`
}

export function shouldTreatMasterHistoryAsProviderGap(opts: {
  messages: unknown[]
  peerId: string
  agentId: string
}): boolean {
  const latestAssistantId = latestAssistantMessageId(opts.messages)
  if (!latestAssistantId) return false
  return !latestAssistantId.startsWith(ownAgentAssistantPrefix(opts.peerId, opts.agentId))
}

/**
 * Master rows the native session of this agent has not seen: everything after
 * this agent's latest own engine answer. Null when that answer is not in the
 * window (the native session's coverage is unknown, so only a full rebuild is
 * safe) or nothing engine-produced follows it.
 */
export function providerGapMessagesAfterOwnTurn(opts: {
  messages: unknown[]
  peerId: string
  agentId: string
}): unknown[] | null {
  const prefix = ownAgentAssistantPrefix(opts.peerId, opts.agentId)
  for (let i = opts.messages.length - 1; i >= 0; i--) {
    const raw = opts.messages[i]
    if (!raw || typeof raw !== 'object') continue
    const msg = raw as ChatHistoryMessage
    if (msg.system === true || msg.role !== 'assistant') continue
    if (typeof msg.id !== 'string' || !msg.id.startsWith(prefix)) continue
    // `${prefix}3-thinking` / `-tool-…` rows belong to the same turn as `${prefix}3`.
    const tail = opts.messages.slice(i + 1)
    return latestEngineAssistantIndex(tail) >= 0 ? tail : null
  }
  return null
}

export function historicalContextInjectionKey(opts: {
  messages: unknown[] | null | undefined
  peerId: string
  agentId: string
  hasProviderResumeId?: boolean
}): string | null {
  const messages = Array.isArray(opts.messages) ? opts.messages : []
  if (messages.length === 0) return opts.hasProviderResumeId ? null : 'local:no-provider-resume'
  const latestAssistantId = latestAssistantMessageId(messages)
  if (
    latestAssistantId &&
    shouldTreatMasterHistoryAsProviderGap({
      messages,
      peerId: opts.peerId,
      agentId: opts.agentId,
    })
  ) {
    return `master:${latestAssistantId}`
  }
  return opts.hasProviderResumeId ? null : `master:${latestAssistantId ?? 'no-assistant'}`
}

export function buildHistoricalContextPrompt(
  messages: unknown[],
  currentUserText: string,
  maxHistoryChars?: number,
  maxPromptBytes?: number,
  includeCurrentUserText = true,
): string | null {
  const promptUserText = includeCurrentUserText ? currentUserText : ''
  const currentNorm = normForCompare(currentUserText)
  const rows: Array<{ role: ModelHistorySemanticRole; text: string; status?: unknown }> = []
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue
    const msg = raw as ChatHistoryMessage
    if (msg.system === true) continue
    const role = modelHistorySemanticRole(msg)
    if (!role) continue
    const text = modelHistorySemanticText(msg).trim()
    if (!text) continue
    rows.push({ role, text, status: msg.status })
  }
  while (rows.length > 0) {
    const last = rows[rows.length - 1]
    const lastNorm = normForCompare(last.text)
    const isCurrent =
      last.role === 'user' &&
      (last.status === 'sending' ||
        last.status === 'queued' ||
        (currentNorm && (lastNorm === currentNorm || currentNorm.startsWith(lastNorm))))
    if (!isCurrent) break
    rows.pop()
  }
  if (rows.length === 0) return null
  const renderPrompt = (
    selectedRows: Array<{ role: ModelHistorySemanticRole; text: string }>,
  ): string =>
    renderHistoricalContextJsonPrompt(
      selectedRows.map((message) => ({
        role: modelHistoryRoleLabel(message.role),
        text: message.text,
      })),
      promptUserText,
    )
  if (
    typeof maxPromptBytes === 'number' &&
    Number.isSafeInteger(maxPromptBytes) &&
    maxPromptBytes > 0
  ) {
    let selected: typeof rows = []
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const candidate = [rows[index]!, ...selected]
      if (Buffer.byteLength(renderPrompt(candidate), 'utf8') > maxPromptBytes) break
      selected = candidate
    }
    return selected.length > 0 ? renderPrompt(selected) : null
  }
  // Storage has already selected the exact contiguous semantic suffix against
  // the executable model context window (including the current prompt and a
  // per-record envelope allowance). The normal path does not apply a second
  // cap here. maxHistoryChars is reserved for a provider-confirmed context
  // rejection, where the same turn immediately retries with an exact suffix.
  let body = rows
    .map((message) => `${modelHistoryRoleLabel(message.role)}: ${message.text}`)
    .join('\n\n')
  if (
    typeof maxHistoryChars === 'number' &&
    Number.isSafeInteger(maxHistoryChars) &&
    maxHistoryChars > 0 &&
    body.length > maxHistoryChars
  ) {
    let start = body.length - maxHistoryChars
    const first = body.charCodeAt(start)
    if (first >= 0xdc00 && first <= 0xdfff && start > 0) start -= 1
    body = `[Earlier history remains stored and can be retrieved when needed.]\n${body.slice(start)}`
  }
  return [
    '<openclaude_previous_context>',
    'The current OpenClaude session was previously served by a different runner/provider or cannot be natively resumed. Use this transcript as prior conversation context. Do not restate it unless needed.',
    body,
    '</openclaude_previous_context>',
    '',
    '<current_user_message>',
    promptUserText,
    '</current_user_message>',
  ].join('\n')
}

function buildNativeModelHandoffContext(summaryText: string, mediaPathHints = ''): string {
  const sections = [
    '<openclaude_native_model_handoff>',
    'The previous source model compacted this populated session for the selected target model. Treat the following native handoff as prior conversation context. Do not restate it unless needed.',
    summaryText,
  ]
  if (mediaPathHints.trim()) {
    sections.push('', mediaPathHints.trimEnd())
  }
  sections.push('</openclaude_native_model_handoff>')
  return sections.join('\n')
}

export function buildNativeModelHandoffPrompt(
  summaryText: string,
  currentUserText: string,
  mediaPathHints = '',
): string {
  return [
    buildNativeModelHandoffContext(summaryText, mediaPathHints),
    '',
    '<current_user_message>',
    currentUserText,
    '</current_user_message>',
  ].join('\n')
}

export function buildNativeModelHandoffPayload(
  summaryText: string,
  currentUserInput: string | Array<{ type: string; [key: string]: unknown }>,
  mediaPathHints = '',
): string | Array<{ type: string; [key: string]: unknown }> {
  if (typeof currentUserInput === 'string') {
    return buildNativeModelHandoffPrompt(summaryText, currentUserInput, mediaPathHints)
  }
  return [
    { type: 'text', text: buildNativeModelHandoffContext(summaryText, mediaPathHints) },
    ...currentUserInput,
  ]
}

export function shouldAttemptHistoricalContextInjection(opts: {
  alreadyInjected?: boolean
  lastInjectedKey?: string | null
  injectionKey?: string | null
  channel?: string
  userTextOrBlocks: unknown
  hasProviderResumeId?: boolean
}): boolean {
  if (opts.channel !== 'webchat') return false
  if (typeof opts.userTextOrBlocks !== 'string' && !Array.isArray(opts.userTextOrBlocks)) return false
  if (opts.injectionKey) return opts.lastInjectedKey !== opts.injectionKey
  return !opts.alreadyInjected && !opts.hasProviderResumeId
}

export function shouldEmitContextRebuilt(opts: {
  historyMode: 'native-resume' | 'stateless-replay'
  reason?: AgentSession['_contextRebuildNotice']
  alreadyNotified?: boolean
}): boolean {
  if (opts.alreadyNotified) return false
  return opts.historyMode === 'native-resume' || opts.reason !== undefined
}

/**
 * Per-turn liveness watchdog 的阈值。`submit()` 内的 setInterval 每 15s 看一次
 * `Date.now() - runner.lastActivityAt`,超过这里的阈值就 reject 让 submit()
 * 走到 idle-timeout 分支 interrupt 子进程。
 *
 * 两档:
 *   - TOOL_MS (15 min) — "子进程活着,backend 在跑长操作,stdout 沉默" 的状态。
 *     当前命中两类:(a) parser.pendingToolCalls > 0 — 工具(MCP/Bash/sub-agent)
 *     执行中;(b) currentTurnStatus === 'compacting' — CCB 在做 auto-compact,
 *     发的是一次 backend-only 总结请求,无 tool call 也无 token 流,first-token
 *     在大 context + Opus 高思考档下完全可能 > 5 min;(c) codex-native —
 *     GPT 5.5/Codex 高推理档在首个 reasoning/tool/text 事件前可能静默数分钟
 *     (尤其长文档/上下文整理),且当前 Codex app-server 没有 CCB 那样的
 *     `status=compacting` side-channel,所以按 TOOL 档保守放行。
 *   - DEFAULT_MS (5 min) — 只保留给没有解析出 engine id 的 legacy 调用。
 *     真实 CCB 静态模型在大 context / 高思考档的一次 API 请求中可能合法静默
 *     超过 5 分钟；科研与编码实跑都复现了 5min 误杀。因此已解析的 CCB 与
 *     Codex 一律走 TOOL_MS，仍由 15min idle watchdog 释放真死锁。
 *
 * 历史:pre-2026-04-19 这两个阈值是 30 / 60 min,过宽导致 deadlock 检测慢。
 * 2026-04-19 收紧到 15 / 5。本次(2026-05-25)发现 compacting 误归到 DEFAULT,
 * 把它合并到 TOOL 档,不新增第三档(同语义不切碎)。
 *
 * 另有 _runOneTurn 内部一个 30 min 硬背书 timer(被任意 stdout chunk 重置),
 * 作为这两档之上的兜底,不在本文件常量范围。等人回答期间不得把它当静默
 * 触发 interrupt/免单,见 `shouldFireTurnIdleTimeout`。
 */
export const IDLE_TIMEOUT_TOOL_MS = 15 * 60_000
export const IDLE_TIMEOUT_DEFAULT_MS = 5 * 60_000
/** One admitted Box detached tool chain may live four hours. Give its owner
 * turn five minutes to observe the keeper's terminal proof before interrupt. */
export const BOX_ACTIVE_TURN_IDLE_MS = 4 * 60 * 60_000 + 5 * 60_000
/** Box ChatGPT Web Pro (box-gpt-6-astra-pro) tasks can run up to 6 hours.
 * Give the owner turn a 6h 15m silent backstop and idle watchdog threshold. */
export const BOX_GPT_WEB_ACTIVE_TURN_IDLE_MS = 6 * 60 * 60_000 + 15 * 60_000

/**
 * Idle TTL of resume-map entries whose in-memory AgentSession was evicted.
 * OCV5-556: a user coming back after more than 7 days lost the native resume
 * and every engine fell back to a lossy history rebuild, although the native
 * conversation files were still in the volume. 90 days matches the volume
 * lifetime (volume GC: 90 days without a login), so the map only drops
 * entries whose files are about to go anyway.
 */
export const RESUME_MAP_INACTIVE_TTL_MS = 90 * 24 * 60 * 60 * 1000
function isBoxActiveTurn(engineId?: string, modelId?: string): boolean {
  return engineId === 'ccb' && isBoxApiModel(modelId)
}
function isBoxGptWebActiveTurn(engineId?: string, modelId?: string): boolean {
  return (
    (engineId === 'cursor' || engineId === 'ccb' || engineId === undefined) &&
    isBoxGptWebCatalogModel(modelId)
  )
}

export function pickTurnSilentBackstopMs(engineId?: string, modelId?: string): number {
  if (isBoxGptWebActiveTurn(engineId, modelId)) return BOX_GPT_WEB_ACTIVE_TURN_IDLE_MS
  return isBoxActiveTurn(engineId, modelId)
    ? BOX_ACTIVE_TURN_IDLE_MS : 30 * 60_000
}

/**
 * 给定 turn 当前的 backend-side 状态 + parser 未完成工具数,返回该 turn 此刻
 * 应该用的 idle watchdog 阈值。
 *
 * 抽成 pure function 是为了让阈值选择策略锁在测试里 —— 防止以后有人无意识地
 * 把 OR 分支"清理"掉退回 5min 单档,从而再次让 compacting 期间被误杀。
 *
 * compacting 与 retrying(自动重试等待期)同属"turn 仍在工作但暂无 token"的
 * 非流式阶段,都取长档阈值,不被 idle watchdog 误杀。
 *
 * Live watchdog 调用点见本文件 `submit()` 内 livenessTimer。
 */
export function pickIdleTimeoutMs(
  currentTurnStatus: GatewayTurnPhase | undefined,
  pendingToolCalls: number,
  /** M1a:providerTag 泛化为 engine id('ccb' | 'codex')。codex 判定从旧
   *  'codex-native'(provider 语义)改为 'codex'(engine 语义),真值表不变。 */
  engineId?: string,
  modelId?: string,
): number {
  if (isBoxGptWebActiveTurn(engineId, modelId)) return BOX_GPT_WEB_ACTIVE_TURN_IDLE_MS
  if (isBoxActiveTurn(engineId, modelId)) return BOX_ACTIVE_TURN_IDLE_MS
  const inNonStreamingPhase =
    currentTurnStatus === 'compacting' ||
    (typeof currentTurnStatus === 'object' && currentTurnStatus !== null)
  if (
    pendingToolCalls > 0 ||
    inNonStreamingPhase ||
    engineId === 'ccb' ||
    engineId === 'codex' ||
    engineId === 'grok' ||
    engineId === 'cursor' ||
    engineId === 'zcode' ||
    engineId === 'antigravity'
  ) {
    return IDLE_TIMEOUT_TOOL_MS
  }
  return IDLE_TIMEOUT_DEFAULT_MS
}

export function shouldTripIdleWatchdog(input: {
  waitingForUserInput: boolean
  idleMs: number
  thresholdMs: number
}): boolean {
  return !input.waitingForUserInput && input.idleMs > input.thresholdMs
}

/**
 * 30min per-turn hard-backstop timer in `_runOneTurn`.
 *
 * Waiting for explicit user input (AskUserQuestion / request_user_input /
 * permission card) is not engine silence. Same authority signal as
 * `shouldTripIdleWatchdog`: `runner.waitingForUserInput === true`.
 * Finalized turns are already past the interrupt/waiver window.
 */
export function shouldFireTurnIdleTimeout(input: {
  waitingForUserInput: boolean
  finalized: boolean
}): boolean {
  return !input.finalized && !input.waitingForUserInput
}

/**
 * Drive one tick of the 30min per-turn timer.
 * Returns true → caller should interrupt + waive.
 * Waiting-for-user re-arms `refresh` and returns false (defer repeatedly).
 * Finalized turns are a no-op.
 */
export function applyTurnIdleTimeoutTick(input: {
  waitingForUserInput: boolean
  finalized: boolean
  refresh: () => void
}): boolean {
  if (
    !shouldFireTurnIdleTimeout({
      waitingForUserInput: input.waitingForUserInput,
      finalized: input.finalized,
    })
  ) {
    if (!input.finalized && input.waitingForUserInput) input.refresh()
    return false
  }
  return true
}

/**
 * LRU 空闲回收的「临时会话」判定。cron / 旧 task / taskboard 巡检走短空闲 TTL
 * (`maxIdleMsCron` = 30min);webchat 走 2h。
 *
 * 判定看的是「距上次活动」而不是会话墙钟时长。`submit()` 把 `lastUsedAt` /
 * `runner.lastActivityAt` 打到 turn 起点,stdout 与 CCB telemetry 持续刷新
 * `lastActivityAt`(见本文件 liveness 注释)。巡检 delegate 活跃期间
 * 只要还在产出就不会被 30min 空闲窗杀掉;真静默会先被 15min turn idle
 * watchdog 收掉,本判定只负责事后把死会话从内存里清掉,避免当成长聊会话
 * 留 2 小时。
 */
export function isTempSessionKey(sessionKey: string): boolean {
  return (
    sessionKey.includes(':cron:') || sessionKey.includes(':task:') || isPatrolSessionKey(sessionKey)
  )
}

export function scheduleSessionOutputAssetCollection(opts: {
  userId: string | undefined
  sessionId: string
  assistantText: string
  sessionKey: string
  traceId?: string
  chatProjectId?: string | null
}): void {
  // OCV5-625: still scan workspace/sessions/<id> when the turn text has no generated/ paths.
  if (!opts.userId) return
  void collectSessionOutputAssets({
    userId: opts.userId,
    sessionId: opts.sessionId,
    assistantText: opts.assistantText || '',
    ...(opts.chatProjectId !== undefined ? { chatProjectId: opts.chatProjectId } : {}),
  }).catch((err) => {
    log.warn(
      'collectSessionOutputAssets failed',
      {
        sessionKey: opts.sessionKey,
        ...(opts.traceId ? { traceId: opts.traceId } : {}),
      },
      err,
    )
  })
}

/** RFC-v5-durable-turn-dispatch §4 — recent-terminal ring 容量。 */
const RECENT_TERMINAL_RING_CAP = 8

/** OCV5-180 B1 — `_pendingAgentGroups` 元素:完成的团队卡 + 冻结的 exact
 * owner turnKey(launch 时定位)。ownerTurnKey 缺省 = 旧调用方语义(随当前
 * turn drain,不参与 seal 判定),仅存量测试路径使用。 */
export interface PendingAgentGroupEntry {
  group: DurableAgentGroup
  ownerTurnKey?: string
}

/**
 * 把一次客户 turn 的终态记入 per-session recent-terminal ring(endClientTurn 调用)。
 * 同 clientMessageId 覆盖旧记录(幂等);超 cap 淘汰最老。
 */
export function recordRecentTerminal(
  session: AgentSession,
  clientMessageId: string,
  outcome: 'completed' | 'interrupted' | 'crashed',
): void {
  if (!clientMessageId) return
  const ring = session._recentTerminalRing ?? (session._recentTerminalRing = [])
  const existing = ring.findIndex((e) => e.clientMessageId === clientMessageId)
  if (existing >= 0) ring.splice(existing, 1)
  ring.push({ clientMessageId, outcome })
  while (ring.length > RECENT_TERMINAL_RING_CAP) ring.shift()
}

/** ring 查询:命中返回 outcome,未命中返回 undefined(= 未知身份,调用方发 unknown)。 */
export function lookupRecentTerminal(
  session: AgentSession,
  clientMessageId: string,
  options: { masterAuthoritative?: boolean } = {},
): 'completed' | 'interrupted' | 'crashed' | undefined {
  // Commercial/V5 finality belongs to master PG. The container ring only
  // knows the engine ended; it cannot prove visible_at committed. Returning
  // unknown makes the host bridge perform the authoritative PG reconcile and
  // prevents a synthetic completed frame from erasing an unpersisted answer.
  if (options.masterAuthoritative) return undefined
  return session._recentTerminalRing?.find((e) => e.clientMessageId === clientMessageId)?.outcome
}

export function takeDurableEventOrdinal(session: AgentSession): number {
  const ordinal = session._nextDurableEventOrdinal ?? 0
  session._nextDurableEventOrdinal = ordinal + 1
  return ordinal
}

/** OCV5-435 — how long a Stop that beat its turn's engine start stays armed. */
export const PRE_START_STOP_TTL_MS = 10 * 60_000
/** OCV5-435 — a Stop that overtook its own message on the way in (Master acks
 * admission before forwarding) stays armed only briefly: the message is ms
 * behind, and a stale Stop must not outlive a retry of the same message. */
export const PRE_ADMISSION_STOP_TTL_MS = 30_000

/** Send attempt named by a browser Stop control id (`control:stop:<cmid>` is
 * attempt 0, `control:stop:<cmid>:attempt:<n>` attempt n); undefined when the
 * id is hashed or names no attempt. */
export function stopControlSendAttempt(controlId: unknown, clientMessageId: string): number | undefined {
  if (typeof controlId !== 'string') return undefined
  const base = `control:stop:${clientMessageId}`
  if (controlId === base) return 0
  const match = controlId.startsWith(`${base}:attempt:`)
    ? /^(\d{1,9})$/.exec(controlId.slice(base.length + ':attempt:'.length))
    : null
  return match ? Number(match[1]) : undefined
}

/** Send attempt named by a browser message idempotency key (`web:<cmid>:<n>`). */
export function messageSendAttempt(idempotencyKey: unknown, clientMessageId: string): number | undefined {
  if (typeof idempotencyKey !== 'string') return undefined
  const prefix = `web:${clientMessageId}:`
  if (!idempotencyKey.startsWith(prefix)) return undefined
  const match = /^(\d{1,9})$/.exec(idempotencyKey.slice(prefix.length))
  return match ? Number(match[1]) : undefined
}

/** Exact browser-turn identity for a pre-start Stop (peer id sanitized like sessionKey). */
export function preStartStopKey(peerId: string, clientMessageId: string): string {
  return `${peerId.replace(/[^a-zA-Z0-9_-]/g, '_')}\u0000${clientMessageId}`
}

export {
  TRANSIENT_SAME_CLASS_BREAKER,
  advanceTransientBreaker,
  formatTransientCircuitOpenError,
  resolveTransientBreakerThreshold,
} from './transientRetryCircuit.js'

/** E12 — 瞬时错误自动重试的续跑输入。裸「继续」会让模型丢失重试语境(可能被
 *  理解成用户新指令);这里显式附带原始意图:上一轮因上游瞬时错误被打断,应
 *  继续完成同一任务。导出供引擎回放测试引用同一权威串。 */
export const TRANSIENT_RETRY_INPUT = '上一条消息因上游瞬时错误中断，请继续完成该任务。'

/**
 * CCB/Codex 轮内瞬时重试走 TRANSIENT_RETRY_INPUT,接同一 native session,
 * 不是重放原用户口令。已完成的 Bash/MCP 因此不会再跑一遍。
 *
 * checkpointSafe 仍只给 Read/Glob/Grep 盖章;本谓词补上「会话还在 + 工具已
 * 完成 + 无挂起权限」的续跑。没有 native session 时拒绝,避免变成重放。
 */
export function isNativeEngineTransientContinuationSafe(input: {
  providerTag: string | undefined
  nativeSessionId: string | null | undefined
  ccbSessionId: string | null | undefined
  permissionCount: number
  tools: readonly { completed?: boolean }[]
}): boolean {
  if (input.providerTag !== 'ccb' && input.providerTag !== 'codex') return false
  if (!input.nativeSessionId && !input.ccbSessionId) return false
  if (input.permissionCount !== 0) return false
  return input.tools.every((tool) => tool.completed !== false)
}

// Re-export from ccbMessageParser so existing imports keep working
export type { SessionStreamEvent } from './ccbMessageParser.js'

/** `turn_status` working detail meaning "the model is thinking" (empty or
 *  visible thinking). web-react `MODEL_THINKING_WORKING_DETAIL` mirrors it. */
export const MODEL_THINKING_WORKING_DETAIL = 'thinking'
/** Keepalive period while a thinking block is open; well under the browser's
 *  12s "generating" and 30s silence-warning thresholds. */
export const MODEL_THINKING_KEEPALIVE_MS = 10_000

/** preheatRunner 的结构化结果(engine_preheat 观测:区分未触发/排队/失败/已热)。 */
export type PreheatOutcome =
  | 'started'
  | 'already_running'
  | 'failed'
  | 'skipped_engine'
  | 'skipped_teardown'
  | 'skipped_busy'
  | 'skipped_cap'

/** CCB 冷启约 20s、codex app-server 5–8s、MCP tsx 回落约 7s。45s ≈ 两倍 CCB 冷启 + MCP 余量。 */
export const ENGINE_PREHEAT_DEADLINE_DEFAULT_MS = 45_000

export function resolveEnginePreheatDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OC_ENGINE_PREHEAT_DEADLINE_MS)
  if (Number.isFinite(raw) && raw >= 20) return Math.floor(raw)
  return ENGINE_PREHEAT_DEADLINE_DEFAULT_MS
}

export interface CronBridgeEvent {
  action: 'create' | 'delete' | 'list'
  agentId: string
  // CronCreate params
  cron?: string
  prompt?: string
  recurring?: boolean
  durable?: boolean
  // CronDelete params
  id?: string
}

/** post-terminal / server-authored turn 持久化四态:
 *  - 'acked'   = master 已确认落库(主 turn final 唯一认可的成功)。
 *  - 'queued'  = 已 durable 暂存到重试队列(stageDurable 已 fsync 在网络请求之前,
 *                master 暂不可达),重试循环保证送达 —— 对 tail 折叠**等同成功**:
 *                可更新 hash/**计入预算**、可转发(帧已可靠落盘,不因 master 抖动重复 stage)。
 *  - 'dropped' = 永久丢弃(410 会话已删 / 4xx 契约冲突 / stage 都失败)—— 不算成功,
 *                fold 不更新 hash、不转发、不进 durable 收集器。
 *  - 'skipped' = **未持久化但非失败**(legacy 本地路径:无 userId / 空 text /
 *                runtimeEvents-only 不落本地 SQLite)。改前该分支返回 undefined→布尔 true;
 *                四态下 fold 对 skipped **转发 + 更新 hash(保去重)但不计预算**(没写东西
 *                不占 cap),与"没落盘不消耗预算"语义一致。仅 legacy 分支产生。 */
export type TapePersistResult = 'acked' | 'queued' | 'dropped' | 'skipped'

/** OCV5-180 B1 — shared exact-owner logical-run record. `inflight` is not
 * durable: a dropped (non-queued) persist must delete it so the same frozen
 * payload can retry. `queued`/`acked` are durable; `session_deleted` is
 * terminal and must not resurrect. */
export type ExactOwnerRunState = 'buffered' | 'inflight' | 'queued' | 'acked' | 'session_deleted'

interface ExactOwnerRunRecord {
  identity: string
  state: ExactOwnerRunState
}

export function activeGoalAttribution(session: AgentSession):
  | {
      goalId: string
      goalStateRevision: number
    }
  | undefined {
  const goal = session._platformGoal
  return goal?.status === 'active'
    ? { goalId: goal.goalId, goalStateRevision: goal.stateRevision }
    : undefined
}

/** A1 — 单条待折叠/持久化的 post-terminal bash_output_tail。归属值(ownerTurnKey/
 *  ownerSessionId/turnIndex/onEvent)由发起 turn 的闭包捕获传入;因 tool_use_id 是
 *  流键的一部分、且一个 tool_use_id 只归一个 turn,同一 stream key 的这些值恒定。 */
export interface TailFoldItem {
  event: DurableRuntimeEvent
  block: OutboundContentBlock
  hash: string
  ownerTurnKey: string
  ownerSessionId: string
  turnIndex: number
  toolUseId: string
  parentToolUseId: string
  onEvent: (e: SessionStreamEvent) => void
}

/** A1 — 单个 tail 流(键 = ownerTurnKey + parentToolUseId + toolUseId)的折叠状态。 */
export interface TailFoldStreamState {
  /** 上次**持久化成功(acked|queued)**的内容 hash(dropped 不更新 → 下次重试);
   *  null = 尚未成功持久化。 */
  lastPersistedHash: string | null
  /** 上次持久化**尝试**时刻(限频锚点;0 = 从未尝试)。 */
  lastPersistAt: number
  /** 本流已成功持久化的真实 tail 条数(per-stream cap 判定)。 */
  persistedCount: number
  /** trailing-edge 合并槽:限频窗口内只保留最新一条。 */
  pending: TailFoldItem | null
  timer: ReturnType<typeof setTimeout> | null
  /** per-stream cap marker 已成功落库(acked|queued)后置位:该流彻底停(不落不转)。
   *  dropped 时保持 false → 下次事件用**同一冻结 marker**重试。 */
  capped: boolean
  /** F1b — per-stream capped marker 事件,**首次构造后冻结**(ordinal/observedAt 不再
   *  重造),保证重试时 identity 稳定、master UPSERT 去重,绝不产生多条 marker。 */
  markerEvent: DurableRuntimeEvent | null
}

export interface TailPersistQueueItem {
  st: TailFoldStreamState
  item: TailFoldItem
}

/** F2/F6 — 单个 ownerTurnKey 的跨会话 tail 预算(SessionManager 级,有界 LRU)。多个
 *  delegate 子会话共享同一 parent ownerTurnKey 时**共用**本预算(不再各领 64)。 */
interface TailOwnerBudget {
  /** 本 owner 跨所有流已成功持久化的真实 tail 总数(owner cap 判定)。 */
  persistedCount: number
  /** owner cap marker 已成功落库后置位:该 owner 所有流彻底停(不落不转)。 */
  capped: boolean
  /** F1b/F2 — owner capped marker 事件,首次构造后冻结(同上,identity 稳定去重)。 */
  markerEvent: DurableRuntimeEvent | null
  /**
   * F6 — owner 级串行链(**跨 session** 预算临界区)。cap 判定 / 真实 tail 落定 /
   * marker 落定都在本链任务内执行,消灭"两个共享 ownerTurnKey 的 session 各经自己
   * 的 per-session 链、同时读 persistedCount 过 cap → 超发"的竞态。
   * 死锁面:owner 链任务内**绝不 await session 链**(嵌套方向恒为 session→owner)。
   */
  chain: Promise<void>
}

/** Close a PG-active queue turn after a gateway/container restart without ever
 * re-running it. The exact turnKey makes the tape and waiver idempotent across
 * repeated recovery attempts; queued means the lossless drainer owns delivery. */
export async function persistInterruptedPromptQueueTurn(args: {
  sessionKey: string
  peerId: string
  agentId: string
  userId: string
  turnIndex: number
  turnKey: string
  clientMessageId: string
}): Promise<void> {
  const outcome = await persistServerAuthoredTurnOutcome({
    sessionKey: args.sessionKey,
    peerId: args.peerId,
    agentId: args.agentId,
    userId: args.userId,
    turnIndex: args.turnIndex,
    turnKey: args.turnKey,
    clientMessageId: args.clientMessageId,
    text: '运行环境重启，本轮已安全中断并自动免单，请重新发送。',
    status: 'interrupted',
    errorCode: 'SERVICE_RESTART',
    errorDetail: 'prompt queue active turn recovered after gateway restart',
    waiveReason: 'no_response',
  })
  if (outcome === 'dropped' || outcome === 'skipped') {
    throw new Error(`prompt queue restart tape was not retained (${outcome})`)
  }
}

/** A short-lived host-controlled drain rejected a new runtime turn. */
export class RuntimeRecycleDrainingError extends Error {
  readonly code = 'RUNTIME_RECYCLE_DRAINING'
  constructor() {
    super('runtime is draining for a stale-image recycle')
    this.name = 'RuntimeRecycleDrainingError'
  }
}

export interface PromptQueueExecutionFence {
  readonly sessionKey: string
  readonly token: symbol
  release(): void
}


const USER_GOAL_OBJECTIVE_MAX = 4000

/** Browser goal-bar mutation. Usage counters stay on the previous snapshot. */
export function nextUserGoal(
  current: GoalStateSnapshot | null,
  sessionId: string,
  action: 'set' | 'pause' | 'resume' | 'clear',
  objective: string | undefined,
): GoalStateSnapshot | 'noop' | 'rejected' {
  const clean = typeof objective === 'string' ? objective.trim() : ''
  if (clean.length > USER_GOAL_OBJECTIVE_MAX) return 'rejected'
  const now = new Date().toISOString()
  const text = action === 'set' ? clean : current?.objective || clean
  if (action !== 'clear' && !text) return 'rejected'
  if (action === 'clear' && current?.status === 'cleared') return 'noop'
  if (action === 'pause' && current?.status === 'paused') return 'noop'
  if (action === 'resume' && current?.status === 'active' && current.objective === text) return 'noop'
  if (action === 'set' && current?.status === 'active' && current.objective === text) return 'noop'
  const status = action === 'clear' ? 'cleared' : action === 'pause' ? 'paused' : 'active'
  return {
    sessionId,
    goalId: current?.goalId ?? randomUUID(),
    objective: text || current?.objective || ' ',
    status,
    tokenBudget: current?.tokenBudget ?? null,
    creditBudget: current?.creditBudget ?? null,
    tokensUsed: current?.tokensUsed ?? 0,
    creditsUsed: current?.creditsUsed ?? '0',
    timeUsedSeconds: current?.timeUsedSeconds ?? 0,
    stateRevision: (current?.stateRevision ?? 0) + 1,
    snapshotRevision: (current?.snapshotRevision ?? 0) + 1,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
    statusChangedAt: current?.status === status ? current.statusChangedAt : now,
  }
}

export class SessionManager {
  private sessions = new Map<string, AgentSession>()
  /** OCV5-180 B1 — `${ownerTurnKey}\0${runId}` → exact-owner logical-run
   *  状态(buffer / drain-seal / late 共用)。同内容唯一、异内容冲突可见;
   *  inflight 不是 durable。有界 LRU 只淘汰已完成(acked/queued/session_deleted);
   *  buffered/inflight 以活 owner bucket / 冻结 payload 为权威,不可 FIFO 丢弃。 */
  private _exactOwnerRuns = new Map<string, ExactOwnerRunRecord>()
  /** Per-sessionKey mutex around getOrCreate so two concurrent turns cannot
   *  each replace the runner and --resume the same Cursor SQLite store. */
  private _sessionCreateGates = new Map<string, Promise<void>>()
  /** Queue execution uses the existing promise only as an execution mutex.
   * The WeakSet is the synchronous admission fence that rejects, rather than
   * queues, any second submit while that mutex is owned. */
  private _promptQueueExecutions = new WeakSet<AgentSession>()
  /** Engine switches replace AgentSession objects, so the invariant also needs
   * a stable logical-session fence that survives object replacement attempts. */
  private _promptQueueExecutionKeys = new Set<string>()
  /** OCV5-435 — Stops for an accepted browser turn whose engine run did not
   * exist yet (preStartStopKey → expiry). Consumed when that run is created. */
  private _preStartStops = new Map<string, { expiresAt: number; sendAttempt?: number }>()
  /** Accepted grants need a fence before getOrCreate() and attachment
   * preprocessing. The token lets that one queue dispatch adopt/replace its
   * own session while every legacy or second dispatch fails closed. */
  private _promptQueueDispatchFences = new Map<string, symbol>()
  /** Shared gate for every submit path during a host-controlled image recycle. */
  private _runtimeRecycleDrainUntil = 0
  private _runtimeRecycleDrainTimer: ReturnType<typeof setTimeout> | null = null
  private maxIdleMsCron = 30 * 60 * 1000 // 30 min for cron/task sessions
  private maxIdleMsChat = 2 * 60 * 60 * 1000 // 2 hours for webchat sessions (resume-map persists for reconnect)
  // A1 post-terminal tail 折叠参数(默认值即生产值;private 供单测按小值/短窗覆盖,
  // 不下沉到 env 面以免扩散配置权威)。
  private _tailFoldMinIntervalMs = 5000
  private _tailFoldStreamCap = 24
  private _tailFoldOwnerCap = 64
  // A2:同一 owner 的 backlog 用一个 continuation tape 批量落库。
  // 32 条 / 512KiB 与 lossless runtime batching 的稳健量级一致,
  // 避免一个慢 ACK 把 64 条 tail 串成数十分钟收尾。
  private _tailPersistBatchMaxEvents = 32
  private _tailPersistBatchMaxBytes = 512 * 1024
  /** Cooperative Stop grace before the gateway escalates to runner shutdown.
   * Private test seam; the production boundary remains five seconds. */
  private _terminalRequestGraceMs = 5_000
  /** Outer deadline on the post-shutdown stdout-close barrier. The barrier
   * keeps late paid bytes inside the turn, but a descendant that escaped the
   * supervisor's process group can hold the pipe open forever; without a
   * deadline the turn never reaches a terminal state and the client sits in
   * "stopping" indefinitely. Private test seam. */
  private _terminalOutputDrainTimeoutMs = 15_000
  /**
   * F2 — owner 级 tail 预算,按 ownerTurnKey 键控,**SessionManager 级**(跨会话共享:
   * 多个 delegate 子会话共用同一 parent ownerTurnKey 时同领一份 64 额度,而非各领 64)。
   * 有界 LRU(上限 512):超限逐出最旧条 —— 取舍是被逐出的 owner 预算重置(极端下
   * 512+ 并发 owner 时,老 owner 可能重新获得额度),换来无界增长的硬防护。owner cap
   * 触发 = 整 owner 只落一条 marker、其后该 owner 所有流全停;marker 不计入预算,故
   * 每 owner 硬上限 = 64 条真实 tail + 至多 ⌊64/streamCap⌋ 条 per-stream marker + 1 条
   * owner marker。
   */
  private _tailOwnerBudgets = new Map<string, TailOwnerBudget>()
  private static readonly TAIL_OWNER_BUDGET_MAX = 512
  /**
   * B5 — post-terminal 事件归属缺失(缺 ownerTurnKey/ownerSessionId)的观测计数(单一
   * SessionManager 级,非 per-session:归属失败与具体会话无关,是路由/委派链的健康信号)。
   * `tailDropped` = 无法归属的 tail 被 fail-closed 丢弃的次数(对齐 ccbAdapter 的
   * dropped-tail 惯例);`nonTailForwarded` = 无法归属的非 tail 事件仍兜底转发的次数
   * (非 tail 无 cap/去重保护,丢弃会真丢内容,故只观测不拦)。测试经此断言告警活体。
   */
  private _missingOwnerMetrics = { tailDropped: 0, nonTailForwarded: 0 }
  /** B5 — 归属缺失告警的限频锚点(每 30s 至多一次,对齐 ccbAdapter._warnDroppedTail,防洪泛)。*/
  private _lastMissingOwnerWarnAt = 0
  /** @deprecated Use eventBus 'task.created'/'task.deleted' instead. Kept for backward compat. */
  public onCronBridge?: (event: CronBridgeEvent) => Promise<void>
  /** Called when a 401 auth error is detected — gateway should trigger immediate token refresh */
  public onAuthError?: () => Promise<void>
  /**
   * 2026-04-21 安全审计 Medium#G1:被拆的 session 在 sessionManager 层把 subprocess
   * 杀掉就结束,但 server.ts 里的 `_outboundRing` 按 sessionKey 各维护一圈 frame
   * buffer,sessionManager 本身没这个引用。结果:LRU 驱逐/shutdownAll/
   * destroySession 内部路径 里 outboundRing 条目永远不被清,cron/task 风格的
   * 唯一 sessionKey 会随时间慢慢泄漏成常驻 frame 堆 —— 实测 5 周跑满 ~80 MB RSS。
   *
   * 修法:把 outboundRing.clear 通过这个 callback 回调给 server.ts,让 server 层
   * 的唯一 owner 统一负责清理。server.ts 在 OpenClaudeServer 构造函数里就绑定 callback
   * (见 server.ts:247 附近),确保第一次 destroySession 触发前 callback 已就位。
   *
   * 为何不把 OutboundRing 直接挪到 sessionManager:ring 的消费方(replay / store)
   * 都在 server.ts 的 WS handler 内,移动代价比暴露一个清理 hook 大得多。
   */
  public onSessionDestroyed?: (sessionKey: string) => void
  /** CCB local-agent bookend with no live turn (or as a second path while
   * a turn's onEvent is also live). server.ts plans origin-inject here. */
  public onCcbTaskNotification?: (
    session: AgentSession,
    payload: {
      taskId: string
      status: string
      outputFile: string
      summary: string
      toolUseId?: string
    },
  ) => void
  public onCcbTaskNotificationDelivered?: (
    session: AgentSession,
    payload: { taskId: string; deliveredBy: 'ccb-mid-turn' },
  ) => void

  // ── Phase 5: GitHub session repo wiring ──
  /**
   * SessionRepoWorkspaceManager.getRepoSnapshot 的 provider(由 server.ts
   * setRepoSnapshotProvider 注入)。SubprocessRunner.start() 用此读当前 repo
   * 状态决定 effective addDir + _boundRepoBinding。
   * 未注入时保持 undefined,传给 SubprocessRunner 后等同"未绑定"。
   */
  private _getRepoSnapshot: ((sessionId: string) => RepoSnapshot | null) | undefined

  /**
   * peer (= sessionId) → sessionKey 反查索引。recycle 入口拿 sessionKey 用,
   * 从而调 session.lock 串行化 shutdown。getOrCreate 时 set,clean/close 时 delete。
   * 同 sessionKey 唯一 — 协议约定 peerId === sessionId,sessionKey 包含 peerId,
   * 所以一对一,Map<sessionId, sessionKey>。
   */
  private _sessionIdToKey = new Map<string, string>()

  /**
   * 由 server.ts 在 Gateway 构造器里调,把 _repoWorkspace.getRepoSnapshot 注入。
   * 必须在第一个 SubprocessRunner 创建之前调,否则首批 runner 会拿不到 snapshot。
   */
  setRepoSnapshotProvider(fn: (sessionId: string) => RepoSnapshot | null): void {
    this._getRepoSnapshot = fn
  }

  /** Browser goal bar: pause, resume, replace, or clear the session goal.
   * Objective text is accepted only for set, or when this session has no
   * platform snapshot yet. Usage counters and budgets stay server-owned. */
  async applyUserGoalAction(
    sessionKey: string,
    action: 'set' | 'pause' | 'resume' | 'clear',
    objective: string | undefined,
  ): Promise<'applied' | 'noop' | 'rejected'> {
    const session = this.sessions.get(sessionKey)
    if (!session) return 'rejected'
    const prev = session.lock
    let release!: () => void
    session.lock = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await prev
      const next = nextUserGoal(session._platformGoal ?? null, session.peerId, action, objective)
      if (next === 'rejected') return 'rejected'
      if (next === 'noop') return 'noop'
      session._platformGoal = next
      await session.runner.setGoalState(next)
      return 'applied'
    } finally {
      release()
    }
  }

  /** Apply a master-authored goal update at the next session lock boundary.
   * Busy turns finish with their captured revision; no queue or interruption
   * behavior is changed. */
  async syncGoalState(sessionId: string, goal: GoalStateSnapshot): Promise<void> {
    const sessionKey = this._sessionIdToKey.get(sessionId)
    if (!sessionKey) return
    const session = this.sessions.get(sessionKey)
    if (!session) return
    const prev = session.lock
    let release!: () => void
    session.lock = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await prev
      session._platformGoal = structuredClone(goal)
      await session.runner.setGoalState(goal)
    } finally {
      release()
    }
  }

  /**
   * Phase 5:repo selection 版本变化时 recycle 该 session 的 runner。
   * 决策表(配合 SubprocessRunner.getBoundRepoBinding):
   *   binding=null & snap=ready              → SHUTDOWN(让下次 spawn 拿 repo cwd)
   *   binding=null & snap=cloning|failed     → NOOP(addDir 始终 agentBaseDir)
   *   binding=v_x & snap=ready & x===snap.v  → NOOP
   *   binding=v_x & snap=ready & x!==snap.v  → SHUTDOWN
   *   binding=v_x & snap=cloning|failed      → NOOP(让 CCB 继续在旧 v_x dir 工作)
   *
   * lock 内进行,与 submit() 互斥。runner.shutdown 后下次 submit 自动 spawn,
   * 拿当时的 repo snapshot(getRepoSnapshot provider 取自 _repoWorkspace.states)。
   */
  recyclePeerForRepoChange(sessionId: string, newSnapshot: RepoSnapshot | null): Promise<void> {
    return recyclePeerForRepoChangeImpl.call(this as unknown as SessionLifecycleHost, sessionId, newSnapshot)
  }

  /**
   * Phase 5:repo unbind(用户 DELETE selection / link revoke)时 recycle 该 session。
   * 调用前 caller(server.ts _handleSessionRepoUnbind)必须先 _repoWorkspace.unbind
   * (短锁内删 states[sessionId]),保证排队 submit 启动时 getRepoSnapshot 返 null。
   * 总是无条件 shutdown(若 isRunning):因为 unbind 后 addDir 必须切回 agentBaseDir。
   */
  recyclePeerForRepoUnbind(sessionId: string): Promise<void> {
    return recyclePeerForRepoUnbindImpl.call(this as unknown as SessionLifecycleHost, sessionId)
  }

  private readonly resumeStore = new ResumeStore(join(paths.home, 'resume-map.json'))
  private get resumeMapPath(): string {
    return this.resumeStore.path
  }
  private set resumeMapPath(path: string) {
    this.resumeStore.path = path
  }

  constructor(public config: OpenClaudeConfig) {
    this._loadResumeMap()
  }

  isRuntimeRecycleDraining(now = Date.now()): boolean {
    if (this._runtimeRecycleDrainUntil <= now) {
      this.releaseRuntimeRecycleDrain()
      return false
    }
    return true
  }

  private markPlannedServiceRestart(session: AgentSession): void {
    session._plannedTeardown = 'service_restart'
  }

  /** Deploy/container recycle/SIGTERM → SERVICE_RESTART. Real crash stays RUNNER_CRASHED.
   *
   * `crashed === false` is the runner's own verdict that *we* asked for this
   * exit (`SubprocessRunner.shutdown()` set `shuttingDown` before the process
   * died — credential switch, effort/model swap, session replacement, goal
   * change, preheat deadline …). Even when the grace window expired and the
   * process had to be SIGKILLed, that is a platform recycle, not a crash.
   * Reporting it as RUNNER_CRASHED made master's automatic recovery respawn
   * the runner, hit the same recycle within ~1s, and loop until the 10-retry
   * budget was exhausted (INC 2026-09-04 webmtmoostmzw8pdg). */
  private shouldClassifyExitAsServiceRestart(
    session: AgentSession,
    info?: { signal: string | null; crashed?: boolean },
  ): boolean {
    if (session._plannedTeardown === 'service_restart') return true
    if (this.isRuntimeRecycleDraining()) return true
    if (info?.crashed === false) return true
    return info?.signal === 'SIGTERM'
  }

  /**
   * Arm the common submit gate, then synchronously inspect accepted turns.
   * A later submit sees the gate; an earlier submit has already incremented
   * `_activeTurnCount` before its first await.
   */
  armRuntimeRecycleDrain(ttlMs: number): { accepted: boolean; activeTurns: number } {
    return armRuntimeRecycleDrainImpl.call(this as unknown as SessionLifecycleHost, ttlMs)
  }

  releaseRuntimeRecycleDrain(): void {
    this._runtimeRecycleDrainUntil = 0
    if (this._runtimeRecycleDrainTimer) {
      clearTimeout(this._runtimeRecycleDrainTimer)
      this._runtimeRecycleDrainTimer = null
    }
  }

  /** Update config reference (e.g. after OAuth token refresh) and propagate to all runners */
  updateConfig(config: OpenClaudeConfig): void {
    this.config = config
    for (const session of this.sessions.values()) {
      session.runner.updateConfig(config)
    }
  }

  /**
   * 注入远程目标控制器。commercial 侧在启动装配时调用;personal / 测试环境不调,
   * setExecutionTarget('remote') 会抛 RemoteTargetUnavailableError。
   *
   * 故意不是构造器参数 —— SessionManager 在 gateway 包里,controller 实现
   * 在 commercial 包,反向依赖禁止(Codex R11 BLOCK-1)。
   */
  private _remoteTargetController?: RemoteTargetController
  setRemoteTargetController(ctrl: RemoteTargetController | undefined): void {
    this._remoteTargetController = ctrl
  }

  // ── Server-authored turn persistence tracking ──────────────────────────
  // Each `persistServerAuthoredTurn(...)` call returns a Promise<boolean> that
  // settles once the durable enqueue (sink → retry queue file write) lands
  // on disk. We add the promise to this set on dispatch and remove on
  // settle. Shutdown drains the set before clearing the v3 sink singleton
  // so a process exit cannot lose the turn between "callback fired" and
  // "file written" (Codex R2 BLOCK-1).
  //
  // The set is Promise-keyed not entry-keyed: turn-end + crash-flush can
  // both fire for the same (sessionKey, turnIndex), and idempotency lives
  // in the master's UPSERT keyed by msgId — we don't dedup on the client.
  private _pendingPersistence = new Set<Promise<unknown>>()

  private _trackPersistence(p: Promise<unknown>): void {
    _trackPersistenceImpl.call(this as unknown as SessionTailHost, p)
  }

  /** Wait for every in-flight server-authored turn persistence promise
   *  registered via `_trackPersistence` to settle. Always resolves;
   *  individual rejections are absorbed (the helper itself never rejects,
   *  but Promise.allSettled is the belt-and-braces version). Called from
   *  `shutdownAll` after subprocess kill so handleExit's setTimeout-150ms
   *  flush gets to land before the sink singleton is cleared. */
  async awaitPendingPersistence(): Promise<void> {
    if (this._pendingPersistence.size === 0) return
    await Promise.allSettled([...this._pendingPersistence])
  }

  /** A1 — 把一次 tail 持久化(或 capped marker)追加到 **per-session** 串行链,并
   *  纳入 pending-persistence 跟踪。折叠/非折叠 post-terminal 事件都经此串行化,
   *  故定时器 flush 与事件回调不会并发双写。 */
  private _chainTailPersist(session: AgentSession, task: () => Promise<void>): void {
    _chainTailPersistImpl.call(this as unknown as SessionTailHost, session, task)
  }

  /** F2 — 取/建 ownerTurnKey 的跨会话预算(LRU:命中刷新位置,超限逐出最旧一条)。
   *  逐出 = 预算重置(被逐 owner 重新获得额度)。为何**不**改成 fail-closed 拒绝新 owner:
   *  ownerTurnKey 是 turn 作用域,512 个并发 post-terminal 活跃 turn 非现实场景;拒绝新
   *  owner 会伤 UX(合法 bg bash tail 被无端丢)。逐出时 warn 一次以便观测异常规模。 */
  private _getOwnerBudget(ownerTurnKey: string): TailOwnerBudget {
    const map = this._tailOwnerBudgets
    const existing = map.get(ownerTurnKey)
    if (existing) {
      map.delete(ownerTurnKey)
      map.set(ownerTurnKey, existing)
      return existing
    }
    const budget: TailOwnerBudget = {
      persistedCount: 0,
      capped: false,
      markerEvent: null,
      chain: Promise.resolve(),
    }
    map.set(ownerTurnKey, budget)
    while (map.size > SessionManager.TAIL_OWNER_BUDGET_MAX) {
      const oldest = map.keys().next().value as string | undefined
      if (oldest === undefined) break
      map.delete(oldest)
      log.warn('post-terminal tail owner budget evicted (budget reset)', {
        evictedOwnerTurnKey: oldest,
        budgetCap: SessionManager.TAIL_OWNER_BUDGET_MAX,
      })
    }
    return budget
  }

  /** F6 — 在 owner 级串行链上跑一个任务(跨 session 预算临界区串行化)。返回本任务
   *  完成时 resolve 的 promise,供 session 链任务 `await`(方向恒为 session→owner,
   *  owner 任务内绝不 await session 链 → 无环、无死锁)。 */
  private _runOnOwnerChain(ownerTurnKey: string, task: () => Promise<void>): Promise<void> {
    return _runOnOwnerChainImpl.call(this as unknown as SessionAgentGroupsHost, ownerTurnKey, task)
  }

  /** F1b — 冻结的 capped marker 事件(ordinal/observedAt/payload 首次构造后不再变),
   *  保证 dropped 重试时 identity 稳定、master UPSERT 去重,绝不产生多条 marker。 */
  private _buildTailCapMarker(item: TailFoldItem, reason: 'cap' | 'owner_cap'): DurableRuntimeEvent {
    return _buildTailCapMarkerImpl.call(this as unknown as SessionTailHost, item, reason)
  }

  /** A1/A2/F1/F1b/F2/F4/F6/F7 — tail 先进 per-session 队列。首条开工后
   *  新到 backlog 由同一 worker 按 owner 成批持久化;无 backlog 时仍是单条低延迟。 */
  private _enqueueTailPersist(
    session: AgentSession,
    st: TailFoldStreamState,
    item: TailFoldItem,
  ): void {
    st.lastPersistAt = Date.now()
    ;(session._postTerminalTailQueue ??= []).push({ st, item })
    this._scheduleTailPersistWorker(session)
  }

  private _scheduleTailPersistWorker(session: AgentSession): void {
    _scheduleTailPersistWorkerImpl.call(this as unknown as SessionTailHost, session)
  }

  private _drainTailPersistQueue(session: AgentSession): Promise<void> {
    return _drainTailPersistQueueImpl.call(this as unknown as SessionTailHost, session)
  }

  private _persistTailBatch(session: AgentSession, batch: TailPersistQueueItem[]): Promise<void> {
    return _persistTailBatchImpl.call(this as unknown as SessionTailHost, session, batch)
  }

  /** A1 — bash_output_tail 折叠入口(在发起 turn 的 onPostTerminalRuntimeEvent 内
   *  为每条 tail 调用)。去重(内容不变直接丢弃)→ 限频(<5s trailing-edge 合并,
   *  只保留最新一条,定时器到点 flush)→ 否则立即 enqueue 持久化。 */
  private _foldPostTerminalTail(session: AgentSession, item: TailFoldItem, streamKey: string): void {
    _foldPostTerminalTailImpl.call(this as unknown as SessionTailHost, session, item, streamKey)
  }

  /** B5 — 归属缺失计数 + 限频 warn(30s)。丢弃/兜底转发两类共用一个限频锚点,
   *  日志带累计计数便于观测该缺陷是个例还是持续。 */
  private _warnMissingPostTerminalOwner(kind: 'tail_dropped' | 'non_tail_forwarded'): void {
    _warnMissingPostTerminalOwnerImpl.call(this as unknown as SessionTailHost, kind)
  }

  /**
   * B5/B6 — post-terminal runtime 事件分发的**单一权威**(从 runEngineTurn 的
   * onPostTerminalRuntimeEvent 闭包抽出,给归属 fail-closure 与非 tail dropped 门控一个
   * 可直接单测的接缝)。三条不变量:
   *   - **归属缺失(B5)**:缺 ownerTurnKey/ownerSessionId 时,tail 类 **fail-closed 丢弃**
   *     (对齐 ccbAdapter._routeMessage:归属不明的 tail 绝不裸转发 —— 那正是 owner
   *     attribution bug 成因;tail 有 cap/去重/归档兜底,丢一帧无损);非 tail 类因无
   *     cap/去重保护且丢弃即真丢内容,**保持兜底转发**,但两类都记计数 + 限频 warn。
   *   - **非 tail dropped 门控(B6)**:非 tail 事件先持久化后转发,persist 结果 `dropped`
   *     时**不转发**(与 tail 路径 _enqueueTailPersist 的 dropped→不更新/不转发对称),
   *     绝不把未落盘的 post-terminal 快照抢先展示;durable 收集器 push 同步收敛到
   *     acked|queued(dropped/skipped 不进,消除"未落盘事件仍被当耐久重放"的类一致性缺陷)。
   *   - **tail 折叠**:归属齐备的 tail 交 _foldPostTerminalTail(去重/限频/cap)。
   */
  private _dispatchPostTerminalRuntimeEvent(session: AgentSession, event: DurableRuntimeEvent, block: OutboundContentBlock, ctx: {
      ownerTurnKey: string | undefined | null
      ownerSessionId: string | undefined | null
      turnIndex: number
      onEvent: (e: SessionStreamEvent) => void
    }): void {
    _dispatchPostTerminalRuntimeEventImpl.call(this as unknown as SessionTailHost, session, event, block, ctx)
  }

  /**
   * A1/F7 — 排空 tail 折叠:flush 各流 pending(**只绕过 5s 限频窗口,仍受 stream/owner
   * cap 约束** —— pending 走既有 cap 判定,cap 已满则落 marker 或丢弃,owner.capped 后
   * 不写任何东西),await 串行链排空。
   *
   * `destroy`(仅 runner 已停的三处销毁路径:destroySession / LRU 驱逐 / shutdownAll)
   * 时额外汇总 log + 清 stream 状态/metrics/session 链 —— **破坏性**。
   * `destroy=false`(F4:handleDelegateTask 摘取点,runner 仍活)为**非破坏 snapshot
   * drain**:只 flush + await,不清态,后续 tail 仍受既有去重/cap 状态约束。
   */
  private _drainTailFolding(session: AgentSession, opts: { destroy: boolean }): Promise<void> {
    return _drainTailFoldingImpl.call(this as unknown as SessionTailHost, session, opts)
  }

  /** A1 — session 销毁收尾(destroySession / LRU 驱逐 / shutdownAll 三处,runner 已停)。 */
  private async _flushTailFolding(session: AgentSession): Promise<void> {
    await this._drainTailFolding(session, { destroy: true })
  }

  /** F4/F7② — 供 handleDelegateTask 摘取 delegate 收集器(_durableDelegateRuntimeEvents →
   *  DurableAgentGroup)前调用。**此时 runner 仍活**,故走**非破坏** drain:flush pending +
   *  await 折叠链排空(使 acked|queued 的 tail 入收集器),但**不清 stream 状态/metrics**,
   *  后续 tail 仍受既有去重/cap 约束。若用破坏性清态,drain 后新 tail 会重置去重/cap 面。 */
  async flushSessionTailFolding(session: AgentSession): Promise<void> {
    await this._drainTailFolding(session, { destroy: false })
  }

  /** Record a platform-executed turn (for example a trusted Image 2 edit)
   * without asking the language-model runner to execute it. The turn shares
   * the same lock/counter/persistence contract as model turns, then clears
   * the native resume id so the next submit rebuilds from master history and
   * sees this external exchange. */
  recordExternalTurn(session: AgentSession, args: {
      userText: string
      assistantText: string
      requestId: string
      traceId?: string
      model?: string
      /** Chat project this external turn resolved at its start (not via submit, so passed here). */
      chatProjectId?: string | null
    }, reservation?: PromptQueueExternalTurnReservation): Promise<{ turnIndex: number; messageId: string }> {
    return recordExternalTurnImpl.call(this as unknown as SessionSubmitHost, session, args, reservation)
  }

  /** Reserve and activate a prompt-queue external turn before its paid relay
   * starts. The reservation is later passed to recordExternalTurn(), so a
   * crash cannot charge first and mint a different logical turn on retry. */
  async reservePromptQueueExternalTurn(
    session: AgentSession,
    queueLifecycle: {
      readonly queueTurn: true
      onTurnReserved(reservation: {
        turnIndex: number
        turnKey: string
        traceId?: string
      }): Promise<void>
    },
    traceId?: string,
  ): Promise<PromptQueueExternalTurnReservation> {
    const legacyId = this._resumeMap.get(session.sessionKey)
    const turnIndex = await reserveTurnIndex(session.sessionKey, {
      minimumLastTurn: session.turns,
      legacySessionIds: legacyId && legacyId !== session.sessionKey ? [legacyId] : [],
    })
    const turnKey = deriveLosslessTurnKey({
      sessionId: session.peerId,
      agentId: session.agentId,
      turnIndex,
      status: 'completed',
      text: '',
    })
    session.turns = turnIndex - 1
    session._currentTurnKey = turnKey
    session._currentTurnIndex = turnIndex
    await queueLifecycle.onTurnReserved({
      turnIndex,
      turnKey,
      ...(traceId ? { traceId } : {}),
    })
    return { turnIndex, turnKey }
  }

  /** Acquire the per-session turn lock for platform work that runs outside
   * the model runner. Stop requests abort its signal, and the returned finish
   * callback releases both the lock and reconnect-visible activity count. */
  beginExternalTurn(session: AgentSession, opts?: {
      queueTurn?: boolean
      queueExecutionFence?: PromptQueueExecutionFence
      clientMessageId?: string
    }): Promise<{
    signal: AbortSignal
    finish: (outcome: 'completed' | 'errored') => void
  }> {
    return beginExternalTurnImpl.call(this as unknown as SessionSubmitHost, session, opts)
  }

  // Resume-map state lives in ResumeStore (resumeStore.ts, FINDINGS §7 step 1).
  // These private views and delegates keep the resume policy below and the
  // existing tests on their old names.
  private get _resumeMap() { return this.resumeStore.ids }
  private get _resumeMapProvider() { return this.resumeStore.provider }
  private get _resumeMapHistory() { return this.resumeStore.history }
  private get _resumeRejectedIds() { return this.resumeStore.rejected }
  private get _resumeHeadPromotedFromHistory() { return this.resumeStore.promotedFromHistory }
  private get _resumeMapTimestamps() { return this.resumeStore.timestamps }
  private get _resumeMapLastCost() { return this.resumeStore.lastCost }
  private get _resumeMapCostImprecise() { return this.resumeStore.costImprecise }
  private get _resumeMapWrite() { return this.resumeStore.write }

  private _pushResumeHistory(key: string, prev: string | undefined | null): void {
    this.resumeStore.pushHistory(key, prev)
  }

  static extractRejectedResumeIds(errorDetail: string | undefined): string[] {
    return ResumeStore.extractRejectedIds(errorDetail)
  }

  private _markResumeRejectedFromError(
    key: string,
    errorDetail: string | undefined,
    liveId: string | null | undefined,
  ): string[] {
    return this.resumeStore.markRejectedFromError(key, errorDetail, liveId)
  }

  private _markResumeRejected(key: string, id: string | undefined | null): void {
    this.resumeStore.markRejected(key, id)
  }

  private _forgetResumeEntry(key: string): void {
    this.resumeStore.forget(key)
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
  private _resolveDurableResumeId(sessionKey: string, provider: string, head: string | undefined, workspacePath?: string, opts?: {
      /** Id the engine just rejected at runtime — never re-pick it even if its
       *  artifact looks present (non-empty file ≠ resumable conversation). */
      exclude?: string
      /** Default true: steer the live adapter via setResumeSessionId. Pass
       *  false when the caller IS the engine (codex resolveResumeFallback runs
       *  inside the kernel's own attach path and sets threadId itself). */
      syncRunner?: boolean
    }): string | undefined {
    return _resolveDurableResumeIdImpl.call(this as unknown as SessionSubmitHost, sessionKey, provider, head, workspacePath, opts)
  }

  private static CCB_PROVIDER_TAG = CCB_PROVIDER_TAG
  private static CCB_RESUME_HISTORY_CONTEXT_VERSION = CCB_RESUME_HISTORY_CONTEXT_VERSION

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
  private _resumeIdFor(sessionKey: string, wantProvider: string, workspacePath?: string): string | undefined {
    return _resumeIdForImpl.call(this as unknown as SessionSubmitHost, sessionKey, wantProvider, workspacePath)
  }

  /** A Grok id with no on-disk transcript must not stay --resume-able.
   *  Clearing the live head before `_saveResumeMap` also stops the overlay
   *  from writing that dead id back. */
  private _releaseGrokResumeHead(sessionKey: string): void {
    const live = this.sessions.get(sessionKey)
    if (!live || live.providerTag !== 'grok') return
    live.ccbSessionId = null
    live.runner.clearSessionId()
    live._historicalContextInjected = false
    live._historicalContextInjectedKey = undefined
    live._forceHistoricalContextOnFirstTurn = true
    live._contextRebuildNotice = 'native-resume-loss'
  }


  /** Same cwd projection CursorAdapter.spawnTurn uses: repo workspace when
   *  ready, otherwise the agent base dir. Wrapper --workspace is pwd -P of
   *  that cwd, so realpath when the path exists. */
  private _cursorWorkspacePath(agentBaseDir: string, repoSessionId?: string, projectBound?: boolean): string {
    return _cursorWorkspacePathImpl.call(this as unknown as SessionLifecycleHost, agentBaseDir, repoSessionId, projectBound)
  }

  private _cursorWorkspacePathForSession(session: AgentSession): string | undefined {
    if (!session.workspaceCwd) return undefined
    return this._cursorWorkspacePath(
      session.workspaceCwd,
      session.repoSessionId ?? session.peerId,
      Boolean(session.projectId),
    )
  }

  /** Whether a CCB session's JSONL file exists somewhere under
   *  `$CLAUDE_CONFIG_DIR/projects/*`. We don't try to replicate CCB's
   *  sanitizePath(cwd) projection — worktree switches, EnterWorktreeTool
   *  and the gap between CCB process cwd (= ccbDir) vs agent.cwd (=
   *  --add-dir) each rearrange where the file actually lands. Instead we
   *  scan every project directory under CLAUDE_CONFIG_DIR/projects and
   *  look for `<id>.jsonl` with non-zero size. In v3 containers this dir
   *  typically has ≤5 subdirs so the scan is cheap.
   *
   *  Conservative by design: errors, missing CLAUDE_CONFIG_DIR, or missing
   *  projects/ dir all return `true` (skip validation) — we'd rather let
   *  the old parser stale-detection fire than incorrectly evict a live
   *  resume entry. */
  private _ccbJsonlExists(resumeId: string): boolean {
    return _ccbJsonlExistsImpl.call(this as unknown as SessionLifecycleHost, resumeId)
  }

  /** Return the persisted cost-delta baseline iff the entry was produced by
   *  `wantProvider`. Cost baseline is tied to the *same subprocess* that
   *  wrote it — feeding a CCB-era cumulative into a freshly-spawned codex
   *  runner (or vice-versa) would poison `totalCostUSD` on the first
   *  `result`, showing an inflated sessionTotal / cost.recorded value that
   *  isn't tied to real API usage. Mismatch → undefined (caller seeds 0). */
  private _lastCostFor(sessionKey: string, wantProvider: string): number | undefined {
    const cost = this._resumeMapLastCost.get(sessionKey)
    if (cost === undefined) return undefined
    const tag = SessionManager.normalizeEngineTag(this._resumeMapProvider.get(sessionKey))
    return tag === wantProvider ? cost : undefined
  }

  private _costImpreciseFor(sessionKey: string, wantProvider: string): boolean {
    const tag = SessionManager.normalizeEngineTag(this._resumeMapProvider.get(sessionKey))
    return tag === wantProvider && this._resumeMapCostImprecise.get(sessionKey) === true
  }

  private static normalizeEngineTag = normalizeEngineTag

  private _loadResumeMap(): void {
    this.resumeStore.load()
  }

  private _saveResumeMap(): void {
    this.resumeStore.persist(this.resumeStore.serialize(this.sessions))
  }

  /** Await any pending resume-map disk writes (used by shutdown to prevent data loss). */
  async awaitResumeMapFlush(): Promise<void> {
    await this.resumeStore.flush()
  }

  /** Check which sessionKeys in the resume map match a given pattern (e.g., containing a peerId) */
  getResumableKeys(filter?: (key: string) => boolean): string[] {
    const keys = [...this._resumeMap.keys()]
    return filter ? keys.filter(filter) : keys
  }

  /** Fence the complete accepted-grant window: session lookup/engine switch,
   * attachment preprocessing, activation, provider execution and settlement.
   * PG still owns ordering; this token only turns accidental parallel runtime
   * work into a synchronous invariant failure. */
  beginPromptQueueExecutionFence(sessionKey: string): PromptQueueExecutionFence {
    const existing = this.sessions.get(sessionKey)
    if (
      this._promptQueueDispatchFences.has(sessionKey) ||
      this._promptQueueExecutionKeys.has(sessionKey) ||
      (existing?._activeTurnCount ?? 0) > 0 ||
      (existing?._activeClientTurnCount ?? 0) > 0
    ) {
      throw new Error('PROMPT_QUEUE_EXECUTION_INVARIANT: logical session already owns runtime work')
    }
    const token = Symbol(`prompt-queue:${sessionKey}`)
    this._promptQueueDispatchFences.set(sessionKey, token)
    let released = false
    return {
      sessionKey,
      token,
      release: () => {
        if (released) return
        released = true
        if (this._promptQueueDispatchFences.get(sessionKey) === token) {
          this._promptQueueDispatchFences.delete(sessionKey)
        }
      },
    }
  }

  private _ownsPromptQueueExecutionFence(
    sessionKey: string,
    fence: PromptQueueExecutionFence | undefined,
  ): boolean {
    return (
      fence !== undefined &&
      fence.sessionKey === sessionKey &&
      this._promptQueueDispatchFences.get(sessionKey) === fence.token
    )
  }

  getOrCreate(opts: {
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
    /** Speculation may create a missing identity, but never replace/mutate a real one. */
    preheatOnly?: boolean
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
  }): Promise<AgentSession> {
    return getOrCreateImpl.call(this as unknown as SessionSubmitHost, opts)
  }

  private async _enterSessionCreateGate<T>(sessionKey: string, work: () => Promise<T>): Promise<T> {
    const previous = this._sessionCreateGates.get(sessionKey) ?? Promise.resolve()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(
      () => held,
      () => held,
    )
    this._sessionCreateGates.set(sessionKey, tail)
    try {
      await previous
      return await work()
    } finally {
      release()
      if (this._sessionCreateGates.get(sessionKey) === tail) {
        this._sessionCreateGates.delete(sessionKey)
      }
    }
  }

  private _getOrCreateExclusive(opts: Parameters<SessionManager['getOrCreate']>[0]): Promise<AgentSession> {
    return _getOrCreateExclusiveImpl.call(this as unknown as SessionSubmitHost, opts)
  }

  prepareModelSwitch(session: AgentSession, expectedSourceModel: string, targetModel: string, switchId: string): Promise<{ sourceModel: string; targetModel: string }> {
    return prepareModelSwitchImpl.call(this as unknown as SessionLifecycleHost, session, expectedSourceModel, targetModel, switchId)
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
  private async finishIdleUnderLock(session: AgentSession, source: {
    sessionId: string
    turnKey: string
  }, recoveryDir: string = paths.home): Promise<void> {
    return finishIdleUnderLockImpl.call(this as unknown as SessionSubmitHost, session, source, recoveryDir)
  }

  /**
   * Run durable idle work after the user turn released session.lock. Queued
   * behind the lock like recycle; from scheduling to release it is counted as
   * an internal turn (not a client turn and not _activeTurnCount, so the
   * prompt-queue admission invariant is untouched). Rereads disk state under
   * the lock, so a submit that took the lock first has already handled or
   * superseded it.
   */
  private scheduleIdleDrain(session: AgentSession, attempt = 0): void {
    scheduleIdleDrainImpl.call(this as unknown as SessionLifecycleHost, session, attempt)
  }

  /** Operator exit (requestIdleReset): replace the native session, then
   * abandon this session's unfinished idle work. Caller owns session.lock. */
  private applyIdleResetIfRequested(session: AgentSession): Promise<void> {
    return applyIdleResetIfRequestedImpl.call(this as unknown as SessionLifecycleHost, session)
  }

  cancelModelSwitch(session: AgentSession, switchId: string): boolean {
    const transition = session._modelSwitchTransition
    if (!transition || transition.id !== switchId || transition.state === 'consuming') return false
    session._modelSwitchTransition = undefined
    return true
  }

  // ── 引擎预热(session-open engine preheat)───────────────────────────────

  /** Per-session in-flight preheat (single-flight) + global concurrency cap. */
  private readonly _preheatInFlight = new Map<string, Promise<PreheatOutcome>>()
  private _preheatActive = 0

  /**
   * 会话打开引擎预热(INC-20260824-FIRST-TEXT-LATENCY;调用方负责 env gate)。
   *
   * 只对实现了 `EngineAdapter.preheat` 的常驻进程引擎生效(CCB spawn ~20s、codex
   * app-server 5-8s);one-shot CLI(grok/cursor/zcode)无 preheat → skip。语义边界:
   * **不提交 turn、零上游 LLM 调用、零 LLM 计费**;但 spawn 会拉起 MCP 子进程,
   * 用户自配 MCP 的初始化可能有本地/网络副作用 —— 由全局并发 cap=1、单飞与失败
   * 日志兜底。串行化在 session.lock 上;与几乎同时到达的 submit 共享 runner 的
   * in-flight start promise,不会互抛。
   */
  /** Prompt-queue in-flight for this session: a queued-but-not-yet-granted
   * turn owns the spawn/side-effect boundary — preheat must not preempt it. */
  private _promptQueueHolds(session: AgentSession): boolean {
    return (
      this._promptQueueExecutions.has(session) ||
      this._promptQueueExecutionKeys.has(session.sessionKey) ||
      this._promptQueueDispatchFences.has(session.sessionKey)
    )
  }

  preheatRunner(session: AgentSession, preparation?: PreheatPreparation): Promise<PreheatOutcome> {
    return preheatRunnerImpl.call(this as unknown as SessionLifecycleHost, session, preparation)
  }

  submit(session: AgentSession, userTextOrBlocks: string | Array<{ type: string; [key: string]: unknown }>, onEvent: (e: SessionStreamEvent) => void, effortLevel?: string | null, model?: string, requestId?: string, traceId?: string, conversationMode?: 'default' | 'plan', opts?: {
      historicalMessages?: unknown[]
      /** v5 codex route 消费链(A1):dispatchInbound 校验后的 per-turn provider
       *  路由覆盖。每 turn 显式 set(null = 清除 stale route);仅 codex engine
       *  runner 实现 setCodexRoute,其余 runner duck-type 缺方法 → noop。 */
      codexRoute?: CodexProviderConfigOverride | null
      /** Grok CLI receives only this one-turn opaque loopback relay route. */
      grokRoute?: GrokRouteOverride | null
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
      systemHelpBootstrap?: string
      /** Remaining spendable credits (fen) captured at master admission. */
      creditBudgetFen?: bigint
      /** 长会话热尾巴+归档 §2.3:历史上下文兜底注入**成功后**回调,让上层
       *  (server.ts)发 sys.context_rebuilt 提示帧(boss 硬指标 3:引擎无法原生续接、
       *  走兜底注入时主动提醒用户)。仅 webchat leader turn 传;delegate/cron/train
       *  submit 不传 → 无用户可见提示。gateway-authored 决策,不进 engine event 流。 */
      emitContextRebuilt?: (info: { messageCount: number; reason?: 'engine-switch' | 'native-resume-loss' }) => void
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
    }): Promise<void> {
    return submitImpl.call(this as unknown as SessionSubmitHost, session, userTextOrBlocks, onEvent, effortLevel, model, requestId, traceId, conversationMode, opts)
  }

  private runOneTurnWithRetry(session: AgentSession, userTextOrBlocks: string | Array<{ type: string; [key: string]: unknown }>, onEvent: (e: SessionStreamEvent) => void, requestId?: string, traceId?: string, collabAgentPolicy?: CollabAgentPolicy, modelAuthority?: TurnModelAuthority, clientMessageId?: string, dispatchContext?: AgentSession['_currentDispatch'], queueLifecycle?: {
      readonly queueTurn: true
      onTurnReserved(reservation: {
        turnIndex: number
        turnKey: string
        traceId?: string
      }): Promise<void>
    }, logicalTurnSignal?: AbortSignal, contextOverflowRetryInputs: string[] = [], automaticRetryState?: AutomaticRetryState, modelSwitchTransition?: AgentSession['_modelSwitchTransition']): Promise<void> {
    return runOneTurnWithRetryImpl.call(this as unknown as TurnRunnerHost, session, userTextOrBlocks, onEvent, requestId, traceId, collabAgentPolicy, modelAuthority, clientMessageId, dispatchContext, queueLifecycle, logicalTurnSignal, contextOverflowRetryInputs, automaticRetryState, modelSwitchTransition)
  }

  private _transientRetryDelayMs(attempt: number): number {
    return Math.min(30_000, 2000 * 2 ** attempt) + Math.random() * 1000
  }

  /** Wait for the runner's stdout to really close, but never forever.
   *
   * The supervisor's own shutdown is already bounded, so reaching the deadline
   * here means a descendant outlived a process-group SIGKILL and still owns
   * the pipe. Giving up costs at most the bytes that descendant has yet to
   * write; refusing to give up costs the turn its terminal state. */
  private async _awaitBoundedOutputDrain(
    runner: Pick<EngineAdapter, 'waitForOutputDrain'>,
    session: AgentSession,
  ): Promise<void> {
    const timeoutMs = this._terminalOutputDrainTimeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      await runner.waitForOutputDrain()
      return
    }
    let timer: NodeJS.Timeout | undefined
    const drained = await Promise.race([
      // A barrier that settles after the deadline must not resurface as an
      // unhandled rejection once we have already moved on.
      runner
        .waitForOutputDrain()
        .then(
          () => true,
          () => true,
        ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
    if (timer) clearTimeout(timer)
    if (drained) return
    log.error('terminal output drain deadline exceeded; finalizing turn without stdout close', {
      sessionKey: session.sessionKey,
      provider: session.providerTag,
      timeoutMs,
    })
  }

  // (auth 错误关键字分类已下沉 engine/ccbAdapter.ts —— 错误字符串是 CCB 底座私有
  //  知识;本层只消费 TurnSummary.errorKind === 'auth'。)

  private _runOneTurn(session: AgentSession, userTextOrBlocks: string | Array<{ type: string; [key: string]: unknown }>, onEvent: (e: SessionStreamEvent) => void, requestId?: string, traceId?: string, collabAgentPolicy?: CollabAgentPolicy, assistantMessageId?: string, thinkingMessageId?: string, toolMessageIdFactory?: (blockId: string) => string, turnKey?: string, clientMessageId?: string, modelAuthority?: TurnModelAuthority, retryRuntimeEvents: DurableRuntimeEvent[] = [], retryAssistantSegments: SegmentRecord[] = [], retryThinkingSegments: SegmentRecord[] = [], retryTools: TurnToolEntry[] = [], retryStructuredBlocks: Array<Record<string, unknown>> = [], queueTurn = false, retryAuthErrors = true, retryPhantomErrors = true, retryTransientErrors = false, attemptOrdinal = 0, automaticRetryState?: AutomaticRetryState, modelSwitchTransition?: AgentSession['_modelSwitchTransition']): Promise<void> {
    return _runOneTurnImpl.call(this as unknown as TurnRunnerHost, session, userTextOrBlocks, onEvent, requestId, traceId, collabAgentPolicy, assistantMessageId, thinkingMessageId, toolMessageIdFactory, turnKey, clientMessageId, modelAuthority, retryRuntimeEvents, retryAssistantSegments, retryThinkingSegments, retryTools, retryStructuredBlocks, queueTurn, retryAuthErrors, retryPhantomErrors, retryTransientErrors, attemptOrdinal, automaticRetryState, modelSwitchTransition)
  }

  /** Control receipts must await durable Box intent. A rejection deliberately
   * leaves the master's durable Stop control pending for its existing retry. */
  async interruptForReceipt(sessionKey: string, exact?: {turnKey?:string;clientMessageId?:string}): Promise<boolean> {
    const captured=this.captureInterruptForReceipt(sessionKey,exact)
    if (!captured) return false
    await captured.prepare()
    return captured.interrupt()
  }

  captureInterruptForReceipt(sessionKey:string,exact?:{turnKey?:string;clientMessageId?:string}) {
    const s=this.sessions.get(sessionKey)
    if (!s || (exact?.turnKey !== undefined && s._currentTurnKey !== exact.turnKey)
      || (exact?.clientMessageId !== undefined && s._runningClientMessageId !== exact.clientMessageId)) return undefined
    const runner=s.runner, turnKey=s._currentTurnKey, external=s._externalTurnAbort
    const persist=s._persistActiveTurn
    if (!persist && exact?.clientMessageId !== undefined) this.fencePreStartStop(s.peerId,exact.clientMessageId)
    const engine=isBoxApiModel(s.model) ? runner.captureInterruptForReceipt?.(turnKey) : undefined
    return {target:engine?.target,prepare:async()=>{
      if (engine) await engine.prepare()
      else if (isBoxApiModel(s.model) && runner.prepareInterrupt) await runner.prepareInterrupt('user',turnKey)
    },interrupt:async()=>{
      // Even on retry, prepare only the captured old engine owner. A completed
      // old turn is an applied target, never permission to abort its successor.
      if (this.sessions.get(sessionKey) !== s || s.runner !== runner || s._currentTurnKey !== turnKey
        || s._externalTurnAbort !== external || s._persistActiveTurn !== persist
        || (exact?.clientMessageId !== undefined && s._runningClientMessageId !== exact.clientMessageId)) return true
      if (persist) {
        const pending=persist('interrupted','本轮已由用户停止。','USER_CANCELLED')
        this._trackPersistence(pending)
        await pending
        return true
      }
      if (external && !external.signal.aborted) external.abort()
      const interrupted=engine ? engine.interrupt() : runner.interrupt('user')
      return !!external || interrupted
    }}
  }

  interrupt(sessionKey: string, reason: 'user' | 'system' = 'system'): boolean {
    const s = this.sessions.get(sessionKey)
    if (!s) return false
    const external = s._externalTurnAbort
    const needsBoxBarrier = reason === 'user' && isBoxApiModel(s.model) && s.runner.prepareInterrupt !== undefined
    if (!needsBoxBarrier && external && !external.signal.aborted) external.abort()
    const persistActiveTurn = s._persistActiveTurn
    if (persistActiveTurn) {
      const persistence = reason === 'user'
        ? persistActiveTurn('interrupted', '本轮已由用户停止。', 'USER_CANCELLED')
        : persistActiveTurn('interrupted', '本轮因系统调度中断。', 'SYSTEM_INTERRUPT')
      this._trackPersistence(persistence)
      return true
    }
    if (needsBoxBarrier) {
      const runner = s.runner
      const turnKey = s._currentTurnKey
      const captured=runner.captureInterruptForReceipt?.(turnKey)
      const pending = (async () => {
        for (;;) {
          try {if(captured) await captured.prepare();else await runner.prepareInterrupt!('user',turnKey);break}
          catch {
            log.warn('box_user_stop_control_pending', {sessionKey})
            // Retain this exact old turn's local intent when a synchronous
            // internal caller cannot await a receipt. Retry control only;
            // after persistence the identity guard still protects a new turn.
            await new Promise<void>(resolve => {setTimeout(resolve,5000).unref?.()})
          }
        }
        if (this.sessions.get(sessionKey) !== s || s.runner !== runner
          || s._currentTurnKey !== turnKey || s._externalTurnAbort !== external
          || s._persistActiveTurn !== persistActiveTurn) return
        if (external && !external.signal.aborted) external.abort()
        if(captured) captured.interrupt();else runner.interrupt('user')
      })()
      this._trackPersistence(pending)
      return true
    }
    const runnerInterrupted = s.runner.interrupt(reason)
    return !!external || runnerInterrupted
  }

  /** Stop-and-run fence: never interrupt a newer turn that raced the queue
   * mutation/PG response. Exact logical turnKey is the only accepted owner. */
  interruptExact(sessionKey: string, turnKey: string): boolean {
    const session = this.sessions.get(sessionKey)
    if (!session || session._currentTurnKey !== turnKey) return false
    return this.interrupt(sessionKey, 'user')
  }

  /** Browser Stop fence: only interrupt the turn that owns this exact
   * clientMessageId.  A stale Stop can never kill a newer turn. */
  interruptClientTurn(sessionKey: string, clientMessageId: string): boolean {
    const session = this.sessions.get(sessionKey)
    if (!session || session._runningClientMessageId !== clientMessageId) return false
    // The owner is known but its engine run (and terminal persistence) is not
    // created yet; arm the fence so the run stops the moment it exists.
    if (!session._persistActiveTurn) this.fencePreStartStop(session.peerId, clientMessageId)
    return this.interrupt(sessionKey, 'user')
  }

  /** OCV5-435 — a browser Stop for an accepted turn that has no engine run
   * yet. Answering "not active" would let the turn start anyway while Master
   * already treats it as stopped (its prompts become user_stop cards the
   * browser hides). The fence stops that exact turn as soon as it starts. */
  fencePreStartStop(
    peerId: string,
    clientMessageId: string,
    ttlMs: number = PRE_START_STOP_TTL_MS,
    sendAttempt?: number,
  ): void {
    const now = Date.now()
    for (const [key, fence] of this._preStartStops) {
      if (fence.expiresAt <= now) this._preStartStops.delete(key)
    }
    this._preStartStops.set(preStartStopKey(peerId, clientMessageId), {
      expiresAt: now + ttlMs,
      ...(sendAttempt !== undefined ? { sendAttempt } : {}),
    })
  }

  /** A message was just admitted. A fence armed before it arrived either
   * belongs to this send (it then lives as long as an admitted turn's fence,
   * however long the run takes to start) or to another send attempt of the
   * same message (a resend after a Stop the gateway never saw the original
   * for), which it must not stop. Unknown attempts on either side keep it. */
  adoptPreStartStopOnAdmission(peerId: string, clientMessageId: string, sendAttempt?: number): void {
    const key = preStartStopKey(peerId, clientMessageId)
    const fence = this._preStartStops.get(key)
    if (!fence) return
    if (fence.expiresAt <= Date.now()) {
      this._preStartStops.delete(key)
      return
    }
    if (fence.sendAttempt !== undefined && sendAttempt !== undefined && fence.sendAttempt !== sendAttempt) {
      this._preStartStops.delete(key)
      return
    }
    fence.expiresAt = Date.now() + PRE_START_STOP_TTL_MS
  }

  /** Drop a fence whose turn ended without ever creating an engine run. */
  clearPreStartStop(peerId: string, clientMessageId: string): void {
    this._preStartStops.delete(preStartStopKey(peerId, clientMessageId))
  }

  private _takePreStartStop(peerId: string, clientMessageId: string): boolean {
    const key = preStartStopKey(peerId, clientMessageId)
    const fence = this._preStartStops.get(key)
    if (fence === undefined) return false
    this._preStartStops.delete(key)
    return fence.expiresAt > Date.now()
  }

  getByKey(sessionKey: string): AgentSession | undefined {
    return this.sessions.get(sessionKey)
  }

  /**
   * P2 债A — buffer a completed delegation (team card) onto the leader session
   * so it drains into that session's turn-end server-authored persist.
   *
   * Called from `handleDelegateTask` collection at delegate完成/失败/超时 收尾,
   * keyed by the parent (leader) sessionKey.
   *
   * OCV5-180 B1 — exact-owner admission:带 `owner`(launch 时冻结的
   * {parentSessionId,parentTurnKey,turnIndex})时,只有「parent 的当前 turn 仍是
   * 该 owner turn 且该 turn 未被 seal」才接受入内存缓冲;否则返回 false,由调用方
   * 走 `deliverLateDelegateAgentGroup` 持久晚到通路。不带 owner 保持旧语义
   * (存量测试/旧调用方)。父会话不在内存同样返回 false —— 调用方凭冻结 locator
   * 仍可持久化晚到卡,不再退化为 client-only 丢失。
   *
   * Array.push is safe under concurrent parallel delegations (single-threaded
   * event loop, no torn writes).
   */
  bufferPendingAgentGroup(parentSessionKey: string, group: DurableAgentGroup, owner?: DelegateOwnerTurnLocator): boolean {
    return bufferPendingAgentGroupImpl.call(this as unknown as SessionAgentGroupsHost, parentSessionKey, group, owner)
  }

  /** P2 债A — take the leader session's buffered team cards for the turn-end
   *  persist. Returns [] when empty.
   *
   * OCV5-180 B1 — 带 `turnKey`(终态冻结点:completed persist 或 terminal
   * partial persist,两处均在同一同步临界段内冻结 payload)时:
   *  1. 只取 ownerTurnKey 匹配本 turn(或无 owner 的旧条目)的卡 —— 其他
   *     turn 的晚到卡绝不再混入本 turn 的 tape(历史 65 条坏 tape 的根因);
   *  2. 同步把该 turn 记入 `_sealedOwnerTurnKeys`(B-R2-1:封口判据 = payload
   *     已冻结,不是 master ACK/finalized)。此后同 owner 的完成只能走持久
   *     晚到通路。不带 turnKey 保持旧 take-and-clear 语义(存量测试)。 */
  drainPendingAgentGroups(session: AgentSession, turnKey?: string): DurableAgentGroup[] {
    return drainPendingAgentGroupsImpl.call(this as unknown as SessionAgentGroupsHost, session, turnKey)
  }

  /** OCV5-180 B1 — 把 owner turn 已 seal 后到达(或 owner 会话已不在内存)的
   * 委派团队卡,作为受限 continuation tape 持久化到原 owner 名下。
   *
   * 幂等/冲突契约:同一 (ownerTurnKey, runId) 首次写入登记 identity;
   *  - 同 identity 重投(如 durable 重放)→ no-op(确定性 tape 本就幂等);
   *  - 不同内容同 run → 记 `late_delegate_group_conflict`(可观察),保留首卡,
   *    不再生成第二张卡。返回 false 仅表示「未调度新写」(invalid locator /
   *    冲突抑制),不含 sink 排队('queued' 是可靠等待,由 sink drainer 送达)。 */
  deliverLateDelegateAgentGroup(args: {
    owner: DelegateOwnerTurnLocator
    group: DurableAgentGroup
    sessionKey?: string
  }): boolean {
    return deliverLateDelegateAgentGroupImpl.call(this as unknown as SessionAgentGroupsHost, args)
  }

  private _exactOwnerRunKey(ownerTurnKey: string, runId: string): string {
    return `${ownerTurnKey}\0${runId}`
  }

  private _trimExactOwnerRuns(): void {
    _trimExactOwnerRunsImpl.call(this as unknown as SessionAgentGroupsHost)
  }

  private _ownerLocatorForSession(
    session: AgentSession,
    turnKey: string,
  ): DelegateOwnerTurnLocator {
    return {
      parentSessionId: session.peerId,
      parentTurnKey: turnKey,
      turnIndex:
        session._currentTurnIndex ??
        (Number.isSafeInteger(session.turns) ? Math.max(1, session.turns) : 1),
    }
  }

  /** Shared exact-owner logical-run admission for buffer / drain / late. */
  private _admitExactOwnerRun(owner: DelegateOwnerTurnLocator, group: DurableAgentGroup, next: ExactOwnerRunState): 'accept' | 'duplicate' | 'conflict' | 'session_deleted' {
    return _admitExactOwnerRunImpl.call(this as unknown as SessionAgentGroupsHost, owner, group, next)
  }

  private _claimDrainedOwnerGroups(session: AgentSession, turnKey: string, groups: DurableAgentGroup[]): void {
    _claimDrainedOwnerGroupsImpl.call(this as unknown as SessionAgentGroupsHost, session, turnKey, groups)
  }

  private _settleDrainedOwnerGroups(session: AgentSession, turnKey: string, groups: DurableAgentGroup[], outcome: TapePersistResult): void {
    _settleDrainedOwnerGroupsImpl.call(this as unknown as SessionAgentGroupsHost, session, turnKey, groups, outcome)
  }

  private _compareOwnerRunIdentity(
    seenIdentity: string,
    owner: DelegateOwnerTurnLocator,
    group: DurableAgentGroup,
  ): 'duplicate' | 'conflict' {
    if (!seenIdentity) return 'duplicate'
    return seenIdentity === lateDelegateGroupIdentity(owner, group) ? 'duplicate' : 'conflict'
  }

  private _matchLiveOwnerRun(session: AgentSession, owner: DelegateOwnerTurnLocator, group: DurableAgentGroup): 'accept' | 'duplicate' | 'conflict' | 'session_deleted' {
    return _matchLiveOwnerRunImpl.call(this as unknown as SessionAgentGroupsHost, session, owner, group)
  }

  private _matchLiveSessionsOwnerRun(owner: DelegateOwnerTurnLocator, group: DurableAgentGroup, sessionKey?: string): 'accept' | 'duplicate' | 'conflict' | 'session_deleted' {
    return _matchLiveSessionsOwnerRunImpl.call(this as unknown as SessionAgentGroupsHost, owner, group, sessionKey)
  }

  /** OCV5-180 B1 — mark an owner turn sealed (payload frozen). Insertion-order
   * LRU; re-sealing an already-sealed key is a no-op. */
  private _sealOwnerTurn(session: AgentSession, turnKey: string): void {
    _sealOwnerTurnImpl.call(this as unknown as SessionAgentGroupsHost, session, turnKey)
  }

  /** team-durability — 客户 turn 进入执行段(dispatchInbound 首次 submit 前)。
   *  与 endClientTurn 严格 try/finally 配对。语义见 AgentSession._activeClientTurnCount。 */
  beginClientTurn(session: AgentSession): void {
    session._activeClientTurnCount = (session._activeClientTurnCount ?? 0) + 1
  }

  /** team-durability — 客户 turn 收尾(含 review 编排在内的整个 turn 生命周期结束)。
   *  outcome 记入 _lastClientTurnOutcome 供 hello 重连对账区分"正常完成 vs 中断"。
   *  RFC-v5-durable-turn-dispatch §4:带 clientMessageId 时同步记入 recent-terminal
   *  ring —— 精确身份对账(命中 completed→turn_completed;命中中断→interrupted)。 */
  endClientTurn(
    session: AgentSession,
    outcome: 'completed' | 'errored',
    clientMessageId?: string,
  ): void {
    session._activeClientTurnCount = Math.max(0, (session._activeClientTurnCount ?? 0) - 1)
    session._lastClientTurnOutcome = outcome
    if (clientMessageId) {
      recordRecentTerminal(
        session,
        clientMessageId,
        outcome === 'completed' ? 'completed' : 'interrupted',
      )
    }
  }

  /**
   * 切换 session 的执行目标 (local ⇄ remote)。
   *
   * 语义(与 boss 对齐):
   *   - 切换意味着**清空上下文** —— shutdown 当前 runner + 清 resume-map。用户
   *     在进入切换时已被 UI 明确告知此行为(前端侧)。
   *   - lock chain 保护:integrated 进 session.lock,跟 submit 相互串行,
   *     保证不会在 in-flight turn 中途偷偷换掉 target。
   *   - 切入 remote 先 acquireMux 成功再 swap,失败路径不碰 runner;切走 remote
   *     在 swap 成功后才 release 旧 mux(outside lock,避免持锁做 IO)。
   *   - 幂等:target.kind 与当前相同且(remote 时)hostId 相同 → noop 返回。
   *
   * 失败:
   *   - controller 未注入但 target.kind='remote' → RemoteTargetUnavailableError
   *   - session 不存在 → throw
   *   - session.userId 缺失(cron / 历史路径) → throw(remote 必须绑 user)
   *   - acquireMux 抛 → rethrow(已回滚,runner 未动)
   */
  setExecutionTarget(sessionKey: string, target: { kind: 'local' } | { kind: 'remote'; hostId: string }): Promise<void> {
    return setExecutionTargetImpl.call(this as unknown as SessionLifecycleHost, sessionKey, target)
  }

  /** Destroy a single session: kill subprocess + remove from map + clear resume mapping.
   *  Also clears resume-map even if the session was already evicted from memory. */
  destroySession(sessionKey: string): Promise<void> {
    return destroySessionImpl.call(this as unknown as SessionLifecycleHost, sessionKey)
  }

  /**
   * Stop the warm runner and drop the live session, but keep resume-map so a
   * later getOrCreate(sessionKey) can native-resume. Awaited by resumable
   * delegate_task; fire-and-forget destroySession remains the one-shot path.
   */
  retireKeepResume(sessionKey: string): Promise<void> {
    return retireKeepResumeImpl.call(this as unknown as SessionLifecycleHost, sessionKey)
  }

  hasLiveSession(sessionKey: string): boolean {
    return this.sessions.has(sessionKey)
  }

  /** Drop resume-map rows for an evicted/expired delegate binding. */
  forgetResume(sessionKey: string): void {
    if (!this._resumeMap.has(sessionKey)) return
    this._resumeMap.delete(sessionKey)
    this._resumeMapTimestamps.delete(sessionKey)
    this._resumeMapLastCost.delete(sessionKey)
    this._resumeMapCostImprecise.delete(sessionKey)
    this._resumeMapProvider.delete(sessionKey)
    this._resumeMapHistory.delete(sessionKey)
    this._saveResumeMap()
  }

  shutdownAll(): Promise<void> {
    return shutdownAllImpl.call(this as unknown as SessionLifecycleHost)
  }

  list(): {
    sessionKey: string
    agentId: string
    lastUsedAt: number
    ccbSessionId: string | null
    turns: number
    totalCostUSD: number
  }[] {
    return [...this.sessions.values()].map((s) => ({
      sessionKey: s.sessionKey,
      agentId: s.agentId,
      lastUsedAt: s.lastUsedAt,
      ccbSessionId: s.ccbSessionId,
      turns: s.turns,
      totalCostUSD: s.totalCostUSD,
    }))
  }

  // 周期性 LRU 驱逐 — webchat sessions survive much longer than cron/task sessions
  startEvictionLoop(intervalMs = 60_000): () => void {
    return startEvictionLoopImpl.call(this as unknown as SessionLifecycleHost, intervalMs)
  }


  private _pruneResumeMap(): void {
    const pruned = this.resumeStore.prune((key) => this.sessions.has(key), RESUME_MAP_INACTIVE_TTL_MS)
    for (const { key, ageMs } of pruned) {
      log.info('pruned idle resume-map entry', { sessionKey: key, ageMs })
    }
    if (pruned.length > 0) this._saveResumeMap()
  }
}

// ── Verification verdict parser ──────────────────
// Detects "VERDICT: PASS|FAIL|PARTIAL|NEEDS_FIX" and "### Check:" blocks in
// assistant text.
//
// P2 债C — 词汇统一:历史上本解析器(为科研/校验类 turn 而生)只认 PASS/FAIL/
// PARTIAL,而团队模式隐藏审查员 persona 输出的是 PASS / NEEDS_FIX,两条管线互不
// 相认(解析器解析不出审查裁决 → 审查结果无法回流)。现吸收 NEEDS_FIX 作为 FAIL
// 语义(= 未通过 / passed=false),让同一个解析器同时服务两条管线。NEEDS_FIX 的
// 词汇权威源 = @openclaude/protocol REVIEW_VERDICT_NEEDS_FIX(reviewer persona 与
// gateway 硬编排 review pass 共用),此处正则与之对齐。

interface ParsedVerdict {
  verdict: 'PASS' | 'FAIL' | 'PARTIAL' | 'NEEDS_FIX'
  passed: boolean
  evidence: Array<{ check: string; passed: boolean; detail?: string }>
}

const VERDICT_RE = /^VERDICT:\s*(PASS|FAIL|PARTIAL|NEEDS_FIX)\s*$/m

/** Strip fenced code blocks to prevent false matches inside output. */
function stripCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '')
}

export function parseVerificationVerdict(text: string): ParsedVerdict | null {
  // Strip code fences to avoid false matches in examples/output
  const cleaned = stripCodeFences(text)

  const verdictMatch = VERDICT_RE.exec(cleaned)
  if (!verdictMatch) return null

  const verdict = verdictMatch[1] as 'PASS' | 'FAIL' | 'PARTIAL' | 'NEEDS_FIX'
  const evidence: ParsedVerdict['evidence'] = []

  // Split text into check blocks (each starts with "### Check:" at line start)
  const parts = cleaned.split(/(?=^### Check:)/m)
  for (const part of parts) {
    const nameMatch = /^### Check:\s*(.+?)(?:\n|$)/.exec(part)
    if (!nameMatch) continue

    const checkName = nameMatch[1].trim()

    // Find the LAST "**Result: PASS|FAIL**" in the block (anchor to trailing position)
    let passed = false
    const allResults = [...part.matchAll(/^\*\*Result:\s*(PASS|FAIL)\*\*/gm)]
    if (allResults.length > 0) {
      passed = allResults[allResults.length - 1][1] === 'PASS'
    }

    // Extract detail: everything between the check name and the last result line (truncated)
    let detail: string | undefined
    if (allResults.length > 0) {
      const lastResultIdx = allResults[allResults.length - 1].index!
      // Offset is relative to `part`, so it's correct
      detail = part.slice(nameMatch[0].length, lastResultIdx).trim().slice(0, 500) || undefined
    } else {
      detail = part.slice(nameMatch[0].length).trim().slice(0, 500) || undefined
    }

    evidence.push({ check: checkName, passed, detail })
  }

  return { verdict, passed: verdict === 'PASS', evidence }
}
