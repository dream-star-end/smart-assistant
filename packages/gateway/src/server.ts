import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import type { ChannelAdapter, ChannelContext } from '@openclaude/plugin-sdk'
import type { InboundFrame, InboundMessage, OutboundMessage } from '@openclaude/protocol'
import {
  type AgentDef,
  type AgentsConfig,
  MemoryStore,
  type OpenClaudeConfig,
  SkillStore,
  TaskStore,
  paths,
  readAgentsConfig,
  readConfig,
  searchSessions,
  writeAgentsConfig,
  writeConfig,
} from '@openclaude/storage'
import { type WebSocket, WebSocketServer } from 'ws'
import { checkToken } from './auth.js'
import { CronScheduler } from './cron.js'
import { eventBus } from './eventBus.js'
import { handleOpenAIRequest } from './openaiCompat.js'
import { PermissionRelay, type PermissionRequest } from './permissionRelay.js'
import { Router } from './router.js'
import { RunLog } from './runLog.js'
import { SessionManager } from './sessionManager.js'
import { WebhookRouter } from './webhooks.js'

export interface GatewayDeps {
  config: OpenClaudeConfig
  agentsConfig: AgentsConfig
  webRoot?: string // 静态 web UI 目录
  channelFactories?: Array<(deps: { config: OpenClaudeConfig }) => ChannelAdapter>
}

export class Gateway {
  private wss!: WebSocketServer
  private httpServer!: ReturnType<typeof createServer>
  private router: Router
  private sessions: SessionManager
  private cron: CronScheduler | null = null
  private webhookRouter: WebhookRouter | null = null
  private _taskStore = new TaskStore()
  private _runLog = new RunLog()
  private permissions: PermissionRelay | null = null
  private channels = new Map<string, ChannelAdapter>()

  // ── Idempotency key dedup (prevents duplicate processing on client reconnect replay) ──
  private _seenIdempotencyKeys = new Map<string, number>() // key → timestamp
  private static readonly IDEMPOTENCY_MAX_KEYS = 1000
  private static readonly IDEMPOTENCY_TTL_MS = 5 * 60_000 // 5 minutes

  /**
   * Check whether an idempotency key has already been processed.
   * Returns true if the key is a duplicate (i.e. should be skipped).
   */
  private _checkIdempotencyKey(key: string): boolean {
    if (!key) return false // empty key = no dedup
    const now = Date.now()

    // Evict expired entries on every check to keep Map bounded by TTL
    if (this._seenIdempotencyKeys.size > 100) {
      for (const [k, ts] of this._seenIdempotencyKeys) {
        if (now - ts > Gateway.IDEMPOTENCY_TTL_MS) {
          this._seenIdempotencyKeys.delete(k)
        }
      }
    }

    if (this._seenIdempotencyKeys.has(key)) {
      const ts = this._seenIdempotencyKeys.get(key)!
      if (now - ts < Gateway.IDEMPOTENCY_TTL_MS) {
        return true // duplicate
      }
      // Expired — allow re-processing, will be re-added below
    }

    this._seenIdempotencyKeys.set(key, now)
    return false
  }

  // ── Cached task list for high-frequency eventBus lookups ──
  private _cachedTasks: Awaited<ReturnType<TaskStore['list']>> | null = null
  private async _getCachedTasks() {
    if (!this._cachedTasks) {
      this._cachedTasks = await this._taskStore.list()
    }
    return this._cachedTasks
  }
  private _invalidateTaskCache() {
    this._cachedTasks = null
  }

  // ── Cached agents config (avoid re-reading YAML on every request) ──
  private _agentsConfigCache: AgentsConfig | null = null
  private _agentsConfigMtime: number = 0

  private async _getAgentsConfig(): Promise<AgentsConfig> {
    try {
      const st = statSync(paths.agentsYaml)
      const mtime = st.mtimeMs
      if (this._agentsConfigCache && mtime === this._agentsConfigMtime) {
        return this._agentsConfigCache
      }
      this._agentsConfigCache = await readAgentsConfig()
      this._agentsConfigMtime = mtime
      return this._agentsConfigCache
    } catch {
      // File doesn't exist or stat failed — fall through to fresh read
      this._agentsConfigCache = await readAgentsConfig()
      this._agentsConfigMtime = 0
      return this._agentsConfigCache
    }
  }

  // ── In-memory cache for static web UI files ──
  private _staticFileCache = new Map<string, { content: Buffer; mime: string }>()
  // (channel, peer.id) → 当前活跃的 ws client(用于回传 outbound)
  private clientsByPeer = new Map<string, Set<WebSocket>>()
  // Per-agent last active channel tracking (for proactive push)
  // Track last active channel + session for proactive push (reminders, heartbeat, etc.)
  private lastActiveChannel = new Map<
    string,
    { channel: string; peerId: string; sessionKey: string; at: number }
  >()

  constructor(private deps: GatewayDeps) {
    this.router = new Router(deps.agentsConfig)
    this.sessions = new SessionManager(deps.config)
  }

  async start(): Promise<void> {
    const { config } = this.deps

    this.httpServer = createServer((req, res) => this.handleHttp(req, res))
    this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' })

    // WS keepalive: ping every 25s, terminate if no pong in 35s
    setInterval(() => {
      for (const ws of this.wss.clients) {
        if ((ws as any)._isAlive === false) {
          ws.terminate()
          continue
        }
        ;(ws as any)._isAlive = false
        ws.ping()
      }
    }, 25_000)

    this.wss.on('connection', (ws, req) => this.handleWsConnection(ws, req))

    // 启动渠道
    for (const factory of this.deps.channelFactories ?? []) {
      const adapter = factory({ config })
      const ctx: ChannelContext = {
        dispatch: (frame) => this.dispatchInbound(frame, adapter),
        log: {
          info: (m, meta) => console.log(`[ch:${adapter.name}] ${m}`, meta ?? ''),
          error: (m, meta) => console.error(`[ch:${adapter.name}] ${m}`, meta ?? ''),
        },
        config: (config.channels as any)[adapter.name] ?? {},
      }
      try {
        await adapter.init(ctx)
        this.channels.set(adapter.name, adapter)
        console.log(`[gateway] channel "${adapter.name}" ready`)
      } catch (err) {
        console.error(`[gateway] channel "${adapter.name}" failed to init:`, err)
      }
    }

    const stopEviction = this.sessions.startEvictionLoop()
    process.once('SIGINT', () => this.shutdown(stopEviction))
    process.once('SIGTERM', () => this.shutdown(stopEviction))

    // Permission relay for PreToolUse hook guard
    this.permissions = new PermissionRelay()
    this.permissions.on('request', (req: PermissionRequest) => this.broadcastPermissionRequest(req))
    this.permissions.on('expired', (req: PermissionRequest) => {
      console.log('[permission-relay] expired', req.reqId, req.reason)
    })
    this.permissions.start().catch((err) => console.error('[permission-relay] start failed:', err))

    // Start cron scheduler for reflection jobs (L3)
    // Smart delivery: push to last active channel, fallback to all webchat clients
    this.cron = new CronScheduler(config, this.sessions, (text, job) => {
      const agentId = job.agent
      const lastActive = this.lastActiveChannel.get(agentId)
      const icon =
        job.id === 'heartbeat'
          ? '💓'
          : job.id.includes('skill')
            ? '🛠'
            : job.id.startsWith('remind')
              ? '⏰'
              : '🪞'

      // Build outbound message — use last active session if available
      // Include cronJob metadata so frontend can visually distinguish system pushes
      const buildOut = (peerId: string, sessionKey?: string) => ({
        type: 'outbound.message' as const,
        sessionKey: sessionKey || `agent:${agentId}:cron:dm:${job.id}`,
        channel: 'webchat' as const,
        peer: { id: peerId, kind: 'dm' as const },
        blocks: [{ kind: 'text' as const, text: `${icon} ${job.label || job.id}\n\n${text}` }],
        isFinal: true,
        cronJob: { id: job.id, heartbeat: !!job.heartbeat, label: job.label || job.id },
      })

      let delivered = false

      // 1. Push to last active channel + session (within 24h)
      if (lastActive && Date.now() - lastActive.at < 24 * 3600_000) {
        if (lastActive.channel === 'webchat') {
          const peerKey = `webchat:${lastActive.peerId}`
          const set = this.clientsByPeer.get(peerKey)
          if (set && set.size > 0) {
            // Use the last active session so message appears in the right conversation
            const data = JSON.stringify(buildOut(lastActive.peerId, lastActive.sessionKey))
            for (const ws of set) {
              try {
                ws.send(data)
              } catch {}
            }
            delivered = true
          }
        }
        // Try Telegram / other channel adapter
        if (!delivered) {
          const adapter = this.channels.get(lastActive.channel)
          if (adapter) {
            adapter.send(buildOut(lastActive.peerId, lastActive.sessionKey)).catch(() => {})
            delivered = true
          }
        }
      }

      // 2. Try explicit deliver target
      if (!delivered && job.deliver && job.deliver !== 'local') {
        const adapter = this.channels.get(job.deliver)
        if (adapter) {
          adapter.send(buildOut(job.deliverTarget?.peerId || '__cron__')).catch(() => {})
          delivered = true
        }
      }

      // 3. Fallback: broadcast to all connected webchat clients
      if (!delivered) {
        const data = JSON.stringify(buildOut('__reflection__'))
        for (const set of this.clientsByPeer.values()) {
          for (const ws of set) {
            try {
              ws.send(data)
            } catch {}
          }
        }
      }
    })
    this.cron.lastActiveChannel = this.lastActiveChannel
    this.cron.start().catch((err) => console.error('[cron] start failed:', err))

    // EventBus: bridge CCB CronCreate/CronDelete to gateway CronScheduler
    eventBus.on('task.created', (ev) => {
      if (!this.cron || ev.source !== 'cron-bridge') return
      // Use taskId directly — sessionManager already generates unique ccb-xxx IDs
      this.cron
        .addJob({
          id: ev.taskId,
          schedule: ev.schedule || '* * * * *',
          agent: ev.agentId,
          prompt: ev.prompt,
          deliver: 'webchat',
          enabled: true,
          oneshot: ev.oneshot ?? true,
          label: ev.prompt.slice(0, 50),
        })
        .then(() => console.log(`[eventBus] task.created → gateway job ${ev.taskId}`))
        .catch((err) => console.warn('[eventBus] task.created failed:', err))
    })
    eventBus.on('task.deleted', (ev) => {
      if (!this.cron) return
      this.cron
        .removeJob(ev.taskId)
        .then((ok) =>
          console.log(`[eventBus] task.deleted → ${ok ? 'removed' : 'not found'} ${ev.taskId}`),
        )
        .catch((err) => console.warn('[eventBus] task.deleted failed:', err))
    })

    // Start webhook router
    this.webhookRouter = new WebhookRouter()
    await this.webhookRouter.load()
    console.log(`[webhooks] loaded ${this.webhookRouter.list().length} webhook(s)`)

    // EventBus: route webhook.received → agent execution + delivery
    eventBus.on('webhook.received', (ev) => {
      const { webhookId, agentId, payload } = ev
      const { resolvedPrompt } = payload as any
      ;(async () => {
        const cfg = await this._getAgentsConfig()
        const agent = cfg.agents.find((a) => a.id === agentId)
        if (!agent) return console.warn(`[webhook] agent "${agentId}" not found`)
        const sessionKey = `agent:${agentId}:webhook:${webhookId}:${Date.now()}`
        const session = await this.sessions.getOrCreate({
          sessionKey,
          agent,
          channel: 'webhook',
          peerId: webhookId,
          title: `[webhook] ${webhookId}`,
        })
        const _whRun = this._runLog.start({ agentId, sessionKey, taskType: 'webhook' })
        let output = ''
        let _whError = ''
        try {
          await this.sessions.submit(session, resolvedPrompt, (e) => {
            if (e.kind === 'block' && e.block.kind === 'text') output += (e.block as any).text
            if (e.kind === 'error') _whError = e.error
          })
          this._runLog.complete(_whRun, {
            status: _whError ? 'failed' : 'completed',
            error: _whError || undefined,
          })
        } catch (err: any) {
          _whError = _whError || String(err)
          this._runLog.complete(_whRun, { status: 'failed', error: _whError })
        }
        // Deliver to last active webchat
        if (output.trim()) {
          const lastActive =
            this.lastActiveChannel.get(agentId) || this.lastActiveChannel.get('main')
          if (lastActive) {
            const out = {
              type: 'outbound.message' as const,
              sessionKey: lastActive.sessionKey,
              channel: 'webchat' as const,
              peer: { id: lastActive.peerId, kind: 'dm' as const },
              blocks: [
                { kind: 'text' as const, text: `🔔 **Webhook ${webhookId}**\n\n${output.trim()}` },
              ],
              isFinal: true,
            }
            const set = this.clientsByPeer.get(`webchat:${lastActive.peerId}`)
            if (set) {
              const data = JSON.stringify(out)
              for (const ws of set) {
                try {
                  ws.send(data)
                } catch {}
              }
            }
          }
        }
      })().catch((err) => console.error(`[webhook] ${webhookId} execution failed:`, err))
    })

    // TaskStore: schedule-triggered tasks run alongside cron (check every 60s)
    setInterval(() => {
      this._tickScheduledTasks().catch((err) => console.error('[task-scheduler] tick failed:', err))
    }, 60_000)

    // Invalidate task cache when tasks are created or deleted
    eventBus.on('task.created', () => this._invalidateTaskCache())
    eventBus.on('task.deleted', () => this._invalidateTaskCache())

    // EventBus: webhook.received can also trigger webhook-type tasks
    eventBus.on('webhook.received', (ev) => {
      this._getCachedTasks()
        .then((tasks) => {
          for (const t of tasks) {
            if (
              t.trigger === 'webhook' &&
              t.webhookId === ev.webhookId &&
              t.status !== 'disabled'
            ) {
              this._triggerTask(t.id).catch(() => {})
            }
          }
        })
        .catch(() => {})
    })

    // EventBus: catch-all listener for event-triggered tasks (uses cached task list)
    eventBus.on('*', (ev) => {
      this._getCachedTasks()
        .then((tasks) => {
          for (const t of tasks) {
            if (t.trigger === 'event' && t.eventType === ev.type && t.status !== 'disabled') {
              this._triggerTask(t.id).catch(() => {})
            }
          }
        })
        .catch(() => {})
    })

    // Start OAuth token auto-refresh (every 30 min)
    setInterval(() => this.refreshClaudeOAuthIfNeeded().catch(() => {}), 30 * 60_000)
    // Check immediately on boot
    this.refreshClaudeOAuthIfNeeded().catch(() => {})

    await new Promise<void>((res) => {
      this.httpServer.listen(config.gateway.port, config.gateway.bind, () => res())
    })
    console.log(`[gateway] http://${config.gateway.bind}:${config.gateway.port}  (token: *****)`)

    // Auto-resume: proactively continue interrupted webchat sessions after gateway restart
    this.bootAutoResume().catch((err) => console.error('[auto-resume] boot failed:', err))
  }

