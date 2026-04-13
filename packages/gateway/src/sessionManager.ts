import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AgentDef,
  type OpenClaudeConfig,
  indexTurn,
  paths,
  upsertSessionMeta,
} from '@openclaude/storage'
import { CcbMessageParser, type SessionStreamEvent } from './ccbMessageParser.js'
import { eventBus } from './eventBus.js'
import { SubprocessRunner } from './subprocessRunner.js'

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
  // CCB CronCreate bridge: maps tool_use_id/content_key → gateway cron job ID
  _cronBridgeMap?: Map<string, string>
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
  private maxIdleMsChat = 7 * 24 * 60 * 60 * 1000 // 7 days for webchat sessions
  /** @deprecated Use eventBus 'task.created'/'task.deleted' instead. Kept for backward compat. */
  public onCronBridge?: (event: CronBridgeEvent) => Promise<void>

  private resumeMapPath = join(paths.home, 'resume-map.json')

  constructor(public config: OpenClaudeConfig) {
    this._loadResumeMap()
  }

  /** Update config reference (e.g. after OAuth token refresh) */
  updateConfig(config: OpenClaudeConfig): void {
    this.config = config
  }

  // Resume map: sessionKey → ccbSessionId (survives gateway restart)
  private _resumeMap = new Map<string, string>()

  private _loadResumeMap(): void {
    try {
      if (existsSync(this.resumeMapPath)) {
        const data = JSON.parse(readFileSync(this.resumeMapPath, 'utf-8'))
        this._resumeMap = new Map(Object.entries(data))
      }
    } catch {}
  }

  private _saveResumeMap(): void {
    const obj: Record<string, string> = {}
    for (const [key, sess] of this.sessions) {
      if (sess.ccbSessionId) obj[key] = sess.ccbSessionId
    }
    try {
      writeFileSync(this.resumeMapPath, JSON.stringify(obj, null, 2))
    } catch {}
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
      toolUseIdToName: new Map(),
    }
    runner.on('session_id', (id: string) => {
      session.ccbSessionId = id
      // Persist session→ccbSessionId mapping for resume after gateway restart
      this._saveResumeMap()
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
      // Reset per-turn accumulators for FTS5 indexing
      session.currentUserText =
        typeof userTextOrBlocks === 'string'
          ? userTextOrBlocks
          : userTextOrBlocks
              .filter((b) => b.type === 'text')
              .map((b) => (b as any).text ?? '')
              .join('\n')
      session.currentAssistantBuf = ''
      // Auto-name session from first user turn
      if (session.turns === 0 && session.currentUserText) {
        const title = session.currentUserText.slice(0, 50).replace(/\s+/g, ' ').trim()
        if (title) session.title = title
      }
      // Liveness-based timeout: kill only if NO stdout/stderr activity for a while.
      // Delegate/cron tasks get longer timeout since tools (Browser, Bash) can take time.
      const isLongRunning =
        session.sessionKey.includes(':delegate:') ||
        session.sessionKey.includes(':cron:') ||
        session.sessionKey.includes(':task:')
      const IDLE_TIMEOUT = isLongRunning ? 10 * 60_000 : 5 * 60_000 // 10min for tasks, 5min for chat
      const CHECK_INTERVAL = 30_000 // check every 30s
      let livenessTimer: NodeJS.Timeout | null = null
      const livenessPromise = new Promise<never>((_, reject) => {
        livenessTimer = setInterval(() => {
          const idleMs = Date.now() - session.runner.lastActivityAt
          if (idleMs > IDLE_TIMEOUT) {
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
        onEvent({
          kind: 'error',
          error: '子进程无响应超过 3 分钟,已自动停止。如果任务仍在执行,请重试。',
        })
        console.error(`[session:${session.sessionKey}] idle timeout: ${err.message}`)
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
        // Only retry on transient errors (rate limit, server error, network)
        const isTransient = /529|503|502|504|ECONNRESET|ETIMEDOUT|rate.limit|overloaded/i.test(msg)
        if (!isTransient || attempt >= MAX_RETRIES) throw err
        const delay = BASE_DELAY * 2 ** attempt + Math.random() * 1000
        console.warn(
          `[session:${session.sessionKey}] transient error (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${Math.round(delay / 1000)}s: ${msg}`,
        )
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

  private async _runOneTurn(
    session: AgentSession,
    userTextOrBlocks: string | Array<{ type: string; [key: string]: unknown }>,
    onEvent: (e: SessionStreamEvent) => void,
  ): Promise<void> {
    const { runner } = session
    await new Promise<void>((resolve) => {
      const timer = setTimeout(
        () => {
          if (!parser.finalized) {
            onEvent({ kind: 'error', error: 'timeout waiting for result' })
            cleanup()
          }
        },
        10 * 60 * 1000,
      )

      const cleanup = () => {
        clearTimeout(timer)
        parser.finish()
        runner.off('message', handleMessage)
        runner.off('error', handleError)
        resolve()
      }

      const parser = new CcbMessageParser({
        toolUseIdToName: session.toolUseIdToName,
        onEvent,
        onToolUse: (tool) => {
          // Bridge CCB CronCreate/CronDelete via EventBus
          if (tool.name === 'CronCreate') {
            const gatewayJobId = `ccb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
            // Stage 1: store tool_use_id → gatewayJobId.
            // Stage 2 (onToolResult): when CronCreate result arrives, extract CCB's
            // returned job ID from the text and store ccbJobId → gatewayJobId.
            if (!session._cronBridgeMap) session._cronBridgeMap = new Map()
            session._cronBridgeMap.set(`_pending:${tool.id}`, gatewayJobId)
            eventBus.emit('task.created', {
              type: 'task.created',
              taskId: gatewayJobId,
              agentId: session.agentId,
              schedule: tool.input.cron,
              prompt: tool.input.prompt,
              oneshot: tool.input.recurring === false,
              source: 'cron-bridge',
            })
          } else if (tool.name === 'CronDelete') {
            // Look up the gateway job ID from our ccbJobId → gatewayJobId map
            const ccbId = tool.input.id
            const gatewayId = session._cronBridgeMap?.get(ccbId) ?? ccbId
            eventBus.emit('task.deleted', {
              type: 'task.deleted',
              taskId: gatewayId,
              agentId: session.agentId,
            })
          }
        },
        onToolResult: (tr) => {
          // Stage 2 of CronCreate bridge: extract CCB's returned job ID from result text
          // and establish ccbJobId → gatewayJobId mapping for future CronDelete.
          // CCB CronCreate result format: "Scheduled recurring job XXXXXXXX (...)"
          if (tr.toolName === 'CronCreate' && !tr.isError && session._cronBridgeMap) {
            const pendingKey = `_pending:${tr.toolUseId}`
            const gatewayJobId = session._cronBridgeMap.get(pendingKey)
            if (gatewayJobId) {
              session._cronBridgeMap.delete(pendingKey)
              // Extract CCB job ID from result text (8-char hex)
              const match = /job\s+([0-9a-f]{6,12})/i.exec(tr.preview)
              if (match) {
                session._cronBridgeMap.set(match[1], gatewayJobId)
              }
            }
          }
        },
        onFinish: (result) => {
          clearTimeout(timer)
          runner.off('message', handleMessage)
          runner.off('error', handleError)
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
            ]).catch((err) => console.error('[sessionManager] FTS5 index failed:', err))
          }
          resolve()
        },
        sessionTotals: session, // parser reads/writes totalCostUSD and turns directly
      })

      const handleMessage = (msg: any) => parser.parse(msg)
      const handleError = (err: Error) => {
        onEvent({ kind: 'error', error: err.message })
        cleanup()
      }

      runner.on('message', handleMessage)
      runner.on('error', handleError)

      runner.submit(userTextOrBlocks).catch((err) => {
        onEvent({ kind: 'error', error: String(err) })
        cleanup()
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

  /** Destroy a single session: kill subprocess + remove from map + clear resume mapping */
  async destroySession(sessionKey: string): Promise<void> {
    const s = this.sessions.get(sessionKey)
    if (!s) return
    await s.runner.shutdown()
    this.sessions.delete(sessionKey)
    this._resumeMap.delete(sessionKey)
    this._saveResumeMap()
  }

  async shutdownAll(): Promise<void> {
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
      for (const [key, s] of this.sessions) {
        // Cron/task sessions (contain ':cron:' or ':task:') use short idle timeout
        // Webchat/user sessions use long idle timeout (7 days)
        const isTempSession = key.includes(':cron:') || key.includes(':task:')
        const maxIdle = isTempSession ? this.maxIdleMsCron : this.maxIdleMsChat
        if (now - s.lastUsedAt > maxIdle) {
          s.runner.shutdown().catch(() => {})
          this.sessions.delete(key)
        }
      }
    }, intervalMs)
    return () => clearInterval(t)
  }
}
