import { existsSync, readFileSync, statSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AgentDef,
  type OpenClaudeConfig,
  type SelfhealExecutionStatus,
  appendServerAuthoredMessageDurable,
  claimQueuedTurn,
  enqueueExecution,
  getClientSession,
  getExecution,
  getMaxTurnIdx,
  indexTurn,
  paths,
  reopenExecutionForRedrive,
  setExecutionStatus,
  upsertSessionMeta,
} from '@openclaude/storage'
import { ClaudeMessageParser, type SessionStreamEvent } from './claudeMessageParser.js'
import { CodexAppServerRunner } from './codexAppServerRunner.js'
import { CodexRunner } from './codexRunner.js'
import { createEvent, eventBus } from './eventBus.js'
import { createLogger } from './logger.js'
import { normalizeProxyUrl } from './proxyEnv.js'
import { SubprocessRunner } from './subprocessRunner.js'

const log = createLogger({ module: 'sessionManager' })

const CODEX_GOAL_STATUSES = new Set(['active', 'paused', 'budgetLimited', 'complete'])

export type CodexGoalControlAction = 'get' | 'set' | 'clear'
export type CodexGoalControlInput = {
  objective?: string | null
  status?: string | null
  tokenBudget?: number | null
}

export const LIVENESS_IDLE_TIMEOUT_TOOL_MS = 15 * 60_000
export const LIVENESS_IDLE_TIMEOUT_DEFAULT_MS = 5 * 60_000
export const LIVENESS_IDLE_TIMEOUT_COMPACTING_MS = 20 * 60_000
// Codex app-server only: cold-start grace until a turn's first observable-output
// block. codex liveness counts only visible progress (getLivenessIdleMs ignores
// its raw stdout), and Codex GPT-5 at high reasoning effort (esp. Goal mode) can
// reason server-side for >5min before emitting its first block. The 5min DEFAULT
// tier is tuned for claude's dense streaming and falsely kills codex's cold
// phase. Until the first block of a turn, codex measures idle from turnStartedAt
// against this window; once a block lands it falls back to the normal tiers, so
// steady-state deadlock detection is unchanged.
export const LIVENESS_IDLE_TIMEOUT_CODEX_FIRST_TOKEN_MS = 20 * 60_000
export const IDLE_TIMEOUT_TURN_DRAIN_MS = 2_000
// Continuation watch backstop — how long a post-turn continuation watch may stay
// armed before it force-ends itself (it also ends earlier on result/exit).
// Hoisted to module scope so the user-submit drain gate (which must bound how
// long a new turn waits for an in-flight watch) and _armContinuationWatch share
// ONE authoritative value instead of two drifting magic numbers.
export const CONTINUATION_WATCH_BACKSTOP_MS = 20 * 60_000

export function getLivenessIdleTimeoutMs(
  parser: { pendingToolCalls?: number; isCompacting?: boolean } | null | undefined,
): number {
  if (parser?.isCompacting) return LIVENESS_IDLE_TIMEOUT_COMPACTING_MS
  if ((parser?.pendingToolCalls ?? 0) > 0) return LIVENESS_IDLE_TIMEOUT_TOOL_MS
  return LIVENESS_IDLE_TIMEOUT_DEFAULT_MS
}

export function shouldHardResetRunnerAfterIdleTimeout(runner: unknown): boolean {
  // Both long-lived runner types can wedge such that a plain interrupt() cannot
  // free them: codex app-server (JSON-RPC process stuck high-CPU) and the claude
  // subprocess (stdin ended / internal deadlock — interrupt is a no-op, as
  // observed when a wedged turn ignored a turn/interrupt and stayed `running`).
  // For both, the only reliable recovery is shutdown() so the next submit()
  // respawns a fresh process. shutdown() is idempotent on already-dead runners.
  return runner instanceof CodexAppServerRunner || runner instanceof SubprocessRunner
}

export function getLivenessIdleMs(
  runner: unknown,
  visibleActivityAt: number,
  now = Date.now(),
): number {
  if (runner instanceof CodexAppServerRunner) {
    return now - visibleActivityAt
  }
  const lastActivityAt =
    runner && typeof runner === 'object' && typeof (runner as any).lastActivityAt === 'number'
      ? (runner as any).lastActivityAt
      : visibleActivityAt
  return now - lastActivityAt
}

/**
 * Resolve the idle measurement + threshold for one liveness watchdog tick.
 *
 * Codex cold-start exception: before a turn emits its first observable-output
 * block (`hasVisibleProgress=false`), a CodexAppServerRunner measures idle from
 * `turnStartedAt` against the wide first-token grace window instead of the 5min
 * DEFAULT tier — high-effort server-side reasoning can legitimately stay silent
 * longer than 5min before the first block. Once a block lands, or for any
 * non-codex runner, the normal liveness clock (`getLivenessIdleMs`) + tiers
 * (`getLivenessIdleTimeoutMs`) apply, so steady-state deadlock detection is
 * unchanged.
 */
export function resolveLivenessIdle(args: {
  runner: unknown
  hasVisibleProgress: boolean
  parser: { pendingToolCalls?: number; isCompacting?: boolean } | null | undefined
  turnStartedAt: number
  visibleActivityAt: number
  now?: number
}): { idleMs: number; threshold: number } {
  const now = args.now ?? Date.now()
  if (args.runner instanceof CodexAppServerRunner && !args.hasVisibleProgress) {
    return {
      idleMs: now - args.turnStartedAt,
      threshold: LIVENESS_IDLE_TIMEOUT_CODEX_FIRST_TOKEN_MS,
    }
  }
  return {
    idleMs: getLivenessIdleMs(args.runner, args.visibleActivityAt, now),
    threshold: getLivenessIdleTimeoutMs(args.parser),
  }
}

export function createIdleTimeoutEventGate(
  onEvent: (e: SessionStreamEvent) => void,
  onSuppressed?: (e: SessionStreamEvent, count: number) => void,
): {
  emit: (e: SessionStreamEvent) => void
  suppress: () => void
  suppressedCount: () => number
} {
  let suppressing = false
  let suppressed = 0
  return {
    emit: (e) => {
      if (suppressing) {
        suppressed++
        onSuppressed?.(e, suppressed)
        return
      }
      onEvent(e)
    },
    suppress: () => {
      suppressing = true
    },
    suppressedCount: () => suppressed,
  }
}

type ChatHistoryMessage = {
  role?: unknown
  text?: unknown
  content?: unknown
  status?: unknown
  system?: unknown
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

function normalizeLowInformationText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s"'`“”‘’「」『』（）()【】\[\]{}<>《》,，.。!！?？;；:：、~～_-]+/g, '')
}

const LOW_INFORMATION_CONTINUATION_TEXTS = new Set([
  '继续',
  '继续吧',
  '继续做',
  '继续处理',
  '继续执行',
  '继续跑',
  '继续修',
  '继续改',
  '接着',
  '接着吧',
  '接着做',
  '接着处理',
  '往下',
  '往下做',
  '下一步',
  '咋样',
  '怎么样',
  '如何',
  '啥情况',
  '什么情况',
  '进展',
  '有进展吗',
  '好了没',
  '好了么',
  '好了吗',
  '改好了吗',
  '修好了吗',
  '搞定了吗',
  '完成了吗',
  '做完了吗',
  '行了吗',
  '可以了吗',
  'continue',
  'goon',
  'keepgoing',
  'next',
  'nextstep',
  'done',
  'status',
  'update',
  'anyupdate',
  'howsitgoing',
  'howisitgoing',
])

export function isLowInformationContinuationText(text: string): boolean {
  const normalized = normalizeLowInformationText(text)
  if (!normalized) return false

  return (
    LOW_INFORMATION_CONTINUATION_TEXTS.has(normalized) ||
    /^继续(?:一下|下|看看|看下|看一下)$/.test(normalized) ||
    /^接着(?:一下|下|看看|看下|看一下)$/.test(normalized)
  )
}

export function shouldClarifyNonNativeResume(opts: {
  channel: string
  turns: number
  hasNativeResumeId: boolean
  userText: string
}): boolean {
  return (
    opts.channel === 'webchat' &&
    opts.turns > 0 &&
    !opts.hasNativeResumeId &&
    isLowInformationContinuationText(opts.userText)
  )
}

function buildNonNativeResumeClarificationText(): string {
  return [
    '⚠️ 这个 Codex 会话刚被重置，当前 runner 不能原生恢复上一轮内部状态。',
    '',
    '像“继续 / 咋样 / 改好了吗”这类短指令在这种状态下不安全：模型只能看到一段历史摘要，可能会误把很久前的任务当成当前任务继续跑，前端也会看起来像无响应。',
    '',
    '请直接说明要继续的具体事项，例如：“继续修个人版这个会话无响应的问题，从当前 diff 开始”。',
  ].join('\n')
}

export function buildHistoricalContextPrompt(
  messages: unknown[],
  currentUserText: string,
  opts?: { maxChars?: number; maxMessages?: number },
): string | null {
  const maxChars = opts?.maxChars ?? 14_000
  const maxMessages = opts?.maxMessages ?? 40
  const currentNorm = normForCompare(currentUserText)
  const rows: Array<{
    role: 'user' | 'assistant'
    text: string
    status?: unknown
  }> = []
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue
    const msg = raw as ChatHistoryMessage
    if (msg.system === true) continue
    const role = msg.role === 'user' || msg.role === 'assistant' ? msg.role : null
    if (!role) continue
    const text = extractHistoryText(msg).trim()
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
  let selected = rows.slice(-maxMessages)
  while (selected.length > 0) {
    const body = selected
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
      .join('\n\n')
    if (body.length <= maxChars) {
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
    selected = selected.slice(1)
  }
  return null
}

// 一个 sessionKey 对应一个 SubprocessRunner + 一把 Mutex(同 session 串行)。
// 跨 session 完全并行。
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
  title: string
  startedAt: number
  runner: SubprocessRunner
  runnerProviderTag: string
  ccbSessionId: string | null
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
  // Current turn parser (for idle-timeout to check pendingToolCalls)
  _currentParser?: import('./claudeMessageParser.js').ClaudeMessageParser
  // Stable id of the turn currently streaming (`srv-${peerId}-t${turnIndex}`),
  // refreshed at turn start + each background-workflow re-arm. Stamped onto every
  // outbound.message frame as `turnId` so the web side can upsert assistant/
  // thinking by turn and reconcile live (m-*) messages with the server-authored
  // durable row (which shares this exact id). undefined for non-webchat sessions.
  _activeTurnId?: string
  // Permanent (session-lifetime) stdout 'message' pump. Installed once on the
  // first _runOneTurn and bound to `session.runner` (never reassigned, so it
  // survives effort/model recycle + idle hard-reset which shut the proc but keep
  // the runner EventEmitter). It delegates each raw message to the current turn's
  // handler — the dispatcher seam P2.2/P2.3 build on. destroySession/shutdownAll/
  // eviction explicitly off() it.
  _messagePump?: ((msg: any) => void) | null
  // The current turn's message handler (set per turn in _runOneTurn). The pump
  // routes to whatever this points at. Deliberately NOT cleared on detach so a
  // post-result frame still reaches the old, finalized parser and is dropped —
  // preserving the legacy "replace not remove" behaviour (the next turn replaces it).
  _currentTurnHandler?: ((msg: any) => void) | null
  // P2.2: active continuation watch — runs OUTSIDE the submit lock after a turn
  // that launched a background task resolves. The permanent pump routes to its
  // parser; a new user submit queues behind it (minimal strict gate). null/absent
  // when no watch is active.
  _continuationWatch?: ContinuationWatch | null
  // P2.2: per-session serial chain for continuation durable writes. Serialized so
  // the pump can synchronously re-arm + deliver the NEXT continuation while a prior
  // durable append is still in flight, without reordering/dropping (mirrors the
  // _resumeMapWrite chain pattern).
  _continuationWrite?: Promise<void>
  _historicalContextInjected?: boolean
}

