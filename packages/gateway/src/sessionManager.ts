import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AgentDef,
  type OpenClaudeConfig,
  appendServerAuthoredMessageDurable,
  getClientSession,
  getEngineContextMessages,
  getMaxTurnIdx,
  indexTurn,
  MemoryDir,
  recordTurnDispatchRunning,
  reserveTurnIndex,
  paths,
  type KernelFileLock,
  upsertSessionMeta,
} from '@openclaude/storage'
// M0 engine 适配层:CCB 私有件(parser/telemetry/auth 分类)已下沉 CcbAdapter,
// 本文件只消费 engine 中立契约(EngineAdapter / EngineEvent / TurnSummary /
// PartialSnapshot)。ccbAdapter / codexAdapter 的 import 兼有 registry 注册副作用
// ('ccb' / 'codex' factory)。
import './engine/ccbAdapter.js'
import './engine/codexAdapter.js'
import type {
  AutomaticRetryState,
  CollabAgentPolicy,
  EngineAdapter,
  EngineTurnRun,
} from './engine/engineAdapter.js'
import type {
  DurableRuntimeEvent,
  EngineBillingEvent,
  EngineEvent,
  EngineFinalMeta,
  SegmentRecord,
  SessionStreamEvent,
  TurnSummary,
  TurnToolEntry,
} from './engine/engineEvents.js'
import { createEngine, resolveEngine } from './engine/registry.js'
import { isModelAuthorityRequired } from './modelAuthority.js'
import type { CodexProviderConfigOverride } from './engine/codexShared.js'
import { eventBus, createEvent } from './eventBus.js'
import { createLogger } from './logger.js'
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
  modelHistoryRoleLabel,
  modelHistorySemanticRole,
  modelHistorySemanticText,
  type ModelHistorySemanticRole,
  type TurnWaiveReason,
  type DurableAgentGroup,
  type DurableGoalUsageRecord,
  type GoalStateSnapshot,
  type OutboundContentBlock,
  type SessionWorkspaceMode,
} from '@openclaude/protocol'
import { resolveExecutionModel } from './server.js'
import { classifyRunError } from './errorClassify.js'
import type { GatewayTurnPhase } from './ccbMessageParser.js'
import {
  type ExecutionTarget,
  type RemoteTargetController,
  RemoteTargetUnavailableError,
} from './remoteTarget.js'
import type { RepoSnapshot } from './sessionRepoWorkspace.js'
import type { TurnModelAuthority, UsageAttributionTag } from './subprocessRunner.js'

const log = createLogger({ module: 'sessionManager' })

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

type ChatHistoryMessage = {
  id?: unknown
  role?: unknown
  text?: unknown
  content?: unknown
  status?: unknown
  system?: unknown
}

type PendingExternalExchange = {
  user: { id: string; role: 'user'; text: string; status: 'completed'; ts: number }
  assistant: { id: string; role: 'assistant'; text: string; status: 'completed'; ts: number }
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

function normForCompare(s: string): string {
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
  if (latestAssistantId && shouldTreatMasterHistoryAsProviderGap({
    messages,
    peerId: opts.peerId,
    agentId: opts.agentId,
  })) {
    return `master:${latestAssistantId}`
  }
  return opts.hasProviderResumeId ? null : `master:${latestAssistantId ?? 'no-assistant'}`
}

export function buildHistoricalContextPrompt(
  messages: unknown[],
  currentUserText: string,
  maxHistoryChars?: number,
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
 *   - DEFAULT_MS (5 min) — API stream / 普通 idle。子进程预期在持续吐 token
 *     或至少有 telemetry 事件刷 lastActivityAt;真静默 > 5 min 通常意味着
 *     deadlock 或 SDK 卡死,需要尽快 kill 释放 session lock。
 *
 * 历史:pre-2026-04-19 这两个阈值是 30 / 60 min,过宽导致 deadlock 检测慢。
 * 2026-04-19 收紧到 15 / 5。本次(2026-05-25)发现 compacting 误归到 DEFAULT,
 * 把它合并到 TOOL 档,不新增第三档(同语义不切碎)。
 *
 * 另有 _runOneTurn 内部一个 30 min 硬背书 timer(被任意 stdout chunk 重置),
 * 作为这两档之上的兜底,不在本文件常量范围。
 */
export const IDLE_TIMEOUT_TOOL_MS = 15 * 60_000
export const IDLE_TIMEOUT_DEFAULT_MS = 5 * 60_000

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
): number {
  const inNonStreamingPhase =
    currentTurnStatus === 'compacting' ||
    (typeof currentTurnStatus === 'object' && currentTurnStatus !== null)
  if (pendingToolCalls > 0 || inNonStreamingPhase || engineId === 'codex') {
    return IDLE_TIMEOUT_TOOL_MS
  }
  return IDLE_TIMEOUT_DEFAULT_MS
}

function throwIfLogicalTurnCancelled(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('logical turn cancelled')
}

function waitForRetryDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfLogicalTurnCancelled(signal)
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('logical turn cancelled'),
      )
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 触发 v3MasterSink server-authored 持久化的 channel 白名单。
 *
 * 历史上只有 'webchat' 走 master→client_sessions 写回路径(Phase 0.1 落地的 mobile
 * durability 修复)。'wechat' 在 v3 commercial 接 iLink broker 后,inbound 直接从
 * /internal/v3/wechat-inbound 喂 dispatchInbound,**peer.id 由 broker 解析为 client_sessions.id**
 * (即 wechat_session_pointer.current_session_id),所以走和 webchat 一模一样的"per-user
 * client_sessions 行 + master 端 appendServerAuthoredMessage"的写回路径,允许放行。
 *
 * 其它 channel(telegram / cron / webhook / delegate)peerId 不是 client_sessions.id —
 * master 端 WHERE id=? AND user_id=? 永远命不中,落 outbox 死信浪费 IO,故不放行。
 */
const MASTER_SINK_PERSIST_CHANNELS: ReadonlySet<string> = new Set(['webchat', 'wechat'])

// 一个 sessionKey 对应一个 EngineAdapter(CCB = CcbAdapter 组合 SubprocessRunner)
// + 一把 Mutex(同 session 串行)。跨 session 完全并行。
export interface AgentSession {
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
   * 这里(delegate_task 是队长工具调用,同步 await,故子委派完成必早于队长本
   * turn 结束)。turn 收尾(persistServerAuthoredTurn 调用点)drain 本数组并清空,
   * 随同一 POST 下发给 master 落库为 role 'agent-group' 行。
   *
   * 只在 webchat 队长会话上累积(buffering 走 progressTarget,webchat-only,与
   * MASTER_SINK_PERSIST_CHANNELS 一致)。嵌套 delegate 的完整 transcript 先写入
   * 直接父 delegate 的 `_durableDelegateTranscript`,最终随一级团队卡一起入本缓冲。
   */
  _pendingAgentGroups?: DurableAgentGroup[]
  /** Turn-wide monotonic sequence shared by engine output and delegation cards. */
  _nextDurableEventOrdinal?: number
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
  // Model name for cost attribution
  model?: string
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

  /** 本 turn 入站用户文本的服务端权威快照(≤8000 字,dispatchInbound 每 turn 刷新)。
   *  审查任务书(buildTeamReviewContext)的"用户原始需求"取此,不采信模型自报。 */
  _currentTurnUserText?: string
  /** 本 turn 的 master canonical traceId(submit 每 turn 刷新,含 undefined 清除残留)。
   *  市场使用信号(skillUsageReporter)在 tool.called(hub skill_view)派发时经
   *  SessionManager.getByKey 同步读取,作为评分归因键。单一铸造权威在 master,此处只
   *  中转 submit 已确定的 turnTraceId,不参与铸造。engine 中立(runner.traceId 是 CCB/
   *  codex 私有、不在 EngineAdapter 契约上,故落到 session 提供统一读点)。 */
  _currentTurnTraceId?: string
  /** Stable logical turn key used by lossless persistence and cost joins. */
  _currentTurnKey?: string
  /** Browser user-row id bound to the submit that currently owns session.lock.
   * Unlike _activeTurnCount, this never describes queued submits. */
  _runningClientMessageId?: string

  /** RFC-v5-durable-turn-dispatch §4 — per-session recent-terminal ring
   * (cap 8: clientMessageId → outcome). autoResumeFromHello 用 hello 携带的
   * inFlightClientMessageId 精确对账:命中 completed → turn_completed reconcile
   * 帧带 id;命中中断类 → interrupted 帧带 id;未知 → turn_state_unknown。
   * 非持久化(重启后空 → 未知身份 → forceSync,不冒充终态)。 */
  _recentTerminalRing?: Array<{ clientMessageId: string; outcome: 'completed' | 'interrupted' | 'crashed' }>

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
): 'completed' | 'interrupted' | 'crashed' | undefined {
  return session._recentTerminalRing?.find((e) => e.clientMessageId === clientMessageId)?.outcome
}

function takeDurableEventOrdinal(session: AgentSession): number {
  const ordinal = session._nextDurableEventOrdinal ?? 0
  session._nextDurableEventOrdinal = ordinal + 1
  return ordinal
}

function combineRetryAssistantOutput(
  retrySegments: readonly SegmentRecord[],
  terminalText: string,
  terminalSegments: readonly SegmentRecord[],
  fallbackTs: number,
): { text: string; segments: SegmentRecord[] } {
  if (retrySegments.length === 0) {
    return { text: terminalText, segments: terminalSegments.map((segment) => ({ ...segment })) }
  }
  const tail = terminalSegments.length > 0
    ? terminalSegments
    : terminalText.length > 0
      ? [{ index: 0, text: terminalText, ts: fallbackTs }]
      : []
  const segments = [...retrySegments, ...tail].map((segment, index) => ({
    ...segment,
    index,
  }))
  return {
    text: retrySegments.map((segment) => segment.text).join('') + terminalText,
    segments,
  }
}

const TRANSIENT_RETRY_ERROR_CODES = new Set([
  'rate_limited',
  'model_capacity',
  'upstream_failed',
])

// Re-export from ccbMessageParser so existing imports keep working
export type { SessionStreamEvent } from './ccbMessageParser.js'

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

/** server-authored turn 持久化三态(见 TapePersistResult):把 V3MasterSink /
 *  legacy 本地写的结果收敛成 acked|queued|dropped 的单一权威分类。 */
