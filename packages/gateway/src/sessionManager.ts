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

/** Background idle drain re-arms while proof stays pending (egress settling). */
const IDLE_DRAIN_RETRIES = 6
const IDLE_DRAIN_RETRY_MS = 30_000

import { isCcbUserCancellationDiagnostic } from './engine/ccbAdapter.js'
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

function latestAssistantMessageId(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const raw = messages[i]
    if (!raw || typeof raw !== 'object') continue
    const msg = raw as ChatHistoryMessage & { id?: unknown }
    if (msg.system === true) continue
    if (msg.role !== 'assistant') continue
    const id = typeof msg.id === 'string' ? msg.id : ''
    return id || null
  }
  return null
}

export function shouldTreatMasterHistoryAsProviderGap(opts: {
  messages: unknown[]
  peerId: string
  agentId: string
}): boolean {
  const latestAssistantId = latestAssistantMessageId(opts.messages)
  if (!latestAssistantId) return false
  return !latestAssistantId.startsWith(`srv-${opts.peerId}-${opts.agentId}-t`)
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
): string | null {
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
  const jsonString = (value: string): string => JSON.stringify(value).replace(/</g, '\\u003c')
  const renderPrompt = (
    selectedRows: Array<{ role: ModelHistorySemanticRole; text: string }>,
  ): string => {
    const transcript = selectedRows.map((message) => ({
      role: modelHistoryRoleLabel(message.role),
      text: message.text,
    }))
    const historyJson = JSON.stringify(transcript).replace(/</g, '\\u003c')
    return [
      '<openclaude_previous_context_json>',
      'The current OpenClaude session was previously served by a different runner/provider or cannot be natively resumed. The next line is JSON. Use it as prior conversation context and do not restate it unless needed.',
      historyJson,
      '</openclaude_previous_context_json>',
      '',
      '<current_user_message_json>',
      jsonString(currentUserText),
      '</current_user_message_json>',
    ].join('\n')
  }
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
    currentUserText,
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

const NATIVE_MODEL_HANDOFF_MAX_CHARS = 256_000
const NATIVE_MODEL_SWITCH_TTL_MS = 30 * 60_000

export function shouldAttemptHistoricalContextInjection(opts: {
  alreadyInjected?: boolean
  lastInjectedKey?: string | null
  injectionKey?: string | null
  channel?: string
  userTextOrBlocks: unknown
  hasProviderResumeId?: boolean
}): boolean {
  if (opts.channel !== 'webchat') return false
  if (typeof opts.userTextOrBlocks !== 'string') return false
  if (opts.injectionKey) return opts.lastInjectedKey !== opts.injectionKey
  return !opts.alreadyInjected && !opts.hasProviderResumeId
}

export function shouldEmitContextRebuilt(opts: {
  historyMode: 'native-resume' | 'stateless-replay'
  reason?: AgentSession['_contextRebuildNotice']
}): boolean {
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
function isBoxActiveTurn(engineId?: string, modelId?: string): boolean {
  return engineId === 'ccb' && isBoxApiModel(modelId)
}

export function pickTurnSilentBackstopMs(engineId?: string, modelId?: string): number {
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
  if (!opts.userId || !opts.assistantText) return
  void collectSessionOutputAssets({
    userId: opts.userId,
    sessionId: opts.sessionId,
    assistantText: opts.assistantText,
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

// 一个 sessionKey 对应一个 EngineAdapter(CCB = CcbAdapter 组合 SubprocessRunner)
// + 一把 Mutex(同 session 串行)。跨 session 完全并行。
export interface AgentSession {
  /** In-memory execution identity only. Durable session/owner fields are untouched. */
  _identityCreationOpts?: Omit<
    Parameters<SessionManager['getOrCreate']>[0],
    'promptQueueExecutionFence' | 'modelSwitchId'
  >
  _identityAgentFingerprint?: string
  _identityCompat?: IdentityCompatRuntimeContext

  sessionKey: string
  agentId: string
  channel: string
  peerId: string
  /**
   * The authenticated userId that owns the client_sessions row this
   * AgentSession writes to. Set by the first `getOrCreate({ userId })`
   * call (webchat: from the WS auth JWT; other channels usually 'default').
   * Used by the Phase 0.2/0.4 durable-append path so we can persist
   * server-authored assistant text even when the client_sessions row
   * hasn't been upserted yet (first-turn race). `undefined` means we
   * never had a userId (cron-style pre-warm or legacy code path); callers
   * fall back to the old `getClientSession` lookup in that case.
   */
  userId?: string
  /**
   * Repo/workspace lookup key used by runner getRepoSnapshot(). Delegate
   * sessions keep their real peerId for identity, but inherit the originating
   * webchat peerId here so nested delegate_task calls stay in the same repo.
   */
  repoSessionId?: string
  /** Server-persisted default cwd policy. Delegates inherit their root web
   * session's value so the whole task tree shares one isolated directory. */
  workspaceMode: SessionWorkspaceMode
  /**
   * Exact cwd handed to the engine adapter as `agentBaseDir` (pinned
   * `agent.cwd`, or `resolveDefaultWorkspaceCwd`). Cursor chat-store hashes
   * are keyed by this path after the repo-snapshot overlay and realpath, so
   * stale-resume detection must read it back instead of recomputing.
   *
   * Bound chat sessions pass the project workspace here. A ready session-repo
   * overlay is applied later in adapters via decideEngineCwd (allowed).
   */
  workspaceCwd: string
  /** tb_project.id when this session is bound to a work project. null = unbound. */
  projectId?: string | null
  /** projectId + contextVersion + assetsRevision + manifest hashes. */
  contextFingerprint?: string
  /**
   * Chat project the running turn resolved at its start (server.ts); its
   * output assets are registered there. Set by submit() under the turn lock,
   * so a queued next message cannot replace it mid-turn. undefined = not
   * resolved (flag off): the master infers.
   */
  turnChatProjectId?: string | null
  runContext?: import('./runContextPersist.js').RunContextDescriptor
  frozenProjectContext?: import('@openclaude/storage').FrozenProjectContext | null
  /**
   * 直接父会话键。仅 delegate 子会话在创建时物化(handleDelegateTask 传入已校验的
   * 直接父 sessionKey);webchat 根会话为 undefined。用于委派进度**沿父链向上追溯**到
   * 最近的 webchat 祖先(resolveDelegateProgressRouting)——把二级+嵌套委派的进度路由
   * 回用户可见的一级委派卡。只增不改的父指针,使会话委派图可导航。
   */
  parentSessionKey?: string
  /**
   * 本(delegate)会话进度卡的 runId(handleDelegateTask 生成后回填)。嵌套子委派沿父链
   * 追溯到**一级**委派会话后复用其该值作为进度帧 runId,从而把嵌套进度 append 到同一张
   * 一级委派卡。webchat / 普通会话为 undefined。
   */
  progressRunId?: string
  title: string
  startedAt: number
  /** M0 engine 适配层:底座差异收口在 EngineAdapter(CCB = CcbAdapter 组合
   *  SubprocessRunner)。字段名保留 `runner` —— server.ts 等引用面零扩散。 */
  runner: EngineAdapter
  ccbSessionId: string | null
  /**
   * P2 债A — 本 turn 内已完成的委派(团队卡)server-authored durable 缓冲。
   *
   * 委派跑在**独立子会话**,但 agent-group 卡属于**本(队长)会话/turn**:
   * handleDelegateTask 收尾时经 `bufferPendingAgentGroup` 按父 sessionKey 推入
   * 这里。turn 收尾(persistServerAuthoredTurn 调用点)drain 本数组并清空,
   * 随同一 POST 下发给 master 落库为 role 'agent-group' 行。
   *
   * OCV5-180 B1 — 缓冲改为 exact-owner 准入:每条 entry 记录冻结的 owner
   * turnKey(启动时定位);只有**仍处于打开状态的本 owner turn** 可入内存缓冲,
   * owner turn 已 seal(drain 同步临界段封口)后一律走持久晚到通路
   * (`deliverLateDelegateAgentGroup`),不再跨时段滞留内存数组。
   *
   * 只在 webchat 队长会话上累积(buffering 走 progressTarget,webchat-only,与
   * MASTER_SINK_PERSIST_CHANNELS 一致)。嵌套 delegate 的完整 transcript 先写入
   * 直接父 delegate 的 `_durableDelegateTranscript`,最终随一级团队卡一起入本缓冲。
   */
  _pendingAgentGroups?: PendingAgentGroupEntry[]
  /** Turn-wide monotonic sequence shared by engine output and delegation cards. */
  _nextDurableEventOrdinal?: number
  /**
   * Remaining spendable credits (fen) for the in-flight turn, injected by
   * master at admission. Engine-reported adapters abort once running cost
   * reaches this budget.
   */
  _turnCreditBudgetFen?: bigint
  /** Active turn's fail-safe tape finalizer. The outer liveness watchdog uses
   * this instead of emitting an unpersisted error and abandoning the parser. */
  _persistActiveTurn?: (
    status: 'interrupted' | 'crashed',
    reason: string,
    errorCode: string,
    waiveReason?: TurnWaiveReason,
  ) => Promise<void>
  /** Root user-visible turn that owns this delegate session's billed work.
   * Every nested delegate inherits the same key instead of re-parenting cost
   * to an ephemeral delegate turn that is never persisted as a chat tape. */
  _billingParentTurnKey?: string
  /** Trusted session-scoped billing attribution copied from getOrCreate().
   * CCB consumes the same tag through its process environment; Codex needs it
   * on each EngineTurn so the engine-reported billing frame can preserve the
   * delegate parent locator as well. */
  _usageAttribution?: UsageAttributionTag
  /** Live, uncapped collector for a delegate session's complete transcript.
   * Nested delegates append their full transcript here in execution order so
   * the first-level durable team card survives reload with every descendant. */
  _durableDelegateTranscript?: unknown[]
  /** Complete raw event stream for this one-shot delegate turn. The delegate
   * channel is not persisted as its own chat session, so handleDelegateTask
   * moves this collector into the parent DurableAgentGroup. */
  _durableDelegateRuntimeEvents?: DurableRuntimeEvent[]
  /** A1 — post-terminal bash_output_tail 折叠状态(per session,懒建)。键 =
   *  `${ownerTurnKey}\0${parentToolUseId}\0${toolUseId}`。见
   *  SessionManager._foldPostTerminalTail:把 CCB bg bash 在 turn 终态后每秒不变的
   *  tail 洪泛压成"内容变化才落 / 5s 限频 / 每流 24 条 + 每 turn 64 条封顶"。
   *  session 销毁时 flush pending 后清空(见 _flushTailFolding)。 */
  _tailFoldStreams?: Map<string, TailFoldStreamState>
  /** A1 — 折叠抑制计数(会话销毁时汇总 log 一次,不引入新监控机制)。 */
  _tailFoldMetrics?: { unchangedSuppressed: number; rateCoalesced: number; capped: number }
  /** A1 — 折叠 tail 与非折叠 post-terminal 事件共享的 **per-session** 串行持久化链。
   *  定时器 flush 与事件回调都经它串行化,杜绝并发双 flush;含义即原 per-turn
   *  postTerminalRuntimeChain 提升到 session 维度。 */
  _postTerminalRuntimeChain?: Promise<void>
  /** A2 — 正在等 master ACK 时新到的 tail 先进队列,下一次用一个
   *  continuation tape 批量持久化。避免长任务终态后串行等 64 次
   *  network/finalize ACK,同时仍保持“先持久化、后转发”。 */
  _postTerminalTailQueue?: TailPersistQueueItem[]
  _postTerminalTailWorkerScheduled?: boolean
  /** Complete engine-reported billing frames for this delegate subtree.
   * handleDelegateTask moves them into the parent DurableAgentGroup. */
  _durableDelegateEngineBillings?: EngineBillingEvent[]
  /** Platform-authoritative goal captured under this session's lock. It is
   * immutable for the complete logical turn, including retries. */
  _platformGoal?: GoalStateSnapshot | null
  /** Delegate-subtree usage records rolled up without aggregation. */
  _durableDelegateGoalUsageRecords?: DurableGoalUsageRecord[]
  lock: Promise<void>
  lastUsedAt: number
  // 跨 turn 累积
  totalCostUSD: number
  /** Monotonic: any estimated/unpriced turn makes the resumed aggregate imprecise. */
  costImprecise?: boolean
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  turns: number
  // CCB 报告的进程累计 cost（getTotalCost()）的上一次取值。
  // _handleResult 里用来算 per-turn cost = cumulative - _lastCcbCumulativeCost。
  // CCB 子进程重启时会被重置为 0,parser 通过 cumulative<prev 检测到,
  // 把新的 cumulative 直接当作本轮 cost。
  _lastCcbCumulativeCost: number
  // 跨 turn 的 tool_use id → name 映射(用于 tool_result 关联)
  toolUseIdToName: Map<string, string>
  // 当前 turn 的文本累积器(用于 FTS5 索引)
  currentUserText?: string
  currentAssistantBuf?: string
  /** Per-turn efficiency linter state (tool_use_detected hook). */
  _efficiencyTurn?: import('./agentEfficiencyGuard.js').TurnGuardState
  _efficiencyPendingHits?: import('./agentEfficiencyGuard.js').LintHit[]
  _efficiencyBudget?: import('./agentEfficiencyGuard.js').VerificationBudget
  // Model name for cost attribution
  model?: string
  /** Native-compaction transition fences every old-model submit until the
   * exact target model + generation consumes the prepared handoff. */
  _modelSwitchTransition?: {
    id: string
    sourceModel: string
    targetModel: string
    sourceEngine: string
    state: 'preparing' | 'prepared' | 'consuming'
    summaryText?: string
    summaryInjected?: boolean
    expiresAt?: number
  }
  _lastNativeCompactionSummary?: string
  /** Signed context owner for the turn that currently holds session.lock. */
  _boxContextOwner?: string
  /** Set while the lock-held idle path is inside runner.submitTurn. */
  _idleRunning?: boolean
  /** OCV5-297: internal idle compact turns currently using the runner. Not a
   * client turn and not _activeTurnCount (prompt-queue admission asserts that
   * one); lifecycle gates (recycle drain, model switch, preheat) read it. */
  _idleInternalTurns?: number
  // CCB CronCreate bridge: maps tool_use_id/content_key → gateway cron job ID
  _cronBridgeMap?: Map<string, string>
  /** Set by onFinish when the CCB result row signals a stale --resume session
   *  id (file no longer exists). Read by the runner.exit handler to evict the
   *  sessionKey's resume-map entry instead of re-persisting it. See
   *  ccbMessageParser.ts TurnResult.staleResumeId. */
  _pendingStaleResumeClear?: boolean
  /**
   * 当前执行目标(local = 容器内本地,remote = ssh ControlMaster 到远程机)。
   * 默认 { kind:'local' }。切换走 `SessionManager.setExecutionTarget`,整个
   * swap 过程受 `lock` 保护,保证 in-flight turn 看到的是一个一致的 target。
   */
  executionTarget: ExecutionTarget
  /**
   * Phase 5 G.0 → M1a 泛化:本 session 的 **engine id**('ccb' / 'codex',
   * = getOrCreate 时 resolveEngine 的固化结果;字段名保留 providerTag 以免
   * 引用面扩散)。resume-map 按此维度隔离(防 codex thread_id 与 CCB
   * session_id 互喂),recyclePeerForRepoChange / pickIdleTimeoutMs 用它走
   * codex 专属分支(避免 instanceof,见 Plan v3 G.0)。
   */
  providerTag: string
  /**
   * Phase 5 G.0:agent.provider 原始值('claude-subscription' /
   *  'codex-native' / 'minimax' 等)。诊断日志用,辅助排查 recycle 行为
   *  与 provider 路由是否对齐;不参与判断逻辑(判断逻辑用 providerTag)。
   *  agents.yaml 允许 provider 字段缺省,所以这里也允许 undefined。
   */
  agentProvider?: string
  /** Set after we prepend persisted chat history to the first provider-switch
   *  turn. Prevents re-sending the whole transcript on every follow-up. */
  _historicalContextInjected?: boolean
  /** Stable key for the last master-history transcript preamble injected.
   *  Lets Codex native receive newly-produced DeepSeek/CCB turns after the
   *  user switches away and later returns to GPT, while avoiding a repeated
   *  full transcript on ordinary same-provider follow-ups. */
  _historicalContextInjectedKey?: string
  /** User-visible rebuild notices are exceptional. Cursor uses native-resume;
   * set this for an engine switch or a lost native id so the fallback replay
   * can announce a rebuild. Do not set it on a successful native resume. */
  _contextRebuildNotice?: 'engine-switch' | 'native-resume-loss'
  /** A same-engine resume-map entry existed, but the newly selected transport
   * cannot consume it (for example Cursor Sand CCB -> official CC). Preheat may
   * mint a fresh native id before the first real turn; that empty id must not
   * suppress bounded history reconstruction. */
  _forceHistoricalContextOnFirstTurn?: boolean
  /**
   * getOrCreate 跨 engine / workspace 替换期间置位:旧 session 在 runner.shutdown()
   * 完成前仍留在 sessions map。无票 inbound 取样到此标记则不得沿用其 model。
   */
  _replacing?: boolean
  /**
   * Set immediately before a platform-initiated runner.shutdown()
   * (deploy shutdownAll / destroySession / retireKeepResume / LRU).
   * handleExit/handleError then persist SERVICE_RESTART (yellow/waived)
   * instead of RUNNER_CRASHED (red). Unexpected crashes leave this unset.
   */
  _plannedTeardown?: 'service_restart'
  /** Platform-executed exchanges not yet observed in master history. A
   * transient master-sink failure can durably queue the assistant row while
   * the very next user turn arrives first; this session-local tail keeps that
   * paid result in the rebuilt provider context until master acknowledges it. */
  _pendingExternalExchanges?: PendingExternalExchange[]
  /**
   * 当前 turn 的 backend-side 非流式阶段状态。
   *
   * 非 null 值有两类:`'compacting'`(CCB auto/manual compact 期间走单独 LLM
   * 调用,这段时间不产生 assistant token)与 `{status:'retrying', retry}`
   * (codex 自动重试等待期)。两者都是"turn 仍在工作但暂无 token"的阶段态,
   * 前端如果只看流量会以为卡死。server.ts 在收到 `kind:'turn_status'` 事件时
   * 更新此 cache 并 deliver 帧;turn 终态(final/error)清回 null。
   * autoResumeFromHello 在 ring replay 之后,如果 runner 仍在跑且 cache 非空,
   * 补发一帧给重连的客户端(兜底 ring eviction 导致原阶段帧已被冲掉的情况;
   * retrying 补发时按缓存的 retry.retryAt 让前端重算剩余倒计时)。
   *
   * 不持久化、不跨进程 —— gateway 重启后默认 null(下次阶段帧自然把它推回对应
   * 状态,不依赖任何持久状态)。
   */
  currentTurnStatus?: GatewayTurnPhase
  /**
   * Active turn count — number of in-flight `submit()` promises for this session.
   *
   * 进入 `submit()` 后(`session.lock` 新建那一刻)++,**`submit()` promise
   * settled**(即 try/finally 走到 finally,无论正常 return 还是 throw)前 --。
   * 故意覆盖比 runner 进程生命周期更宽的语义:
   *   - `await prev` 等队列中前一个 turn,counter 已计入(用户视角已"按了发送")
   *   - effort/model swap 期间 `runner.shutdown()` 后窗口(proc 已死,turn 还在)
   *   - phantom-turn / auth-refresh retry 内的 shutdown + respawn 窗口
   *   - liveness timeout race 抛错时 — 直到上层 catch 完才 --
   * 所有这些都在 `submit()` try/finally 内,counter 不归零。
   *
   * **这是 turn-level 的 inFlight 真值源**,优于 `runner.isRunning`(进程级,
   * 由 `subprocessRunner.ts: proc!==null && !closed || starting` 定义,turn 内
   * subprocess respawn 窗口会短暂 false)。`autoResumeFromHello` 用它决定是否
   * 推 synthetic turn-interrupted isFinal:counter > 0 意味着 turn 还活着,
   * 绝不应该误推终结帧让前端清状态。
   *
   * 用 counter 而非 boolean:虽然同 session `session.lock` 串行,理论上最多
   * 一个真正执行的 turn,但"in-flight submit 数"包含排队在 `await prev`
   * 后面的 submit。counter 对未来重叠/重入路径鲁棒,且 `Math.max(0, n - 1)`
   * 避免双 finally 或字段缺失导致负数;boolean 会被第二个 submit 的 finally
   * 错误清掉第一个的 active 状态。
   *
   * 不持久化、不跨进程 — gateway 重启后默认 undefined → 读 `?? 0`,下一次
   * `submit()` 自然恢复。Optional 让历史内存对象 / 测试 fake / 其它 provider
   * 注入的 session 不被 TS 波及。
   */
  _activeTurnCount?: number

  /** team-durability(2026-07-07)— **客户 turn** 级 in-flight 计数,scope 比
   * `_activeTurnCount`(engine submit 级)更宽:由 server.ts dispatchInbound 在
   * 首次 submit 前 ++、整个 turn 编排(含 hidden-reviewer 硬编排的 review 委派 +
   * continuation 再 submit)收尾的 finally 里 --。修的洞:团队模式下 engine turn
   * 完成(_activeTurnCount 归零)后 gateway 编排还要跑数分钟审查,期间 hello 重连
   * 若只看 engine 计数会误判"turn 已结束"。判定 turn 是否在飞必须两个计数都看
   * (`_shouldPushTurnInterruptedFinal`)。语义细节同 `_activeTurnCount`:counter
   * 而非 boolean、不持久化、重启后 undefined 读 ?? 0。 */
  _activeClientTurnCount?: number
  /** Abort controller for a platform-executed external turn (Image 2). */
  _externalTurnAbort?: AbortController

  /** team-durability — 最近一次客户 turn 的收尾方式(dispatchInbound finally 记录)。
   * hello 重连对账用:客户端报 inFlight 而两个 turn 计数均为 0 时,'completed' →
   * 推静默 reconcile final(turn 已正常完成,客户端只是错过了终态帧,不该提示
   * "被中断请重发"——那会诱导用户重发重付费);'errored'/undefined → 维持原
   * service_restart 中断文案语义。 */
  _lastClientTurnOutcome?: 'completed' | 'errored'

  /** 队长自主送审(2026-07-07)— 本 turn 是否为团队模式队长回合(dispatchInbound 每
   *  turn 刷新)。_runDelegateTask 的审查门读它:目标为隐藏审查员的委派仅在 true 时放行。 */
  _teamModeTurn?: boolean
  /** Frozen collaboration mode for this inbound turn (main only). */
  _collabModeTurn?: 'solo' | 'advisor' | 'team'
  _advisorTurn?: { advisorModel: string; configVersion: string }

  /** 本 turn 入站用户文本的服务端权威快照(≤8000 字,dispatchInbound 每 turn 刷新)。
   *  审查任务书(buildTeamReviewContext)的"用户原始需求"取此,不采信模型自报。 */
  _currentTurnUserText?: string
  /** Prefix actually prepended to this turn after stripping advisor tool preamble. */
  _injectedTurnConstraints?: string
  /** 本 turn 的 master canonical traceId(submit 每 turn 刷新,含 undefined 清除残留)。
   *  市场使用信号(skillUsageReporter)在 tool.called(hub skill_view)派发时经
   *  SessionManager.getByKey 同步读取,作为评分归因键。单一铸造权威在 master,此处只
   *  中转 submit 已确定的 turnTraceId,不参与铸造。engine 中立(runner.traceId 是 CCB/
   *  codex 私有、不在 EngineAdapter 契约上,故落到 session 提供统一读点)。 */
  _currentTurnTraceId?: string
  /** Stable logical turn key used by lossless persistence and cost joins. */
  _currentTurnKey?: string
  /** Turn index of the turn that owns `_currentTurnKey` (seeded together at
   * turn start). OCV5-180 B1 — exact-owner delegate cards freeze this so a
   * late completion lands as a continuation of the same turn number. */
  _currentTurnIndex?: number
  /** OCV5-180 B1 — owner turns whose turn-end payload is already frozen
   * (drain ran in the same synchronous critical section). A delegate group
   * arriving after its owner key is sealed must go to the persistent late
   * path, never back into `_pendingAgentGroups`. Bounded LRU. */
  _sealedOwnerTurnKeys?: Map<string, number>
  /** OCV5-180 B1 — runId → identity for groups that already rode the root
   * tape (acked/queued drain). Lives on the owner session next to the sealed
   * turn keys so FIFO eviction of `_exactOwnerRuns` cannot forget a frozen
   * root payload. Bounded by the sealed-turn cap. */
  _ackedExactOwnerRuns?: Map<string, Map<string, string>>
  /** Browser user-row id bound to the submit that currently owns session.lock.
   * Unlike _activeTurnCount, this never describes queued submits. */
  _runningClientMessageId?: string
  /** Browser user-row id of the inbound currently inside dispatchInbound
   * after getOrCreate and before that function's outer finally. Covers the
   * mkdir/writeFile/parseDocument window where turn counters are still 0. */
  _admittingClientMessageId?: string

  /** RFC-v5-durable-turn-dispatch §4 — per-session recent-terminal ring
   * (cap 8: clientMessageId → outcome). autoResumeFromHello 用 hello 携带的
   * inFlightClientMessageId 精确对账:命中 completed → turn_completed reconcile
   * 帧带 id;命中中断类 → interrupted 帧带 id;未知 → turn_state_unknown。
   * 非持久化(重启后空 → 未知身份 → forceSync,不冒充终态)。 */
  _recentTerminalRing?: Array<{
    clientMessageId: string
    outcome: 'completed' | 'interrupted' | 'crashed'
  }>

  /** RFC-v5-durable-turn-dispatch §3 — 本 turn 的 durable inbox 准入身份
   * (server.ts dispatchInbound 从验签 descriptor 取出并在 submit 前挂上)。
   * runOneTurnWithRetry 用它在**模型调用前**落 inbox running;turn-end 持久化
   * 用它把 dispatchId/attemptNo 带进 tape payload,ACK 回调据此驱动 terminal。
   * 仅 webchat-DM durable turn 有;legacy/本地路径恒 undefined。 */
  _currentDispatch?: {
    userId: string
    sessionId: string
    clientMessageId: string
    dispatchId: string
    attemptNo: number
  }
}

/** RFC-v5-durable-turn-dispatch §4 — recent-terminal ring 容量。 */
const RECENT_TERMINAL_RING_CAP = 8

/** OCV5-180 B1 — `_pendingAgentGroups` 元素:完成的团队卡 + 冻结的 exact
 * owner turnKey(launch 时定位)。ownerTurnKey 缺省 = 旧调用方语义(随当前
 * turn drain,不参与 seal 判定),仅存量测试路径使用。 */
interface PendingAgentGroupEntry {
  group: DurableAgentGroup
  ownerTurnKey?: string
}

/** OCV5-180 B1 — `_sealedOwnerTurnKeys` 有界 LRU 容量。 */
const SEALED_OWNER_TURN_KEYS_CAP = 32

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

const PREHEAT_DEADLINE_CODE = 'PREHEAT_DEADLINE'

function withPreheatDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`engine preheat exceeded ${ms}ms deadline`)
      ;(err as Error & { code: string }).code = PREHEAT_DEADLINE_CODE
      reject(err)
    }, ms)
    timer.unref?.()
  })
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function isPreheatDeadline(err: unknown): boolean {
  return Boolean(
    err && typeof err === 'object' && (err as { code?: string }).code === PREHEAT_DEADLINE_CODE,
  )
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
type TapePersistResult = 'acked' | 'queued' | 'dropped' | 'skipped'

/** OCV5-180 B1 — shared exact-owner logical-run record. `inflight` is not
 * durable: a dropped (non-queued) persist must delete it so the same frozen
 * payload can retry. `queued`/`acked` are durable; `session_deleted` is
 * terminal and must not resurrect. */
type ExactOwnerRunState = 'buffered' | 'inflight' | 'queued' | 'acked' | 'session_deleted'

interface ExactOwnerRunRecord {
  identity: string
  state: ExactOwnerRunState
}

/** server-authored turn 持久化三态(见 TapePersistResult):把 V3MasterSink /
 *  legacy 本地写的结果收敛成 acked|queued|dropped 的单一权威分类。 */
export function persistServerAuthoredTurnOutcome(args: {
  sessionKey: string
  peerId: string
  /** AgentSession.agentId — the agent that produced this turn (e.g. 'main',
   *  'codex', 'minimax2.7'). Folded into the persisted messageId so a chat
   *  that switches model mid-conversation doesn't collide on
   *  `srv-${peerId}-t1` (each AgentSession tracks its own `session.turns`
   *  starting at 0, so without this disambiguator turn 1 of codex and turn
   *  1 of main both stamp t1 and the client merges them — root cause of
   *  the 2026-05-13 "switched to deepseek, only thinking visible" bug).
   *  Required: every live caller is inside SessionManager and holds a
   *  populated `session.agentId`. */
  agentId: string
  /** From AgentSession.userId. Undefined on legacy/cron-pre-warm paths.
   *  Ignored on the v3 sink path (master derives it from identity). */
  userId: string | undefined
  turnIndex: number
  /** Exact browser user row that originated this webchat turn. Optional for
   * cron/legacy/retry-queue compatibility; materialized server rows carry it
   * as `_clientMessageId` for exact client reconciliation. */
  clientMessageId?: string
  turnKey?: string
  waiveReason?: TurnWaiveReason
  continuationOfTurnKey?: string
  /** RFC-v5-durable-turn-dispatch §3 — durable inbox 准入身份。仅本 turn 的**主
   *  tape**携带(continuation tape 恒不带);随 tape payload 入 hash,master ACK
   *  据此驱动 inbox row → terminal。 */
  dispatch?: { dispatchId: string; attemptNo: number }
  createdAt?: number
  text: string
  /** Optional full reasoning/thinking text for the same turn. Persisted as a
   *  separate `_source: 'server'` message with `role: 'thinking'`,
   *  ts = assistantTs - 1. v3 sink path: passed through to master in the
   *  same POST body; master writes both rows in two storage calls.
   *  Legacy/personal path: thinking is best-effort (its write is wrapped
   *  in try/catch, failures don't block the assistant write). */
  thinkingText?: string
  status: 'completed' | 'interrupted' | 'crashed'
  /** Plan §4.4 改动 7 — server-owned requestId (commercial proxy emits via
   *  `x-openclaude-request-id`; sessionManager forwards verbatim). v3 sink
   *  path requires this for assistant writes (master schema refine).
   *  Legacy / personal path ignores it. */
  requestId?: string
  /** CCB agent session id(= runner.sessionId,与 anthropicProxy 从 LLM
   *  metadata.session_id 提取的一致)。v3 sink 透传给 master,使 ccb 助手落库时按
   *  session 精确排空 pending costCredits(per-turn 精确,消除 by-user 跨会话归并)。
   *  Legacy/personal path 忽略。 */
  agentSessionId?: string
  goalId?: string
  goalStateRevision?: number
  /** Plan §4.4 改动 7 — token usage gathered at message_stop. Wire-only on
   *  the v3 sink path; legacy persists usage via the
   *  `outputs/usage_log` table separately. */
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    totalTokens?: number
    model?: string
    turn?: number
    /** Master-owned per-turn canonical traceId (see V3MasterSinkWirePayload).
     *  Folded into messages[i].usage.traceId for the web UI's copyable
     *  "请求ID" + refresh-stable log correlation. */
    traceId?: string
  }
  /** Plan §4.4 改动 7 — refresh-stable status pills. */
  truncated?: boolean
  errorCode?: string
  errorDetail?: string
  /** Top-level tool calls completed during this turn, captured by
   *  CcbMessageParser. v3 sink path: master writes each as a server-authored
   *  'tool' message so the durable copy survives refresh. Legacy/personal
   *  path ignores this field — local SQLite preserves client-authored tool
   *  rows already (no overwrite happens locally). */
  tools?: TurnToolEntry[]
  /** Fix B (2026-05-25) — per-text-segment durable rows. When non-empty,
   *  v3 sink path forwards to master which writes one assistant row per
   *  segment (`srv-...-tN-s${idx}`). Legacy/personal path keeps single-row
   *  behavior (only the live stream gets segment ids; refresh-recovery on
   *  personal version stays single-row). Plan §3.5.1. */
  assistantSegments?: SegmentRecord[]
  /** Fix B (2026-05-25) — same per-segment treatment for thinking rows. */
  thinkingSegments?: SegmentRecord[]
  /** P2 债A — completed delegations (team cards) for this turn, drained from
   *  the leader session's `_pendingAgentGroups` buffer. v3 sink path forwards
   *  to master which writes each as a server-authored `role: 'agent-group'`
   *  row. Legacy/personal path ignores it (team cards are client-owned there;
   *  no container→master sink). */
  agentGroups?: DurableAgentGroup[]
  /** Exact plan/goal block update stream emitted by the main agent. */
  structuredBlocks?: Array<Record<string, unknown>>
  runtimeEvents?: DurableRuntimeEvent[]
  /** Final usage from an engine-reported billing adapter (Codex). It is
   * co-located with the immutable turn tape so a bridge disconnect or
   * bounded outbound-ring eviction cannot erase the only settle evidence. */
  engineBilling?: EngineBillingEvent
  /** OCV5-180 B1 — fatal drop reason (stageDurable throw / 410 session_deleted). */
  onDroppedReason?: (reason: string) => void
}): Promise<TapePersistResult> {
  const sink = getV3MasterSinkOrNull()
  if (sink) {
    const payload: V3MasterSinkPayload = {
      sessionId: args.peerId,
      agentId: args.agentId,
      turnIndex: args.turnIndex,
      ...(args.clientMessageId ? { clientMessageId: args.clientMessageId } : {}),
      ...(args.turnKey ? { turnKey: args.turnKey } : {}),
      ...(args.waiveReason ? { waiveReason: args.waiveReason } : {}),
      ...(args.continuationOfTurnKey ? { continuationOfTurnKey: args.continuationOfTurnKey } : {}),
      // durable dispatch identity 只挂主 tape：continuation tape(post-terminal
      // Bash tail)绝不携带,避免非主内容触发 inbox terminal / 污染 dispatch 归属。
      ...(args.dispatch && !args.continuationOfTurnKey
        ? { dispatchId: args.dispatch.dispatchId, attemptNo: args.dispatch.attemptNo }
        : {}),
      status: args.status,
      text: args.text,
      ...(args.thinkingText && args.thinkingText.length > 0
        ? { thinkingText: args.thinkingText }
        : {}),
      createdAt: args.createdAt ?? Date.now(),
      // Plan §4.4 改动 7 — propagate requestId/usage/truncated/errorCode/
      // errorDetail to master. Master schema treats requestId as required
      // when text is non-empty (assistant write), optional otherwise
      // (thinking-only). Caller is responsible for supplying requestId on
      // the assistant path; we don't synthesize one here.
      ...(args.requestId !== undefined ? { requestId: args.requestId } : {}),
      ...(args.agentSessionId !== undefined ? { agentSessionId: args.agentSessionId } : {}),
      ...(args.goalId !== undefined ? { goalId: args.goalId } : {}),
      ...(args.goalStateRevision !== undefined
        ? { goalStateRevision: args.goalStateRevision }
        : {}),
      ...(args.usage !== undefined ? { usage: args.usage } : {}),
      ...(args.truncated ? { truncated: true } : {}),
      ...(args.errorCode !== undefined ? { errorCode: args.errorCode } : {}),
      ...(args.errorDetail !== undefined ? { errorDetail: args.errorDetail } : {}),
      ...(args.tools && args.tools.length > 0 ? { tools: args.tools } : {}),
      // Fix B (2026-05-25) — per-segment rows. Forward when non-empty;
      // master detects presence and writes one row per segment. Plan §3.5.1.
      ...(args.assistantSegments && args.assistantSegments.length > 0
        ? { assistantSegments: args.assistantSegments }
        : {}),
      ...(args.thinkingSegments && args.thinkingSegments.length > 0
        ? { thinkingSegments: args.thinkingSegments }
        : {}),
      // P2 债A — team cards. Forward when non-empty; master writes one
      // server-authored `role: 'agent-group'` row per delegation.
      ...(args.agentGroups && args.agentGroups.length > 0 ? { agentGroups: args.agentGroups } : {}),
      ...(args.structuredBlocks && args.structuredBlocks.length > 0
        ? { structuredBlocks: args.structuredBlocks }
        : {}),
      ...(args.runtimeEvents && args.runtimeEvents.length > 0
        ? { runtimeEvents: args.runtimeEvents }
        : {}),
      ...(args.engineBilling !== undefined
        ? { engineBilling: structuredClone(args.engineBilling) }
        : {}),
    }
    return sink
      .persistOrQueue(payload)
      .then((outcome): TapePersistResult => {
        if (outcome.ok) return 'acked'
        if (outcome.queued) {
          // stageDurable 已 fsync,重试队列会送达 —— 可靠排队,等同成功(见
          // TapePersistResult 'queued')。Already info-logged inside the sink.
          return 'queued'
        }
        // dropped — fatal classification (410 会话已删 / 4xx schema/method).
        // Surface at warn so ops sees the contract violation but not as
        // an error spike (fatal here means we have a bug, not a runtime
        // glitch the system can recover from).
        log.warn('v3 sink dropped server-authored payload', {
          sessionKey: args.sessionKey,
          peerId: args.peerId,
          turnIndex: args.turnIndex,
          status: args.status,
          reason: outcome.droppedReason,
        })
        args.onDroppedReason?.(outcome.droppedReason)
        return 'dropped'
      })
      .catch((err): TapePersistResult => {
        // persistOrQueue 只在**重试队列 I/O 失败(stageDurable 抛,如 ENOSPC)**时 throw
        // —— 此时帧根本没落盘,是真正的丢弃,记 'dropped'(非 queued)。
        log.error(
          'v3 sink persistOrQueue threw',
          {
            sessionKey: args.sessionKey,
            peerId: args.peerId,
            turnIndex: args.turnIndex,
            status: args.status,
          },
          err,
        )
        args.onDroppedReason?.(err instanceof Error ? err.message : String(err))
        return 'dropped'
      })
  }
  if (isCommercialManagedRuntime()) {
    throw new Error('LOSSLESS_SINK_UNAVAILABLE: commercial turn tape sink is not initialized')
  }
  // Legacy / personal-version path — local SQLite is authoritative.
  //
  // agentId is folded into the messageId for the same reason as the v3 sink
  // path (see args.agentId doc): a personal-version chat that rotates across
  // agents mid-conversation would otherwise collide on `srv-${peerId}-t1`.
  // No backward-compat shim needed: historical rows in SQLite keep their
  // pre-Fix-A ids; new rows use the disambiguated format. Client/server
  // agree because the same formula stamps OutboundContentBlock.messageId
  // at the runOneTurnWithRetry mint site below.
  const messageId = `srv-${args.peerId}-${args.agentId}-t${args.turnIndex}`
  const thinkingMessageId = `srv-${args.peerId}-${args.agentId}-t${args.turnIndex}-thinking`
  const directWrite = async () => {
    // OCV5-94: only the owner is needed here; the timeline view is page-bounded
    // while the default exact view hydrates every turn tape of the session.
    const uid =
      args.userId ?? (await getClientSession(args.peerId, undefined, { view: 'timeline' }))?.userId
    if (!uid) return undefined // cron-style pre-UI, no owner — skip.
    const baseTs = Date.now()
    // Best-effort thinking write: doesn't block assistant. Failures are
    // logged at warn (not error) because thinking is auxiliary debug
    // content; losing it is degraded but acceptable. Assistant text is
    // first-class and gets the structured outer .then result handling.
    if (args.thinkingText && args.thinkingText.length > 0) {
      try {
        const r = await appendServerAuthoredMessageDurable(args.peerId, uid, {
          id: thinkingMessageId,
          role: 'thinking',
          text: args.thinkingText,
          ts: baseTs - 1,
          status: args.status,
        })
        if (r && !r.applied && r.reason !== 'already_exists') {
          log.warn('legacy thinking persist degraded', {
            sessionKey: args.sessionKey,
            peerId: args.peerId,
            turnIndex: args.turnIndex,
            reason: r.reason,
          })
        }
      } catch (err) {
        log.warn(
          'legacy thinking persist threw — continuing assistant',
          {
            sessionKey: args.sessionKey,
            peerId: args.peerId,
            turnIndex: args.turnIndex,
          },
          err,
        )
      }
    }
    if (args.text && args.text.length > 0) {
      return appendServerAuthoredMessageDurable(args.peerId, uid, {
        id: messageId,
        role: 'assistant',
        text: args.text,
        ts: baseTs,
        status: args.status,
      })
    }
    // thinking-only legacy turn — already logged inside the try/catch above.
    // Return undefined so outer .then's `if (!r) return` short-circuits.
    return undefined
  }
  return directWrite()
    .then((r): TapePersistResult => {
      // undefined = 没写任何东西(无 userId / thinking-only 空 text / runtimeEvents-only):
      // 未持久化但非失败 → 'skipped'(布尔层仍折 true,与改前 undefined→true 逐值一致)。
      if (!r) return 'skipped'
      if (r.applied) return 'acked'
      if (r.reason === 'already_exists') return 'acked'
      if (r.reason === 'queued_to_outbox') {
        // 'queued_to_outbox' is an expected degraded-mode outcome
        // (DB unavailable); the outbox replay loop delivers it — 可靠排队,
        // 等同成功(见 TapePersistResult 'queued')。log as warn not error.
        log.warn('server-authored message queued to outbox (DB unavailable)', {
          sessionKey: args.sessionKey,
          peerId: args.peerId,
          turnIndex: args.turnIndex,
          status: args.status,
          error: r.error,
        })
        return 'queued'
      }
      log.warn('server-authored message not persisted', {
        sessionKey: args.sessionKey,
        peerId: args.peerId,
        turnIndex: args.turnIndex,
        status: args.status,
        reason: r.reason,
      })
      return 'dropped'
    })
    .catch((err): TapePersistResult => {
      log.error(
        'appendServerAuthoredMessage failed',
        {
          sessionKey: args.sessionKey,
          peerId: args.peerId,
          turnIndex: args.turnIndex,
          status: args.status,
        },
        err as Error,
      )
      return 'dropped'
    })
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

function persistPostTerminalRuntimeEvents(args: {
  sessionKey: string
  sessionId: string
  turnIndex: number
  continuationOfTurnKey: string
  events: DurableRuntimeEvent[]
}): Promise<TapePersistResult> {
  if (args.events.length === 0) return Promise.resolve('skipped')
  const identity = createHash('sha256')
    .update('oc-post-terminal-runtime-batch-v1\0')
    .update(args.continuationOfTurnKey)
  for (const event of args.events) {
    const raw = JSON.stringify(event.payload)
    identity
      .update('\0')
      .update(String(event.ordinal))
      .update('\0')
      .update(String(event.observedAt))
      .update('\0')
      .update(event.source)
      .update('\0')
      .update(raw)
  }
  const identityHex = identity.digest('hex')
  // 三态透传:tail 折叠区分 acked|queued(可靠,更新 hash/count/转发)与 dropped
  // (不更新 → 冻结的 marker / 变化 tail 下次重试)。persistServerAuthoredTurnOutcome
  // 在 commercial-managed 缺 sink 时会 throw(配置异常),兜底折成 dropped。
  return persistServerAuthoredTurnOutcome({
    sessionKey: args.sessionKey,
    peerId: args.sessionId,
    agentId: `tail_${identityHex.slice(0, 24)}`,
    userId: undefined,
    turnIndex: args.turnIndex,
    turnKey: createHash('sha256')
      .update('oc-post-terminal-tape-batch-v1\0')
      .update(identityHex)
      .digest('hex'),
    continuationOfTurnKey: args.continuationOfTurnKey,
    createdAt: Math.min(...args.events.map((event) => event.observedAt)),
    text: '',
    status: 'completed',
    runtimeEvents: args.events.map((event) => structuredClone(event)),
  }).catch((err): TapePersistResult => {
    log.error('post-terminal runtime persist threw', { sessionKey: args.sessionKey }, err as Error)
    return 'dropped'
  })
}

/** OCV5-180 B1 — 把一张晚到的委派团队卡持久化为 owner turn 的受限
 * continuation tape(agentGroups-only 分支)。tape key 由 (ownerTurnKey, runId)
 * 推导:同一逻辑 run 永远命中同一 tape(master finalize 幂等 / 异内容 409);
 * root 暂不可达由 v3 sink 的 fsynced 重试队列表达('queued' ≠ 丢弃),不落纯内存 bucket。 */
function persistPostTerminalAgentGroup(args: {
  sessionKey: string
  owner: DelegateOwnerTurnLocator
  group: DurableAgentGroup
  onDroppedReason?: (reason: string) => void
}): Promise<TapePersistResult> {
  return persistServerAuthoredTurnOutcome({
    ...buildLateDelegateContinuationArgs({
      owner: args.owner,
      group: args.group,
      sessionKey: args.sessionKey,
    }),
    onDroppedReason: args.onDroppedReason,
  }).catch((err): TapePersistResult => {
    log.error(
      'post-terminal agent-group persist threw',
      { sessionKey: args.sessionKey, runId: args.group.runId },
      err as Error,
    )
    args.onDroppedReason?.(err instanceof Error ? err.message : String(err))
    return 'dropped'
  })
}

/** A1 — 单条待折叠/持久化的 post-terminal bash_output_tail。归属值(ownerTurnKey/
 *  ownerSessionId/turnIndex/onEvent)由发起 turn 的闭包捕获传入;因 tool_use_id 是
 *  流键的一部分、且一个 tool_use_id 只归一个 turn,同一 stream key 的这些值恒定。 */
interface TailFoldItem {
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
interface TailFoldStreamState {
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

interface TailPersistQueueItem {
  st: TailFoldStreamState
  item: TailFoldItem
}

type TailPersistOp =
  | { kind: 'real'; st: TailFoldStreamState; item: TailFoldItem; event: DurableRuntimeEvent }
  | {
      kind: 'stream_marker'
      st: TailFoldStreamState
      item: TailFoldItem
      event: DurableRuntimeEvent
    }
  | {
      kind: 'owner_marker'
      st: TailFoldStreamState
      item: TailFoldItem
      event: DurableRuntimeEvent
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

/** tail 内容指纹 = tail + total_bytes + truncated_head + tool_use_id +
 *  parent_tool_use_id。bg bash 每秒 emit 的不变 tail 指纹相同 → 折叠丢弃。 */
function tailContentHash(payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(typeof payload.tail === 'string' ? payload.tail : '')
    .update('\0')
    .update(String(typeof payload.total_bytes === 'number' ? payload.total_bytes : 0))
    .update('\0')
    .update(String(!!payload.truncated_head))
    .update('\0')
    .update(typeof payload.tool_use_id === 'string' ? payload.tool_use_id : '')
    .update('\0')
    .update(typeof payload.parent_tool_use_id === 'string' ? payload.parent_tool_use_id : '')
    .digest('hex')
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
  async recyclePeerForRepoChange(
    sessionId: string,
    newSnapshot: RepoSnapshot | null,
  ): Promise<void> {
    const sessionKey = this._sessionIdToKey.get(sessionId)
    if (!sessionKey) return
    const session = this.sessions.get(sessionKey)
    if (!session) return

    // Phase 5 G.1:codex-native 哪怕 runner.isRunning=false 也不能短路 —
    //   CodexRunner 是 per-turn `codex exec`,turn 结束后子进程退出(isRunning=false),
    //   但 runner 仍保留 threadId、session 仍保留 ccbSessionId、_resumeMap*
    //   仍含上一轮 thread id;repo 变了下一轮 turn 必须重置否则 codex 会 attach
    //   到旧 repo 对应的 thread,污染 LLM 上下文(Plan v3 Codex Round 3 BLOCKER)。
    //   CCB(SubprocessRunner)是 long-running:!isRunning ⇒ 进程已死,
    //   下次 submit() 会读最新 snapshot 起一个新 spawn,无需重置任何 in-memory 状态。
    const isCodex = session.providerTag === 'codex'
    if (!session.runner.isRunning && !isCodex) {
      return // 没活进程且非 codex,下次 submit 会自然读最新 snapshot
    }

    const binding = session.runner.getBoundRepoBinding()
    let shouldRecycle = false
    if (newSnapshot === null) {
      // null 走 unbind 路径,不该到这里;safety only
      shouldRecycle = binding !== null
    } else if (newSnapshot.status === 'ready') {
      shouldRecycle = !binding || binding.selectionVersion !== newSnapshot.selectionVersion
    } else {
      // cloning / failed / pending → 让 runner 继续在旧 binding(若有)dir 工作
      shouldRecycle = false
    }

    if (!shouldRecycle) return

    log.info('recycle-for-repo-change triggered', {
      sessionKey: session.sessionKey,
      sessionId,
      providerTag: session.providerTag,
      isRunning: session.runner.isRunning,
      bindingVersion: binding?.selectionVersion ?? null,
      newSnapshotVersion:
        newSnapshot && newSnapshot.status === 'ready' ? newSnapshot.selectionVersion : null,
    })

    // 串行化 recycle:与 submit() 互斥,避免本 turn 中途被打断
    const prev = session.lock
    let release!: () => void
    session.lock = new Promise<void>((r) => (release = r))
    try {
      await prev
      // Phase 5 G.2:codex-native 必须在 shutdown 之前清掉所有 thread / resume 残留。
      //   原因:CodexRunner 即便 isRunning=false 也会保留 in-memory threadId,
      //   且 _saveResumeMap 会从 live session.ccbSessionId 反推回 _resumeMap —
      //   只清 _resumeMap 不够,必须同时清 session.ccbSessionId + 调 runner.clearSessionId
      //   再 _saveResumeMap()。setExecutionTarget 已经是这套模式(Codex Round 2 BLOCKER)。
      if (isCodex) {
        this._resumeMap.delete(sessionKey)
        this._resumeMapTimestamps.delete(sessionKey)
        this._resumeMapProvider.delete(sessionKey)
        this._resumeMapLastCost.delete(sessionKey)
        this._resumeMapCostImprecise.delete(sessionKey)
        this._resumeMapHistory.delete(sessionKey)
        session.ccbSessionId = null
        session.runner.clearSessionId?.()
        this._saveResumeMap()
      }
      // shutdown 只在子进程实际存活时调;codex per-turn 在 turn 间 isRunning=false
      // 是常态,这里不应再 shutdown(否则 stop() 会试图 kill 一个不存在的 pid 浪费日志)。
      if (session.runner.isRunning) {
        try {
          await session.runner.shutdown()
        } catch (err) {
          log.warn(
            'recycle-for-repo-change shutdown failed',
            { sessionKey: session.sessionKey, sessionId },
            err,
          )
        }
      }
    } finally {
      release()
    }
  }

  /**
   * Phase 5:repo unbind(用户 DELETE selection / link revoke)时 recycle 该 session。
   * 调用前 caller(server.ts _handleSessionRepoUnbind)必须先 _repoWorkspace.unbind
   * (短锁内删 states[sessionId]),保证排队 submit 启动时 getRepoSnapshot 返 null。
   * 总是无条件 shutdown(若 isRunning):因为 unbind 后 addDir 必须切回 agentBaseDir。
   */
  async recyclePeerForRepoUnbind(sessionId: string): Promise<void> {
    const sessionKey = this._sessionIdToKey.get(sessionId)
    if (!sessionKey) return
    const session = this.sessions.get(sessionKey)
    if (!session) return
    if (!session.runner.isRunning) return

    const prev = session.lock
    let release!: () => void
    session.lock = new Promise<void>((r) => (release = r))
    try {
      await prev
      try {
        await session.runner.shutdown()
      } catch (err) {
        log.warn(
          'recycle-for-repo-unbind shutdown failed',
          { sessionKey: session.sessionKey, sessionId },
          err,
        )
      }
    } finally {
      release()
    }
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
    const boundedTtlMs = Number.isFinite(ttlMs)
      ? Math.min(30_000, Math.max(1_000, Math.floor(ttlMs)))
      : 10_000
    this._runtimeRecycleDrainUntil = Date.now() + boundedTtlMs
    if (this._runtimeRecycleDrainTimer) clearTimeout(this._runtimeRecycleDrainTimer)
    this._runtimeRecycleDrainTimer = setTimeout(
      () => this.releaseRuntimeRecycleDrain(),
      boundedTtlMs,
    )
    this._runtimeRecycleDrainTimer.unref?.()

    let activeTurns = 0
    for (const session of this.sessions.values()) {
      activeTurns += Math.max(0, session._activeTurnCount ?? 0)
      activeTurns += Math.max(0, session._activeClientTurnCount ?? 0)
      activeTurns += Math.max(0, session._idleInternalTurns ?? 0)
    }
    if (activeTurns > 0) this.releaseRuntimeRecycleDrain()
    return { accepted: activeTurns === 0, activeTurns }
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
    this._pendingPersistence.add(p)
    // Two-handler `.then` instead of `.finally` so a rejected `p`
    // doesn't propagate through the chain and trigger an
    // unhandledRejection. `persistServerAuthoredTurn` itself never
    // rejects (its catches absorb sink/storage errors into log lines),
    // but this is belt-and-braces — a future call site swapping in a
    // different awaitable shouldn't be able to crash the gateway.
    const cleanup = (): void => {
      this._pendingPersistence.delete(p)
    }
    p.then(cleanup, cleanup)
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
    const chain = (session._postTerminalRuntimeChain ?? Promise.resolve())
      .then(task)
      .catch((err) => {
        log.error(
          'post-terminal runtime persist failed',
          { sessionKey: session.sessionKey },
          err as Error,
        )
      })
    session._postTerminalRuntimeChain = chain
    this._trackPersistence(chain)
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
    const budget = this._getOwnerBudget(ownerTurnKey)
    const next = budget.chain
      .then(task)
      .catch((err) =>
        log.error('post-terminal tail owner-chain task failed', { ownerTurnKey }, err as Error),
      )
    budget.chain = next
    return next
  }

  /** F1b — 冻结的 capped marker 事件(ordinal/observedAt/payload 首次构造后不再变),
   *  保证 dropped 重试时 identity 稳定、master UPSERT 去重,绝不产生多条 marker。 */
  private _buildTailCapMarker(
    item: TailFoldItem,
    reason: 'cap' | 'owner_cap',
  ): DurableRuntimeEvent {
    return {
      ordinal: item.event.ordinal,
      observedAt: Date.now(),
      source: 'gateway',
      payload: {
        type: 'system',
        subtype: 'bash_output_tail_capped',
        tool_use_id: item.toolUseId,
        ...(item.parentToolUseId ? { parent_tool_use_id: item.parentToolUseId } : {}),
        suppressed_reason: reason,
      },
    }
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
    if (session._postTerminalTailWorkerScheduled) return
    session._postTerminalTailWorkerScheduled = true
    this._chainTailPersist(session, async () => {
      try {
        await this._drainTailPersistQueue(session)
      } finally {
        session._postTerminalTailWorkerScheduled = false
        // JS 同步段无竞态,但持久化 await 期间可能到新事件;
        // worker 退出前再补挂一次,不留无主队列。
        if ((session._postTerminalTailQueue?.length ?? 0) > 0) {
          this._scheduleTailPersistWorker(session)
        }
      }
    })
  }

  private async _drainTailPersistQueue(session: AgentSession): Promise<void> {
    const queue = (session._postTerminalTailQueue ??= [])
    while (queue.length > 0) {
      const first = queue.shift()!
      const batch = [first]
      let bytes = Buffer.byteLength(JSON.stringify(first.item.event), 'utf8')
      while (queue.length > 0 && batch.length < this._tailPersistBatchMaxEvents) {
        const next = queue[0]!
        // continuation tape 的 owner 必须唯一;遇到另一 owner 就先收当前批。
        if (next.item.ownerTurnKey !== first.item.ownerTurnKey) break
        const nextBytes = Buffer.byteLength(JSON.stringify(next.item.event), 'utf8')
        if (batch.length > 0 && bytes + nextBytes > this._tailPersistBatchMaxBytes) break
        queue.shift()
        batch.push(next)
        bytes += nextBytes
      }
      await this._runOnOwnerChain(first.item.ownerTurnKey, () =>
        this._persistTailBatch(session, batch),
      )
    }
  }

  private async _persistTailBatch(
    session: AgentSession,
    batch: TailPersistQueueItem[],
  ): Promise<void> {
    if (batch.length === 0) return
    const first = batch[0]!.item
    const owner = this._getOwnerBudget(first.ownerTurnKey)
    const metrics = (session._tailFoldMetrics ??= {
      unchangedSuppressed: 0,
      rateCoalesced: 0,
      capped: 0,
    })
    const ops: TailPersistOp[] = []
    const plannedHashes = new Map<TailFoldStreamState, string | null>()
    const plannedRealCounts = new Map<TailFoldStreamState, number>()
    let ownerRealCount = 0
    let ownerMarkerPlanned = false
    const streamMarkerPlanned = new Set<TailFoldStreamState>()
    // runtimeEvents-only 在 legacy/no-sink 路径会返回 skipped;它们按旧契约
    // 不占预算、不触发 cap。sink 存在时才做持久化预算规划。
    const enforcePersistentBudget = getV3MasterSinkOrNull() !== null

    for (const entry of batch) {
      const { st, item } = entry
      const currentHash = plannedHashes.has(st) ? plannedHashes.get(st)! : st.lastPersistedHash
      if (item.hash === currentHash) {
        metrics.unchangedSuppressed++
        continue
      }
      if (enforcePersistentBudget && (st.capped || owner.capped || ownerMarkerPlanned)) continue
      if (
        enforcePersistentBudget &&
        owner.persistedCount + ownerRealCount >= this._tailFoldOwnerCap
      ) {
        owner.markerEvent ??= this._buildTailCapMarker(item, 'owner_cap')
        ops.push({ kind: 'owner_marker', st, item, event: owner.markerEvent })
        ownerMarkerPlanned = true
        continue
      }
      const streamRealCount = plannedRealCounts.get(st) ?? 0
      if (
        enforcePersistentBudget &&
        st.persistedCount + streamRealCount >= this._tailFoldStreamCap
      ) {
        if (!streamMarkerPlanned.has(st)) {
          st.markerEvent ??= this._buildTailCapMarker(item, 'cap')
          ops.push({ kind: 'stream_marker', st, item, event: st.markerEvent })
          streamMarkerPlanned.add(st)
        }
        continue
      }
      ops.push({ kind: 'real', st, item, event: item.event })
      plannedHashes.set(st, item.hash)
      plannedRealCounts.set(st, streamRealCount + 1)
      ownerRealCount++
    }
    if (ops.length === 0) return

    const outcome = await persistPostTerminalRuntimeEvents({
      sessionKey: session.sessionKey,
      sessionId: first.ownerSessionId,
      turnIndex: first.turnIndex,
      continuationOfTurnKey: first.ownerTurnKey,
      events: ops.map((op) => op.event),
    })
    if (outcome === 'dropped') return

    for (const op of ops) {
      if (op.kind === 'owner_marker') {
        owner.capped = true
        metrics.capped++
        log.warn('post-terminal tail OWNER capped', {
          sessionKey: session.sessionKey,
          ownerTurnKey: op.item.ownerTurnKey,
          ownerPersistedCount: owner.persistedCount,
        })
        continue
      }
      if (op.kind === 'stream_marker') {
        op.st.capped = true
        metrics.capped++
        log.warn('post-terminal tail stream capped', {
          sessionKey: session.sessionKey,
          ownerTurnKey: op.item.ownerTurnKey,
          toolUseId: op.item.toolUseId,
          persistedCount: op.st.persistedCount,
        })
        continue
      }
      op.st.lastPersistedHash = op.item.hash
      if (outcome === 'acked' || outcome === 'queued') {
        op.st.persistedCount++
        owner.persistedCount++
        session._durableDelegateRuntimeEvents?.push(structuredClone(op.item.event))
      }
      op.item.onEvent({ kind: 'block', block: op.item.block })
    }
  }

  /** A1 — bash_output_tail 折叠入口(在发起 turn 的 onPostTerminalRuntimeEvent 内
   *  为每条 tail 调用)。去重(内容不变直接丢弃)→ 限频(<5s trailing-edge 合并,
   *  只保留最新一条,定时器到点 flush)→ 否则立即 enqueue 持久化。 */
  private _foldPostTerminalTail(
    session: AgentSession,
    item: TailFoldItem,
    streamKey: string,
  ): void {
    const streams = (session._tailFoldStreams ??= new Map())
    const metrics = (session._tailFoldMetrics ??= {
      unchangedSuppressed: 0,
      rateCoalesced: 0,
      capped: 0,
    })
    let st = streams.get(streamKey)
    if (!st) {
      st = {
        lastPersistedHash: null,
        lastPersistAt: 0,
        persistedCount: 0,
        pending: null,
        timer: null,
        capped: false,
        markerEvent: null,
      }
      streams.set(streamKey, st)
    }
    // 已封顶:静默丢弃(cap 已在触发时计数 + warn 一次)。
    if (st.capped) return
    // owner 已封顶 → 整 owner 全停,静默丢弃(只读 peek,不 churn owner LRU)。
    if (this._tailOwnerBudgets.get(item.ownerTurnKey)?.capped) return
    // 稳态洪泛:内容与上次持久化相同 → 丢弃(不持久化、不转发、不进 durable 收集器)。
    if (item.hash === st.lastPersistedHash) {
      metrics.unchangedSuppressed++
      return
    }
    const now = Date.now()
    if (st.lastPersistAt > 0 && now - st.lastPersistAt < this._tailFoldMinIntervalMs) {
      // 限频:trailing-edge 合并,只保留最新一条 pending;到点 flush 走同一串行链。
      metrics.rateCoalesced++
      st.pending = item
      if (!st.timer) {
        const delay = Math.max(0, st.lastPersistAt + this._tailFoldMinIntervalMs - now)
        st.timer = setTimeout(() => {
          st!.timer = null
          const pending = st!.pending
          st!.pending = null
          if (pending) this._enqueueTailPersist(session, st!, pending)
        }, delay)
        // 折叠定时器不该拖住进程退出:销毁路径会主动 flush pending 并 clear。
        const t = st.timer as { unref?: () => void }
        if (typeof t.unref === 'function') t.unref()
      }
      return
    }
    this._enqueueTailPersist(session, st, item)
  }

  /** B5 — 归属缺失计数 + 限频 warn(30s)。丢弃/兜底转发两类共用一个限频锚点,
   *  日志带累计计数便于观测该缺陷是个例还是持续。 */
  private _warnMissingPostTerminalOwner(kind: 'tail_dropped' | 'non_tail_forwarded'): void {
    if (kind === 'tail_dropped') this._missingOwnerMetrics.tailDropped++
    else this._missingOwnerMetrics.nonTailForwarded++
    const now = Date.now()
    if (now - this._lastMissingOwnerWarnAt < 30_000) return
    this._lastMissingOwnerWarnAt = now
    log.warn('post-terminal runtime event missing owner attribution', {
      kind,
      tail_dropped: this._missingOwnerMetrics.tailDropped,
      non_tail_forwarded: this._missingOwnerMetrics.nonTailForwarded,
    })
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
  private _dispatchPostTerminalRuntimeEvent(
    session: AgentSession,
    event: DurableRuntimeEvent,
    block: OutboundContentBlock,
    ctx: {
      ownerTurnKey: string | undefined | null
      ownerSessionId: string | undefined | null
      turnIndex: number
      onEvent: (e: SessionStreamEvent) => void
    },
  ): void {
    const { ownerTurnKey, ownerSessionId, turnIndex, onEvent } = ctx
    const payload =
      event.payload && typeof event.payload === 'object'
        ? (event.payload as Record<string, unknown>)
        : null
    const isTail = payload?.subtype === 'bash_output_tail'

    if (!ownerTurnKey || !ownerSessionId) {
      if (isTail) {
        // B5 fail-closed:归属不明的 tail 绝不裸转发(丢弃 + 计数 + 限频 warn)。
        this._warnMissingPostTerminalOwner('tail_dropped')
        return
      }
      // B5:非 tail 无 cap/去重保护,丢弃会真丢内容 → 保持兜底转发,但计数 + 限频 warn。
      this._warnMissingPostTerminalOwner('non_tail_forwarded')
      onEvent({ kind: 'block', block })
      return
    }

    if (!isTail) {
      // B6 非 tail:先持久化后转发,dropped 时 fail-closed 不转发(与 tail 路径对称)。
      this._chainTailPersist(session, async () => {
        const outcome = await persistPostTerminalRuntimeEvents({
          sessionKey: session.sessionKey,
          sessionId: ownerSessionId,
          turnIndex,
          continuationOfTurnKey: ownerTurnKey,
          events: [event],
        })
        // dropped:帧未落盘 → 绝不抢先展示未持久化的 post-terminal 快照。
        if (outcome === 'dropped') return
        // acked|queued 才进 durable 收集器(skipped=legacy 未落盘,转发但不计耐久;
        // 与 tail 路径 _enqueueTailPersist 完全对称)。
        if (outcome === 'acked' || outcome === 'queued') {
          session._durableDelegateRuntimeEvents?.push(structuredClone(event))
        }
        onEvent({ kind: 'block', block })
      })
      return
    }

    // tail → 折叠(去重 / 5s 限频 / 每流 24 + 每 turn 64 封顶)。
    const toolUseId = typeof payload!.tool_use_id === 'string' ? payload!.tool_use_id : ''
    const parentToolUseId =
      typeof payload!.parent_tool_use_id === 'string' ? payload!.parent_tool_use_id : ''
    this._foldPostTerminalTail(
      session,
      {
        event,
        block,
        hash: tailContentHash(payload!),
        ownerTurnKey,
        ownerSessionId,
        turnIndex,
        toolUseId,
        parentToolUseId,
        onEvent,
      },
      [ownerTurnKey, parentToolUseId, toolUseId].join('\u0000'),
    )
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
  private async _drainTailFolding(
    session: AgentSession,
    opts: { destroy: boolean },
  ): Promise<void> {
    const streams = session._tailFoldStreams
    if (streams) {
      for (const st of streams.values()) {
        if (st.timer) {
          clearTimeout(st.timer)
          st.timer = null
        }
        const pending = st.pending
        st.pending = null
        if (pending) this._enqueueTailPersist(session, st, pending)
      }
    }
    if (session._postTerminalRuntimeChain) {
      await session._postTerminalRuntimeChain.catch(() => {})
    }
    if (!opts.destroy) return
    const m = session._tailFoldMetrics
    if (m && (m.unchangedSuppressed || m.rateCoalesced || m.capped)) {
      log.info('post-terminal tail folding summary', {
        sessionKey: session.sessionKey,
        unchanged_suppressed: m.unchangedSuppressed,
        rate_coalesced: m.rateCoalesced,
        capped: m.capped,
      })
    }
    session._tailFoldStreams = undefined
    session._tailFoldMetrics = undefined
    session._postTerminalRuntimeChain = undefined
    session._postTerminalTailQueue = undefined
    session._postTerminalTailWorkerScheduled = false
    // owner 预算不在此清:它是 SessionManager 级、可被同 ownerTurnKey 的其它(delegate)
    // 会话共享,自身受 LRU(512)有界;随会话清会破坏跨会话聚合封顶。
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
  private _cursorWorkspacePath(
    agentBaseDir: string,
    repoSessionId?: string,
    projectBound?: boolean,
  ): string {
    const snap =
      repoSessionId && this._getRepoSnapshot ? this._getRepoSnapshot(repoSessionId) : null
    const cwd = decideEngineCwd({
      agentBaseDir,
      repoSnapshot: snap,
      projectBound,
    }).cwd
    try {
      return realpathSync(cwd)
    } catch {
      return cwd
    }
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
    try {
      const configDir = process.env.CLAUDE_CONFIG_DIR
      if (!configDir) return true
      const projectsDir = join(configDir, 'projects')
      if (!existsSync(projectsDir)) return true
      const entries = readdirSync(projectsDir, { withFileTypes: true })
      for (const ent of entries) {
        if (!ent.isDirectory()) continue
        const candidate = join(projectsDir, ent.name, `${resumeId}.jsonl`)
        try {
          const st = statSync(candidate)
          if (st.isFile() && st.size > 0) return true
        } catch {
          // ENOENT / permission denied — treat as not-here, keep scanning
        }
      }
      return false
    } catch {
      return true
    }
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

  async prepareModelSwitch(
    session: AgentSession,
    expectedSourceModel: string,
    targetModel: string,
    switchId: string,
  ): Promise<{ sourceModel: string; targetModel: string }> {
    if (!/^[A-Za-z0-9:_-]{8,128}$/.test(switchId)) throw new Error('MODEL_SWITCH_ID_INVALID')
    if ((session._activeTurnCount ?? 0) > 0 || (session._activeClientTurnCount ?? 0) > 0
      || (session._idleInternalTurns ?? 0) > 0) {
      throw new Error('MODEL_SWITCH_SESSION_BUSY')
    }
    const sourceModel = session.model ?? session.runner.model
    if (!sourceModel) throw new Error('MODEL_SWITCH_SOURCE_UNKNOWN')
    if (sourceModel !== expectedSourceModel) throw new Error('MODEL_SWITCH_SOURCE_CHANGED')
    if (sourceModel === targetModel) return { sourceModel, targetModel }
    if (session._modelSwitchTransition?.state === 'preparing') {
      throw new Error('MODEL_SWITCH_ALREADY_PREPARING')
    }
    const transition: NonNullable<AgentSession['_modelSwitchTransition']> = {
      id: switchId,
      sourceModel,
      targetModel,
      sourceEngine: session.providerTag,
      state: 'preparing',
    }
    session._modelSwitchTransition = transition
    try {
      let artifact
      if (session.runner.compactForHandoff) {
        artifact = await session.runner.compactForHandoff()
      } else if (session.providerTag === 'ccb' || session.providerTag === 'grok') {
        const compactStartedAt = Date.now()
        session._lastNativeCompactionSummary = undefined
        await this.submit(
          session,
          '/compact preserve the user goal, decisions, constraints, current work, files, errors, and next steps',
          () => {},
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { modelSwitchInternal: switchId },
        )
        artifact =
          session.providerTag === 'grok'
            ? await session.runner.readCompactionHandoffSince?.(compactStartedAt)
            : session._lastNativeCompactionSummary
              ? {
                  summaryText: session._lastNativeCompactionSummary,
                  source: 'ccb' as const,
                  compactStartedAt,
                }
              : undefined
      }
      if (!artifact?.summaryText?.trim())
        throw new Error('MODEL_SWITCH_NATIVE_COMPACTION_UNAVAILABLE')
      if (artifact.summaryText.length > NATIVE_MODEL_HANDOFF_MAX_CHARS) {
        throw new Error('MODEL_SWITCH_NATIVE_COMPACTION_TOO_LARGE')
      }
      if (session._modelSwitchTransition !== transition) throw new Error('MODEL_SWITCH_SUPERSEDED')
      transition.summaryText = artifact.summaryText.trim()
      transition.expiresAt = Date.now() + NATIVE_MODEL_SWITCH_TTL_MS
      transition.state = 'prepared'
      return { sourceModel, targetModel }
    } catch (error) {
      if (session._modelSwitchTransition === transition) session._modelSwitchTransition = undefined
      throw error
    }
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
    // Counted from the moment the drain joins the lock chain (like submit()
    // counts _activeTurnCount before `await prev`) until it releases, so
    // recycle / model switch / preheat never see this runner as idle while a
    // drain is waiting, reading proof, or running the idle turn.
    session._idleInternalTurns = (session._idleInternalTurns ?? 0) + 1
    void (async () => {
      const prev = session.lock
      let release!: () => void
      session.lock = new Promise<void>((resolve) => (release = resolve))
      let again = false
      try {
        await prev
        if (this.sessions.get(session.sessionKey) !== session
          || session._plannedTeardown || session._replacing) return
        const source = currentIdleSource(paths.home, session.sessionKey)
        if (!source) return
        await this.finishIdleUnderLock(session, source)
        again = currentIdleSource(paths.home, session.sessionKey) !== undefined
      } catch (err) {
        again = true
        if (!(err instanceof IdleCompactRejected)) {
          log.warn('idle background drain failed', { sessionKey: session.sessionKey }, err)
        }
      } finally {
        session._idleInternalTurns = Math.max(0, (session._idleInternalTurns ?? 0) - 1)
        release()
      }
      if (again && attempt < IDLE_DRAIN_RETRIES) {
        const timer = setTimeout(() => this.scheduleIdleDrain(session, attempt + 1), IDLE_DRAIN_RETRY_MS)
        timer.unref?.()
      }
    })()
  }

  /** Operator exit (requestIdleReset): replace the native session, then
   * abandon this session's unfinished idle work. Caller owns session.lock. */
  private async applyIdleResetIfRequested(session: AgentSession): Promise<void> {
    const marker = readIdleReset(paths.home, session.sessionKey)
    if (!marker) return
    if (marker === 'corrupt') {
      log.error('box idle reset marker invalid; ignored', { sessionKey: session.sessionKey })
      return
    }
    if (session.runner.isRunning) await session.runner.shutdown().catch(() => {})
    const sessionKey = session.sessionKey
    this._resumeMap.delete(sessionKey)
    this._resumeMapTimestamps.delete(sessionKey)
    this._resumeMapProvider.delete(sessionKey)
    this._resumeMapLastCost.delete(sessionKey)
    this._resumeMapCostImprecise.delete(sessionKey)
    this._resumeMapHistory.delete(sessionKey)
    session.ccbSessionId = null
    session.runner.clearSessionId?.()
    this._saveResumeMap()
    const abandoned = abandonAllIdle(paths.home, sessionKey)
    consumeIdleReset(paths.home, sessionKey)
    pruneIdleOps(paths.home, sessionKey)
    log.warn('box idle reset applied: native session replaced', { sessionKey, abandoned })
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

  async preheatRunner(session: AgentSession): Promise<PreheatOutcome> {
    if (session._plannedTeardown || session._replacing) return 'skipped_teardown'
    const runner = session.runner
    if (typeof runner.preheat !== 'function') return 'skipped_engine'
    if (runner.isRunning) return 'already_running'
    if ((session._activeTurnCount ?? 0) > 0 || (session._idleInternalTurns ?? 0) > 0
      || this._promptQueueHolds(session)) {
      return 'skipped_busy'
    }
    const existing = this._preheatInFlight.get(session.sessionKey)
    if (existing) return existing
    if (this._preheatActive >= 1) return 'skipped_cap'
    this._preheatActive += 1
    const startedAt = Date.now()
    // `run` never rejects: concurrent callers share this promise via the map,
    // and a rejected shared promise would escape the first caller's handling.
    const run = (async (): Promise<PreheatOutcome> => {
      const prev = session.lock
      let release: () => void = () => {}
      session.lock = new Promise<void>((r) => (release = r))
      try {
        await prev
        // Re-check under the lock: a turn/teardown may have landed meanwhile.
        if (session._plannedTeardown || session._replacing) return 'skipped_teardown'
        if (session.runner.isRunning) return 'already_running'
        if ((session._activeTurnCount ?? 0) > 0 || (session._idleInternalTurns ?? 0) > 0
          || this._promptQueueHolds(session)) {
          return 'skipped_busy'
        }
        const deadlineMs = resolveEnginePreheatDeadlineMs()
        try {
          await withPreheatDeadline(session.runner.preheat!(), deadlineMs)
        } catch (err) {
          if (!isPreheatDeadline(err)) throw err
          log.warn('engine_preheat', {
            sessionKey: session.sessionKey,
            engine: runner.engineId,
            outcome: 'timed_out',
            spawn_ms: Date.now() - startedAt,
            deadline_ms: deadlineMs,
            err: String(err),
          })
          try {
            await session.runner.shutdown()
          } catch (shutdownErr) {
            log.warn(
              'engine_preheat shutdown after deadline failed',
              {
                sessionKey: session.sessionKey,
              },
              shutdownErr,
            )
          }
          return 'failed'
        }
        session.lastUsedAt = Date.now()
        log.info('engine_preheat', {
          sessionKey: session.sessionKey,
          engine: runner.engineId,
          outcome: 'started',
          spawn_ms: Date.now() - startedAt,
        })
        return 'started'
      } catch (err) {
        log.warn('engine_preheat', {
          sessionKey: session.sessionKey,
          engine: runner.engineId,
          outcome: 'failed',
          spawn_ms: Date.now() - startedAt,
          err: String(err),
        })
        return 'failed'
      } finally {
        release()
      }
    })()
    this._preheatInFlight.set(session.sessionKey, run)
    try {
      return await run
    } finally {
      this._preheatActive -= 1
      if (this._preheatInFlight.get(session.sessionKey) === run) {
        this._preheatInFlight.delete(session.sessionKey)
      }
    }
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

  interrupt(sessionKey: string, reason: 'user' | 'system' = 'system'): boolean {
    const s = this.sessions.get(sessionKey)
    if (!s) return false
    const external = s._externalTurnAbort
    if (external && !external.signal.aborted) external.abort()
    const persistActiveTurn = s._persistActiveTurn
    if (persistActiveTurn) {
      const persistence = reason === 'user'
        ? persistActiveTurn('interrupted', '本轮已由用户停止。', 'USER_CANCELLED')
        : persistActiveTurn('interrupted', '本轮因系统调度中断。', 'SYSTEM_INTERRUPT')
      this._trackPersistence(persistence)
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
  bufferPendingAgentGroup(
    parentSessionKey: string,
    group: DurableAgentGroup,
    owner?: DelegateOwnerTurnLocator,
  ): boolean {
    const parent = this.sessions.get(parentSessionKey)
    if (!parent) return false
    if (owner) {
      if (!isValidDelegateOwnerLocator(owner)) return false
      if (parent.peerId !== owner.parentSessionId) return false
      if (parent._currentTurnKey !== owner.parentTurnKey) return false
      if (parent._sealedOwnerTurnKeys?.has(owner.parentTurnKey)) return false
      const live = this._matchLiveOwnerRun(parent, owner, group)
      if (live === 'conflict' || live === 'session_deleted') return false
      if (live === 'duplicate') return true
      const admission = this._admitExactOwnerRun(owner, group, 'buffered')
      if (admission === 'conflict' || admission === 'session_deleted') return false
      if (admission === 'duplicate') return true
    }
    // OCV5-189 diagnostics only: exact-owner requests for an earlier/sealed
    // turn were already rejected above and the caller takes the durable late
    // path. Legacy ownerless or anomalous billings may still reach this point;
    // logging must not change admission, queue ownership or drain semantics.
    const currentTurnKey = parent._currentTurnKey
    const crossTurn = (group.engineBillings ?? []).filter(
      (billing) => typeof billing.parentTurnKey === 'string' && billing.parentTurnKey !== currentTurnKey,
    )
    if (currentTurnKey && crossTurn.length > 0) {
      log.warn('delegate team card drains into a later turn than its billing parent', {
        parentSessionKey,
        runId: group.runId,
        agentId: group.agentId,
        currentTurnKey,
        billingParentTurnKeys: [...new Set(crossTurn.map((billing) => billing.parentTurnKey))],
        requestIds: crossTurn.map((billing) => billing.requestId),
      })
    }
    ;(parent._pendingAgentGroups ??= []).push({
      group: {
        ...group,
        _ocEventOrdinal: group._ocEventOrdinal ?? takeDurableEventOrdinal(parent),
      },
      ownerTurnKey: owner?.parentTurnKey,
    })
    return true
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
    const pending = session._pendingAgentGroups
    if (turnKey === undefined) {
      if (!pending || pending.length === 0) return []
      session._pendingAgentGroups = undefined
      return pending.map((entry) => entry.group)
    }
    // Exact-owner drain: seal the turn **even when nothing was buffered** —
    // the turn-end payload freeze happens regardless, so a late completion
    // for this owner must never enter the in-memory buffer afterwards.
    this._sealOwnerTurn(session, turnKey)
    if (!pending || pending.length === 0) return []
    const take: DurableAgentGroup[] = []
    const keep: PendingAgentGroupEntry[] = []
    const takenRuns = new Set<string>()
    for (const entry of pending) {
      if (entry.ownerTurnKey === undefined || entry.ownerTurnKey === turnKey) {
        if (takenRuns.has(entry.group.runId)) continue
        takenRuns.add(entry.group.runId)
        take.push(entry.group)
      } else keep.push(entry)
    }
    session._pendingAgentGroups = keep.length > 0 ? keep : undefined
    if (take.length > 0) {
      this._claimDrainedOwnerGroups(session, turnKey, take)
    }
    return take
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
    if (!isValidDelegateOwnerLocator(args.owner)) {
      log.warn('late delegate group dropped: invalid owner locator', {
        runId: args.group.runId,
      })
      return false
    }
    if (args.sessionKey) {
      const live = this.sessions.get(args.sessionKey)
      if (live && live.peerId !== args.owner.parentSessionId) {
        log.warn('late delegate group dropped: session/peer mismatch', {
          runId: args.group.runId,
          ownerSessionId: args.owner.parentSessionId,
        })
        return false
      }
    }
    const conflictKey = this._exactOwnerRunKey(args.owner.parentTurnKey, args.group.runId)
    const live = this._matchLiveSessionsOwnerRun(args.owner, args.group, args.sessionKey)
    if (live === 'conflict') {
      log.warn('late_delegate_group_conflict: same run with different content', {
        runId: args.group.runId,
        ownerTurnKey: args.owner.parentTurnKey,
      })
      return false
    }
    if (live === 'session_deleted') {
      log.warn('late delegate group dropped: session_deleted', {
        runId: args.group.runId,
      })
      return false
    }
    if (live === 'duplicate') return true
    const admission = this._admitExactOwnerRun(args.owner, args.group, 'inflight')
    if (admission === 'conflict') {
      log.warn('late_delegate_group_conflict: same run with different content', {
        runId: args.group.runId,
        ownerTurnKey: args.owner.parentTurnKey,
      })
      return false
    }
    if (admission === 'session_deleted') {
      log.warn('late delegate group dropped: session_deleted', {
        runId: args.group.runId,
      })
      return false
    }
    if (admission === 'duplicate') {
      const seen = this._exactOwnerRuns.get(conflictKey)
      if (seen?.state === 'inflight' || seen?.state === 'queued' || seen?.state === 'acked' || seen?.state === 'buffered') {
        return true
      }
      return true
    }
    let droppedReason = ''
    // No pre-stage local lookup: master owns cross-root idempotency. The
    // async wrapper also captures a synchronous managed-sink rejection;
    // register its complete outcome chain before returning to shutdown.
    const persistence = (async () => persistPostTerminalAgentGroup({
      sessionKey: args.sessionKey ?? args.owner.parentSessionId,
      owner: args.owner,
      group: args.group,
      onDroppedReason: (reason) => {
        droppedReason = reason
      },
    }))()
    const settled = persistence.then((outcome) => {
      const rec = this._exactOwnerRuns.get(conflictKey)
      if (!rec || rec.identity !== lateDelegateGroupIdentity(args.owner, args.group)) return
      if (outcome === 'acked') {
        rec.state = 'acked'
        return
      }
      if (outcome === 'queued') {
        rec.state = 'queued'
        return
      }
      if (/session_deleted/i.test(droppedReason)) {
        rec.state = 'session_deleted'
        log.warn('late delegate group persist session_deleted', {
          runId: args.group.runId,
          ownerTurnKey: args.owner.parentTurnKey,
        })
        return
      }
      this._exactOwnerRuns.delete(conflictKey)
      log.warn('late delegate group persist dropped', {
        runId: args.group.runId,
        ownerTurnKey: args.owner.parentTurnKey,
        reason: droppedReason || outcome,
      })
    }, (err: unknown) => {
      const rec = this._exactOwnerRuns.get(conflictKey)
      if (rec?.identity === lateDelegateGroupIdentity(args.owner, args.group)) {
        this._exactOwnerRuns.delete(conflictKey)
      }
      log.warn('late delegate group persist failed before durable handoff', {
        runId: args.group.runId,
        ownerTurnKey: args.owner.parentTurnKey,
      }, err instanceof Error ? err : new Error(String(err)))
    })
    this._trackPersistence(settled)
    return true
  }

  private _exactOwnerRunKey(ownerTurnKey: string, runId: string): string {
    return `${ownerTurnKey}\0${runId}`
  }

  private _trimExactOwnerRuns(): void {
    if (this._exactOwnerRuns.size <= 256) return
    const evictable: string[] = []
    for (const [key, rec] of this._exactOwnerRuns) {
      if (rec.state === 'buffered' || rec.state === 'inflight') continue
      evictable.push(key)
    }
    while (this._exactOwnerRuns.size > 256 && evictable.length > 0) {
      const oldest = evictable.shift()
      if (oldest === undefined) break
      const rec = this._exactOwnerRuns.get(oldest)
      if (!rec || rec.state === 'buffered' || rec.state === 'inflight') continue
      this._exactOwnerRuns.delete(oldest)
    }
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
  private _admitExactOwnerRun(
    owner: DelegateOwnerTurnLocator,
    group: DurableAgentGroup,
    next: ExactOwnerRunState,
  ): 'accept' | 'duplicate' | 'conflict' | 'session_deleted' {
    const key = this._exactOwnerRunKey(owner.parentTurnKey, group.runId)
    const identity = lateDelegateGroupIdentity(owner, group)
    const seen = this._exactOwnerRuns.get(key)
    if (!seen) {
      this._exactOwnerRuns.set(key, { identity, state: next })
      this._trimExactOwnerRuns()
      return 'accept'
    }
    if (seen.identity !== identity) return 'conflict'
    if (seen.state === 'session_deleted') return 'session_deleted'
    return 'duplicate'
  }

  private _claimDrainedOwnerGroups(
    session: AgentSession,
    turnKey: string,
    groups: DurableAgentGroup[],
  ): void {
    const owner = this._ownerLocatorForSession(session, turnKey)
    if (!isValidDelegateOwnerLocator(owner)) return
    for (const group of groups) {
      const key = this._exactOwnerRunKey(turnKey, group.runId)
      const identity = lateDelegateGroupIdentity(owner, group)
      const seen = this._exactOwnerRuns.get(key)
      if (seen && seen.identity !== identity) continue
      this._exactOwnerRuns.set(key, { identity, state: 'inflight' })
    }
    this._trimExactOwnerRuns()
  }

  private _settleDrainedOwnerGroups(
    session: AgentSession,
    turnKey: string,
    groups: DurableAgentGroup[],
    outcome: TapePersistResult,
  ): void {
    const owner = this._ownerLocatorForSession(session, turnKey)
    const durable = outcome === 'acked' || outcome === 'queued' || outcome === 'skipped'
    if (durable && isValidDelegateOwnerLocator(owner)) {
      const byTurn = (session._ackedExactOwnerRuns ??= new Map())
      let runs = byTurn.get(turnKey)
      if (!runs) {
        runs = new Map()
        byTurn.set(turnKey, runs)
      }
      for (const group of groups) {
        runs.set(group.runId, lateDelegateGroupIdentity(owner, group))
      }
    }
    for (const group of groups) {
      const key = this._exactOwnerRunKey(turnKey, group.runId)
      const rec = this._exactOwnerRuns.get(key)
      if (!rec) continue
      if (isValidDelegateOwnerLocator(owner) && rec.identity !== lateDelegateGroupIdentity(owner, group)) {
        continue
      }
      if (outcome === 'acked') rec.state = 'acked'
      else if (outcome === 'queued') rec.state = 'queued'
      else if (outcome === 'skipped') rec.state = 'acked'
      else this._exactOwnerRuns.delete(key)
    }
  }

  private _compareOwnerRunIdentity(
    seenIdentity: string,
    owner: DelegateOwnerTurnLocator,
    group: DurableAgentGroup,
  ): 'duplicate' | 'conflict' {
    if (!seenIdentity) return 'duplicate'
    return seenIdentity === lateDelegateGroupIdentity(owner, group) ? 'duplicate' : 'conflict'
  }

  private _matchLiveOwnerRun(
    session: AgentSession,
    owner: DelegateOwnerTurnLocator,
    group: DurableAgentGroup,
  ): 'accept' | 'duplicate' | 'conflict' | 'session_deleted' {
    const pending = session._pendingAgentGroups
    if (pending) {
      for (const entry of pending) {
        if (entry.ownerTurnKey !== owner.parentTurnKey) continue
        if (entry.group.runId !== group.runId) continue
        return this._compareOwnerRunIdentity(lateDelegateGroupIdentity(owner, entry.group), owner, group)
      }
    }
    const acked = session._ackedExactOwnerRuns?.get(owner.parentTurnKey)?.get(group.runId)
    if (acked !== undefined) return this._compareOwnerRunIdentity(acked, owner, group)
    return 'accept'
  }

  private _matchLiveSessionsOwnerRun(
    owner: DelegateOwnerTurnLocator,
    group: DurableAgentGroup,
    sessionKey?: string,
  ): 'accept' | 'duplicate' | 'conflict' | 'session_deleted' {
    const liveSession = sessionKey ? this.sessions.get(sessionKey) : undefined
    if (liveSession) {
      const live = this._matchLiveOwnerRun(liveSession, owner, group)
      if (live !== 'accept') return live
    }
    for (const session of this.sessions.values()) {
      if (session.peerId !== owner.parentSessionId) continue
      const live = this._matchLiveOwnerRun(session, owner, group)
      if (live !== 'accept') return live
    }
    return 'accept'
  }

  /** OCV5-180 B1 — mark an owner turn sealed (payload frozen). Insertion-order
   * LRU; re-sealing an already-sealed key is a no-op. */
  private _sealOwnerTurn(session: AgentSession, turnKey: string): void {
    const sealed = (session._sealedOwnerTurnKeys ??= new Map<string, number>())
    if (sealed.has(turnKey)) return
    sealed.set(turnKey, Date.now())
    if (sealed.size > SEALED_OWNER_TURN_KEYS_CAP) {
      const oldest = sealed.keys().next().value
      if (oldest !== undefined) {
        sealed.delete(oldest)
        session._ackedExactOwnerRuns?.delete(oldest)
      }
    }
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
  async setExecutionTarget(
    sessionKey: string,
    target: { kind: 'local' } | { kind: 'remote'; hostId: string },
  ): Promise<void> {
    const session = this.sessions.get(sessionKey)
    if (!session) throw new Error(`session not found: ${sessionKey}`)

    const prev = session.lock
    let release!: () => void
    session.lock = new Promise<void>((r) => (release = r))
    try {
      await prev

      const current = session.executionTarget
      // 幂等短路:target 未变(remote 需 hostId 相同)
      if (current.kind === target.kind) {
        if (current.kind === 'local') return
        if (
          current.kind === 'remote' &&
          target.kind === 'remote' &&
          current.hostId === target.hostId
        )
          return
      }

      // 切入 remote 的前置校验
      let newTarget: ExecutionTarget
      if (target.kind === 'remote') {
        const ctrl = this._remoteTargetController
        if (!ctrl) throw new RemoteTargetUnavailableError('controller not injected')
        if (!session.userId) {
          // remote 必须绑 userId,做跨用户隔离;cron 风格 session 不允许远程执行
          throw new Error('session not switchable to remote: userId missing')
        }
        const userId = session.userId
        // 先 acquire,失败抛异常由外层 rethrow,不动 runner
        const handle = await ctrl.acquireMux(sessionKey, userId, target.hostId)
        newTarget = { kind: 'remote', hostId: target.hostId, hostMeta: handle }
      } else {
        newTarget = { kind: 'local' }
      }

      // Swap:到这里新目标资源已就绪(local 无资源,remote 已 hold mux)。
      // 下面做"清上下文 + 改 runner 配置":
      //   1. runner.shutdown 优雅停 CCB(graceful,in-flight turn 会被打断,
      //      但 session.crashed 不会触发 —— shuttingDown 标志位让 exit 归类
      //      为预期退出)。
      //   2. 清 resume-map 四张平行表 + session.ccbSessionId + runner sessionId
      //      —— 下次 submit 就会用新 env spawn 一个全新 CCB。
      //   3. runner.setExecutionTarget 在重启前就位,新 spawn 读到新 env。
      //
      // 任何一步抛 → release 新 mux 做 rollback;session.executionTarget 不提交。
      try {
        await session.runner.shutdown()
        this._resumeMap.delete(sessionKey)
        this._resumeMapTimestamps.delete(sessionKey)
        this._resumeMapProvider.delete(sessionKey)
        this._resumeMapLastCost.delete(sessionKey)
        this._resumeMapCostImprecise.delete(sessionKey)
        this._resumeMapHistory.delete(sessionKey)
        session.ccbSessionId = null
        session.runner.clearSessionId?.()
        this._saveResumeMap()
        await session.runner.setExecutionTarget(newTarget)
      } catch (err) {
        if (newTarget.kind === 'remote' && session.userId) {
          await this._remoteTargetController
            ?.releaseMux(sessionKey, session.userId, newTarget.hostId)
            .catch((e) => log.warn('rollback releaseMux failed', { sessionKey, err: String(e) }))
        }
        throw err
      }

      // 提交新 target。旧 mux(若之前是 remote)在锁外异步 release,别让 IO
      // 阻塞 lock chain;release 幂等,失败只告警。
      const oldTarget = session.executionTarget
      session.executionTarget = newTarget
      if (oldTarget.kind === 'remote' && session.userId) {
        const uid = session.userId
        const oldHostId = oldTarget.hostId
        queueMicrotask(() => {
          this._remoteTargetController
            ?.releaseMux(sessionKey, uid, oldHostId)
            .catch((err) =>
              log.warn('release old mux failed', { sessionKey, oldHostId, err: String(err) }),
            )
        })
      }
      log.info('execution target switched', {
        sessionKey,
        from: oldTarget.kind,
        to: newTarget.kind,
        hostId: newTarget.kind === 'remote' ? newTarget.hostId : undefined,
      })
    } finally {
      release()
    }
  }

  /** Destroy a single session: kill subprocess + remove from map + clear resume mapping.
   *  Also clears resume-map even if the session was already evicted from memory. */
  async destroySession(sessionKey: string): Promise<void> {
    const s = this.sessions.get(sessionKey)
    if (s) {
      // (跨 turn stdout 路由收在 adapter 内:session 引用被删后 adapter → turn
      //  闭包链整体可 GC,无需再显式卸 'message' listener。)
      this.markPlannedServiceRestart(s)
      await s.runner.shutdown()
      // A1:底座已停产出,flush 折叠 tail 的 pending 并清定时器/状态(await 持久化链)。
      await this._flushTailFolding(s)
      // 释放 remote mux refcount —— destroy 是 session 终结态,refcount 必须归零,
      // 否则 mux 泄漏。release 幂等,失败只 warn 不抛(上游不关心)。
      if (s.executionTarget.kind === 'remote' && s.userId) {
        await this._remoteTargetController
          ?.releaseMux(sessionKey, s.userId, s.executionTarget.hostId)
          .catch((err) =>
            log.warn('destroySession releaseMux failed', { sessionKey, err: String(err) }),
          )
      }
      this.sessions.delete(sessionKey)
      // Phase 5:同步清 peer→sessionKey 反查索引(避免悬挂条目让后续 recycle 找到死 session)。
      this._sessionIdToKey.delete(s.peerId)
    }
    // Always clear resume-map (handles both live and evicted sessions)
    if (this._resumeMap.has(sessionKey)) {
      this._resumeMap.delete(sessionKey)
      this._resumeMapTimestamps.delete(sessionKey)
      this._resumeMapLastCost.delete(sessionKey)
      this._resumeMapCostImprecise.delete(sessionKey)
      this._resumeMapProvider.delete(sessionKey)
      this._resumeMapHistory.delete(sessionKey)
      this._saveResumeMap()
    }
    // Medium#G1:让 server.ts 的 outboundRing 也清掉这个 key(两个 server.ts
    // 里现存的 destroySession 调用点已经显式 clear 过,这里再调一次是幂等;
    // 未来若有遗漏的路径,callback 能兜住)
    try {
      this.onSessionDestroyed?.(sessionKey)
    } catch {}
  }

  /**
   * Stop the warm runner and drop the live session, but keep resume-map so a
   * later getOrCreate(sessionKey) can native-resume. Awaited by resumable
   * delegate_task; fire-and-forget destroySession remains the one-shot path.
   */
  async retireKeepResume(sessionKey: string): Promise<void> {
    const s = this.sessions.get(sessionKey)
    if (s) {
      try {
        this.markPlannedServiceRestart(s)
        await s.runner.shutdown()
      } catch (err) {
        log.warn('retireKeepResume shutdown failed', { sessionKey }, err)
      }
      try {
        await this._flushTailFolding(s)
      } catch (err) {
        log.warn('retireKeepResume flush failed', { sessionKey }, err)
      }
      if (s.executionTarget.kind === 'remote' && s.userId) {
        await this._remoteTargetController
          ?.releaseMux(sessionKey, s.userId, s.executionTarget.hostId)
          .catch((err) =>
            log.warn('retireKeepResume releaseMux failed', { sessionKey, err: String(err) }),
          )
      }
      this.sessions.delete(sessionKey)
      this._sessionIdToKey.delete(s.peerId)
    }
    try {
      this.onSessionDestroyed?.(sessionKey)
    } catch {}
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

  async shutdownAll(): Promise<void> {
    // Persist resume map BEFORE killing subprocesses — ensures state survives restart
    // (runner.shutdown() sets shuttingDown=true so the exit handler won't call _saveResumeMap)
    this._saveResumeMap()
    await this._resumeMapWrite
    // Medium#G1:shutdown 前先把所有 live sessionKey 通知一次 ring 清理,防止
    // 进程退出前最后一刻的 WS 重连拿到下一轮无主的 frame。
    const keysToClear = [...this.sessions.keys()]
    // 收集所有 remote session 的 mux 句柄,用于 shutdown 后统一 release,
    // 避免 mux 泄漏跨进程(systemd 重启 tmpfs 清干净是最后兜底,但 release
    // 在自 process 内做,是正路)。
    const muxReleases: Array<() => Promise<void>> = []
    for (const s of this.sessions.values()) {
      if (s.executionTarget.kind === 'remote' && s.userId) {
        const uid = s.userId
        const key = s.sessionKey
        const hostId = s.executionTarget.hostId
        muxReleases.push(
          () =>
            this._remoteTargetController?.releaseMux(key, uid, hostId).catch(() => {}) ??
            Promise.resolve(),
        )
      }
    }
    await Promise.all(
      [...this.sessions.values()].map((s) => {
        this.markPlannedServiceRestart(s)
        return s.runner.shutdown()
      }),
    )
    await Promise.all(muxReleases.map((fn) => fn()))
    // A1:底座已全部停产出,flush 各 session 折叠 tail 的 pending(其持久化随后被
    // awaitPendingPersistence 一并排空)。
    await Promise.all([...this.sessions.values()].map((s) => this._flushTailFolding(s)))
    // Drain server-authored persistence promises (turn-end fan-outs +
    // handleExit setTimeout-150ms partial flushes registered while the
    // runners were being torn down). Must complete before server.ts
    // clears the v3 sink singleton, otherwise late writes fall through
    // to the legacy local SQLite path that's permanently empty in v3.
    await this.awaitPendingPersistence()
    this.sessions.clear()
    // Phase 5:整体清空时同步清反查索引。
    this._sessionIdToKey.clear()
    for (const k of keysToClear) {
      try {
        this.onSessionDestroyed?.(k)
      } catch {}
    }
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
    // 2026-04-22 Codex R1 N11:LRU 驱逐此前 fire-and-forget 调 runner.shutdown() 然后
    // 立刻 `sessions.delete(key)` + `onSessionDestroyed(key)` 清 ring。问题是 shutdown
    // 内部有 SIGTERM → 1s 等待 → SIGKILL 的异步链,在这期间 runner 仍可能从 stdout
    // 读到残余字节并推给 server(通过 onFrame callback),而此刻 server 的 outboundRing
    // 已被 onSessionDestroyed 清空 —— 这些尾帧会落到一个空 ring 上,下次 reconnect
    // replay 时丢掉(数据不一致且无 warning)。
    //
    // 修复:await 每个 runner.shutdown() 完成后才 delete + onSessionDestroyed。
    // 用 async IIFE 不阻塞 interval 队列(每轮 eviction 独立跑,上一轮若卡住不影响下一轮)。
    let _inFlight = false
    const t = setInterval(() => {
      if (_inFlight) return // 防并行:shutdown 链慢 → 跳过本轮,下一轮再扫
      _inFlight = true
      ;(async () => {
        try {
          const now = Date.now()
          const toEvict: string[] = []
          for (const [key, s] of this.sessions) {
            const isTempSession = isTempSessionKey(key)
            const maxIdle = isTempSession ? this.maxIdleMsCron : this.maxIdleMsChat
            const lastActive = Math.max(s.lastUsedAt, s.runner.lastActivityAt)
            if (now - lastActive > maxIdle) {
              toEvict.push(key)
            }
          }
          for (const key of toEvict) {
            const s = this.sessions.get(key)
            if (!s) continue
            // 先 await shutdown 完成(SIGTERM+SIGKILL 链走完),再清状态
            try {
              this.markPlannedServiceRestart(s)
              await s.runner.shutdown()
            } catch {}
            // A1:底座已停产出,flush 折叠 tail 的 pending 并清定时器/状态。
            await this._flushTailFolding(s)
            // 释放 remote mux refcount(若为 remote)—— 与 destroySession 语义一致
            if (s.executionTarget.kind === 'remote' && s.userId) {
              await this._remoteTargetController
                ?.releaseMux(key, s.userId, s.executionTarget.hostId)
                .catch((err) => log.warn('evict releaseMux failed', { key, err: String(err) }))
            }
            this.sessions.delete(key)
            // Phase 5:同步清 peer→sessionKey 反查索引(避免悬挂条目)。
            this._sessionIdToKey.delete(s.peerId)
            if (!key.includes(':webchat:')) {
              this._resumeMap.delete(key)
              this._resumeMapTimestamps.delete(key)
              this._resumeMapLastCost.delete(key)
              this._resumeMapCostImprecise.delete(key)
              this._resumeMapProvider.delete(key)
              this._resumeMapHistory.delete(key)
            }
            // Medium#G1 + N11:shutdown 完才清 ring,保证不会有"runner 已死但 ring 还能
            // 接尾帧"的窗口。webchat 虽然 resume-map 留着等 reconnect,但 outboundRing
            // 没必要留(重连时会重走 hello,server 按 lastFrameSeq=0 重建)。
            try {
              this.onSessionDestroyed?.(key)
            } catch {}
          }
          if (toEvict.length > 0) this._saveResumeMap()
          this._pruneResumeMap()
        } finally {
          _inFlight = false
        }
      })()
    }, intervalMs)
    return () => clearInterval(t)
  }

  // Idle TTL for entries whose in-memory AgentSession was already evicted.
  // 7 days covers typical gateway restarts / multi-day reconnect gaps while
  // preventing resume-map from growing unbounded. Rationale: resume-map exists
  // to survive *restarts*, not to be a durable conversation archive.
  private static RESUME_MAP_INACTIVE_TTL = 7 * 24 * 60 * 60 * 1000 // 7 days

  private _pruneResumeMap(): void {
    const pruned = this.resumeStore.prune((key) => this.sessions.has(key), SessionManager.RESUME_MAP_INACTIVE_TTL)
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