/** Immutable routing captured when a continuation watch opens. The gateway wires
 *  SessionManager.onContinuationEvent to stamp `turnId` + push to the peer's ws —
 *  an independent delivery path (NOT the per-submit onEvent closure, which would
 *  re-complete the RunLog and clear stale out.blocks). */
export interface ContinuationDeliveryRoute {
  sessionKey: string
  peerId: string
  userId?: string
  channel: string
  agentId: string
  /** The (sub-)turn id — `srv-${peerId}-t${turnIndex}` — shared by every frame of
   *  this continuation and equal to its durable row id (invariant C lockstep). */
  turnId?: string
}

/** Session-level continuation watch state (P2.2). Lives on the session, fed by the
 *  permanent stdout pump, outside any submit lock. */
export interface ContinuationWatch {
  /** Fresh parser for the current continuation sub-turn (re-armed per sub-turn). */
  parser: import('./claudeMessageParser.js').ClaudeMessageParser
  /** Streaming turnId for the current sub-turn = serverAuthoredMsgId(peerId, turns+1),
   *  recomputed at each re-arm. Equals the eventual durable row id (turns post-inc). */
  streamTurnId?: string
  /** Immutable route captured at watch open. */
  route: ContinuationDeliveryRoute
  /** Sub-turns delivered so far (bounded by MAX_CONTINUATIONS). */
  count: number
  /** Backstop idle timer — ends the watch on prolonged silence (no interrupt). */
  backstop: ReturnType<typeof setTimeout> | null
  /** Watch-owned settle guard (double observe OK, double settle not). */
  ended: boolean
  /** Runner listeners owned by the watch (removed on every end path). */
  onExit: (info: { code: number | null; signal: string | null; crashed: boolean }) => void
  onError: (err: Error) => void
  onParseError: (p: { line: string; err: unknown }) => void
  /** Resolved when the watch ends — queued user submits await this. */
  done: Promise<void>
  resolveDone: () => void
}

/** Canonical id for a server-authored assistant message / its turn. Single
 *  source of truth shared by durable persistence (appendServerAuthoredMessageDurable)
 *  and the outbound `turnId` stamp, so the web side can match the live (m-*) and
 *  durable copies of the same turn. Changing this format breaks live↔durable
 *  reconciliation — keep the two call sites in lockstep. */
function serverAuthoredMsgId(peerId: string, turnIndex: number): string {
  return `srv-${peerId}-t${turnIndex}`
}

// Re-export from claudeMessageParser so existing imports keep working
export type { SessionStreamEvent } from './claudeMessageParser.js'

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

export class SessionManager {
  private sessions = new Map<string, AgentSession>()
  private maxIdleMsCron = 30 * 60 * 1000 // 30 min for cron/task sessions
  private maxIdleMsChat = 30 * 60 * 1000 // 30 min for webchat sessions — aggressive eviction to curb subprocess accumulation on small personal VPS (bun+playwright+mcp stack per peer); resume-map (7d persist) handles cold reconnect via --resume
  /** @deprecated Use eventBus 'task.created'/'task.deleted' instead. Kept for backward compat. */
  public onCronBridge?: (event: CronBridgeEvent) => Promise<void>
  /** Called when a 401 auth error is detected — gateway should trigger immediate token refresh */
  public onAuthError?: () => Promise<void>
  /** Called after server-authored assistant text mutates a client_sessions row. */
  public onClientSessionMutated?: (sessionId: string, userId: string) => void
  // P2.2: independent continuation delivery. The gateway wires this to stamp
  // route.turnId onto the event and push it to the peer's ws (mirroring the
  // per-block/final deliver), WITHOUT the per-submit onEvent closure (which would
  // re-complete the RunLog + clear stale out.blocks). Optimization layer on top of
  // the durable "no-drop" floor — absent callback => persist-only (still no drop).
  public onContinuationEvent?: (route: ContinuationDeliveryRoute, event: SessionStreamEvent) => void

  private resumeMapPath = join(paths.home, 'resume-map.json')

  constructor(public config: OpenClaudeConfig) {
    this._loadResumeMap()
  }

