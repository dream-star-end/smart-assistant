import { createHash, randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import {
  constants as fsConstants,
  closeSync,
  createReadStream,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { isIPv4 } from 'node:net'
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
  getUsageSummary,
  queryEvents,
  listClientSessions,
  getClientSession,
  upsertClientSession,
  deleteClientSession,
  listUnclaimedSessions,
  claimSession,
} from '@openclaude/storage'
import { type WebSocket, WebSocketServer } from 'ws'
import { checkToken, verifyPassword, signJwt, verifyJwt, type JwtPayload } from './auth.js'
import { CronScheduler } from './cron.js'
import { parseDocument } from './documentParser.js'
import { eventBus, createEvent } from './eventBus.js'
import { startEventPersistence } from './eventPersist.js'
import { createLogger } from './logger.js'
import { startMetricsCollection, serializeMetrics, httpRequestsTotal, httpRequestDuration, wsConnectionsTotal, sessionsActive } from './metrics.js'
import { RateLimiter } from './rateLimit.js'
import { handleOpenAIRequest } from './openaiCompat.js'
import { OutboundRingBuffer } from './outboundRing.js'
import { Router } from './router.js'
import { RunLog } from './runLog.js'
import { SessionManager } from './sessionManager.js'
import { WebhookRouter } from './webhooks.js'

/**
 * V3 Phase 2 Task 2H: 商业化模块 hook 形状(只声明 gateway 需要的接口,
 * 不依赖 @openclaude/commercial 的具体实现)。
 *
 * - `handle(req, res) → Promise<boolean>`:返 true 表示已处理,gateway 不再继续路由
 * - `handleWsUpgrade(req, socket, head) → boolean`:同上,boolean 表示是否已 upgrade/destroy
 * - `shutdown()`:在 _doShutdown Stage 3.5 调用(channels 之后,sessions 之前)
 * - `internalProxyAddress`:供 /healthz 反映内部代理是否上线
 *
 * 故意不 import @openclaude/commercial — 保持 gateway 包对商业化模块零编译期依赖,
 * cli launcher 负责 dynamic import + 注入。
 */
export interface CommercialHook {
  handle: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>
  handleWsUpgrade: (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => boolean
  shutdown: () => Promise<void>
  internalProxyAddress?: { host: string; port: number }
  /**
   * 商业化模块的 JWT HMAC 密钥(HS256)。注入后,gateway 的 personal-version 路由
   * 会同时尝试用这个 secret 验证 access token,使商业化用户也能命中
   * /api/agents、/api/sessions/* 等 personal-version 端点。
   */
  jwtSecret?: Uint8Array
}

export interface GatewayDeps {
  config: OpenClaudeConfig
  agentsConfig: AgentsConfig
  webRoot?: string // 静态 web UI 目录
  channelFactories?: Array<(deps: { config: OpenClaudeConfig }) => ChannelAdapter>
  /** V3 2H: 商业化模块挂载点(undefined = 未启用)。由 cli launcher 在 COMMERCIAL_ENABLED=1 时注入。 */
  commercial?: CommercialHook
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
  private channels = new Map<string, ChannelAdapter>()
  private log = createLogger({ module: 'gateway' })
  private rateLimiter = new RateLimiter()
  private _wsKeepaliveTimer: ReturnType<typeof setInterval> | null = null
  private _taskSchedulerTimer: ReturnType<typeof setInterval> | null = null
  private _oauthRefreshTimer: ReturnType<typeof setInterval> | null = null
  private _pendingPermissionSweepTimer: ReturnType<typeof setInterval> | null = null
  private _stopEviction: (() => void) | null = null
  private _shuttingDown = false
  private _shutdownPromise: Promise<void> | null = null

  // ── Idempotency key dedup (prevents duplicate processing on client reconnect replay) ──
  private _seenIdempotencyKeys = new Map<string, number>() // key → timestamp
  private static readonly IDEMPOTENCY_MAX_KEYS = 1000
  private static readonly IDEMPOTENCY_TTL_MS = 5 * 60_000 // 5 minutes

  /**
   * Check whether an idempotency key has already been processed (read-only).
   * Returns true if the key is a duplicate (i.e. should be skipped).
   */
  private _isIdempotencyDuplicate(key: string): boolean {
    if (!key) return false
    const now = Date.now()

    // Evict expired entries periodically
    if (this._seenIdempotencyKeys.size > 100) {
      for (const [k, ts] of this._seenIdempotencyKeys) {
        if (now - ts > Gateway.IDEMPOTENCY_TTL_MS) {
          this._seenIdempotencyKeys.delete(k)
        }
      }
    }

    const ts = this._seenIdempotencyKeys.get(key)
    return ts !== undefined && now - ts < Gateway.IDEMPOTENCY_TTL_MS
  }

  /** Record an idempotency key as processed. */
  private _markIdempotencyKey(key: string): void {
    if (key) this._seenIdempotencyKeys.set(key, Date.now())
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
  private _staticFileCache = new Map<string, { content: Buffer; mime: string; etag: string }>()
  // (channel, peer.id) → 当前活跃的 ws client(用于回传 outbound)
  private clientsByPeer = new Map<string, Set<WebSocket>>()
  // Pending permission requests: requestId → { sessionKey, toolName, input, toolUseId, peerKey, channel, peer }
  // Used for single-settlement, original-input passthrough, and disconnect auto-deny.
  // `channel` and `peer` are preserved from the original request so disconnect
  // auto-deny broadcasts with the correct (unspoofable) peer kind.
  // `toolName` lets handlePermissionResponse apply tool-specific handling
  // (e.g. AskUserQuestion merges user-supplied `answers` into updatedInput).
  private _pendingPermissions = new Map<string, {
    sessionKey: string
    toolName: string
    input: Record<string, unknown>
    toolUseId?: string
    peerKey: string
    /** Authenticated userId that owns this pending request — carried so that
     *  _recordSettlement can stamp the settlement with the owner, and
     *  reconstructed peerKeys on late-duplicate replay paths match the
     *  original broadcast scope. */
    userId: string
    channel: string
    peer: { id: string; kind: 'dm' | 'group' }
    /** Monotonic timestamp (Date.now) at which this request should be auto-denied
     *  by the janitor even if no disconnect or crash occurred. Prevents orphan
     *  pending entries when a user leaves the tab open across days. */
    expiresAt: number
  }>()
  /** Max wait for a permission response before the janitor auto-denies.
   *  Matched to the outer CCB turn timeout (30 min) so we don't pre-empt
   *  a slow user while a turn is still live. */
  private static readonly PENDING_PERMISSION_TTL_MS = 30 * 60_000
  /** How often the janitor scans _pendingPermissions. */
  private static readonly PENDING_PERMISSION_SWEEP_MS = 60_000
  // Recently-settled permission requests: requestId → authoritative result.
  // Used to replay the true `behavior` when a duplicate/late response arrives
  // after the first responder already won the race. Without this, the
  // already_settled branch would rebroadcast the LATE responder's behavior,
  // which could mislabel cards on a 3rd tab that missed the first broadcast.
  // Bounded by RECENT_SETTLEMENT_MAX (FIFO evict) and RECENT_SETTLEMENT_TTL_MS.
  private _recentSettlements = new Map<
    string,
    {
      behavior: 'allow' | 'deny'
      channel: string
      peer: { id: string; kind: 'dm' | 'group' }
      sessionKey: string
      /** Authenticated userId from the originating request — needed to
       *  reconstruct the per-user peerKey on already-settled replay. */
      userId: string
      // Present only for AskUserQuestion allow settlements — replayed to
      // late-joining tabs so they can fill in the answers column of the card.
      answers?: Record<string, string>
      ts: number
    }
  >()
  private static readonly RECENT_SETTLEMENT_MAX = 1000
  private static readonly RECENT_SETTLEMENT_TTL_MS = 5 * 60_000
  // Per-agent last active channel tracking (for proactive push)
  // Track last active channel + session for proactive push (reminders, heartbeat, etc.)
  private lastActiveChannel = new Map<
    string,
    { channel: string; peerId: string; sessionKey: string; at: number; userId: string }
  >()

  // ── Phase 0.3: outbound frame ring buffer (short-term replay) ──
  // See packages/gateway/src/outboundRing.ts for the standalone class.
  // Every outbound.message frame delivered to a webchat peer gets a monotonic
  // `frameSeq` stamped alongside `ts`; the ring backs
  // `autoResumeFromHello(lastFrameSeq)` cursor replay so reconnecting clients
  // can catch up without hitting REST. When the ring can't satisfy a resume,
  // we emit `outbound.resume_failed` so the client escalates to REST sync.
  private _outboundRing = new OutboundRingBuffer()

  constructor(private deps: GatewayDeps) {
    this.router = new Router(deps.agentsConfig)
    this.sessions = new SessionManager(deps.config)
    // Wire up auth error handler: force-refresh token when 401 detected (bypass expiry check)
    this.sessions.onAuthError = () => this.refreshClaudeOAuthIfNeeded(true)
    // 2026-04-21 Medium#G1:被 sessionManager 内部驱逐/shutdown 的 sessionKey
    // 由此 callback 统一走 outboundRing.clear,防 ring 内存长期泄漏。server.ts
    // 其他已有的 destroySession 调用点仍然显式 clear(幂等 double-clear 无副作用)。
    this.sessions.onSessionDestroyed = (sessionKey) => {
      try { this._outboundRing.clear(sessionKey) } catch {}
    }
  }

  async start(): Promise<void> {
    const { config } = this.deps

    // Phase 0.2: replay any server-authored messages queued to the outbox
    // while the previous gateway instance was unable to reach SQLite (disk
    // full, crash mid-write, etc.). Runs before the WS endpoint opens so
    // catch-up writes precede live traffic. Failures here must not block
    // startup — we'd rather serve with a retryable queue than refuse boot.
    try {
      const { replayMsgOutbox } = await import('@openclaude/storage')
      const summary = await replayMsgOutbox()
      if (summary.processed > 0) {
        this.log.info('msg-outbox replay', summary)
      }
    } catch (err) {
      this.log.error('msg-outbox replay failed (continuing startup)', undefined, err as Error)
    }

    this.httpServer = createServer((req, res) => this.handleHttp(req, res))
    // V3 2H: 改用 noServer + 手动 upgrade dispatch,以便商业化模块的 /ws/user-chat-bridge
    // 与 /ws/agent 路径在 gateway 自身的 /ws 之前优先匹配。原 `path: '/ws'` 模式下
    // ws lib 会对所有非 /ws 请求 socket.destroy(),把商业化路径吃掉。
    // 商用 v3:容器内 gateway 作为 server 接收 bridge client 转发的 user 帧。
    // 用户允许单附件 200 MiB / 总 300 MiB,base64 后 ≈ 400 MiB + envelope → 448 MiB。
    // ws 默认 maxPayload=100 MiB 会让 Receiver 对大附件帧直接 RangeError 关连接。
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 448 * 1024 * 1024 })
    this.httpServer.on('upgrade', (req, socket, head) => {
      // 1) 商业化模块优先(/ws/user-chat-bridge / /ws/agent / 未来私有路径)
      try {
        if (this.deps.commercial?.handleWsUpgrade(req, socket, head)) return
      } catch (err) {
        this.log.error('commercial.handleWsUpgrade threw', undefined, err)
        try { socket.destroy() } catch {}
        return
      }
      // 2) gateway 自身 /ws(浏览器 ↔ gateway 的 ChannelAdapter 协议)
      const url = req.url ?? '/'
      // 只接受 exact `/ws` 或 `/ws?…` 路径,剩余的 4xx + close
      const path = (() => { try { return new URL(url, 'http://x').pathname } catch { return url } })()
      if (path === '/ws') {
        this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req))
        return
      }
      // 3) 不认识的 ws path:401 + close(对齐 ws lib 默认对未匹配路径的处理)
      try {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        socket.destroy()
      } catch {}
    })

    // WS keepalive: ping every 25s, terminate if no pong in 35s
    this._wsKeepaliveTimer = setInterval(() => {
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
          // Channel name last so adapter-supplied meta.channel can't spoof it.
          info: (m, meta) => this.log.info(m, { ...(meta ?? {}), channel: adapter.name }),
          error: (m, meta) => this.log.error(m, { ...(meta ?? {}), channel: adapter.name }),
        },
        config: (config.channels as any)[adapter.name] ?? {},
        // Reset session keyed by (channel, peer). Used by channel /new handlers.
        // Destroys every session the router could route this (channel, peer) to.
        resetSession: async (channel, peerId, peerKind) => {
          const safePeer = peerId.replace(/[^a-zA-Z0-9_-]/g, '_')
          const prefix = `agent:`
          const suffix = `:${channel}:${peerKind}:${safePeer}`
          const keys: string[] = []
          for (const s of this.sessions.list()) {
            if (s.sessionKey.startsWith(prefix) && s.sessionKey.endsWith(suffix)) {
              keys.push(s.sessionKey)
            }
          }
          for (const k of keys) {
            try { await this.sessions.destroySession(k) } catch {}
            this._outboundRing.clear(k)
          }
        },
      }
      try {
        await adapter.init(ctx)
        this.channels.set(adapter.name, adapter)
        this.log.info('channel ready', { channel: adapter.name })
      } catch (err) {
        this.log.error('channel failed to init', { channel: adapter.name }, err)
      }
    }

    this._stopEviction = this.sessions.startEvictionLoop()
    process.once('SIGINT', () => {
      this.shutdown().catch((err) => this.log.error('shutdown error (SIGINT)', undefined, err))
    })
    process.once('SIGTERM', () => {
      this.shutdown().catch((err) => this.log.error('shutdown error (SIGTERM)', undefined, err))
    })


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
          const peerKey = Gateway.makePeerKey(lastActive.userId, 'webchat', lastActive.peerId)
          const set = this.clientsByPeer.get(peerKey)
          if (set && set.size > 0) {
            // Route through deliver() to preserve the "all WebChat
            // outbound.message frames carry ts" invariant the client-side
            // stale-final guard relies on. buildOut includes a `cronJob`
            // marker field that OutboundMessage schema doesn't declare,
            // hence the cast — the wire format tolerates extra keys.
            // Stamp userId so deliver() routes to the correct per-user peerKey.
            const cronOut = {
              ...buildOut(lastActive.peerId, lastActive.sessionKey),
              _userId: lastActive.userId,
            }
            this.deliver(cronOut as OutboundMessage)
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

      // 3. Fallback: broadcast to all connected webchat clients.
      // This path can't use deliver() (which is scoped to a single peerKey) —
      // inline the ts stamp so the client's stale-final/ts-guard invariant
      // stays intact here too.
      if (!delivered) {
        const data = JSON.stringify({
          ...buildOut('__reflection__'),
          ts: Date.now(),
        })
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
    this.cron.start().catch((err) => this.log.error('cron start failed', undefined, err))

    // Start event persistence (writes all events to SQLite event_log)
    startEventPersistence()

    // Start metrics collection (eventBus → prometheus counters)
    startMetricsCollection()

    // Start rate limiter cleanup
    this.rateLimiter.startCleanup()

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
        .then(() =>
          this.log.info('eventBus task.created → gateway job', { taskId: ev.taskId }),
        )
        .catch((err) =>
          this.log.warn('eventBus task.created failed', { taskId: ev.taskId }, err),
        )
    })
    eventBus.on('task.deleted', (ev) => {
      if (!this.cron) return
      this.cron
        .removeJob(ev.taskId)
        .then((ok) =>
          this.log.info('eventBus task.deleted', {
            taskId: ev.taskId,
            result: ok ? 'removed' : 'not found',
          }),
        )
        .catch((err) =>
          this.log.warn('eventBus task.deleted failed', { taskId: ev.taskId }, err),
        )
    })

    // Start webhook router
    this.webhookRouter = new WebhookRouter()
    await this.webhookRouter.load()
    this.log.info('webhooks loaded', { count: this.webhookRouter.list().length })

    // EventBus: route webhook.received → agent execution + delivery
    eventBus.on('webhook.received', (ev) => {
      const { webhookId, agentId, payload } = ev
      const { resolvedPrompt } = payload as any
      ;(async () => {
        const cfg = await this._getAgentsConfig()
        const agent = cfg.agents.find((a) => a.id === agentId)
        if (!agent) {
          this.log.warn('webhook agent not found', { agentId, webhookId })
          return
        }
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
            // Route through deliver() so the server-assigned ts gets stamped —
            // otherwise the web client's stale-final guard has nothing to compare
            // against and every webhook-delivered isFinal bypasses the guard.
            this.deliver({
              type: 'outbound.message' as const,
              sessionKey: lastActive.sessionKey,
              channel: 'webchat' as const,
              peer: { id: lastActive.peerId, kind: 'dm' as const },
              blocks: [
                { kind: 'text' as const, text: `🔔 **Webhook ${webhookId}**\n\n${output.trim()}` },
              ],
              isFinal: true,
              _userId: lastActive.userId,
            } as OutboundMessage)
          }
        }
      })().catch((err) =>
        this.log.error('webhook execution failed', { webhookId, agentId }, err),
      )
    })

    // TaskStore: schedule-triggered tasks run alongside cron (check every 60s)
    this._taskSchedulerTimer = setInterval(() => {
      this._tickScheduledTasks().catch((err) =>
        this.log.error('task-scheduler tick failed', undefined, err),
      )
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

    // Handle subprocess crashes: push a system message to the client so they know
    // the session will auto-recover on the next message they send
    eventBus.on('session.crashed', (ev) => {
      // Route through deliver() so the ts-stamp path is the single source of truth
      // for stale-final ordering. Preserves original semantics (no-op if no
      // clients are connected — deliver() bails early on empty peer set).
      // Cast keeps the legacy `agentId` field the crash notification has always
      // carried; OutboundMessage schema doesn't define it but the client reads
      // it, and the wire format tolerates extra keys.
      this.deliver({
        type: 'outbound.message',
        sessionKey: ev.sessionKey,
        channel: 'webchat',
        peer: { id: ev.peerId, kind: 'dm' },
        agentId: ev.agentId,
        blocks: [
          {
            kind: 'text',
            text: '⚠️ AI 进程异常退出，下一条消息将自动恢复上下文。',
          },
        ],
        isFinal: true,
      } as OutboundMessage)
      this.log.info('pushed crash notification', { peerId: ev.peerId })

      // Any pending permission requests that belonged to the crashed session
      // will never be answered (subprocess is gone). Clean them up so the
      // map doesn't leak and any connected tabs dismiss their stuck modal.
      const pendingToReap: string[] = []
      for (const [requestId, pending] of this._pendingPermissions) {
        if (pending.sessionKey === ev.sessionKey) pendingToReap.push(requestId)
      }
      for (const requestId of pendingToReap) {
        this._forceDenyPendingPermission(requestId, 'crashed', 'Session crashed')
      }
    })

    // Periodic OAuth token refresh (every 10 min). Running subprocesses keep
    // the old token until restarted; 401 detection in sessionManager handles
    // the restart + retry when the old token expires mid-conversation.
    this._oauthRefreshTimer = setInterval(() => this.refreshClaudeOAuthIfNeeded().catch(() => {}), 10 * 60_000)
    // Periodic pending-permission janitor: TTL-based auto-deny + orphan cleanup.
    this._pendingPermissionSweepTimer = setInterval(
      () => {
        try { this._sweepStalePendingPermissions() } catch (err) {
          this.log.warn('pending permission sweep failed', undefined, err)
        }
      },
      Gateway.PENDING_PERMISSION_SWEEP_MS,
    )
    // Check immediately on boot
    this.refreshClaudeOAuthIfNeeded().catch(() => {})

    await new Promise<void>((res) => {
      this.httpServer.listen(config.gateway.port, config.gateway.bind, () => res())
    })
    this.log.info('server started', { bind: config.gateway.bind, port: config.gateway.port })

    // Auto-resume: proactively continue interrupted webchat sessions after gateway restart
    this.bootAutoResume().catch((err) =>
      this.log.error('auto-resume boot failed', undefined, err),
    )
  }

  /**
   * Public, idempotent shutdown. Safe to call from signal handlers, fatal
   * error handlers, or external orchestration. Concurrent calls share the
   * same in-flight shutdown promise.
   *
   * Pass `exit=false` to skip the terminal `process.exit(0)` — the caller
   * is then responsible for exiting (used by emergency exit handlers that
   * want to exit with code 1 after graceful flush).
   */
  public shutdown(exit = true): Promise<void> {
    if (this._shutdownPromise) return this._shutdownPromise
    // Set ingress guard FIRST so handlers reject new requests immediately
    this._shuttingDown = true
    this._shutdownPromise = this._doShutdown(exit).catch((err) => {
      try {
        this.log.error('shutdown failed', undefined, err)
      } catch {}
      if (exit) process.exit(1)
    })
    return this._shutdownPromise
  }

  /** True once shutdown has begun; handlers use this to reject new ingress. */
  public get isShuttingDown(): boolean {
    return this._shuttingDown
  }

  private async _doShutdown(exit: boolean): Promise<void> {
    this.log.info('shutting down')

    // ── Stage 1: stop accepting new traffic ──
    // `httpServer.close()` stops accepting new HTTP connections but lets
    // in-flight requests finish. WS upgrade happens via the HTTP server so
    // new WS connections are also refused. Existing handlers additionally
    // check `_shuttingDown` to short-circuit.
    // We capture the close-completion Promise here and await it in Stage 5
    // so the full close lifecycle is awaited before exit.
    let httpCloseDone: Promise<void> = Promise.resolve()
    if (this.httpServer) {
      httpCloseDone = new Promise<void>((resolveClose) => {
        try {
          this.httpServer.close((err) => {
            if (err) this.log.warn('httpServer.close error', undefined, err)
            resolveClose()
          })
        } catch (err) {
          this.log.warn('httpServer.close threw', undefined, err)
          resolveClose()
        }
      })
    }

    // ── Stage 2: stop all background timers ──
    try {
      this._stopEviction?.()
    } catch {}
    this._stopEviction = null
    if (this._wsKeepaliveTimer !== null) {
      clearInterval(this._wsKeepaliveTimer)
      this._wsKeepaliveTimer = null
    }
    if (this._taskSchedulerTimer !== null) {
      clearInterval(this._taskSchedulerTimer)
      this._taskSchedulerTimer = null
    }
    if (this._oauthRefreshTimer !== null) {
      clearInterval(this._oauthRefreshTimer)
      this._oauthRefreshTimer = null
    }
    if (this._pendingPermissionSweepTimer !== null) {
      clearInterval(this._pendingPermissionSweepTimer)
      this._pendingPermissionSweepTimer = null
    }
    try {
      this.cron?.stop()
    } catch (err) {
      this.log.warn('cron stop error', undefined, err)
    }

    // ── Stage 3: drain channel adapters (Telegram etc.) ──
    for (const ch of this.channels.values()) {
      try {
        await ch.shutdown()
      } catch (err) {
        this.log.warn('channel shutdown error', { channel: ch.name }, err)
      }
    }

    // ── Stage 3.5: V3 2H — drain 商业化模块(close redis/pricing/anthropic proxy/ws bridge) ──
    if (this.deps.commercial) {
      try {
        await this.deps.commercial.shutdown()
      } catch (err) {
        this.log.warn('commercial shutdown error', undefined, err)
      }
    }

    // ── Stage 4: drain sessions (kill CCB subprocesses, flush resume map) ──
    try {
      await this.sessions.shutdownAll()
    } catch (err) {
      this.log.warn('sessions shutdownAll error', undefined, err)
    }
    try {
      await this.sessions.awaitResumeMapFlush()
    } catch (err) {
      this.log.warn('resume map flush error', undefined, err)
    }

    // ── Stage 5: force-close remaining sockets ──
    // WS: terminate remaining clients so `wss.close()` callback fires promptly.
    // HTTP: `closeAllConnections()` destroys active sockets (e.g. SSE streams)
    //       that would otherwise block the Stage 1 `close()` callback.
    if (this.httpServer) {
      try {
        const closeAll = (this.httpServer as any).closeAllConnections
        if (typeof closeAll === 'function') closeAll.call(this.httpServer)
      } catch (err) {
        this.log.warn('closeAllConnections error', undefined, err)
      }
    }
    const wssCloseDone = new Promise<void>((resolveClose) => {
      if (!this.wss) return resolveClose()
      try {
        for (const ws of this.wss.clients) {
          try { ws.terminate() } catch {}
        }
        this.wss.close((err) => {
          if (err) this.log.warn('wss.close error', undefined, err)
          resolveClose()
        })
      } catch (err) {
        this.log.warn('wss.close threw', undefined, err)
        resolveClose()
      }
    })
    await Promise.allSettled([httpCloseDone, wssCloseDone])
    this.log.info('shutdown complete')
    if (exit) process.exit(0)
  }

  // ───────── HTTP ─────────
  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    // Ingress guard: refuse new work once shutdown has begun
    if (this._shuttingDown) {
      res.statusCode = 503
      res.setHeader('Connection', 'close')
      res.setHeader('Content-Type', 'text/plain')
      res.end('shutting down')
      return
    }

    // V3 2H: 商业化模块优先 — 其 router 自管 auth + 输入校验 + status code,
    // 返 true 即"已处理",gateway 不再走自家 /api/auth/login 等路径。
    // 必须在 security headers 之前,否则 commercial 自己设置的 CSP/headers 会被覆盖。
    if (this.deps.commercial) {
      const r = this.deps.commercial.handle(req, res)
      if (r === true) return
      if (r && typeof (r as Promise<boolean>).then === 'function') {
        ;(r as Promise<boolean>)
          .then((handled) => {
            if (handled) return
            this._handleHttpAfterCommercial(req, res)
          })
          .catch((err) => {
            this.log.error('commercial.handle threw', undefined, err)
            if (!res.headersSent) {
              try {
                res.statusCode = 500
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'commercial error' } }))
              } catch {}
            } else {
              try { res.end() } catch {}
            }
          })
        return
      }
      // false 同步 → 走 gateway 路由
    }
    this._handleHttpAfterCommercial(req, res)
  }

  private _handleHttpAfterCommercial(req: IncomingMessage, res: ServerResponse): void {
    const reqStart = Date.now()
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const method = req.method ?? 'GET'
    const path = url.pathname

    // M1: Security headers on every response
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    // Cloudflare Turnstile widget iframe (challenges.cloudflare.com) needs a
    // handful of sensor/attestation features delegated to it; default deny
    // policy makes the widget hang at "before-interactive" and never produce a
    // token (silent failure — user sees blank widget area). See:
    // https://developers.cloudflare.com/turnstile/troubleshooting/permissions-policy
    res.setHeader('Permissions-Policy', [
      'camera=()', 'microphone=()', 'geolocation=()',
      'accelerometer=(self "https://challenges.cloudflare.com")',
      'gyroscope=(self "https://challenges.cloudflare.com")',
      'magnetometer=(self "https://challenges.cloudflare.com")',
      'xr-spatial-tracking=(self "https://challenges.cloudflare.com")',
      'attribution-reporting=(self "https://challenges.cloudflare.com")',
      'private-state-token-issuance=(self "https://challenges.cloudflare.com")',
      'private-state-token-redemption=(self "https://challenges.cloudflare.com")',
    ].join(', '))

    // Instrument response — record metrics after response finishes
    res.on('finish', () => {
      const duration = Date.now() - reqStart
      const status = String(res.statusCode)
      httpRequestsTotal.inc({ method, path: normalizePath(path), status })
      httpRequestDuration.observe(duration, { method, path: normalizePath(path) })
      // Log non-static requests (skip static assets to reduce noise)
      if (path.startsWith('/api/') || path.startsWith('/v1/') || path === '/healthz' || path === '/metrics') {
        this.log.info('http', { method, path, status: res.statusCode, durationMs: duration })
      }
    })

    // ── Multi-user login (no auth required, rate-limited) ──
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      // Use socket address only — X-Forwarded-For is client-spoofable; cloudflared connects locally
      const clientIp = req.socket.remoteAddress || 'unknown'
      if (!this.rateLimiter.check(clientIp, 'login')) {
        this.sendJson(res, 429, { error: 'too many login attempts, try again later' })
        return
      }
      this.readBody(req).then((body) => {
        let parsed: any
        try {
          parsed = JSON.parse(body)
        } catch {
          this.sendJson(res, 400, { error: 'invalid JSON' })
          return
        }
        if (typeof parsed !== 'object' || parsed === null) {
          this.sendJson(res, 400, { error: 'body must be a JSON object' })
          return
        }
        const { username, password } = parsed
        const users = this.deps.config.gateway.users
        if (!users?.length) {
          // Legacy mode: accept raw accessToken as password — username not required
          if (typeof password !== 'string') {
            this.sendJson(res, 400, { error: 'password must be a string' })
            return
          }
          if (checkToken(password, this.deps.config.gateway.accessToken)) {
            const token = signJwt({ userId: 'default', exp: Math.floor(Date.now() / 1000) + Gateway.JWT_TTL_SECONDS }, this.deps.config.gateway.accessToken)
            this.sendJson(res, 200, { token, userId: 'default', name: 'Default' })
          } else {
            this.sendJson(res, 401, { error: 'invalid credentials' })
          }
          return
        }
        if (typeof username !== 'string' || typeof password !== 'string') {
          this.sendJson(res, 400, { error: 'username and password must be strings' })
          return
        }
        const user = users.find((u) => u.id === username)
        if (!user || !verifyPassword(password, user.passwordHash)) {
          this.sendJson(res, 401, { error: 'invalid credentials' })
          return
        }
        const token = signJwt({ userId: user.id, exp: Math.floor(Date.now() / 1000) + Gateway.JWT_TTL_SECONDS }, this.deps.config.gateway.accessToken)
        this.sendJson(res, 200, { token, userId: user.id, name: user.name })
      }).catch(() => this.sendJson(res, 400, { error: 'invalid body' }))
      return
    }

    // Routes that need auth
    // All /api/*, /v1/*, and /metrics endpoints require auth except healthz
    const needsAuth =
      (url.pathname.startsWith('/api/') && url.pathname !== '/api/healthz') ||
      url.pathname.startsWith('/v1/') ||
      url.pathname === '/metrics'
    // v3 file proxy: HOST gateway → container /api/file or /api/media via docker bridge
    // bypasses checkHttpAuth if all four conditions hold (see checkBridgeBypass).
    const bridgeVerified = needsAuth ? this.checkBridgeBypass(req, url) : false
    if (needsAuth && !bridgeVerified && !this.checkHttpAuth(req)) {
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
      // setSessionCookie re-verifies the token; if JWT just raced into expiry,
      // return 401 rather than silently downgrading to 'default' identity.
      if (!this.setSessionCookie(res, req)) {
        res.writeHead(401)
        res.end('unauthorized')
        return
      }
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
      // V3 2H: /healthz 增加 commercial 模块状态(供运维快速判断 v2/v3 实例形态)
      const c = this.deps.commercial
      // v3 file proxy: advertise `file-proxy-v1` capability only when ALL three
      // env vars HOST relies on are injected AND well-formed. Incomplete或形态不对
      // (supervisor 写错 / 部署降级 / 容器复用)→ not ready → HOST 返 CONTAINER_OUTDATED,
      // 避免 HOST 按 bypass 发头结果容器内 checkBridgeBypass 失败 401 的 dead lock。
      // (Codex R1 SHOULD-3:校验形态,不只校验非空)
      const TRUST_BRIDGE_IP = process.env.OPENCLAUDE_TRUST_BRIDGE_IP || ''
      const OC_CONTAINER_ID = process.env.OC_CONTAINER_ID || ''
      const OC_BRIDGE_NONCE = process.env.OC_BRIDGE_NONCE || ''
      // trust IP 必须是 IPv4 文本(docker bridge gateway,通常 172.30.0.1)
      // 用 net.isIPv4 而不是松正则 —— R2 SHOULD:`999.999.999.999` 会过正则但
      // remoteAddress 永远 match 不到,结果 /healthz 误报 ready 导致 HOST probe
      // 通过但真实 bypass 全挂。
      const TRUST_IP_OK = isIPv4(TRUST_BRIDGE_IP)
      // container id 必须是 10 位以内正整数(BIGSERIAL),禁止 alpha / leading 0 / 超长
      const CONTAINER_ID_OK = /^[1-9][0-9]{0,18}$/.test(OC_CONTAINER_ID)
      const NONCE_OK = /^[0-9a-f]{64}$/i.test(OC_BRIDGE_NONCE)
      const bridgeReady = TRUST_IP_OK && CONTAINER_ID_OK && NONCE_OK
      const body: Record<string, unknown> = c
        ? {
            ok: true,
            commercial: {
              enabled: true,
              internalProxy: c.internalProxyAddress
                ? { host: c.internalProxyAddress.host, port: c.internalProxyAddress.port }
                : null,
            },
          }
        : { ok: true }
      body.containerId = OC_CONTAINER_ID || null
      body.capabilities = bridgeReady ? ['file-proxy-v1'] : []
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
      return
    }
    if (path === '/metrics') {
      sessionsActive.value = this.sessions.list().length
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' })
      res.end(serializeMetrics())
      return
    }
    // /version — reports currently-live release. Written by scripts/deploy-v3.sh
    // as <cwd>/VERSION.json after rsync and before systemctl restart. Public
    // (no auth) because commit hash of a private repo carries no secret value
    // and matches the already-open /healthz posture.
    if (url.pathname === '/version' && req.method === 'GET') {
      let body: { tag: string; builtAt: string | null; commit?: string } = {
        tag: 'unknown',
        builtAt: null,
      }
      try {
        const raw = readFileSync(resolve(process.cwd(), 'VERSION.json'), 'utf-8')
        const j = JSON.parse(raw)
        if (typeof j.tag === 'string') body.tag = j.tag
        if (typeof j.builtAt === 'string') body.builtAt = j.builtAt
        if (typeof j.commit === 'string') body.commit = j.commit
      } catch {
        // file missing / unreadable / malformed → return defaults above
      }
      this.sendJson(res, 200, body)
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
    if (url.pathname === '/api/usage' && req.method === 'GET') {
      const agentId = url.searchParams.get('agentId') ?? undefined
      const sessionId = url.searchParams.get('sessionId') ?? undefined
      const sinceRaw = url.searchParams.get('since')
      const since = sinceRaw ? Number(sinceRaw) : undefined
      if (since !== undefined && !Number.isFinite(since)) {
        this.sendJson(res, 400, { error: 'since must be a valid number' }); return
      }
      Promise.all([
        getUsageSummary({ agentId, sessionId, since }),
        queryEvents({ type: 'cost.recorded', agentId, sessionKey: sessionId, since, limit: 50 }),
      ]).then(([summary, events]) => {
        this.sendJson(res, 200, { summary, recentCostEvents: events })
      }).catch(() => this.sendJson(res, 500, { error: 'usage query failed' }))
      return
    }
    if (url.pathname === '/api/usage/events' && req.method === 'GET') {
      const type = url.searchParams.get('type') ?? undefined
      const agentId = url.searchParams.get('agentId') ?? undefined
      const sessionKey = url.searchParams.get('sessionKey') ?? undefined
      const sinceRaw = url.searchParams.get('since')
      const since = sinceRaw ? Number(sinceRaw) : undefined
      const limitRaw = url.searchParams.get('limit')
      const limitNum = limitRaw ? Number(limitRaw) : 100
      const limit = Number.isFinite(limitNum) ? Math.min(Math.max(limitNum, 1), 1000) : 100
      if (since !== undefined && !Number.isFinite(since)) {
        this.sendJson(res, 400, { error: 'since must be a valid number' }); return
      }
      queryEvents({ type, agentId, sessionKey, since, limit })
        .then((events) => this.sendJson(res, 200, { events }))
        .catch(() => this.sendJson(res, 500, { error: 'event query failed' }))
      return
    }
    if (url.pathname === '/api/runs' && req.method === 'GET') {
      this.sendJson(res, 200, { runs: this._runLog.recent(50) })
      return
    }
    if (url.pathname === '/api/sessions') {
      // Filter live sessions to those belonging to the authenticated user.
      // Session keys contain the peerId (which is the client session ID);
      // we match against client_sessions owned by this userId.
      const userId = this.getUserId(req)
      const allLive = this.sessions.list()
      // For multi-user: only show sessions whose peerId belongs to this user
      listClientSessions(userId).then((owned) => {
        const ownedIds = new Set(owned.map((s) => s.id))
        // Also include sessions with no matching client session (cron/task sessions) only for default user
        const filtered = allLive.filter((s) => {
          const peerId = s.sessionKey.split(':')[4] || ''
          return ownedIds.has(peerId) || (userId === 'default' && !peerId.startsWith('web-'))
        })
        this.sendJson(res, 200, { sessions: filtered })
      }).catch(() => this.sendJson(res, 200, { sessions: [] }))
      return
    }
    // ── Client session sync (cross-device, multi-user) ──
    if (url.pathname === '/api/sessions/list' && req.method === 'GET') {
      const userId = this.getUserId(req)
      listClientSessions(userId)
        .then((list) => this.sendJson(res, 200, { sessions: list }))
        .catch(() => this.sendJson(res, 500, { error: 'list failed' }))
      return
    }
    // ── Session migration (must be before clientSessMatch regex which would capture "unclaimed"/"claim") ──
    if (url.pathname === '/api/sessions/unclaimed' && req.method === 'GET') {
      listUnclaimedSessions()
        .then((list) => this.sendJson(res, 200, { sessions: list }))
        .catch(() => this.sendJson(res, 500, { error: 'list failed' }))
      return
    }
    if (url.pathname === '/api/sessions/claim' && req.method === 'POST') {
      const userId = this.getUserId(req)
      this.readBody(req).then(async (body) => {
        const { sessionIds } = JSON.parse(body) as { sessionIds: string[] }
        if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
          this.sendJson(res, 400, { error: 'sessionIds required' })
          return
        }
        const results: Record<string, boolean> = {}
        for (const sid of sessionIds) {
          results[sid] = await claimSession(sid, userId)
        }
        this.sendJson(res, 200, { ok: true, results })
      }).catch(() => this.sendJson(res, 400, { error: 'invalid body' }))
      return
    }
    const clientSessMatch = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]{8,50})$/)
    if (clientSessMatch) {
      const sessId = clientSessMatch[1]
      const userId = this.getUserId(req)
      if (req.method === 'GET') {
        getClientSession(sessId, userId)
          .then((s) => s ? this.sendJson(res, 200, s) : this.sendJson(res, 404, { error: 'not found' }))
          .catch(() => this.sendJson(res, 500, { error: 'get failed' }))
        return
      }
      if (req.method === 'PUT') {
        this.readBody(req).then(async (body) => {
          const data = JSON.parse(body)
          const updatedAt = Date.now()
          const applied = await upsertClientSession({
            id: sessId,
            userId,
            agentId: data.agentId || 'main',
            title: data.title || '新会话',
            pinned: !!data.pinned,
            createdAt: data.createdAt || Date.now(),
            lastAt: data.lastAt || Date.now(),
            messages: data.messages || [],
            updatedAt,
          }, data._baseSyncedAt || 0)
          if (!applied) {
            this.sendJson(res, 409, { error: 'conflict' })
          } else {
            this.sendJson(res, 200, { ok: true, applied: true, updatedAt })
          }
        }).catch(() => this.sendJson(res, 400, { error: 'invalid body' }))
        return
      }
      if (req.method === 'DELETE') {
        deleteClientSession(sessId, userId)
          .then(() => this.sendJson(res, 200, { ok: true }))
          .catch(() => this.sendJson(res, 500, { error: 'delete failed' }))
        return
      }
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
    // ── Changelog / Release Notes ──
    if (url.pathname === '/api/changelog' && req.method === 'GET') {
      const changelogPath = join(paths.home, 'changelog.json')
      try {
        const raw = readFileSync(changelogPath, 'utf-8')
        const data = JSON.parse(raw)
        this.sendJson(res, 200, data)
      } catch {
        this.sendJson(res, 200, { currentVersion: '0.0.0', releases: [] })
      }
      return
    }

    // ── User Feedback ──
    if (url.pathname === '/api/feedback' && req.method === 'POST') {
      this.readBody(req).then(async (body) => {
        try {
          const { category, description, sessionId, userAgent } = JSON.parse(body)
          if (!description || typeof description !== 'string' || description.trim().length < 15) {
            this.sendJson(res, 400, { error: '反馈描述至少需要 15 个字符' }); return
          }
          const feedbackDir = join(paths.home, 'feedback')
          await mkdir(feedbackDir, { recursive: true })
          const entry = {
            id: `fb-${Date.now()}-${randomBytes(4).toString('hex')}`,
            category: category || 'general',
            description,
            sessionId: sessionId || null,
            userAgent: userAgent || null,
            userId: this.getUserId(req),
            createdAt: new Date().toISOString(),
          }
          const filePath = join(feedbackDir, `${entry.id}.json`)
          await writeFile(filePath, JSON.stringify(entry, null, 2))
          this.sendJson(res, 200, { ok: true, id: entry.id })
        } catch (err) {
          this.sendJson(res, 400, { error: String(err) })
        }
      }).catch(() => this.sendJson(res, 400, { error: 'invalid body' }))
      return
    }
    if (url.pathname === '/api/feedback' && req.method === 'GET') {
      const feedbackDir = join(paths.home, 'feedback')
      const userId = this.getUserId(req)
      try {
        const files = existsSync(feedbackDir)
          ? readdirSync(feedbackDir).filter(f => f.endsWith('.json')).sort().reverse()
          : []
        const items: unknown[] = []
        for (const f of files) {
          if (items.length >= 50) break
          try {
            const entry = JSON.parse(readFileSync(join(feedbackDir, f), 'utf-8'))
            if (entry && entry.userId === userId) items.push(entry)
          } catch { /* skip corrupt files */ }
        }
        this.sendJson(res, 200, { feedback: items })
      } catch {
        this.sendJson(res, 200, { feedback: [] })
      }
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

    // ── WeChat (iLink) bot binding ──
    // Multi-tenant: each OC user can bind their own WeChat bot via QR scan.
    //   POST   /api/wechat/pair/start            → { qrcode, qrcodeImgContent }
    //   POST   /api/wechat/pair/poll  {qrcode}   → { status, accountId?, loginUserId? }
    //   GET    /api/wechat/binding               → { binding: {...} | null }
    //   DELETE /api/wechat/binding               → { ok: true }
    //   PUT    /api/wechat/binding/status        → { ok, status }
    if (url.pathname.startsWith('/api/wechat/')) {
      this._handleWechat(req, res, url.pathname).catch((err) =>
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
      let filename: string
      try {
        filename = decodeURIComponent(mediaMatch[1])
      } catch {
        res.writeHead(400)
        res.end('bad request')
        return
      }
      // Reject path traversal attempts (../ or absolute paths)
      if (filename.includes('..') || filename.startsWith('/') || filename.startsWith('\\')) {
        res.writeHead(400)
        res.end('bad request')
        return
      }
      // Search in uploads first, then generated. Resolve via realpath so a
      // symlink inside uploads/ cannot escape the directory.
      const dirs = [paths.uploadsDir, paths.generatedDir]
      let realPath: string | null = null
      for (const dir of dirs) {
        const baseReal = resolve(dir)
        const candidate = resolve(dir, filename)
        if (!candidate.startsWith(baseReal + '/') && candidate !== baseReal) continue
        try {
          const r = realpathSync(candidate)
          if (r.startsWith(baseReal + '/')) {
            realPath = r
            break
          }
        } catch {}
      }
      if (!realPath) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const agentCwds = this.deps.agentsConfig.agents
        .map((a) => a.cwd)
        .filter((c): c is string => !!c)
      // After realpath resolution, the path is already inside uploads/ or
      // generated/; both are static FILE_ALLOWED_DIRS entries, so
      // isFileAllowed returns true unconditionally. But do the blocklist
      // check — someone could drop a .env into uploads/.
      if (isFileBlocked(realPath)) {
        res.writeHead(403)
        res.end('access denied')
        return
      }
      const fd = this.openFileHardened(res, realPath, agentCwds)
      if (fd === null) return
      let mediaStat: ReturnType<typeof fstatSync>
      try {
        mediaStat = fstatSync(fd)
      } catch {
        closeSync(fd)
        res.writeHead(404)
        res.end('not found')
        return
      }
      if (!mediaStat.isFile()) {
        closeSync(fd)
        res.writeHead(404)
        res.end('not found')
        return
      }
      const mediaContentType = mimeFor(realPath)
      // C3: Force download for active content types to prevent same-origin script execution
      const mediaHeaders: Record<string, string | number> = {
        'Content-Type': mediaContentType,
        'Content-Length': mediaStat.size,
        'Cache-Control': 'private, max-age=3600',
      }
      if (isActiveContentType(mediaContentType)) {
        mediaHeaders['Content-Disposition'] = `attachment; filename="${encodeURIComponent(basename(realPath) || 'file')}"`
      }
      res.writeHead(200, mediaHeaders)
      createReadStream(null as unknown as string, { fd, autoClose: true }).pipe(res)
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
      // v3 file proxy hardening: use realpath (not resolve) so symlinks in the
      // *path text* are resolved to their canonical target BEFORE allowlist
      // check. Without this, a symlink /root/.openclaude/generated/foo →
      // /root/openclaude.json would pass isFileAllowed (text startsWith check)
      // and leak the config.
      const resolved = resolve(filePath)
      let realPath: string
      try {
        realPath = realpathSync(resolved)
      } catch {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const agentCwds = this.deps.agentsConfig.agents
        .map((a) => a.cwd)
        .filter((c): c is string => !!c)
      if (!isFileAllowed(realPath, agentCwds)) {
        this.log.warn('api/file denied (not in allowlist)', { path: realPath })
        res.writeHead(403)
        res.end('access denied')
        return
      }
      if (isFileBlocked(realPath)) {
        this.log.warn('api/file blocked sensitive', { path: realPath })
        res.writeHead(403)
        res.end('access denied')
        return
      }
      // fd-based open (O_NOFOLLOW + /proc/self/fd realpath check) closes the
      // middle-directory swap race; see openFileHardened().
      const fd = this.openFileHardened(res, realPath, agentCwds)
      if (fd === null) return
      let fileStat: ReturnType<typeof fstatSync>
      try {
        fileStat = fstatSync(fd)
      } catch {
        closeSync(fd)
        res.writeHead(404)
        res.end('not found')
        return
      }
      if (!fileStat.isFile()) {
        closeSync(fd)
        res.writeHead(404)
        res.end('not found')
        return
      }
      const fileContentType = mimeFor(realPath)
      // C3: Force download for active content types to prevent same-origin script execution
      const fileDispositionMode = isActiveContentType(fileContentType) ? 'attachment' : 'inline'
      res.writeHead(200, {
        'Content-Type': fileContentType,
        'Content-Length': fileStat.size,
        'Cache-Control': 'private, max-age=3600',
        'Content-Disposition': `${fileDispositionMode}; filename="${encodeURIComponent(basename(realPath) || 'file')}"`,
      })
      createReadStream(null as unknown as string, { fd, autoClose: true }).pipe(res)
      return
    }

    // 静态 web UI (with in-memory cache)
    if (this.deps.webRoot) {
      const safePath = url.pathname === '/' ? '/index.html' : url.pathname
      // sw.js must never be edge-cached: SW versioning depends on browser
      // re-fetching the new file on every page load. CF defaults to a 4h TTL
      // which strands users on stale SW for hours. (See feedback memory
      // v3_static_cache_trap.md.)
      const cacheHeader = safePath === '/sw.js' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600'
      const filePath = resolve(this.deps.webRoot, `.${safePath}`)
      if (filePath.startsWith(resolve(this.deps.webRoot))) {
        const cached = this._staticFileCache.get(filePath)
        if (cached) {
          if (req.headers['if-none-match'] === cached.etag) {
            res.writeHead(304)
            res.end()
            return
          }
          res.writeHead(200, { 'Content-Type': cached.mime, 'ETag': cached.etag, 'Cache-Control': cacheHeader })
          res.end(cached.content)
          return
        }
        try {
          const s = statSync(filePath)
          if (s.isFile()) {
            const content = readFileSync(filePath)
            const mime = mimeFor(filePath)
            const etag = `"${createHash('md5').update(content).digest('hex').slice(0, 16)}"`
            if (this._staticFileCache.size >= 200) {
              const firstKey = this._staticFileCache.keys().next().value
              if (firstKey !== undefined) this._staticFileCache.delete(firstKey)
            }
            this._staticFileCache.set(filePath, { content, mime, etag })
            if (req.headers['if-none-match'] === etag) {
              res.writeHead(304)
              res.end()
              return
            }
            res.writeHead(200, { 'Content-Type': mime, 'ETag': etag, 'Cache-Control': cacheHeader })
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
          if (req.headers['if-none-match'] === cachedIndex.etag) {
            res.writeHead(304)
            res.end()
            return
          }
          res.writeHead(200, { 'Content-Type': 'text/html', 'ETag': cachedIndex.etag, 'Cache-Control': 'no-cache' })
          res.end(cachedIndex.content)
          return
        }
        try {
          const s = statSync(indexPath)
          if (s.isFile()) {
            const content = readFileSync(indexPath)
            const etag = `"${createHash('md5').update(content).digest('hex').slice(0, 16)}"`
            if (this._staticFileCache.size >= 200) {
              const firstKey = this._staticFileCache.keys().next().value
              if (firstKey !== undefined) this._staticFileCache.delete(firstKey)
            }
            this._staticFileCache.set(indexPath, { content, mime: 'text/html', etag })
            if (req.headers['if-none-match'] === etag) {
              res.writeHead(304)
              res.end()
              return
            }
            res.writeHead(200, { 'Content-Type': 'text/html', 'ETag': etag, 'Cache-Control': 'no-cache' })
            res.end(content)
            return
          }
        } catch {}
      }
    }
    res.writeHead(404)
    res.end('not found')
  }

  /** Extract bearer token from request (header, WS protocol, or cookie). */
  private extractToken(req: IncomingMessage): string {
    const authHeader = req.headers.authorization?.replace(/^Bearer\s+/, '') ?? ''
    const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim())
    const protoToken =
      protocols.includes('bearer') && protocols.length >= 2 ? protocols[protocols.length - 1] : ''
    const cookies = (req.headers.cookie || '').split(';').reduce(
      (acc, c) => {
        const [k, ...v] = c.trim().split('=')
        if (k) acc[k] = v.join('=')
        return acc
      },
      {} as Record<string, string>,
    )
    const cookieToken = cookies.oc_session || ''
    return authHeader || protoToken || cookieToken
  }

  private checkHttpAuth(req: IncomingMessage): boolean {
    const t = this.extractToken(req)
    // Try JWT first (multi-user mode)
    const jwt = verifyJwt(t, this.deps.config.gateway.accessToken)
    if (jwt) return true
    // V3 commercial: accept JWTs signed by commercial module's jwtSecret too,
    // otherwise paths that fall through to gateway (e.g. /api/agents,
    // /api/sessions/*, /api/changelog) would 401 right after a successful
    // commercial login and trigger a token-expired redirect storm.
    if (this.verifyCommercialJwt(t) !== null) return true
    // Fall back to legacy single token
    return checkToken(t, this.deps.config.gateway.accessToken)
  }

  /**
   * v3 file proxy: check whether this HTTP request is a valid HOST→container
   * bridge call for /api/file or /api/media/*. When true, the normal
   * checkHttpAuth() requirement is bypassed.
   *
   * All four conditions MUST hold:
   *  1. remote IP === OPENCLAUDE_TRUST_BRIDGE_IP (host in docker bridge)
   *  2. method ∈ {GET, HEAD} AND path ∈ {/api/file, /api/media/*}
   *  3. X-OpenClaude-Container-Id === env.OC_CONTAINER_ID (binding)
   *  4. timingSafeEqual(X-OpenClaude-Bridge-Nonce, env.OC_BRIDGE_NONCE)
   *
   * Container side doesn't know the HOST's HMAC rootSecret — only its own
   * per-container nonce (HMAC(rootSecret, containerId)) injected at start.
   */
  private checkBridgeBypass(req: IncomingMessage, url: URL): boolean {
    const TRUST_BRIDGE_IP = process.env.OPENCLAUDE_TRUST_BRIDGE_IP || ''
    const OC_CONTAINER_ID = process.env.OC_CONTAINER_ID || ''
    const OC_BRIDGE_NONCE = process.env.OC_BRIDGE_NONCE || ''
    if (!TRUST_BRIDGE_IP || !OC_CONTAINER_ID || !OC_BRIDGE_NONCE) return false
    // Codex R1/R2 SHOULD-3:形态校验与 /healthz 保持一致,防止 env 写错时 bypass 只
    // 看非空就放行(healthz 广播 ready 但 bypass 因细节 reject 会造成哑锁)。
    // 用 net.isIPv4 严格校验,不用松正则 —— out-of-range octet 也要拒。
    if (!isIPv4(TRUST_BRIDGE_IP)) return false
    if (!/^[1-9][0-9]{0,18}$/.test(OC_CONTAINER_ID)) return false
    if (!/^[0-9a-f]{64}$/i.test(OC_BRIDGE_NONCE)) return false
    const remoteIp = req.socket.remoteAddress || ''
    if (remoteIp !== TRUST_BRIDGE_IP && remoteIp !== `::ffff:${TRUST_BRIDGE_IP}`) return false
    const m = req.method || ''
    if (m !== 'GET' && m !== 'HEAD') return false
    const p = url.pathname
    if (p !== '/api/file' && !p.startsWith('/api/media/')) return false
    const hdrId = String(req.headers['x-openclaude-container-id'] ?? '').trim()
    if (hdrId !== OC_CONTAINER_ID) return false
    const hdrNonce = String(req.headers['x-openclaude-bridge-nonce'] ?? '').trim()
    if (!/^[0-9a-f]{64}$/i.test(hdrNonce)) return false
    if (hdrNonce.length !== OC_BRIDGE_NONCE.length) return false
    try {
      return timingSafeEqual(Buffer.from(hdrNonce, 'hex'), Buffer.from(OC_BRIDGE_NONCE, 'hex'))
    } catch {
      return false
    }
  }

  /**
   * v3 file proxy: open a file with TOCTOU-hardened realpath checking.
   * Callers must have already verified `realPath` against allowlist/blocklist.
   *
   *  - openSync(O_NOFOLLOW): last-component symlink defense.
   *  - realpathSync(/proc/self/fd/<fd>) === realPath: middle-directory
   *    symlink race defense. An attacker who swaps a parent directory
   *    between our allowlist check and open() will show up here with
   *    fdReal ≠ realPath.
   *  - isFileAllowed/isFileBlocked re-checked on fdReal as fail-closed
   *    defense (redundant but cheap).
   *
   * Returns an fd on success; writes 403/404 to res and returns null on failure.
   */
  private openFileHardened(
    res: ServerResponse,
    realPath: string,
    agentCwds: string[],
  ): number | null {
    let fd: number
    try {
      fd = openSync(realPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    } catch {
      res.writeHead(404)
      res.end('not found')
      return null
    }
    let fdReal: string
    try {
      fdReal = realpathSync(`/proc/self/fd/${fd}`)
    } catch {
      closeSync(fd)
      res.writeHead(404)
      res.end('not found')
      return null
    }
    if (fdReal !== realPath || !isFileAllowed(fdReal, agentCwds) || isFileBlocked(fdReal)) {
      closeSync(fd)
      res.writeHead(403)
      res.end('access denied')
      return null
    }
    return fd
  }

  /** Get authenticated userId from request. Returns 'default' for legacy token auth. */
  private getUserId(req: IncomingMessage): string {
    const t = this.extractToken(req)
    const jwt = verifyJwt(t, this.deps.config.gateway.accessToken)
    if (jwt?.userId) return jwt.userId
    // Commercial JWT: prefix sub (BIGINT user_id as string) so it cannot
    // collide with personal-version userIds (which are arbitrary usernames).
    // Used as partition key for SQLite client_sessions etc.
    const cm = this.verifyCommercialJwt(t)
    if (cm) return `c:${cm.sub}`
    return 'default'
  }

  /**
   * Verify an HS256 JWT signed by the commercial module's jwtSecret.
   * Synchronous (uses node:crypto) so we don't have to make checkHttpAuth /
   * getUserId async — those are called from many spots in this file and
   * propagating async would balloon the diff.
   *
   * Accepts payload shape: { sub: string, role: 'user'|'admin', iat, exp, jti }.
   * Returns null on any verification failure (bad alg, bad sig, expired,
   * malformed payload, or commercial module not loaded).
   */
  private verifyCommercialJwt(token: string): { sub: string; role: 'user' | 'admin'; exp: number } | null {
    if (!token || !this.deps.commercial?.jwtSecret) return null
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [headerB64, payloadB64, sigB64] = parts
    let header: any
    try { header = JSON.parse(Buffer.from(headerB64, 'base64url').toString()) } catch { return null }
    if (header?.alg !== 'HS256') return null
    let actualSig: Buffer
    try { actualSig = Buffer.from(sigB64, 'base64url') } catch { return null }
    const expectedSig = createHmac('sha256', this.deps.commercial.jwtSecret).update(`${headerB64}.${payloadB64}`).digest()
    if (expectedSig.length !== actualSig.length) return null
    if (!timingSafeEqual(expectedSig, actualSig)) return null
    let payload: any
    try { payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) } catch { return null }
    const now = Math.floor(Date.now() / 1000)
    if (typeof payload?.exp !== 'number' || payload.exp <= now) return null
    if (typeof payload?.sub !== 'string' || payload.sub.length === 0) return null
    if (payload.role !== 'user' && payload.role !== 'admin') return null
    return { sub: payload.sub, role: payload.role, exp: payload.exp }
  }

  /** Get userId stashed on a WS at handshake time. Falls back to 'default' if
   *  the WS was created before this field existed (hot-reload / legacy client). */
  private getWsUserId(ws: WebSocket): string {
    const uid = (ws as any)._userId
    return typeof uid === 'string' && uid.length > 0 ? uid : 'default'
  }

  /** Build a broadcast routing key. Historically `${channel}:${peerId}` only;
   *  userId dimension added 2026-04-19 so two users sharing a (client-generated,
   *  non-unique) peerId cannot receive each other's broadcasts. Individual
   *  clients are already scoped by userId via SQLite `client_sessions`, but
   *  WS-layer `clientsByPeer` wasn't — this closes that gap. */
  private static makePeerKey(userId: string, channel: string, peerId: string): string {
    return `${userId}:${channel}:${peerId}`
  }

  /** Check if the request arrived over HTTPS (direct TLS or behind a trusted reverse proxy like cloudflared).
   * X-Forwarded-Proto is only trusted when the connection originates from a loopback address (127.0.0.1 / ::1),
   * i.e. a local reverse proxy. External connections must use direct TLS.
   */
  private isHttps(req: IncomingMessage): boolean {
    if ((req.socket as any).encrypted === true) return true
    const remoteAddr = req.socket.remoteAddress ?? ''
    // Trust X-Forwarded-Proto only from loopback (127.x.x.x, ::1, IPv4-mapped ::ffff:127.x.x.x)
    const isLoopback = remoteAddr === '::1' || remoteAddr.startsWith('127.') || remoteAddr.startsWith('::ffff:127.')
    return isLoopback && req.headers['x-forwarded-proto'] === 'https'
  }

  /** Session token lifetime — used for JWT issuance and legacy-mode cookie cap.
   *  Kept in one place so JWT TTL and cookie Max-Age can't drift. */
  private static readonly JWT_TTL_SECONDS = 30 * 86400 // 30 days

  /** Set HttpOnly session cookie on response — stores the verified auth token so
   *  <img src="/api/file/...">, <audio>, <video> can access protected media on
   *  the same origin without JS-supplied headers.
   *
   *  Rules:
   *   - JWT mode: store the JWT verbatim (preserves userId); Max-Age tracks the
   *     JWT's remaining exp so the cookie can never outlive its token, avoiding
   *     silent 401 storms on subresource requests. Floored at 60s to avoid
   *     setting an already-dead cookie on the same response that just authed.
   *   - Legacy raw-token mode: store the raw accessToken; Max-Age capped at
   *     JWT_TTL_SECONDS since the raw token has no server-side revocation.
   *   - Otherwise (e.g. JWT just expired in the microsecond race between
   *     checkHttpAuth and here): refuse. We do NOT silently downgrade a JWT
   *     user's identity into the shared 'default' raw-token principal; caller
   *     sees `false` and returns 401 so the client can re-login cleanly.
   *
   *  Returns true if a cookie was set; false if the caller should 401. */
  private setSessionCookie(res: ServerResponse, req: IncomingMessage): boolean {
    const t = this.extractToken(req)
    const secure = this.isHttps(req) ? '; Secure' : ''

    const jwt = verifyJwt(t, this.deps.config.gateway.accessToken)
    if (jwt && typeof jwt.exp === 'number') {
      // Clamp remaining seconds to [60, JWT_TTL_SECONDS]. Max-Age=0 semantically
      // means "delete cookie"; a positive floor keeps the cookie alive long
      // enough for the client to renew or get a clean 401 on the next request.
      const remaining = jwt.exp - Math.floor(Date.now() / 1000)
      const maxAge = Math.max(60, Math.min(remaining, Gateway.JWT_TTL_SECONDS))
      res.setHeader(
        'Set-Cookie',
        `oc_session=${t}; HttpOnly; SameSite=Strict${secure}; Path=/api/; Max-Age=${maxAge}`,
      )
      return true
    }
    if (checkToken(t, this.deps.config.gateway.accessToken)) {
      // Legacy raw-token auth. `t` is constant-time equal to the configured
      // accessToken (which came from trusted config), so it's safe to echo
      // into Set-Cookie without further sanitization.
      res.setHeader(
        'Set-Cookie',
        `oc_session=${t}; HttpOnly; SameSite=Strict${secure}; Path=/api/; Max-Age=${Gateway.JWT_TTL_SECONDS}`,
      )
      return true
    }
    // V3 commercial JWT — same Max-Age clamping logic as personal-version JWT.
    const cm = this.verifyCommercialJwt(t)
    if (cm) {
      const remaining = cm.exp - Math.floor(Date.now() / 1000)
      const maxAge = Math.max(60, Math.min(remaining, Gateway.JWT_TTL_SECONDS))
      res.setHeader(
        'Set-Cookie',
        `oc_session=${t}; HttpOnly; SameSite=Strict${secure}; Path=/api/; Max-Age=${maxAge}`,
      )
      return true
    }
    return false
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
    this.log.info('inter-agent message', {
      sourceAgent,
      targetAgentId,
      preview: message.slice(0, 60),
    })

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
      // Route through deliver() so the ts-stamp happens centrally — bypass here
      // would let inter-agent replies slip past the web client's stale-final guard.
      this.deliver({
        type: 'outbound.message' as const,
        sessionKey: lastActive.sessionKey || `agent:${targetAgentId}:inter:dm:${sourceAgent}`,
        channel: 'webchat' as const,
        peer: { id: lastActive.peerId, kind: 'dm' as const },
        blocks: [
          { kind: 'text' as const, text: `📨 **${targetAgentId}** 回复:\n\n${output.trim()}` },
        ],
        isFinal: true,
        _userId: lastActive.userId,
      } as OutboundMessage)
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
    this.log.info('delegate', {
      sourceAgent,
      targetAgentId,
      goalPreview: goal.slice(0, 60),
      depth,
    })

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

    eventBus.emit('agent.completed', createEvent('agent.completed', targetAgentId, {
      sessionKey,
      output: output.trim(),
      error: error || undefined,
    }))

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

  private async _handleWechat(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const userId = this.getUserId(req)
    // 来自 config;enabled=false 时 manager 从未启动(gateway.ts:88 直接跳过 import)
    // 此时禁止 pair/* 等会真正调上游 iLink 的写操作,避免用户扫完码绑定成功 —
    // 实际 worker 没跑 — UI 显示 active 误导用户(生产踩过坑,audit P0-1)。
    // GET/DELETE binding 仍放行,让用户看到/清理残留。
    const wechatEnabled = Boolean(
      (this.deps.config.channels as any)?.wechat?.enabled,
    )
    const isPairingWrite =
      (pathname === '/api/wechat/pair/start' && req.method === 'POST') ||
      (pathname === '/api/wechat/pair/poll' && req.method === 'POST') ||
      (pathname === '/api/wechat/pair/cancel' && req.method === 'POST') ||
      (pathname === '/api/wechat/binding/status' && req.method === 'PUT')
    if (!wechatEnabled && isPairingWrite) {
      this.sendJson(res, 409, {
        error: {
          code: 'WECHAT_DISABLED',
          message: '服务端暂未启用微信通道,请联系管理员',
        },
      })
      return
    }

    // Lazy import so the gateway doesn't pull in qrcode/iLink deps unless the
    // WeChat channel is wired up. Importing a workspace package is ~free in
    // Bun — this is purely to avoid hard-coupling the gateway to it.
    let pairing: any
    try {
      pairing = await import('@openclaude/channel-wechat' as any)
    } catch (err) {
      this.sendJson(res, 503, {
        error: {
          code: 'WECHAT_UNAVAILABLE',
          message: '@openclaude/channel-wechat not available: ' + String(err),
        },
      })
      return
    }
    const {
      startPairing,
      resumePairing,
      cancelPairing,
    } = pairing as typeof import('@openclaude/channel-wechat')

    const {
      getWechatBindingByUserId,
      deleteWechatBinding,
      updateWechatBindingStatus,
    } = await import('@openclaude/storage')

    // ── POST /api/wechat/pair/start ──
    if (pathname === '/api/wechat/pair/start' && req.method === 'POST') {
      try {
        const { qrcode, qrcodeImgContent } = await startPairing(userId)
        this.sendJson(res, 200, { qrcode, qrcodeImgContent })
      } catch (err: any) {
        this.sendError(res, 502, `QR fetch failed: ${err?.message || err}`)
      }
      return
    }

    // ── POST /api/wechat/pair/poll {qrcode} ──
    // Long-poll shim: wechat server itself long-polls ~35s; we just relay.
    if (pathname === '/api/wechat/pair/poll' && req.method === 'POST') {
      try {
        const body = await this.readBody(req)
        const { qrcode } = JSON.parse(body || '{}') as { qrcode?: string }
        if (!qrcode) {
          this.sendError(res, 400, 'qrcode required')
          return
        }
        const status = await resumePairing(userId, qrcode)
        this.sendJson(res, 200, status)
      } catch (err: any) {
        this.sendError(res, 500, `poll failed: ${err?.message || err}`)
      }
      return
    }

    // ── POST /api/wechat/pair/cancel {qrcode} ──
    if (pathname === '/api/wechat/pair/cancel' && req.method === 'POST') {
      try {
        const body = await this.readBody(req)
        const { qrcode } = JSON.parse(body || '{}') as { qrcode?: string }
        if (qrcode) cancelPairing(qrcode)
        this.sendJson(res, 200, { ok: true })
      } catch {
        this.sendJson(res, 200, { ok: true })
      }
      return
    }

    // ── GET /api/wechat/binding ──
    if (pathname === '/api/wechat/binding' && req.method === 'GET') {
      const b = await getWechatBindingByUserId(userId)
      if (!b) {
        // binding=null 时仍要带 channel_enabled,前端 wechat.js 用这个值决定
        // 是否渲染"服务端暂未启用微信通道"红字提示(否则 enabled=false 下点
        // 开始按钮才 409,UX 差 —— Codex R2 IMPORTANT#2)
        this.sendJson(res, 200, { binding: null, channel_enabled: wechatEnabled })
        return
      }
      // worker_running:enabled × manager 实际持有该用户的 worker 才算 true。
      // enabled=false → 必 false;enabled=true 但 manager 没起 worker(新绑定
      // 还没过 reconcile 或 init 失败)→ false。前端据此显示"通道未启用/消息收不到"。
      // 读 adapter 时用 duck-typed 方法访问(manager.ts 暴露 isWorkerRunning),
      // 避免污染 plugin-sdk 的 ChannelAdapter 公共接口。
      const adapter = this.channels.get('wechat') as unknown as
        | { isWorkerRunning?: (uid: string) => boolean }
        | undefined
      const workerRunning =
        wechatEnabled &&
        b.status === 'active' &&
        typeof adapter?.isWorkerRunning === 'function' &&
        adapter.isWorkerRunning(userId) === true
      // Redact bot_token from client view
      this.sendJson(res, 200, {
        binding: {
          accountId: b.accountId,
          loginUserId: b.loginUserId,
          status: b.status,
          createdAt: b.createdAt,
          updatedAt: b.updatedAt,
          lastEventAt: b.lastEventAt,
          worker_running: workerRunning,
        },
        channel_enabled: wechatEnabled,
      })
      return
    }

    // ── DELETE /api/wechat/binding ──
    if (pathname === '/api/wechat/binding' && req.method === 'DELETE') {
      await deleteWechatBinding(userId)
      this.sendJson(res, 200, { ok: true })
      return
    }

    // ── PUT /api/wechat/binding/status {status} ──
    if (pathname === '/api/wechat/binding/status' && req.method === 'PUT') {
      try {
        const body = await this.readBody(req)
        const { status } = JSON.parse(body || '{}') as { status?: string }
        if (status !== 'active' && status !== 'disabled') {
          this.sendError(res, 400, 'status must be active or disabled')
          return
        }
        await updateWechatBindingStatus(userId, status)
        this.sendJson(res, 200, { ok: true, status })
      } catch (err: any) {
        this.sendError(res, 500, String(err?.message || err))
      }
      return
    }

    this.sendError(res, 404, 'wechat route not found')
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
        this.log.error('task manual trigger failed', { taskId }, err),
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
    this.log.info('oauth exchanging code', { provider: providerKey, codeLen: cleanCode.length })

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
        this.log.error('oauth token exchange failed', {
          provider: providerKey,
          status: tokenRes.status,
          body: errText,
        })
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
        this.log.info('oauth tokens saved', { provider: providerKey })
      }

      this.sendJson(res, 200, {
        ok: true,
        expiresIn: tokens.expires_in,
        scope: tokens.scope,
      })
    } catch (err: any) {
      this.log.error('oauth exchange error', { provider: providerKey }, err)
      this.sendError(res, 500, err?.message ?? 'token exchange failed')
    }
  }

  // Token auto-refresh (called periodically and on-demand after 401).
  // Dedup: concurrent calls share one in-flight refresh to avoid stampede.
  // If a non-forced refresh is in-flight and a forced one is requested,
  // we chain the forced refresh after the current one completes.
  private _refreshPromise: Promise<void> | null = null
  private _refreshForced = false

  private refreshClaudeOAuthIfNeeded(force = false): Promise<void> {
    if (this._refreshPromise) {
      if (force && !this._refreshForced) {
        // Upgrade: chain a forced refresh after the in-flight non-forced one
        this._refreshForced = true
        this._refreshPromise = this._refreshPromise
          .then(() => this._refreshClaudeOAuthImpl(true))
      }
      return this._refreshPromise
    }
    this._refreshForced = force
    this._refreshPromise = this._refreshClaudeOAuthImpl(force)
      .finally(() => { this._refreshPromise = null; this._refreshForced = false })
    return this._refreshPromise
  }

  private async _refreshClaudeOAuthImpl(force: boolean): Promise<void> {
    // Try refreshing Claude OAuth
    const claudeOAuth = this.deps.config.auth.claudeOAuth
    if (claudeOAuth?.refreshToken && (force || Date.now() >= claudeOAuth.expiresAt - 5 * 60_000)) {
      await this._refreshToken('claude', claudeOAuth)
    }
    // Try refreshing Codex OAuth
    const codexOAuth = this.deps.config.auth.codexOAuth
    if (codexOAuth?.refreshToken && (force || Date.now() >= codexOAuth.expiresAt - 5 * 60_000)) {
      await this._refreshToken('codex', codexOAuth)
    }
  }

  private async _refreshToken(
    providerKey: string,
    oauth: { refreshToken: string; scope: string; expiresAt: number },
  ): Promise<void> {
    const prov = this.OAUTH_PROVIDERS[providerKey]
    if (!prov || !prov.tokenUrl) {
      this.log.warn('oauth skipping refresh', {
        provider: providerKey,
        reason: !prov ? 'unknown provider' : 'no tokenUrl configured',
      })
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
        this.log.error('oauth refresh failed', { provider: providerKey, status: tokenRes.status })
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
        this.log.info('oauth token refreshed', {
          provider: providerKey,
          expiresInSec: tokens.expires_in,
        })
      }
    } catch (err) {
      this.log.error('oauth refresh error', { provider: providerKey }, err)
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

  private wsClients = new Set<WebSocket>()

  // ───────── WS ─────────
  private handleWsConnection(ws: WebSocket, req: IncomingMessage): void {
    if (this._shuttingDown) {
      try { ws.close(1001, 'shutting down') } catch {}
      return
    }
    // v3 commercial 容器内信任 docker bridge gateway IP 直连。commercial 侧 userChatBridge
    // 经 docker bridge 网络转发的 ws → /ws 不带 bearer(容器随机生成的 accessToken supervisor
    // 没回传)。仅当容器 entrypoint.sh 显式注入 OPENCLAUDE_TRUST_BRIDGE_IP=172.30.0.1 时生效;
    // 个人版 / 任何未配置该 env 的场景下 process.env.OPENCLAUDE_TRUST_BRIDGE_IP 为空,
    // 旁路恒为 false,checkHttpAuth 行为完全不变。
    const remoteIp = req.socket.remoteAddress || ''
    const TRUST_BRIDGE_IP = process.env.OPENCLAUDE_TRUST_BRIDGE_IP || ''
    const isFromBridge = !!TRUST_BRIDGE_IP && (
      remoteIp === TRUST_BRIDGE_IP ||
      remoteIp === `::ffff:${TRUST_BRIDGE_IP}`
    )
    if (!isFromBridge && !this.checkHttpAuth(req)) {
      ws.close(1008, 'unauthorized')
      return
    }
    // Stash authenticated userId on the WS so every subsequent broadcast lookup
    // can scope peerKey by user, preventing cross-account delivery when two
    // users happen to share the same client-generated peerId (see makePeerKey
    // helper). Legacy-token auth returns 'default'.
    ;(ws as any)._userId = this.getUserId(req)
    wsConnectionsTotal.inc()
    this.log.info('ws.connect')
    ws.once('close', () => this.log.debug('ws.disconnect'))

    // Keepalive pong tracking
    ;(ws as any)._isAlive = true
    ws.on('pong', () => {
      ;(ws as any)._isAlive = true
    })

    this.wsClients.add(ws)
    ws.once('close', () => this.wsClients.delete(ws))
    ws.on('message', async (raw) => {
      try {
      let frame: InboundFrame
      try {
        frame = JSON.parse(raw.toString()) as InboundFrame
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'invalid json' }))
        return
      }
      // Client-side keepalive ping — just ignore
      if ((frame as any).type === 'ping') return

      // Hello frame: client identifies its sessions so we can auto-resume.
      // We register the WS into clientsByPeer only for peers that have an
      // active session in the session manager (validated server-side).
      if ((frame as any).type === 'inbound.hello') {
        const hello = frame as any
        // Phase 0.3: peers may carry `lastFrameSeq` — the highest frameSeq
        // this tab successfully processed before the disconnect. 0 = never
        // received one (first connect / localStorage wiped / legacy client).
        const peers: Array<{ peerId: string; agentId: string; inFlight?: boolean; lastFrameSeq?: number }> = hello.peers || []
        // Auto-resume: check if any peer has a resumable session that is NOT already active
        this.autoResumeFromHello(peers, ws).catch((err) =>
          this.log.error('auto-resume failed', undefined, err),
        )
        return
      }

      if (frame.type === 'inbound.message') {
        // Stash userId on the frame so downstream dispatchInbound/deliver
        // paths that don't have the WS in scope can still build the correct
        // per-user peerKey. Private field (leading _), never sent over wire.
        ;(frame as any)._userId = this.getWsUserId(ws)
        // 把 ws client 关联到这个 (channel, peer)
        const peerKey = Gateway.makePeerKey(this.getWsUserId(ws), frame.channel, frame.peer.id)
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
              // Auto-deny all pending permission requests for this peer
              // since no client is available to respond.
              this._autoDenyPendingPermissions(peerKey)
            }
          })
        }
        await this.dispatchInbound(frame)
      } else if (frame.type === 'inbound.control.stop') {
        await this.handleStop(frame)
      } else if ((frame as any).type === 'inbound.permission_response') {
        // Stash userId so handlePermissionResponse can rebuild per-user
        // peerKey on the late-duplicate no-pending-entry fallback path
        // (the only path where we have no server-trusted user identity).
        ;(frame as any)._userId = this.getWsUserId(ws)
        await this.handlePermissionResponse(frame as any)
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
        // Drop the outbound ring when the session is reset. Keeping stale
        // frames around for a now-meaningless sessionKey would be wasteful
        // and could mislead a future reconnect.
        this._outboundRing.clear(sessionKey)
        this.log.info('reset destroyed session', { sessionKey })
      } else if ((frame as any).type === 'control.session.compact') {
        // Compact: send a compaction request to the agent as a user message
        const sessionKey = (frame as any).sessionKey
        if (!sessionKey) return
        const session = this.sessions.getByKey(sessionKey)
        if (!session) {
          ws.send(JSON.stringify({ type: 'error', error: 'session not found' }))
          return
        }
        this.log.info('compact session', { sessionKey })
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
                // Single-ws send (compact progress goes only to the requester),
                // so deliver() isn't appropriate here — stamp ts inline instead
                // so the client's stale-final guard has a monotonic timestamp.
                ws.send(JSON.stringify({ ...out, ts: Date.now() }))
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
                    ts: Date.now(),
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
        this.log.error('ws-message unhandled error', undefined, err)
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
    this.log.info('interrupt', { sessionKey, ok })
  }

  /** Handle permission approval/denial from the web frontend */
  private async handlePermissionResponse(frame: {
    type: 'inbound.permission_response'
    channel: string
    peer: { id: string; kind: 'dm' | 'group' }
    agentId?: string
    requestId: string
    behavior: 'allow' | 'deny'
    message?: string
    /** Optional client-supplied tool input override (currently only used by
     *  AskUserQuestion to carry user-selected `answers` + `annotations`).
     *  Sanitized via `sanitizeAskUserQuestionUpdatedInput` before being
     *  forwarded to CCB; untrusted client fields are dropped. */
    updatedInput?: Record<string, unknown>
  }): Promise<void> {
    // Consume pending first so we can use its authoritative channel/peer/sessionKey
    // instead of trusting the client-supplied frame fields. For the not-found /
    // dead-session branches we fall back to frame.* because we have nothing else.
    const pending = this._pendingPermissions.get(frame.requestId)
    if (!pending) {
      // Race: another tab (or our own /stop / timeout path) settled this
      // requestId first. Replay the authoritative behavior from the recent-
      // settlements map so a 3rd tab that missed the first broadcast doesn't
      // end up labeled with the LATE responder's behavior (which may differ).
      // If we have no record at all (expired / server restarted), fall back
      // to the late responder's own behavior — the only signal we have.
      const prior = this._lookupSettlement(frame.requestId)
      this.log.warn('permission response for unknown/already-settled request', {
        requestId: frame.requestId,
        hasPrior: !!prior,
        lateBehavior: frame.behavior,
      })
      if (prior) {
        // Route the rebroadcast using prior.* (server-trusted) so a late
        // duplicate can't steer the settlement to a peerKey of its choosing.
        const priorPeerKey = Gateway.makePeerKey(prior.userId, prior.channel, prior.peer.id)
        this._broadcastPermissionSettled(priorPeerKey, {
          sessionKey: prior.sessionKey,
          channel: prior.channel,
          peer: prior.peer,
          requestId: frame.requestId,
          behavior: prior.behavior,
          reason: 'already_settled',
          ...(prior.answers ? { answers: prior.answers } : {}),
        })
      } else {
        // No server-side record survives — fall back to frame.* because
        // that's the only signal we have for where to route the settlement.
        // Use the ws-stashed userId (set by the inbound handler) so we don't
        // have to trust a client-supplied userId field.
        const fallbackUserId: string =
          typeof (frame as any)._userId === 'string' ? (frame as any)._userId : 'default'
        const peerKey = Gateway.makePeerKey(fallbackUserId, frame.channel, frame.peer.id)
        this._broadcastPermissionSettled(peerKey, {
          sessionKey: '',
          channel: frame.channel,
          peer: frame.peer,
          requestId: frame.requestId,
          behavior: frame.behavior,
          reason: 'already_settled',
        })
      }
      return
    }
    this._pendingPermissions.delete(frame.requestId)

    const session = this.sessions.getByKey(pending.sessionKey)
    if (!session) {
      this.log.warn('permission response for dead session', { sessionKey: pending.sessionKey })
      // Session is gone, but tabs still hold the modal — clear them.
      // Record the authoritative deny so any late duplicate rebroadcasts deny.
      // Use pending.* (server-trusted) instead of frame.* (client-supplied).
      this._recordSettlement(frame.requestId, {
        behavior: 'deny',
        channel: pending.channel,
        peer: pending.peer,
        sessionKey: pending.sessionKey,
        userId: pending.userId,
      })
      this._broadcastPermissionSettled(pending.peerKey, {
        sessionKey: pending.sessionKey,
        channel: pending.channel,
        peer: pending.peer,
        requestId: frame.requestId,
        behavior: 'deny',
        reason: 'disconnect',
      })
      return
    }
    // Build the updatedInput that will be passed to CCB.
    // Default: preserve original input so CCB doesn't receive an empty object.
    // Tool-specific exception: AskUserQuestion lets the client merge in
    // `answers` / `annotations` — we validate & whitelist them first so a
    // compromised client can't inject arbitrary keys into the tool payload.
    //
    // `effectiveBehavior` starts at frame.behavior but can be downgraded to
    // 'deny' if the AskUserQuestion sanitizer finds nothing usable in the
    // client-supplied updatedInput. Silently allowing an empty-answers
    // AskUserQuestion turn would pass the tool call through with zero
    // answers and leave the model wondering what the user said — far
    // harder to diagnose than an explicit deny.
    let forwardedInput: Record<string, unknown> = pending.input
    let effectiveBehavior: 'allow' | 'deny' = frame.behavior
    let effectiveMessage = frame.message
    // AskUserQuestion allow *requires* valid client-supplied answers. If the
    // client forgot to send updatedInput (buggy tab), sent a non-object, or
    // sent one whose fields all fail whitelist, we must downgrade to deny —
    // otherwise CCB receives an empty-answers AskUserQuestion turn and the
    // model has no idea why the user didn't answer. We run this branch
    // *unconditionally* when the tool is AskUserQuestion + behavior=allow;
    // the sanitizer itself handles every shape of bad input.
    if (frame.behavior === 'allow' && pending.toolName === 'AskUserQuestion') {
      const rawCandidate =
        frame.updatedInput && typeof frame.updatedInput === 'object' && !Array.isArray(frame.updatedInput)
          ? frame.updatedInput
          : {}
      const sanitized = sanitizeAskUserQuestionUpdatedInput(pending.input, rawCandidate)
      if (sanitized === null) {
        this.log.warn('AskUserQuestion allow without valid answers — denying', {
          requestId: frame.requestId,
          receivedUpdatedInput: typeof frame.updatedInput,
        })
        effectiveBehavior = 'deny'
        effectiveMessage = 'No valid answers supplied'
      } else {
        forwardedInput = sanitized
      }
    }
    const response = effectiveBehavior === 'allow'
      ? { behavior: 'allow' as const, updatedInput: forwardedInput, toolUseID: pending.toolUseId }
      : { behavior: 'deny' as const, message: effectiveMessage || 'User denied', toolUseID: pending.toolUseId }
    const ok = session.runner.sendPermissionResponse(frame.requestId, response)
    this.log.info('permission response', {
      requestId: frame.requestId,
      behavior: effectiveBehavior,
      clientBehavior: frame.behavior,
      ok,
      toolName: pending.toolName,
      askUserQuestionMerged:
        pending.toolName === 'AskUserQuestion' && forwardedInput !== pending.input,
    })
    // Record the authoritative result BEFORE broadcasting so any late
    // duplicate response that arrives between here and the broadcast round
    // will see the correct behavior. Use pending.* so late duplicates replay
    // the server-trusted peer identity, not whatever the current client sent.
    // effectiveBehavior may differ from frame.behavior when the AskUserQuestion
    // sanitizer downgraded a malformed allow to deny — record the downgrade
    // so other tabs see the truth.
    //
    // For AskUserQuestion allow we also record + broadcast the sanitized
    // answers so other tabs can fill in their permission card correctly
    // (without having the user re-enter anything) and the sender tab can
    // reconcile its optimistic state if the gateway-visible answers ever
    // differ from what the tab cached locally.
    const settledAnswers =
      effectiveBehavior === 'allow' &&
      pending.toolName === 'AskUserQuestion' &&
      forwardedInput !== pending.input &&
      (forwardedInput as { answers?: unknown }).answers &&
      typeof (forwardedInput as { answers?: unknown }).answers === 'object'
        ? ((forwardedInput as { answers: Record<string, string> }).answers)
        : undefined
    this._recordSettlement(frame.requestId, {
      behavior: effectiveBehavior,
      channel: pending.channel,
      peer: pending.peer,
      sessionKey: pending.sessionKey,
      userId: pending.userId,
      ...(settledAnswers ? { answers: settledAnswers } : {}),
    })
    // Tell every tab attached to this peer (including the sender) that the
    // request is resolved. Other tabs dismiss their stuck prompt with the
    // actual behavior. The sender tab previously treated this as a no-op,
    // but now uses the broadcast to reconcile optimistic state (especially
    // important when the gateway downgraded allow→deny).
    this._broadcastPermissionSettled(pending.peerKey, {
      sessionKey: pending.sessionKey,
      channel: pending.channel,
      peer: pending.peer,
      requestId: frame.requestId,
      behavior: effectiveBehavior,
      reason: 'remote',
      ...(settledAnswers ? { answers: settledAnswers } : {}),
    })
  }

  /** Broadcast a settlement event to all WS clients at a peerKey.
   *  `answers` is only set for AskUserQuestion allow settlements — lets
   *  other tabs render the collected answers in the permission card, and
   *  lets the sender tab keep its optimistic state in sync if we later
   *  switch semantics (e.g. if answers get server-side post-processing). */
  private _broadcastPermissionSettled(
    peerKey: string,
    payload: {
      sessionKey: string
      channel: string
      peer: { id: string; kind: 'dm' | 'group' }
      requestId: string
      behavior: 'allow' | 'deny'
      reason: 'remote' | 'already_settled' | 'disconnect' | 'timeout' | 'crashed'
      answers?: Record<string, string>
    },
  ): void {
    const clients = this.clientsByPeer.get(peerKey)
    if (!clients || clients.size === 0) return
    const frame = JSON.stringify({
      type: 'outbound.permission_settled',
      ...payload,
    })
    for (const ws of clients) {
      try { ws.send(frame) } catch {}
    }
  }

  /** Record an authoritative settlement for later replay to late duplicates.
   *  `answers` is carried so that a 3rd tab hitting the already-settled
   *  replay path still sees the collected AskUserQuestion answers. */
  private _recordSettlement(
    requestId: string,
    entry: {
      behavior: 'allow' | 'deny'
      channel: string
      peer: { id: string; kind: 'dm' | 'group' }
      sessionKey: string
      userId: string
      answers?: Record<string, string>
    },
  ): void {
    // FIFO evict (Map preserves insertion order) to cap memory under burst load.
    while (this._recentSettlements.size >= Gateway.RECENT_SETTLEMENT_MAX) {
      const oldestKey = this._recentSettlements.keys().next().value
      if (oldestKey === undefined) break
      this._recentSettlements.delete(oldestKey)
    }
    this._recentSettlements.set(requestId, { ...entry, ts: Date.now() })
  }

  /** Look up a recent settlement, honoring TTL (returns null if expired). */
  private _lookupSettlement(requestId: string): {
    behavior: 'allow' | 'deny'
    channel: string
    peer: { id: string; kind: 'dm' | 'group' }
    sessionKey: string
    userId: string
    answers?: Record<string, string>
  } | null {
    const e = this._recentSettlements.get(requestId)
    if (!e) return null
    if (Date.now() - e.ts > Gateway.RECENT_SETTLEMENT_TTL_MS) {
      this._recentSettlements.delete(requestId)
      return null
    }
    return {
      behavior: e.behavior,
      channel: e.channel,
      peer: e.peer,
      sessionKey: e.sessionKey,
      userId: e.userId,
      answers: e.answers,
    }
  }

  /** Shared auto-deny + settle + broadcast for one pending permission entry.
   *  Used by disconnect / timeout / session-crash paths. Safe to call on
   *  sessions that no longer exist — the runner-response step silently
   *  skips in that case (the subprocess is already gone). */
  private _forceDenyPendingPermission(
    requestId: string,
    reason: 'disconnect' | 'timeout' | 'crashed',
    denyMessage: string,
  ): boolean {
    const pending = this._pendingPermissions.get(requestId)
    if (!pending) return false
    this._pendingPermissions.delete(requestId)
    const session = this.sessions.getByKey(pending.sessionKey)
    if (session) {
      // sendPermissionResponse swallows its own errors and returns false if
      // the subprocess is gone — `false` is expected on crash/exit paths.
      const ok = session.runner.sendPermissionResponse(requestId, {
        behavior: 'deny',
        message: denyMessage,
        toolUseID: pending.toolUseId,
      })
      this.log.info('auto-denied pending permission', {
        requestId,
        reason,
        runnerAccepted: ok,
      })
    }
    // Record authoritative 'deny' so a late duplicate response (from a
    // reconnecting tab or a redelivered frame) replays the correct result
    // instead of whatever the late responder happens to have sent.
    this._recordSettlement(requestId, {
      behavior: 'deny',
      channel: pending.channel,
      peer: pending.peer,
      sessionKey: pending.sessionKey,
      userId: pending.userId,
    })
    // Broadcast so any still-connected tab dismisses its modal immediately.
    // No-op when no clients remain (e.g. disconnect path).
    this._broadcastPermissionSettled(pending.peerKey, {
      sessionKey: pending.sessionKey,
      channel: pending.channel,
      peer: pending.peer,
      requestId,
      behavior: 'deny',
      reason,
    })
    return true
  }

  /** Auto-deny all pending permission requests associated with a peerKey (on disconnect) */
  private _autoDenyPendingPermissions(peerKey: string): void {
    // Snapshot requestIds first — the helper mutates _pendingPermissions.
    const requestIds: string[] = []
    for (const [requestId, pending] of this._pendingPermissions) {
      if (pending.peerKey === peerKey) requestIds.push(requestId)
    }
    for (const requestId of requestIds) {
      this._forceDenyPendingPermission(requestId, 'disconnect', 'Client disconnected')
    }
  }

  /** Periodic janitor: auto-deny permissions whose wait has exceeded the TTL.
   *  Also cleans up entries whose session no longer exists (subprocess was
   *  evicted or destroyed without going through the crash event path). */
  private _sweepStalePendingPermissions(): void {
    const now = Date.now()
    const toExpire: Array<{ requestId: string; reason: 'timeout' | 'crashed' }> = []
    for (const [requestId, pending] of this._pendingPermissions) {
      if (now >= pending.expiresAt) {
        toExpire.push({ requestId, reason: 'timeout' })
      } else if (!this.sessions.getByKey(pending.sessionKey)) {
        // Orphan: session was evicted/ended without the crash event firing.
        // Treat as "crashed" for the UI — the underlying subprocess is gone.
        toExpire.push({ requestId, reason: 'crashed' })
      }
    }
    if (toExpire.length === 0) return
    for (const { requestId, reason } of toExpire) {
      const msg = reason === 'timeout' ? 'Permission request timed out' : 'Session ended'
      this._forceDenyPendingPermission(requestId, reason, msg)
    }
    this.log.info('pending permission sweep', {
      expired: toExpire.length,
      remaining: this._pendingPermissions.size,
    })
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

      this.log.info('auto-resume pre-warming', { sessionKey })
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
        userId: 'default',
        at: Date.now(),
      })
      this.log.info('auto-resume pre-warmed', { sessionKey })
    }
  }

  private async autoResumeFromHello(
    peers: Array<{ peerId: string; agentId: string; inFlight?: boolean; lastFrameSeq?: number }>,
    ws: WebSocket,
  ): Promise<void> {
    // Register the reconnected WS client for each peer that has an active/resumable session.
    // Security note: the same trust model applies as inbound.message — the gateway
    // access token is the auth boundary; we validate that a session actually exists
    // (active or in resume-map) before registering.
    const registeredPeerKeys: string[] = []
    const helloUserId = this.getWsUserId(ws)

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
              // Pre-warm path still knows the authenticated userId from the
              // reconnected WS (hello). Pass it through so any turn that
              // fires before a fresh inbound.message can still persist via
              // the direct-userId path instead of short-circuiting on
              // getClientSession(peerId).
              userId: helloUserId,
            })
            this.lastActiveChannel.set(aid, {
              channel: 'webchat',
              peerId,
              sessionKey,
              userId: helloUserId,
              at: Date.now(),
            })
            this.log.info('auto-resume on-demand pre-warmed', { sessionKey })
          } catch (err) {
            this.log.error('auto-resume failed to pre-warm', { sessionKey }, err)
            continue
          }
        } else {
          continue // Not in resume-map either — skip
        }
      }

      const peerKey = Gateway.makePeerKey(helloUserId, 'webchat', peerId)
      let set = this.clientsByPeer.get(peerKey)
      if (!set) {
        set = new Set()
        this.clientsByPeer.set(peerKey, set)
      }
      if (!set.has(ws)) {
        set.add(ws)
        registeredPeerKeys.push(peerKey)
      }
      this.log.info('auto-resume re-registered WS', { peerKey, sessionKey })

      // ── Phase 0.3: ring-buffer replay on hello.lastFrameSeq ──
      // If the client supplied a cursor, serve anything we still have buffered
      // for this sessionKey. If the ring can't satisfy (pruned / restart /
      // bogus cursor), emit `outbound.resume_failed` so the client triggers
      // a REST force-sync. This is ONLY a short-term optimisation; the
      // durable server-side persistence from Phase 0.1/0.2 remains the
      // authoritative backstop for any duration of disconnect.
      const peerRec = peers.find(p => p.peerId === peerId)
      const clientLastSeq = typeof peerRec?.lastFrameSeq === 'number' ? peerRec.lastFrameSeq : 0
      if (clientLastSeq >= 0) {
        const replay = this._outboundRing.peekReplay(sessionKey, clientLastSeq)
        if (replay.ok) {
          for (const f of replay.sent) {
            try { ws.send(f.data) } catch { break }
          }
          if (replay.sent.length > 0) {
            this.log.info('resume replay served', {
              sessionKey, from: clientLastSeq, to: replay.to, sent: replay.sent.length,
            })
          }
        } else {
          try {
            ws.send(JSON.stringify({
              type: 'outbound.resume_failed',
              sessionKey,
              channel: 'webchat',
              peer: { id: peerId, kind: 'dm' },
              from: clientLastSeq,
              to: replay.to,
              reason: replay.reason,
              ts: Date.now(),
            }))
            this.log.warn('resume replay miss — signalled resume_failed', {
              sessionKey, from: clientLastSeq, to: replay.to, reason: replay.reason,
            })
          } catch {}
        }
      }

      // Push a synthetic isFinal to the reconnected client for sessions that the client
      // reports as in-flight (had _sendingInFlight=true) but whose subprocess is not
      // currently running. This clears the client's stuck _sendingInFlight state from
      // the interrupted turn. Without this, the client shows a permanent typing indicator
      // and the resumed subprocess sits idle — neither side moves first.
      const peerInFlight = peers.find(p => p.peerId === peerId)?.inFlight
      if (peerInFlight && session && !session.runner.isRunning) {
        try {
          // Single-ws send (only the hello-ing client should see this notice),
          // so deliver() isn't appropriate here — stamp ts inline.
          const interruptFrame = JSON.stringify({
            type: 'outbound.message',
            sessionKey,
            channel: 'webchat',
            peer: { id: peerId, kind: 'dm' },
            agentId: aid,
            blocks: [
              {
                kind: 'text',
                text: '\n\n⚠️ 上一轮对话被服务重启中断，请重新发送消息继续。',
              },
            ],
            isFinal: true,
            ts: Date.now(),
          })
          ws.send(interruptFrame)
          this.log.info('auto-resume pushed turn-interrupted isFinal', { sessionKey })
        } catch {}
      }
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
    // Ingress guard: drop new messages once shutdown begins so we don't spin
    // up work that `shutdownAll()` then has to tear back down.
    if (this._shuttingDown) return
    if (frame.type !== 'inbound.message') {
      // TODO: 权限响应处理
      return
    }

    // ── Idempotency dedup (read-only check): skip already-processed messages ──
    // Checked first so duplicates don't consume rate-limit budget
    if (frame.idempotencyKey && this._isIdempotencyDuplicate(frame.idempotencyKey)) {
      this.log.debug('duplicate idempotencyKey', { key: frame.idempotencyKey })
      const dupUserId: string =
        typeof (frame as any)._userId === 'string' ? (frame as any)._userId : 'default'
      const peerKey = Gateway.makePeerKey(dupUserId, frame.channel, frame.peer.id)
      const clients = this.clientsByPeer.get(peerKey)
      if (clients) {
        const ack = JSON.stringify({
          type: 'outbound.ack',
          idempotencyKey: frame.idempotencyKey,
          deduplicated: true,
        })
        for (const ws of clients) {
          try { ws.send(ack) } catch {}
        }
      }
      return
    }

    // ── Rate limiting: per-peer sliding window ──
    // Only non-duplicate messages consume rate-limit budget
    if (!this.rateLimiter.check(frame.peer.id, frame.channel)) {
      const rlUserId: string =
        typeof (frame as any)._userId === 'string' ? (frame as any)._userId : 'default'
      const rateLimitOut = {
        type: 'outbound.message' as const,
        sessionKey: '',
        channel: frame.channel,
        peer: frame.peer,
        blocks: [{ kind: 'text' as const, text: '请求过于频繁，请稍后再试。' }],
        isFinal: true,
        _userId: rlUserId,
      }
      // Route WebSocket broadcast through deliver() so ts-stamp is consistent
      // with regular turn finals; keep the adapter path separate for non-ws
      // channels (Telegram etc.) — adapter.send expects a plain OutboundMessage.
      this.deliver(rateLimitOut)
      if (adapter) {
        // Strip the private `_userId` stamp before handing to non-ws adapters —
        // they have their own wire format and shouldn't see gateway internals.
        const { _userId: _strip, ...adapterOut } = rateLimitOut
        adapter.send(adapterOut).catch(() => {})
      }
      return
    }

    // Mark idempotency key eagerly so concurrent/reconnect replays are dropped during processing.
    // If processing fails the key is deleted, allowing the client to retry.
    if (frame.idempotencyKey) this._markIdempotencyKey(frame.idempotencyKey)

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
    const activeUserId: string =
      typeof (frame as any)._userId === 'string' ? (frame as any)._userId : 'default'
    this.lastActiveChannel.set(agent.id, {
      channel: frame.channel,
      peerId: frame.peer.id,
      sessionKey,
      userId: activeUserId,
      at: Date.now(),
    })

    // Defensive sanitize: WS frames are JSON-cast (no typebox runtime check),
    // so an attacker could put arbitrary strings in effortLevel. Whitelist
    // mirrors protocol/frames.ts InboundMessage.effortLevel + CCB EFFORT_LEVELS.
    //   - 合法 string → 透传
    //   - null      → 透传(显式清除已有 effort,让 runner 回到模型默认)
    //   - 其它(包括字段缺省) → 不传给 sessionManager,保持现有 runner 不动
    const _effortAllow = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
    const _frameEffort = (frame as any).effortLevel
    let safeEffortLevel: string | null | undefined
    if (_frameEffort === null) {
      safeEffortLevel = null
    } else if (typeof _frameEffort === 'string' && _effortAllow.has(_frameEffort)) {
      safeEffortLevel = _frameEffort
    } else {
      safeEffortLevel = undefined
    }

    const session = await this.sessions.getOrCreate({
      sessionKey,
      agent,
      channel: frame.channel,
      peerId: frame.peer.id,
      // Phase 0.4 P1-3: carry the authenticated userId onto the session so
      // the durable-append path can persist server-authored text even
      // before the client's debounced PUT lands (first-turn race). Without
      // this the handleResult hook calls `getClientSession(peerId)`, gets
      // null, and silently drops the reply.
      userId: activeUserId,
      title: (frame.content.text ?? '').slice(0, 50).trim() || undefined,
      // 仅用于**新建** runner 时初始化 effort;既存 session 的切换由 submit() 处理
      // (在那里和 turn 入队原子串行,避免并发 submit 之间互相覆盖)。
      effortLevel: safeEffortLevel,
    })
    const out: OutboundMessage = {
      type: 'outbound.message',
      sessionKey,
      channel: frame.channel,
      peer: frame.peer,
      blocks: [],
      isFinal: false,
    }
    // Private userId stamp for deliver() — must be stripped before sending.
    // Fixed in deliver() via destructure so this never reaches the wire.
    ;(out as any)._userId = activeUserId
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
    const MAX_SINGLE_FILE = 200 * 1024 * 1024 // 200MB
    const MAX_TOTAL_MEDIA = 300 * 1024 * 1024 // 300MB total
    // text-kind attachments 在前端 buildMessageText() 阶段就拼进 content.text,
    // 绕过了下面基于 m.base64 的 per-file 校验。给 content.text 整体上限兜底,
    // 防止 (a) 绕前端构造巨 text 帧 (b) 大 text 附件 + 大正文叠加超 300 MB 契约。
    const textByteLen = Buffer.byteLength(text, 'utf8')
    if (textByteLen > MAX_TOTAL_MEDIA) {
      const errMsg = `消息文本超过 ${MAX_TOTAL_MEDIA / 1024 / 1024}MB 限制 (${(textByteLen / 1024 / 1024).toFixed(1)}MB)`
      this.log.warn('upload rejected: text too large', { reason: errMsg, textByteLen, sessionKey })
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
    const ALLOWED_MIME_PREFIXES = [
      'image/', 'audio/', 'video/', 'application/pdf', 'text/',
      'application/vnd.openxmlformats-officedocument.', // docx, xlsx, pptx
      'application/vnd.ms-',                            // doc, xls, ppt
      'application/msword',                             // .doc
      'application/zip', 'application/x-zip',           // zip archives
      'application/json',                               // json files
      'application/xml',                                // xml files
    ]
    let totalMediaSize = 0
    for (const m of media) {
      if (!m.base64) continue
      const rawLen = m.base64.length
      const byteLen = Math.ceil(rawLen * 0.75) // base64 → bytes approx
      if (byteLen > MAX_SINGLE_FILE) {
        const errMsg = `附件超过 ${MAX_SINGLE_FILE / 1024 / 1024}MB 限制 (${(byteLen / 1024 / 1024).toFixed(1)}MB)`
        this.log.warn('upload rejected', { reason: errMsg, byteLen, sessionKey })
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
        this.log.warn('upload rejected', { reason: errMsg, totalMediaSize, sessionKey })
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
        this.log.warn('upload rejected: disallowed MIME', { mime, sessionKey })
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
        this.log.warn('dispatchInbound failed to save upload', { kind: m.kind }, err)
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
        // 对 .docx / .pdf 在 gateway 端预解析为 markdown 直接塞进 prompt;
        // 失败/不支持的格式回退到原来的"路径告知 + Read"。alice 的痛点是上传
        // .doc 失败被迫粘 60KB,即便上传成功 agent 也读不了二进制 —— 这里先解析。
        //
        // 并发上限 3:多 PDF 串行会让首字延迟到 ~30s × N。完全 Promise.all 又
        // 会同时开 N 个 pdfjs worker 撑爆内存(科研用户偶尔丢 5+ 篇论文)。
        // 折中:每批 3 个并行,顺序保留(parsedDocs/unparsedFiles 按 files 顺序排)。
        const PARSE_CONCURRENCY = 3
        type ParsedDoc = {
          file: SavedMedia
          markdown: string
          truncated: boolean
          parser: string
        }
        const parsedDocs: ParsedDoc[] = []
        const unparsedFiles: SavedMedia[] = []
        for (let i = 0; i < files.length; i += PARSE_CONCURRENCY) {
          const batch = files.slice(i, i + PARSE_CONCURRENCY)
          const results = await Promise.all(
            batch.map(async (f) => ({ file: f, result: await parseDocument(f.path, f.mimeType) })),
          )
          for (const { file: f, result } of results) {
            if (result) parsedDocs.push({ file: f, ...result })
            else unparsedFiles.push(f)
          }
        }

        for (const doc of parsedDocs) {
          lines.push(
            '',
            '---',
            `**用户上传的文档**:\`${doc.file.name}\` (${doc.file.mimeType}, ${doc.file.sizeHint})`,
            `_已由 ${doc.parser} 在服务端预解析为 markdown,内容如下_${doc.truncated ? ' **(已截断)**' : ''}:`,
            '',
            doc.markdown,
            '',
            `_(原文件保存在服务器:\`${doc.file.path}\`,如需访问图片/附件可用 Read)_`,
          )
        }

        if (unparsedFiles.length > 0) {
          lines.push(
            '',
            '---',
            '用户还附带了以下文档(已保存到服务器本地,gateway 没能预解析 ——',
            '可能因为格式不支持、解析失败或解析超时):',
          )
          for (const f of unparsedFiles) {
            lines.push(`- \`${f.path}\` (${f.mimeType}, ${f.sizeHint}, 原名: ${f.name})`)
          }
          lines.push(
            '',
            '可以用 Read 工具读取文档内容(对纯文本、CSV、源码、PDF 等都有效',
            '—— 大 PDF 即便预解析超时,Read 也可能能拿到部分文本)。',
            '若是 .doc 老格式 Word 二进制,Read 会看到乱码 —— 礼貌地请用户转存为 .docx 重传。',
          )
        }
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
      } else if (e.kind === 'permission_request') {
        // Forward permission prompt to WebSocket clients for user approval.
        // userId is stashed on the frame by the WS handler (see handleWsConnection)
        // so adapter-dispatched frames fall back to 'default'. On personal-edition
        // (single-user) this is always 'default' in practice.
        const dispatchUserId: string =
          typeof (frame as any)._userId === 'string' ? (frame as any)._userId : 'default'
        const peerKey = Gateway.makePeerKey(dispatchUserId, frame.channel, frame.peer.id)
        const permFrame = {
          type: 'outbound.permission_request' as const,
          sessionKey,
          channel: frame.channel,
          peer: frame.peer,
          requestId: e.request.requestId,
          toolName: e.request.toolName,
          toolUseId: e.request.toolUseId,
          inputPreview: JSON.stringify(e.request.input).slice(0, 400),
          inputJson: e.request.input,
        }
        // Permission requests only make sense for interactive clients (WebChat)
        // Non-interactive adapters auto-deny.
        if (adapter) {
          session.runner.sendPermissionResponse(e.request.requestId, {
            behavior: 'deny',
            message: 'Permission prompts not supported on this channel',
            toolUseID: e.request.toolUseId,
          })
        } else {
          const clients = this.clientsByPeer.get(peerKey)
          if (clients && clients.size > 0) {
            // Register pending request for single-settlement + disconnect auto-deny
            this._pendingPermissions.set(e.request.requestId, {
              sessionKey,
              toolName: e.request.toolName,
              input: e.request.input,
              toolUseId: e.request.toolUseId,
              peerKey,
              userId: dispatchUserId,
              channel: frame.channel,
              peer: frame.peer,
              expiresAt: Date.now() + Gateway.PENDING_PERMISSION_TTL_MS,
            })
            const data = JSON.stringify(permFrame)
            for (const ws of clients) {
              try { ws.send(data) } catch {}
            }
          } else {
            // No connected client — auto-deny
            session.runner.sendPermissionResponse(e.request.requestId, {
              behavior: 'deny',
              message: 'No connected client to approve',
              toolUseID: e.request.toolUseId,
            })
          }
        }
      } else if (e.kind === 'error') {
        this._runLog.complete(_run, { status: 'failed', error: e.error })
        // Remove idempotency key on failure to allow client retry
        if (frame.idempotencyKey) this._seenIdempotencyKeys.delete(frame.idempotencyKey)
        this.deliver(
          {
            ...out,
            blocks: [{ kind: 'text', text: `[error] ${e.error}` }],
            isFinal: true,
          },
          adapter,
        )
      }
    }, safeEffortLevel)
  }

  private deliver(out: OutboundMessage, adapter?: ChannelAdapter): void {
    // Strip the private `_userId` stamp up-front so BOTH adapter and WS
    // branches only ever see the clean wire shape. Keeping the stripped
    // value locally lets the WS branch still route per-user. Stripping
    // here (rather than only just before ws.send) prevents future adapters
    // / debug logs from accidentally leaking internal routing fields.
    const { _userId: stampedUserId, ...wire } = out as OutboundMessage & {
      _userId?: string
    }
    if (adapter) {
      adapter.send(wire as OutboundMessage).catch((err) =>
        this.log.error('adapter send failed', { channel: adapter.name }, err),
      )
      return
    }
    // WebChat: broadcast to all ws clients at the same (userId, channel, peer).
    // userId is read from the `_userId` stamp that callers put on the out
    // frame when they know it. If absent (legacy cron / shutdown paths),
    // fall back to 'default' — personal edition is single-user, so every
    // connected ws registers under userId='default' anyway. On v2 cherry-pick
    // all non-stamped call sites will need updating to route correctly.
    const deliverUserId: string =
      typeof stampedUserId === 'string' ? stampedUserId : 'default'
    const peerKey = Gateway.makePeerKey(deliverUserId, wire.channel, wire.peer.id)
    // ── Phase 0.3: stamp frameSeq + push to ring buffer ──
    // We stamp + store even if no clients are currently connected — that's
    // the whole point: a later autoResumeFromHello for this sessionKey needs
    // the frames to be in the buffer regardless of whether anyone was
    // listening at the moment of the original deliver.
    // Stamp a server-assigned monotonic timestamp on every outbound frame so
    // the web client can reject stale / out-of-order frames after reconnect
    // or agent switches. Schema keeps `ts` unvalidated (extra field is
    // tolerated), so no protocol version bump is required.
    const now = Date.now()
    const sessionKey = (wire as { sessionKey?: string }).sessionKey
    let data: string
    if (sessionKey) {
      const frameSeq = this._outboundRing.nextSeq(sessionKey)
      data = JSON.stringify({ ...wire, ts: now, frameSeq })
      this._outboundRing.store(sessionKey, frameSeq, now, data)
    } else {
      data = JSON.stringify({ ...wire, ts: now })
    }
    const set = this.clientsByPeer.get(peerKey)
    if (!set) return
    for (const ws of set) {
      try {
        ws.send(data)
      } catch {}
    }
  }
}