function persistServerAuthoredTurnOutcome(args: {
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
      ...(args.continuationOfTurnKey
        ? { continuationOfTurnKey: args.continuationOfTurnKey }
        : {}),
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
      ...(args.agentGroups && args.agentGroups.length > 0
        ? { agentGroups: args.agentGroups }
        : {}),
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
    const uid = args.userId ?? ((await getClientSession(args.peerId))?.userId)
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

function activeGoalAttribution(session: AgentSession): {
  goalId: string
  goalStateRevision: number
} | undefined {
  const goal = session._platformGoal
  return goal?.status === 'active'
    ? { goalId: goal.goalId, goalStateRevision: goal.stateRevision }
    : undefined
}

function safeUsageCounter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

/** Partial/crash persistence must retain every token counter already observed.
 * Codex billing arrives before its final parser event, so it is also a valid
 * fallback if an exit races terminal materialization. */
function terminalUsageForPersistence(args: {
  finalMeta?: EngineFinalMeta
  billing?: EngineBillingEvent
  traceId?: string
  turnIndex: number
  model?: string
}): NonNullable<V3MasterSinkPayload['usage']> {
  const billingUsage = args.billing?.usage
  const billingTotal = [
    billingUsage?.input_tokens,
    billingUsage?.output_tokens,
    billingUsage?.cache_read_input_tokens,
    billingUsage?.cache_creation_input_tokens,
    billingUsage?.reasoning_output_tokens,
  ].reduce<number | undefined>((total, value) => {
    const safe = safeUsageCounter(value)
    return safe === undefined ? total : (total ?? 0) + safe
  }, undefined)
  const totalTokens = safeUsageCounter(args.finalMeta?.totalTokens) ?? billingTotal
  return {
    inputTokens:
      safeUsageCounter(args.finalMeta?.inputTokens) ?? safeUsageCounter(billingUsage?.input_tokens) ?? 0,
    outputTokens:
      safeUsageCounter(args.finalMeta?.outputTokens) ?? safeUsageCounter(billingUsage?.output_tokens) ?? 0,
    cacheReadTokens:
      safeUsageCounter(args.finalMeta?.cacheReadTokens) ??
      safeUsageCounter(billingUsage?.cache_read_input_tokens) ??
      0,
    cacheCreationTokens:
      safeUsageCounter(args.finalMeta?.cacheCreationTokens) ??
      safeUsageCounter(billingUsage?.cache_creation_input_tokens) ??
      0,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(args.model ? { model: args.model } : {}),
    turn: args.turnIndex,
    ...(args.traceId ? { traceId: args.traceId } : {}),
  }
}

function persistPostTerminalRuntimeEvent(args: {
  sessionKey: string
  sessionId: string
  turnIndex: number
  continuationOfTurnKey: string
  event: DurableRuntimeEvent
}): Promise<TapePersistResult> {
  const raw = JSON.stringify(args.event.payload)
  const identity = createHash('sha256')
    .update('oc-post-terminal-runtime-v1\0')
    .update(args.continuationOfTurnKey)
    .update('\0')
    .update(String(args.event.ordinal))
    .update('\0')
    .update(String(args.event.observedAt))
    .update('\0')
    .update(raw)
    .digest('hex')
  // 三态透传:tail 折叠区分 acked|queued(可靠,更新 hash/count/转发)与 dropped
  // (不更新 → 冻结的 marker / 变化 tail 下次重试)。persistServerAuthoredTurnOutcome
  // 在 commercial-managed 缺 sink 时会 throw(配置异常),兜底折成 dropped。
  return persistServerAuthoredTurnOutcome({
    sessionKey: args.sessionKey,
    peerId: args.sessionId,
    agentId: `tail_${identity.slice(0, 24)}`,
    userId: undefined,
    turnIndex: args.turnIndex,
    turnKey: createHash('sha256')
      .update('oc-post-terminal-tape-v1\0')
      .update(identity)
      .digest('hex'),
    continuationOfTurnKey: args.continuationOfTurnKey,
    createdAt: args.event.observedAt,
    text: '',
    status: 'completed',
    runtimeEvents: [structuredClone(args.event)],
  }).catch((err): TapePersistResult => {
    log.error(
      'post-terminal runtime persist threw',
      { sessionKey: args.sessionKey },
      err as Error,
    )
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

class TurnIdleTimeoutError extends Error {
  readonly code = 'TURN_IDLE_TIMEOUT'
}

class TurnHardLimitError extends Error {
  readonly code = 'TURN_HARD_LIMIT'
  constructor() {
    super('turn reached the platform 12 hour execution limit')
  }
}

export interface PromptQueueExecutionFence {
  readonly sessionKey: string
  readonly token: symbol
  release(): void
}

export class SessionManager {
  private sessions = new Map<string, AgentSession>()
  /** Queue execution uses the existing promise only as an execution mutex.
   * The WeakSet is the synchronous admission fence that rejects, rather than
   * queues, any second submit while that mutex is owned. */
  private _promptQueueExecutions = new WeakSet<AgentSession>()
  /** Engine switches replace AgentSession objects, so the invariant also needs
   * a stable logical-session fence that survives object replacement attempts. */
  private _promptQueueExecutionKeys = new Set<string>()
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
  /** Cooperative Stop grace before the gateway escalates to runner shutdown.
   * Private test seam; the production boundary remains five seconds. */
  private _terminalRequestGraceMs = 5_000
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
    session.lock = new Promise<void>((resolve) => { release = resolve })
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
      shouldRecycle =
        !binding || binding.selectionVersion !== newSnapshot.selectionVersion
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

  private resumeMapPath = join(paths.home, 'resume-map.json')

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
    const cleanup = (): void => { this._pendingPersistence.delete(p) }
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
        log.error(
          'post-terminal tail owner-chain task failed',
          { ownerTurnKey },
          err as Error,
        ),
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

  /** A1/F1/F1b/F2/F4/F6/F7 — 实际持久化一条 tail;达 owner/stream cap 时改持久化一条
   *  **冻结**的 capped marker。嵌套两级串行链:**session 链**保证本流内保序、**owner 链**
   *  把 cap 判定 + 计数增量 + 落定收进跨 session 临界区(F6:消灭共享 ownerTurnKey 的
   *  两 session 同读 count 超发)。四态:acked|queued → 转发 + 更新 hash + 计入预算 +
   *  进收集器;skipped(legacy 未落盘)→ 转发 + 更新 hash 但**不计预算/不进收集器**;
   *  dropped → 全不更新(marker/变化 tail 下次用同一冻结事件重试)。cap 恒被尊重
   *  (F7:terminal flush 不再豁免 cap,capped 后不写任何东西)。 */
  private _enqueueTailPersist(
    session: AgentSession,
    st: TailFoldStreamState,
    item: TailFoldItem,
  ): void {
    // 限频锚点:尝试时刻同步置位(而非落定时刻),给后续事件稳定的间隔判定。
    st.lastPersistAt = Date.now()
    // session 链:本流内保序;把预算临界区 + 持久化委托给 owner 链(session→owner)。
    this._chainTailPersist(session, () =>
      this._runOnOwnerChain(item.ownerTurnKey, async () => {
        const metrics = (session._tailFoldMetrics ??= {
          unchangedSuppressed: 0,
          rateCoalesced: 0,
          capped: 0,
        })
        // 迟到同内容:rapid-fire 的重复 tail 在首条落定前已排进 pending,落定后其 hash
        // 已等于 lastPersistedHash → 不重复落。
        if (item.hash === st.lastPersistedHash) {
          metrics.unchangedSuppressed++
          return
        }
        const owner = this._getOwnerBudget(item.ownerTurnKey)
        // 已封顶(stream 或 owner)→ 该流彻底停(不落不转);cap 恒尊重,无豁免。
        if (st.capped || owner.capped) return
        // owner cap:整 owner 只落一条冻结 marker,成功(acked|queued|skipped)后封停该
        // owner 全部流;dropped 则不封停,下次用同一冻结 marker 重试。
        if (owner.persistedCount >= this._tailFoldOwnerCap) {
          owner.markerEvent ??= this._buildTailCapMarker(item, 'owner_cap')
          const outcome = await persistPostTerminalRuntimeEvent({
            sessionKey: session.sessionKey,
            sessionId: item.ownerSessionId,
            turnIndex: item.turnIndex,
            continuationOfTurnKey: item.ownerTurnKey,
            event: owner.markerEvent,
          })
          if (outcome !== 'dropped') {
            owner.capped = true
            metrics.capped++
            log.warn('post-terminal tail OWNER capped', {
              sessionKey: session.sessionKey,
              ownerTurnKey: item.ownerTurnKey,
              ownerPersistedCount: owner.persistedCount,
            })
          }
          return
        }
        // per-stream cap:该流落一条冻结 marker,成功后停该流。
        if (st.persistedCount >= this._tailFoldStreamCap) {
          st.markerEvent ??= this._buildTailCapMarker(item, 'cap')
          const outcome = await persistPostTerminalRuntimeEvent({
            sessionKey: session.sessionKey,
            sessionId: item.ownerSessionId,
            turnIndex: item.turnIndex,
            continuationOfTurnKey: item.ownerTurnKey,
            event: st.markerEvent,
          })
          if (outcome !== 'dropped') {
            st.capped = true
            metrics.capped++
            log.warn('post-terminal tail stream capped', {
              sessionKey: session.sessionKey,
              ownerTurnKey: item.ownerTurnKey,
              toolUseId: item.toolUseId,
              persistedCount: st.persistedCount,
            })
          }
          return
        }
        // 真实 tail 持久化。
        const outcome = await persistPostTerminalRuntimeEvent({
          sessionKey: session.sessionKey,
          sessionId: item.ownerSessionId,
          turnIndex: item.turnIndex,
          continuationOfTurnKey: item.ownerTurnKey,
          event: item.event,
        })
        // dropped:全不更新(维持"转发的必已持久化",变化 tail 下次重试)。
        if (outcome === 'dropped') return
        // acked|queued|skipped 都更新 hash + 转发(去重前进)。
        st.lastPersistedHash = item.hash
        // acked|queued 才计入预算 + 进 delegate durable 收集器(skipped=未落盘,不占
        // 预算、不进收集器)。
        if (outcome === 'acked' || outcome === 'queued') {
          st.persistedCount++
          owner.persistedCount++
          session._durableDelegateRuntimeEvents?.push(structuredClone(item.event))
        }
        item.onEvent({ kind: 'block', block: item.block })
      }),
    )
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
        const outcome = await persistPostTerminalRuntimeEvent({
          sessionKey: session.sessionKey,
          sessionId: ownerSessionId,
          turnIndex,
          continuationOfTurnKey: ownerTurnKey,
          event,
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
  async recordExternalTurn(
    session: AgentSession,
    args: { userText: string; assistantText: string; requestId: string; traceId?: string; model?: string },
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
          legacySessionIds:
            legacyId && legacyId !== session.sessionKey ? [legacyId] : [],
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
      void indexTurn(session.sessionKey, turnIndex, args.userText, args.assistantText)
        .catch((err) => log.warn('external turn index failed', { sessionKey: session.sessionKey, turnIndex }, err))
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
      legacySessionIds:
        legacyId && legacyId !== session.sessionKey ? [legacyId] : [],
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
  async beginExternalTurn(
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
    session.lock = new Promise<void>((resolve) => { release = resolve })
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
        this.endClientTurn(session, outcome)
        if (queueTurn) {
          this._promptQueueExecutions.delete(session)
          this._promptQueueExecutionKeys.delete(session.sessionKey)
        }
        release()
      },
    }
  }

  // Resume map: sessionKey → ccbSessionId (survives gateway restart)
  private _resumeMap = new Map<string, string>()
  // Parallel map: sessionKey → runner provider that produced the id.
  // Needed to keep codex thread_ids and CCB session_ids from being cross-fed
  // when the same sessionKey is later served by a different provider.
  // Legacy entries without explicit provider are treated as 'ccb' on load.
  private _resumeMapProvider = new Map<string, string>()
  // Serialized write queue to prevent concurrent writeFile race conditions
  private _resumeMapWrite: Promise<void> = Promise.resolve()

  /** Provider name for CCB-backed runners (default). Used as the fallback
   *  tag when an on-disk resume-map entry omits `provider` (legacy format). */
  private static CCB_PROVIDER_TAG = 'ccb'

  /** Return the resumable id for this session iff the persisted entry was
   *  produced by `wantProvider`. Cross-provider mismatches return undefined
   *  so we never feed a CCB session_id to codex (or vice versa).
   *
   *  For CCB, also validate that the session's JSONL file exists on disk.
   *  If the file was wiped (e.g. CLAUDE_CONFIG_DIR projects directory was
   *  reset — pre-2026-04-22 tmpfs on v3 containers was ephemeral),
   *  pretending to --resume yields a "No conversation found with session ID"
   *  crash and a scary "AI 进程异常退出" banner. Pre-detect and drop the
   *  entry so the next spawn starts a fresh session silently — UI history
   *  stays visible (it lives in the DB), but CCB has no memory of previous
   *  turns (unavoidable when the JSONL is gone). */
  private _resumeIdFor(sessionKey: string, wantProvider: string): string | undefined {
    const id = this._resumeMap.get(sessionKey)
    if (!id) return undefined
    const tag = SessionManager.normalizeEngineTag(this._resumeMapProvider.get(sessionKey))
    if (tag !== wantProvider) return undefined
    if (tag === SessionManager.CCB_PROVIDER_TAG && !this._ccbJsonlExists(id)) {
      log.warn('resume-map entry points to missing JSONL — dropping silently', {
        sessionKey,
        resumeId: id,
      })
      this._resumeMap.delete(sessionKey)
      this._resumeMapTimestamps.delete(sessionKey)
      this._resumeMapProvider.delete(sessionKey)
      this._resumeMapLastCost.delete(sessionKey)
      this._saveResumeMap()
      return undefined
    }
    return id
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

  /** M1a:resume-map provider tag 的历史值归一。旧格式在 P1f 前写过
   *  'codex-native'(provider 语义);engine 维度泛化后统一为 engine id
   *  'codex',其余(含缺省)一律 'ccb'。加载与比较都过这一个函数,
   *  防新旧 tag 混用导致 resume 条目被误判跨底座。 */
  private static normalizeEngineTag(tag: string | undefined): string {
    if (tag === 'codex-native' || tag === 'codex') return 'codex'
    return SessionManager.CCB_PROVIDER_TAG
  }

  private _loadResumeMap(): void {
    // Try primary file first, fall back to backup if corrupted (atomic-write safety net)
    for (const path of [this.resumeMapPath, this.resumeMapPath + '.bak']) {
      try {
        if (!existsSync(path)) continue
        // File mtime acts as the lower-bound timestamp for entries that lack
        // their own `ts` (pre-Phase-0.2 legacy string values). Using Date.now()
        // here would reset the TTL clock on every gateway restart, letting
        // stale entries live forever — that's the bug this fixes. If stat
        // fails (race with atomic-rename), fall back to 0 so _pruneResumeMap
        // treats the entry as unknown-age and evicts it on first sweep.
        let fileMtime = 0
        try {
          fileMtime = statSync(path).mtimeMs
        } catch {}
        const data = JSON.parse(readFileSync(path, 'utf-8'))
        // Support both legacy format {key: sessionId} and new format
        // {key: {id, ts, lastCost?, provider?}}
        // Missing `provider` → treated as CCB (the only provider before
        // codex-native landed), matching _resumeIdFor's fallback.
        for (const [key, val] of Object.entries(data)) {
          if (typeof val === 'string') {
            this._resumeMap.set(key, val)
            this._resumeMapTimestamps.set(key, fileMtime)
            this._resumeMapProvider.set(key, SessionManager.CCB_PROVIDER_TAG)
          } else if (val && typeof val === 'object' && 'id' in (val as any)) {
            this._resumeMap.set(key, (val as any).id)
            this._resumeMapTimestamps.set(key, (val as any).ts ?? Date.now())
            // Optional cost-delta baseline for the resumed CCB. If present,
            // CCB will restore STATE.totalCostUSD to this value and the
            // gateway needs the same baseline to compute correct per-turn
            // deltas on the first post-resume `result`.
            const lastCost = (val as any).lastCost
            if (typeof lastCost === 'number' && Number.isFinite(lastCost) && lastCost >= 0) {
              this._resumeMapLastCost.set(key, lastCost)
            }
            const prov = (val as any).provider
            // M1a:tag 归一为 engine id(历史 'codex-native' → 'codex')。
            this._resumeMapProvider.set(
              key,
              SessionManager.normalizeEngineTag(
                typeof prov === 'string' && prov ? prov : undefined,
              ),
            )
          }
        }
        return // Successfully parsed (even if empty — empty means all sessions were destroyed)
      } catch {
        log.warn('failed to load resume-map', { path })
      }
    }
  }

  private _saveResumeMap(): void {
    // Merge: start from the loaded resume-map (includes sessions not yet re-activated),
    // then overlay with live sessions (which may have updated ccbSessionIds after resume).
    type ResumeEntry = { id: string; ts: number; lastCost?: number; provider?: string }
    const obj: Record<string, ResumeEntry> = {}
    const now = Date.now()
    for (const [key, val] of this._resumeMap) {
      const entry: ResumeEntry = {
        id: val,
        ts: this._resumeMapTimestamps.get(key) ?? now,
      }
      const cached = this._resumeMapLastCost.get(key)
      if (cached !== undefined && cached > 0) entry.lastCost = cached
      // Only serialize provider when it differs from the implicit 'ccb' default
      // so legacy tooling that reads this file sees no unexpected new fields
      // for CCB sessions.
      const prov = this._resumeMapProvider.get(key)
      if (prov && prov !== SessionManager.CCB_PROVIDER_TAG) entry.provider = prov
      obj[key] = entry
    }
    for (const [key, sess] of this.sessions) {
      if (sess.ccbSessionId) {
        const entry: ResumeEntry = {
          id: sess.ccbSessionId,
          ts: now,
        }
        if (sess._lastCcbCumulativeCost > 0) entry.lastCost = sess._lastCcbCumulativeCost
        const prov = this._resumeMapProvider.get(key)
        if (prov && prov !== SessionManager.CCB_PROVIDER_TAG) entry.provider = prov
        obj[key] = entry
        // Keep in-memory maps in sync
        this._resumeMap.set(key, sess.ccbSessionId)
        this._resumeMapTimestamps.set(key, now)
        this._resumeMapLastCost.set(key, sess._lastCcbCumulativeCost)
      }
    }
    const data = JSON.stringify(obj, null, 2)
    // Atomic write: write to .tmp, then rename (rename is atomic on Linux/ext4)
    const tmpPath = this.resumeMapPath + '.tmp'
    const bakPath = this.resumeMapPath + '.bak'
    this._resumeMapWrite = this._resumeMapWrite
      .then(async () => {
        await writeFile(tmpPath, data)
        // Backup current file before overwriting (fallback if crash during rename)
        try {
          if (existsSync(this.resumeMapPath)) {
            await rename(this.resumeMapPath, bakPath)
          }
        } catch {}
        await rename(tmpPath, this.resumeMapPath)
      })
      .catch((err) => log.error('resume-map write failed', {}, err))
  }

  /** Await any pending resume-map disk writes (used by shutdown to prevent data loss).
   *  Loops until the write promise stabilizes — handles late writes queued during await. */
  async awaitResumeMapFlush(): Promise<void> {
    let prev: Promise<void> | null = null
    while (prev !== this._resumeMapWrite) {
      prev = this._resumeMapWrite
      await prev
    }
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
      throw new Error(
        'PROMPT_QUEUE_EXECUTION_INVARIANT: logical session already owns runtime work',
      )
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
    return fence !== undefined &&
      fence.sessionKey === sessionKey &&
      this._promptQueueDispatchFences.get(sessionKey) === fence.token
  }

  async getOrCreate(opts: {
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
      engine: 'ccb' | 'codex'
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
    /** Static CCB --json-schema contract for one-shot structured output. */
    structuredOutputSchema?: Readonly<Record<string, unknown>>
    /** delegate 子会话计费归因(仅 handleDelegateTask 设置)→ runner
     *  CLAUDE_CODE_EXTRA_METADATA env → master 计费点落
     *  usage_records.mode/parent_session_id/delegate_agent_id。
     *  Spawn-time attribute(delegate sessionKey 带时间戳一次性,不存在复用)。 */
    usageAttribution?: UsageAttributionTag
  }): Promise<AgentSession> {
    const ownsDispatchFence = this._ownsPromptQueueExecutionFence(
      opts.sessionKey,
      opts.promptQueueExecutionFence,
    )
    if (
      (opts.promptQueueExecutionFence && !ownsDispatchFence) ||
      (this._promptQueueDispatchFences.has(opts.sessionKey) && !ownsDispatchFence)
    ) {
      throw new Error(
        'PROMPT_QUEUE_EXECUTION_INVARIANT: queue preflight owns this logical session',
      )
    }
    // 新建时 null 等同 undefined(都让 CCB 用模型默认)
    const initialEffort: string | undefined =
      opts.effortLevel === null ? undefined : opts.effortLevel

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
    )
    // flag 门(§3):托管 + OC_MODEL_AUTHORITY=1 时,**无 master 权威一律不许创建 runner**。
    // 判定放在 resolveEngine 内部(engine 判定的单一收口),这里只把 flag 传进去 ——
    // 于是"所有无 envelope 的 runner 创建入口"的完整性不再依赖人工枚举:createEngine 的
    // 唯一调用者就是本函数,任何漏取 catalog 投影的入口都会在这里 fail-closed 炸出来。
    const engineId = resolveEngine(executionModel, opts.agent, opts.executionAuthority, {
      requireAuthority: isModelAuthorityRequired(),
    })
    const existing = this.sessions.get(opts.sessionKey)
    const workspaceMode = opts.workspaceMode ?? existing?.workspaceMode ?? 'legacy'
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
      if (existing.providerTag !== desiredEngine || workspaceModeChanged) {
        if (
          this._promptQueueExecutionKeys.has(opts.sessionKey) ||
          (this._promptQueueDispatchFences.has(opts.sessionKey) && !ownsDispatchFence)
        ) {
          throw new Error(
            'PROMPT_QUEUE_EXECUTION_INVARIANT: engine switch cannot replace an active queue session',
          )
        }
        // Same logical client session, but the desired engine changed (model
        // switch across engines, or agent switched between CCB and Codex).
        // Native resume ids are engine-specific, so tear down the old runner
        // and let the fresh one receive a compact transcript preamble on its
        // first submit().
        try {
          await existing.lock
          await existing.runner.shutdown()
        } catch (err) {
          log.warn('session-replacement shutdown failed', {
            sessionKey: opts.sessionKey,
            engineChanged: existing.providerTag !== desiredEngine,
            workspaceModeChanged,
          }, err)
        }
        this.sessions.delete(opts.sessionKey)
      } else {
        existing.lastUsedAt = Date.now()
        if (opts.title && (!existing.title || existing.title === 'New conversation'))
          existing.title = opts.title
        // Adopt a userId from a later call if the session was first created
        // without one (e.g. cron pre-warmed, then a webchat user attached).
        // Never *overwrite* an already-set userId — doing so would enable a
        // different authenticated user to redirect another user's persistence.
        if (opts.userId && !existing.userId) existing.userId = opts.userId
        if (opts.repoSessionId && !existing.repoSessionId) existing.repoSessionId = opts.repoSessionId
        if (opts.parentSessionKey && !existing.parentSessionKey)
          existing.parentSessionKey = opts.parentSessionKey
        return existing
      }
    }
    // 显式 pin 的 agent cwd(如 repo session)优先,永不被 workspace 缺省覆盖;
    // 仅在没有显式 cwd 时用 OPENCLAUDE_DEFAULT_WORKSPACE(存在且是目录)/否则 process.cwd()。
    const repoSessionId = opts.repoSessionId ?? opts.peerId
    const cwd = opts.agent.cwd ?? resolveDefaultWorkspaceCwd(workspaceMode, repoSessionId)
    const persona = opts.hermeticNoTools
      ? undefined
      : opts.agent.persona ?? paths.agentClaudeMd(opts.agent.id)
    // M0/M1a engine 适配层:runner 构造收口到 registry factory。
    //   - executionModel / engineId 已在函数头部一次收口(见上方注释)——
    //     teardown 判定与构造用同一份解析结果,不会出现"比较用 A、spawn 用 B"。
    //   - createEngine 对未注册 engine fail-closed 抛错(原 v5 channel 硬闸的
    //     语义升级形态:任何 channel 都不会把未注册 engine 静默落到 CCB)。
    const runner = createEngine(engineId, {
      sessionKey: opts.sessionKey,
      agentId: opts.agent.id,
      agentBaseDir: cwd,
      config: this.config,
      persona,
      model: executionModel,
      permissionMode: opts.agent.permissionMode ?? this.config.defaults.permissionMode,
      agentProvider: opts.agent.provider,
      agentMcpServers: opts.agent.mcpServers,
      agentToolsets: opts.agent.toolsets ?? this.config.defaults.toolsets,
      delegationDepth: opts.delegationDepth,
      // Symmetrically: only resume from an id produced by the SAME engine
      // (resume-map 按 engine 维度隔离,防 codex thread_id 与 CCB session_id
      // 互喂)。_resumeIdFor also drops the entry silently when the CCB JSONL
      // was wiped (pre-2026-04-22 v3 containers' tmpfs was ephemeral).
      resumeSessionId: opts.hermeticNoTools
        ? undefined
        : this._resumeIdFor(opts.sessionKey, engineId),
      effortLevel: initialEffort,
      // Phase 5:repoSessionId 默认等于 peerId;delegate_task 可传父 webchat
      // session id 作为 repo lookup key,但不改变 delegate 自己的 peerId。
      // getRepoSnapshot 由 Gateway 构造器注入。
      sessionId: repoSessionId,
      getRepoSnapshot: this._getRepoSnapshot,
      workload: opts.workload,
      skillTrainRunId: opts.skillTrainRunId,
      skillEvalMode: opts.skillEvalMode,
      skillEvalExclude: opts.skillEvalExclude,
      skillEvalDraft: opts.skillEvalDraft,
      usageAttribution: opts.usageAttribution,
      hermeticNoTools: opts.hermeticNoTools,
      structuredOutputSchema: opts.structuredOutputSchema,
    })
    const now = Date.now()
    const session: AgentSession = {
      sessionKey: opts.sessionKey,
      agentId: opts.agent.id,
      channel: opts.channel ?? 'webchat',
      peerId: opts.peerId ?? 'unknown',
      userId: opts.userId,
      workspaceMode,
      repoSessionId,
      title: opts.title ?? 'New conversation',
      // delegate 子会话的直接父指针(webchat/普通会话为 undefined)。物化父链使委派进度
      // 可向上追溯 webchat 祖先;不影响 _sessionIdToKey / peerId 身份。
      parentSessionKey: opts.parentSessionKey,
      _billingParentTurnKey: opts.usageAttribution?.parentTurnKey,
      _usageAttribution: opts.usageAttribution
        ? { ...opts.usageAttribution }
        : undefined,
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
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      turns: 0,
      _lastCcbCumulativeCost: this._lastCostFor(opts.sessionKey, engineId) ?? 0,
      // 与 runner 同一份白名单收敛结果(见上方 executionModel 注释)。
      model: executionModel,
      toolUseIdToName: new Map(),
      executionTarget: { kind: 'local' },
      // Phase 5 G.0 → M1a:固化 engine 路由信息(字段名保留 providerTag),
      //   recyclePeerForRepoChange / pickIdleTimeoutMs 用它
      //   走 codex 专属重置分支(避免 instanceof / runner.constructor.name)。
      providerTag: engineId,
      agentProvider: opts.agent.provider,
    }
    runner.on('session_id', (id: string) => {
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
      if (!info.resumed) {
        session._lastCcbCumulativeCost = 0
      }
    })
    // Monitor subprocess crashes — emit event so gateway can notify connected clients
    runner.on('exit', (info: { code: number | null; signal: string | null; crashed: boolean }) => {
      // 子进程退出 → 清空 turn_status 缓存。crashed/正常 exit 都清:正常 exit
      // 意味着没有 in-flight turn(也就不会还有 compacting);crashed 期间如果
      // 恰好在 compact 中,这帧 cache 没有 turn_status:null 来源(子进程死了
      // 不会再 emit setSDKStatus(null)),不清会让后续 autoResumeFromHello
      // 误推 compacting 给重连客户端。
      session.currentTurnStatus = null
      if (info.crashed) {
        log.warn('subprocess crashed', { sessionKey: opts.sessionKey, code: info.code, signal: info.signal })
        // If the most recent turn failed because the --resume session id on
        // disk is stale (CCB: "No conversation found with session ID: ..."),
        // evict the entry so the next submit() starts a fresh CCB session.
        // Without this, every restart re-spawns CCB with the same dead id,
        // producing the same error, and the subprocess never boots.
        if (session._pendingStaleResumeClear) {
          this._resumeMap.delete(opts.sessionKey)
          this._resumeMapTimestamps.delete(opts.sessionKey)
          this._resumeMapProvider.delete(opts.sessionKey)
          this._resumeMapLastCost.delete(opts.sessionKey)
          session.ccbSessionId = null
          session._pendingStaleResumeClear = false
          // Also forget the id inside the runner — otherwise submit()'s next
          // start() reads it back as resumeSessionId and --resume the same
          // dead id again.
          session.runner.clearSessionId?.()
          this._saveResumeMap()
        } else if (session.ccbSessionId) {
          // Ensure the session stays in resume-map so it can be restored on next submit()
          // (SubprocessRunner.submit() auto-restarts with --resume when proc is null)
          this._resumeMap.set(opts.sessionKey, session.ccbSessionId)
          this._saveResumeMap()
        }
        // Notify via eventBus so gateway can push a reconnect hint to the client
        eventBus.emit('session.crashed', createEvent('session.crashed', session.agentId, {
          sessionKey: opts.sessionKey,
          peerId: session.peerId,
          ccbSessionId: session.ccbSessionId,
        }))
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
  }

  async submit(
    session: AgentSession,
    userTextOrBlocks: string | Array<{ type: string; [key: string]: unknown }>,
    onEvent: (e: SessionStreamEvent) => void,
    /** 来自 InboundMessage.effortLevel,用于本条消息开始执行**之前**调整 runner 的
     *  CLAUDE_CODE_EFFORT_LEVEL(env 仅在 CCB 启动时读,所以"切档"= shutdown 触发
     *  下一次 submit 重启子进程):
     *    - string         : 设成该值
     *    - null           : 显式清除(回到模型默认 effort)
     *    - undefined      : caller 没指定,不动
     *
     *  effort 应用、prev await、本 turn 的 _runOneTurn 全部串在同一个新 lock 里;
     *  闭包捕获 desiredEffort 后,后到的 submit() 不会污染本 turn 的 effort。 */
    effortLevel?: string | null,
    /** 来自 InboundMessage.model(2026-04-26 v1.0.4 起加),用于本条消息开始执行
     *  **之前**切换 runner 的 --model:
     *    - string    : caller 想用此 model — 与 runner.model 不同 → 触发 setModel + shutdown
     *    - undefined : caller 没指定,沿用 runner 当前 model(没有"清除回 agent 默认"语义)
     *
     *  与 effortLevel 共用同一把 lock + 同一次 shutdown(若 model 与 effort 都变,
     *  两次 setX 后只 shutdown 一次,避免双 warn 噪声 + 双 race)。 */
    model?: string,
    /** PR2 v1.0.66 — server-owned requestId(来自 InboundMessage.requestId,master 强制写)。
     *  仅 codex-native runner 路径消费:CodexAppServerRunner.submit 把它挂在 queue
     *  entry 上,turn 结束 emitResult 时回带,sessionManager 路由成 'codex_billing'
     *  SessionStreamEvent → server.ts 发 outbound.codex_billing 帧。
     *
     *  其它 runner(claude / minimax / 等)完全不读这个字段,纯透传 noop。
     *  缺省 / 非 codex agent → 不参与真扣费链路,Anthropic 路径走 anthropicProxy 自己的扣费。 */
    requestId?: string,
    /** V3 S12e CG7 — master-authoritative turn-level trace id(Contract B).
     *  Currently consumed only by submit-layer warn/error logs(effort/model-
     *  change shutdown failure, idle-timeout interrupt)so an operator grepping
     *  on traceId can correlate gateway-side submit failures with the turn's
     *  outbound frames. _runOneTurn / runOneTurnWithRetry internal logs
     *  (phantom/auth/transient/parse_error)are NOT in CG7 scope — they'll be
     *  threaded in CG8 together with the subprocessRunner env injection so
     *  the whole turn-internal log path lands as one coherent step. */
    traceId?: string,
    /** Codex-native app-server only. Omitted means default mode so a previous
     *  plan-only turn cannot leak into ordinary follow-up turns. */
    conversationMode?: 'default' | 'plan',
    opts?: {
      historicalMessages?: unknown[]
      /** v5 codex route 消费链(A1):dispatchInbound 校验后的 per-turn provider
       *  路由覆盖。每 turn 显式 set(null = 清除 stale route);仅 codex engine
       *  runner 实现 setCodexRoute,其余 runner duck-type 缺方法 → noop。 */
      codexRoute?: CodexProviderConfigOverride | null
      /** Master-authored platform goal snapshot for this exact turn. null
       * explicitly clears stale engine state; omission is for legacy callers. */
      platformGoal?: GoalStateSnapshot | null
      toolsets?: string[]
      collabAgentPolicy?: CollabAgentPolicy
      /** 模型权威批次 §4:本 turn 的上游请求凭据(master 签名 authority + turn lease)。
       *  只有 **bridge turn** 有(server.ts dispatchInbound 从验签产物 TurnExecutionDescriptor
       *  原样取出);cron/synthetic/delegate/train 等本地路径 submit 不传 —— CCB runner
       *  自取 `x-oc-local-catalog` token(方案 §3/§4),清位语义在 runner 内单一收口。 */
      modelAuthority?: TurnModelAuthority
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
    },
  ): Promise<void> {
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
      isCommercialManagedRuntime()
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
    // 闭包捕获:即便后面再有 submit 也不会改这个常量
    const desiredEffort: string | undefined =
      effortLevel === null ? undefined : effortLevel
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
        memoryTurnBarrier = await new MemoryDir(session.agentId).acquireSharedBarrier()
      }
      // V3 S12e CG8 — contract C(best-effort)stash latest turn trace on runner
      // so that ANY re-spawn triggered inside this turn — effort/model change
      // shutdown(下方 effortChanged/modelChanged 分支)、phantom restart
      // (runOneTurnWithRetry)、auth refresh restart — picks it up via
      // `OPENCLAUDE_TRACE_ID` env at next spawn time. No effect on a long-lived
      // CCB process(env is read at fork); 后续 turn CCB 内部 trace 接收待 S11c
      // stdin JSON-RPC 扩展。Lock 保证 setTraceId 与并发 submit() 串行,不会
      // 跨 turn 互踩。
      if (traceId !== undefined) session.runner.setTraceId(traceId)
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
      // effort + model 应用都必须在本 turn 真正启动**之前**完成,且必须在 prev 之后:
      //   - prev 之前:可能中断别人的 in-flight turn
      //   - 本 turn 之后:env / cli args 已被 CCB 启动时读完,改也无效
      // 同时受 lock chain 保护,后到的 submit 想 set 别的 effort/model 也得排在我们后面。
      // 把 effort/model 的 needsRestart 信号合并 → 一次 shutdown(下次 submit 自动 spawn 用新 effort+model)。
      const effortChanged =
        callerSpecifiedEffort && session.runner.effortLevel !== desiredEffort
      const modelChanged = callerSpecifiedModel && session.runner.model !== desiredModel
      const runnerToolsets = (session.runner as any).toolsets
      const maybeSetToolsets = (session.runner as any).setToolsets
      const toolsetsChanged =
        callerSpecifiedToolsets &&
        typeof maybeSetToolsets === 'function' &&
        !sameToolsetsForCompare(runnerToolsets, desiredToolsets)
      if (effortChanged) session.runner.setEffortLevel(desiredEffort)
      if (modelChanged) {
        session.runner.setModel(desiredModel)
        // 同步更新 session.model,outbound 帧 / metrics / audit 都靠它,避免
        // 下次 spawn 前的窗口期 stale。runner.model 要等 spawn 才生效;但 shutdown
        // 已让 runner 死,窗口期内不会产生新 metrics —— session.model 提前对齐安全。
        // 最后兜底用 glm-5.2(平台默认、v3/v5 都合法的静态 key 模型)。
        // 不再硬编码 claude-opus-4-7 —— Claude 官方模型已下线,那会造出非法默认 → spawn 失败。
        session.model = desiredModel ?? this.config.defaults.model ?? 'glm-5.2'
      }
      if (toolsetsChanged) {
        maybeSetToolsets.call(session.runner, desiredToolsets)
      }
      if (effortChanged || modelChanged || toolsetsChanged) {
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
      const masterHistoricalMessages = Array.isArray(opts?.historicalMessages)
        ? opts.historicalMessages
        : null
      const mergePendingExternalHistory = (messages: unknown[]): unknown[] => {
        const pending = session._pendingExternalExchanges
        if (!pending?.length) return messages
        const ids = new Set(
          messages
            .filter((raw): raw is { id: string } =>
              !!raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string')
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
            return msg.role === 'user'
              && normForCompare(extractHistoryText(msg)) === normForCompare(exchange.user.text)
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
      const contextOverflowHistoryChars = effectiveMasterHistoricalMessages?.reduce<number>(
        (total, raw) => {
          if (!raw || typeof raw !== 'object') return total
          const msg = raw as ChatHistoryMessage
          if (msg.system === true || !modelHistorySemanticRole(msg)) return total
          return total + modelHistorySemanticText(msg).length
        },
        0,
      ) ?? 0
      const contextOverflowRetryInputs =
        effectiveMasterHistoricalMessages &&
        typeof userTextOrBlocks === 'string' &&
        contextOverflowHistoryChars > 0
          ? [4, 16, 64]
              .map((divisor) => buildHistoricalContextPrompt(
                effectiveMasterHistoricalMessages,
                userTextOrBlocks,
                Math.max(1, Math.ceil(contextOverflowHistoryChars / divisor)),
              ))
              .filter((prompt): prompt is string => prompt !== null)
          : []
      let providerResumeId = this._resumeIdFor(session.sessionKey, session.providerTag)
      const injectionKey = historicalContextInjectionKey({
        messages: effectiveMasterHistoricalMessages,
        peerId: session.peerId,
        agentId: session.agentId,
        hasProviderResumeId: !!providerResumeId,
      })
      if (providerResumeId && injectionKey !== null) {
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
        session.ccbSessionId = null
        session.runner.clearSessionId?.()
        this._saveResumeMap()
        session._historicalContextInjected = false
        session._historicalContextInjectedKey = undefined
        providerResumeId = undefined
      }
      if (
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
            effectiveMasterHistoricalMessages ??
            mergePendingExternalHistory(
              (await getEngineContextMessages(
                session.peerId,
                session.userId ?? 'default',
                {
                  contextWindow:
                    opts?.modelAuthority?.executionDescriptor.contextWindow ??
                    (session.providerTag === 'codex' ? null : undefined),
                  engine: session.providerTag,
                  currentUserText: typeof userTextOrBlocks === 'string' ? userTextOrBlocks : '',
                  ...(opts?.replayLifecycle?.clientMessageId
                    ? { excludeClientMessageId: opts.replayLifecycle.clientMessageId }
                    : {}),
                },
              )) ?? [],
            )
          const historicalPrompt = historyMessages && typeof userTextOrBlocks === 'string'
            ? buildHistoricalContextPrompt(historyMessages, userTextOrBlocks)
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
              injectionKey: session._historicalContextInjectedKey,
              messageCount: injectedCount,
            })
            // §2.3 boss 硬指标 3:兜底注入成功 = 引擎无法原生续接、上下文被重建 → 主动
            // 提醒用户(仅当上层传了回调,即 webchat leader turn;内部子 turn 不提醒)。
            // 回调抛错不能打断 turn —— 提示是尽力而为的 UX,吞掉即可。
            try {
              opts?.emitContextRebuilt?.({ messageCount: injectedCount })
            } catch (emitErr) {
              log.warn('emit sys.context_rebuilt failed', { sessionKey: session.sessionKey }, emitErr)
            }
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
          const idleMs = Date.now() - session.runner.lastActivityAt
          // pendingToolCalls 经 adapter 读当前活跃 turn 的 parser(turn 间为 0),
          // 语义与旧 session._currentParser?.pendingToolCalls 一致。
          const threshold = pickIdleTimeoutMs(
            session.currentTurnStatus,
            session.runner.pendingToolCalls,
            session.providerTag,
          )
          if (idleMs > threshold) {
            const error = new TurnIdleTimeoutError(
              `idle timeout (${Math.round(idleMs / 1000)}s no output)`,
            )
            logicalTurnAbort.abort(error)
            reject(error)
          }
        }, CHECK_INTERVAL)
      })
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
        contextOverflowRetryInputs,
        opts?.automaticRetryState,
      )
      try {
        await Promise.race([
          logicalTurnRun,
          livenessPromise,
        ])
      } finally {
        if (livenessTimer) clearInterval(livenessTimer)
      }
    } catch (err: any) {
      if (err instanceof TurnIdleTimeoutError || err?.code === 'TURN_IDLE_TIMEOUT') {
        const persistTimedOutTurn = session._persistActiveTurn
        // Actually interrupt the runner so the subprocess stops
        try { session.runner.interrupt() } catch {}
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
        try { session.runner.interrupt() } catch {}
        const reason = '任务已达到 12 小时运行上限，系统已中断。本轮已自动免单，积分将原路退回；请重新发起。'
        if (persistLimitedTurn) {
          const persistence = persistLimitedTurn(
            'interrupted',
            reason,
            'TURN_LIMIT',
            'turn_limit',
          )
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
            log.warn('active-turn replay before-release hook failed', { sessionKey: session.sessionKey }, err)
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
          session._activeTurnCount = Math.max(0, (session._activeTurnCount ?? 0) - 1)
          session._currentTurnKey = undefined
          session._currentDispatch = undefined
          if (queueTurn) {
            this._promptQueueExecutions.delete(session)
            this._promptQueueExecutionKeys.delete(session.sessionKey)
          }
          release()
        }
      }
    }
  }

  private async runOneTurnWithRetry(
    session: AgentSession,
    userTextOrBlocks: string | Array<{ type: string; [key: string]: unknown }>,
    onEvent: (e: SessionStreamEvent) => void,
    requestId?: string,
    /** V3 S12e CG8 — turn-level trace id propagated from submit(). Tagged on
     *  all turn-internal warn/error logs(phantom/auth/transient/parse_error/
     *  staleResume/skipped/willCallApi/FTS5/verification verdict)so an
     *  operator grepping on traceId sees the entire turn's gateway-side trail.
     *  Sub-30 minute lifetime — scoped to this turn's retry budget. */
    traceId?: string,
    collabAgentPolicy?: CollabAgentPolicy,
    /** 模型权威批次 §4:本 turn 的上游凭据。短 authority 只约束
     *  「开始执行」；turn 内(含 phantom/transient 重试)复用同一份逻辑
     *  lease，并由 CCB adapter 定期向 master 续签。安全撤销仍由 egress 每请求
     *  epoch fence 兜住，不靠 lease 自然过期。 */
    modelAuthority?: TurnModelAuthority,
    /** Validated browser user-row id for exact durable attribution. */
    clientMessageId?: string,
    /** RFC-v5-durable-turn-dispatch §3 — 本 turn 的 durable inbox 准入身份。
     *  webchat-DM durable turn 才有;用于**模型调用前**落 inbox running + turn-end
     *  tape 带 dispatchId。 */
    dispatchContext?: AgentSession['_currentDispatch'],
    queueLifecycle?: {
      readonly queueTurn: true
      onTurnReserved(reservation: {
        turnIndex: number
        turnKey: string
        traceId?: string
      }): Promise<void>
    },
    /** Platform liveness/hard-limit cancellation for the complete logical
     * turn. This fence sits above individual EngineTurnRun generations. */
    logicalTurnSignal?: AbortSignal,
    /** Fresh-thread prompts with progressively smaller exact history suffixes.
     * Used only after a real Codex context-window rejection. */
    contextOverflowRetryInputs: string[] = [],
    automaticRetryState?: AutomaticRetryState,
  ): Promise<void> {
    const retryState: AutomaticRetryState = automaticRetryState ?? {
      rootClientMessageId: clientMessageId ?? session.sessionKey,
      attempt: 0,
      max: AUTOMATIC_TURN_RETRY_MAX,
    }
    // PHANTOM_TURN 用独立计数器,不和 transient 共用 attempt budget。
    // 第 0 次 phantom → 重启子进程 + retry 1 次;第 1 次还是 phantom → 终态 error,不再重试。
    let phantomRetryUsed = false

    // V3 v7 — Canonical assistant/thinking message ids for this user turn.
    // Computed ONCE here and shared by:
    //   1. CcbMessageParser (stamps text/thinking blocks emitted by the model)
    //   2. retry/auth/transient status text emits below (so they don't claim
    //      a separate m-* row that would later prevent canonical id adoption)
    //   3. Phase 0.1 turn-end takeover (persistServerAuthoredTurn legacy
    //      path + master internalServerAuthored.ts handler use the identical
    //      formula `srv-${peerId}-${agentId}-t${turnIndex}` and `${...}-thinking`)
    //
    // Reserve the turn id durably before any model output. FTS/session metadata
    // are post-result indexes and can lag or be absent for interrupted turns;
    // using them alone lets a process restart reuse tN and collide with an
    // immutable tape already ACKed (or queued locally). A reservation is never
    // rolled back; failed/empty turns may leave harmless gaps.
    //
    // 2026-05-13 — agentId segment added to disambiguate mid-chat model
    // switches. A chat that flips from codex to main keeps the same
    // peerId, but server creates a new AgentSession whose `session.turns`
    // restarts at 0; without agentId, turn 1 of codex and turn 1 of main
    // both stamp `srv-${peerId}-t1` and the client merges two answers
    // into one row. AgentId is part of sessionKey already so each
    // AgentSession naturally has its own agentId in scope here.
    //
    // Retry attempts within this loop SHARE these ids: a user turn that
    // gets retried for phantom/auth/transient errors is still one logical
    // assistant message from the user's perspective.
    const legacyId = this._resumeMap.get(session.sessionKey)
    const projectedTurnIndex = await reserveTurnIndex(session.sessionKey, {
      minimumLastTurn: session.turns,
      legacySessionIds:
        legacyId && legacyId !== session.sessionKey ? [legacyId] : [],
    })
    // CcbMessageParser increments this reference on a real result. Seed it to
    // the slot immediately before the reservation so the result lands exactly
    // on projectedTurnIndex; partial/crash persistence uses the same slot.
    session.turns = projectedTurnIndex - 1
    const turnKey = deriveLosslessTurnKey({
      sessionId: session.peerId,
      agentId: session.agentId,
      turnIndex: projectedTurnIndex,
      status: 'completed',
      text: '',
    })
    session._currentTurnKey = turnKey
    session._nextDurableEventOrdinal = 0
    // RFC-v5-durable-turn-dispatch §3 — durable inbox: queued → running,同事务落
    // finalize 元数据(agent_id/turn_index/turn_key/request_id/created_at),**先于
    // 模型调用**。created_at 在此现取一次并持久化,boot recovery 合成 crashed tape
    // 用它确定性重放(严禁恢复期 Date.now())。runOneTurnWithRetry 在 lock 内跑,
    // dispatchContext 天然 turn-scoped;记 session._currentDispatch 供 turn-end 持久化取。
    if (dispatchContext) {
      // B3 fail-closed:queued→running CAS **必须确认**才允许调用模型。返回 null(CAS 落空:
      // 行已非 queued / 缺失)或抛异常(DB 故障)→ 禁止调用模型,CAS inbox → rejected
      // (not_accepted)并抛 TurnDispatchNotAcceptedError 走既有失败路径终局。绝不"告警后继续跑"
      // —— 那会让 rejected 墓碑与真 tape 并存(双终态,§3 铁律)。
      let runningRow: Awaited<ReturnType<typeof recordTurnDispatchRunning>> = null
      let recordErr: unknown
      try {
        runningRow = await recordTurnDispatchRunning({
          userId: dispatchContext.userId,
          sessionId: dispatchContext.sessionId,
          clientMessageId: dispatchContext.clientMessageId,
          agentId: session.agentId,
          turnIndex: projectedTurnIndex,
          turnKey,
          requestId: typeof requestId === 'string' && requestId !== '' ? requestId : null,
          createdAt: Date.now(),
        })
      } catch (err) {
        recordErr = err
      }
      if (recordErr !== undefined || runningRow === null) {
        log.error(
          'turn dispatch running CAS unconfirmed — refusing model call (fail-closed)',
          {
            sessionKey: session.sessionKey,
            dispatchId: dispatchContext.dispatchId,
            recordMissed: runningRow === null,
          },
          recordErr instanceof Error ? recordErr : undefined,
        )
        // 落 rejected 墓碑 + 抛错(既有失败路径:submit replayLifecycle 投影用户可见错误,
        // 不写 tape → 无双终态)。**只在 running CAS 确认后**才把 dispatch 记进 session,
        // 避免 turn-end 持久化误取一个从未进入执行的 dispatch。
        await failClosedOnRunningCasMiss({
          userId: dispatchContext.userId,
          sessionId: dispatchContext.sessionId,
          clientMessageId: dispatchContext.clientMessageId,
          dispatchId: dispatchContext.dispatchId,
          cause: recordErr,
        })
      }
      session._currentDispatch = dispatchContext
    }
    if (queueLifecycle) {
      await queueLifecycle.onTurnReserved({
        turnIndex: projectedTurnIndex,
        turnKey,
        ...(traceId ? { traceId } : {}),
      })
    }
    const assistantMessageId = `srv-${session.peerId}-${session.agentId}-t${projectedTurnIndex}`
    const thinkingMessageId = `srv-${session.peerId}-${session.agentId}-t${projectedTurnIndex}-thinking`
    // V3 v7.1 — canonical tool row id factory. Same lifecycle as the
    // assistant / thinking ids above (one per user turn, shared across
    // retries). Format matches master's `internalServerAuthored.ts` tool
    // id branch so client + server tape agree on tool row id from frame 1.
    const toolMessageIdFactory = (blockId: string): string =>
      `srv-${session.peerId}-${session.agentId}-t${projectedTurnIndex}-tool-${blockId}`

    // Every retry attempt belongs to one logical turn and one immutable tape.
    // Keep exact failed-attempt protocol events and gateway retry notices, then
    // prepend them to the terminal attempt's snapshot.
    const retryRuntimeEvents: DurableRuntimeEvent[] = []
    const retryAssistantSegments: SegmentRecord[] = []
    const retryThinkingSegments: SegmentRecord[] = []
    const retryTools: TurnToolEntry[] = []
    const retryStructuredBlocks: Array<Record<string, unknown>> = []
    let retryInput = userTextOrBlocks
    let contextOverflowRetryIndex = 0
    const canRetry = (): boolean => retryState.attempt < retryState.max
    const emitRetryStatus = (code: string, delayMs = 0): boolean => {
      if (!canRetry()) return false
      retryState.attempt += 1
      const ordinal = takeDurableEventOrdinal(session)
      const observedAt = Date.now()
      retryRuntimeEvents.push({
        ordinal,
        observedAt,
        source: 'gateway',
        payload: {
          type: 'retry_status',
          code,
          rootClientMessageId: retryState.rootClientMessageId,
          attempt: retryState.attempt,
          max: retryState.max,
        },
      })
      onEvent({
        kind: 'turn_status',
        status: {
          status: 'retrying',
          retry: {
            attempt: retryState.attempt,
            max: retryState.max,
            delayMs,
            retryAt: Date.now() + delayMs,
          },
        },
      })
      return true
    }
    const clearRetryStatus = (): void => onEvent({ kind: 'turn_status', status: null })

    let attemptOrdinal = 0
    for (;;) {
      throwIfLogicalTurnCancelled(logicalTurnSignal)
      try {
        await this._runOneTurn(
          session,
          retryInput,
          onEvent,
          requestId,
          traceId,
          collabAgentPolicy,
          assistantMessageId,
          thinkingMessageId,
          toolMessageIdFactory,
          turnKey,
          clientMessageId,
          modelAuthority,
          retryRuntimeEvents,
          retryAssistantSegments,
          retryThinkingSegments,
          retryTools,
          retryStructuredBlocks,
          queueLifecycle?.queueTurn === true,
          canRetry(),
          !phantomRetryUsed,
          canRetry(),
          attemptOrdinal,
          retryState,
        )
        return // success
      } catch (err: any) {
        // Liveness owns the terminal outcome for the complete logical turn.
        // Never let an interrupted EngineTurnRun escape into another gateway
        // retry attempt while the timeout path is persisting its exact tape.
        throwIfLogicalTurnCancelled(logicalTurnSignal)
        const msg = err?.message ?? String(err)

        // Phantom turn: CCB 返回了不调模型的空 result(usage/cost/blocks 全为 0)。
        // 通常是 CCB 子进程长闲置后内部状态卡死,重启子进程能恢复。
        if (/PHANTOM_TURN/i.test(msg)) {
          log.warn('phantom turn detected, restarting subprocess', {
            sessionKey: session.sessionKey,
            phantomRetryUsed,
            ...(traceId ? { traceId } : {}),
          })
          // shutdown → 下次 submit() 会自动 respawn 一个干净的 CCB 进程。
          // 子进程重启时 runner 的 'spawn' 事件会自动把 _lastCcbCumulativeCost 归零。
          await session.runner.shutdown()
          throwIfLogicalTurnCancelled(logicalTurnSignal)
          if (phantomRetryUsed) {
            return
          }
          if (!canRetry()) throw err
          phantomRetryUsed = true
          emitRetryStatus('PHANTOM_RETRY')
          clearRetryStatus()
          attemptOrdinal += 1
          continue
        }

        // Authentication/user-policy failures require explicit user action.
        // Never fold them into the model-busy automatic retry loop.
        if (/AUTH_ERROR/i.test(msg)) {
          throw err
        }

        const errorClass = classifyRunError(msg).code
        // A full Codex native thread is recoverable: immediately rebuild it
        // from a smaller exact master-history suffix. Surface progress to the
        // user and do not add transient backoff latency.
        if (
          errorClass === 'context_too_long' &&
          session.providerTag === 'codex' &&
          canRetry() &&
          contextOverflowRetryIndex < contextOverflowRetryInputs.length
        ) {
          contextOverflowRetryIndex += 1
          retryInput = contextOverflowRetryInputs[contextOverflowRetryIndex - 1]!
          log.warn('codex context window exhausted; rebuilding with smaller history', {
            sessionKey: session.sessionKey,
            attempt: contextOverflowRetryIndex,
            maxRetries: retryState.max,
            ...(traceId ? { traceId } : {}),
          })
          emitRetryStatus('CONTEXT_REBUILD_RETRY')
          clearRetryStatus()
          attemptOrdinal += 1
          continue
        }

        // Only retry on transient errors (rate limit, server error, network)
        const isTransient =
          TRANSIENT_RETRY_ERROR_CODES.has(errorClass) ||
          /AbortError|operation was aborted|timed?\s*out/i.test(msg)
        if (!isTransient || !canRetry()) throw err
        const delay = this._transientRetryDelayMs(retryState.attempt)
        log.warn('transient error, retrying', {
          sessionKey: session.sessionKey,
          attempt: retryState.attempt + 1,
          maxRetries: retryState.max,
          delayS: Math.round(delay / 1000),
          error: msg,
          ...(traceId ? { traceId } : {}),
        })
        emitRetryStatus('TRANSIENT_RETRY', delay)
        // Match the only recovery action a user would take: continue the same
        // engine session. Codex/CC own tool and conversation continuation.
        retryInput = '继续'
        try {
          await waitForRetryDelay(delay, logicalTurnSignal)
        } finally {
          clearRetryStatus()
        }
        attemptOrdinal += 1
      }
    }
  }

  private _transientRetryDelayMs(attempt: number): number {
    return Math.min(30_000, 2000 * 2 ** attempt) + Math.random() * 1000
  }

  // (auth 错误关键字分类已下沉 engine/ccbAdapter.ts —— 错误字符串是 CCB 底座私有
  //  知识;本层只消费 TurnSummary.errorKind === 'auth'。)

  private async _runOneTurn(
    session: AgentSession,
    userTextOrBlocks: string | Array<{ type: string; [key: string]: unknown }>,
    onEvent: (e: SessionStreamEvent) => void,
    requestId?: string,
    /** V3 S12e CG8 — turn trace id propagated from runOneTurnWithRetry. Spread
     *  into every turn-scoped log statement's ctx via `...(traceId ? { traceId } : {})`
     *  so undefined values don't insert a `traceId: undefined` key. See parent
     *  fn JSDoc for the full log-tagging inventory. */
    traceId?: string,
    collabAgentPolicy?: CollabAgentPolicy,
    /** V3 v7 — canonical assistant/thinking message ids computed once by
     *  runOneTurnWithRetry and shared across retries within this user turn.
     *  Passed into CcbMessageParser so every main-agent text/thinking block
     *  emitted to the client carries
     *  `messageId: srv-${peerId}-${agentId}-t${turnIndex}` (agentId segment
     *  added 2026-05-13 to disambiguate mid-chat model switches; see
     *  runOneTurnWithRetry comment for full rationale). */
    assistantMessageId?: string,
    thinkingMessageId?: string,
    /** V3 v7.1 — canonical tool row id factory. Same minting scope as the
     *  assistant/thinking ids above (one factory per user turn, shared with
     *  master's `internalServerAuthored` writer via the
     *  `srv-${peerId}-${agentId}-t${turnIndex}-tool-${blockId}` format).
     *  Undefined for personal-version legacy callers. */
    toolMessageIdFactory?: (blockId: string) => string,
    /** Stable logical key shared by tape persistence and proxy billing. */
    turnKey?: string,
    /** Validated browser user-row id carried into every terminal tape path. */
    clientMessageId?: string,
    /** 模型权威批次 §4:本 turn 的上游凭据(见 runOneTurnWithRetry 注释)。 */
    modelAuthority?: TurnModelAuthority,
    /** Exact events from earlier attempts of this same logical turn. */
    retryRuntimeEvents: DurableRuntimeEvent[] = [],
    /** User-visible retry notices already emitted before this attempt. */
    retryAssistantSegments: SegmentRecord[] = [],
    /** User-visible process from earlier transient attempts in this turn. */
    retryThinkingSegments: SegmentRecord[] = [],
    retryTools: TurnToolEntry[] = [],
    retryStructuredBlocks: Array<Record<string, unknown>> = [],
    /** True only for a claimed PG queue turn; propagated to runner-local
     * backlog guards and never changes engine semantics. */
    queueTurn = false,
    /** Whether an auth result may reject for another credential-refresh try. */
    retryAuthErrors = true,
    /** Whether an empty phantom result may reject for its one clean-process try. */
    retryPhantomErrors = true,
    /** Whether a normal transient error result may enter another attempt. */
    retryTransientErrors = false,
    /** Zero-based retry attempt; names call ids so frozen attempts never collide. */
    attemptOrdinal = 0,
    automaticRetryState?: AutomaticRetryState,
  ): Promise<void> {
    const { runner } = session
    const turnStartTime = Date.now()
    let turnToolCallCount = 0
    let turnBlockCount = 0
    let turnPermissionCount = 0
    // Plan/goal blocks are paid structured model output but are not contained
    // in assistantText/thinkingText/tool snapshots. Keep every update (not
    // merely the last card projection) so a disconnected browser is never the
    // sole durable copy.
    const structuredBlocks: Array<Record<string, unknown>> = []
    const callUsageByTarget = new Map<string, CallTokenUsageSnapshot>()
    const freezeCall = (call: CallTokenUsageSnapshot): CallTokenUsageSnapshot =>
      structuredClone(call)
    const freezeTools = (tools: readonly TurnToolEntry[]): TurnToolEntry[] =>
      tools.map((tool) => {
        const call = callUsageByTarget.get(tool.blockId)
        return {
          ...structuredClone(tool),
          ...(call ? { _callUsage: freezeCall(call) } : {}),
        }
      })
    const freezeSegments = (
      segments: readonly SegmentRecord[],
      messageIdBase: string | undefined,
    ): SegmentRecord[] =>
      segments.map((segment) => {
        const targetId = messageIdBase
          ? `${messageIdBase}-s${segment.index}`
          : undefined
        const call = targetId ? callUsageByTarget.get(targetId) : undefined
        return {
          ...structuredClone(segment),
          ...(call ? { _callUsage: freezeCall(call) } : {}),
        }
      })
    const freezeStructuredBlocks = (
      blocks: readonly Record<string, unknown>[],
    ): Array<Record<string, unknown>> =>
      blocks.map((block) => {
        const targetId = typeof block.blockId === 'string' ? block.blockId : undefined
        const call = targetId ? callUsageByTarget.get(targetId) : undefined
        return {
          ...structuredClone(block),
          ...(call ? { _callUsage: freezeCall(call) } : {}),
        }
      })
    const onPostTerminalRuntimeEvent = (
      event: DurableRuntimeEvent,
      block: OutboundContentBlock,
    ): void => {
      const ownerTurnKey = session.channel === 'delegate'
        ? session._billingParentTurnKey
        : turnKey
      const ownerSessionId = session.channel === 'delegate'
        ? session._usageAttribution?.parentSessionId
        : session.peerId
      this._dispatchPostTerminalRuntimeEvent(session, event, block, {
        ownerTurnKey,
        ownerSessionId,
        turnIndex: prevTurns + 1,
        onEvent,
      })
    }

    // Snapshot session totals so we can roll back on auth error / phantom turn
    // (CcbAdapter 的 per-turn parser 经 TurnParams.sessionTotals 引用直接 mutate
    // 这些字段 —— 成本 delta 基线的单一权威仍是 AgentSession 本身)
    const prevCostUSD = session.totalCostUSD
    const prevTurns = session.turns
    const prevLastCcbCost = session._lastCcbCumulativeCost

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn() } }
      let turn: EngineTurnRun | null = null
      let finalizationDone: Promise<void> | null = null
      let persistTerminalSnapshot:
        | ((
            status: 'interrupted' | 'crashed',
            reason: string,
            errorCode: string,
            settleAfter?: boolean,
            waiveReason?: TurnWaiveReason,
          ) => Promise<void>)
        | null = null
      let requestTerminalPersistence:
        | ((
            status: 'interrupted' | 'crashed',
            reason: string,
            errorCode: string,
            waiveReason?: TurnWaiveReason,
          ) => Promise<void>)
        | null = null
      let requestedTerminal: {
        status: 'interrupted' | 'crashed'
        reason: string
        errorCode: string
        waiveReason?: TurnWaiveReason
      } | null = null
      let terminalRequestEscalated = false

      // Idle timeout — refreshed on every adapter 'activity'(底座每条原始消息,
      // 含 parser 会忽略的消息 —— 与旧 runner 'message' 的 refresh 时机逐条对齐)。
      // A turn is only killed if the agent produces no output for this long, so long
      // active tasks keep running while genuinely stuck turns still get interrupted.
      const IDLE_TIMEOUT_MS = 30 * 60 * 1000 // 30 min of silence from runner
      const timer = setTimeout(
        () => {
          if (!turn?.finalized) {
            const reason = '任务 30 分钟没有新输出，已中断。本轮已自动免单，积分将原路退回；请重试。'
            const persistence = requestTerminalPersistence?.(
              'interrupted',
              reason,
              'IDLE_TIMEOUT',
              'idle_timeout',
            )
              ?? Promise.resolve()
            this._trackPersistence(persistence)
          }
        },
        IDLE_TIMEOUT_MS,
      )

      // Buffer 'final' event — only forward to client after auth check passes
      let pendingFinal: SessionStreamEvent | null = null
      let observedFinalMeta: EngineFinalMeta | undefined
      let terminalEngineBilling: EngineBillingEvent | undefined
      let terminalBillingFlushed = false
      const flushTerminalBilling = () => {
        if (!terminalEngineBilling || terminalBillingFlushed) return
        terminalBillingFlushed = true
        const billing = structuredClone(terminalEngineBilling)
        session._durableDelegateEngineBillings?.push(structuredClone(billing))
        onEvent({ kind: 'codex_billing', ...billing })
      }
      const handleEngineEvent = (e: EngineEvent) => {
        if (
          e.kind === 'turn_status' &&
          e.status &&
          typeof e.status === 'object' &&
          e.status.status === 'retrying'
        ) {
          // Codex mutates the shared counter before emitting. Native CCB
          // api_retry has only its own local numbering, so advance it here.
          if (session.providerTag !== 'codex' && automaticRetryState) {
            automaticRetryState.attempt = Math.min(
              automaticRetryState.max,
              automaticRetryState.attempt + 1,
            )
          }
          const shared = automaticRetryState ?? {
            rootClientMessageId: clientMessageId ?? turnKey ?? session.sessionKey,
            attempt: e.status.retry.attempt,
            max: e.status.retry.max,
          }
          const retry = {
            ...e.status.retry,
            attempt: shared.attempt,
            max: shared.max,
          }
          retryRuntimeEvents.push({
            ordinal: takeDurableEventOrdinal(session),
            observedAt: Date.now(),
            source: 'gateway',
            payload: {
              type: 'retry_status',
              code: session.providerTag === 'codex' ? 'CODEX_TURN_START_RETRY' : 'CCB_API_RETRY',
              rootClientMessageId: shared.rootClientMessageId,
              attempt: retry.attempt,
              max: retry.max,
            },
          })
          onEvent({ kind: 'turn_status', status: { status: 'retrying', retry } })
          return
        }
        // CCB 私有 detected 事件(原 parser onToolUse/onToolResult 回调的升格形态):
        // cron 桥接 + tool.called 指标属 engine 中立编排,在此就地消费,**不进**
        // server.ts 的 outbound 流(与旧回调语义一致)。事件与内容 block 同一条
        // 同步顺序流 —— 触发时序与旧回调逐一对位。
        if (e.kind === 'tool_use_detected') {
          const tool = e.tool
          turnToolCallCount++
          // Bridge CCB CronCreate/CronDelete via EventBus
          if (tool.name === 'CronCreate') {
            const gatewayJobId = `ccb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
            if (!session._cronBridgeMap) session._cronBridgeMap = new Map()
            session._cronBridgeMap.set(`_pending:${tool.id}`, gatewayJobId)
            eventBus.emit('task.created', createEvent('task.created', session.agentId, {
              taskId: gatewayJobId,
              schedule: tool.input.cron,
              prompt: tool.input.prompt,
              oneshot: tool.input.recurring === false,
              source: 'cron-bridge',
            }))
          } else if (tool.name === 'CronDelete') {
            const ccbId = tool.input.id
            const gatewayId = session._cronBridgeMap?.get(ccbId) ?? ccbId
            eventBus.emit('task.deleted', createEvent('task.deleted', session.agentId, {
              taskId: gatewayId,
            }))
          }
          return
        }
        if (e.kind === 'tool_result_detected') {
          const tr = e.result
          if (tr.toolName === 'CronCreate' && !tr.isError && session._cronBridgeMap) {
            const pendingKey = `_pending:${tr.toolUseId}`
            const gatewayJobId = session._cronBridgeMap.get(pendingKey)
            if (gatewayJobId) {
              session._cronBridgeMap.delete(pendingKey)
              const match = /job\s+([0-9a-f]{6,12})/i.exec(tr.preview)
              if (match) {
                session._cronBridgeMap.set(match[1], gatewayJobId)
              }
            }
          }
          // Emit tool.called for metrics / observability.
          // turnIndex is 1-indexed to match turn.completed semantics:
          // session.turns is still pre-increment during tool processing
          // (incremented inside parser._handleResult after this path runs).
          eventBus.emit('tool.called', createEvent('tool.called', session.agentId, {
            sessionKey: session.sessionKey,
            turnIndex: session.turns + 1,
            toolName: tr.toolName,
            durationMs: tr.durationMs,
            isError: tr.isError,
            inputPreview: tr.inputPreview,
            outputPreview: tr.preview ? tr.preview.slice(0, 500) : undefined,
            ...(tr.exitCode !== undefined ? { exitCode: tr.exitCode } : {}),
            ...(tr.terminationReason !== undefined
              ? { terminationReason: tr.terminationReason }
              : {}),
          }))
          return
        }
        if (e.kind === 'call_usage') {
          const call: CallTokenUsageSnapshot = {
            ...structuredClone(e.call),
            callId: `a${attemptOrdinal + 1}-${e.call.callId}`,
          }
          for (const targetId of call.targetIds) {
            callUsageByTarget.set(targetId, call)
          }
          onEvent({ kind: 'call_usage', call })
          return
        }
        if (
          e.kind === 'block' &&
          (e.block.kind === 'plan' || e.block.kind === 'goal') &&
          !e.block.parentToolUseId
        ) {
          structuredBlocks.push({
            ...(structuredClone(e.block) as OutboundContentBlock),
            _ocObservedAt: Date.now(),
            _ocEventOrdinal:
              typeof (e.block as Record<string, unknown>)._ocEventOrdinal === 'number'
                ? (e.block as Record<string, unknown>)._ocEventOrdinal
                : takeDurableEventOrdinal(session),
          })
        }
        // Track all observable output for phantom-turn detection.
        // permission_request counts as real output too (visible permission card),
        // so it must NOT be flagged as phantom even if usage is 0.
        if (e.kind === 'block') turnBlockCount++
        else if (e.kind === 'permission_request') turnPermissionCount++
        if (e.kind === 'final') {
          observedFinalMeta = e.meta ? { ...e.meta } : undefined
          pendingFinal = e
          return
        }
        onEvent(e)
      }

      // adapter 'activity' = 底座每条原始消息到达。detach 后不再 refresh:旧实现
      // 靠 `!detached` guard(listener 跨 turn 保留),现 listener 在 detach 卸载,
      // guard 留作 belt-and-braces(卸载与 emit 同 tick 竞争时不重臂已清的 timer)。
      const handleActivity = () => { if (!detached) timer.refresh() }
      // M1a — engine-reported 计费侧信道(codex)。adapter 在 turn 终态 result
      // 帧上 emit 'billing'(先于 parser 产出 'final',顺序与 P1f 前一致);这里
      // 包装成 SessionStreamEvent 'codex_billing' 直通 onEvent → server.ts 发
      // outbound.codex_billing 帧给 master 做真扣费 settle(M2)。
      //   - 直调 onEvent 而非 handleEngineEvent:billing 帧不计 turnBlockCount /
      //     turnPermissionCount,phantom 判定不把 billing 当"输出"(旧语义)。
      //   - `!detached` guard:turn 已 idle/error 收尾后不再补发,防二次 settle。
      //   - CCB(billingMode:'proxy')永不 emit 'billing',本 listener 是 no-op。
      const handleBilling = (b: EngineBillingEvent) => {
        if (detached) return
        // Do not let a transient attempt's error billing claim the logical
        // request before a later successful retry. finalize/partial persistence
        // flushes exactly the one terminal attempt; the tape remains the
        // durable fallback for a lost live frame.
        terminalEngineBilling = structuredClone(b)
      }
      // Per-turn parse_error listener (previously only installed at runner
      // construction). Must be detached with the rest to avoid per-turn
      // listener accumulation (R9).
      const handleParseError = (payload: { line: string; err?: unknown; error?: unknown }) => {
        const rawError = payload.err ?? payload.error
        const err = rawError as Error | undefined
        retryRuntimeEvents.push({
          ordinal: takeDurableEventOrdinal(session),
          observedAt: Date.now(),
          source: 'gateway',
          payload: {
            type: 'parse_error',
            line: payload.line,
            error: err?.message ?? String(rawError ?? 'unknown parse error'),
          },
        })
        log.warn('ccb stdout parse_error', {
          sessionKey: session.sessionKey,
          msg: err?.message,
          sample: payload.line?.slice(0, 200),
          ...(traceId ? { traceId } : {}),
        })
      }

      let detached = false
      // A subprocess exit and the final result line can cross in the stdout
      // drain window. Exactly one terminal snapshot may own this logical turn;
      // otherwise completed and crash-flush payloads would contend for the
      // same immutable turn key. Normal completion wins until the crash timer
      // explicitly freezes the parser and claims the partial snapshot.
      let terminalPersistenceClaim: 'none' | 'complete' | 'partial' = 'none'
      const detach = () => {
        if (detached) return
        detached = true
        if (session._persistActiveTurn === requestTerminalPersistence) {
          session._persistActiveTurn = undefined
        }
        clearTimeout(timer)
        // 等价旧 parser.finish():幂等终结本 turn(summary 以当前累积态 resolve)。
        // turn-scoped 句柄保证 stale detach 不波及后继 turn(旧
        // `session._currentParser === parser` identity guard 收在 adapter 内)。
        turn?.end()
        // 故意不清 adapter 的 stdout 路由:CCB 的 bg bash 在 turn 结束后仍 emit
        // bash_output_tail,需要继续流经 finalized parser(放行 tail)→
        // handleEngineEvent → onEvent → this.deliver。下一轮 submitTurn 会替换
        // 路由,旧闭包链届时被 GC。telemetry 的 per-turn 作用域由 adapter 在
        // turn 终态时清(旧 runner.off('telemetry') 的对位物)。
        runner.off('activity', handleActivity)
        runner.off('billing', handleBilling)
        runner.off('error', handleError)
        runner.off('exit', handleExit)
        runner.off('parse_error', handleParseError)
      }

      const retainedTerminalErrors = new Set<string>()
      const retainTerminalError = (
        status: 'interrupted' | 'crashed',
        reason: string,
        errorCode: string,
      ): void => {
        const identity = `${status}\0${errorCode}\0${reason}`
        if (retainedTerminalErrors.has(identity)) return
        retainedTerminalErrors.add(identity)
        retryRuntimeEvents.push({
          ordinal: takeDurableEventOrdinal(session),
          observedAt: Date.now(),
          source: 'gateway',
          payload: { type: 'terminal_error', status, code: errorCode, detail: reason },
        })
      }

      let partialPersistencePromise: Promise<void> | null = null
      persistTerminalSnapshot = (
        status: 'interrupted' | 'crashed',
        reason: string,
        errorCode: string,
        settleAfter = true,
        waiveReason?: TurnWaiveReason,
      ): Promise<void> => {
        if (terminalPersistenceClaim !== 'none') {
          return partialPersistencePromise ?? Promise.resolve()
        }
        terminalPersistenceClaim = 'partial'
        partialPersistencePromise = (async () => {
          let persistenceAcknowledged = !MASTER_SINK_PERSIST_CHANNELS.has(session.channel)
          detach()
          if (
            status === 'interrupted' &&
            errorCode === 'USER_CANCELLED' &&
            terminalEngineBilling?.status === 'error'
          ) {
            terminalEngineBilling = {
              ...terminalEngineBilling,
              terminalCode: 'USER_CANCELLED',
            }
          }
          flushTerminalBilling()
          const snap = turn?.getPartialSnapshot() ?? {
            assistantText: '',
            thinkingText: '',
            completedTools: [],
            assistantSegments: [],
            thinkingSegments: [],
            runtimeEvents: [],
          }
          const partialAgentGroups = this.drainPendingAgentGroups(session)
          retainTerminalError(status, reason, errorCode)
          const terminalRuntimeEvents = [
            ...retryRuntimeEvents.map((event) => structuredClone(event)),
            ...snap.runtimeEvents,
          ]
          const partialAssistant = combineRetryAssistantOutput(
            retryAssistantSegments,
            snap.assistantText,
            freezeSegments(snap.assistantSegments, assistantMessageId),
            Date.now(),
          )
          const partialThinking = combineRetryAssistantOutput(
            retryThinkingSegments,
            snap.thinkingText,
            freezeSegments(snap.thinkingSegments, thinkingMessageId),
            Date.now(),
          )
          const partialTools = [
            ...retryTools.map((tool) => structuredClone(tool)),
            ...freezeTools(snap.completedTools),
          ]
          const partialStructuredBlocks = [
            ...retryStructuredBlocks.map((block) => structuredClone(block)),
            ...freezeStructuredBlocks(structuredBlocks),
          ]
          if (session._durableDelegateRuntimeEvents) {
            session._durableDelegateRuntimeEvents.push(
              ...terminalRuntimeEvents.map((event) => structuredClone(event)),
            )
          }
          try {
            if (MASTER_SINK_PERSIST_CHANNELS.has(session.channel)) {
              const turnIndex = prevTurns + 1
              session.turns = Math.max(session.turns, turnIndex)
              persistenceAcknowledged = await persistServerAuthoredTurn({
                sessionKey: session.sessionKey,
                peerId: session.peerId,
                agentId: session.agentId,
                userId: session.userId,
                turnIndex,
                ...activeGoalAttribution(session),
                ...(clientMessageId ? { clientMessageId } : {}),
                ...(turnKey ? { turnKey } : {}),
                ...(waiveReason ? { waiveReason } : {}),
                ...(session._currentDispatch ? { dispatch: session._currentDispatch } : {}),
                text: partialAssistant.text,
                ...(partialThinking.text.length > 0
                  ? { thinkingText: partialThinking.text }
                  : {}),
                status,
                errorCode,
                errorDetail: reason,
                usage: terminalUsageForPersistence({
                  finalMeta: observedFinalMeta,
                  billing: terminalEngineBilling,
                  traceId,
                  turnIndex,
                  model: session.model,
                }),
                ...(requestId ? { requestId } : {}),
                ...(session.ccbSessionId ? { agentSessionId: session.ccbSessionId } : {}),
                ...(partialTools.length > 0 ? { tools: partialTools } : {}),
                ...(partialAssistant.segments.length > 0
                  ? { assistantSegments: partialAssistant.segments }
                  : {}),
                ...(partialThinking.segments.length > 0
                  ? { thinkingSegments: partialThinking.segments }
                  : {}),
                ...(partialAgentGroups.length > 0 ? { agentGroups: partialAgentGroups } : {}),
                ...(partialStructuredBlocks.length > 0
                  ? { structuredBlocks: partialStructuredBlocks }
                  : {}),
                runtimeEvents: terminalRuntimeEvents,
                ...(terminalEngineBilling !== undefined
                  ? { engineBilling: terminalEngineBilling }
                  : {}),
              })
            }
          } finally {
            // A queued tape is durable locally but not yet visible from the
            // authoritative PG history. Never expose a terminal frame until
            // the master has ACKed it; reconnect/relogin must not turn a live
            // "finished" reply into a missing one.
            if (persistenceAcknowledged) onEvent({ kind: 'error', error: reason })
            if (settleAfter) settle(() => resolve())
          }
        })()
        return partialPersistencePromise
      }

      let terminalRequestPromise: Promise<void> | null = null
      requestTerminalPersistence = (
        status: 'interrupted' | 'crashed',
        reason: string,
        errorCode: string,
        waiveReason?: TurnWaiveReason,
      ): Promise<void> => {
        // Record the terminal observation immediately, before a cooperative
        // interrupt can produce more engine events. Its global ordinal thus
        // reconstructs the exact live ordering after refresh.
        requestedTerminal ??= { status, reason, errorCode, ...(waiveReason ? { waiveReason } : {}) }
        retainTerminalError(status, reason, errorCode)
        if (terminalRequestPromise) return terminalRequestPromise
        terminalRequestPromise = (async () => {
          const activeTurn = turn
          if (!activeTurn) {
            await Promise.resolve()
            if (!turn) {
              await persistTerminalSnapshot?.(status, reason, errorCode, true, waiveReason)
              return
            }
          }

          try { runner.interrupt() } catch {}

          // Give a cooperative interrupt one short window to produce its own
          // usage-bearing terminal result. If it does, normal finalization is
          // authoritative and already includes the gateway terminal event.
          const targetTurn = turn!
          let summaryFinished = false
          let timerHandle: NodeJS.Timeout | null = null
          await Promise.race([
            targetTurn.summary.then(() => { summaryFinished = true }),
            new Promise<void>((resolveWait) => {
              timerHandle = setTimeout(resolveWait, this._terminalRequestGraceMs)
            }),
          ])
          if (timerHandle) clearTimeout(timerHandle)
          if (summaryFinished) {
            await finalizationDone
            await partialPersistencePromise
            if (terminalPersistenceClaim === 'none') {
              await persistTerminalSnapshot?.(status, reason, errorCode, true, waiveReason)
            }
            return
          }

          // No result: terminate the process generation, then wait beyond the
          // supervisor's bounded shutdown return until its stdout really
          // closes. This is the no-loss barrier for escaped descendants that
          // still hold the pipe after SIGKILL.
          if (status === 'interrupted' && errorCode === 'USER_CANCELLED') {
            terminalRequestEscalated = true
          }
          try {
            await runner.shutdown()
          } catch (err) {
            retainTerminalError(
              'crashed',
              `runner shutdown failed: ${String(err)}`,
              'RUNNER_SHUTDOWN_FAILED',
            )
          }
          await runner.waitForOutputDrain()
          // Let synchronously parsed final/result frames schedule their
          // summary/finalization microtasks before deciding a partial is needed.
          await Promise.resolve()
          if (targetTurn.finalized) {
            await finalizationDone
            await partialPersistencePromise
            return
          }
          await persistTerminalSnapshot?.(status, reason, errorCode, true, waiveReason)
        })()
        return terminalRequestPromise
      }
      session._persistActiveTurn = requestTerminalPersistence

      // == turn 终态后处理(原 parser onFinish 主体,改为消费 TurnSummary)==
      // 由下方 turn.summary.then(finalizeTurn) 触发:正常终态带 summary(engine
      // 中立汇总),异常终态(error/exit/timeout 经 detach → turn.end 强制收尾)
      // 为 null —— 与旧 onFinish(result | null) 语义一致。时序:parser onFinish →
      // summary resolve → microtask 执行本函数,期间不会有新的 stdout 宏任务插入,
      // 后处理相对底座输出流的顺序与旧同步实现一致(含 crash 路径下
      // _pendingStaleResumeClear 先于 getOrCreate 'exit' handler 可见)。
      const finalizeTurn = async (result: TurnSummary | null): Promise<void> => {
          if (terminalPersistenceClaim === 'partial') return
          detach()
          let persistenceAcknowledged = true
          let terminalErrorForClient: string | undefined
          let terminalErrorCodeForClient: 'user_cancelled' | undefined

          // Detect stale --resume session id. CCB emits an error result with
          // `errors: ["No conversation found with session ID: <id>"]` when
          // the JSONL file for the requested resume id is missing on disk.
          // Flag the session so the upcoming runner.exit handler evicts the
          // entry from resume-map; otherwise every subsequent submit()
          // re-spawns CCB with the same dead id and loops forever.
          if (result?.staleResumeId) {
            log.warn('stale --resume session id detected, will clear resume-map entry', {
              sessionKey: session.sessionKey,
              staleId: session.ccbSessionId,
              ...(traceId ? { traceId } : {}),
            })
            session._pendingStaleResumeClear = true
            session.totalCostUSD = prevCostUSD
            session.turns = prevTurns
            session._lastCcbCumulativeCost = prevLastCcbCost
            await persistTerminalSnapshot?.(
              'crashed',
              result.errorDetail ?? 'Previous engine session is no longer available',
              'STALE_RESUME_ID',
              false,
            )
            settle(() => reject(new Error('STALE_RESUME_ID: Previous session file missing; next submit will start fresh')))
            return
          }

          if (result?.errorClass === 'context_too_long' && session.providerTag === 'codex') {
            log.warn('codex context window exhausted; clearing native resume for next turn', {
              sessionKey: session.sessionKey,
              ...(traceId ? { traceId } : {}),
            })
            await runner.shutdown()
            this._resumeMap.delete(session.sessionKey)
            this._resumeMapTimestamps.delete(session.sessionKey)
            this._resumeMapProvider.delete(session.sessionKey)
            this._resumeMapLastCost.delete(session.sessionKey)
            session.ccbSessionId = null
            runner.clearSessionId?.()
            this._saveResumeMap()
            session._historicalContextInjected = false
            session._historicalContextInjectedKey = undefined
          }

          // Detect auth error — roll back counters and reject. 分类逻辑(isError +
          // 关键字宽匹配 / CCB 精确错误前缀)已下沉 CcbAdapter(底座私有知识),
          // 本层只消费 errorKind === 'auth'。
          if (result?.errorKind === 'auth' && retryAuthErrors) {
            retryRuntimeEvents.push(
              ...result.runtimeEvents.map((event) => structuredClone(event)),
            )
            session.totalCostUSD = prevCostUSD
            session.turns = prevTurns
            session._lastCcbCumulativeCost = prevLastCcbCost
            settle(() => reject(new Error('AUTH_ERROR: Token expired or invalid')))
            return
          }

          const transientErrorClass =
            result?.errorClass ?? classifyRunError(result?.errorDetail).code
          const contextOverflowHasUsage =
            result !== null &&
            (
              result.usage.cost !== 0 ||
              result.usage.inputTokens !== 0 ||
              result.usage.outputTokens !== 0 ||
              result.usage.cacheReadTokens !== 0 ||
              result.usage.cacheCreationTokens !== 0 ||
              Object.values(terminalEngineBilling?.usage ?? {}).some(
                (value) => typeof value === 'number' && value !== 0,
              )
            )
          const contextOverflowIsSafeToRetry =
            result !== null &&
            transientErrorClass === 'context_too_long' &&
            session.providerTag === 'codex' &&
            turnBlockCount === 0 &&
            turnPermissionCount === 0 &&
            turnToolCallCount === 0 &&
            structuredBlocks.length === 0 &&
            result.assistantText.length === 0 &&
            result.thinkingText.length === 0 &&
            result.assistantSegments.length === 0 &&
            result.thinkingSegments.length === 0 &&
            result.tools.length === 0 &&
            !contextOverflowHasUsage
          const transientContinuationIsSafe =
            turnPermissionCount === 0 &&
            assessTurnRecoveryTape(
              (result?.tools ?? []).map((tool) => ({
                role: 'tool',
                ...tool,
                // TurnToolEntry omits completed for a matched result; the
                // durable recovery contract requires an explicit terminal bit.
                _completed: tool.completed !== false,
              })),
            ).checkpointSafe
          if (
            result?.isError &&
            retryTransientErrors &&
            transientContinuationIsSafe &&
            (
              TRANSIENT_RETRY_ERROR_CODES.has(transientErrorClass) ||
              contextOverflowIsSafeToRetry
            )
          ) {
            retryRuntimeEvents.push(
              ...result.runtimeEvents.map((event) => structuredClone(event)),
            )
            const frozenAttemptAssistantSegments =
              freezeSegments(result.assistantSegments, assistantMessageId)
            const attemptAssistantSegments = frozenAttemptAssistantSegments.length > 0
              ? frozenAttemptAssistantSegments
              : result.assistantText.length > 0
                ? [{ index: 0, text: result.assistantText, ts: Date.now() }]
                : []
            retryAssistantSegments.push(
              ...attemptAssistantSegments.map((segment, index) => ({
                ...segment,
                index: retryAssistantSegments.length + index,
              })),
            )
            const frozenAttemptThinkingSegments =
              freezeSegments(result.thinkingSegments, thinkingMessageId)
            const attemptThinkingSegments = frozenAttemptThinkingSegments.length > 0
              ? frozenAttemptThinkingSegments
              : result.thinkingText.length > 0
                ? [{ index: 0, text: result.thinkingText, ts: Date.now() }]
                : []
            retryThinkingSegments.push(
              ...attemptThinkingSegments.map((segment, index) => ({
                ...segment,
                index: retryThinkingSegments.length + index,
              })),
            )
            retryTools.push(...freezeTools(result.tools))
            retryStructuredBlocks.push(
              ...freezeStructuredBlocks(structuredBlocks),
            )
            session.totalCostUSD = prevCostUSD
            session.turns = prevTurns
            session._lastCcbCumulativeCost = prevLastCcbCost
            // The failed attempt is free and must not claim the shared
            // request/turn identity before the terminal attempt.
            terminalEngineBilling = undefined
            settle(() => reject(new Error(
              result.errorDetail ?? `${transientErrorClass}: transient model failure`,
            )))
            return
          }

          const modelAuthorityFailure = result?.errorKind === 'model_authority'
          const modelAuthorityReason = modelAuthorityFailure
            ? '任务运行时间较长，平台执行凭证未能继续。本轮已自动免单，积分将原路退回；你可以重新尝试。'
            : undefined
          // A generic runner error may be emitted before the remaining stdout
          // drains into a valid terminal result (pipe/error ordering). Preserve
          // that diagnostic runtime event, but only a platform-owned waiver or
          // an engine-confirmed user cancellation may override the summary.
          // If Stop races a natural end_turn, completion remains authoritative.
          // CCB confirms its cooperative AbortController path with this exact
          // null-stop-reason result shape instead of stopReason='interrupted'.
          const ccbUserCancellationResult =
            session.providerTag === 'ccb' &&
            result?.isError === true &&
            result.stopReason === null &&
            result.errorDetail?.includes('"subtype":"error_during_execution"') === true &&
            (
              result.errorDetail.includes('Error: Request was aborted.') ||
              result.errorDetail ===
                '{"subtype":"error_during_execution","errors":["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"]}' ||
              result.errorDetail ===
                '{"subtype":"error_during_execution","errors":["[ede_diagnostic] result_type=undefined last_content_type=n/a stop_reason=null"]}'
            )
          const userCancellationOverride =
            requestedTerminal?.status === 'interrupted' &&
            requestedTerminal.errorCode === 'USER_CANCELLED' &&
            (
              result?.stopReason === 'interrupted' ||
              ccbUserCancellationResult ||
              (
                terminalRequestEscalated &&
                result?.isError === true &&
                result.stopReason !== 'end_turn' &&
                terminalEngineBilling?.status === 'error' &&
                terminalEngineBilling.terminalCode === 'CODEX_ERROR' &&
                result.errorDetail?.includes(
                  '"result":"codex app-server exited code=',
                ) === true
              )
            )
              ? requestedTerminal
              : null
          if (
            userCancellationOverride &&
            terminalEngineBilling?.status === 'error'
          ) {
            // A forced Codex app-server shutdown reports a generic CODEX_ERROR
            // because the runner cannot know why its process was killed. At
            // this layer both sides are authoritative: the browser requested
            // USER_CANCELLED and the engine confirmed an interrupted result.
            // Keep billing/audit classification aligned with the tape.
            terminalEngineBilling = {
              ...terminalEngineBilling,
              terminalCode: 'USER_CANCELLED',
            }
          }
          let terminalOverride = (
            requestedTerminal?.waiveReason ? requestedTerminal : userCancellationOverride
          ) ?? (modelAuthorityFailure
            ? {
                status: 'crashed' as const,
                reason: modelAuthorityReason!,
                errorCode: 'MODEL_AUTHORITY_EXPIRED',
                waiveReason: 'platform_authority_expired' as const,
              }
            : null)
          if (terminalOverride) {
            retainTerminalError(
              terminalOverride.status,
              terminalOverride.reason,
              terminalOverride.errorCode,
            )
          }

          // Phantom-turn detection — three-state logic (v3):
          //   - apiState='skipped'  → CCB explicitly said no API call
          //                           (slash command path). Normal completion,
          //                           zero cost is expected, NOT phantom.
          //   - apiState='called'   → CCB explicitly fired willCallApi.
          //                           Cannot be phantom. If the result row is
          //                           missing stop_reason AND no blocks came
          //                           out, note `incomplete` for diagnostics
          //                           but don't roll back.
          //   - apiState='unknown'  → No telemetry arrived (e.g. old CCB,
          //                           disabled kill switch, emit swallowed an
          //                           error). Fall back to the legacy 9-AND
          //                           heuristic so behavior is strictly ≤
          //                           pre-refactor (R7: never fail closed).
          // See docs/ccb-telemetry-refactor-plan.md §5.4.
          const userInputStr =
            typeof userTextOrBlocks === 'string' ? userTextOrBlocks : null
          const isStringInput = userInputStr !== null
          const isSlashCommand =
            isStringInput && userInputStr!.trimStart().startsWith('/')

          // phantom 信号经 turn 句柄读(异常终态 result=null 时仍可读 —— 旧实现
          // 在 onFinish(null) 里同样消费 telemetry signals;正常终态与
          // result.phantomSignals 同源同值)。
          const signals = turn!.getPhantomSignals()
          let isPhantomTurn = false
          switch (signals.apiState) {
            case 'skipped':
              log.info('turn.skipped (telemetry)', {
                sessionKey: session.sessionKey,
                reason: signals.skipReason,
                ...(traceId ? { traceId } : {}),
              })
              isPhantomTurn = false
              break
            case 'called':
              isPhantomTurn = false
              if (
                result &&
                !result.stopReason &&
                turnBlockCount === 0 &&
                turnPermissionCount === 0
              ) {
                // Correlate with turn.apiResponse (if received) to distinguish
                // "stream ended mid-flight" from "stream never finished" —
                // apiResponse fires only after stream loop completes, so its
                // absence here means CCB's stream completed without producing
                // an assistant message. 诊断字段由 CcbAdapter 在汇总时快照
                // (result.diagnostics);incompleteCount 恒为 1 —— telemetry
                // channel 是 per-turn 实例,旧 noteIncomplete/getIncompleteCount
                // 组合在此路径的取值恒等于 1。
                const diag = result.diagnostics
                log.warn('telemetry: willCallApi fired but no stop_reason and no blocks', {
                  sessionKey: session.sessionKey,
                  incompleteCount: 1,
                  hadApiResponse: diag?.hadApiResponse ?? false,
                  apiRespStopReason: diag?.apiRespStopReason,
                  lastToolPreUse: diag?.lastToolPreUse,
                  toolErrorCount: diag?.toolErrorCount ?? 0,
                  ...(traceId ? { traceId } : {}),
                })
              }
              break
            case 'unknown':
              // Legacy 9-AND heuristic (unchanged from pre-refactor)
              isPhantomTurn =
                !!result &&
                isStringInput &&
                !isSlashCommand &&
                !result.isError &&
                result.usage.inputTokens === 0 &&
                result.usage.outputTokens === 0 &&
                result.usage.cacheReadTokens === 0 &&
                result.usage.cacheCreationTokens === 0 &&
                result.usage.cost === 0 &&
                turnToolCallCount === 0 &&
                turnBlockCount === 0 &&
                turnPermissionCount === 0
              break
          }
          if (terminalOverride) isPhantomTurn = false

          if (isPhantomTurn) {
            if (result && retryPhantomErrors) {
              retryRuntimeEvents.push(
                ...result.runtimeEvents.map((event) => structuredClone(event)),
              )
            }
            // Roll back parser-mutated counters (parser already incremented
            // turns and may have touched cost/cumulative even if delta was 0).
            session.totalCostUSD = prevCostUSD
            session.turns = prevTurns
            session._lastCcbCumulativeCost = prevLastCcbCost
            log.warn('phantom turn — CCB returned empty result without invoking model', {
              sessionKey: session.sessionKey,
              turnIndex: session.turns + 1,
              durationMs: Date.now() - turnStartTime,
              ...(traceId ? { traceId } : {}),
            })
            if (retryPhantomErrors) {
              settle(() => reject(new Error('PHANTOM_TURN: CCB returned empty result')))
            } else {
              await persistTerminalSnapshot?.(
                'crashed',
                '任务未能产生有效回复。本轮已自动免单；请重新尝试。',
                'PHANTOM_TURN',
                true,
                'no_response',
              )
            }
            return
          }

          // Proxy billing already treats a successfully metered call with
          // zero output tokens as no-response and charges 0. Carry the same
          // exact reason onto the terminal tape so that decision is never a
          // silent waiver: even a zero-debit turn gets one inbox receipt.
          if (
            !terminalOverride &&
            result &&
            result.usage.outputTokens === 0 &&
            (result.usage.inputTokens > 0 ||
              result.usage.cacheReadTokens > 0 ||
              result.usage.cacheCreationTokens > 0)
          ) {
            terminalOverride = {
              status: 'crashed',
              reason: '任务未能产生有效回复。本轮已自动免单；请重新尝试。',
              errorCode: 'NO_RESPONSE',
              waiveReason: 'no_response',
            }
            retainTerminalError(
              terminalOverride.status,
              terminalOverride.reason,
              terminalOverride.errorCode,
            )
          }

          // Update session accumulators from turn result
          if (result) {
            terminalPersistenceClaim = 'complete'
            flushTerminalBilling()
            const completedAssistant = combineRetryAssistantOutput(
              retryAssistantSegments,
              result.assistantText,
              freezeSegments(result.assistantSegments, assistantMessageId),
              Date.now(),
            )
            const completedThinking = combineRetryAssistantOutput(
              retryThinkingSegments,
              result.thinkingText,
              freezeSegments(result.thinkingSegments, thinkingMessageId),
              Date.now(),
            )
            const completedTools = [
              ...retryTools.map((tool) => structuredClone(tool)),
              ...freezeTools(result.tools),
            ]
            const completedStructuredBlocks = [
              ...retryStructuredBlocks.map((block) => structuredClone(block)),
              ...freezeStructuredBlocks(structuredBlocks),
            ]
            session.totalInputTokens += result.usage.inputTokens
            session.totalOutputTokens += result.usage.outputTokens
            session.totalCacheReadTokens += result.usage.cacheReadTokens
            session.totalCacheCreationTokens += result.usage.cacheCreationTokens
            session.currentAssistantBuf = completedAssistant.text
            // Persist cost-delta baseline after every successful turn so that
            // a gateway crash + restart can re-seed the correct baseline for
            // the resumed CCB (whose restoreCostStateForSession will target
            // the same cumulative). Without this, `lastCost` in resume-map
            // would only get updated when session_id changes, which lags
            // behind real turn completion by many turns.
            this._saveResumeMap()
            // L2: persist to FTS5 for session_search.
            // Use sessionKey (not ccbSessionId) as the FTS / sessions_meta
            // identity: sessionKey is stable across CCB process lifecycles
            // and across provider switches, while ccbSessionId rotates and
            // would split one logical session's history into multiple rows
            // — also breaking getMaxTurnIdx() lookup on resume.
            if (session.channel !== 'auto-dream') {
              const sessId = session.sessionKey
              Promise.all([
                upsertSessionMeta({
                  id: sessId,
                  agentId: session.agentId,
                  channel: session.channel,
                  peerId: session.peerId,
                  title: session.title,
                  startedAt: session.startedAt,
                  lastAt: Date.now(),
                  turnCount: session.turns,
                  totalCostUSD: session.totalCostUSD,
                }),
                indexTurn(sessId, session.turns, session.currentUserText ?? '', completedAssistant.text),
              ]).catch((err) =>
                log.error(
                  'FTS5 index failed',
                  { sessionKey: session.sessionKey, ...(traceId ? { traceId } : {}) },
                  err,
                ),
              )
            }

            // ── Phase 0.1: persist server-authored assistant message ──
            // Write the authoritative assistant text into the client_sessions
            // row so that a mobile client that missed the tail of the
            // streaming response (tab backgrounded, tab frozen, network
            // drop, OS-level JS suspension) can recover the full turn via
            // REST force-sync after reconnect. This is the core durability
            // fix — prior to this, server.ts:3787 silently dropped outbound
            // frames when no ws client was connected, and nothing else
            // persisted the assistant text to the user-visible messages
            // array. See docs/MOBILE_STREAM_DURABILITY_PLAN.md.
            //
            // Only applies to channels whose peerId resolves to a client_sessions
            // row id —— 当前是 webchat(UI 创建会话拿到 id 后才 dispatch 第一条)
            // 和 wechat(broker 用 wechat_session_pointer.current_session_id 当 peer.id
            // 喂 dispatchInbound,语义等价)。telegram/cron/webhook/delegate 的 peerId
            // 不是 client_sessions.id,master 端 WHERE id=? 永远命不中,只会浪费 outbox
            // 死信 IO,所以由 MASTER_SINK_PERSIST_CHANNELS 拒。它们的 turn 跟踪走
            // sessions_meta / event_log 路径(已存在,不在本 if 内)。
            const completedHasAssistant = completedAssistant.text.length > 0
            const completedHasThinking = completedThinking.text.length > 0
            // Tools-only turn is rare but real: a turn that emits tool_use
            // blocks, runs them, and ends without producing further assistant
            // text or thinking. We still need to persist the tool snapshots
            // so refresh recovery has something to render. Without this,
            // tool rows would only land when assistantText|thinkingText is
            // also non-empty — losing the durability fix in the rare case.
            const completedHasTools = completedTools.length > 0
            // P2 债A — drain the leader session's buffered team cards. Drained
            // unconditionally (take-and-clear) so a completed turn never leaks
            // its delegations into the next turn's persist, even if the persist
            // gate below is false (non-persisting channel). Added to the gate so
            // a delegation-only turn (leader produced no text/thinking/tools —
            // Agent tool is excluded from tools[] by ccbMessageParser) still
            // persists its team cards.
            const completedAgentGroups = this.drainPendingAgentGroups(session)
            const completedHasAgentGroups = completedAgentGroups.length > 0
            const completedHasStructuredBlocks = completedStructuredBlocks.length > 0
            const completedRuntimeEvents = [
              ...retryRuntimeEvents.map((event) => structuredClone(event)),
              ...result.runtimeEvents,
            ]
            if (session._durableDelegateRuntimeEvents) {
              session._durableDelegateRuntimeEvents.push(
                ...completedRuntimeEvents.map((event) => structuredClone(event)),
              )
            }
            const completedHasRuntimeEvents = completedRuntimeEvents.length > 0
            const completedHasError =
              terminalOverride !== null || result.isError || result.errorDetail !== undefined
            if (completedHasError) {
              terminalErrorForClient =
                terminalOverride?.reason ?? result.errorDetail ?? 'engine reported an error'
              terminalErrorCodeForClient =
                terminalOverride?.errorCode === 'USER_CANCELLED'
                  ? 'user_cancelled'
                  : undefined
            }
            if (
              MASTER_SINK_PERSIST_CHANNELS.has(session.channel) &&
              (completedHasAssistant ||
                completedHasThinking ||
                completedHasTools ||
                completedHasAgentGroups ||
                completedHasStructuredBlocks ||
                completedHasRuntimeEvents ||
                completedHasError)
            ) {
              const peerId = session.peerId
              const assistantText = completedAssistant.text
              const thinkingText = completedThinking.text
              const turnIndex = session.turns
              // Phase 0.4 P1-3 (tightened): use `session.userId` directly when
              // we have it — this lets `appendServerAuthoredMessageDurable`
              // route `session_not_found` into the outbox instead of silently
              // dropping when the client's debounced PUT hasn't landed yet.
              // Fall back to `getClientSession` lookup for legacy code paths
              // that didn't carry userId (cron pre-warm, old webchat calls).
              //
              // thinkingText is forwarded too (Phase 0.4 thinking durability):
              // server-wins overwrite path was discarding the streaming-only
              // thinking buffer; persisting it as `_source: 'server'` keeps it
              // through merge-preserving-server-authored & through phantom
              // dedupe. Threshold extended to "thinking-only" turns (Sonnet
              // 4.6 adaptive thinking that runs out of tokens before producing
              // assistant text) so those don't disappear either.
              const persistence = persistServerAuthoredTurn({
                sessionKey: session.sessionKey,
                peerId,
                agentId: session.agentId,
                userId: session.userId,
                turnIndex,
                ...activeGoalAttribution(session),
                ...(clientMessageId ? { clientMessageId } : {}),
                ...(turnKey ? { turnKey } : {}),
                ...(session._currentDispatch ? { dispatch: session._currentDispatch } : {}),
                text: assistantText,
                ...(completedHasThinking ? { thinkingText } : {}),
                status: terminalOverride?.status ?? 'completed',
                ...(terminalOverride?.waiveReason
                  ? { waiveReason: terminalOverride.waiveReason }
                  : {}),
                // Plan §4.4 改动 7 — wire telemetry into the sink so master
                // can persist `usage` + render refresh-stable truncated pill.
                // requestId may be absent on non-codex / non-master paths;
                // master schema only requires it when text is non-empty,
                // and we already gate the persist call on completedHasAssistant
                // OR completedHasThinking. The v3 sink schema enforces
                // requestId for assistant writes; the gateway is run only
                // by master in v3 commercial, so requestId is always present
                // there. When absent (personal-version dev), the legacy
                // path is taken (sink is null) and requestId is ignored.
                ...(requestId ? { requestId } : {}),
                // CCB agent session id → 让 master 按 session 精确排空 pending costCredits
                // (= anthropicProxy 从 LLM metadata.session_id 提取的同一 id)。
                ...(session.ccbSessionId ? { agentSessionId: session.ccbSessionId } : {}),
                usage: {
                  inputTokens: result.usage.inputTokens,
                  outputTokens: result.usage.outputTokens,
                  cacheReadTokens: result.usage.cacheReadTokens,
                  cacheCreationTokens: result.usage.cacheCreationTokens,
                  totalTokens: result.usage.totalTokens,
                  ...(session.model ? { model: session.model } : {}),
                  turn: turnIndex,
                  // Surface the master-owned per-turn traceId so the web UI can
                  // show a copyable "请求ID" that greps verbatim against master
                  // turn logs; persisted into messages[i].usage.traceId so it
                  // survives refresh via the usage sync channel.
                  ...(traceId ? { traceId } : {}),
                },
                ...(result.stopReason === 'max_tokens' ? { truncated: true } : {}),
                ...(completedHasError
                  ? {
                      errorCode:
                        terminalOverride?.errorCode ??
                        (result.errorKind === 'auth'
                          ? 'AUTH_ERROR'
                          : _tapeErrorCodeForGenericFailure(result.errorDetail)),
                      errorDetail:
                        terminalOverride?.reason ??
                        result.errorDetail ??
                        'engine reported an error',
                    }
                  : {}),
                ...(completedHasTools ? { tools: completedTools } : {}),
                // Fix B (2026-05-25) — per-segment durable rows. Plan §3.5.1.
                ...(completedAssistant.segments.length > 0
                  ? { assistantSegments: completedAssistant.segments }
                  : {}),
                ...(completedThinking.segments.length > 0
                  ? { thinkingSegments: completedThinking.segments }
                  : {}),
                // P2 债A — team cards drained above.
                ...(completedHasAgentGroups ? { agentGroups: completedAgentGroups } : {}),
                ...(completedHasStructuredBlocks
                  ? { structuredBlocks: completedStructuredBlocks }
                  : {}),
                ...(completedHasRuntimeEvents ? { runtimeEvents: completedRuntimeEvents } : {}),
                ...(terminalEngineBilling !== undefined
                  ? { engineBilling: terminalEngineBilling }
                  : {}),
              })
              this._trackPersistence(persistence)
              // Do not declare the paid turn complete until master has
              // durably finalized the immutable tape. A queued local spool is
              // safe but not yet refresh-visible, so it must not masquerade as
              // an acknowledged completion.
              persistenceAcknowledged = await persistence
            }

            // Emit turn.completed event (triggers event_log + usage_log persistence)
            const turnDurationMs = Date.now() - turnStartTime
            eventBus.emit('turn.completed', createEvent('turn.completed', session.agentId, {
              sessionKey: session.sessionKey,
              turnIndex: session.turns,
              usage: {
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
                cacheReadTokens: result.usage.cacheReadTokens,
                cacheCreationTokens: result.usage.cacheCreationTokens,
                costUsd: result.usage.cost,
                model: session.model,
              },
              toolCalls: turnToolCallCount,
              durationMs: turnDurationMs,
              // PR2 v1.0.66 — codex-native turn 把 server-owned requestId 透到这里,
              // 让 event_log / 异步 audit 能关联到 inflightCodexTurns 行。其它路径 undefined。
              ...(requestId ? { requestId } : {}),
            }))

            // Emit cost.recorded for budget tracking
            eventBus.emit('cost.recorded', createEvent('cost.recorded', session.agentId, {
              sessionKey: session.sessionKey,
              turnIndex: session.turns,
              usage: {
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
                cacheReadTokens: result.usage.cacheReadTokens,
                cacheCreationTokens: result.usage.cacheCreationTokens,
                costUsd: result.usage.cost,
                model: session.model,
              },
              sessionTotalCostUsd: session.totalCostUSD,
            }))

            // Detect verification verdicts in assistant output and emit structured event
            const verdict = parseVerificationVerdict(result.assistantText)
            if (verdict) {
              eventBus.emit('verification.result', createEvent('verification.result', session.agentId, {
                sessionKey: session.sessionKey,
                target: 'code' as const,
                passed: verdict.passed,
                evidence: verdict.evidence,
              }))
              log.info('verification verdict', {
                sessionKey: session.sessionKey,
                verdict: verdict.verdict,
                checks: verdict.evidence.length,
                passed: verdict.passed,
                ...(traceId ? { traceId } : {}),
              })
            }
          }
          // A transient persistence failure stays in the unlimited fsynced
          // retry queue. Do not emit a new user-facing notice and do not expose
          // terminal completion until the authoritative master ACKs it.
          if (persistenceAcknowledged) {
            if (terminalErrorForClient) {
              // 审计 R3:errorClass 已是 TurnSummary 的权威字段(各 adapter 的
              // buildTurnSummary 从 TurnResult 复制),直读即可 —— 不再 cast 穿透,
              // 也不再靠 server 侧重新正则解析 errorDetail 兜底。runner 预分类在场
              // 则透传给 server.ts 直接按码组 outbound.error;缺省 undefined →
              // server 侧回落 classifyRunError,行为不变。
              const preClassified = result?.errorClass
              onEvent({
                kind: 'error',
                error: terminalErrorForClient,
                ...(preClassified ? { errorClass: preClassified } : {}),
                ...(terminalErrorCodeForClient ? { errorCode: terminalErrorCodeForClient } : {}),
              })
            } else if (pendingFinal) {
              onEvent(pendingFinal)
            }
          }
          settle(() => resolve())
      }

      const handleError = (err: Error) => {
        const persistence = requestTerminalPersistence?.('crashed', err.message, 'RUNNER_ERROR')
          ?? Promise.resolve()
        this._trackPersistence(persistence)
      }

      // Listen for subprocess crash mid-turn. Defer slightly to let remaining
      // stdout data drain (exit can fire before stdout 'end' in Node.js).
      const handleExit = (info: { code: number | null; signal: string | null; crashed: boolean }) => {
        // Normal lifecycle restarts (model/effort/toolset swaps and Codex
        // app-server route-token respawns) emit a clean `exit` before the turn
        // continues on the replacement process. Do not finalize/detach the
        // parser for that expected code=0/no-signal shape; real signal/non-zero
        // exits still take the existing partial-drain/error path below.
        if (!info.crashed && info.code === 0 && info.signal == null) return

        // The setTimeout body is wrapped in `flushP` and registered with the
        // pending-persistence set IMMEDIATELY (synchronously, on this exit
        // event). That way `SessionManager.awaitPendingPersistence` — called
        // from `shutdownAll` after `runner.shutdown()` resolves — already
        // sees the promise and waits for the 150ms drain window + the sink
        // enqueue inside it to land on disk. If we instead added the
        // persist promise inside the setTimeout body, shutdown could race
        // past awaitPendingPersistence (set still empty) and clear the
        // sink singleton before the setTimeout fires, sending the partial
        // through the legacy data-loss path. Codex R2 BLOCK-1.
        const flushP = new Promise<void>((resolveFlush) => {
          setTimeout(() => {
            if (turn?.finalized || terminalPersistenceClaim !== 'none') {
              resolveFlush()
              return
            }
            const reason = info.signal
              ? `子进程被信号 ${info.signal} 终止`
              : info.code
                ? `子进程异常退出 (code ${info.code})`
                : '子进程意外退出'
            const status: 'interrupted' | 'crashed' = info.signal ? 'interrupted' : 'crashed'
            const code = info.signal ? 'RUNNER_INTERRUPTED' : 'RUNNER_CRASHED'
            void (persistTerminalSnapshot?.(status, reason, code) ?? Promise.resolve())
              .finally(resolveFlush)
          }, 150)
        })
        this._trackPersistence(flushP)
      }

      runner.on('activity', handleActivity)
      runner.on('billing', handleBilling)
      runner.on('error', handleError)
      runner.on('exit', handleExit)
      runner.on('parse_error', handleParseError)

      // adapter 在 submitTurn 内构造 per-turn parser + telemetry(CCB 私有生命
      // 周期)并替换 stdout 路由目标 —— 旧 _currentMessageListener 的替换语义
      // (每 session 恒一个路由目标,旧 turn 闭包链自此可 GC)收进 adapter。
      // PR2 v1.0.66 — requestId 挂 queue entry(CCB 路径 noop 透传)。
      const submittedTurn = runner.submitTurn({
        input: userTextOrBlocks,
        ...(queueTurn ? { queueTurn: true } : {}),
        requestId,
        ...(turnKey ? { turnKey } : {}),
        // 模型权威批次 §4:bridge turn 的两张签名票(本地路径 undefined → CCB runner
        // 自取 local_catalog token;codex adapter 不消费本字段)。
        ...(modelAuthority !== undefined ? { modelAuthority } : {}),
        traceId,
        assistantMessageId,
        thinkingMessageId,
        toolMessageIdFactory,
        nextDurableEventOrdinal: () => takeDurableEventOrdinal(session),
        onPostTerminalRuntimeEvent,
        collabAgentPolicy,
        automaticRetryState,
        ...(session._usageAttribution
          ? { usageAttribution: session._usageAttribution }
          : {}),
        onEvent: handleEngineEvent,
        // CCB 成本 delta 基线:parser 直接读写 session.totalCostUSD / turns /
        // _lastCcbCumulativeCost(单一权威;回滚由上方 finalizeTurn 就地恢复)。
        sessionTotals: session,
        toolUseIdToName: session.toolUseIdToName,
      })
      turn = submittedTurn

      // 对位旧 runner.submit(...).catch:spawn 失败 / crash-loop backoff 等。
      submittedTurn.submitted.catch((err) => {
        const persistence = requestTerminalPersistence?.(
          'crashed',
          String(err),
          'TURN_SUBMIT_FAILED',
        ) ?? Promise.resolve()
        this._trackPersistence(persistence)
      })

      finalizationDone = submittedTurn.summary.then(finalizeTurn).catch((err) => {
        // finalizeTurn 自身抛错(编排层内部 bug)时对位旧实现 parser._parseInner
        // 的 catch → error 事件;并 settle 防 session lock 悬挂(旧实现此路径
        // 会悬挂,这里顺手加固,正常路径行为不变)。
        onEvent({ kind: 'error', error: String(err) })
        settle(() => resolve())
      })
    })
  }

  interrupt(sessionKey: string): boolean {
    const s = this.sessions.get(sessionKey)
    if (!s) return false
    const external = s._externalTurnAbort
    if (external && !external.signal.aborted) external.abort()
    const persistActiveTurn = s._persistActiveTurn
    if (persistActiveTurn) {
      const persistence = persistActiveTurn(
        'interrupted',
        '本轮已由用户停止。',
        'USER_CANCELLED',
      )
      this._trackPersistence(persistence)
      return true
    }
    const runnerInterrupted = s.runner.interrupt()
    return !!external || runnerInterrupted
  }

  /** Stop-and-run fence: never interrupt a newer turn that raced the queue
   * mutation/PG response. Exact logical turnKey is the only accepted owner. */
  interruptExact(sessionKey: string, turnKey: string): boolean {
    const session = this.sessions.get(sessionKey)
    if (!session || session._currentTurnKey !== turnKey) return false
    return this.interrupt(sessionKey)
  }

  /** Browser Stop fence: only interrupt the turn that owns this exact
   * clientMessageId.  A stale Stop can never kill a newer turn. */
  interruptClientTurn(sessionKey: string, clientMessageId: string): boolean {
    const session = this.sessions.get(sessionKey)
    if (!session || session._runningClientMessageId !== clientMessageId) return false
    return this.interrupt(sessionKey)
  }

  getByKey(sessionKey: string): AgentSession | undefined {
    return this.sessions.get(sessionKey)
  }

  /**
   * P2 债A — buffer a completed delegation (team card) onto the leader session
   * so it drains into that session's turn-end server-authored persist.
   *
   * Called from `handleDelegateTask` collection at delegate完成/失败/超时 收尾,
   * keyed by the parent (leader) sessionKey. Returns false when the parent
   * session isn't live (raced away, or a non-webchat parent that the caller
   * shouldn't have targeted) — the caller degrades to client-only team cards
   * (no regression) in that case.
   *
   * Array.push is safe under concurrent parallel delegations (single-threaded
   * event loop, no torn writes). The buffer is drained + cleared at turn-end
   * (`persistServerAuthoredTurn` call sites); it only accumulates within the
   * leader turn a delegation belongs to.
   */
  bufferPendingAgentGroup(parentSessionKey: string, group: DurableAgentGroup): boolean {
    const parent = this.sessions.get(parentSessionKey)
    if (!parent) return false
    ;(parent._pendingAgentGroups ??= []).push({
      ...group,
      _ocEventOrdinal:
        group._ocEventOrdinal ?? takeDurableEventOrdinal(parent),
    })
    return true
  }

  /** P2 债A — take-and-clear the leader session's buffered team cards for the
   *  turn-end persist. Returns [] when empty. Clearing here prevents a turn's
   *  delegations from leaking into the next turn's persist. */
  drainPendingAgentGroups(session: AgentSession): DurableAgentGroup[] {
    const pending = session._pendingAgentGroups
    if (!pending || pending.length === 0) return []
    session._pendingAgentGroups = undefined
    return pending
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
      recordRecentTerminal(session, clientMessageId, outcome === 'completed' ? 'completed' : 'interrupted')
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
        if (current.kind === 'remote' && target.kind === 'remote' && current.hostId === target.hostId) return
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
        session.ccbSessionId = null
        session.runner.clearSessionId?.()
        this._saveResumeMap()
        session.runner.setExecutionTarget(newTarget)
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
            .catch((err) => log.warn('release old mux failed', { sessionKey, oldHostId, err: String(err) }))
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
      this._resumeMapProvider.delete(sessionKey)
      this._saveResumeMap()
    }
    // Medium#G1:让 server.ts 的 outboundRing 也清掉这个 key(两个 server.ts
    // 里现存的 destroySession 调用点已经显式 clear 过,这里再调一次是幂等;
    // 未来若有遗漏的路径,callback 能兜住)
    try { this.onSessionDestroyed?.(sessionKey) } catch {}
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
        muxReleases.push(() =>
          this._remoteTargetController?.releaseMux(key, uid, hostId).catch(() => {}) ??
            Promise.resolve(),
        )
      }
    }
    await Promise.all([...this.sessions.values()].map((s) => s.runner.shutdown()))
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
      try { this.onSessionDestroyed?.(k) } catch {}
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
      if (_inFlight) return  // 防并行:shutdown 链慢 → 跳过本轮,下一轮再扫
      _inFlight = true
      ;(async () => {
        try {
          const now = Date.now()
          const toEvict: string[] = []
          for (const [key, s] of this.sessions) {
            const isTempSession = key.includes(':cron:') || key.includes(':task:')
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
              this._resumeMapProvider.delete(key)
            }
            // Medium#G1 + N11:shutdown 完才清 ring,保证不会有"runner 已死但 ring 还能
            // 接尾帧"的窗口。webchat 虽然 resume-map 留着等 reconnect,但 outboundRing
            // 没必要留(重连时会重走 hello,server 按 lastFrameSeq=0 重建)。
            try { this.onSessionDestroyed?.(key) } catch {}
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

  // Resume-map TTL: track when each entry was last updated
  private _resumeMapTimestamps = new Map<string, number>()
  // Persisted cost-delta baseline for resumed CCB sessions. CCB's
  // restoreCostStateForSession sets STATE.totalCostUSD to this value on start,
  // so the gateway must seed the matching baseline before the first post-resume
  // `result` arrives (otherwise the parser would compute delta against 0 and
  // re-attribute the entire historical cumulative as this turn's cost).
  private _resumeMapLastCost = new Map<string, number>()
  // Idle TTL for entries whose in-memory AgentSession was already evicted.
  // 7 days covers typical gateway restarts / multi-day reconnect gaps while
  // preventing resume-map from growing unbounded. Rationale: resume-map exists
  // to survive *restarts*, not to be a durable conversation archive.
  private static RESUME_MAP_INACTIVE_TTL = 7 * 24 * 60 * 60 * 1000 // 7 days

  private _pruneResumeMap(): void {
    const now = Date.now()
    let pruned = false
    for (const [key] of this._resumeMap) {
      if (this.sessions.has(key)) continue // live session — keep
      // ts=0 = unknown age (legacy entry whose file mtime could not be stat'd
      // in _loadResumeMap). Treat as instantly-expired: `now - 0` is huge, so
      // it trivially exceeds the threshold and gets pruned on first sweep.
      const ts = this._resumeMapTimestamps.get(key) ?? 0
      if (now - ts > SessionManager.RESUME_MAP_INACTIVE_TTL) {
        this._resumeMap.delete(key)
        this._resumeMapTimestamps.delete(key)
        this._resumeMapLastCost.delete(key)
        this._resumeMapProvider.delete(key)
        pruned = true
        log.info('pruned idle resume-map entry', {
          sessionKey: key,
          ageMs: ts === 0 ? null : now - ts,
        })
      }
    }
    if (pruned) this._saveResumeMap()
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