  private async shutdown(stopEviction: () => void): Promise<void> {
    console.log('\n[gateway] shutting down...')
    stopEviction()
    for (const ch of this.channels.values()) {
      try {
        await ch.shutdown()
      } catch {}
    }
    await this.sessions.shutdownAll()
    this.wss.close()
    this.httpServer.close()
    process.exit(0)
  }

  // ───────── HTTP ─────────
  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    // Routes that need auth
    // All /api/* and /v1/* endpoints require auth except healthz
    const needsAuth =
      (url.pathname.startsWith('/api/') && url.pathname !== '/api/healthz') ||
      url.pathname.startsWith('/v1/')
    if (needsAuth && !this.checkHttpAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    // OpenAI-compatible API: /v1/chat/completions, /v1/models
    if (url.pathname.startsWith('/v1/')) {
      handleOpenAIRequest(req, res, url, {
        config: this.deps.config,
        agentsConfig: this.deps.agentsConfig,
        sessions: this.sessions,
        runLog: this._runLog,
        readBody: (r) => this.readBody(r),
        sendJson: (r, c, b) => this.sendJson(r, c, b),
        sendError: (r, c, m) => this.sendError(r, c, m),
      })
        .then((handled) => {
          if (!handled) this.sendError(res, 404, 'unknown v1 endpoint')
        })
        .catch((err) => this.sendError(res, 500, String(err)))
      return
    }

    // Session cookie endpoint — called by frontend after login to set HttpOnly cookie
    // (so img/audio/video elements can access /api/file and /api/media without JS headers)
    if (url.pathname === '/api/auth/session' && req.method === 'POST') {
      if (!this.checkHttpAuth(req)) {
        res.writeHead(401)
        res.end('unauthorized')
        return
      }
      this.setSessionCookie(res, req)
      this.sendJson(res, 200, { ok: true })
      return
    }

    // Logout: expire the HttpOnly session cookie
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      const secure = this.isHttps(req) ? '; Secure' : ''
      res.setHeader('Set-Cookie', `oc_session=; HttpOnly; SameSite=Strict${secure}; Path=/api/; Max-Age=0`)
      this.sendJson(res, 200, { ok: true })
      return
    }

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, sessions: this.sessions.list().length }))
      return
    }
    if (url.pathname === '/api/doctor') {
      const summary = this._runLog.summary()
      const recentRuns = this._runLog.recent(20)
      const sessions = this.sessions.list()
      const webhooks = this.webhookRouter?.list().length ?? 0
      this.sendJson(res, 200, {
        uptime: process.uptime(),
        memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        activeSessions: sessions.length,
        webhooks,
        runLog: summary,
        recentRuns,
      })
      return
    }
    if (url.pathname === '/api/runs' && req.method === 'GET') {
      this.sendJson(res, 200, { runs: this._runLog.recent(50) })
      return
    }
    if (url.pathname === '/api/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ sessions: this.sessions.list() }))
      return
    }
    if (url.pathname === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      const activeMcps: Array<{ id: string; label?: string; provider?: string; tools?: string[] }> =
        []
      const activeProvider = this.deps.config.provider
      for (const srv of this.deps.config.mcpServers ?? []) {
        if (srv.enabled === false) continue
        if (srv.provider && srv.provider !== activeProvider) continue
        activeMcps.push({ id: srv.id, label: srv.label, provider: srv.provider, tools: srv.tools })
      }
      const authInfo: Record<string, any> = { mode: this.deps.config.auth.mode }
      if (this.deps.config.auth.claudeOAuth?.accessToken) {
        authInfo.claudeOAuth = {
          active: true,
          expiresAt: this.deps.config.auth.claudeOAuth.expiresAt,
        }
      }
      if (this.deps.config.auth.codexOAuth?.accessToken) {
        authInfo.codexOAuth = {
          active: true,
          expiresAt: this.deps.config.auth.codexOAuth.expiresAt,
        }
      }
      res.end(
        JSON.stringify({
          gateway: { bind: this.deps.config.gateway.bind, port: this.deps.config.gateway.port },
          defaults: this.deps.config.defaults,
          channels: Object.keys(this.deps.config.channels),
          provider: activeProvider,
          auth: authInfo,
          mcpServers: activeMcps,
        }),
      )
      return
    }
    if (url.pathname === '/api/agents') {
      this.handleAgentsCollection(req, res).catch((err) => this.sendError(res, 500, String(err)))
      return
    }
    const agentIdMatch = url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)$/)
    if (agentIdMatch) {
      this.handleAgentItem(req, res, agentIdMatch[1]).catch((err) =>
        this.sendError(res, 500, String(err)),
      )
      return
    }
    const personaMatch = url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/persona$/)
    if (personaMatch) {
      this.handlePersona(req, res, personaMatch[1]).catch((err) =>
        this.sendError(res, 500, String(err)),
      )
      return
    }
    const memoryMatch = url.pathname.match(
      /^\/api\/agents\/([a-zA-Z0-9_-]+)\/memory\/(memory|user)$/,
    )
    if (memoryMatch) {
      this.handleMemory(req, res, memoryMatch[1], memoryMatch[2] as 'memory' | 'user').catch(
        (err) => this.sendError(res, 500, String(err)),
      )
      return
    }
    const skillsListMatch = url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/skills$/)
    if (skillsListMatch) {
      this.handleSkillsList(req, res, skillsListMatch[1]).catch((err) =>
        this.sendError(res, 500, String(err)),
      )
      return
    }
    const skillViewMatch = url.pathname.match(
      /^\/api\/agents\/([a-zA-Z0-9_-]+)\/skills\/([a-z0-9-]+)$/,
    )
    if (skillViewMatch) {
      this.handleSkillItem(req, res, skillViewMatch[1], skillViewMatch[2]).catch((err) =>
        this.sendError(res, 500, String(err)),
      )
      return
    }
    // ── Inter-agent messaging ──
    const agentMsgMatch = url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/message$/)
    if (agentMsgMatch) {
      this.handleAgentMessage(req, res, agentMsgMatch[1]).catch((err) =>
        this.sendError(res, 500, String(err)),
      )
      return
    }
    // ── Synchronous task delegation ──
    const delegateMatch = url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/delegate$/)
    if (delegateMatch) {
      this.handleDelegateTask(req, res, delegateMatch[1]).catch((err) =>
        this.sendError(res, 500, String(err)),
      )
      return
    }
    if (url.pathname === '/api/search') {
      this.handleSearch(req, res, url).catch((err) => this.sendError(res, 500, String(err)))
      return
    }
    // ── Cron/reminder REST API ──
    if (url.pathname === '/api/cron') {
      this.handleCronApi(req, res).catch((err) => this.sendError(res, 500, String(err)))
      return
    }
    const cronItemMatch = url.pathname.match(/^\/api\/cron\/([a-zA-Z0-9_-]+)$/)
    if (cronItemMatch) {
      this.handleCronItem(req, res, cronItemMatch[1]).catch((err) =>
        this.sendError(res, 500, String(err)),
      )
      return
    }
    // ── Tasks REST API ──
    if (url.pathname === '/api/tasks') {
      this._handleTasksApi(req, res).catch((err) => this.sendError(res, 500, String(err)))
      return
    }
    const taskItemMatch = url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)$/)
    if (taskItemMatch) {
      this._handleTaskItem(req, res, taskItemMatch[1]).catch((err) =>
        this.sendError(res, 500, String(err)),
      )
      return
    }
    if (url.pathname === '/api/tasks-executions' && req.method === 'GET') {
      this._taskStore
        .recentExecutions()
        .then((execs) => this.sendJson(res, 200, { executions: execs }))
        .catch((err) => this.sendError(res, 500, String(err)))
      return
    }

    // ── Webhook REST API ──
    if (url.pathname === '/api/webhooks' && req.method === 'GET') {
      const list = this.webhookRouter?.list() ?? []
      this.sendJson(res, 200, { webhooks: list })
      return
    }
    const webhookMatch = url.pathname.match(/^\/api\/webhooks\/([a-zA-Z0-9_-]+)$/)
    if (webhookMatch) {
      this._handleWebhook(req, res, webhookMatch[1]).catch((err) =>
        this.sendError(res, 500, String(err)),
      )
      return
    }

    // ── Claude.ai OAuth ──
    if (url.pathname === '/api/auth/claude/start') {
      this.handleOAuthStart(req, res).catch((err) => this.sendError(res, 500, String(err)))
      return
    }
    if (url.pathname === '/api/auth/claude/callback') {
      this.handleOAuthCallback(req, res).catch((err) => this.sendError(res, 500, String(err)))
      return
    }
    if (url.pathname === '/api/auth/claude/status') {
      const oauth = this.deps.config.auth.claudeOAuth
      this.sendJson(res, 200, {
        authenticated: !!oauth?.accessToken,
        expiresAt: oauth?.expiresAt,
        scope: oauth?.scope,
      })
      return
    }

    // ── Media file serving ──
    // Serve user-uploaded and MCP-generated media files for inline rendering.
    const mediaMatch = url.pathname.match(/^\/api\/media\/(.+)$/)
    if (mediaMatch) {
      const filename = decodeURIComponent(mediaMatch[1])
      // Reject path traversal attempts (../ or absolute paths)
      if (filename.includes('..') || filename.startsWith('/') || filename.startsWith('\\')) {
        res.writeHead(400)
        res.end('bad request')
        return
      }
      // Search in uploads first, then generated
      const dirs = [paths.uploadsDir, paths.generatedDir]
      let found: string | null = null
      let mediaStat: ReturnType<typeof statSync> | null = null
      for (const dir of dirs) {
        const candidate = resolve(dir, filename)
        // Security: ensure resolved path stays inside the allowed directory
        if (!candidate.startsWith(resolve(dir))) continue
        try {
          const s = statSync(candidate)
          if (s.isFile()) {
            found = candidate
            mediaStat = s
            break
          }
        } catch {}
      }
      if (!found || !mediaStat) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      res.writeHead(200, {
        'Content-Type': mimeFor(found),
        'Content-Length': mediaStat.size,
        'Cache-Control': 'public, max-age=86400',
      })
      createReadStream(found).pipe(res)
      return
    }

    // ── File serving by absolute path (whitelist-restricted) ──
    if (url.pathname === '/api/file') {
      const filePath = url.searchParams.get('path')
      if (!filePath) {
        res.writeHead(400)
        res.end('missing ?path=')
        return
      }
      // Accept both POSIX (/path) and Windows (C:\path) absolute paths
      const isAbsolute = filePath.startsWith('/') || /^[A-Za-z]:[\\\/]/.test(filePath)
      if (filePath.includes('..') || !isAbsolute) {
        res.writeHead(400)
        res.end('bad path')
        return
      }
      // Security: allowlist directories first, then blocklist as secondary defense.
      const resolved = resolve(filePath)
      const agentCwds = this.deps.agentsConfig.agents
        .map((a) => a.cwd)
        .filter((c): c is string => !!c)
      if (!isFileAllowed(resolved, agentCwds)) {
        console.warn(`[api/file] denied (not in allowlist): ${resolved}`)
        res.writeHead(403)
        res.end('access denied')
        return
      }
      if (isFileBlocked(resolved)) {
        console.warn(`[api/file] blocked sensitive: ${resolved}`)
        res.writeHead(403)
        res.end('access denied')
        return
      }
      let fileStat: ReturnType<typeof statSync>
      try {
        fileStat = statSync(resolved)
      } catch {
        res.writeHead(404)
        res.end('not found')
        return
      }
      if (!fileStat.isFile()) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      res.writeHead(200, {
        'Content-Type': mimeFor(resolved),
        'Content-Length': fileStat.size,
        'Cache-Control': 'public, max-age=3600',
        'Content-Disposition': `inline; filename="${encodeURIComponent(basename(resolved) || 'file')}"`,
      })
      createReadStream(resolved).pipe(res)
      return
    }

    // 静态 web UI (with in-memory cache)
    if (this.deps.webRoot) {
      const safePath = url.pathname === '/' ? '/index.html' : url.pathname
      const filePath = resolve(this.deps.webRoot, `.${safePath}`)
      if (filePath.startsWith(resolve(this.deps.webRoot))) {
        const cached = this._staticFileCache.get(filePath)
        if (cached) {
          res.writeHead(200, { 'Content-Type': cached.mime })
          res.end(cached.content)
          return
        }
        try {
          const s = statSync(filePath)
          if (s.isFile()) {
            const content = readFileSync(filePath)
            const mime = mimeFor(filePath)
            this._staticFileCache.set(filePath, { content, mime })
            res.writeHead(200, { 'Content-Type': mime })
            res.end(content)
            return
          }
        } catch {}
      }
      // SPA fallback — only for navigation requests (no file extension)
      // Static assets (.js/.css/.map/.min.js etc.) should 404, not serve index.html
      const hasExtension = /\.\w+$/.test(url.pathname)
      if (!hasExtension) {
        const indexPath = resolve(this.deps.webRoot, 'index.html')
        const cachedIndex = this._staticFileCache.get(indexPath)
        if (cachedIndex) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(cachedIndex.content)
          return
        }
        try {
          const s = statSync(indexPath)
          if (s.isFile()) {
            const content = readFileSync(indexPath)
            this._staticFileCache.set(indexPath, { content, mime: 'text/html' })
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end(content)
            return
          }
        } catch {}
      }
    }
    res.writeHead(404)
    res.end('not found')
  }

  private checkHttpAuth(req: IncomingMessage): boolean {
    // 1. Authorization: Bearer header (fetch API calls)
    const authHeader = req.headers.authorization?.replace(/^Bearer\s+/, '') ?? ''
    // 2. Sec-WebSocket-Protocol subprotocol (WebSocket)
    const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim())
    const protoToken =
      protocols.includes('bearer') && protocols.length >= 2 ? protocols[protocols.length - 1] : ''
    // 3. HttpOnly cookie (for img/audio/video/a elements that can't set headers)
    const cookies = (req.headers.cookie || '').split(';').reduce(
      (acc, c) => {
        const [k, ...v] = c.trim().split('=')
        if (k) acc[k] = v.join('=')
        return acc
      },
      {} as Record<string, string>,
    )
    const cookieToken = cookies.oc_session || ''
    const t = authHeader || protoToken || cookieToken
    return checkToken(t, this.deps.config.gateway.accessToken)
  }

  /** Check if the request arrived over HTTPS (direct TLS or behind a trusted reverse proxy like cloudflared) */
  private isHttps(req: IncomingMessage): boolean {
    return (
      (req.socket as any).encrypted === true ||
      req.headers['x-forwarded-proto'] === 'https'
    )
  }

  /** Set HttpOnly session cookie on response */
  private setSessionCookie(res: ServerResponse, req: IncomingMessage): void {
    const token = this.deps.config.gateway.accessToken
    const secure = this.isHttps(req) ? '; Secure' : ''
    res.setHeader(
      'Set-Cookie',
      `oc_session=${token}; HttpOnly; SameSite=Strict${secure}; Path=/api/; Max-Age=31536000`,
    )
  }

  private sendJson(res: ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  private sendError(res: ServerResponse, code: number, message: string): void {
    this.sendJson(res, code, { error: message })
  }
  private async readJsonBody<T = any>(req: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf-8')
    if (!raw) return {} as T
    try {
      return JSON.parse(raw) as T
    } catch {
      throw new Error('invalid json body')
    }
  }

  // GET /api/agents         → { agents, default }
  // POST /api/agents        → create { id, model?, persona? }
  private async handleAgentsCollection(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cfg = await readAgentsConfig()
    if (req.method === 'GET') {
      this.sendJson(res, 200, { agents: cfg.agents, default: cfg.default, routes: cfg.routes })
      return
    }
    if (req.method === 'POST') {
      const body = await this.readJsonBody<Partial<AgentDef>>(req)
      if (!body.id || !/^[a-zA-Z0-9_-]+$/.test(body.id)) {
        this.sendError(res, 400, 'invalid agent id (use only a-z 0-9 _ -)')
        return
      }
      if (cfg.agents.find((a) => a.id === body.id)) {
        this.sendError(res, 409, 'agent already exists')
        return
      }
      // Inherit provider/permissionMode/cwd from request or sensible defaults
      const defaultAgent = cfg.agents.find((a) => a.id === cfg.default)
      const agent: AgentDef = {
        id: body.id,
        model: body.model ?? this.deps.config.defaults.model,
        persona: paths.agentClaudeMd(body.id),
        permissionMode:
          body.permissionMode ??
          defaultAgent?.permissionMode ??
          this.deps.config.defaults.permissionMode,
        provider: body.provider ?? defaultAgent?.provider,
        cwd: body.cwd ?? defaultAgent?.cwd,
        toolsets: body.toolsets,
      }
      cfg.agents.push(agent)
      await writeAgentsConfig(cfg)
      this.deps.agentsConfig = cfg
      await mkdir(paths.agentSessionsDir(body.id), { recursive: true })
      // Seed an empty persona file if missing
      try {
        await writeFile(paths.agentClaudeMd(body.id), `# Agent: ${body.id}\n\n`, { flag: 'wx' })
      } catch {}
      // 热更新路由
      this.router.reload(cfg)
      this.sendJson(res, 201, { agent })
      return
    }
    this.sendError(res, 405, 'method not allowed')
  }

  // GET /api/agents/:id    → { agent }
  // PUT /api/agents/:id    → update model | persona
  // DELETE /api/agents/:id → remove (cannot remove default)
  private async handleAgentItem(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
  ): Promise<void> {
    const cfg = await readAgentsConfig()
    const idx = cfg.agents.findIndex((a) => a.id === id)
    if (idx < 0) return this.sendError(res, 404, 'agent not found')
    const agent = cfg.agents[idx]
    if (req.method === 'GET') {
      this.sendJson(res, 200, { agent })
      return
    }
    if (req.method === 'PUT') {
      const body = await this.readJsonBody<Partial<AgentDef>>(req)
      if (body.model !== undefined) agent.model = body.model
      if (body.persona !== undefined) agent.persona = body.persona
      if (body.cwd !== undefined) agent.cwd = body.cwd
      if (body.permissionMode !== undefined) agent.permissionMode = body.permissionMode
      if (body.displayName !== undefined) agent.displayName = body.displayName
      if (body.avatarEmoji !== undefined) agent.avatarEmoji = body.avatarEmoji
      if (body.greeting !== undefined) agent.greeting = body.greeting
      if (body.provider !== undefined) agent.provider = body.provider
      if (body.toolsets !== undefined) agent.toolsets = body.toolsets
      if (body.mcpServers !== undefined) agent.mcpServers = body.mcpServers
      cfg.agents[idx] = agent
      await writeAgentsConfig(cfg)
      this.deps.agentsConfig = cfg
      this.router.reload(cfg)
      this.sendJson(res, 200, { agent })
      return
    }
    if (req.method === 'DELETE') {
      if (cfg.default === id) {
        this.sendError(res, 400, 'cannot delete default agent')
        return
      }
      cfg.agents.splice(idx, 1)
      await writeAgentsConfig(cfg)
      this.deps.agentsConfig = cfg
      this.router.reload(cfg)
      this.sendJson(res, 200, { ok: true })
      return
    }
    this.sendError(res, 405, 'method not allowed')
  }

  // GET /api/agents/:id/persona  → { text }
  // PUT /api/agents/:id/persona  → { text }
  private async handlePersona(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
  ): Promise<void> {
    const cfg = await readAgentsConfig()
    const agent = cfg.agents.find((a) => a.id === id)
    if (!agent) return this.sendError(res, 404, 'agent not found')
    const personaPath = agent.persona ?? paths.agentClaudeMd(id)
    if (req.method === 'GET') {
      let text = ''
      try {
        text = await readFile(personaPath, 'utf-8')
      } catch {}
      this.sendJson(res, 200, { text, path: personaPath })
      return
    }
    if (req.method === 'PUT') {
      const body = await this.readJsonBody<{ text?: string }>(req)
      const text = typeof body.text === 'string' ? body.text : ''
      await mkdir(dirname(personaPath), { recursive: true })
      await writeFile(personaPath, text, { mode: 0o600 })
      this.sendJson(res, 200, { ok: true, path: personaPath })
      return
    }
    this.sendError(res, 405, 'method not allowed')
  }

  // GET /api/agents/:id/memory/memory   → { text, charCount, limit }
  // GET /api/agents/:id/memory/user     → { text, charCount, limit }
  // PUT same paths with body { text }   → overwrite the target
  private async handleMemory(
    req: IncomingMessage,
    res: ServerResponse,
    agentId: string,
    target: 'memory' | 'user',
  ): Promise<void> {
    const store = new MemoryStore(agentId)
    await store.load()
    if (req.method === 'GET') {
      this.sendJson(res, 200, {
        text: store.read(target),
        charCount: store.charCount(target),
        target,
      })
      return
    }
    if (req.method === 'PUT') {
      const body = await this.readJsonBody<{ text?: string }>(req)
      const r = await store.overwrite(target, body.text ?? '')
      if (!r.ok) return this.sendError(res, 400, r.error ?? 'save failed')
      this.sendJson(res, 200, { ok: true, charCount: store.charCount(target) })
      return
    }
    this.sendError(res, 405, 'method not allowed')
  }

  // GET /api/agents/:id/skills — list
  private async handleSkillsList(
    req: IncomingMessage,
    res: ServerResponse,
    agentId: string,
  ): Promise<void> {
    if (req.method !== 'GET') return this.sendError(res, 405, 'method not allowed')
    const store = new SkillStore(agentId)
    const list = await store.list()
    this.sendJson(res, 200, { skills: list })
  }

  // GET/PUT/DELETE /api/agents/:id/skills/:name
  private async handleSkillItem(
    req: IncomingMessage,
    res: ServerResponse,
    agentId: string,
    skillName: string,
  ): Promise<void> {
    const store = new SkillStore(agentId)
    if (req.method === 'GET') {
      const v = await store.view(skillName)
      if (!v || typeof v === 'string') return this.sendError(res, 404, 'skill not found')
      this.sendJson(res, 200, { skill: v })
      return
    }
    if (req.method === 'PUT') {
      const body = await this.readJsonBody<{
        description?: string
        body?: string
        tags?: string[]
      }>(req)
      const r = await store.save(
        { name: skillName, description: body.description ?? '', tags: body.tags },
        body.body ?? '',
      )
      if (!r.ok) return this.sendError(res, 400, r.error ?? 'save failed')
      this.sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'DELETE') {
      const r = await store.delete(skillName)
      if (!r.ok) return this.sendError(res, 404, r.error ?? 'delete failed')
      this.sendJson(res, 200, { ok: true })
      return
    }
    this.sendError(res, 405, 'method not allowed')
  }

  // GET /api/search?q=... → full-text search past sessions
  // ── Inter-agent messaging ──
  private async handleAgentMessage(
    req: IncomingMessage,
    res: ServerResponse,
    targetAgentId: string,
  ): Promise<void> {
    if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
    const body = await this.readBody(req)
    let parsed: any
    try {
      parsed = JSON.parse(body)
    } catch {
      return this.sendError(res, 400, 'invalid JSON')
    }
    const { message, sourceAgent } = parsed
    if (!message) return this.sendError(res, 400, 'message required')

    // Find target agent
    const cfg = await this._getAgentsConfig()
    const targetAgent = cfg.agents.find((a) => a.id === targetAgentId)
    if (!targetAgent) return this.sendError(res, 404, `agent "${targetAgentId}" not found`)

    const sessionKey = `agent:${targetAgentId}:inter:dm:${sourceAgent || 'system'}`
    console.log(`[inter-agent] ${sourceAgent} → ${targetAgentId}: "${message.slice(0, 60)}"`)

    // Create/reuse session for the target agent
    const session = await this.sessions.getOrCreate({
      sessionKey,
      agent: targetAgent,
      channel: 'inter-agent',
      peerId: sourceAgent || 'system',
      title: `[from ${sourceAgent}] ${message.slice(0, 30)}`,
    })

    // Submit message and collect output
    let output = ''
    await this.sessions.submit(
      session,
      `[来自 agent "${sourceAgent}" 的消息]\n\n${message}`,
      (e) => {
        if (e.kind === 'block' && e.block.kind === 'text') output += e.block.text
      },
    )

    // Push result to user's active channel
    const lastActive =
      this.lastActiveChannel.get('main') || this.lastActiveChannel.values().next().value
    if (lastActive && output.trim()) {
      const out = {
        type: 'outbound.message' as const,
        sessionKey: lastActive.sessionKey || `agent:${targetAgentId}:inter:dm:${sourceAgent}`,
        channel: 'webchat' as const,
        peer: { id: lastActive.peerId, kind: 'dm' as const },
        blocks: [
          { kind: 'text' as const, text: `📨 **${targetAgentId}** 回复:\n\n${output.trim()}` },
        ],
        isFinal: true,
      }
      const peerKey = `webchat:${lastActive.peerId}`
      const set = this.clientsByPeer.get(peerKey)
      if (set) {
        const data = JSON.stringify(out)
        for (const ws of set) {
          try {
            ws.send(data)
          } catch {}
        }
      }
    }

    this.sendJson(res, 200, { ok: true, agentId: targetAgentId, outputLength: output.length })
  }

  /** Active delegation count for recursion/concurrency limits */
  private _activeDelegations = 0
  private static MAX_CONCURRENT_DELEGATIONS = 5

  private async handleDelegateTask(
    req: IncomingMessage,
    res: ServerResponse,
    targetAgentId: string,
  ): Promise<void> {
    if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
    const body = await this.readBody(req)
    let parsed: any
    try {
      parsed = JSON.parse(body)
    } catch {
      return this.sendError(res, 400, 'invalid JSON')
    }
    const { goal, context, sourceAgent, toolsets } = parsed
    if (!goal) return this.sendError(res, 400, 'goal required')

    // Concurrency guard
    if (this._activeDelegations >= Gateway.MAX_CONCURRENT_DELEGATIONS) {
      return this.sendError(
        res,
        429,
        `too many concurrent delegations (max ${Gateway.MAX_CONCURRENT_DELEGATIONS})`,
      )
    }

    // Recursion guard: check delegation depth via header
    const depthHeader = req.headers['x-delegation-depth']
    const depth = depthHeader ? Number.parseInt(String(depthHeader), 10) : 0
    if (depth >= 3) {
      return this.sendError(res, 400, 'delegation depth limit exceeded (max 3)')
    }

    // Find target agent
    const cfg = await this._getAgentsConfig()
    const targetAgent = cfg.agents.find((a) => a.id === targetAgentId)
    if (!targetAgent) return this.sendError(res, 404, `agent "${targetAgentId}" not found`)

    // Apply toolset restriction if specified
    const delegatedAgent = toolsets ? { ...targetAgent, toolsets } : targetAgent

    const sessionKey = `agent:${targetAgentId}:delegate:${sourceAgent || 'system'}:${Date.now()}`
    console.log(
      `[delegate] ${sourceAgent} → ${targetAgentId}: "${goal.slice(0, 60)}" (depth=${depth})`,
    )

    const session = await this.sessions.getOrCreate({
      sessionKey,
      agent: delegatedAgent,
      channel: 'delegate',
      peerId: sourceAgent || 'system',
      title: `[delegate] ${goal.slice(0, 40)}`,
      delegationDepth: depth + 1,
    })

    // Build prompt with context
    const prompt = context
      ? `[委派任务]\n\n目标: ${goal}\n\n上下文:\n${context}\n\n请完成上述任务并返回结果摘要。`
      : `[委派任务]\n\n目标: ${goal}\n\n请完成上述任务并返回结果摘要。`

    this._activeDelegations++
    const _dlgRun = this._runLog.start({ agentId: targetAgentId, sessionKey, taskType: 'delegate' })
    let output = ''
    let error = ''
    try {
      await this.sessions.submit(session, prompt, (e) => {
        if (e.kind === 'block' && e.block.kind === 'text') output += e.block.text
        if (e.kind === 'error') error = e.error
      })
      this._runLog.complete(_dlgRun, {
        status: error ? 'failed' : 'completed',
        error: error || undefined,
      })
    } catch (err: any) {
      error = error || String(err)
      this._runLog.complete(_dlgRun, { status: 'failed', error })
    } finally {
      this._activeDelegations--
    }

    eventBus.emit('agent.completed', {
      type: 'agent.completed',
      agentId: targetAgentId,
      sessionKey,
      output: output.trim(),
      error: error || undefined,
    })

    this.sendJson(res, 200, {
      ok: !error,
      agentId: targetAgentId,
      output: output.trim(),
      error: error || undefined,
    })
  }

  private async _handleWebhook(
    req: IncomingMessage,
    res: ServerResponse,
    whId: string,
  ): Promise<void> {
    if (req.method === 'POST') {
      const wh = this.webhookRouter?.find(whId)
      if (!wh) {
        this.sendError(res, 404, 'webhook not found')
        return
      }
      const body = await this.readBody(req)
      const sig = (req.headers['x-hub-signature-256'] || req.headers['x-signature'] || '') as string
      const result = await this.webhookRouter!.process(wh, body, sig)
      this.sendJson(res, result.ok ? 200 : 403, result)
      return
    }
    if (req.method === 'DELETE') {
      const removed = await this.webhookRouter?.remove(whId)
      this.sendJson(res, removed ? 200 : 404, { ok: !!removed })
      return
    }
    this.sendError(res, 405, 'method not allowed')
  }

  private async _handleTasksApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') {
      const tasks = await this._taskStore.list()
      this.sendJson(res, 200, { tasks })
      return
    }
    if (req.method === 'POST') {
      const body = await this.readBody(req)
      let parsed: any
      try {
        parsed = JSON.parse(body)
      } catch {
        return this.sendError(res, 400, 'invalid JSON')
      }
      const { id, title, agent, prompt, trigger, schedule, webhookId, eventType, maxRuns } = parsed
      if (!title || !prompt) return this.sendError(res, 400, 'title and prompt required')
      const task = await this._taskStore.create({
        id: id || `task-${Date.now().toString(36)}`,
        title,
        agent: agent || 'main',
        prompt,
        trigger: trigger || 'manual',
        schedule,
        webhookId,
        eventType,
        maxRuns,
      })
      this._invalidateTaskCache()
      this.sendJson(res, 201, { ok: true, task })
      return
    }
    this.sendError(res, 405, 'method not allowed')
  }

  private async _handleTaskItem(
    req: IncomingMessage,
    res: ServerResponse,
    taskId: string,
  ): Promise<void> {
    if (req.method === 'GET') {
      const task = await this._taskStore.get(taskId)
      if (!task) return this.sendError(res, 404, 'task not found')
      this.sendJson(res, 200, { task })
      return
    }
    if (req.method === 'PUT') {
      const body = await this.readBody(req)
      let parsed: any
      try {
        parsed = JSON.parse(body)
      } catch {
        return this.sendError(res, 400, 'invalid JSON')
      }
      const ok = await this._taskStore.update(taskId, parsed)
      if (ok) this._invalidateTaskCache()
      this.sendJson(res, ok ? 200 : 404, { ok })
      return
    }
    if (req.method === 'DELETE') {
      const ok = await this._taskStore.remove(taskId)
      if (ok) this._invalidateTaskCache()
      this.sendJson(res, ok ? 200 : 404, { ok })
      return
    }
    // POST → manually trigger the task (uses shared _triggerTask with RunLog)
    if (req.method === 'POST') {
      const task = await this._taskStore.get(taskId)
      if (!task) return this.sendError(res, 404, 'task not found')
      if (task.status === 'disabled')
        return this.sendError(res, 409, 'task is disabled (maxRuns reached)')
      this._triggerTask(taskId).catch((err) =>
        console.error(`[task] ${taskId} manual trigger failed:`, err),
      )
      this.sendJson(res, 202, { ok: true, message: 'task triggered' })
      return
    }
    this.sendError(res, 405, 'method not allowed')
  }

  /** Check schedule-triggered tasks and fire if cron matches */
  private async _tickScheduledTasks(): Promise<void> {
    const tasks = await this._taskStore.list()
    const now = new Date()
    for (const t of tasks) {
      if (t.trigger !== 'schedule' || !t.schedule || t.status === 'disabled') continue
      // Simple minute-level dedup: skip if ran in this minute
      const minuteKey = Math.floor(now.getTime() / 60_000)
      if (t.lastRunAt && Math.floor(t.lastRunAt / 60_000) === minuteKey) continue
      // Import cronMatches from cron.ts is complex — use a simple check
      // Delegate to CronScheduler's cronMatches by re-importing
      try {
        const { cronMatches } = await import('./cron.js')
        if (cronMatches(t.schedule, now)) {
          this._triggerTask(t.id).catch(() => {})
        }
      } catch {}
    }
  }

  /** Trigger a task by ID (shared by schedule tick, webhook, and manual API) */
  private async _triggerTask(taskId: string): Promise<void> {
    const task = await this._taskStore.get(taskId)
    if (!task || task.status === 'disabled') return
    const cfg = await this._getAgentsConfig()
    const agent = cfg.agents.find((a) => a.id === task.agent)
    if (!agent) return
    const sessionKey = `agent:${task.agent}:task:${taskId}:${Date.now()}`
    const session = await this.sessions.getOrCreate({
      sessionKey,
      agent,
      channel: 'task',
      peerId: taskId,
      title: `[task] ${task.title}`,
    })
    const runEntry = this._runLog.start({ agentId: task.agent, sessionKey, taskType: 'task' })
    let output = ''
    let error = ''
    try {
      await this.sessions.submit(session, task.prompt, (e) => {
        if (e.kind === 'block' && e.block.kind === 'text') output += (e.block as any).text
        if (e.kind === 'error') error = e.error
      })
    } catch (err: any) {
      error = String(err)
    }
    this._runLog.complete(runEntry, {
      status: error ? 'failed' : 'completed',
      error: error || undefined,
    })
    await this._taskStore.recordExecution({
      taskId,
      startedAt: runEntry.startedAt,
      completedAt: Date.now(),
      status: error ? 'failed' : 'completed',
      output: output.slice(0, 2000),
      error: error || undefined,
    })
  }

  private async handleSearch(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== 'GET') return this.sendError(res, 405, 'method not allowed')
    const q = url.searchParams.get('q') ?? ''
    const limit = Number(url.searchParams.get('limit') ?? '10')
    if (!q.trim()) {
      this.sendJson(res, 200, { hits: [] })
      return
    }
    try {
      const hits = await searchSessions(q, limit)
      this.sendJson(res, 200, { hits })
    } catch (err) {
      this.sendError(res, 500, String(err))
    }
  }

  // ── Cron/Reminder API handlers ──
  private async handleCronApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.cron) return this.sendError(res, 503, 'cron not initialized')
    if (req.method === 'GET') {
      const jobs = await this.cron.listJobsWithMeta()
      this.sendJson(res, 200, { jobs })
      return
    }
    if (req.method === 'POST') {
      const body = await this.readBody(req)
      let parsed: any
      try {
        parsed = JSON.parse(body)
      } catch {
        return this.sendError(res, 400, 'invalid JSON')
      }
      const { schedule, prompt, deliver, oneshot, label, agent } = parsed
      if (!schedule || !prompt) return this.sendError(res, 400, 'schedule and prompt required')
      const id = `remind-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const job = {
        id,
        schedule,
        agent: agent || 'main',
        prompt,
        deliver: deliver || 'webchat',
        enabled: true,
        oneshot: oneshot ?? true,
        label: label || prompt.slice(0, 50),
      }
      await this.cron.addJob(job)
      this.sendJson(res, 201, { ok: true, job })
      return
    }
    this.sendError(res, 405, 'method not allowed')
  }

  private async handleCronItem(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
  ): Promise<void> {
    if (!this.cron) return this.sendError(res, 503, 'cron not initialized')
    if (req.method === 'DELETE') {
      const removed = await this.cron.removeJob(id)
      this.sendJson(res, removed ? 200 : 404, { ok: removed })
      return
    }
    if (req.method === 'PUT') {
      const body = await this.readBody(req)
      let parsed: any
      try {
        parsed = JSON.parse(body)
      } catch {
        return this.sendError(res, 400, 'invalid JSON')
      }
      const updated = await this.cron.updateJob(id, parsed)
      this.sendJson(res, updated ? 200 : 404, { ok: updated })
      return
    }
    this.sendError(res, 405, 'method not allowed')
  }

  // ── Claude.ai OAuth PKCE Flow ──
  private oauthPending = new Map<
    string,
    { codeVerifier: string; createdAt: number; provider: string }
  >()

  // Multi-provider OAuth configs
  private readonly OAUTH_PROVIDERS: Record<
    string,
    {
      clientId: string
      authUrl: string
      tokenUrl: string
      redirect: string
      scopes: string
      extraParams?: Record<string, string>
    }
  > = {
    claude: {
      clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      authUrl: 'https://claude.com/cai/oauth/authorize',
      tokenUrl: 'https://platform.claude.com/v1/oauth/token',
      redirect: 'https://platform.claude.com/oauth/code/callback',
      scopes: 'user:profile user:inference user:sessions:claude_code user:mcp_servers',
    },
    codex: {
      clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
      authUrl: 'https://auth.openai.com/oauth/authorize',
      tokenUrl: 'https://auth.openai.com/oauth/token',
      redirect: 'http://localhost:1455/auth/callback',
      scopes: 'openid profile email offline_access',
      extraParams: {
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
        originator: 'codex_vscode',
      },
    },
  }

  private async handleOAuthStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
    const body = await this.readBody(req)
    const { provider: oauthProvider } = JSON.parse(body || '{}')
    const providerKey = oauthProvider || 'claude'
    const prov = this.OAUTH_PROVIDERS[providerKey]
    if (!prov) return this.sendError(res, 400, `unknown oauth provider: ${providerKey}`)

    const codeVerifier = randomBytes(32).toString('base64url')
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
    const state = randomBytes(16).toString('hex')

    // Limit pending states to prevent abuse
    if (this.oauthPending.size >= 50) {
      const oldest = this.oauthPending.keys().next().value
      if (oldest) this.oauthPending.delete(oldest)
    }
    this.oauthPending.set(state, { codeVerifier, createdAt: Date.now(), provider: providerKey })
    setTimeout(() => this.oauthPending.delete(state), 10 * 60_000)

    const params = new URLSearchParams({
      client_id: prov.clientId,
      redirect_uri: prov.redirect,
      response_type: 'code',
      scope: prov.scopes,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      ...(prov.extraParams ?? {}),
    })

    this.sendJson(res, 200, {
      authUrl: `${prov.authUrl}?${params}`,
      state,
      provider: providerKey,
    })
  }

  private async handleOAuthCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
    const body = await this.readBody(req)
    let parsed: any
    try {
      parsed = JSON.parse(body)
    } catch {
      return this.sendError(res, 400, 'invalid JSON')
    }
    const { code, state } = parsed
    if (!code || !state) return this.sendError(res, 400, 'code and state required')
    const cleanCode = code.includes('#') ? code.split('#')[0] : code

    const pending = this.oauthPending.get(state)
    if (!pending) return this.sendError(res, 400, 'invalid or expired state')
    this.oauthPending.delete(state)
    const providerKey = (pending as any).provider || 'claude'
    const prov = this.OAUTH_PROVIDERS[providerKey]
    if (!prov) return this.sendError(res, 400, 'unknown provider')
    console.log(`[oauth:${providerKey}] exchanging code (len=${cleanCode.length})...`)

    try {
      const tokenRes = await fetch(prov.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: prov.clientId,
          code: cleanCode,
          code_verifier: pending.codeVerifier,
          redirect_uri: prov.redirect,
          ...(providerKey === 'claude' ? { state } : {}),
        }),
      })

      if (!tokenRes.ok) {
        const errText = await tokenRes.text()
        console.error('[oauth] token exchange failed:', tokenRes.status, errText)
        return this.sendError(res, 502, `token exchange failed: ${tokenRes.status}`)
      }

      const tokens = (await tokenRes.json()) as {
        access_token: string
        refresh_token?: string
        expires_in?: number
        scope?: string
        token_type?: string
      }

      // Save to config (keyed by provider)
      const config = await readConfig()
      if (config) {
        const oauthData = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? '',
          expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
          scope: tokens.scope ?? prov.scopes,
        }
        if (providerKey === 'claude') {
          config.auth.claudeOAuth = oauthData
          config.auth.mode = 'subscription'
        } else if (providerKey === 'codex') {
          config.auth.codexOAuth = oauthData
        }
        await writeConfig(config)
        this.deps.config = config
        this.sessions.updateConfig(config)
        console.log(`[oauth:${providerKey}] tokens saved`)
      }

      this.sendJson(res, 200, {
        ok: true,
        expiresIn: tokens.expires_in,
        scope: tokens.scope,
      })
    } catch (err: any) {
      console.error('[oauth] exchange error:', err)
      this.sendError(res, 500, err?.message ?? 'token exchange failed')
    }
  }

  // Token auto-refresh (called periodically)
  private async refreshClaudeOAuthIfNeeded(): Promise<void> {
    // Try refreshing Claude OAuth
    const claudeOAuth = this.deps.config.auth.claudeOAuth
    if (claudeOAuth?.refreshToken && Date.now() >= claudeOAuth.expiresAt - 5 * 60_000) {
      await this._refreshToken('claude', claudeOAuth)
    }
    // Try refreshing Codex OAuth
    const codexOAuth = this.deps.config.auth.codexOAuth
    if (codexOAuth?.refreshToken && Date.now() >= codexOAuth.expiresAt - 5 * 60_000) {
      await this._refreshToken('codex', codexOAuth)
    }
  }

  private async _refreshToken(
    providerKey: string,
    oauth: { refreshToken: string; scope: string; expiresAt: number },
  ): Promise<void> {
    const prov = this.OAUTH_PROVIDERS[providerKey]
    if (!prov || !prov.tokenUrl) {
      if (!prov) console.warn(`[oauth:${providerKey}] skipping refresh: unknown provider`)
      else console.warn(`[oauth:${providerKey}] skipping refresh: no tokenUrl configured`)
      return
    }

    try {
      const tokenRes = await fetch(prov.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: prov.clientId,
          refresh_token: oauth.refreshToken,
          ...(providerKey === 'claude' ? { scope: prov.scopes } : {}),
        }),
      })

      if (!tokenRes.ok) {
        console.error(`[oauth:${providerKey}] refresh failed:`, tokenRes.status)
        return
      }

      const tokens = (await tokenRes.json()) as any
      const config = await readConfig()
      if (config) {
        const refreshed = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? oauth.refreshToken,
          expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
          scope: tokens.scope ?? oauth.scope,
        }
        if (providerKey === 'claude') config.auth.claudeOAuth = refreshed
        else (config.auth as any)[`${providerKey}OAuth`] = refreshed
        await writeConfig(config)
        this.deps.config = config
        this.sessions.updateConfig(config)
        console.log(`[oauth:${providerKey}] token refreshed, expires in`, tokens.expires_in, 's')
      }
    } catch (err) {
      console.error(`[oauth:${providerKey}] refresh error:`, err)
    }
  }

  private readBody(req: IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > maxBytes) {
          req.destroy()
          reject(new Error('body too large'))
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString()))
      req.on('error', reject)
    })
  }

  // Broadcast a permission_request to every connected WS client (and every
  // adapter that supports it — telegram in the future).
  private wsClients = new Set<WebSocket>()

  private broadcastPermissionRequest(req: PermissionRequest): void {
    const out: OutboundMessage = {
      type: 'outbound.message',
      sessionKey: req.sessionKey || `agent:${req.agentId}:permission:dm:${req.reqId}`,
      channel: 'permission',
      peer: { id: '__permission__', kind: 'dm' },
      blocks: [
        {
          kind: 'text',
          text: `🔒 agent 想执行一个高风险操作:\n\n工具: ${req.toolName}\n规则: ${req.reason}\n\n${req.summary}`,
        },
      ],
      isFinal: true,
      permissionRequest: {
        id: req.reqId,
        tool: req.toolName,
        reason: req.reason,
        detail: req.detail,
        summary: req.summary,
        toolInput: req.toolInput,
        options: ['allow', 'deny'],
      },
    }
    const data = JSON.stringify(out)
    for (const ws of this.wsClients) {
      try {
        ws.send(data)
      } catch {}
    }
  }

  // ───────── WS ─────────
  private handleWsConnection(ws: WebSocket, req: IncomingMessage): void {
    if (!this.checkHttpAuth(req)) {
      ws.close(1008, 'unauthorized')
      return
    }
    // Keepalive pong tracking
    ;(ws as any)._isAlive = true
    ws.on('pong', () => {
      ;(ws as any)._isAlive = true
    })

    this.wsClients.add(ws)
    ws.once('close', () => this.wsClients.delete(ws))
    // When a new client connects, replay any currently-pending permission requests
    if (this.permissions) {
      for (const req of this.permissions.getPending()) {
        this.broadcastPermissionRequest(req)
      }
    }
    ws.on('message', async (raw) => {
      try {
      let frame: InboundFrame
      try {
        frame = JSON.parse(raw.toString()) as InboundFrame
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'invalid json' }))
        return
      }
      // Permission response from the frontend
      if (frame.type === 'inbound.permission_response') {
        if (!this.permissions) return
        const decision = frame.decision
        const mapped =
          decision === 'allow_always' ? 'allow_always' : decision === 'allow' ? 'allow' : 'deny'
        const ok = await this.permissions.respond(frame.requestId, mapped as any)
        console.log(`[permission-relay] response ${frame.requestId} → ${mapped} (ok=${ok})`)
        return
      }
      // Client-side keepalive ping — just ignore
      if ((frame as any).type === 'ping') return

      // Hello frame: client identifies its sessions so we can auto-resume.
      // We register the WS into clientsByPeer only for peers that have an
      // active session in the session manager (validated server-side).
      if ((frame as any).type === 'inbound.hello') {
        const hello = frame as any
        const peers: Array<{ peerId: string; agentId: string }> = hello.peers || []
        // Auto-resume: check if any peer has a resumable session that is NOT already active
        this.autoResumeFromHello(peers, ws).catch((err) =>
          console.error('[auto-resume] failed:', err),
        )
        return
      }

      if (frame.type === 'inbound.message') {
        // 把 ws client 关联到这个 (channel, peer)
        const peerKey = `${frame.channel}:${frame.peer.id}`
        let set = this.clientsByPeer.get(peerKey)
        if (!set) {
          set = new Set()
          this.clientsByPeer.set(peerKey, set)
        }
        if (!set.has(ws)) {
          set.add(ws)
          ws.once('close', () => {
            set?.delete(ws)
            if (set?.size === 0) {
              this.clientsByPeer.delete(peerKey)
            }
          })
        }
        await this.dispatchInbound(frame)
      } else if (frame.type === 'inbound.control.stop') {
        await this.handleStop(frame)
      } else if ((frame as any).type === 'inbound.control.reset') {
        // Reset: kill the CCB subprocess AND remove session from manager,
        // so next message creates an entirely fresh session with no history
        const f = frame as any
        const agentId =
          f.agentId ||
          this.router.route({
            type: 'inbound.message',
            idempotencyKey: '',
            channel: f.channel,
            peer: f.peer,
            content: { text: '' },
            ts: Date.now(),
          }).agent.id
        const sessionKey = `agent:${agentId}:${f.channel}:${f.peer.kind}:${f.peer.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
        await this.sessions.destroySession(sessionKey)
        console.log(
          `[reset] destroyed session ${sessionKey} — next message will create fresh context`,
        )
      } else if ((frame as any).type === 'control.session.compact') {
        // Compact: send a compaction request to the agent as a user message
        const sessionKey = (frame as any).sessionKey
        if (!sessionKey) return
        const session = this.sessions.getByKey(sessionKey)
        if (!session) {
          ws.send(JSON.stringify({ type: 'error', error: 'session not found' }))
          return
        }
        console.log(`[compact] compacting session ${sessionKey}`)
        try {
          await this.sessions.submit(
            session,
            '/compact — 请压缩当前对话上下文,保留关键信息,删除冗余细节。',
            (e) => {
              if (e.kind === 'block') {
                const out = {
                  type: 'outbound.message',
                  sessionKey,
                  channel: 'webchat',
                  peer: { id: sessionKey.split(':')[4] || '__compact__', kind: 'dm' },
                  blocks: [e.block],
                  isFinal: false,
                }
                ws.send(JSON.stringify(out))
              } else if (e.kind === 'final') {
                ws.send(
                  JSON.stringify({
                    type: 'outbound.message',
                    sessionKey,
                    channel: 'webchat',
                    peer: { id: '__compact__', kind: 'dm' },
                    blocks: [{ kind: 'text', text: '✅ 上下文压缩完成' }],
                    isFinal: true,
                    meta: e.meta,
                  }),
                )
              }
            },
          )
        } catch (err: any) {
          ws.send(JSON.stringify({ type: 'error', error: `compact failed: ${err?.message}` }))
        }
      }
      } catch (err: any) {
        console.error('[ws-message] unhandled error in message handler:', err)
        try {
          ws.send(JSON.stringify({ type: 'error', error: `internal error: ${err?.message}` }))
        } catch { /* ws may already be closed */ }
      }
    })
  }

  private async handleStop(frame: {
    type: 'inbound.control.stop'
    channel: string
    peer: { id: string; kind: 'dm' | 'group' }
    agentId?: string
    sessionKey?: string
  }): Promise<void> {
    let sessionKey = frame.sessionKey
    if (!sessionKey) {
      if (frame.agentId) {
        sessionKey = `agent:${frame.agentId}:${frame.channel}:${frame.peer.kind}:${frame.peer.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
      } else {
        const routed = this.router.route({
          type: 'inbound.message',
          idempotencyKey: '',
          channel: frame.channel,
          peer: frame.peer,
          content: {},
          ts: Date.now(),
        } as any)
        sessionKey = routed.sessionKey
      }
    }
    const ok = this.sessions.interrupt(sessionKey)
    console.log(`[gateway] interrupt ${sessionKey} → ${ok}`)
  }

  /** Pre-warm webchat sessions on boot so they respond instantly to the first user message */
  private async bootAutoResume(): Promise<void> {
    const resumableKeys = this.sessions.getResumableKeys((k) => k.includes(':webchat:'))
    if (resumableKeys.length === 0) return

    for (const sessionKey of resumableKeys) {
      if (this.sessions.getByKey(sessionKey)) continue

      const parts = sessionKey.split(':')
      const agentId = parts[1]
      const peerId = parts.slice(4).join(':')

      console.log(`[auto-resume] pre-warming ${sessionKey}`)
      const cfg = await this._getAgentsConfig()
      const agent = cfg.agents.find((a) => a.id === agentId) ?? ({ id: agentId } as AgentDef)
      await this.sessions.getOrCreate({
        sessionKey,
        agent,
        channel: 'webchat',
        peerId,
      })
      this.lastActiveChannel.set(agentId, {
        channel: 'webchat',
        peerId,
        sessionKey,
        at: Date.now(),
      })
      console.log(`[auto-resume] pre-warmed ${sessionKey}`)
    }
  }

  private async autoResumeFromHello(
    peers: Array<{ peerId: string; agentId: string }>,
    ws: WebSocket,
  ): Promise<void> {
    // Register the reconnected WS client for each peer that has an active/resumable session.
    // Security note: the same trust model applies as inbound.message — the gateway
    // access token is the auth boundary; we validate that a session actually exists
    // (active or in resume-map) before registering.
    const registeredPeerKeys: string[] = []

    for (const { peerId, agentId } of peers) {
      const aid = agentId || 'main'
      const safeId = peerId.replace(/[^a-zA-Z0-9_-]/g, '_')
      const sessionKey = `agent:${aid}:webchat:dm:${safeId}`

      // Check active session first
      let session = this.sessions.getByKey(sessionKey)

      // If not active yet, check resume-map and trigger pre-warm (handles boot race)
      if (!session) {
        const resumableKeys = this.sessions.getResumableKeys((k) => k === sessionKey)
        if (resumableKeys.length > 0) {
          try {
            const cfg = await this._getAgentsConfig()
            const agent = cfg.agents.find((a) => a.id === aid) ?? ({ id: aid } as any)
            session = await this.sessions.getOrCreate({
              sessionKey,
              agent,
              channel: 'webchat',
              peerId,
            })
            this.lastActiveChannel.set(aid, {
              channel: 'webchat',
              peerId,
              sessionKey,
              at: Date.now(),
            })
            console.log(`[auto-resume] on-demand pre-warmed ${sessionKey}`)
          } catch (err) {
            console.error(`[auto-resume] failed to pre-warm ${sessionKey}:`, err)
            continue
          }
        } else {
          continue // Not in resume-map either — skip
        }
      }

      const peerKey = `webchat:${peerId}`
      let set = this.clientsByPeer.get(peerKey)
      if (!set) {
        set = new Set()
        this.clientsByPeer.set(peerKey, set)
      }
      if (!set.has(ws)) {
        set.add(ws)
        registeredPeerKeys.push(peerKey)
      }
      console.log(`[auto-resume] re-registered WS for ${peerKey} (session ${sessionKey})`)
    }

    // Single close handler for all peers registered via this hello (avoids listener accumulation)
    if (registeredPeerKeys.length > 0) {
      ws.once('close', () => {
        for (const peerKey of registeredPeerKeys) {
          const set = this.clientsByPeer.get(peerKey)
          if (set) {
            set.delete(ws)
            if (set.size === 0) this.clientsByPeer.delete(peerKey)
          }
        }
      })
    }
  }

  private async dispatchInbound(frame: InboundFrame, adapter?: ChannelAdapter): Promise<void> {
    if (frame.type !== 'inbound.message') {
      // TODO: 权限响应处理
      return
    }

    // ── Idempotency dedup: skip already-processed messages (reconnect replay protection) ──
    if (frame.idempotencyKey && this._checkIdempotencyKey(frame.idempotencyKey)) {
      console.log(
        `[dispatchInbound] duplicate idempotencyKey "${frame.idempotencyKey}" — skipping`,
      )
      // Notify connected WS clients for this peer so the client knows the message was deduped
      const peerKey = `${frame.channel}:${frame.peer.id}`
      const clients = this.clientsByPeer.get(peerKey)
      if (clients) {
        const ack = JSON.stringify({
          type: 'outbound.ack',
          idempotencyKey: frame.idempotencyKey,
          deduplicated: true,
        })
        for (const ws of clients) {
          try {
            ws.send(ack)
          } catch {}
        }
      }
      return
    }

    // Explicit agentId override (web UI per-session selection)
    let sessionKey: string
    let agent: AgentDef
    if (frame.agentId) {
      const cfg = await this._getAgentsConfig()
      const ag = cfg.agents.find((a) => a.id === frame.agentId) ?? { id: frame.agentId }
      agent = ag
      // Include agentId in sessionKey so different agents get isolated subprocesses
      sessionKey = `agent:${frame.agentId}:${frame.channel}:${frame.peer.kind}:${frame.peer.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
    } else {
      const routed = this.router.route(frame)
      sessionKey = routed.sessionKey
      agent = routed.agent
    }
    // Track last active channel for proactive push
    this.lastActiveChannel.set(agent.id, {
      channel: frame.channel,
      peerId: frame.peer.id,
      sessionKey,
      at: Date.now(),
    })

    const session = await this.sessions.getOrCreate({
      sessionKey,
      agent,
      channel: frame.channel,
      peerId: frame.peer.id,
      title: (frame.content.text ?? '').slice(0, 50).trim() || undefined,
    })
    const out: OutboundMessage = {
      type: 'outbound.message',
      sessionKey,
      channel: frame.channel,
      peer: frame.peer,
      blocks: [],
      isFinal: false,
    }
    // Adapters (Telegram/WeChat/Feishu) can't take 30 small messages per second.
    // Accumulate all blocks and send a single message at final.
    // WebChat (no adapter) keeps streaming via WS broadcast.
    const aggregatedBlocks: typeof out.blocks = []

    // ── Multimodal handling ──
    // Save all uploaded media to local disk and inject descriptive prompt hints
    // so the agent knows how to access them via MCP tools or Read.
    const text = frame.content.text ?? ''
    const media = frame.content.media ?? []

    // Server-side upload validation
    const MAX_SINGLE_FILE = 25 * 1024 * 1024 // 25MB
    const MAX_TOTAL_MEDIA = 50 * 1024 * 1024 // 50MB total
    const ALLOWED_MIME_PREFIXES = ['image/', 'audio/', 'video/', 'application/pdf', 'text/']
    let totalMediaSize = 0
    for (const m of media) {
      if (!m.base64) continue
      const rawLen = m.base64.length
      const byteLen = Math.ceil(rawLen * 0.75) // base64 → bytes approx
      if (byteLen > MAX_SINGLE_FILE) {
        const errMsg = `附件超过 ${MAX_SINGLE_FILE / 1024 / 1024}MB 限制 (${(byteLen / 1024 / 1024).toFixed(1)}MB)`
        console.warn(`[upload] rejected: ${errMsg}`)
        this.deliver(
          {
            type: 'outbound.message',
            sessionKey: sessionKey!,
            channel: frame.channel,
            peer: frame.peer,
            blocks: [{ kind: 'text', text: `⚠️ 上传失败: ${errMsg}` }],
            isFinal: true,
          },
          adapter,
        )
        return
      }
      totalMediaSize += byteLen
      if (totalMediaSize > MAX_TOTAL_MEDIA) {
        const errMsg = `总附件超过 ${MAX_TOTAL_MEDIA / 1024 / 1024}MB 限制`
        console.warn(`[upload] rejected: ${errMsg}`)
        this.deliver(
          {
            type: 'outbound.message',
            sessionKey: sessionKey!,
            channel: frame.channel,
            peer: frame.peer,
            blocks: [{ kind: 'text', text: `⚠️ 上传失败: ${errMsg}` }],
            isFinal: true,
          },
          adapter,
        )
        return
      }
      const mime = m.mimeType || ''
      if (
        mime &&
        !ALLOWED_MIME_PREFIXES.some((p) => mime.startsWith(p)) &&
        mime !== 'application/octet-stream'
      ) {
        const errMsg = `不支持的文件类型: ${mime}`
        console.warn(`[upload] rejected: disallowed MIME ${mime}`)
        this.deliver(
          {
            type: 'outbound.message',
            sessionKey: sessionKey!,
            channel: frame.channel,
            peer: frame.peer,
            blocks: [{ kind: 'text', text: `⚠️ 上传失败: ${errMsg}` }],
            isFinal: true,
          },
          adapter,
        )
        return
      }
    }

    // MIME → extension lookup (expanded to cover all media types)
    const mimeToExt: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/bmp': 'bmp',
      'image/svg+xml': 'svg',
      'audio/mpeg': 'mp3',
      'audio/wav': 'wav',
      'audio/ogg': 'ogg',
      'audio/aac': 'aac',
      'audio/flac': 'flac',
      'audio/mp4': 'm4a',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/quicktime': 'mov',
      'application/pdf': 'pdf',
      'application/msword': 'doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.ms-excel': 'xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    }

    type SavedMedia = {
      kind: string
      path: string
      name: string
      mimeType: string
      sizeHint: string
    }
    const savedMedia: SavedMedia[] = []
    for (const m of media) {
      let base64 = m.base64 ?? ''
      if (!base64 && m.url) continue // external URL — don't save, just reference
      const prefixMatch = base64.match(/^data:([^;]+);base64,(.*)$/)
      const mimeType = prefixMatch ? prefixMatch[1] : (m.mimeType ?? 'application/octet-stream')
      if (prefixMatch) base64 = prefixMatch[2]
      const ext =
        mimeToExt[mimeType] ?? mimeType.split('/')[1]?.replace(/[^a-zA-Z0-9]/g, '') ?? 'bin'
      const defaultName =
        m.kind === 'image'
          ? 'image'
          : m.kind === 'audio'
            ? 'audio'
            : m.kind === 'video'
              ? 'video'
              : 'file'
      const safeBase = (m.filename ?? defaultName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40)
      const fname = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeBase}.${ext}`
      const fpath = join(paths.uploadsDir, fname)
      try {
        await mkdir(paths.uploadsDir, { recursive: true })
        await writeFile(fpath, Buffer.from(base64, 'base64'))
        const sizeKb = (Buffer.byteLength(base64, 'base64') / 1024).toFixed(1)
        savedMedia.push({
          kind: m.kind,
          path: fpath,
          name: m.filename ?? fname,
          mimeType,
          sizeHint: `${sizeKb}KB`,
        })
      } catch (err) {
        console.warn(`[dispatchInbound] failed to save uploaded ${m.kind}:`, err)
      }
    }

    let finalText = text
    if (savedMedia.length > 0) {
      const activeProvider = this.deps.config.provider
      const activeMcpTools: string[] = []
      for (const srv of this.deps.config.mcpServers ?? []) {
        if (srv.enabled === false) continue
        if (srv.provider && srv.provider !== activeProvider) continue
        if (srv.tools) activeMcpTools.push(...srv.tools)
      }
      const hasUnderstandImage = activeMcpTools.includes('understand_image')

      const images = savedMedia.filter((m) => m.kind === 'image')
      const audios = savedMedia.filter((m) => m.kind === 'audio')
      const videos = savedMedia.filter((m) => m.kind === 'video')
      const files = savedMedia.filter((m) => m.kind === 'file')

      const lines = [text]

      if (images.length > 0) {
        lines.push('', '---', '用户附带了以下图片(已保存到服务器本地):')
        for (const ip of images) {
          lines.push(`- \`${ip.path}\` (${ip.mimeType}, ${ip.sizeHint}, 原名: ${ip.name})`)
        }
        lines.push('')
        lines.push('如果需要看图片内容,按以下顺序尝试:')
        let step = 1
        if (hasUnderstandImage) {
          lines.push(
            `${step}. 优先调用 \`understand_image\` MCP 工具,传图片的**本地文件路径**作为 \`image_source\` 参数。`,
          )
          step++
        }
        lines.push(`${step}. 用 Read 工具读图片路径(原生多模态 provider 会直接看到图像)。`)
        step++
        lines.push(`${step}. 如果都不可用,告诉用户当前 provider 不支持图片识别。`)
      }

      if (audios.length > 0) {
        lines.push('', '---', '用户附带了以下音频文件(已保存到服务器本地):')
        for (const a of audios) {
          lines.push(`- \`${a.path}\` (${a.mimeType}, ${a.sizeHint}, 原名: ${a.name})`)
        }
        lines.push(
          '',
          '如果有 STT (语音转文字) 工具可用,请帮用户转录音频内容;否则告知用户音频文件已保存。',
        )
      }

      if (videos.length > 0) {
        lines.push('', '---', '用户附带了以下视频文件(已保存到服务器本地):')
        for (const v of videos) {
          lines.push(`- \`${v.path}\` (${v.mimeType}, ${v.sizeHint}, 原名: ${v.name})`)
        }
        lines.push('', '当前没有视频理解工具。告知用户视频文件已保存,路径如上。')
      }

      if (files.length > 0) {
        lines.push('', '---', '用户附带了以下文档(已保存到服务器本地):')
        for (const f of files) {
          lines.push(`- \`${f.path}\` (${f.mimeType}, ${f.sizeHint}, 原名: ${f.name})`)
        }
        lines.push('', '可以用 Read 工具读取文档内容(对 PDF、纯文本等有效)。')
      }

      finalText = lines.join('\n')
    }
    // Pass as plain text. No image content blocks — safer for non-multimodal providers.
    const payload: string = finalText
    const taskType = sessionKey.includes(':cron:')
      ? ('cron' as const)
      : sessionKey.includes(':delegate:')
        ? ('delegate' as const)
        : sessionKey.includes(':inter:')
          ? ('inter-agent' as const)
          : ('chat' as const)
    const _run = this._runLog.start({ agentId: session.agentId, sessionKey, taskType })
    await this.sessions.submit(session, payload, (e) => {
      if (e.kind === 'block') {
        if (adapter) {
          // For partial tool_use blocks, replace any prior block with same blockId
          const b = e.block as any
          if (b.blockId) {
            const idx = aggregatedBlocks.findIndex((x: any) => x.blockId === b.blockId)
            if (idx >= 0) aggregatedBlocks[idx] = e.block
            else aggregatedBlocks.push(e.block)
          } else {
            aggregatedBlocks.push(e.block)
          }
        } else {
          // WebChat: stream each block immediately via WS
          out.blocks.push(e.block)
          this.deliver({ ...out, blocks: [e.block], isFinal: false }, undefined)
        }
      } else if (e.kind === 'final') {
        this._runLog.complete(_run, {
          status: 'completed',
          cost: e.meta?.cost,
          inputTokens: e.meta?.inputTokens,
          outputTokens: e.meta?.outputTokens,
          turn: e.meta?.turn,
        })
        if (adapter) {
          this.deliver({ ...out, blocks: aggregatedBlocks, isFinal: true, meta: e.meta }, adapter)
        } else {
          this.deliver({ ...out, blocks: [], isFinal: true, meta: e.meta }, undefined)
        }
      } else if (e.kind === 'error') {
        this._runLog.complete(_run, { status: 'failed', error: e.error })
        this.deliver(
          {
            ...out,
            blocks: [{ kind: 'text', text: `[error] ${e.error}` }],
            isFinal: true,
          },
          adapter,
        )
      }
    })
  }

  private deliver(out: OutboundMessage, adapter?: ChannelAdapter): void {
    if (adapter) {
      adapter.send(out).catch((err) => console.error('[gateway] adapter send failed:', err))
      return
    }
    // WebChat:广播给所有同 (channel, peer) 的 ws client
    const peerKey = `${out.channel}:${out.peer.id}`
    const set = this.clientsByPeer.get(peerKey)
    if (!set) return
    const data = JSON.stringify(out)
    for (const ws of set) {
      try {
        ws.send(data)
      } catch {}
    }
  }
}