// ── AskUserQuestion updatedInput sanitizer ──

/**
 * Hard cap on individual answer / notes / preview string length. Matches the
 * rough upper bound of a reasonable user reply; anything larger is almost
 * certainly abuse / a hostile client trying to blow up the forwarded payload.
 */
const ASK_USER_QUESTION_STRING_MAX_LEN = 8192

/**
 * Sanitize a client-supplied `updatedInput` for the AskUserQuestion tool.
 *
 * The frontend sends `{ answers: { [questionText]: string }, annotations?: {
 * [questionText]: { preview?: string, notes?: string } } }` merged into a
 * copy of the original input. We must not forward arbitrary client data to
 * CCB: an attacker that compromises the websocket could otherwise smuggle
 * tool-schema extras through this path.
 *
 * Rules enforced here (matches the LLM-visible shape of the original CCB
 * `AskUserQuestion` schema):
 *   - Ignore every top-level key in `raw` that is not `answers` or
 *     `annotations`; the rest of the payload is inherited verbatim from the
 *     server-trusted `pending.input`.
 *   - `answers` keys must equal the exact `question` text of one of the
 *     pending questions (CCB uses the question string as the map key).
 *   - `answers` values must be strings, ≤ `ASK_USER_QUESTION_STRING_MAX_LEN`.
 *   - `annotations` keys must also be valid question texts.
 *   - `annotations[q].preview` must equal one of that question's
 *     `options[].preview` — the client is not allowed to invent preview text.
 *   - `annotations[q].notes` must be a short string if provided.
 *
 * Returns `null` when no valid `answers` or `annotations` entries survive
 * sanitization — the caller should treat this as a client error and deny
 * the permission request. (Silently forwarding `pending.input` with empty
 * answers would leave the model unable to tell why the user didn't answer.)
 */