  /** Update config reference (e.g. after OAuth token refresh) and propagate to all runners */
  updateConfig(config: OpenClaudeConfig): void {
    this.config = config
    for (const session of this.sessions.values()) {
      session.runner.updateConfig(config)
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
   *  so we never feed a CCB session_id to codex (or vice versa). */
  private _resumeIdFor(sessionKey: string, wantProvider: string): string | undefined {
    const id = this._resumeMap.get(sessionKey)
    if (!id) return undefined
    const tag = this._resumeMapProvider.get(sessionKey) ?? SessionManager.CCB_PROVIDER_TAG
    return tag === wantProvider ? id : undefined
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
    const tag = this._resumeMapProvider.get(sessionKey) ?? SessionManager.CCB_PROVIDER_TAG
    return tag === wantProvider ? cost : undefined
  }

  /** Normalised provider tag for a runner: ccb-family providers collapse to
   *  'ccb', codex-native stays distinct. Extend here when new providers land. */
  private static providerTag(agentProvider: string | undefined): string {
    if (agentProvider === 'codex-native') return 'codex-native'
    return SessionManager.CCB_PROVIDER_TAG
  }

  private _loadResumeMap(): void {
    // Try primary file first, fall back to backup if corrupted (atomic-write safety net)
    for (const path of [this.resumeMapPath, `${this.resumeMapPath}.bak`]) {
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
            this._resumeMapProvider.set(
              key,
              typeof prov === 'string' && prov ? prov : SessionManager.CCB_PROVIDER_TAG,
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
    type ResumeEntry = {
      id: string
      ts: number
      lastCost?: number
      provider?: string
    }
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
    const tmpPath = `${this.resumeMapPath}.tmp`
    const bakPath = `${this.resumeMapPath}.bak`
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

  async getOrCreate(opts: {
    sessionKey: string
    agent: AgentDef
    channel?: string
    peerId?: string
    /**
     * Authenticated userId owning the client_sessions row. When provided,
     * stored on the resulting AgentSession so the durable server-authored-
     * append path can bypass the `getClientSession` short-circuit on
     * first-turn races (Phase 0.4 P1-3). Optional for backwards compatibility:
     * cron/webhook/pre-warm callers that don't have a user context can omit it.
     */
    userId?: string
    title?: string
    delegationDepth?: number
    /** 仅用于**新建** runner 时初始化 effort(官方 `--effort` flag):
     *    - string         : 用作初始值
     *    - null/undefined : 让 claude 用模型默认 effort
     *
     *  既存 session 的 effort 切换走 submit(effortLevel) — 在那里和 turn 入队
     *  原子串行,避免 getOrCreate→submit 之间的窗口期被另一条并发消息覆盖。 */
    effortLevel?: string | null
  }): Promise<AgentSession> {
    // 新建时 null 等同 undefined(都让 claude 用模型默认)
    const initialEffort: string | undefined =
      opts.effortLevel === null ? undefined : opts.effortLevel

    const providerTag = SessionManager.providerTag(opts.agent.provider)
    const existing = this.sessions.get(opts.sessionKey)
    if (existing) {
      if (existing.runnerProviderTag !== providerTag) {
        // Same logical client session, but the agent was switched between
        // Claude Code and Codex. Native resume ids are provider-specific, so
        // tear down the old runner and let the fresh one receive a compact
        // transcript preamble on its first submit().
        try {
          await existing.lock
          await existing.runner.shutdown()
        } catch (err) {
          log.warn('provider-switch shutdown failed', { sessionKey: opts.sessionKey }, err)
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
        return existing
      }
    }
    const cwd = opts.agent.cwd ?? process.cwd()
    const persona = opts.agent.persona ?? paths.agentClaudeMd(opts.agent.id)
    // provider=codex-native routes to `codex` CLI instead of CCB; runner shape
    // (EventEmitter with start/submit/shutdown + same events) is compatible,
    // so upstream session bookkeeping works unchanged.
    //
    // Within codex-native, `agent.runnerKind` picks the codex backend:
    //   'exec'        — legacy `codex exec` per-turn subprocess (no token streaming)
    //   'app-server'  — `codex app-server` long-lived JSON-RPC (token-level streaming)
    // Existing hand-written agents.yaml entries with no runnerKind keep the
    // legacy exec fallback; Agent API normalizes codex-native saves to
    // app-server so newly managed agents get realtime events by default.
    const codexResumeId = this._resumeIdFor(opts.sessionKey, providerTag)
    const codexModel = opts.agent.model ?? this.config.defaults.model
    // Effective egress proxy: per-agent override falls through to global config.
    // Empty / whitespace-only strings are normalized to undefined so a UI "clear
    // this field" doesn't accidentally short-circuit the global fallback at the
    // agent layer.
    const effectiveProxyUrl =
      normalizeProxyUrl(opts.agent.proxyUrl) ?? normalizeProxyUrl(this.config.proxyUrl)
    let runner: SubprocessRunner
    if (opts.agent.provider === 'codex-native') {
      // Only resume if the persisted id was produced by a codex-native runner —
      // feeding a CCB session_id to either codex backend would make codex reject
      // the id or attach to a nonexistent thread.
      // Platform context injection (parity with the ccb subprocessRunner
      // branch below): forward persona / config / claudeCodePath / etc. so
      // the codex runner can build extra-prompt.md + mount mcp-memory via
      // `-c` overrides. Without these the codex agent would launch "naked"
      // with no awareness of OpenClaude's slot pipeline (SOUL/USER/SKILLS/
      // MEMORY/AGENTS/TOOLS/RESEARCH).
      // Fail-CLOSED (Codex HIGH #7): only the app-server runner performs the
      // uid/gid privilege drop. If a runAsUser agent were routed to any other
      // runner (legacy `codex exec` / CCB), codex would launch as the root
      // gateway user — silently defeating the self-heal OS boundary. Refuse.
      if (opts.agent.runAsUser && opts.agent.runnerKind !== 'app-server') {
        throw new Error(
          `agent "${opts.agent.id}": runAsUser requires runnerKind=app-server ` +
            `(got ${JSON.stringify(opts.agent.runnerKind ?? 'exec')}); refusing to spawn un-dropped`,
        )
      }
      if (opts.agent.runnerKind === 'app-server') {
        runner = new CodexAppServerRunner({
          sessionKey: opts.sessionKey,
          agentId: opts.agent.id,
          cwd,
          resumeSessionId: codexResumeId,
          model: codexModel,
          proxyUrl: effectiveProxyUrl,
          persona,
          agentProvider: opts.agent.provider,
          effortLevel: initialEffort,
          config: this.config,
          delegationDepth: opts.delegationDepth,
          runAsUser: opts.agent.runAsUser,
        }) as unknown as SubprocessRunner
      } else {
        runner = new CodexRunner({
          sessionKey: opts.sessionKey,
          agentId: opts.agent.id,
          cwd,
          resumeSessionId: codexResumeId,
          model: codexModel,
          proxyUrl: effectiveProxyUrl,
          persona,
          agentProvider: opts.agent.provider,
          effortLevel: initialEffort,
          config: this.config,
          delegationDepth: opts.delegationDepth,
        }) as unknown as SubprocessRunner
      }
    } else {
      runner = new SubprocessRunner({
        sessionKey: opts.sessionKey,
        agentId: opts.agent.id,
        cwd,
        config: this.config,
        persona,
        model: opts.agent.model ?? this.config.defaults.model,
        permissionMode: opts.agent.permissionMode ?? this.config.defaults.permissionMode,
        agentProvider: opts.agent.provider,
        agentMcpServers: opts.agent.mcpServers,
        agentToolsets: opts.agent.toolsets ?? this.config.defaults.toolsets,
        delegationDepth: opts.delegationDepth,
        // Symmetrically: only resume claude from a claude-tagged id.
        resumeSessionId: this._resumeIdFor(opts.sessionKey, providerTag),
        effortLevel: initialEffort,
        proxyUrl: effectiveProxyUrl,
      })
    }
    const now = Date.now()
    const session: AgentSession = {
      sessionKey: opts.sessionKey,
      agentId: opts.agent.id,
      channel: opts.channel ?? 'webchat',
      peerId: opts.peerId ?? 'unknown',
      userId: opts.userId,
      title: opts.title ?? 'New conversation',
      startedAt: now,
      runner,
      runnerProviderTag: providerTag,
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
      totalCostUSD: this._lastCostFor(opts.sessionKey, providerTag) ?? 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      turns: 0,
      _lastCcbCumulativeCost: this._lastCostFor(opts.sessionKey, providerTag) ?? 0,
      model: opts.agent.model ?? this.config.defaults.model,
      toolUseIdToName: new Map(),
    }
    runner.on('session_id', (id: string) => {
      session.ccbSessionId = id
      // Remember which provider produced this id — the next getOrCreate on
      // this sessionKey (possibly after a gateway restart switching providers)
      // uses the tag to decide whether to pass the id through as --resume.
      this._resumeMapProvider.set(opts.sessionKey, providerTag)
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
      if (info.crashed) {
        log.warn('subprocess crashed', {
          sessionKey: opts.sessionKey,
          code: info.code,
          signal: info.signal,
        })
        // Ensure the session stays in resume-map so it can be restored on next submit()
        // (SubprocessRunner.submit() auto-restarts with --resume when proc is null)
        if (session.ccbSessionId) {
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
    /** Codex-native app-server only. Omitted means default mode so a previous
     *  plan-first turn cannot leak into ordinary follow-up turns. */
    conversationMode?: 'default' | 'plan',
    goalObjective?: string,
    /** 来自 InboundMessage.model,per-session 模型覆盖。提供且与 runner 当前 model
     *  不同时,在本 turn 启动前 setModel + shutdown(下次 submit 自动用新 model 重启),
     *  与 effort 同机制、同 lock chain。缺省则不动(用 agent 默认 model)。
     *  仅对支持 setModel 的 runner(SubprocessRunner)生效;codex runner 无则忽略。 */
    model?: string,
  ): Promise<void> {
    // 闭包捕获:即便后面再有 submit 也不会改这个常量
    const desiredEffort: string | undefined = effortLevel === null ? undefined : effortLevel
    const callerSpecifiedEffort = effortLevel !== undefined

    const prev = session.lock
    let release!: () => void
    session.lock = new Promise<void>((r) => (release = r))
    let eventGate: ReturnType<typeof createIdleTimeoutEventGate> | null = null
    let turnPromise: Promise<void> | null = null
    try {
      await prev
      // P2.2 minimal strict gate: if a continuation watch from the prior turn is
      // still delivering/persisting the late continuation (out-of-lock), let it
      // finish BEFORE this user submit repoints the pump / writes stdin — otherwise
      // the in-flight continuation's frames would be misrouted into this turn's
      // parser. Bounded by the watch backstop. (P2.3 refines into the full strict
      // state machine + supersede.)
      if (session._continuationWatch) {
        // Bound the wait. The watch's own backstop can be repeatedly re-armed by
        // a background workflow that keeps emitting activity, so `done` may never
        // resolve on its own — which would wedge THIS user submit indefinitely
        // BEFORE the liveness watchdog (armed later, after this gate) ever runs.
        // That is exactly how a turn ends up `running` for tens of minutes with
        // zero idle-timeout firing. If the watch overstays the backstop window,
        // force it to end (which resolves `done` + detaches its handlers) so this
        // turn can proceed instead of hanging forever.
        const CONTINUATION_DRAIN_LIMIT_MS = CONTINUATION_WATCH_BACKSTOP_MS + 60_000
        let drainTimer: NodeJS.Timeout | undefined
        const drained = new Promise<void>((r) => {
          drainTimer = setTimeout(r, CONTINUATION_DRAIN_LIMIT_MS)
          drainTimer.unref?.()
        })
        await Promise.race([session._continuationWatch.done, drained])
        if (drainTimer) clearTimeout(drainTimer)
        if (session._continuationWatch && !session._continuationWatch.ended) {
          log.warn('continuation watch exceeded drain limit — forcing end before new turn', {
            sessionKey: session.sessionKey,
          })
          this._endContinuationWatch(session)
        }
      }
      // effort 应用必须在本 turn 真正启动**之前**完成,且必须在 prev 之后:
      //   - prev 之前:可能中断别人的 in-flight turn
      //   - 本 turn 之后:env 已被 CCB 启动时读完,改也无效
      // 同时受 lock chain 保护,后到的 submit 想 set 别的 effort 也得排在我们后面。
      if (callerSpecifiedEffort && session.runner.effortLevel !== desiredEffort) {
        try {
          session.runner.setEffortLevel(desiredEffort)
          await session.runner.shutdown()
          // Delta tracker reset happens automatically on the next 'spawn' event
          // when SubprocessRunner auto-respawns on the next submit().
        } catch (err) {
          log.warn('effort-change shutdown failed', { sessionKey: session.sessionKey }, err)
        }
      }
      // Per-session model override (same recycle mechanism as effort, same lock
      // chain). Only applies to runners that expose setModel — codex-native
      // runners don't (model semantics differ), so the override is ignored there
      // rather than throwing. The new model is read by buildClaudeCliArgs on the
      // next spawn, so we must shutdown the current subprocess for it to apply.
      const setModel = (session.runner as { setModel?: (m?: string) => void }).setModel
      if (model && typeof setModel === 'function' && session.runner.model !== model) {
        try {
          setModel.call(session.runner, model)
          await session.runner.shutdown()
        } catch (err) {
          log.warn('model-change shutdown failed', { sessionKey: session.sessionKey }, err)
        }
      }
      const cleanGoalObjective =
        typeof goalObjective === 'string' && goalObjective.trim().length > 0
          ? goalObjective.trim()
          : undefined
      if (cleanGoalObjective) {
        const maybeSetGoal = (session.runner as any).setGoal
        if (typeof maybeSetGoal !== 'function') {
          onEvent({ kind: 'error', error: '当前 Codex runner 不支持 goals' })
          return
        }
        try {
          await maybeSetGoal.call(session.runner, {
            objective: cleanGoalObjective,
            status: 'active',
          })
        } catch (err) {
          log.warn('goal-mode setGoal failed', {
            sessionKey: session.sessionKey,
            err: (err as Error).message,
          })
          onEvent({
            kind: 'error',
            error: `Codex goal 启用失败: ${(err as Error).message}`,
          })
          return
        }
      }
      const maybeSetConversationMode = (session.runner as any).setConversationMode
      if (typeof maybeSetConversationMode === 'function') {
        maybeSetConversationMode.call(session.runner, conversationMode ?? 'default')
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
      let recoveryNotice: SessionStreamEvent | null = null
      const nativeResumeId = this._resumeIdFor(session.sessionKey, session.runnerProviderTag)
      const shouldRecoverFromHistory =
        !session._historicalContextInjected &&
        session.channel === 'webchat' &&
        session.turns > 0 &&
        typeof userTextOrBlocks === 'string' &&
        !nativeResumeId
      if (shouldRecoverFromHistory) {
        if (
          shouldClarifyNonNativeResume({
            channel: session.channel,
            turns: session.turns,
            hasNativeResumeId: !!nativeResumeId,
            userText: userTextOrBlocks,
          })
        ) {
          const clarificationText = buildNonNativeResumeClarificationText()
          log.info('clarified ambiguous non-native resume instead of submitting to runner', {
            sessionKey: session.sessionKey,
            provider: session.runnerProviderTag,
            userText: userTextOrBlocks,
          })
          onEvent({
            kind: 'block',
            block: { kind: 'text', text: clarificationText },
          })
          onEvent({ kind: 'final' })
          return
        }
        try {
          const clientSession = await getClientSession(session.peerId, session.userId)
          const historicalPrompt = clientSession
            ? buildHistoricalContextPrompt(clientSession.messages, userTextOrBlocks)
            : null
          if (historicalPrompt) {
            runnerPayload = historicalPrompt
            recoveryNotice = {
              kind: 'block',
              block: {
                kind: 'text',
                text: '🔄 此会话无法原生恢复，正在用最近历史恢复上下文…\n',
              },
            }
            session._historicalContextInjected = true
            log.info('injected historical context for provider switch / non-native resume', {
              sessionKey: session.sessionKey,
              provider: session.runnerProviderTag,
              messageCount: clientSession?.messages?.length ?? 0,
            })
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
      // handleStdout) — claude streams partial-message deltas and stream_event
      // rows throughout a turn, so a live subprocess keeps refreshing even
      // during long tools that produce no content blocks.
      // Thresholds tuned for "process active but deadlocked" detection speed
      // (was 30/60min pre-2026-04-19):
      //   - Tool call in progress (MCP/Bash/sub-agent): 15 min
      //   - Context compaction in progress: 20 min (do not kill ordinary
      //     auto-compact because it has no user-visible token stream)
      //   - No tool call pending (API streaming / idle): 5 min
      // _runOneTurn has a separate 30-min idle timer as a tighter
      // turn-level backstop that resets on every stdout message.
      const CHECK_INTERVAL = 15_000 // check every 15s
      let livenessTimer: NodeJS.Timeout | null = null
      const turnStartedAt = Date.now()
      let visibleActivityAt = turnStartedAt
      // Latched on this turn's first observable-output event (block /
      // permission_request — the same "producedOutput" signal used by the
      // continuation watcher). Status / heartbeat-only events do NOT count.
      // Gates the codex cold-start grace (see
      // LIVENESS_IDLE_TIMEOUT_CODEX_FIRST_TOKEN_MS / resolveLivenessIdle).
      let hasVisibleProgress = false
      eventGate = createIdleTimeoutEventGate(
        (e) => {
          visibleActivityAt = Date.now()
          // Latch on real model output. The gateway-synthesized recoveryNotice is
          // emitted before the turn starts and is NOT model progress, so it must
          // not end the codex cold-start grace (a non-native-resume turn can still
          // reason for >5min before its first real block).
          if ((e.kind === 'block' || e.kind === 'permission_request') && e !== recoveryNotice) {
            hasVisibleProgress = true
          }
          onEvent(e)
        },
        (e, count) => {
          if (count <= 3) {
            log.warn('suppressed late event after idle timeout', {
              sessionKey: session.sessionKey,
              kind: e.kind,
              count,
            })
          }
        },
      )
      const livenessPromise = new Promise<never>((_, reject) => {
        livenessTimer = setInterval(() => {
          const { idleMs, threshold } = resolveLivenessIdle({
            runner: session.runner,
            hasVisibleProgress,
            parser: session._currentParser,
            turnStartedAt,
            visibleActivityAt,
            now: Date.now(),
          })
          if (idleMs > threshold) {
            reject(new Error(`idle timeout (${Math.round(idleMs / 1000)}s no output)`))
          }
        }, CHECK_INTERVAL)
      })
      if (recoveryNotice) eventGate.emit(recoveryNotice)
      turnPromise = this.runOneTurnWithRetry(session, runnerPayload, eventGate.emit)
      try {
        await Promise.race([turnPromise, livenessPromise])
      } finally {
        if (livenessTimer) clearInterval(livenessTimer)
      }
    } catch (err: any) {
      if (err?.message?.includes('idle timeout')) {
        if (!eventGate || !turnPromise) throw err
        // Extract idle seconds from the inner error so the user-facing
        // message reflects the actual silence duration (avoids confusing
        // mismatch with the inner 30-min idle timer's fixed wording).
        const m = /\((\d+)s/.exec(String(err?.message))
        const minutes = m ? Math.round(Number(m[1]) / 60) : null
        const detail = minutes ? `约 ${minutes} 分钟无输出` : '长时间无输出'
        onEvent({
          kind: 'error',
          error: `子进程${detail},已中断。请重试。`,
        })
        eventGate.suppress()

        // Actually interrupt the active turn. For codex app-server, an
        // interrupt can leave the long-lived JSON-RPC process wedged/high-CPU;
        // hard-reset that runner so the next submit respawns a fresh process
        // instead of reusing the stuck one. Keep this scoped to app-server:
        // legacy codex exec is per-turn, and CCB has different interrupt
        // semantics.
        let interrupted = false
        try {
          interrupted = session.runner.interrupt()
        } catch (interruptErr) {
          log.warn('idle timeout interrupt failed', {
            sessionKey: session.sessionKey,
            err: (interruptErr as Error).message,
          })
        }

        const hardResetRunner = shouldHardResetRunnerAfterIdleTimeout(session.runner)
        let hardResetDone = false
        let hardResetError: string | undefined
        if (hardResetRunner) {
          try {
            await session.runner.shutdown()
            hardResetDone = true
          } catch (shutdownErr) {
            hardResetError = (shutdownErr as Error).message
            log.error('idle timeout hard reset failed', {
              sessionKey: session.sessionKey,
              err: hardResetError,
            })
          }
        }

        let oldTurnSettled = false
        await Promise.race([
          turnPromise
            .then(() => {
              oldTurnSettled = true
            })
            .catch((turnErr) => {
              oldTurnSettled = true
              log.warn('idle timeout old turn promise rejected after recovery', {
                sessionKey: session.sessionKey,
                err: (turnErr as Error).message,
              })
            }),
          new Promise<void>((resolve) => setTimeout(resolve, IDLE_TIMEOUT_TURN_DRAIN_MS)),
        ])

        log.error(
          'idle timeout, interrupted',
          {
            sessionKey: session.sessionKey,
            interrupted,
            hardResetRunner,
            hardResetDone,
            ...(hardResetError ? { hardResetError } : {}),
            oldTurnSettled,
            suppressedLateEvents: eventGate.suppressedCount(),
          },
          err,
        )
      } else {
        throw err
      }
    } finally {
      release()
    }
  }

  /**
   * At-most-once submit keyed by a durable `executionId` (self-heal slice ②).
   *
   * The dedup ledger lives in selfheal.db and is the *only* thing added on top
   * of the ordinary {@link submit} path:
   *
   *   1. {@link enqueueExecution} — in ONE transaction, write the execution row
   *      ('accepted') AND the durable_turn_queue row ('queued'). This is the
   *      commit point: `accepted` therefore ALWAYS implies a queued turn exists,
   *      so we can never "record accepted but never submit" (the permanent
   *      swallow). Idempotent on executionId.
   *   2. {@link claimQueuedTurn} — CAS queued→consumed (+ execution
   *      accepted→running) in one transaction. EXACTLY ONE caller wins. The
   *      winner (and only it) runs the real turn; everyone else returns the
   *      existing status WITHOUT creating a second turn.
   *   3. Run the turn via the shared {@link submit} path, then settle the
   *      execution status to done/failed.
   *
   * Crash semantics (called ONLY by the jobWorker, under its job lease — the
   * lease guarantees no other live attempt for this executionId):
   *   - crash BEFORE the claim → row stays 'queued' → a re-drive wins the CAS and
   *     submits (no swallow);
   *   - crash AFTER the claim, mid-submit → execution stuck 'running' / queue
   *     'consumed'. Step 0 re-opens that crashed attempt (safe: the prior owner
   *     is dead — its job lease elapsed before re-claim), so the re-drive wins
   *     the CAS and RE-RUNS instead of silently failing the repair (Codex HIGH
   *     #9). Turn execution is thus at-LEAST-once; the broker keeps the actual
   *     privileged SIDE EFFECTS at-most-once, so a re-run never double-deploys.
   *   - a completed ('done') execution is never re-opened → no re-run after
   *     success.
   *
   * `ranHere` tells the caller whether THIS call executed the turn (vs. observed
   * an already-consumed one), so it can map the outcome onto its own bookkeeping.
   */
  async submitWithExecutionId(
    session: AgentSession,
    prompt: string,
    executionId: string,
    onEvent: (e: SessionStreamEvent) => void,
  ): Promise<{ executionId: string; status: SelfhealExecutionStatus; ranHere: boolean }> {
    // 0. Crash recovery: if a prior attempt crashed mid-submit (execution stuck
    //    'running', turn 'consumed'), re-open it so this re-drive can win the CAS
    //    and re-run instead of the repair being silently lost. Safe under the job
    //    lease (no live prior attempt); a 'done' execution is never re-opened.
    await reopenExecutionForRedrive(executionId)

    // 1. Durable, idempotent enqueue (accepted + queued in one txn).
    await enqueueExecution({ executionId, sessionKey: session.sessionKey })

    // 2. Claim the single turn. Losing the CAS means it was already consumed —
    //    return the current status without creating a second turn.
    const won = await claimQueuedTurn(executionId)
    if (!won) {
      const exec = await getExecution(executionId)
      return { executionId, status: exec?.status ?? 'accepted', ranHere: false }
    }

    // 3. We own the turn (execution is now 'running'). Reuse the normal submit
    //    path; settle the ledger on completion.
    try {
      await this.submit(session, prompt, onEvent)
      await setExecutionStatus(executionId, 'done')
      return { executionId, status: 'done', ranHere: true }
    } catch (err) {
      await setExecutionStatus(executionId, 'failed')
      throw err
    }
  }

  private async runOneTurnWithRetry(
    session: AgentSession,
    userTextOrBlocks: string | Array<{ type: string; [key: string]: unknown }>,
    onEvent: (e: SessionStreamEvent) => void,
  ): Promise<void> {
    const MAX_RETRIES = 3
    const BASE_DELAY = 2000
    // PHANTOM_TURN 用独立计数器,不和 transient 共用 attempt budget。
    // 第 0 次 phantom → 重启子进程 + retry 1 次;第 1 次还是 phantom → 终态 error,不再重试。
    let phantomRetryUsed = false
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this._runOneTurn(session, userTextOrBlocks, onEvent)
        return // success
      } catch (err: any) {
        const msg = err?.message ?? String(err)

        // Phantom turn: CCB 返回了不调模型的空 result(usage/cost/blocks 全为 0)。
        // 通常是 CCB 子进程长闲置后内部状态卡死,重启子进程能恢复。
        if (/PHANTOM_TURN/i.test(msg)) {
          log.warn('phantom turn detected, restarting subprocess', {
            sessionKey: session.sessionKey,
            phantomRetryUsed,
          })
          // shutdown → 下次 submit() 会自动 respawn 一个干净的 CCB 进程。
          // 子进程重启时 runner 的 'spawn' 事件会自动把 _lastCcbCumulativeCost 归零。
          await session.runner.shutdown()
          if (phantomRetryUsed) {
            // 重启过一次还是 phantom,不再循环。emit 终态 error(走和 idle_timeout 一样的路径,
            // server.ts 会把 kind:'error' 转成 isFinal:true 的可见错误帧)。
            onEvent({
              kind: 'error',
              error: 'CCB 子进程持续返回空响应,已重启子进程。请重新发送消息或检查 gateway 日志。',
            })
            return
          }
          phantomRetryUsed = true
          onEvent({
            kind: 'block',
            block: {
              kind: 'text',
              text: '\n\n🔄 CCB 子进程返回空响应(未调模型),已重启子进程并自动重试...\n',
            },
          })
          // Don't consume transient-retry budget on a phantom retry. The for-loop's
          // `attempt++` would otherwise eat one slot from MAX_RETRIES (originally
          // intended for 529/503/rate-limit), which would silently shorten the
          // retry budget for any subsequent transient error in this turn.
          attempt--
          continue
        }

        // Auth error (401): refresh credentials and restart subprocess
        if (/AUTH_ERROR/i.test(msg)) {
          log.warn('auth error, refreshing credentials and restarting subprocess', {
            sessionKey: session.sessionKey,
            attempt: attempt + 1,
          })
          // Trigger immediate token refresh via gateway callback
          if (this.onAuthError) {
            try {
              await this.onAuthError()
            } catch (e) {
              log.error(
                'onAuthError callback failed',
                { sessionKey: session.sessionKey },
                e as Error,
              )
            }
          }
          // Shutdown subprocess — next submit() auto-restarts with fresh config.
          // Runner 'spawn' listener resets _lastCcbCumulativeCost automatically.
          await session.runner.shutdown()
          if (attempt >= MAX_RETRIES) throw err
          onEvent({
            kind: 'block',
            block: {
              kind: 'text',
              text: '\n\n🔄 认证已过期,正在刷新凭据并重试...\n',
            },
          })
          continue
        }

        // Only retry on transient errors (rate limit, server error, network)
        const isTransient =
          /529|503|502|504|ECONNRESET|ETIMEDOUT|rate.limit|overloaded|AbortError|operation was aborted|timed?\s*out/i.test(
            msg,
          )
        if (!isTransient || attempt >= MAX_RETRIES) throw err
        const delay = BASE_DELAY * 2 ** attempt + Math.random() * 1000
        log.warn('transient error, retrying', {
          sessionKey: session.sessionKey,
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          delayS: Math.round(delay / 1000),
          error: msg,
        })
        onEvent({
          kind: 'block',
          block: {
            kind: 'text',
            text: `\n\n⚠️ 遇到临时错误,${Math.round(delay / 1000)}秒后自动重试 (${attempt + 1}/${MAX_RETRIES})...\n`,
          },
        })
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }

  // Auth error keywords — only matched when result.isError is true, so safe to be broad.
  // Covers CCB's auth-related error strings from src/services/api/errors.ts:
  //   INVALID_API_KEY_ERROR_MESSAGE           = 'Not logged in · Please run /login'
  //   INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL  = 'Invalid API key · Fix external API key'
  //   TOKEN_REVOKED_ERROR_MESSAGE             = 'OAuth token revoked · Please run /login'
  //   OAUTH_ORG_NOT_ALLOWED_ERROR_MESSAGE     = 'Your account does not have access to Claude Code. Please run /login.'
  //   Generic 401/403 handler                 = 'Please run /login · API Error: ...' / 'Failed to authenticate. ...'
  //   ORG_DISABLED_ERROR_MESSAGE_ENV_KEY(_WITH_OAUTH) = 'Your ANTHROPIC_API_KEY belongs to a disabled organization · ...'
  // The `run /login` substring is the common signal across all CCB login-required
  // paths; the rest catch status-code / revoke / org-disabled phrasings that
  // don't necessarily include a /login prompt.
  private static AUTH_KEYWORDS_RE =
    /authenticat|credentials|401|unauthorized|run \/login|token (?:has been )?revoked|invalid api key|organization has been disabled/i
  // CCB's exact error prefix when API auth fails — safe to match even without isError flag.
  private static AUTH_ERROR_PREFIX_RE = /^Failed to authenticate\b/

  private async _runOneTurn(
    session: AgentSession,
    userTextOrBlocks: string | Array<{ type: string; [key: string]: unknown }>,
    onEvent: (e: SessionStreamEvent) => void,
  ): Promise<void> {
    const { runner } = session
    const turnStartTime = Date.now()
    let turnToolCallCount = 0
    let turnBlockCount = 0
    let turnPermissionCount = 0

    // Snapshot session totals so we can roll back on auth error / phantom turn
    // (parser mutates these directly via sessionTotals reference)
    const prevCostUSD = session.totalCostUSD
    const prevTurns = session.turns
    const prevLastCcbCost = session._lastCcbCumulativeCost

    // Stamp the active turnId before the first block streams. Reads live
    // session.turns + 1 — the value session.turns reaches once this turn's
    // result increments it (matching the durable-append id), so streaming
    // frames and the persisted server-authored row share one turnId. Refreshed
    // on each background-workflow re-arm so continuations get their own turnId.
    const refreshActiveTurnId = () => {
      session._activeTurnId = session.peerId
        ? serverAuthoredMsgId(session.peerId, session.turns + 1)
        : undefined
    }
    refreshActiveTurnId()

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true
          fn()
        }
      }

      // Idle timeout — refreshed on every runner message (see handleMessage below).
      // A turn is only killed if the agent produces no output for this long, so long
      // active tasks keep running while genuinely stuck turns still get interrupted.
      const IDLE_TIMEOUT_MS = 30 * 60 * 1000 // 30 min of silence from runner
      const timer = setTimeout(() => {
        if (!parser.finalized) {
          try {
            runner.interrupt()
          } catch {}
          onEvent({
            kind: 'error',
            error: '单轮对话空闲超时 (30 分钟无输出),已中断。请重试。',
          })
          detach()
          settle(() => resolve())
        }
      }, IDLE_TIMEOUT_MS)

      // Background-workflow continuation soft cap. After a sub-turn launches a
      // background Workflow we hold the turn open for the proactive result turn
      // (re-arm in onFinish). claude normally continues within seconds of the
      // workflow completing, but it is NOT guaranteed (e.g. the agent deferred to
      // a far ScheduleWakeup, or the workflow produced no follow-up). Without a
      // bound the session would sit "thinking" until the 30-min idle cap. So once
      // continuation-waiting, if the runner goes silent for this long we resolve
      // GRACEFULLY — no interrupt, the persistent process lives on. NOTE: a
      // continuation that arrives AFTER this resolve is dropped (the finalized
      // parser ignores it until the next turn re-arms); the user can re-ask. This
      // is the accepted tail-loss tradeoff of the 90s soft cap.
      const CONTINUATION_WAIT_MS = 90 * 1000
      let continuationTimer: ReturnType<typeof setTimeout> | null = null

      // Buffer 'final' event — only forward to client after auth check passes
      let pendingFinal: SessionStreamEvent | null = null
      const wrappedOnEvent = (e: SessionStreamEvent) => {
        // Track all observable output for phantom-turn detection.
        // permission_request counts as real output too (visible permission card),
        // so it must NOT be flagged as phantom even if usage is 0.
        if (e.kind === 'block') turnBlockCount++
        else if (e.kind === 'permission_request') turnPermissionCount++
        // A background Workflow launched this sub-turn → claude will proactively
        // emit a continuation turn with the result once it completes. Keep the
        // turn open (see onFinish re-arm) so that result is not dropped.
        else if (e.kind === 'workflow_progress' && e.stage === 'started') {
          expectsContinuation = true
        }
        if (e.kind === 'final') {
          pendingFinal = e
          return
        }
        onEvent(e)
      }

      // Per-turn parse_error listener (previously only installed at runner
      // construction). Must be detached with the rest to avoid per-turn
      // listener accumulation (R9).
      const handleParseError = (payload: { line: string; err: unknown }) => {
        const err = payload.err as Error | undefined
        log.warn('claude stdout parse_error', {
          sessionKey: session.sessionKey,
          msg: err?.message,
          sample: payload.line?.slice(0, 200),
        })
      }

      // ── ultracode background-workflow continuation ──
      // When a sub-turn launches a background Workflow, claude proactively emits
      // a fresh turn (task_notification → init → assistant → result) on the SAME
      // runner once it completes — no stdin needed. We keep the turn open and
      // re-arm a fresh parser for each continuation so the workflow's result
      // answer is delivered + persisted instead of hitting the finalized-parser
      // drop. The turn resolves only on a result whose sub-turn did NOT launch a
      // background workflow. `parser` is reassigned on each re-arm; `detach` /
      // `handleMessage` always read the current one. Capped to bound runaway chains.
      let parser: ClaudeMessageParser
      let expectsContinuation = false
      let continuationCount = 0
      const MAX_CONTINUATIONS = 16

      let detached = false
      const detach = () => {
        if (detached) return
        detached = true
        clearTimeout(timer)
        if (continuationTimer) {
          clearTimeout(continuationTimer)
          continuationTimer = null
        }
        parser.finish()
        // Only clear if still pointing to this turn's parser (prevents race
        // where idle-timeout releases the lock, a new turn starts and sets
        // a new parser, then this stale detach wipes the new reference).
        if (session._currentParser === parser) session._currentParser = undefined
        // 故意不动 session._currentTurnHandler:permanent pump 仍指向本轮 handler,
        // 下一轮 _runOneTurn 会 repoint;期间 post-result 帧落到已 finalized 的旧
        // parser 被丢弃(保留 "replace not remove" 语义)。pump 本身常驻不卸载。
        runner.off('error', handleError)
        runner.off('exit', handleExit)
        runner.off('parse_error', handleParseError)
      }

      // (Re)arm the continuation soft-cap. Called when a sub-turn re-arms for a
      // background-workflow continuation, and refreshed on every runner message
      // while waiting. Fires only if the runner goes fully silent past the cap —
      // resolves gracefully (no interrupt; process kept alive).
      const armContinuationTimer = () => {
        if (continuationTimer) clearTimeout(continuationTimer)
        continuationTimer = setTimeout(() => {
          if (detached) return
          log.info('background-workflow continuation wait timed out — resolving gracefully', {
            sessionKey: session.sessionKey,
          })
          if (pendingFinal) onEvent(pendingFinal)
          onEvent({ kind: 'final' })
          detach()
          settle(() => resolve())
        }, CONTINUATION_WAIT_MS)
      }

      // Parser config is reused to re-arm a fresh parser on each background-
      // workflow continuation (see onFinish). Callbacks close over the mutable
      // `parser` + continuation flags, so one config object serves every sub-turn.
      const parserConfig: ConstructorParameters<typeof ClaudeMessageParser>[0] = {
        toolUseIdToName: session.toolUseIdToName,
        onEvent: wrappedOnEvent,
        onToolUse: (tool) => {
          turnToolCallCount++
          // Bridge CCB CronCreate/CronDelete via EventBus
          if (tool.name === 'CronCreate') {
            const gatewayJobId = `ccb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
            if (!session._cronBridgeMap) session._cronBridgeMap = new Map()
            session._cronBridgeMap.set(`_pending:${tool.id}`, gatewayJobId)
            eventBus.emit(
              'task.created',
              createEvent('task.created', session.agentId, {
                taskId: gatewayJobId,
                schedule: tool.input.cron,
                prompt: tool.input.prompt,
                oneshot: tool.input.recurring === false,
                source: 'cron-bridge',
              }),
            )
          } else if (tool.name === 'CronDelete') {
            const ccbId = tool.input.id
            const gatewayId = session._cronBridgeMap?.get(ccbId) ?? ccbId
            eventBus.emit(
              'task.deleted',
              createEvent('task.deleted', session.agentId, {
                taskId: gatewayId,
              }),
            )
          }
        },
        onToolResult: (tr) => {
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
          eventBus.emit(
            'tool.called',
            createEvent('tool.called', session.agentId, {
              sessionKey: session.sessionKey,
              turnIndex: session.turns + 1,
              toolName: tr.toolName,
              durationMs: tr.durationMs,
              isError: tr.isError,
              inputPreview: tr.inputPreview,
              outputPreview: tr.preview ? tr.preview.slice(0, 500) : undefined,
            }),
          )
        },
        onFinish: (result) => {
          // NB: do NOT detach() unconditionally — a background-workflow sub-turn
          // re-arms below and must keep its idle timer + crash listeners alive.
          // Every terminal branch (auth / phantom / normal) calls detach() itself.

          // Detect auth error in assistant output — roll back counters and reject.
          // Two signals: (1) isError + broad keyword match, (2) claude's exact error prefix.
          const isAuthError =
            result &&
            ((result.isError && SessionManager.AUTH_KEYWORDS_RE.test(result.assistantText)) ||
              SessionManager.AUTH_ERROR_PREFIX_RE.test(result.assistantText))
          if (isAuthError) {
            session.totalCostUSD = prevCostUSD
            session.turns = prevTurns
            session._lastCcbCumulativeCost = prevLastCcbCost
            detach()
            settle(() => reject(new Error('AUTH_ERROR: Token expired or invalid')))
            return
          }

          // Phantom-turn detection (observable-output heuristic).
          // Official `claude` has no `_oc_telemetry` side-channel, so we judge
          // purely from what the turn produced. A turn is phantom only when a
          // plain (non-slash) string prompt yields a clean result with zero
          // tokens, zero cost, and zero observable output — i.e. claude returned
          // without ever invoking the model. Slash commands legitimately make
          // no model call, so they're excluded. This is the same conservative
          // heuristic the telemetry path fell back to when no signal arrived
          // (R7: never fail closed — a real turn is never misflagged).
          const userInputStr = typeof userTextOrBlocks === 'string' ? userTextOrBlocks : null
          const isStringInput = userInputStr !== null
          const isSlashCommand = isStringInput && userInputStr!.trimStart().startsWith('/')

          const isPhantomTurn =
            !!result &&
            isStringInput &&
            !isSlashCommand &&
            !result.isError &&
            result.inputTokens === 0 &&
            result.outputTokens === 0 &&
            result.cacheReadTokens === 0 &&
            result.cacheCreationTokens === 0 &&
            result.cost === 0 &&
            turnToolCallCount === 0 &&
            turnBlockCount === 0 &&
            turnPermissionCount === 0

          if (isPhantomTurn) {
            // Roll back parser-mutated counters (parser already incremented
            // turns and may have touched cost/cumulative even if delta was 0).
            session.totalCostUSD = prevCostUSD
            session.turns = prevTurns
            session._lastCcbCumulativeCost = prevLastCcbCost
            log.warn('phantom turn — claude returned empty result without invoking model', {
              sessionKey: session.sessionKey,
              turnIndex: session.turns + 1,
              durationMs: Date.now() - turnStartTime,
            })
            detach()
            settle(() => reject(new Error('PHANTOM_TURN: claude returned empty result')))
            return
          }

          // Forward the buffered 'final' event now that we know it's not an auth error
          if (pendingFinal) onEvent(pendingFinal)

          // Update session accumulators from turn result
          if (result) {
            session.totalInputTokens += result.inputTokens
            session.totalOutputTokens += result.outputTokens
            session.totalCacheReadTokens += result.cacheReadTokens
            session.totalCacheCreationTokens += result.cacheCreationTokens
            session.currentAssistantBuf = result.assistantText
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
              indexTurn(sessId, session.turns, session.currentUserText ?? '', result.assistantText),
            ]).catch((err) =>
              log.error('FTS5 index failed', { sessionKey: session.sessionKey }, err),
            )

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
            // Only applies to webchat sessions whose peerId matches a
            // client_sessions row (i.e., the UI created the session before
            // dispatching the first turn). Cron/webhook/telegram/delegate
            // turns are not routed to a per-user client session and thus
            // skip this path — they're tracked via sessions_meta / event_log
            // instead, and will be addressed in Phase 1 (channel broadcast).
            if (
              session.channel === 'webchat' &&
              result.assistantText &&
              result.assistantText.length > 0
            ) {
              const peerId = session.peerId
              const assistantText = result.assistantText
              const turnIndex = session.turns
              // Phase 0.4 P1-3 (tightened): use `session.userId` directly when
              // we have it — this lets `appendServerAuthoredMessageDurable`
              // route `session_not_found` into the outbox instead of silently
              // dropping when the client's debounced PUT hasn't landed yet.
              // Fall back to `getClientSession` lookup for legacy code paths
              // that didn't carry userId (cron pre-warm, old webchat calls).
              const directWrite = async () => {
                if (session.userId) {
                  const messageId = serverAuthoredMsgId(peerId, turnIndex)
                  const r = await appendServerAuthoredMessageDurable(peerId, session.userId, {
                    id: messageId,
                    role: 'assistant',
                    text: assistantText,
                    ts: Date.now(),
                    status: 'completed',
                  })
                  return { r, userId: session.userId }
                }
                const existing = await getClientSession(peerId)
                if (!existing) return undefined // cron-style pre-UI, no owner
                const messageId = serverAuthoredMsgId(peerId, turnIndex)
                const r = await appendServerAuthoredMessageDurable(peerId, existing.userId, {
                  id: messageId,
                  role: 'assistant',
                  text: assistantText,
                  ts: Date.now(),
                  status: 'completed',
                })
                return { r, userId: existing.userId }
              }
              directWrite()
                .then((writeResult) => {
                  const r = writeResult?.r
                  if (r?.applied && writeResult?.userId)
                    this.onClientSessionMutated?.(peerId, writeResult.userId)
                  if (r && !r.applied && r.reason !== 'already_exists') {
                    // 'queued_to_outbox' is an expected degraded-mode outcome
                    // (DB unavailable); log as warn not error so we don't spam
                    // error aggregators when disk/SQLite has a hiccup. The
                    // replay loop will pick it up on next restart.
                    if (r.reason === 'queued_to_outbox') {
                      log.warn('server-authored message queued to outbox (DB unavailable)', {
                        sessionKey: session.sessionKey,
                        peerId,
                        turnIndex,
                        error: r.error,
                      })
                    } else {
                      log.warn('server-authored message not persisted', {
                        sessionKey: session.sessionKey,
                        peerId,
                        turnIndex,
                        reason: r.reason,
                      })
                    }
                  }
                })
                .catch((err) => {
                  log.error(
                    'appendServerAuthoredMessage failed',
                    {
                      sessionKey: session.sessionKey,
                      peerId,
                      turnIndex,
                    },
                    err,
                  )
                })
            }

            // Emit turn.completed event (triggers event_log + usage_log persistence)
            const turnDurationMs = Date.now() - turnStartTime
            eventBus.emit(
              'turn.completed',
              createEvent('turn.completed', session.agentId, {
                sessionKey: session.sessionKey,
                turnIndex: session.turns,
                usage: {
                  inputTokens: result.inputTokens,
                  outputTokens: result.outputTokens,
                  cacheReadTokens: result.cacheReadTokens,
                  cacheCreationTokens: result.cacheCreationTokens,
                  costUsd: result.cost,
                  model: session.model,
                },
                toolCalls: turnToolCallCount,
                durationMs: turnDurationMs,
              }),
            )

            // Emit cost.recorded for budget tracking
            eventBus.emit(
              'cost.recorded',
              createEvent('cost.recorded', session.agentId, {
                sessionKey: session.sessionKey,
                turnIndex: session.turns,
                usage: {
                  inputTokens: result.inputTokens,
                  outputTokens: result.outputTokens,
                  cacheReadTokens: result.cacheReadTokens,
                  cacheCreationTokens: result.cacheCreationTokens,
                  costUsd: result.cost,
                  model: session.model,
                },
                sessionTotalCostUsd: session.totalCostUSD,
              }),
            )

            // Detect verification verdicts in assistant output and emit structured event
            const verdict = parseVerificationVerdict(result.assistantText)
            if (verdict) {
              eventBus.emit(
                'verification.result',
                createEvent('verification.result', session.agentId, {
                  sessionKey: session.sessionKey,
                  target: 'code' as const,
                  passed: verdict.passed,
                  evidence: verdict.evidence,
                }),
              )
              log.info('verification verdict', {
                sessionKey: session.sessionKey,
                verdict: verdict.verdict,
                checks: verdict.evidence.length,
                passed: verdict.passed,
              })
            }
          }
          // Continuation: this sub-turn launched a background task, so claude will
          // proactively emit the result answer as a fresh turn on the same runner.
          if (expectsContinuation && continuationCount < MAX_CONTINUATIONS) {
            if (session.channel === 'webchat') {
              // P2.2: RELEASE the submit lock now and hand off to an OUT-OF-LOCK
              // continuation watch. The watch (fed by the permanent pump) catches
              // the late continuation (median 3.3s, up to 16min), delivers it via
              // onContinuationEvent + persists it durably — no 90s tail-loss, no
              // 16-min lock hold. A queued user submit waits on watch.done.
              this._armContinuationWatch(session, {
                sessionKey: session.sessionKey,
                peerId: session.peerId,
                userId: session.userId,
                channel: session.channel,
                agentId: session.agentId,
              })
              // fall through → detach + settle (release lock); the watch owns it now.
            } else {
              // Non-webchat (cron/telegram/delegate): no peer-ws continuation
              // delivery path, and continuations are rare. Keep the legacy in-lock
              // re-arm + 90s soft-cap unchanged to avoid regressing those channels.
              continuationCount++
              expectsContinuation = false
              turnBlockCount = 0
              turnToolCallCount = 0
              turnPermissionCount = 0
              pendingFinal = null
              parser.finish()
              if (session._currentParser === parser) session._currentParser = undefined
              refreshActiveTurnId()
              parser = new ClaudeMessageParser(parserConfig)
              session._currentParser = parser
              if (!detached) {
                timer.refresh()
                armContinuationTimer()
              }
              return
            }
          }
          detach()
          settle(() => resolve())
        },
        sessionTotals: session, // parser reads/writes totalCostUSD and turns directly
      }

      // Expose parser to outer idle-timeout checker
      parser = new ClaudeMessageParser(parserConfig)
      session._currentParser = parser

      const handleMessage = (msg: any) => {
        // Any message from runner means the agent is still active — reset idle timer.
        // detach 后跳过 timer.refresh():Node Timer.refresh() 即使已 clearTimeout
        // 也会重新 arm,会让旧 turn 的 idle 回调在 30 分钟后被无意义地触发
        // (回调内有 !parser.finalized 守卫所以是 no-op,但还是不要触发更干净)。
        if (!detached) {
          timer.refresh()
          // Any runner output (workflow progress, the continuation turn itself)
          // resets the continuation soft-cap so it only fires on true silence.
          if (continuationTimer) armContinuationTimer()
        }
        parser.parse(msg)
      }
      const handleError = (err: Error) => {
        onEvent({ kind: 'error', error: err.message })
        detach()
        settle(() => resolve())
      }

      // Listen for subprocess crash mid-turn. Defer slightly to let remaining
      // stdout data drain (exit can fire before stdout 'end' in Node.js).
      const handleExit = (info: {
        code: number | null
        signal: string | null
        crashed: boolean
      }) => {
        setTimeout(() => {
          if (!parser.finalized) {
            const reason = info.signal
              ? `子进程被信号 ${info.signal} 终止`
              : info.code
                ? `子进程异常退出 (code ${info.code})`
                : '子进程意外退出'
            // ── Phase 0.2: persist partial assistant text on interrupt/crash ──
            // CCB was streaming into parser.assistantBuf when it died / was
            // interrupted. Without this flush the partial text is only in RAM
            // + whatever frames the ws client already received. If the client
            // is backgrounded we lose it entirely. Persist with status marker
            // 'interrupted' (user stop / SIGINT / idle-timeout signal) vs
            // 'crashed' (unexpected exit code) so the UI can render a clear
            // "[was interrupted]" trailer rather than showing a complete-
            // looking bubble.
            const partial = parser.assistantBuf
            if (session.channel === 'webchat' && partial && partial.length > 0) {
              const status: 'interrupted' | 'crashed' = info.signal ? 'interrupted' : 'crashed'
              const peerId = session.peerId
              const turnIndex = session.turns + 1 // turn hasn't been counted yet
              // Same P1-3 treatment as handleResult: prefer session.userId so
              // a pre-PUT crash still reaches the outbox; fall back to
              // getClientSession for legacy code paths.
              const flushPartial = async () => {
                const uid = session.userId ?? (await getClientSession(peerId))?.userId
                if (!uid) return undefined // no owner, nothing to persist to
                const r = await appendServerAuthoredMessageDurable(peerId, uid, {
                  id: serverAuthoredMsgId(peerId, turnIndex),
                  role: 'assistant',
                  text: partial,
                  ts: Date.now(),
                  status,
                })
                return { r, userId: uid }
              }
              flushPartial()
                .then((writeResult) => {
                  if (writeResult?.r.applied && writeResult.userId)
                    this.onClientSessionMutated?.(peerId, writeResult.userId)
                })
                .catch((err) => {
                  log.error(
                    'partial assistant flush failed',
                    {
                      sessionKey: session.sessionKey,
                      peerId,
                      turnIndex,
                      status,
                    },
                    err as Error,
                  )
                })
            }
            onEvent({ kind: 'error', error: reason })
            detach()
            settle(() => resolve())
          }
          // Cost-tracker reset is handled by the `spawn` listener installed in
          // createSession — it fires synchronously when the next submit() spawns
          // a fresh CCB, with no timer-vs-new-process race.
        }, 150)
      }

      // Permanent stdout pump (install-once, session-lifetime). Bound to
      // `session.runner`, which is never reassigned — it survives effort/model
      // recycle + idle hard-reset (those shut the proc, keep the runner). The
      // pump routes each raw message to the current turn's handler; per turn we
      // just repoint `_currentTurnHandler`. This replaces the old per-turn
      // off-old/on-new churn while keeping exactly one routing target at a time.
      // (The pump is the seam P2.2/P2.3 extend to catch post-result continuation
      // frames without holding the submit lock.)
      if (!session._messagePump) {
        const pump = (msg: any) => session._currentTurnHandler?.(msg)
        session._messagePump = pump
        runner.on('message', pump)
      }
      session._currentTurnHandler = handleMessage
      runner.on('error', handleError)
      runner.on('exit', handleExit)
      runner.on('parse_error', handleParseError)

      runner.submit(userTextOrBlocks).catch((err) => {
        onEvent({ kind: 'error', error: String(err) })
        detach()
        settle(() => resolve())
      })
    })
  }

  /** P2.2: arm a continuation watch after a turn that launched a background task
   *  resolves. Runs OUTSIDE the submit lock — the permanent pump feeds it. Catches
   *  the late continuation turn (task_notification → init → assistant → result),
   *  delivers it real-time via onContinuationEvent and persists it durably on a
   *  serial chain (the no-drop floor). Multi-continuation: re-arms while each
   *  continuation launches another background task, bounded by MAX_CONTINUATIONS.
   *  A queued user submit awaits `watch.done`. */
  private _armContinuationWatch(session: AgentSession, route: ContinuationDeliveryRoute): void {
    if (session._continuationWatch) return // one watch per session
    const runner = session.runner
    // Backstop window is shared with the user-submit drain gate — see
    // CONTINUATION_WATCH_BACKSTOP_MS at module scope (below the 30-min webchat
    // eviction TTL; P2.3 swaps for session_state_changed(idle)).
    const WATCH_BACKSTOP_MS = CONTINUATION_WATCH_BACKSTOP_MS
    const MAX_CONTINUATIONS = 16

    let resolveDone!: () => void
    const done = new Promise<void>((r) => {
      resolveDone = r
    })
    const watch: ContinuationWatch = {
      parser: undefined as any, // set by armNext() below
      streamTurnId: undefined,
      route,
      count: 0,
      backstop: null,
      ended: false,
      onExit: () => {},
      onError: () => {},
      onParseError: () => {},
      done,
      resolveDone,
    }

    const refreshBackstop = () => {
      if (watch.backstop) clearTimeout(watch.backstop)
      watch.backstop = setTimeout(() => {
        if (watch.ended) return
        log.info('continuation watch idle backstop — ending', { sessionKey: session.sessionKey })
        this._endContinuationWatch(session)
      }, WATCH_BACKSTOP_MS)
      // A pending watch must never keep the process alive on its own (the gateway
      // server keeps it up); unref so shutdown/tests aren't blocked by the backstop.
      watch.backstop.unref?.()
    }

    // Build a fresh continuation sub-turn context (parser + streamTurnId + per-
    // context rollback snapshot). Called at open and at each re-arm.
    const armNext = () => {
      const peerId = route.peerId
      // turns+1 now == session.turns AFTER this sub-turn's result (the parser
      // increments via sessionTotals: session) → durable row id == streaming turnId.
      const streamTurnId = peerId ? serverAuthoredMsgId(peerId, session.turns + 1) : undefined
      watch.streamTurnId = streamTurnId
      // per-context rollback snapshot (invariant E / R5) — isolated from the user turn.
      const prevCostUSD = session.totalCostUSD
      const prevTurns = session.turns
      const prevLastCcbCost = session._lastCcbCumulativeCost
      let expectsAnother = false
      let producedOutput = false // any observable output (block/permission) — for phantom detection
      let pendingFinal: SessionStreamEvent | null = null

      const deliver = (e: SessionStreamEvent) =>
        this.onContinuationEvent?.({ ...route, turnId: streamTurnId }, e)

      watch.parser = new ClaudeMessageParser({
        toolUseIdToName: session.toolUseIdToName,
        onEvent: (e) => {
          if (e.kind === 'workflow_progress' && e.stage === 'started') expectsAnother = true
          else if (e.kind === 'block' || e.kind === 'permission_request') producedOutput = true
          if (e.kind === 'final') {
            pendingFinal = e
            return
          }
          deliver(e)
        },
        onToolUse: undefined,
        onFinish: (result) => {
          if (!result || watch.ended) return // null = parser.finish() during end
          // per-context auth rollback — restore ONLY this context's snapshot, end watch.
          const isAuthError =
            (result.isError && SessionManager.AUTH_KEYWORDS_RE.test(result.assistantText)) ||
            SessionManager.AUTH_ERROR_PREFIX_RE.test(result.assistantText)
          if (isAuthError) {
            session.totalCostUSD = prevCostUSD
            session.turns = prevTurns
            session._lastCcbCumulativeCost = prevLastCcbCost
            this._endContinuationWatch(session)
            return
          }
          // per-context phantom rollback — a continuation that produced NOTHING
          // (zero tokens/cost, no observable output, no further task) is a phantom:
          // restore this context's snapshot so it neither advances the turn counter
          // nor delivers/persists, then end the watch. (Mirrors the main-turn phantom
          // guard, minus the user-input-string gate which doesn't apply to a
          // model-proactive continuation.)
          const isPhantom =
            !result.isError &&
            !producedOutput &&
            !expectsAnother &&
            result.inputTokens === 0 &&
            result.outputTokens === 0 &&
            result.cacheReadTokens === 0 &&
            result.cacheCreationTokens === 0 &&
            result.cost === 0
          if (isPhantom) {
            session.totalCostUSD = prevCostUSD
            session.turns = prevTurns
            session._lastCcbCumulativeCost = prevLastCcbCost
            this._endContinuationWatch(session)
            return
          }
          // forward the buffered final (real-time optimization)
          if (pendingFinal) deliver(pendingFinal)
          // capture IMMUTABLE values — the next context can mutate live session fields.
          const assistantText = result.assistantText ?? ''
          const turnIndex = session.turns // post-increment by the parser
          const durableTurnId = streamTurnId
          const userId = route.userId
          watch.count++
          const reArm = expectsAnother && watch.count < MAX_CONTINUATIONS
          // SYNC re-arm BEFORE awaiting the durable write so the NEXT continuation's
          // frames route to a fresh parser without reordering/dropping.
          if (reArm) armNext()

          // durable "no-drop" floor on a per-session serial chain.
          if (
            session.channel === 'webchat' &&
            userId &&
            assistantText.length > 0 &&
            durableTurnId
          ) {
            session._continuationWrite = (session._continuationWrite ?? Promise.resolve())
              .then(async () => {
                const r = await appendServerAuthoredMessageDurable(peerId, userId, {
                  id: durableTurnId,
                  role: 'assistant',
                  text: assistantText,
                  ts: Date.now(),
                  status: 'completed',
                })
                if (r.applied) this.onClientSessionMutated?.(peerId, userId)
              })
              .catch((err) =>
                log.error(
                  'continuation durable append failed',
                  { sessionKey: session.sessionKey, turnIndex },
                  err as Error,
                ),
              )
          }
          // observability (mirrors the main-turn onFinish emits)
          eventBus.emit(
            'turn.completed',
            createEvent('turn.completed', session.agentId, {
              sessionKey: session.sessionKey,
              turnIndex,
              usage: {
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
                cacheReadTokens: result.cacheReadTokens,
                cacheCreationTokens: result.cacheCreationTokens,
                costUsd: result.cost,
                model: session.model,
              },
              toolCalls: 0,
              durationMs: 0,
            }),
          )

          if (reArm) refreshBackstop()
          else this._endContinuationWatch(session)
        },
        sessionTotals: session,
      })
      session._currentParser = watch.parser
    }

    watch.onError = (err: Error) => {
      if (watch.ended) return
      log.warn('continuation watch runner error', {
        sessionKey: session.sessionKey,
        err: err.message,
      })
      this._endContinuationWatch(session)
    }
    watch.onExit = (info) => {
      if (watch.ended) return
      // Mirror the main-turn handleExit drain: persist any partial continuation
      // text durably before ending, so a runner crash mid-continuation doesn't
      // lose the streamed-but-unfinalized answer (no-drop floor on the crash path).
      const partial = watch.parser?.assistantBuf
      if (
        route.channel === 'webchat' &&
        route.userId &&
        watch.streamTurnId &&
        partial &&
        partial.length > 0
      ) {
        const status: 'interrupted' | 'crashed' = info.signal ? 'interrupted' : 'crashed'
        const peerId = route.peerId
        const userId = route.userId
        const turnId = watch.streamTurnId
        const text = partial
        session._continuationWrite = (session._continuationWrite ?? Promise.resolve())
          .then(async () => {
            const r = await appendServerAuthoredMessageDurable(peerId, userId, {
              id: turnId,
              role: 'assistant',
              text,
              ts: Date.now(),
              status,
            })
            if (r.applied) this.onClientSessionMutated?.(peerId, userId)
          })
          .catch((err) =>
            log.error(
              'continuation partial flush failed',
              { sessionKey: session.sessionKey },
              err as Error,
            ),
          )
      }
      this._endContinuationWatch(session)
    }
    watch.onParseError = () => {}

    session._continuationWatch = watch
    armNext()
    // Route the permanent pump to the watch parser (late-bound on watch.parser so
    // re-arm reassignment is picked up). Ended → no-op (next user submit repoints).
    session._currentTurnHandler = (msg: any) => {
      if (watch.ended) return
      refreshBackstop()
      watch.parser.parse(msg)
    }
    runner.on('error', watch.onError)
    runner.on('exit', watch.onExit)
    runner.on('parse_error', watch.onParseError)
    refreshBackstop()
  }

  /** End an active continuation watch: remove its listeners + timer, finalize its
   *  parser, clear state, and release any queued user submit. Idempotent. */
  private _endContinuationWatch(session: AgentSession): void {
    const watch = session._continuationWatch
    if (!watch || watch.ended) return
    watch.ended = true
    if (watch.backstop) {
      clearTimeout(watch.backstop)
      watch.backstop = null
    }
    try {
      session.runner.off('error', watch.onError)
    } catch {}
    try {
      session.runner.off('exit', watch.onExit)
    } catch {}
    try {
      session.runner.off('parse_error', watch.onParseError)
    } catch {}
    if (watch.parser && !watch.parser.finalized) watch.parser.finish()
    if (session._currentParser === watch.parser) session._currentParser = undefined
    session._continuationWatch = null
    // _currentTurnHandler still points at the (now no-op) watch handler; the next
    // user submit repoints it (mirrors the replace-not-remove discipline).
    watch.resolveDone()
  }

  interrupt(sessionKey: string): boolean {
    const s = this.sessions.get(sessionKey)
    if (!s) return false
    return s.runner.interrupt()
  }

  async getGoal(sessionKey: string): Promise<unknown | null> {
    const s = this.sessions.get(sessionKey)
    if (!s) throw new Error('session not found')
    const getGoal = (s.runner as unknown as { getGoal?: () => Promise<unknown | null> }).getGoal
    if (typeof getGoal !== 'function') throw new Error('current runner does not support goals')
    s.lastUsedAt = Date.now()
    return getGoal.call(s.runner)
  }

  async setGoal(sessionKey: string, input: CodexGoalControlInput): Promise<unknown> {
    const s = this.sessions.get(sessionKey)
    if (!s) throw new Error('session not found')
    const setGoal = (
      s.runner as unknown as { setGoal?: (input: CodexGoalControlInput) => Promise<unknown> }
    ).setGoal
    if (typeof setGoal !== 'function') throw new Error('current runner does not support goals')
    if (
      input.status !== undefined &&
      input.status !== null &&
      !CODEX_GOAL_STATUSES.has(input.status)
    ) {
      throw new Error(`unsupported goal status: ${input.status}`)
    }
    s.lastUsedAt = Date.now()
    return setGoal.call(s.runner, input)
  }

  async clearGoal(sessionKey: string): Promise<boolean> {
    const s = this.sessions.get(sessionKey)
    if (!s) throw new Error('session not found')
    const clearGoal = (s.runner as unknown as { clearGoal?: () => Promise<boolean> }).clearGoal
    if (typeof clearGoal !== 'function') throw new Error('current runner does not support goals')
    s.lastUsedAt = Date.now()
    return clearGoal.call(s.runner)
  }

  getByKey(sessionKey: string): AgentSession | undefined {
    return this.sessions.get(sessionKey)
  }

  async warmupSession(sessionKey: string, timeoutMs = 15_000): Promise<boolean> {
    const session = this.sessions.get(sessionKey)
    if (!session) return false
    const warmup = (
      session.runner as unknown as { warmup?: (timeoutMs?: number) => Promise<boolean> }
    ).warmup
    if (typeof warmup !== 'function') return false

    let ok = false
    const prev = session.lock
    const run = prev
      .catch(() => undefined)
      .then(async () => {
        if (this.sessions.get(sessionKey) !== session) return
        try {
          ok = await warmup.call(session.runner, timeoutMs)
        } catch (err) {
          log.warn('session warmup failed', { sessionKey }, err)
          ok = false
        }
      })
    session.lock = run.then(
      () => undefined,
      () => undefined,
    )
    await session.lock
    return ok
  }

  /** Destroy a single session: kill subprocess + remove from map + clear resume mapping.
   *  Also clears resume-map even if the session was already evicted from memory. */
  async destroySession(sessionKey: string): Promise<void> {
    const s = this.sessions.get(sessionKey)
    if (s) {
      this._endContinuationWatch(s) // tear down any active continuation watch first
      // Detach cross-turn message listener before shutting down to release
      // the closure chain (parser + per-turn onEvent + frame envelope).
      if (s._messagePump) {
        try {
          s.runner.off('message', s._messagePump)
        } catch {}
        s._messagePump = null
      }
      s._currentTurnHandler = null
      await s.runner.shutdown()
      this.sessions.delete(sessionKey)
    }
    // Always clear resume-map (handles both live and evicted sessions)
    if (this._resumeMap.has(sessionKey)) {
      this._resumeMap.delete(sessionKey)
      this._resumeMapTimestamps.delete(sessionKey)
      this._resumeMapLastCost.delete(sessionKey)
      this._resumeMapProvider.delete(sessionKey)
      this._saveResumeMap()
    }
  }

  async shutdownAll(): Promise<void> {
    // Persist resume map BEFORE killing subprocesses — ensures state survives restart
    // (runner.shutdown() sets shuttingDown=true so the exit handler won't call _saveResumeMap)
    this._saveResumeMap()
    await this._resumeMapWrite
    for (const s of this.sessions.values()) {
      this._endContinuationWatch(s)
      if (s._messagePump) {
        try {
          s.runner.off('message', s._messagePump)
        } catch {}
        s._messagePump = null
      }
      s._currentTurnHandler = null
    }
    await Promise.all([...this.sessions.values()].map((s) => s.runner.shutdown()))
    this.sessions.clear()
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
    const t = setInterval(() => {
      const now = Date.now()
      const toEvict: string[] = []
      for (const [key, s] of this.sessions) {
        // Cron/task sessions (contain ':cron:' or ':task:') and webchat sessions
        // both use 30 min idle timeout. Webchat's resume-map persists for 7 days
        // so an evicted webchat subprocess can cold-start via --resume on next message.
        const isTempSession = key.includes(':cron:') || key.includes(':task:')
        const maxIdle = isTempSession ? this.maxIdleMsCron : this.maxIdleMsChat
        // P2.2: never evict a session with an active continuation watch — the late
        // continuation (up to ~16min) is still being delivered/persisted out-of-lock.
        if (s._continuationWatch) continue
        // Use the more recent of lastUsedAt and runner.lastActivityAt to avoid
        // killing sessions with long-running active tasks
        const lastActive = Math.max(s.lastUsedAt, s.runner.lastActivityAt)
        if (now - lastActive > maxIdle) {
          toEvict.push(key)
        }
      }
      for (const key of toEvict) {
        const s = this.sessions.get(key)
        if (!s) continue
        if (s._messagePump) {
          try {
            s.runner.off('message', s._messagePump)
          } catch {}
          s._messagePump = null
        }
        s._currentTurnHandler = null
        s.runner.shutdown().catch(() => {})
        this.sessions.delete(key)
        // Only webchat sessions should survive eviction in resume-map.
        // All other session types (cron, task, inter-agent, telegram) are ephemeral.
        if (!key.includes(':webchat:')) {
          this._resumeMap.delete(key)
          this._resumeMapTimestamps.delete(key)
          this._resumeMapLastCost.delete(key)
          this._resumeMapProvider.delete(key)
        }
        // (webchat entries stay in _resumeMap intentionally for cross-restart recovery)
      }
      if (toEvict.length > 0) this._saveResumeMap()

      // TTL cleanup: remove resume-map entries older than 30 days that have no live session
      this._pruneResumeMap()
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
// Detects "VERDICT: PASS|FAIL|PARTIAL" and "### Check:" blocks in assistant text.

interface ParsedVerdict {
  verdict: 'PASS' | 'FAIL' | 'PARTIAL'
  passed: boolean
  evidence: Array<{ check: string; passed: boolean; detail?: string }>
}

const VERDICT_RE = /^VERDICT:\s*(PASS|FAIL|PARTIAL)\s*$/m

/** Strip fenced code blocks to prevent false matches inside output. */
function stripCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '')
}

export function parseVerificationVerdict(text: string): ParsedVerdict | null {
  // Strip code fences to avoid false matches in examples/output
  const cleaned = stripCodeFences(text)

  const verdictMatch = VERDICT_RE.exec(cleaned)
  if (!verdictMatch) return null

  const verdict = verdictMatch[1] as 'PASS' | 'FAIL' | 'PARTIAL'
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