// ── Exported security helpers (tested in security.test.ts) ──

/**
 * Allowlist of directory prefixes from which /api/file may serve files.
 * Static entries cover well-known locations; dynamic entries (agent cwds)
 * are checked separately via `isFileAllowed()`.
 */
export const FILE_ALLOWED_DIRS: string[] = [
  resolve(paths.generatedDir), // /root/.openclaude/generated/
  resolve(paths.uploadsDir), // /root/.openclaude/uploads/
]

/** Temp-file prefix pattern: /tmp/openclaude-* */
const TEMP_PREFIX = resolve('/tmp/openclaude-')

/** Known project roots that agents may work in */
const AGENT_CWD_ROOTS: string[] = [
  resolve('/opt/openclaude/openclaude'),
  resolve('/opt/openclaude/claude-code-best'),
]

/**
 * Returns true if the resolved absolute path falls within the allowlist.
 * Checked BEFORE the blocklist — if this returns false, the file is denied
 * regardless of blocklist status.
 */
export function isFileAllowed(resolvedPath: string, agentCwds?: string[]): boolean {
  // 1. Static allowed directories
  for (const dir of FILE_ALLOWED_DIRS) {
    if (resolvedPath.startsWith(dir + '/') || resolvedPath === dir) return true
  }
  // 2. Temp files matching /tmp/openclaude-*
  if (resolvedPath.startsWith(TEMP_PREFIX)) return true
  // 3. Known project roots
  for (const cwd of AGENT_CWD_ROOTS) {
    if (resolvedPath.startsWith(cwd + '/') || resolvedPath === cwd) return true
  }
  // 4. Dynamic agent cwds (if provided)
  if (agentCwds) {
    for (const raw of agentCwds) {
      if (!raw) continue
      const cwd = resolve(raw)
      if (resolvedPath.startsWith(cwd + '/') || resolvedPath === cwd) return true
    }
  }
  return false
}