export function sanitizeAskUserQuestionUpdatedInput(
  pendingInput: Record<string, unknown>,
  raw: Record<string, unknown>,
): Record<string, unknown> | null {
  const questions = Array.isArray((pendingInput as { questions?: unknown }).questions)
    ? ((pendingInput as { questions: unknown[] }).questions as unknown[])
    : []
  // Map question text → allowed preview strings for that question.
  const previewsByQuestion = new Map<string, Set<string>>()
  const validQuestionTexts = new Set<string>()
  for (const q of questions) {
    if (!q || typeof q !== 'object') continue
    const questionText = (q as { question?: unknown }).question
    if (typeof questionText !== 'string' || questionText.length === 0) continue
    validQuestionTexts.add(questionText)
    const previews = new Set<string>()
    const options = (q as { options?: unknown }).options
    if (Array.isArray(options)) {
      for (const opt of options) {
        if (!opt || typeof opt !== 'object') continue
        const preview = (opt as { preview?: unknown }).preview
        if (typeof preview === 'string' && preview.length > 0) previews.add(preview)
      }
    }
    previewsByQuestion.set(questionText, previews)
  }

  // answers
  const sanitizedAnswers: Record<string, string> = {}
  const rawAnswers = (raw as { answers?: unknown }).answers
  if (rawAnswers && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers)) {
    for (const [k, v] of Object.entries(rawAnswers as Record<string, unknown>)) {
      if (!validQuestionTexts.has(k)) continue
      if (typeof v !== 'string') continue
      if (v.length > ASK_USER_QUESTION_STRING_MAX_LEN) continue
      // Reject blank answers: a whitespace-only string is indistinguishable
      // from "user didn't answer this" for the model, so we treat both as
      // absent. This matches CCB native `AskUserQuestionPermissionRequest`
      // which requires a non-empty selection before enabling submit.
      if (v.trim().length === 0) continue
      sanitizedAnswers[k] = v
    }
  }

  // annotations
  const sanitizedAnnotations: Record<string, { preview?: string; notes?: string }> = {}
  const rawAnnotations = (raw as { annotations?: unknown }).annotations
  if (rawAnnotations && typeof rawAnnotations === 'object' && !Array.isArray(rawAnnotations)) {
    for (const [k, v] of Object.entries(rawAnnotations as Record<string, unknown>)) {
      if (!validQuestionTexts.has(k)) continue
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue
      const out: { preview?: string; notes?: string } = {}
      const preview = (v as { preview?: unknown }).preview
      if (typeof preview === 'string' && preview.length <= ASK_USER_QUESTION_STRING_MAX_LEN) {
        const allowed = previewsByQuestion.get(k)
        if (allowed && allowed.has(preview)) out.preview = preview
      }
      const notes = (v as { notes?: unknown }).notes
      if (typeof notes === 'string' && notes.length > 0 && notes.length <= ASK_USER_QUESTION_STRING_MAX_LEN) {
        out.notes = notes
      }
      if (out.preview !== undefined || out.notes !== undefined) {
        sanitizedAnnotations[k] = out
      }
    }
  }

  const hasAnswers = Object.keys(sanitizedAnswers).length > 0
  const hasAnnotations = Object.keys(sanitizedAnnotations).length > 0
  // Require at least one real answer — annotations alone are not a valid
  // submission (the model needs answers, annotations are auxiliary). A
  // client that sent only annotations (or nothing valid) is either buggy
  // or hostile; silently falling back to pending.input would forward an
  // empty-answer AskUserQuestion turn.
  if (!hasAnswers) return null
  return {
    ...pendingInput,
    answers: sanitizedAnswers,
    ...(hasAnnotations ? { annotations: sanitizedAnnotations } : {}),
  }
}

