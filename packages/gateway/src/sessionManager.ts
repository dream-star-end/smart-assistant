import { existsSync, readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AgentDef,
  type OpenClaudeConfig,
  indexTurn,
  paths,
  upsertSessionMeta,
} from '@openclaude/storage'
import { CcbMessageParser, type SessionStreamEvent } from './ccbMessageParser.js'
import { eventBus, createEvent } from './eventBus.js'
import { createLogger } from './logger.js'
import { SubprocessRunner } from './subprocessRunner.js'

const log = createLogger({ module: 'sessionManager' })

// 一个 sessionKey 对应一个 SubprocessRunner + 一把 Mutex(同 session 串行)。
// 跨 session 完全并行。
export interface AgentSession {
  sessionKey: string
  agentId: string
  channel: string
  peerId: string
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
  // Serialized write queue to prevent concurrent writeFile race conditions
  private _resumeMapWrite: Promise<void> = Promise.resolve()

  private _loadResumeMap(): void {
    // Try primary file first, fall back to backup if corrupted (atomic-write safety net)
    for (const path of [this.resumeMapPath, this.resumeMapPath + '.bak']) {
      try {
        if (!existsSync(path)) continue
        const data = JSON.parse(readFileSync(path, 'utf-8'))
        // Support both legacy format {key: sessionId} and new format {key: {id, ts}}
        for (const [key, val] of Object.entries(data)) {
          if (typeof val === 'string') {
            this._resumeMap.set(key, val)
            this._resumeMapTimestamps.set(key, Date.now()) // legacy: assume "now" as baseline
          } else if (val && typeof val === 'object' && 'id' in (val as any)) {
            this._resumeMap.set(key, (val as any).id)
            this._resumeMapTimestamps.set(key, (val as any).ts ?? Date.now())
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
    const obj: Record<string, { id: string; ts: number }> = {}
    const now = Date.now()
    for (const [key, val] of this._resumeMap) {
      obj[key] = { id: val, ts: this._resumeMapTimestamps.get(key) ?? now }
    }
    for (const [key, sess] of this.sessions) {
      if (sess.ccbSessionId) {
        obj[key] = { id: sess.ccbSessionId, ts: now }
        // Keep in-memory maps in sync
        this._resumeMap.set(key, sess.ccbSessionId)
        this._resumeMapTimestamps.set(key, now)
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
    title?: string
    delegationDepth?: number
  }): Promise<AgentSession> {
    const existing = this.sessions.get(opts.sessionKey)
    if (existing) {
      existing.lastUsedAt = Date.now()
      if (opts.title && (!existing.title || existing.title === 'New conversation'))
        existing.title = opts.title
      return existing
    }
    const cwd = opts.agent.cwd ?? process.cwd()
    const persona = opts.agent.persona ?? paths.agentClaudeMd(opts.agent.id)
    const runner = new SubprocessRunner({
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
      resumeSessionId: this._resumeMap.get(opts.sessionKey),
    })
    const now = Date.now()
    const session: AgentSession = {
      sessionKey: opts.sessionKey,
      agentId: opts.agent.id,
      channel: opts.channel ?? 'webchat',
      peerId: opts.peerId ?? 'unknown',
      title: opts.title ?? 'New conversation',
      startedAt: now,
      runner,
      ccbSessionId: null,
      lock: Promise.resolve(),
      lastUsedAt: now,
      totalCostUSD: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      turns: 0,
      model: opts.agent.model ?? this.config.defaults.model,
      toolUseIdToName: new Map(),
    }
    runner.on('session_id', (id: string) => {
      session.ccbSessionId = id
      // Persist session→ccbSessionId mapping for resume after gateway restart
      this._saveResumeMap()
    })
    // Monitor subprocess crashes — emit event so gateway can notify connected clients
    runner.on('exit', (info: { code: number | null; signal: string | null; crashed: boolean }) => {
      if (info.crashed) {
        log.warn('subprocess crashed', { sessionKey: opts.sessionKey, code: info.code, signal: info.signal })
        // Ensure the session stays in resume-map so it can be restored on next submit()
        // (SubprocessRunner.submit() auto-restarts with --resume when proc is null)
        if (session.ccbSessionId) {
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
  ): Promise<void> {
    const prev = session.lock
    let release!: () => void
    session.lock = new Promise<void>((r) => (release = r))
    try {
      await prev
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
      // Liveness-based timeout with state-aware thresholds:
      //   - Tool call in progress (MCP/Bash): 15 min (tools legitimately take time)
      //   - No tool call pending (API streaming / idle): 5 min
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
        onEvent({
          kind: 'error',
          error: '子进程长时间无响应,已中断。请重试。',
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
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this._runOneTurn(session, userTextOrBlocks, onEvent)
        return // success
      } catch (err: any) {
        const msg = err?.message ?? String(err)

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
          // Shutdown subprocess — next submit() auto-restarts with fresh config
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
  private static AUTH_KEYWORDS_RE = /authenticat|credentials|401|unauthorized/i
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

    // Snapshot session totals so we can roll back on auth error
    // (parser mutates these directly via sessionTotals reference)
    const prevCostUSD = session.totalCostUSD
    const prevTurns = session.turns

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn() } }

      const timer = setTimeout(
        () => {
          if (!parser.finalized) {
            try { runner.interrupt() } catch {}
            onEvent({ kind: 'error', error: '单轮对话超时 (30min),已中断。请重试。' })
            detach()
            settle(() => resolve())
          }
        },
        30 * 60 * 1000, // 30 min absolute timeout
      )

      // Buffer 'final' event — only forward to client after auth check passes
      let pendingFinal: SessionStreamEvent | null = null
      const wrappedOnEvent = (e: SessionStreamEvent) => {
        if (e.kind === 'final') { pendingFinal = e; return }
        onEvent(e)
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

          // Detect auth error in assistant output — roll back counters and reject.
          // Two signals: (1) isError + broad keyword match, (2) CCB's exact error prefix.
          const isAuthError = result && (
            (result.isError && SessionManager.AUTH_KEYWORDS_RE.test(result.assistantText)) ||
            SessionManager.AUTH_ERROR_PREFIX_RE.test(result.assistantText)
          )
          if (isAuthError) {
            session.totalCostUSD = prevCostUSD
            session.turns = prevTurns
            settle(() => reject(new Error('AUTH_ERROR: Token expired or invalid')))
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

      const handleMessage = (msg: any) => parser.parse(msg)
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
            onEvent({ kind: 'error', error: reason })
            detach()
            settle(() => resolve())
          }
        }, 150)
      }

      runner.on('message', handleMessage)
      runner.on('error', handleError)
      runner.on('exit', handleExit)

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

  /** Destroy a single session: kill subprocess + remove from map + clear resume mapping.
   *  Also clears resume-map even if the session was already evicted from memory. */
  async destroySession(sessionKey: string): Promise<void> {
    const s = this.sessions.get(sessionKey)
    if (s) {
      await s.runner.shutdown()
      this.sessions.delete(sessionKey)
    }
    // Always clear resume-map (handles both live and evicted sessions)
    if (this._resumeMap.has(sessionKey)) {
      this._resumeMap.delete(sessionKey)
      this._resumeMapTimestamps.delete(sessionKey)
      this._saveResumeMap()
    }
  }

  async shutdownAll(): Promise<void> {
    // Persist resume map BEFORE killing subprocesses — ensures state survives restart
    // (runner.shutdown() sets shuttingDown=true so the exit handler won't call _saveResumeMap)
    this._saveResumeMap()
    await this._resumeMapWrite
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
        // Cron/task sessions (contain ':cron:' or ':task:') use short idle timeout
        // Webchat/user sessions use long idle timeout (7 days)
        const isTempSession = key.includes(':cron:') || key.includes(':task:')
        const maxIdle = isTempSession ? this.maxIdleMsCron : this.maxIdleMsChat
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
        s.runner.shutdown().catch(() => {})
        this.sessions.delete(key)
        // Only webchat sessions should survive eviction in resume-map.
        // All other session types (cron, task, inter-agent, telegram) are ephemeral.
        if (!key.includes(':webchat:')) {
          this._resumeMap.delete(key)
          this._resumeMapTimestamps.delete(key)
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
  private static RESUME_MAP_TTL = 30 * 24 * 60 * 60 * 1000 // 30 days

  private _pruneResumeMap(): void {
    const now = Date.now()
    let pruned = false
    for (const [key] of this._resumeMap) {
      if (this.sessions.has(key)) continue // live session — keep
      const ts = this._resumeMapTimestamps.get(key) ?? 0
      if (ts > 0 && now - ts > SessionManager.RESUME_MAP_TTL) {
        this._resumeMap.delete(key)
        this._resumeMapTimestamps.delete(key)
        pruned = true
        log.info('pruned stale resume-map entry', { sessionKey: key })
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
