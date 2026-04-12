import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AgentDef,
  type OpenClaudeConfig,
  indexTurn,
  paths,
  upsertSessionMeta,
} from '@openclaude/storage'
import type { OutboundContentBlock } from '@openclaude/protocol'
import { SubprocessRunner, type SdkMessage } from './subprocessRunner.js'

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
}

export type SessionStreamEvent =
  | { kind: 'block'; block: OutboundContentBlock }
  | {
      kind: 'final'
      meta?: {
        cost?: number
        inputTokens?: number
        outputTokens?: number
        cacheReadTokens?: number
        cacheCreationTokens?: number
        totalCost?: number
        turn?: number
      }
    }
  | { kind: 'permission_request'; id: string; tool: string; summary: string }
  | { kind: 'error'; error: string }

export class SessionManager {
  private sessions = new Map<string, AgentSession>()
  private maxIdleMs = 30 * 60 * 1000

  private resumeMapPath = join(paths.home, 'resume-map.json')

  constructor(public config: OpenClaudeConfig) {
    this._loadResumeMap()
  }

  /** Update config reference (e.g. after OAuth token refresh) */
  updateConfig(config: OpenClaudeConfig): void { this.config = config }

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
    try { writeFileSync(this.resumeMapPath, JSON.stringify(obj, null, 2)) } catch {}
  }

  async getOrCreate(opts: {
    sessionKey: string
    agent: AgentDef
    channel?: string
    peerId?: string
    title?: string
  }): Promise<AgentSession> {
    const existing = this.sessions.get(opts.sessionKey)
    if (existing) {
      existing.lastUsedAt = Date.now()
      if (opts.title && (!existing.title || existing.title === 'New conversation')) existing.title = opts.title
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
      // Liveness-based timeout: kill only if NO stdout activity for 3 minutes
      // (replaces fixed 10-min timeout — long tasks that produce output stay alive)
      const IDLE_TIMEOUT = 3 * 60_000 // 3 minutes of zero output = stuck
      const CHECK_INTERVAL = 30_000   // check every 30s
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
        onEvent({ kind: 'error', error: '子进程无响应超过 3 分钟,已自动停止。如果任务仍在执行,请重试。' })
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
        const delay = BASE_DELAY * Math.pow(2, attempt) + Math.random() * 1000
        console.warn(`[session:${session.sessionKey}] transient error (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${Math.round(delay / 1000)}s: ${msg}`)
        onEvent({ kind: 'block', block: { kind: 'text', text: `\n\n⚠️ 遇到临时错误,${Math.round(delay / 1000)}秒后自动重试 (${attempt + 1}/${MAX_RETRIES})...\n` } })
        await new Promise(r => setTimeout(r, delay))
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
      let finalized = false
      // 本轮内所有 tool_use 的流式状态:key = tool_use id
      const streamingToolUses = new Map<
        string,
        { name: string; partialJson: string; done: boolean }
      >()
      // content_block index → tool_use id (用于 input_json_delta 的路由)
      const indexToToolId = new Map<number, string>()
      // 一轮内去重已 emit 过的 tool_result(user snapshot 也可能重复)
      const emittedToolResultIds = new Set<string>()

      const timer = setTimeout(
        () => {
          if (!finalized) {
            onEvent({ kind: 'error', error: 'timeout waiting for result' })
            finish()
          }
        },
        10 * 60 * 1000,
      )

      type FinalMeta = {
        cost?: number
        inputTokens?: number
        outputTokens?: number
        cacheReadTokens?: number
        cacheCreationTokens?: number
        totalCost?: number
        turn?: number
      }
      const finish = (meta?: FinalMeta) => {
        if (finalized) return
        finalized = true
        clearTimeout(timer)
        onEvent({ kind: 'final', meta })
        runner.off('message', handleMessage)
        runner.off('error', handleError)
        resolve()
      }

      const handleMessage = (msg: SdkMessage) => {
        try {
          // ── system:init ────────────────────────────────
          if (msg.type === 'system') {
            // session_id 已经由 subprocessRunner 抓取并 emit 'session_id' 事件
            return
          }

          // ── stream_event: 流式 partial deltas ──────────
          if (msg.type === 'stream_event') {
            const ev = (msg as any).event
            if (!ev || typeof ev !== 'object') return

            if (ev.type === 'content_block_start') {
              const cb = ev.content_block
              if (cb?.type === 'tool_use' && cb.id && cb.name) {
                session.toolUseIdToName.set(cb.id, cb.name)
                streamingToolUses.set(cb.id, {
                  name: cb.name,
                  partialJson: '',
                  done: false,
                })
                if (typeof ev.index === 'number') indexToToolId.set(ev.index, cb.id)
                // 立即 emit 一个 partial tool_use block(preview 空),web UI 据此挂载一条待更新
                onEvent({
                  kind: 'block',
                  block: {
                    kind: 'tool_use',
                    blockId: cb.id,
                    toolName: cb.name,
                    inputPreview: '',
                    partial: true,
                  },
                })
              }
              return
            }

            if (ev.type === 'content_block_delta') {
              const delta = ev.delta
              if (!delta) return
              if (delta.type === 'text_delta' && delta.text) {
                session.currentAssistantBuf = (session.currentAssistantBuf ?? '') + delta.text
                onEvent({ kind: 'block', block: { kind: 'text', text: delta.text } })
              } else if (delta.type === 'thinking_delta' && delta.thinking) {
                onEvent({ kind: 'block', block: { kind: 'thinking', text: delta.thinking } })
              } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
                const toolId = indexToToolId.get(ev.index as number)
                const tool = toolId ? streamingToolUses.get(toolId) : undefined
                if (tool) {
                  tool.partialJson += delta.partial_json
                  onEvent({
                    kind: 'block',
                    block: {
                      kind: 'tool_use',
                      blockId: toolId!,
                      toolName: tool.name,
                      inputPreview: tool.partialJson.slice(0, 400),
                      partial: true,
                    },
                  })
                }
              }
              return
            }

            if (ev.type === 'content_block_stop') {
              // 如果是 tool_use 的 block,标记 done(但最终完整 input 要等 assistant snapshot)
              const toolId = indexToToolId.get(ev.index as number)
              if (toolId) {
                const tool = streamingToolUses.get(toolId)
                if (tool) tool.done = true
              }
              return
            }

            // message_start / message_delta / message_stop:忽略
            return
          }

          // ── assistant snapshot: finalize tool_use with complete input ──
          if (msg.type === 'assistant') {
            const content = (msg as any).message?.content
            if (!Array.isArray(content)) return
            for (const c of content) {
              if (c?.type === 'tool_use' && c.id) {
                session.toolUseIdToName.set(c.id, c.name ?? 'unknown')
                const inputPreview =
                  typeof c.input === 'string'
                    ? c.input
                    : JSON.stringify(c.input ?? {}).slice(0, 400)
                const streamed = streamingToolUses.get(c.id)
                // 如果之前根本没从 stream_event 拿到 start(很少见,兜底),现在 emit 一次
                // 如果已经 stream 过,也发最终版 — web UI 会按 blockId 更新,设 partial: false
                onEvent({
                  kind: 'block',
                  block: {
                    kind: 'tool_use',
                    blockId: c.id,
                    toolName: c.name ?? 'unknown',
                    inputPreview,
                    partial: false,
                  },
                })
                if (streamed) streamed.done = true
              }
              // text / thinking 跳过(已从 stream_event 流式 emit 过)
            }
            return
          }

          // ── user snapshot: 处理 tool_result ────────────
          if (msg.type === 'user') {
            const content = (msg as any).message?.content
            if (!Array.isArray(content)) return
            for (const c of content) {
              if (c?.type === 'tool_result') {
                const useId = c.tool_use_id
                if (useId && emittedToolResultIds.has(useId)) continue
                if (useId) emittedToolResultIds.add(useId)
                const toolName = useId
                  ? (session.toolUseIdToName.get(useId) ?? 'unknown')
                  : 'unknown'
                const previewRaw = c.content
                let preview: string
                if (typeof previewRaw === 'string') {
                  preview = previewRaw
                } else if (Array.isArray(previewRaw)) {
                  preview = previewRaw
                    .map((b: any) => {
                      if (b?.type === 'text' && typeof b.text === 'string') return b.text
                      return JSON.stringify(b)
                    })
                    .join('\n')
                } else {
                  preview = JSON.stringify(previewRaw ?? '')
                }
                if (preview.length > 500) preview = `${preview.slice(0, 500)}…`
                onEvent({
                  kind: 'block',
                  block: {
                    kind: 'tool_result',
                    blockId: useId ? useId + ':result' : undefined,
                    toolName,
                    isError: !!c.is_error,
                    preview,
                  },
                })
              }
            }
            return
          }

          // ── result: 本轮结束 ───────────────────────────
          if (msg.type === 'result') {
            const usage = (msg as any).usage ?? {}
            const turnCost = (msg as any).total_cost_usd ?? 0
            session.totalCostUSD += turnCost
            session.totalInputTokens += usage.input_tokens ?? 0
            session.totalOutputTokens += usage.output_tokens ?? 0
            session.totalCacheReadTokens += usage.cache_read_input_tokens ?? 0
            session.totalCacheCreationTokens += usage.cache_creation_input_tokens ?? 0
            session.turns += 1
            // ── L2: persist to FTS5 for session_search ──
            const turnIdx = session.turns
            const userText = session.currentUserText ?? ''
            const assistantText = session.currentAssistantBuf ?? ''
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
              indexTurn(sessId, turnIdx, userText, assistantText),
            ]).catch((err) => console.error('[sessionManager] FTS5 index failed:', err))
            // ── end L2 ──
            finish({
              cost: turnCost,
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              cacheReadTokens: usage.cache_read_input_tokens,
              cacheCreationTokens: usage.cache_creation_input_tokens,
              totalCost: session.totalCostUSD,
              turn: session.turns,
            })
            return
          }

          // ── assistant_error / status / tool_progress / 其他:忽略 ──
        } catch (err) {
          onEvent({ kind: 'error', error: String(err) })
        }
      }

      const handleError = (err: Error) => {
        onEvent({ kind: 'error', error: err.message })
        finish()
      }

      runner.on('message', handleMessage)
      runner.on('error', handleError)

      runner.submit(userTextOrBlocks).catch((err) => {
        onEvent({ kind: 'error', error: String(err) })
        finish()
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

  // 周期性 LRU 驱逐
  startEvictionLoop(intervalMs = 60_000): () => void {
    const t = setInterval(() => {
      const now = Date.now()
      for (const [key, s] of this.sessions) {
        if (now - s.lastUsedAt > this.maxIdleMs) {
          s.runner.shutdown().catch(() => {})
          this.sessions.delete(key)
        }
      }
    }, intervalMs)
    return () => clearInterval(t)
  }
}