// ── Exported security helpers (tested in security.test.ts) ──

/**
 * Allowlist of directory prefixes from which /api/file may serve files.
 * Static entries cover well-known locations; dynamic entries (agent cwds)
 * are checked separately via `isFileAllowed()`.
 */
export const FILE_ALLOWED_DIRS: string[] = [
  resolve(paths.generatedDir),  // /root/.openclaude/generated/
  resolve(paths.uploadsDir),    // /root/.openclaude/uploads/
]

/** Temp-file prefix pattern: /tmp/openclaude-* */
const TEMP_PREFIX = resolve('/tmp/openclaude-')

/** Known project roots that agents may work in (intentionally empty — broad source dirs removed) */
const AGENT_CWD_ROOTS: string[] = []

/** Non-executable media extensions safe to serve from agent CWDs */
const MEDIA_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico',
  '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac',
  '.mp4', '.webm', '.mov',
  '.pdf', '.txt', '.md', '.csv', '.json', '.log',
])

/**
 * Returns true if the resolved absolute path falls within the allowlist.
 * Checked BEFORE the blocklist — if this returns false, the file is denied
 * regardless of blocklist status.
 */
export function isFileAllowed(resolvedPath: string, agentCwds?: string[]): boolean {
  // 1. Static allowed directories (OPENCLAUDE_HOME, generated/, uploads/)
  for (const dir of FILE_ALLOWED_DIRS) {
    if (resolvedPath.startsWith(dir + '/') || resolvedPath === dir) return true
  }
  // 2. Temp files matching /tmp/openclaude-*
  if (resolvedPath.startsWith(TEMP_PREFIX)) return true
  // 3. Dynamic agent cwds (if provided) — allow media files and generated/uploads subdirs
  if (agentCwds) {
    for (const raw of agentCwds) {
      if (!raw) continue
      const cwd = resolve(raw)
      if (resolvedPath.startsWith(cwd + '/') || resolvedPath === cwd) {
        // Allow generated/ and uploads/ subdirs unconditionally
        const genSub = cwd + '/generated'
        const upSub = cwd + '/uploads'
        if (resolvedPath.startsWith(genSub + '/') || resolvedPath.startsWith(upSub + '/')) return true
        // Allow non-executable media file extensions anywhere in CWD
        const ext = extname(resolvedPath).toLowerCase()
        if (MEDIA_EXTENSIONS.has(ext)) return true
      }
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
export const MAX_UPLOAD_SINGLE = 200 * 1024 * 1024
export const MAX_UPLOAD_TOTAL = 300 * 1024 * 1024

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

/** MIME types that can execute scripts in the browser and must be force-downloaded. */
const ACTIVE_CONTENT_TYPES = new Set([
  'text/html',
  'image/svg+xml',
  'text/xml',
  'application/xml',
  'application/xhtml+xml',
  // JavaScript is also browser-executable and must not be served inline
  'application/javascript',
  'text/javascript',
])

/**
 * Returns true if the MIME type can execute scripts when rendered inline by the browser.
 * Stripping charset suffix before matching (e.g. "text/html; charset=utf-8" → "text/html").
 */
function isActiveContentType(mime: string): boolean {
  const base = mime.split(';')[0].trim().toLowerCase()
  return ACTIVE_CONTENT_TYPES.has(base)
}

/** Known route prefixes for metrics normalization (avoids high-cardinality labels). */
const KNOWN_ROUTES = [
  '/api/healthz', '/api/doctor', '/api/usage', '/api/usage/events',
  '/api/runs', '/api/sessions', '/api/config', '/api/agents', '/api/search',
  '/api/cron', '/api/tasks', '/api/tasks-executions', '/api/webhooks',
  '/api/wechat/pair/start', '/api/wechat/pair/poll', '/api/wechat/pair/cancel',
  '/api/wechat/binding', '/api/wechat/binding/status',
  '/api/auth/session', '/api/auth/logout', '/api/auth/claude/start',
  '/api/auth/claude/callback', '/api/auth/claude/status',
  '/api/file', '/healthz', '/metrics',
]

/** Normalize URL paths for metrics labels (replace dynamic IDs with :id to avoid high cardinality). */
function normalizePath(p: string): string {
  // Exact match for known routes
  if (KNOWN_ROUTES.includes(p)) return p
  // Dynamic API routes — normalize IDs
  const normalized = p
    .replace(/\/api\/agents\/[a-zA-Z0-9_-]+\/skills\/[a-z0-9-]+/, '/api/agents/:id/skills/:name')
    .replace(/\/api\/agents\/[a-zA-Z0-9_-]+\/([a-z]+)/, '/api/agents/:id/$1')
    .replace(/\/api\/agents\/[a-zA-Z0-9_-]+/, '/api/agents/:id')
    .replace(/\/api\/cron\/[a-zA-Z0-9_-]+/, '/api/cron/:id')
    .replace(/\/api\/tasks\/[a-zA-Z0-9_-]+/, '/api/tasks/:id')
    .replace(/\/api\/webhooks\/[a-zA-Z0-9_-]+/, '/api/webhooks/:id')
    .replace(/\/api\/media\/.+/, '/api/media/:file')
  if (normalized !== p) return normalized
  // OpenAI compat
  if (p.startsWith('/v1/')) return '/v1/:endpoint'
  // Static files and unknown paths — collapse to prevent cardinality explosion
  return '/__other__'
}

// 便捷工厂
export async function createGateway(opts?: { webRoot?: string }): Promise<Gateway> {
  const config = await readConfig()
  if (!config) throw new Error('Run `openclaude onboard` first to create config.')
  const agentsConfig = await readAgentsConfig()
  return new Gateway({ config, agentsConfig, webRoot: opts?.webRoot })
}
