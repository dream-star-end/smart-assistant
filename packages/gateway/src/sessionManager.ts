import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AgentDef,
  type OpenClaudeConfig,
  appendServerAuthoredMessageDurable,
  getClientSession,
  indexTurn,
  paths,
  upsertSessionMeta,
} from '@openclaude/storage'
import { CcbMessageParser, type SessionStreamEvent } from './ccbMessageParser.js'
import {
  TelemetryChannel,
  type OcTelemetryEvent,
} from './telemetryChannel.js'
import { eventBus, createEvent } from './eventBus.js'
import { createLogger } from './logger.js'
import { SubprocessRunner } from './subprocessRunner.js'
import { CodexRunner } from './codexRunner.js'
import {
  type ExecutionTarget,
  type RemoteTargetController,
  RemoteTargetUnavailableError,
} from './remoteTarget.js'

const log = createLogger({ module: 'sessionManager' })

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
  _currentParser?: import('./ccbMessageParser.js').CcbMessageParser
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
}

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

export class SessionManager {
  private sessions = new Map<string, AgentSession>()
  private maxIdleMsCron = 30 * 60 * 1000 // 30 min for cron/task sessions
  private maxIdleMsChat = 2 * 60 * 60 * 1000 // 2 hours for webchat sessions (resume-map persists for reconnect)
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
    const tag = this._resumeMapProvider.get(sessionKey) ?? SessionManager.CCB_PROVIDER_TAG
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
    /** 仅用于**新建** runner 时初始化 CLAUDE_CODE_EFFORT_LEVEL:
     *    - string         : 用作初始值
     *    - null/undefined : 让 CCB 用模型默认 effort
     *
     *  既存 session 的 effort 切换走 submit(effortLevel) — 在那里和 turn 入队
     *  原子串行,避免 getOrCreate→submit 之间的窗口期被另一条并发消息覆盖。 */
    effortLevel?: string | null
  }): Promise<AgentSession> {
    // 新建时 null 等同 undefined(都让 CCB 用模型默认)
    const initialEffort: string | undefined =
      opts.effortLevel === null ? undefined : opts.effortLevel

    const existing = this.sessions.get(opts.sessionKey)
    if (existing) {
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
    const cwd = opts.agent.cwd ?? process.cwd()
    const persona = opts.agent.persona ?? paths.agentClaudeMd(opts.agent.id)
    // provider=codex-native routes to `codex` CLI instead of CCB; runner shape
    // (EventEmitter with start/submit/shutdown + same events) is compatible,
    // so upstream session bookkeeping works unchanged.
    const providerTag = SessionManager.providerTag(opts.agent.provider)
    const runner: SubprocessRunner =
      opts.agent.provider === 'codex-native'
        ? (new CodexRunner({
            sessionKey: opts.sessionKey,
            agentId: opts.agent.id,
            cwd,
            // Only resume if the persisted id was produced by a codex-native
            // runner — feeding a CCB session_id to `codex exec resume` would
            // make codex reject the arg or attach to a nonexistent thread.
            resumeSessionId: this._resumeIdFor(opts.sessionKey, providerTag),
            model: opts.agent.model ?? this.config.defaults.model,
          }) as unknown as SubprocessRunner)
        : new SubprocessRunner({
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
            // Symmetrically: only resume CCB from a CCB-tagged id.
            // _resumeIdFor also drops the entry silently when the CCB JSONL
            // was wiped (pre-2026-04-22 v3 containers' tmpfs was ephemeral).
            resumeSessionId: this._resumeIdFor(opts.sessionKey, providerTag),
            effortLevel: initialEffort,
          })
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
      executionTarget: { kind: 'local' },
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
  ): Promise<void> {
    // 闭包捕获:即便后面再有 submit 也不会改这个常量
    const desiredEffort: string | undefined =
      effortLevel === null ? undefined : effortLevel
    const callerSpecifiedEffort = effortLevel !== undefined
    const desiredModel: string | undefined = model
    const callerSpecifiedModel = model !== undefined

    const prev = session.lock
    let release!: () => void
    session.lock = new Promise<void>((r) => (release = r))
    try {
      await prev
      // effort + model 应用都必须在本 turn 真正启动**之前**完成,且必须在 prev 之后:
      //   - prev 之前:可能中断别人的 in-flight turn
      //   - 本 turn 之后:env / cli args 已被 CCB 启动时读完,改也无效
      // 同时受 lock chain 保护,后到的 submit 想 set 别的 effort/model 也得排在我们后面。
      // 把 effort/model 的 needsRestart 信号合并 → 一次 shutdown(下次 submit 自动 spawn 用新 effort+model)。
      const effortChanged =
        callerSpecifiedEffort && session.runner.effortLevel !== desiredEffort
      const modelChanged = callerSpecifiedModel && session.runner.model !== desiredModel
      if (effortChanged) session.runner.setEffortLevel(desiredEffort)
      if (modelChanged) {
        session.runner.setModel(desiredModel)
        // 同步更新 session.model,outbound 帧 / metrics / audit 都靠它,避免
        // 下次 spawn 前的窗口期 stale。runner.model 要等 spawn 才生效;但 shutdown
        // 已让 runner 死,窗口期内不会产生新 metrics —— session.model 提前对齐安全。
        session.model = desiredModel ?? this.config.defaults.model ?? 'claude-opus-4-7'
      }
      if (effortChanged || modelChanged) {
        try {
          await session.runner.shutdown()
          // Delta tracker reset happens automatically on the next 'spawn' event
          // when SubprocessRunner auto-respawns on the next submit().
        } catch (err) {
          log.warn(
            'effort/model-change shutdown failed',
            { sessionKey: session.sessionKey, effortChanged, modelChanged },
            err,
          )
        }
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
      // Thresholds tuned for "process active but deadlocked" detection speed
      // (was 30/60min pre-2026-04-19):
      //   - Tool call in progress (MCP/Bash/sub-agent): 15 min
      //   - No tool call pending (API streaming / idle): 5 min
      // _runOneTurn has a separate 30-min idle timer as a tighter
      // turn-level backstop that resets on every stdout message.
      const IDLE_TIMEOUT_TOOL = 15 * 60_000 // 15 min — tool executing
      const IDLE_TIMEOUT_DEFAULT = 5 * 60_000 // 5 min — API stream / general idle
      const CHECK_INTERVAL = 15_000 // check every 15s
      let livenessTimer: NodeJS.Timeout | null = null
      const livenessPromise = new Promise<never>((_, reject) => {
        livenessTimer = setInterval(() => {
          const idleMs = Date.now() - session.runner.lastActivityAt
          const parser = session._currentParser
          const threshold = (parser && parser.pendingToolCalls > 0)
            ? IDLE_TIMEOUT_TOOL
            : IDLE_TIMEOUT_DEFAULT
          if (idleMs > threshold) {
            reject(new Error(`idle timeout (${Math.round(idleMs / 1000)}s no output)`))
          }
        }, CHECK_INTERVAL)
      })
      try {
        await Promise.race([
          this.runOneTurnWithRetry(session, userTextOrBlocks, onEvent),
          livenessPromise,
        ])
      } finally {
        if (livenessTimer) clearInterval(livenessTimer)
      }
    } catch (err: any) {
      if (err?.message?.includes('idle timeout')) {
        // Actually interrupt the runner so the subprocess stops
        try { session.runner.interrupt() } catch {}
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
        log.error('idle timeout, interrupted', { sessionKey: session.sessionKey }, err)
      } else {
        throw err
      }
    } finally {
      release()
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
              error:
                'CCB 子进程持续返回空响应,已重启子进程。请重新发送消息或检查 gateway 日志。',
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
            sessionKey: session.sessionKey, attempt: attempt + 1,
          })
          // Trigger immediate token refresh via gateway callback
          if (this.onAuthError) {
            try { await this.onAuthError() } catch (e) {
              log.error('onAuthError callback failed', { sessionKey: session.sessionKey }, e as Error)
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
        const isTransient = /529|503|502|504|ECONNRESET|ETIMEDOUT|rate.limit|overloaded|AbortError|operation was aborted|timed?\s*out/i.test(msg)
        if (!isTransient || attempt >= MAX_RETRIES) throw err
        const delay = BASE_DELAY * 2 ** attempt + Math.random() * 1000
        log.warn('transient error, retrying', { sessionKey: session.sessionKey, attempt: attempt + 1, maxRetries: MAX_RETRIES, delayS: Math.round(delay / 1000), error: msg })
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

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn() } }

      // Idle timeout — refreshed on every runner message (see handleMessage below).
      // A turn is only killed if the agent produces no output for this long, so long
      // active tasks keep running while genuinely stuck turns still get interrupted.
      const IDLE_TIMEOUT_MS = 30 * 60 * 1000 // 30 min of silence from runner
      const timer = setTimeout(
        () => {
          if (!parser.finalized) {
            try { runner.interrupt() } catch {}
            onEvent({ kind: 'error', error: '单轮对话空闲超时 (30 分钟无输出),已中断。请重试。' })
            detach()
            settle(() => resolve())
          }
        },
        IDLE_TIMEOUT_MS,
      )

      // Buffer 'final' event — only forward to client after auth check passes
      let pendingFinal: SessionStreamEvent | null = null
      const wrappedOnEvent = (e: SessionStreamEvent) => {
        // Track all observable output for phantom-turn detection.
        // permission_request counts as real output too (visible permission card),
        // so it must NOT be flagged as phantom even if usage is 0.
        if (e.kind === 'block') turnBlockCount++
        else if (e.kind === 'permission_request') turnPermissionCount++
        if (e.kind === 'final') { pendingFinal = e; return }
        onEvent(e)
      }

      // Per-turn OpenClaude telemetry sink. Consumes `_oc_telemetry` lines
      // routed by subprocessRunner (see docs/ccb-telemetry-refactor-plan.md).
      // Lifecycle: constructed per turn, dropped by `detach()` on every exit
      // path (normal finish / error / exit / idle timeout / submit catch).
      const telemetry = new TelemetryChannel()
      const handleTelemetry = (ev: OcTelemetryEvent) => telemetry.ingest(ev)
      // Per-turn parse_error listener (previously only installed at runner
      // construction). Must be detached with the rest to avoid per-turn
      // listener accumulation (R9).
      const handleParseError = (payload: { line: string; err: unknown }) => {
        const err = payload.err as Error | undefined
        log.warn('ccb stdout parse_error', {
          sessionKey: session.sessionKey,
          msg: err?.message,
          sample: payload.line?.slice(0, 200),
        })
      }

      const detach = () => {
        clearTimeout(timer)
        parser.finish()
        // Only clear if still pointing to this turn's parser (prevents race
        // where idle-timeout releases the lock, a new turn starts and sets
        // a new parser, then this stale detach wipes the new reference).
        if (session._currentParser === parser) session._currentParser = undefined
        runner.off('message', handleMessage)
        runner.off('error', handleError)
        runner.off('exit', handleExit)
        runner.off('telemetry', handleTelemetry)
        runner.off('parse_error', handleParseError)
      }

      const parser = new CcbMessageParser({
        toolUseIdToName: session.toolUseIdToName,
        onEvent: wrappedOnEvent,
        onToolUse: (tool) => {
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
          eventBus.emit('tool.called', createEvent('tool.called', session.agentId, {
            sessionKey: session.sessionKey,
            turnIndex: session.turns + 1,
            toolName: tr.toolName,
            durationMs: tr.durationMs,
            isError: tr.isError,
            inputPreview: tr.inputPreview,
            outputPreview: tr.preview ? tr.preview.slice(0, 500) : undefined,
          }))
        },
        onFinish: (result) => {
          detach()

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
            })
            session._pendingStaleResumeClear = true
            session.totalCostUSD = prevCostUSD
            session.turns = prevTurns
            session._lastCcbCumulativeCost = prevLastCcbCost
            settle(() => reject(new Error('STALE_RESUME_ID: Previous session file missing; next submit will start fresh')))
            return
          }

          // Detect auth error in assistant output — roll back counters and reject.
          // Two signals: (1) isError + broad keyword match, (2) CCB's exact error prefix.
          const isAuthError = result && (
            (result.isError && SessionManager.AUTH_KEYWORDS_RE.test(result.assistantText)) ||
            SessionManager.AUTH_ERROR_PREFIX_RE.test(result.assistantText)
          )
          if (isAuthError) {
            session.totalCostUSD = prevCostUSD
            session.turns = prevTurns
            session._lastCcbCumulativeCost = prevLastCcbCost
            settle(() => reject(new Error('AUTH_ERROR: Token expired or invalid')))
            return
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

          const signals = telemetry.getTurnSignals()
          let isPhantomTurn = false
          switch (signals.apiState) {
            case 'skipped':
              log.info('turn.skipped (telemetry)', {
                sessionKey: session.sessionKey,
                reason: signals.skipReason,
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
                telemetry.noteIncomplete()
                // Correlate with turn.apiResponse (if received) to distinguish
                // "stream ended mid-flight" from "stream never finished" —
                // apiResponse fires only after stream loop completes, so its
                // absence here means CCB's stream completed without producing
                // an assistant message.
                const apiResp = telemetry.getTurnApiResponse()
                const lastTool = telemetry.getLastToolPreUse()
                log.warn('telemetry: willCallApi fired but no stop_reason and no blocks', {
                  sessionKey: session.sessionKey,
                  incompleteCount: telemetry.getIncompleteCount(),
                  hadApiResponse: !!apiResp,
                  apiRespStopReason: apiResp?.data.stopReason,
                  lastToolPreUse: lastTool?.data.toolName,
                  toolErrorCount: telemetry.getToolErrors().length,
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
                result.inputTokens === 0 &&
                result.outputTokens === 0 &&
                result.cacheReadTokens === 0 &&
                result.cacheCreationTokens === 0 &&
                result.cost === 0 &&
                turnToolCallCount === 0 &&
                turnBlockCount === 0 &&
                turnPermissionCount === 0
              break
          }

          if (isPhantomTurn) {
            // Roll back parser-mutated counters (parser already incremented
            // turns and may have touched cost/cumulative even if delta was 0).
            session.totalCostUSD = prevCostUSD
            session.turns = prevTurns
            session._lastCcbCumulativeCost = prevLastCcbCost
            log.warn('phantom turn — CCB returned empty result without invoking model', {
              sessionKey: session.sessionKey,
              turnIndex: session.turns + 1,
              durationMs: Date.now() - turnStartTime,
            })
            settle(() => reject(new Error('PHANTOM_TURN: CCB returned empty result')))
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
            // L2: persist to FTS5 for session_search
            const sessId = session.ccbSessionId ?? session.sessionKey
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
            ]).catch((err) => log.error('FTS5 index failed', { sessionKey: session.sessionKey }, err))

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
            if (session.channel === 'webchat' && result.assistantText && result.assistantText.length > 0) {
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
                  const messageId = `srv-${peerId}-t${turnIndex}`
                  return appendServerAuthoredMessageDurable(peerId, session.userId, {
                    id: messageId,
                    role: 'assistant',
                    text: assistantText,
                    ts: Date.now(),
                    status: 'completed',
                  })
                }
                const existing = await getClientSession(peerId)
                if (!existing) return undefined // cron-style pre-UI, no owner
                const messageId = `srv-${peerId}-t${turnIndex}`
                return appendServerAuthoredMessageDurable(peerId, existing.userId, {
                  id: messageId,
                  role: 'assistant',
                  text: assistantText,
                  ts: Date.now(),
                  status: 'completed',
                })
              }
              directWrite().then((r) => {
                if (r && !r.applied && r.reason !== 'already_exists') {
                  // 'queued_to_outbox' is an expected degraded-mode outcome
                  // (DB unavailable); log as warn not error so we don't spam
                  // error aggregators when disk/SQLite has a hiccup. The
                  // replay loop will pick it up on next restart.
                  if (r.reason === 'queued_to_outbox') {
                    log.warn('server-authored message queued to outbox (DB unavailable)', {
                      sessionKey: session.sessionKey, peerId, turnIndex,
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
              }).catch((err) => {
                log.error('appendServerAuthoredMessage failed', {
                  sessionKey: session.sessionKey,
                  peerId,
                  turnIndex,
                }, err)
              })
            }

            // Emit turn.completed event (triggers event_log + usage_log persistence)
            const turnDurationMs = Date.now() - turnStartTime
            eventBus.emit('turn.completed', createEvent('turn.completed', session.agentId, {
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
            }))

            // Emit cost.recorded for budget tracking
            eventBus.emit('cost.recorded', createEvent('cost.recorded', session.agentId, {
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
              })
            }
          }
          settle(() => resolve())
        },
        sessionTotals: session, // parser reads/writes totalCostUSD and turns directly
      })

      // Expose parser to outer idle-timeout checker
      session._currentParser = parser

      const handleMessage = (msg: any) => {
        // Any message from runner means the agent is still active — reset idle timer.
        timer.refresh()
        parser.parse(msg)
      }
      const handleError = (err: Error) => {
        onEvent({ kind: 'error', error: err.message })
        detach()
        settle(() => resolve())
      }

      // Listen for subprocess crash mid-turn. Defer slightly to let remaining
      // stdout data drain (exit can fire before stdout 'end' in Node.js).
      const handleExit = (info: { code: number | null; signal: string | null; crashed: boolean }) => {
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
                const uid = session.userId
                  ?? ((await getClientSession(peerId))?.userId)
                if (!uid) return undefined // no owner, nothing to persist to
                return appendServerAuthoredMessageDurable(peerId, uid, {
                  id: `srv-${peerId}-t${turnIndex}`,
                  role: 'assistant',
                  text: partial,
                  ts: Date.now(),
                  status,
                })
              }
              flushPartial().catch((err) => {
                log.error('partial assistant flush failed', {
                  sessionKey: session.sessionKey, peerId, turnIndex, status,
                }, err as Error)
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

      runner.on('message', handleMessage)
      runner.on('error', handleError)
      runner.on('exit', handleExit)
      runner.on('telemetry', handleTelemetry)
      runner.on('parse_error', handleParseError)

      runner.submit(userTextOrBlocks).catch((err) => {
        onEvent({ kind: 'error', error: String(err) })
        detach()
        settle(() => resolve())
      })
    })
  }

  interrupt(sessionKey: string): boolean {
    const s = this.sessions.get(sessionKey)
    if (!s) return false
    return s.runner.interrupt()
  }

  getByKey(sessionKey: string): AgentSession | undefined {
    return this.sessions.get(sessionKey)
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
      await s.runner.shutdown()
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
    this.sessions.clear()
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
            // 释放 remote mux refcount(若为 remote)—— 与 destroySession 语义一致
            if (s.executionTarget.kind === 'remote' && s.userId) {
              await this._remoteTargetController
                ?.releaseMux(key, s.userId, s.executionTarget.hostId)
                .catch((err) => log.warn('evict releaseMux failed', { key, err: String(err) }))
            }
            this.sessions.delete(key)
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