export const FILE_BLOCKED_PATTERNS = [
  /openclaude\.json$/, // gateway config with tokens
  /\.env($|\.)/, // .env, .env.local, .env.production, .env.development, etc.
  /credentials/, // credential directory
  /\.ssh/, // SSH keys
  /\.key$/, // private keys
  /\.pem$/, // certificates
  /id_rsa/, // SSH private key
  /id_ed25519/, // SSH private key
  /\.gnupg/, // GPG keys
  /\.password/, // password files
  /shadow$/, // /etc/shadow
  /auth.*token/i, // token files
  /MEMORY\.md$/, // agent long-term memory
  /USER\.md$/, // user identity / core memory
  /CLAUDE\.md$/, // agent persona / system instructions
  /resume-map\.json$/, // session checkpoint data
  /\.npmrc$/, // npm registry tokens
  /\.pypirc$/, // PyPI credentials
  /\.netrc$/, // FTP/HTTP credentials
  /\.aws\//, // AWS credentials & config directory
  /\.kube\//, // Kubernetes config directory
  /\.docker\/config\.json$/, // Docker registry credentials
]

/** Returns true if the resolved path matches any sensitive-file pattern. */
export function isFileBlocked(resolvedPath: string): boolean {
  return FILE_BLOCKED_PATTERNS.some((p) => p.test(resolvedPath))
}

export const UPLOAD_MIME_PREFIXES = ['image/', 'audio/', 'video/', 'application/pdf', 'text/']
export const MAX_UPLOAD_SINGLE = 25 * 1024 * 1024
export const MAX_UPLOAD_TOTAL = 50 * 1024 * 1024

/** Returns true if the MIME type is allowed for upload. */
export function isUploadMimeAllowed(mime: string): boolean {
  if (!mime) return true
  return UPLOAD_MIME_PREFIXES.some((p) => mime.startsWith(p)) || mime === 'application/octet-stream'
}

const MIME_MAP: Record<string, string> = {
  // web
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  // images
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  // audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.wma': 'audio/x-ms-wma',
  // video
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  // documents
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
}

function mimeFor(p: string): string {
  return MIME_MAP[extname(p).toLowerCase()] ?? 'application/octet-stream'
}

// 便捷工厂
export async function createGateway(opts?: { webRoot?: string }): Promise<Gateway> {
  const config = await readConfig()
  if (!config) throw new Error('Run `openclaude onboard` first to create config.')
  const agentsConfig = await readAgentsConfig()
  return new Gateway({ config, agentsConfig, webRoot: opts?.webRoot })
}
