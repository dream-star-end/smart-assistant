import { createHash, randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import {
  constants as fsConstants,
  chmodSync,
  chownSync,
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlink,
  unlinkSync,
} from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { isIPv4 } from 'node:net'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import type { ChannelAdapter, ChannelContext } from '@openclaude/plugin-sdk'
import {
  type InboundFrame,
  type InboundMessage,
  type OutboundCodexBilling,
  type OutboundError,
  type OutboundMessage,
  type OutboundTurnStatus,
  type Peer,
  newTraceId,
  parseTraceIdCandidate,
} from '@openclaude/protocol'
import { classifyRunError } from './errorClassify.js'
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
  getClientSessionPartial,
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
import { createLogger, type Logger } from './logger.js'
import {
  startMetricsCollection,
  serializeMetrics,
  httpRequestsTotal,
  httpRequestDuration,
  wsConnectionsTotal,
  sessionsActive,
  outboundRingReplayHitTotal,
  outboundRingReplayMissTotal,
  outboundRingEvictedTotal,
  outboundRingSizeBytes,
} from './metrics.js'
import { RateLimiter } from './rateLimit.js'
import { handleOpenAIRequest } from './openaiCompat.js'
import { DEFAULT_RING_CONFIG, OutboundRingBuffer, type EvictionStats } from './outboundRing.js'
import { Router } from './router.js'
import { RunLog } from './runLog.js'
import {
  SessionRepoWorkspaceManager,
  type SessionRepoBindFrame,
  type SessionRepoStatusOut,
} from './sessionRepoWorkspace.js'
import { SessionManager } from './sessionManager.js'
import { WebhookRouter } from './webhooks.js'
import { syncCodexAuthFiles } from './codexAuthSync.js'
import { resolveCodexConversationMode } from './codexAutoPlanMode.js'
import { inferAgentForModel } from './inferAgentForModel.js'
import { resolveOpenClaudeVisionEntry } from './codexLaunchOverrides.js'
import {
  OPENCLAUDE_VISION_MCP_ID,
  OPENCLAUDE_VISION_TOOLS,
  shouldEnableOpenClaudeVision,
} from './mcpVisionServer.js'

// User-Agent for gateway-internal Claude OAuth fetch (token exchange + refresh).
// Default Node fetch sends `undici` which is an obvious non-CC fingerprint to
// Anthropic's OAuth endpoint. Mimic the Claude Code CLI UA pattern instead.
// Version is overridable via env so this stays in sync with installed CCB after
// CCB upgrades; CCB's own MACRO.VERSION is a build-time constant unreachable
// from the gateway process, so we can't auto-derive it.
// Codex (auth.openai.com) intentionally NOT covered — different fingerprint
// regime, no evidence of risk, and the gateway _refreshToken path is a backup
// to codex-cli's own internal refresh anyway.
const CLAUDE_OAUTH_USER_AGENT = `claude-cli/${process.env.OPENCLAUDE_CC_VERSION_FOR_OAUTH || '2.1.888'} (external, cli)`

/**
 * 协议级允许的 InboundMessage.model 值(2026-04-26 v1.0.4 加)。
 *
 * 不查 deps.pricing(GatewayDeps 没 pricing;商用版 admin 启用列表是 host 概念,
 * 容器 gateway 拿不到)。新增模型时这里同步更新。安全意义:防止用户 prefs 残留
 * 已下线模型 / 恶意 frame 注入字符串让 CCB --model 拿到非法值导致 spawn 失败 →
 * session 卡死。运行时校验在 server.ts:WS handler 里;export 出来便于 unit test
 * 与未来抽 helper。
 *
 * 当前 commercial 暴露集合(2026-05-02 v1.0.68 起):
 *   - claude-opus-4-7 / claude-sonnet-4-6 — 主力 anthropic 模型
 *   - gpt-5.5 — codex agent 走 codex JSON-RPC
 *   - deepseek-v4-flash / deepseek-v4-pro — anthropicProxy 在 master 侧 isDeepseekModel
 *     命中后切换上游(DEEPSEEK_UPSTREAM_ENDPOINT + DEEPSEEK_API_KEY),
 *     在 claude-subscription agent 上跑就够,不需要切 agent
 */
export const ALLOWED_INBOUND_MODELS = new Set([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'gpt-5.5',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
])

/** Mirror SubprocessRunner's MCP merge rules for prompt/upload hints.
 * This is intentionally metadata-only: the actual tool injection still
 * happens when the CCB subprocess starts. */
export function collectAvailableMcpToolNames(
  config: OpenClaudeConfig,
  agent?: AgentDef,
  model?: string,
  opts: { resolveVisionEntry?: (claudeCodePath?: string) => string | null } = {},
): string[] {
  const tools = new Set<string>()
  const effectiveProvider = agent?.provider ?? config.provider
  const effectiveModel = model ?? agent?.model ?? config.defaults.model

  const toolsetDefs = config.toolsets
  const agentToolsets = agent?.toolsets ?? config.defaults.toolsets
  let allowedMcpIds: Set<string> | null = null
  if (agentToolsets && agentToolsets.length > 0 && toolsetDefs) {
    allowedMcpIds = new Set<string>()
    for (const ts of agentToolsets) {
      const ids = toolsetDefs[ts]
      if (ids) for (const id of ids) allowedMcpIds.add(id)
    }
    allowedMcpIds.add('openclaude-memory')
  }

  const addTools = (id: string, names?: string[], bypassToolset = false) => {
    if (!bypassToolset && allowedMcpIds && !allowedMcpIds.has(id)) return
    for (const name of names ?? []) tools.add(name)
  }

  const resolveVisionEntry = opts.resolveVisionEntry ?? resolveOpenClaudeVisionEntry
  if (
    shouldEnableOpenClaudeVision(effectiveProvider, effectiveModel) &&
    resolveVisionEntry(config.auth.claudeCodePath)
  ) {
    addTools(OPENCLAUDE_VISION_MCP_ID, OPENCLAUDE_VISION_TOOLS)
  }

  for (const srv of config.mcpServers ?? []) {
    if (srv.enabled === false) continue
    if (srv.provider && srv.provider !== effectiveProvider) continue
    addTools(srv.id, srv.tools)
  }

  for (const srv of agent?.mcpServers ?? []) {
    if (srv.enabled === false) continue
    // Agent-specific MCPs override/bypass global provider scoping, matching
    // SubprocessRunner's Layer 3 behavior.
    addTools(srv.id, srv.tools, true)
  }

  return [...tools]
}

// ─── handleUpload TOCTOU hardening test seam (v3 commercial v1.0.155) ───────
//
// Production calls fchmod / fchown / link via `_uploadFsOps.*` so unit tests
// can simulate failure modes (EPERM on fchown, EXDEV on link, etc.) without
// spinning up real containers or root-side filesystem state. `null` restores
// defaults. Production code MUST NOT call __setUploadFsOpsForTests.
//
// Only operations whose TOCTOU semantics matter for the contract are wrapped
// — openSync / realpathSync / closeSync / fstatSync / unlinkSync remain
// direct because their failure-injection isn't needed by current tests.
//
// Pattern mirrors `__setCodexSpawnForTests` in codexRunner.ts.
type UploadFsOps = {
  fchmodSync: typeof fchmodSync
  fchownSync: typeof fchownSync
  linkSync: typeof linkSync
}
const defaultUploadFsOps: UploadFsOps = { fchmodSync, fchownSync, linkSync }
let _uploadFsOps: UploadFsOps = defaultUploadFsOps
export function __setUploadFsOpsForTests(overrides: Partial<UploadFsOps> | null): void {
  _uploadFsOps = overrides ? { ...defaultUploadFsOps, ...overrides } : defaultUploadFsOps
}

// v3 commercial: shared codex chatgpt OAuth between host gateway and per-user
// containers requires two host directories — master (refresh_token, never
// mounted) and container (stripped, ro bind-mounted into containers). See
// codexAuthSync.ts for the design. Defaults can be overridden by env to
// support staging / alt deploys.
const CODEX_MASTER_DIR_DEFAULT = '/var/lib/openclaude-v3/codex-master-auth'
const CODEX_CONTAINER_DIR_DEFAULT = '/var/lib/openclaude-v3/codex-container-auth'

// Container Dockerfile (packages/commercial/agent-sandbox/Dockerfile.openclaude-runtime)
// fixes the agent user at uid=1000 / gid=1000. Default here matches that
// invariant so a missing env var doesn't silently leave auth.json root-owned
// (which would prevent the container's agent uid from reading it). Overrideable
// via CODEX_CONTAINER_AUTH_UID for non-default deploys / dev.
const CODEX_CONTAINER_AUTH_UID_DEFAULT = 1000

function getCodexAuthDirs(): {
  masterDir: string
  containerDir: string
  containerUid: number
} {
  const uidRaw = process.env.CODEX_CONTAINER_AUTH_UID
  const containerUid =
    uidRaw && /^\d+$/.test(uidRaw) ? Number(uidRaw) : CODEX_CONTAINER_AUTH_UID_DEFAULT
  return {
    masterDir: process.env.CODEX_MASTER_DIR || CODEX_MASTER_DIR_DEFAULT,
    containerDir: process.env.CODEX_CONTAINER_DIR || CODEX_CONTAINER_DIR_DEFAULT,
    containerUid,
  }
}

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
/**
 * V3 multi-tenant media 路由结果(uploads + generated 双 dir,同一 docker volume)。
 *
 * 故意结构化(kind discriminator + logCtx),不抛错。gateway 自己决定 HTTP 状态码 +
 * 客户端可见 message。这里的字段命名与 commercial/userMedia.ts 的 `UserMediaLocation`
 * 完全一致 —— 类型在 gateway 端本地重复声明只是为了避免 gateway 反向 import commercial。
 *
 * ok 时同时返回 uploads 和 generated 两个子目录,因为它们属于同一 volume,一次
 * inspect 就能确认两者可用,避免 `/api/media` 一次请求里双查 DB+docker。
 */
export type UserMediaLocationLike =
  | { kind: 'ok'; uid: number; uploads: string; generated: string }
  | {
      kind: 'fail'
      reason: 'remote-host'
      /** 与 'ok' 分支同语义,gateway upload 推远端 host 时透传给 hook。 */
      uid: number
      hostUuid: string
      uploads: string
      generated: string
      logCtx: Record<string, unknown>
    }
  | {
      kind: 'fail'
      reason: 'invalid-uid' | 'not-ready' | 'volume-missing' | 'ambiguous' | 'daemon-error'
      logCtx: Record<string, unknown>
    }

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
  /**
   * V3 multi-tenant `/api/uploads` 写入 + `/api/media` 读取 +
   * `/api/file`/openFileHardened allowlist 的路径解析器。
   * 把 `c:<uid>` 的 userId 映射到该用户 docker volume 宿主路径下的
   * `_data/uploads/` 和 `_data/generated/` 两个子目录。
   *
   * 注入时表明商用模块在多租户模式 —— gateway 必须按用户路由,不再使用全局
   * `paths.uploadsDir` / `paths.generatedDir`(那两个目录在多租户下不存在
   * 用户文件,会触发 dispatchInbound 端"媒体不存在或不可读" / 图像 404)。
   */
  resolveUserMediaDirs?: (userId: string) => Promise<UserMediaLocationLike>
  /**
   * **V3 remote-host 上传桥**(2026-05-16)。把 master 收到的上传文件推到远端
   * compute host 上的用户 docker volume 宿主路径。
   *
   * 仅当 `resolveUserMediaDirs` 返回 `{kind:'fail', reason:'remote-host', ...}`
   * 时由 `handleUpload` 调用 —— 此时 master 物理上不持有用户的 volume,本机
   * tmp+rename 路径不可用。
   *
   * 实现侧(commercial):查 compute_hosts 表解出 NodeAgentTarget,经 mTLS
   * PUT `/files?path=<remotePath>&mode=0644&owner_uid=1000&owner_gid=1000` 上传。
   * node-agent 端 AllowedDirRegexes 严格匹配 v3 用户卷形态;mode+owner 与 self
   * host 上 chmod/chown 完全等价(让远端容器内 agent uid 1000 可读)。
   *
   * 错误语义:throw 表示推送失败(网络/证书/agent app err);gateway 转 5xx。
   */
  pushRemoteHostUpload?: (args: {
    hostUuid: string
    remotePath: string
    content: Buffer
  }) => Promise<void>
  /**
   * **V3 remote-host 读路径桥**(2026-05-16 Phase 2)。`pushRemoteHostUpload`
   * 的对称端 —— 当 `resolveUserMediaDirs` 返回 `remote-host`,gateway 用本 hook
   * 从远端 user docker volume 拉文件回 master,由 master 服给 HTTP 终端。
   *
   * 仅在 `handleMediaGet` / `handleApiFile` 命中 remote-host 时调用,自 self-host
   * 路径无关。`remotePath` 必须在 node-agent AllowedDirRegexes 之内(uploads/
   * generated 子目录),否则 node-agent 直接 400 BAD_PATH。
   *
   * 返:
   *   - `Buffer` → 拉到字节(可能为空文件)
   *   - `null`   → 远端 404,gateway 可选择尝试另一目录或最终 404 给用户
   *   - throw   → 网络/mTLS/auth/agent app err,gateway 转 502
   */
  pullRemoteHostMedia?: (args: {
    hostUuid: string
    remotePath: string
  }) => Promise<Buffer | null>
  /**
   * **textual** 谓词:判定 `resolvedPath` 是否长得像
   * `/var/lib/docker/volumes/oc-v3-data-u<digits>/_data/(uploads|generated)[/<file>]`。
   *
   * **不是 user-scoped** —— gateway HTTP allowlist 不能用它(cross-tenant
   * IDOR)。allowlist 应该用 `resolveUserMediaDirs(userId)` 解析出当前用户的
   * `{uploads, generated}` 后自己 closure 限制到该 uid 的两 dir。
   *
   * 唯一合法用途:启动时 `.tmp-*` orphan sweep(无 userId 上下文,只想匹配
   * docker volumes 根下的 user volume 目录壳子)。
   */
  isUserVolumeMediaPath?: (resolvedPath: string) => boolean
  /**
   * **P1.7 slice 7c — WeChat broker 入口**。
   *
   * 当 commercial 模块启用 wechat broker (WECHAT_BROKER_ENABLED=1) 时注入。
   * gateway 把它**通过 wechatChannelFactory 的 `onInboundOverride`** 透传给
   * `routeWechatInbound`,broker 由此接管 inbound 事件(替代 ctx.dispatch),
   * 并把目标用户的 outbound 容器 endpoint 暂存,供其 v3WechatOutbound 适配器
   * 按 wsess-* session → bindingUserId → senderId 反查回传。
   *
   * **结构类型 (structural)**:gateway 不 import commercial 的具体类——保持
   * gateway → commercial 单向依赖。
   */
  wechatBroker?: {
    onInbound(evt: {
      bindingUserId: string
      senderId: string
      text: string
      idempotencyKey: string
      receivedAt: number
      channel?: 'wechat'
      agentId?: string
    }): Promise<unknown>
  }
  /**
   * **v1.0.192 — cold-start guard for `/api/uploads`**(以及 commercial 内部
   * `/api/file`、`/api/media/:file` 由 commercial router 自己直接调底层 wrapper)。
   *
   * `handleUpload` 在确认请求是 commercial user(userId 形如 `c:<digits>`)后,
   * 在 `_resolveMediaDirs` 之前 await 本 hook —— 确保用户容器已 provision +
   * volume 已挂载 + container running,再去解析 host path 并写入。否则会出现
   * "容器尚未启动,写到 volume host path 上,容器内 agent 看不到文件" 的脏写。
   *
   * 与 commercial router 内部使用的 `(uid: bigint) => Promise<void>`(throw 风格)
   * 不同,**这里返回结构化 result**:gateway 不 import commercial 的
   * `ContainerUnreadyError`,保持 structural-only 依赖。`{ok:false}` 由 gateway
   * 翻译成 503 + `Retry-After`,`{ok:true}` 即放行。
   *
   * 底层都是同一个 `sharedEnsureRunning`(per-uid singleflight),所以 WS bridge /
   * HTTP `/api/media-signed` / commercial router file proxy / gateway upload 同
   * uid 的 in-flight 调用会合并成一次 provision。
   *
   * 非 commercial 形态(`c:<digits>` 不匹配,如 personal-version userId)时 gateway
   * 不调用本 hook —— 让 `_resolveMediaDirs` 原有 `invalid-uid` 路径继续判定。
   */
  ensureContainerReady?: (
    uid: bigint,
  ) => Promise<
    { ok: true } | { ok: false; retryAfterSec: number; reason: string }
  >
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
  /** v3 master sink retry queue stop hook — set when sink is wired in
   *  start(); called in shutdown stage 2 to cancel the periodic drain
   *  timer. null when v3 sink isn't configured (personal version). */
  private _stopV3RetryDrainer: (() => void) | null = null
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
  private _outboundRing!: OutboundRingBuffer

  // ── Phase 4 GitHub workspace: per-WS recent hello peers cache + pending binds ──
  // bind 帧到达时,sessionId 必须出现在 clientsByPeer 注册表 OR 该 ws 最近 5s 内
  // 收到的 hello peers。否则入 pending 队列(5s timeout 后 fail)。
  // Map keyed by ws → { peerIds: Set<sessionId>, recordedAt: ms }
  private _recentHelloPeers = new WeakMap<
    WebSocket,
    { peerIds: Set<string>; recordedAt: number }
  >()
  private _pendingRepoBinds = new Map<
    string /* sessionId|version */,
    {
      ws: WebSocket
      frame: SessionRepoBindFrame
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private static readonly REPO_BIND_HELLO_GRACE_MS = 5_000
  private static readonly REPO_BIND_PENDING_TIMEOUT_MS = 5_000
  private _repoWorkspace = new SessionRepoWorkspaceManager({
    info: (msg, fields) => this.log.info(msg, fields),
    warn: (msg, fields) => this.log.warn(msg, fields),
    error: (msg, fields) => this.log.error(msg, undefined, fields ? new Error(JSON.stringify(fields)) : undefined),
  })

  constructor(private deps: GatewayDeps) {
    this.router = new Router(deps.agentsConfig)
    this.sessions = new SessionManager(deps.config)
    // Wire up auth error handler: force-refresh token when 401 detected (bypass expiry check)
    this.sessions.onAuthError = () => this.refreshClaudeOAuthIfNeeded(true)
    // Phase 5:把 _repoWorkspace 的 getRepoSnapshot 当 provider 注入。
    // 单进程架构下 workspace.states Map 就是权威源,SubprocessRunner.start()
    // 通过它读 ready repo 的 workspaceDir,作为 CCB 的 --add-dir。
    this.sessions.setRepoSnapshotProvider(
      this._repoWorkspace.getRepoSnapshot.bind(this._repoWorkspace),
    )
    // Optional config override for ring bounds: lets `boss` raise maxAgeMs on
    // commercial hosts where mobile users keep tabs backgrounded for >10min.
    const ringCfg = deps.config.gateway.outboundRing ?? {}
    this._outboundRing = new OutboundRingBuffer({
      maxEntries: ringCfg.maxEntries ?? DEFAULT_RING_CONFIG.maxEntries,
      maxAgeMs: ringCfg.maxAgeMs ?? DEFAULT_RING_CONFIG.maxAgeMs,
      maxBytes: ringCfg.maxBytes ?? DEFAULT_RING_CONFIG.maxBytes,
    })
    // 2026-04-21 Medium#G1:被 sessionManager 内部驱逐/shutdown 的 sessionKey
    // 由此 callback 统一走 outboundRing.clear,防 ring 内存长期泄漏。server.ts
    // 其他已有的 destroySession 调用点仍然显式 clear(幂等 double-clear 无副作用)。
    this.sessions.onSessionDestroyed = (sessionKey) => {
      try {
        this._outboundRing.clear(sessionKey)
        outboundRingSizeBytes.value = this._outboundRing.totalBytes()
      } catch {}
    }
  }

  /** Feed `prune()` eviction counts into Prometheus counters. Called from
   *  every store/peekReplay site so age-on-read pruning is also reflected.
   *  Also refreshes the ring size gauge — single source of truth for the
   *  `oc_outbound_ring_size_bytes` value. */
  private _recordRingEvictions(stats: EvictionStats): void {
    if (stats.entries) outboundRingEvictedTotal.inc({ cause: 'entries' }, stats.entries)
    if (stats.age) outboundRingEvictedTotal.inc({ cause: 'age' }, stats.age)
    if (stats.bytes) outboundRingEvictedTotal.inc({ cause: 'bytes' }, stats.bytes)
    outboundRingSizeBytes.value = this._outboundRing.totalBytes()
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

    // V3 commercial: container → master sink for server-authored messages.
    // Wire only if env is configured (set by v3supervisor when spawning
    // commercial containers). Personal version + dev sandbox don't set
    // these envs and the sink stays null — sessionManager falls back to
    // the legacy local-SQLite durable path. This block is no-op for
    // non-commercial deployments.
    //
    // Order matters:
    //   1. read config (env-driven; null → skip).
    //   2. create retry queue WITHOUT a sink reference (queue calls a
    //      function we'll close over).
    //   3. create sink with queue injected.
    //   4. wire the queue's attemptSend to call sink.attemptOnce.
    //   5. set the global getter so sessionManager picks it up before
    //      any turn-end callback fires.
    //   6. kick a drain pass + start periodic timer so any entries
    //      from a prior gateway crash get retried.
    try {
      const { makeV3MasterSink, readV3MasterSinkConfig, setV3MasterSinkSingleton } =
        await import('./v3MasterSink.js')
      const { makeV3MasterRetryQueue } = await import('./v3MasterRetryQueue.js')
      const sinkCfg = readV3MasterSinkConfig()
      if (sinkCfg) {
        // Two-phase wire to break the cycle: queue.attemptSend wants the
        // sink's single-attempt path, sink.persistOrQueue wants the queue
        // for fallback. Box `sinkRef` so the queue can call it via late-
        // binding when sink is constructed below.
        let sinkAttemptOnce: ((p: import('./v3MasterSink.js').V3MasterSinkWirePayload) => Promise<void>) | null = null
        const queue = makeV3MasterRetryQueue({
          attemptSend: async (p) => {
            if (!sinkAttemptOnce) {
              throw new Error('v3MasterRetryQueue: drainer fired before sink wired (impossible)')
            }
            return sinkAttemptOnce(p)
          },
        })
        const sink = makeV3MasterSink({ config: sinkCfg, retryQueue: queue })
        sinkAttemptOnce = (p) => sink.attemptOnce(p)
        setV3MasterSinkSingleton(sink)
        // Boot drain — best-effort, never blocks listen().
        queue.kick()
        queue.startPeriodic()
        this._stopV3RetryDrainer = () => queue.stopPeriodic()
        this.log.info('v3 master sink wired', { baseUrl: sinkCfg.baseUrl })
      }
    } catch (err) {
      // Non-fatal — fall back to legacy local durable path. Ops will see
      // turn texts going to local SQLite (which is permanently empty in
      // v3 commercial) so the symptom is "client_sessions empty" — same
      // as pre-fix; loud enough to detect via dashboards.
      this.log.error('v3 master sink wire failed (falling back to legacy path)', undefined, err as Error)
    }

    // Plan B (2026-05-09): clean up orphan `.tmp-*` files left in uploadsDir
    // by handleUpload runs that crashed mid-stream (or were aborted by the
    // client and the cleanup unlink raced past us). One-shot at startup —
    // intentionally no periodic sweep; abort/error paths in handleUpload
    // already unlink eagerly. Codex Plan B v2 review confirmed.
    //
    // V3 multi-tenant extension (2026-05-12): handleUpload writes land in
    // per-user docker volume host paths, not the global paths.uploadsDir.
    // We sweep both:
    //   1. paths.uploadsDir (personal-version / legacy 'default' uploads)
    //   2. /var/lib/docker/volumes/oc-v3-data-u<uid>/_data/uploads/* (commercial)
    // Each block is wrapped in its own try/catch so a docker host without
    // `/var/lib/docker/volumes` (e.g. dev box) doesn't fail the legacy sweep.
    const cutoff = Date.now() - 60 * 60 * 1000 // 1h
    const sweepTmpInDir = (dir: string): number => {
      let cleaned = 0
      try {
        const baseReal = realpathSync(dir)
        for (const fname of readdirSync(baseReal)) {
          if (!fname.startsWith('.tmp-')) continue
          try {
            const st = statSync(join(baseReal, fname))
            if (st.mtimeMs < cutoff) {
              unlinkSync(join(baseReal, fname))
              cleaned++
            }
          } catch {}
        }
      } catch {
        // Directory missing or unreadable — caller decides whether to log.
        return -1
      }
      return cleaned
    }
    try {
      mkdirSync(paths.uploadsDir, { recursive: true })
      const cleaned = sweepTmpInDir(paths.uploadsDir)
      if (cleaned > 0) this.log.info('upload .tmp orphan cleanup', { cleaned, dir: 'legacy' })
    } catch (err) {
      this.log.warn('upload .tmp orphan cleanup (legacy) failed', undefined, err)
    }
    if (this.deps.commercial?.isUserVolumeMediaPath) {
      // Multi-tenant mode — iterate /var/lib/docker/volumes/oc-v3-data-u*.
      // No DB lookup needed; we accept stale uid dirs (e.g. volume deleted)
      // because readdirSync skips them naturally.
      // We only sweep uploads/, NOT generated/: gateway 自身上传走 .tmp-
      // 协议(rename-after-fsync),codex image_gen 用 writeFile 直接落盘,
      // 不会留 .tmp- 残留,所以 generated/ 没有 orphan 需要清。
      // TODO: 若 generated/ 写入将来切到 .tmp-* publish 语义(例如 codex
      // image_gen 改成 rename-after-fsync),把 generated/ 也加进 sweep 列表。
      try {
        const volsRoot = '/var/lib/docker/volumes'
        let totalCleaned = 0
        let dirsSwept = 0
        for (const entry of readdirSync(volsRoot)) {
          if (!/^oc-v3-data-u[1-9][0-9]{0,18}$/.test(entry)) continue
          const userUploads = join(volsRoot, entry, '_data', 'uploads')
          const r = sweepTmpInDir(userUploads)
          if (r >= 0) {
            dirsSwept++
            totalCleaned += r
          }
        }
        if (totalCleaned > 0 || dirsSwept > 0) {
          this.log.info('upload .tmp orphan cleanup', { cleaned: totalCleaned, dirsSwept, dir: 'per-user' })
        }
      } catch (err) {
        // /var/lib/docker/volumes typically requires root (gateway runs as
        // root in v3 commercial); ENOENT just means docker isn't installed
        // (CI / dev). Log warn but don't fail startup.
        this.log.warn('upload .tmp orphan cleanup (per-user) failed', undefined, err)
      }
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
          // Refresh size_bytes gauge — without this, a Prometheus scrape
          // after a wipe still reports the pre-clear bytes until the next
          // store/peek path runs.
          outboundRingSizeBytes.value = this._outboundRing.totalBytes()
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

    // v3 commercial: self-heal codex auth files on boot. If host master /
    // container files were lost (deploy moved dirs, perms got stomped, fresh
    // host) but codexOAuth in config is still valid, regenerate them so
    // per-user containers can read the shared chatgpt subscription without
    // requiring boss to re-OAuth. Force-write — no ownership check needed
    // because we trust the in-memory config as source of truth on boot.
    void this._selfHealCodexAuthOnBoot()

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
    // v3 master sink retry queue periodic timer ONLY here. The sink
    // singleton itself MUST stay set until after sessions.shutdownAll()
    // drains turn-end / handleExit-flush callbacks (stage 4) — clearing
    // it now would send late partial-flush writes through the legacy
    // local SQLite path that's permanently empty in v3 commercial,
    // recreating the original data-loss bug. Stopping the periodic timer
    // is fine: it's purely additive (drains entries already on disk
    // from prior boot), and `kick()` is idempotent.
    // Codex R2 BLOCK-2.
    try {
      this._stopV3RetryDrainer?.()
    } catch (err) {
      this.log.warn('v3 retry drainer stop error', undefined, err)
    }
    this._stopV3RetryDrainer = null

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

    // ── Stage 4.5: clear v3 master sink singleton ──
    // shutdownAll above internally awaits awaitPendingPersistence(), so
    // every turn-end / handleExit-flush has either landed on master via
    // the sink HTTP POST or has been durably enqueued on disk for
    // retry-on-next-boot. Now safe to disable the write path.
    // Codex R2 BLOCK-2 — kept the kill-switch out of stage 2 and put it
    // here after sessions are fully drained.
    try {
      const { setV3MasterSinkSingleton } = await import('./v3MasterSink.js')
      setV3MasterSinkSingleton(null)
    } catch (err) {
      this.log.warn('v3 master sink singleton clear error', undefined, err)
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

    // v3 WeChat broker → 容器 inbound 通道(D3d:HMAC-derived nonce 鉴权)。
    // master 侧 broker 经 docker bridge gateway 主动 POST 把 WeChat 收到的消息塞进
    // 容器的 dispatchInbound() 路径,等价于"模拟一条 WS inbound.message"。
    //
    // 鉴权完全靠 checkInboundBypass —— **不接受任何 JWT / 旧 token,也不允许 host loopback**;
    // env(OPENCLAUDE_TRUST_BRIDGE_IP/OC_CONTAINER_ID/OPENCLAUDE_INBOUND_NONCE)缺失 / 形态错
    // 一律 false,fail-closed。401 时只回最小 JSON,不暴露原因(防 oracle)。
    //
    // 端点放到 needsAuth 块之前并提前 return —— 防 `/internal/*` 之类未来路由意外
    // 被 needsAuth 漏判公开化(/internal/ 不在 needsAuth 当前的 prefix 列表里)。
    if (url.pathname === '/internal/v3/wechat-inbound' && req.method === 'POST') {
      if (!this.checkInboundBypass(req, url)) {
        this.sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      this.handleWechatInbound(req, res).catch((err) => {
        this.log.error('wechat-inbound handler crashed', undefined, err)
        if (!res.headersSent) {
          try { this.sendJson(res, 500, { error: 'internal' }) } catch {}
        } else {
          try { res.end() } catch {}
        }
      })
      return
    }

    // 容器侧 WeChat inbound 补偿端点。master broker 的 inboundDispatcher Step 2
    // 失败时调本端点撤销 Step 1 写入的 client_sessions row。
    //
    //   - 鉴权同 /wechat-inbound:走 checkInboundBypass(已支持 /internal/v3/* 前缀)
    //   - **idempotent + always-200**:dispatcher 视任何 500 / 非-200 都为 "compensation
    //     failed",而 reconcile 30s 才兜底。always-200 + `deleted` 字段把"行不存在 / 已
    //     删 / 真删了"三种状态显式化,避免 dispatcher 把 idempotent no-op 错记成 error
    //   - 真 DB 错也照 200 返(body 内带 errMessage 让 broker log 观测,但 dispatcher
    //     不重试 — 重试同一条 compensation 也不会成,reconcile 会兜底清孤儿)
    if (url.pathname === '/internal/v3/wechat-inbound-compensate' && req.method === 'POST') {
      if (!this.checkInboundBypass(req, url)) {
        this.sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      this.handleWechatInboundCompensate(req, res).catch((err) => {
        this.log.error('wechat-inbound-compensate handler crashed', undefined, err)
        if (!res.headersSent) {
          // crash 路径也照 200 返 — dispatcher 永远不该 retry compensation
          try { this.sendJson(res, 200, { ok: true, deleted: false, errMessage: 'internal' }) } catch {}
        } else {
          try { res.end() } catch {}
        }
      })
      return
    }

    // Frontend diagnostic trace sink — receives ring-buffer events from
    // packages/web/public/modules/trace.js for diagnosing the "已读但无回复"
    // class of bug (assistant frame delivered by gateway but never landed in
    // client_sessions.messages). NO database write — pino structured log only,
    // queryable via journalctl/grep. 50KB body cap defends the endpoint from
    // accidental flood (RING_MAX*compact entries fits well under).
    if (url.pathname === '/api/web-trace' && req.method === 'POST') {
      const userId = this.getUserId(req)
      this.readBody(req, 50 * 1024)
        .then((body) => {
          let payload: unknown
          try {
            payload = JSON.parse(body)
          } catch {
            this.sendJson(res, 400, { error: 'invalid json' })
            return
          }
          const events = (payload as { events?: unknown })?.events
          if (!Array.isArray(events)) {
            this.sendJson(res, 400, { error: 'events array required' })
            return
          }
          this.log.info('web-trace', { userId, count: events.length, events })
          res.writeHead(204)
          res.end()
        })
        .catch((err) => {
          const tooLarge = String(err?.message ?? err).includes('body too large')
          if (tooLarge) {
            this.sendJson(res, 413, { error: 'body too large' })
          } else {
            this.sendJson(res, 400, { error: 'read failed' })
          }
        })
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
        // Incremental sync (Plan v3): client passes `?since=<seq>` to get
        // only messages whose server-assigned `_seq` exceeds the cursor.
        // Legacy rows (any message without `_seq`) and missing/invalid
        // `since` fall back to the full payload via `isPartial: false`.
        const sinceRaw = url.searchParams.get('since')
        const sinceSeq = sinceRaw !== null ? Number(sinceRaw) : 0
        const useIncremental = Number.isFinite(sinceSeq) && sinceSeq > 0
        if (useIncremental) {
          getClientSessionPartial(sessId, userId, sinceSeq)
            .then((s) => s ? this.sendJson(res, 200, s) : this.sendJson(res, 404, { error: 'not found' }))
            .catch(() => this.sendJson(res, 500, { error: 'get failed' }))
        } else {
          getClientSession(sessId, userId)
            .then((s) => {
              if (!s) {
                this.sendJson(res, 404, { error: 'not found' })
                return
              }
              // Always stamp protocol fields explicitly (Codex review #6 — do
              // not rely on truthy/falsey of missing keys). `maxSeq` is
              // computed from messages, not next_seq.
              const messages = (s.messages as Array<{ _seq?: unknown }>) || []
              let maxSeq = 0
              for (const m of messages) {
                const v = (m as { _seq?: unknown })._seq
                if (typeof v === 'number' && Number.isFinite(v) && v > maxSeq) maxSeq = v
              }
              this.sendJson(res, 200, {
                ...s,
                isPartial: false,
                totalMessageCount: messages.length,
                maxSeq,
              })
            })
            .catch(() => this.sendJson(res, 500, { error: 'get failed' }))
        }
        return
      }
      if (req.method === 'PUT') {
        // Wire-level body cap = 2MB. Set BELOW the storage layer's
        // MAX_SESSION_BYTES (4MB) so a single PUT can never be the sole
        // cause of pushing a row past the storage cap; lets clients still
        // send moderate-size sessions while preventing the 2026-05-08
        // 8MB-PUT incident from recurring at the gateway boundary. Errors
        // from each stage are routed to distinct status codes:
        //   413 — body or post-merge blob too large (terminal, client must
        //         shrink session before retry)
        //   400 — malformed JSON
        //   409 — stale write (existing.updated_at > _baseSyncedAt OR
        //         concurrent racer beat us to the UPDATE)
        ;(async () => {
          let body: string
          try {
            body = await this.readBody(req, 2 * 1024 * 1024)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (msg === 'body too large') {
              this.sendJson(res, 413, { error: 'request body too large', maxBytes: 2 * 1024 * 1024 })
            } else {
              this.sendJson(res, 400, { error: 'invalid body' })
            }
            return
          }
          let data: { agentId?: string; title?: string; pinned?: unknown; createdAt?: number; lastAt?: number; messages?: unknown; _baseSyncedAt?: number }
          try {
            data = JSON.parse(body)
          } catch {
            this.sendJson(res, 400, { error: 'invalid JSON' })
            return
          }
          const updatedAt = Date.now()
          const result = await upsertClientSession({
            id: sessId,
            userId,
            agentId: data.agentId || 'main',
            title: data.title || '新会话',
            pinned: !!data.pinned,
            createdAt: data.createdAt || Date.now(),
            lastAt: data.lastAt || Date.now(),
            messages: (data.messages as unknown[]) || [],
            updatedAt,
          }, data._baseSyncedAt || 0)
          if (result === 'oversized') {
            // Distinct from request-body 413 (which fires before parse).
            // The post-merge blob would push the on-disk row past
            // MAX_SESSION_BYTES — client should drop attachments / split
            // the session before retrying. Returning 409 here would
            // collide with the stale-write retry loop and recreate the
            // event-loop stall this fix was written to eliminate.
            this.sendJson(res, 413, { error: 'session too large', reason: 'oversized' })
          } else if (result === 'rejected_stale') {
            this.sendJson(res, 409, { error: 'conflict' })
          } else {
            this.sendJson(res, 200, { ok: true, applied: true, updatedAt })
          }
        })().catch(() => this.sendJson(res, 500, { error: 'put failed' }))
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

    // ── Streaming upload endpoint (Plan B 2026-05-09) ──
    // Single-file raw-binary POST. Body streams directly to disk, sha256-named.
    // Replaces sending base64 inside the WS frame's `_media[i].base64` — that
    // path bloated `client_sessions.messages` JSON and triggered the 2026-05-08
    // event-loop stall incident. See feedback memo
    // v3_attachments_independent_channel.md.
    if (url.pathname === '/api/uploads' && req.method === 'POST') {
      this.handleUpload(req, res).catch((err) => this.sendError(res, 500, String(err)))
      return
    }

    // ── Media file serving ──
    // Serve user-uploaded and MCP-generated media files for inline rendering.
    // Async because v3 commercial uploads dir resolution touches PG + docker.
    // Use the same dispatch pattern as /api/uploads to keep handleHttp sync.
    const mediaMatch = url.pathname.match(/^\/api\/media\/(.+)$/)
    if (mediaMatch) {
      this.handleMediaGet(req, res, mediaMatch[1]).catch((err) => {
        if (!res.headersSent) {
          this.sendError(res, 500, String(err))
        } else {
          try { res.end() } catch { /* socket gone */ }
        }
      })
      return
    }

    // ── File serving by absolute path (whitelist-restricted) ──
    // Async dispatch because v3 commercial requires resolving the caller's
    // {uploads, generated} dirs for a user-scoped allowlist predicate (DB +
    // docker inspect). Pattern mirrors /api/uploads and /api/media.
    if (url.pathname === '/api/file') {
      this.handleApiFile(req, res, url).catch((err) => {
        if (!res.headersSent) {
          this.sendError(res, 500, String(err))
        } else {
          try { res.end() } catch { /* socket gone */ }
        }
      })
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
   * v3 WeChat broker → container inbound 通道(D3d HMAC 派生方案 B')。
   *
   * Master broker 通过 docker bridge gateway 主动 POST 到容器 gateway 的
   * `/internal/v3/wechat-inbound`。**与 checkBridgeBypass 严格不同**:
   *
   *   | 维度          | bridge bypass(file proxy)    | inbound bypass(broker → 容器) |
   *   | ------------- | ---------------------------- | --------------------------- |
   *   | 方向          | host → 容器(file/media 反代)  | host broker → 容器           |
   *   | path          | /api/file, /api/media/*       | /internal/v3/wechat-inbound  |
   *   | method        | GET / HEAD                    | POST                         |
   *   | nonce HMAC 域 | HMAC(s, containerId)           | HMAC(s, "inbound:" + cid)    |
   *   | env           | OC_BRIDGE_NONCE(hex 64)        | OPENCLAUDE_INBOUND_NONCE(b64url 43)|
   *   | header        | X-OpenClaude-Bridge-Nonce     | X-OpenClaude-Inbound-Nonce  |
   *
   * **故意编码不同**(hex vs base64url):env 名 / log / grep 一眼能区分两类 nonce,
   * 避免任何"复用同一校验函数 / 同一 header"的捷径让两条通道粘合。Codex r4 note 2 明确
   * 要求两条通道的 nonce 在 HMAC 输入域 + 编码上同时正交。
   *
   * TRUST_BRIDGE_IP / OC_CONTAINER_ID 与 file-proxy 共用;两个值同时缺/形态不对都直接
   * 拒(同 healthz capability 广播逻辑,避免 healthz advertise 但 bypass 失败的哑锁)。
   * 与 file-proxy 一样 fail-closed:env 缺一即恒 false。
   */
  private checkInboundBypass(req: IncomingMessage, url: URL): boolean {
    const TRUST_BRIDGE_IP = process.env.OPENCLAUDE_TRUST_BRIDGE_IP || ''
    const OC_CONTAINER_ID = process.env.OC_CONTAINER_ID || ''
    const INBOUND_NONCE = process.env.OPENCLAUDE_INBOUND_NONCE || ''
    if (!TRUST_BRIDGE_IP || !OC_CONTAINER_ID || !INBOUND_NONCE) return false
    if (!isIPv4(TRUST_BRIDGE_IP)) return false
    if (!/^[1-9][0-9]{0,18}$/.test(OC_CONTAINER_ID)) return false
    // base64url(32B) → 43 chars,无 padding,字符集 [A-Za-z0-9_-]
    if (!/^[A-Za-z0-9_-]{43}$/.test(INBOUND_NONCE)) return false
    const remoteIp = req.socket.remoteAddress || ''
    if (remoteIp !== TRUST_BRIDGE_IP && remoteIp !== `::ffff:${TRUST_BRIDGE_IP}`) return false
    if ((req.method || '') !== 'POST') return false
    // Phase 1 只用一个端点,但前缀放开方便后续 broker → 容器扩控制面(notify-user 等)。
    // 任何不以 /internal/v3/ 开头的路径直接拒,确保 bypass 不会泄到其它路由。
    if (!url.pathname.startsWith('/internal/v3/')) return false
    const hdrId = String(req.headers['x-openclaude-container-id'] ?? '').trim()
    if (hdrId !== OC_CONTAINER_ID) return false
    const hdrNonce = String(req.headers['x-openclaude-inbound-nonce'] ?? '').trim()
    if (!/^[A-Za-z0-9_-]{43}$/.test(hdrNonce)) return false
    if (hdrNonce.length !== INBOUND_NONCE.length) return false
    try {
      return timingSafeEqual(
        Buffer.from(hdrNonce, 'base64url'),
        Buffer.from(INBOUND_NONCE, 'base64url'),
      )
    } catch {
      return false
    }
  }

  /**
   * v3 WeChat broker → 容器 dispatchInbound 桥。
   *
   * 调用前必须先过 checkInboundBypass(在 route 入口处已校验)。这里负责:
   *  1. 读 body(256KB 上限,与 internalServerAuthored 对齐;wechat 单消息远小于此,
   *     但 attachments 可能拼大;给个稳妥上限)
   *  2. 轻量手写 schema 校验(gateway 没 zod 依赖,不为单条路由引入新 dep)
   *  3. 构造 InboundFrame 直接喂 this.dispatchInbound —— 复用 line 5181-5190
   *     lazy-session 路径(channel='wechat',peer.id 由 broker 解析为 client_sessions.id,
   *     即 RFC v4 中 sessionPointer.current_session_id)。**不要走** inbound.hello/
   *     inbound.bind 任何模板 —— 那些是 WS-only 控制帧,跟 HTTP inbound 无关。
   *  4. 200 回 { ok, sessionKey };400/413 严守语义,broker outbox 端可按 status
   *     class 决定 fatal vs retry(参见 wechat-broker-design.md §4.8)
   *
   * **trust 模型**:body.userId 由 broker 自行决定(它持有 wechat_bindings 行),
   * 容器层不再二次校验 c:NN 跟容器 owner 的对齐 —— 容器只服务一个用户,broker 错配
   * 整段消息走错容器属于上游路由 bug,跟 dispatchInbound 收到一条 WS frame 信任
   * _userId 是同一信任模型(checkInboundBypass 已确认 caller = master broker)。
   */
  private async handleWechatInbound(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const MAX_INBOUND_BODY = 256 * 1024
    let raw: string
    try {
      raw = await this.readBody(req, MAX_INBOUND_BODY)
    } catch (err) {
      const tooLarge = String((err as Error)?.message ?? err).includes('body too large')
      this.sendJson(res, tooLarge ? 413 : 400, { error: tooLarge ? 'body too large' : 'read failed' })
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.sendJson(res, 400, { error: 'invalid json' })
      return
    }
    if (!parsed || typeof parsed !== 'object') {
      this.sendJson(res, 400, { error: 'body must be a JSON object' })
      return
    }
    const body = parsed as Record<string, unknown>

    // ── Schema validation(手写,精度等价 zod minimum,但零 dep)──
    const userId = body.userId
    if (typeof userId !== 'string' || !/^c:[1-9][0-9]{0,18}$/.test(userId)) {
      this.sendJson(res, 400, { error: 'userId must match c:<uid>' })
      return
    }
    const peerRaw = body.peer as Record<string, unknown> | undefined
    if (!peerRaw || typeof peerRaw !== 'object') {
      this.sendJson(res, 400, { error: 'peer required' })
      return
    }
    const peerKind = peerRaw.kind
    const peerId = peerRaw.id
    // Phase 1 只支持 DM。group 留给 future phase(WeChat group bot 是另一套 API)。
    if (peerKind !== 'dm') {
      this.sendJson(res, 400, { error: 'peer.kind must be dm in P1' })
      return
    }
    if (typeof peerId !== 'string' || peerId.length === 0 || peerId.length > 256) {
      this.sendJson(res, 400, { error: 'peer.id required (1..256 chars)' })
      return
    }
    const peerDisplayName = peerRaw.displayName
    if (peerDisplayName !== undefined && (typeof peerDisplayName !== 'string' || peerDisplayName.length > 256)) {
      this.sendJson(res, 400, { error: 'peer.displayName must be string ≤256' })
      return
    }
    const agentId = body.agentId
    if (agentId !== undefined && (typeof agentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(agentId))) {
      this.sendJson(res, 400, { error: 'agentId charset/length invalid' })
      return
    }
    const contentRaw = body.content as Record<string, unknown> | undefined
    if (!contentRaw || typeof contentRaw !== 'object') {
      this.sendJson(res, 400, { error: 'content required' })
      return
    }
    const text = contentRaw.text
    if (typeof text !== 'string') {
      this.sendJson(res, 400, { error: 'content.text required (P1 text-only)' })
      return
    }
    // 单条 text 上限:与 protocol 默认一致(_capToolEntry 类似 64 KB UTF-8 budget),
    // 但 inbound 是用户消息,容许大点(WeChat 长截图描述 / 用户粘贴);256KB body
    // cap 已经是硬上限,这里只做 schema-level 防御。
    if (text.length > 65536) {
      this.sendJson(res, 400, { error: 'content.text too long (>65536 chars)' })
      return
    }
    const idempotencyKey = body.idempotencyKey
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 128) {
      this.sendJson(res, 400, { error: 'idempotencyKey required (1..128 chars)' })
      return
    }
    const tsRaw = body.ts
    let ts: number
    if (tsRaw === undefined) {
      ts = Date.now()
    } else if (typeof tsRaw === 'number' && Number.isFinite(tsRaw) && tsRaw >= 0 && tsRaw <= Number.MAX_SAFE_INTEGER) {
      ts = Math.floor(tsRaw)
    } else {
      this.sendJson(res, 400, { error: 'ts must be non-negative finite number' })
      return
    }

    // ── 构造 InboundFrame 并喂 dispatchInbound ──
    // 不模拟 inbound.hello / inbound.bind 任何控制帧,直接命中 line 5181-5190
    // lazy-session 路径。peer.id === sessionId(broker 保证),sessionKey 由
    // dispatchInbound 用 agent.id+channel+peer.kind+peer.id 派生 —— 跟 webchat
    // 路径完全同形,sessionManager.handleResult 处的 client_sessions 写回路径自然命中
    // (channel='wechat' 由 P1.4 sink gate 放行)。
    const peerOut: { kind: 'dm'; id: string; displayName?: string } = {
      kind: 'dm',
      id: peerId,
    }
    if (typeof peerDisplayName === 'string') peerOut.displayName = peerDisplayName
    const frame = {
      type: 'inbound.message' as const,
      idempotencyKey,
      channel: 'wechat',
      peer: peerOut,
      ...(typeof agentId === 'string' ? { agentId } : {}),
      content: { text },
      ts,
    }
    // _userId 私有 stash,与 WS path(line 4163)同语义:dispatchInbound 内部读
    // (frame as any)._userId 决定 peerKey 命名空间和 client_sessions 归属。
    ;(frame as any)._userId = userId

    // V3 broker → 容器 outbound 回路。
    //
    // dispatchInbound 不带 adapter 会走 WS 广播路径(server.ts deliver() line 6314+),
    // 但容器侧没有 WS 客户端订阅这条 wechat peerKey,assistant 帧只会落进
    // outboundRing 等到永不发生的 hello-resume —— master 这边却收到 200,
    // broker retry queue 不会兜底 → assistant 静默丢失。
    //
    // 显式查 v3-wechat-outbound adapter 把 outbound 出口绑死;adapter 在容器进程
    // 装配时由 cli/gateway.ts 注册(env OPENCLAUDE_V3_MASTER_BASE_URL +
    // OPENCLAUDE_V3_CONTAINER_TOKEN 同时存在),adapter.send 通过
    // POST /internal/v3/wechat-outbound 回送到 master broker。
    //
    // adapter 缺失 = 容器装配错误,broker 不该 POST 到没装 adapter 的容器:
    // 503 fail-closed 让 broker retry queue 视为 transient + 让运维看 log 找到
    // "adapter not registered"。不修改 dispatchInbound 通用行为,其他 channel 不受影响。
    const v3OutboundAdapter = this.channels.get('v3-wechat-outbound')
    if (!v3OutboundAdapter) {
      this.log.error(
        'handleWechatInbound: v3-wechat-outbound adapter not registered; refusing dispatch',
        { userId, peerId, idempotencyKey },
      )
      this.sendJson(res, 503, {
        error: {
          code: 'V3_WECHAT_OUTBOUND_NOT_WIRED',
          message: 'container missing v3-wechat-outbound adapter; outbound cannot return to master',
        },
      })
      return
    }
    await this.dispatchInbound(frame as InboundFrame, v3OutboundAdapter)

    // sessionKey 派生(与 server.ts:5185 一致)便于 broker 关联 log / metric。
    const safePeerId = peerId.replace(/[^a-zA-Z0-9_-]/g, '_')
    const sessionKey =
      typeof agentId === 'string'
        ? `agent:${agentId}:wechat:dm:${safePeerId}`
        : null
    this.sendJson(res, 200, {
      ok: true,
      ...(sessionKey ? { sessionKey } : {}),
    })
  }

  /**
   * v3 WeChat broker → 容器 inbound 补偿端点。
   *
   * 调用前已过 checkInboundBypass(在 route 入口处校验);body 是 dispatcher
   * tryCompensation 构造的 `{sessionId, bindingUserId, reason, traceId?}` JSON。
   *
   * **idempotent + always-200**:
   *   - 行存在且未 soft-deleted → 调 deleteClientSession,200 `{ok:true, deleted:true}`
   *   - 行已 soft-deleted / 不存在 / 跨 tenant userId mismatch → 200 `{ok:true, deleted:false}`
   *   - schema 错 → 400(语义是 caller 出错,不是 compensation 失败 — 跟 idempotent 语义不冲突)
   *   - body 过大 → 413(同 handleWechatInbound 风格)
   *   - DB 异常 → 200 `{ok:true, deleted:false, errMessage}`(dispatcher 不该 retry 同条
   *     compensation;reconcile 30s 兜底)
   *
   * `userId` 通过 `c:` + `bindingUserId` 派生,与 master sqlite Step 2a 写入的
   * `MASTER_USER_PREFIX + bindingUserId` 字节级一致 — deleteClientSession 内部的
   * `WHERE id=? AND user_id=?` 自带 tenant scope 防御。
   */
  private async handleWechatInboundCompensate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const MAX_COMPENSATE_BODY = 8 * 1024
    let raw: string
    try {
      raw = await this.readBody(req, MAX_COMPENSATE_BODY)
    } catch (err) {
      const tooLarge = String((err as Error)?.message ?? err).includes('body too large')
      this.sendJson(res, tooLarge ? 413 : 400, { error: tooLarge ? 'body too large' : 'read failed' })
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.sendJson(res, 400, { error: 'invalid json' })
      return
    }

    const v = validateWechatInboundCompensateBody(parsed)
    if (!v.ok) {
      this.sendJson(res, 400, { error: v.error })
      return
    }
    const { sessionId, bindingUserId, reason, traceId } = v.payload

    const userId = `c:${bindingUserId}`
    let deleted = false
    let errMessage: string | undefined
    try {
      deleted = await deleteClientSession(sessionId, userId)
    } catch (err) {
      errMessage = (err as Error)?.message ?? String(err)
      this.log.error('wechat-inbound-compensate db error', { sessionId, userId, reason, traceId, errMessage })
    }

    this.log.info('wechat-inbound-compensate', {
      sessionId,
      userId,
      reason,
      ...(traceId ? { traceId } : {}),
      deleted,
      ...(errMessage ? { errMessage } : {}),
    })
    this.sendJson(res, 200, {
      ok: true,
      deleted,
      ...(errMessage ? { errMessage } : {}),
    })
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
   * `extraAllowed` is the **caller-provided** user-scoped predicate. Callers
   * in v3 commercial must NOT pull a global textual predicate from `deps`
   * — that would re-introduce the cross-tenant IDOR risk where user A can
   * read user B's docker volume media by absolute path. Caller constructs
   * a closure over the **current request's** resolved `{uploads, generated}`
   * dirs and passes that down.
   *
   * Returns an fd on success; writes 403/404 to res and returns null on failure.
   */
  private openFileHardened(
    res: ServerResponse,
    realPath: string,
    agentCwds: string[],
    extraAllowed?: (p: string) => boolean,
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
    // Re-check via fd realpath as fail-closed defense (redundant with caller's
    // upstream check, but cheap). The user-scoped `extraAllowed` predicate
    // covers v3 commercial docker-volume paths for the **current** uid.
    if (fdReal !== realPath || !isFileAllowed(fdReal, agentCwds, extraAllowed) || isFileBlocked(fdReal)) {
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
   * Resolve the media directories (uploads + generated) for an authenticated
   * user. Both subdirs live in the same docker volume, so a single resolve
   * call returns both — avoids double-DB / double-docker-inspect on read.
   *
   * Returns `{ kind: 'legacy' }` for personal-version flows (no commercial
   * hook, or commercial hook with no resolver — e.g. agentRuntime didn't
   * come up). Caller falls back to `paths.uploadsDir` / `paths.generatedDir`.
   *
   * Otherwise delegates to `commercial.resolveUserMediaDirs` which returns
   * the structured `{ kind: 'ok', uploads, generated }` / `{ kind: 'fail',
   * reason }`. Gateway never silently falls back from a `fail` to legacy
   * paths — that would re-introduce the same single-tenant split-brain that
   * this whole change exists to fix.
   *
   * Status mapping (caller-side):
   *   not-ready    → 503 + Retry-After (provisioning window)
   *   remote-host  → 503 (deferred remote-volume push, see TODO)
   *   volume-missing/ambiguous/daemon-error → 500 (data corruption / docker err)
   *   invalid-uid  → 401 (token has bad sub form; shouldn't happen post-getUserId)
   */
  private async _resolveMediaDirs(
    userId: string,
  ): Promise<
    | { kind: 'legacy'; uploads: string; generated: string }
    | { kind: 'ok'; uid: number; uploads: string; generated: string }
    | {
        kind: 'fail'
        reason: 'remote-host'
        uid: number
        hostUuid: string
        uploads: string
        generated: string
        logCtx: Record<string, unknown>
      }
    | {
        kind: 'fail'
        reason: 'invalid-uid' | 'not-ready' | 'volume-missing' | 'ambiguous' | 'daemon-error'
        logCtx: Record<string, unknown>
      }
  > {
    // No commercial hook OR resolver not injected (agentRuntime not ready) →
    // legacy single-tenant write/read path. `default` always falls here
    // regardless of commercial hook presence (personal-version single-token
    // auth).
    const resolver = this.deps.commercial?.resolveUserMediaDirs
    if (!resolver || userId === 'default') {
      return { kind: 'legacy', uploads: paths.uploadsDir, generated: paths.generatedDir }
    }
    // Commercial JWT user → delegate. Any `c:` userId not parseable by the
    // resolver lands as `kind: 'fail', reason: 'invalid-uid'`.
    const loc = await resolver(userId)
    return loc
  }

  /**
   * Translate a `_resolveMediaDirs` failure into an HTTP response and log.
   * Returns true if the caller should stop (response already sent), false if
   * it can keep going (currently never returns false — branches always send).
   *
   * Centralized so handleUpload, /api/media, /api/file keep the same status
   * mapping.
   */
  private _sendMediaResolveError(
    res: ServerResponse,
    fail: {
      reason: 'invalid-uid' | 'not-ready' | 'remote-host' | 'volume-missing' | 'ambiguous' | 'daemon-error'
      logCtx: Record<string, unknown>
    },
    context: 'upload' | 'media' | 'file',
  ): void {
    switch (fail.reason) {
      case 'invalid-uid':
        // Reached only when a commercial JWT user has a bad sub; getUserId
        // already rejects unverifiable tokens. Treat as auth failure.
        this.log.warn(`${context}: invalid-uid`, fail.logCtx)
        this.sendError(res, 401, 'invalid auth')
        return
      case 'not-ready':
        // User has no active container yet (provisioning window). Frontend
        // re-tries on a backoff — surface 503 + Retry-After so UI/proxy
        // honors it.
        this.log.info(`${context}: container not ready`, fail.logCtx)
        res.setHeader('Retry-After', '5')
        this.sendError(res, 503, 'container not ready, please retry shortly')
        return
      case 'remote-host':
        // User is currently placed on a remote compute host. Plan B doesn't
        // yet push media to remote-host volumes; deferred. Surface 503
        // rather than guess.
        this.log.warn(`${context}: remote-host placement (deferred)`, fail.logCtx)
        this.sendError(res, 503, 'media on remote-host placement not supported yet')
        return
      case 'volume-missing':
        // DB says active but docker volume gone. Data corruption / GC race.
        this.log.error(`${context}: docker volume missing despite active state`, fail.logCtx)
        this.sendError(res, 500, 'storage layout inconsistent — admin investigating')
        return
      case 'ambiguous':
        // Multiple active rows for one user. Data corruption.
        this.log.error(`${context}: ambiguous active containers`, fail.logCtx)
        this.sendError(res, 500, 'storage layout inconsistent — admin investigating')
        return
      case 'daemon-error':
        // PG query error or docker daemon error (non-404).
        this.log.error(`${context}: resolver daemon error`, fail.logCtx)
        this.sendError(res, 500, 'storage layer unavailable')
        return
    }
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

  /**
   * GET /api/file?path=<absolute> — fetch a file by absolute path (allowlisted).
   *
   * Used by the UI when an agent tool output references a file by absolute
   * path (e.g. uploaded image saved at /var/lib/docker/volumes/...).
   *
   * v3 commercial multi-tenant: the user-scoped allowlist predicate is
   * derived from `_resolveMediaDirs(userId)`, NOT from a global textual
   * predicate. This is what prevents user A from reading user B's docker
   * volume media by guessing/leaking absolute paths.
   *
   * Failure modes from the resolver are translated by `_sendMediaResolveError`
   * (not-ready → 503+Retry, etc.). For users with no active container,
   * /api/file silently degrades: still serves OPENCLAUDE_HOME / tmp / agent
   * cwd paths (no docker-volume access), so legacy assets keep working.
   */
  private async handleApiFile(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
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
    const userId = this.getUserId(req)
    const mediaLoc = await this._resolveMediaDirs(userId)
    let realPath: string
    try {
      realPath = realpathSync(resolved)
    } catch {
      // 2026-05-16 Phase 2:本地 realpathSync 失败时,若该路径文本上属于 remote-host
      // 用户的 docker volume uploads/generated 子目录(master 本机物理上没这个
      // volume — 用户被调度到远端 compute host),走 node-agent /files GET 拉远端
      // 字节回服。否则维持原 404 行为。
      //
      // 安全:复用 makeUserScopedMediaPredicate 做边界安全前缀判定(`p === dir ||
      // p.startsWith(dir + '/')`),不裸 startsWith(防 `uploads-evil/x` 误中)。
      // 拉到字节后仍走 isFileBlocked + active MIME→attachment + inline/attachment
      // 双模,与本地分支完全对称(Codex review 2:remote 安全语义不能降级)。
      if (
        mediaLoc.kind === 'fail' &&
        mediaLoc.reason === 'remote-host' &&
        this.deps.commercial?.pullRemoteHostMedia
      ) {
        const remoteScoped = makeUserScopedMediaPredicate(mediaLoc.uploads, mediaLoc.generated)
        if (remoteScoped(resolved)) {
          let buf: Buffer | null = null
          try {
            buf = await this.deps.commercial.pullRemoteHostMedia({
              hostUuid: mediaLoc.hostUuid,
              remotePath: resolved,
            })
          } catch (err) {
            this.log.error(
              'api/file: remote-host pull failed',
              { hostUuid: mediaLoc.hostUuid, remotePath: resolved, ...mediaLoc.logCtx },
              err as Error,
            )
            this.sendError(res, 502, 'remote storage pull failed')
            return
          }
          if (buf === null) {
            // Codex review #1 (Phase 2): null 表示远端 404;空 Buffer(0 字节文件)
            // 是合法命中,不能被 falsy 吞掉。
            res.writeHead(404)
            res.end('not found')
            return
          }
          if (isFileBlocked(resolved)) {
            this.log.warn('api/file: remote hit blocked by sensitive deny-list', { path: resolved })
            res.writeHead(403)
            res.end('access denied')
            return
          }
          const remoteFileContentType = mimeFor(resolved)
          const remoteFileDispositionMode = shouldServeInline(remoteFileContentType) ? 'inline' : 'attachment'
          res.writeHead(200, {
            'Content-Type': remoteFileContentType,
            'Content-Length': buf.length,
            'Cache-Control': 'private, max-age=3600',
            'Content-Disposition': `${remoteFileDispositionMode}; filename="${encodeURIComponent(basename(resolved) || 'file')}"`,
          })
          res.end(buf)
          return
        }
      }
      res.writeHead(404)
      res.end('not found')
      return
    }
    const agentCwds = this.deps.agentsConfig.agents
      .map((a) => a.cwd)
      .filter((c): c is string => !!c)
    // V3 multi-tenant: resolve the caller's docker-volume {uploads, generated}
    // dirs for a **user-scoped** allowlist predicate. Critical: this is what
    // closes the cross-tenant IDOR — a textual "any user volume" predicate
    // (the previous `isUserVolumeUploadsPath` approach) would let user A read
    // any user's media by absolute path.
    //
    // If resolve fails (not-ready / volume-missing / etc.), don't 5xx the
    // request: just fall through with no extraAllowed predicate. /api/file
    // can still serve static FILE_ALLOWED_DIRS / agent cwd paths — only
    // docker-volume media access is silently denied, which is the safest
    // degradation. (Returning 503 here would break personal-version flows
    // running side-by-side and confuse tool-output rendering for users
    // whose container is mid-provisioning.)
    const userScopedAllowed = mediaLoc.kind === 'fail'
      ? undefined
      : makeUserScopedMediaPredicate(mediaLoc.uploads, mediaLoc.generated)
    if (!isFileAllowed(realPath, agentCwds, userScopedAllowed)) {
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
    const fd = this.openFileHardened(res, realPath, agentCwds, userScopedAllowed)
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
    // Inline only previewable media; document/text artifacts must download.
    const fileDispositionMode = shouldServeInline(fileContentType) ? 'inline' : 'attachment'
    res.writeHead(200, {
      'Content-Type': fileContentType,
      'Content-Length': fileStat.size,
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': `${fileDispositionMode}; filename="${encodeURIComponent(basename(realPath) || 'file')}"`,
    })
    createReadStream(null as unknown as string, { fd, autoClose: true }).pipe(res)
  }

  /**
   * GET /api/media/<filename> — fetch a previously uploaded or generated file.
   *
   * V3 multi-tenant: both uploads/ AND generated/ lookup are scoped to the
   * **caller's** per-user docker volume host path. Personal/legacy mode falls
   * back to paths.uploadsDir + paths.generatedDir.
   *
   * Note: closes the pre-existing IDOR — previously any authed user could
   * fetch any digest known to them via /api/media/<digest>.<ext>. Per-user
   * dir routing + user-scoped extraAllowed predicate now restricts cross-user
   * access for both uploads and codex image_gen output.
   */
  private async handleMediaGet(
    req: IncomingMessage,
    res: ServerResponse,
    rawFilename: string,
  ): Promise<void> {
    let filename: string
    try {
      filename = decodeURIComponent(rawFilename)
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
    const userIdForMedia = this.getUserId(req)
    const mediaLocation = await this._resolveMediaDirs(userIdForMedia)
    if (mediaLocation.kind === 'fail') {
      // 2026-05-16 Phase 2:remote-host 用户走 node-agent /files GET 拉远端 user
      // volume 文件回服。其余 fail 原因(not-ready / volume-missing / 等)继续
      // 走 _sendMediaResolveError 既有语义。
      //
      // 与本地分支的安全/响应头**完全对称**(Codex review 2:确保 isFileBlocked /
      // active MIME → attachment / Cache-Control / Content-Length 都跟本地一致,
      // 不能"远端走捷径"):
      //   - mimeFor 用 filename(无 realpath 可言,filename 经 traversal 校验)
      //   - 命中前查 isFileBlocked(防 `.env` 等 deny-list)
      //   - active content 强制 attachment + filename
      //   - Content-Length 取 buffer.length(node-agent 已校 MaxFileSize)
      if (
        mediaLocation.reason === 'remote-host' &&
        this.deps.commercial?.pullRemoteHostMedia
      ) {
        const remoteCandidates = [
          `${mediaLocation.uploads}/${filename}`,
          `${mediaLocation.generated}/${filename}`,
        ]
        let buf: Buffer | null = null
        let hitPath: string | null = null
        for (const remotePath of remoteCandidates) {
          try {
            const result = await this.deps.commercial.pullRemoteHostMedia({
              hostUuid: mediaLocation.hostUuid,
              remotePath,
            })
            if (result !== null) {
              buf = result
              hitPath = remotePath
              break
            }
          } catch (err) {
            this.log.error(
              'media: remote-host pull failed',
              { hostUuid: mediaLocation.hostUuid, remotePath, ...mediaLocation.logCtx },
              err as Error,
            )
            this.sendError(res, 502, 'remote storage pull failed')
            return
          }
        }
        if (buf === null || hitPath === null) {
          // Codex review #1 (Phase 2):空 Buffer(0 字节文件)是合法命中,
          // 必须用严格 === null 判定,不能用 falsy。
          res.writeHead(404)
          res.end('not found')
          return
        }
        if (isFileBlocked(hitPath)) {
          this.log.warn('media: remote hit blocked by sensitive deny-list', { hitPath })
          res.writeHead(403)
          res.end('access denied')
          return
        }
        const remoteContentType = mimeFor(hitPath)
        const remoteHeaders: Record<string, string | number> = {
          'Content-Type': remoteContentType,
          'Content-Length': buf.length,
          'Cache-Control': 'private, max-age=3600',
        }
        remoteHeaders['Content-Disposition'] = `${shouldServeInline(remoteContentType) ? 'inline' : 'attachment'}; filename="${encodeURIComponent(basename(hitPath) || 'file')}"`
        res.writeHead(200, remoteHeaders)
        res.end(buf)
        return
      }
      this._sendMediaResolveError(res, mediaLocation, 'media')
      return
    }
    // Search in uploads first, then generated. Resolve via realpath so a
    // symlink inside uploads/ cannot escape the directory. baseReal also
    // goes through realpathSync — without that, the dir being a symlink
    // (rare but possible in some deployments) would fail the startsWith
    // check after the candidate's realpath resolves to the symlink target.
    const dirs = [mediaLocation.uploads, mediaLocation.generated]
    let realPath: string | null = null
    for (const dir of dirs) {
      let baseReal: string
      try {
        baseReal = realpathSync(dir)
      } catch {
        // Directory may not exist yet (e.g. fresh install with no uploads
        // OR no codex image_gen has run yet → generated dir not created).
        continue
      }
      const candidate = resolve(baseReal, filename)
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
    // User-scoped allowlist predicate: limit to **this request's** resolved
    // uploads + generated dirs. In legacy/personal mode these equal
    // paths.uploadsDir + paths.generatedDir (also in FILE_ALLOWED_DIRS, so
    // the predicate is a no-op there). In commercial mode this is what
    // prevents cross-tenant absolute-path leaks — without it, a textual
    // predicate would let user A read user B's docker volume files.
    const userScopedAllowed = makeUserScopedMediaPredicate(mediaLocation.uploads, mediaLocation.generated)
    // Blocklist check — someone could drop a .env into uploads/.
    if (isFileBlocked(realPath)) {
      res.writeHead(403)
      res.end('access denied')
      return
    }
    const fd = this.openFileHardened(res, realPath, agentCwds, userScopedAllowed)
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
    const mediaHeaders: Record<string, string | number> = {
      'Content-Type': mediaContentType,
      'Content-Length': mediaStat.size,
      'Cache-Control': 'private, max-age=3600',
    }
    mediaHeaders['Content-Disposition'] = `${shouldServeInline(mediaContentType) ? 'inline' : 'attachment'}; filename="${encodeURIComponent(basename(realPath) || 'file')}"`
    res.writeHead(200, mediaHeaders)
    createReadStream(null as unknown as string, { fd, autoClose: true }).pipe(res)
  }

  /**
   * POST /api/uploads — streaming single-file upload (Plan B 2026-05-09).
   *
   * Body is the raw file bytes. Required headers:
   *   - Content-Type: file MIME type (validated against UPLOAD_MIME_PREFIXES)
   * Optional:
   *   - Content-Length: when present, used for early reject (saves bandwidth);
   *     when absent, streaming guard rejects mid-stream if bytes > MAX_UPLOAD_SINGLE.
   *   - X-Filename: URL-encoded original filename (display only; doesn't affect storage).
   *
   * Response: 200 { url, digest, size, mimeType }
   * Errors: 400 / 413 (too large) / 415 (mime) / 500 (write failed)
   *
   * Storage: streams to `<uploadsDir>/.tmp-<random>` while computing sha256;
   * on success atomically renames to `<digest>.<ext>`. If a file with the
   * same digest already exists, dedups (tmp removed, existing path returned).
   */
  private async handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // ── 1. MIME validation ──
    const ctype = (req.headers['content-type'] || '').toString().split(';')[0].trim().toLowerCase()
    if (!ctype) {
      this.sendError(res, 400, 'missing content-type')
      req.destroy()
      return
    }
    if (!isUploadMimeAllowed(ctype)) {
      this.sendError(res, 415, `unsupported mime: ${ctype}`)
      req.destroy()
      return
    }

    // ── 2. Content-Length early reject (when present) ──
    const declared = req.headers['content-length']
    if (declared !== undefined) {
      const n = Number(declared)
      if (!Number.isFinite(n) || n < 0 || !/^\d+$/.test(String(declared))) {
        this.sendError(res, 400, 'invalid content-length')
        req.destroy()
        return
      }
      if (n > MAX_UPLOAD_SINGLE) {
        this.sendError(res, 413, `file exceeds ${MAX_UPLOAD_SINGLE / 1024 / 1024}MB`)
        req.destroy()
        return
      }
    }

    // ── 3a. Resolve per-user uploads directory ──
    // V3 multi-tenant: writes land in the user's docker volume host path so
    // the container side dispatchInbound (running inside oc-v3-u<uid>) reads
    // the same physical file via its `/home/agent/.openclaude/uploads/` mount.
    // Personal / legacy `default` users fall to paths.uploadsDir unchanged.
    // (generated dir is co-resolved but unused on the write path — we only
    // care that the volume exists, which the single resolve call confirms.)
    //
    // V3 remote-host (2026-05-16): when the user's container is on a non-self
    // compute host, master cannot write to a local docker volume — we stage
    // the upload under master's own paths.uploadsDir (just for hashing) and
    // then push the bytes via `pushRemoteHostUpload` (mTLS node-agent /files
    // PUT) to the **remote** volume host path. The final URL still resolves
    // through /api/media but read-back over the wire is Phase 2; this patch
    // unblocks the write path so the in-container agent can see the file.
    const userId = this.getUserId(req)
    // ── 3a-pre. Commercial cold-start guard (v1.0.192) ──
    // 在解析 user-scoped uploads dir 之前确保用户容器已 provision + volume 已挂载
    // + container running。否则会出现:`_resolveMediaDirs` 返回 ok(DB 行 active)
    // 但 docker container 没起来 → upload 写到 volume host path → 容器内 agent
    // 看不到文件 / 看到陈旧视图。
    //
    // 仅对 commercial userId(形如 `c:<digits>`,strict regex)启用,personal-version
    // 维持原行为。malformed `c:` 前缀(非纯数字)跳过 ensure,让 `_resolveMediaDirs`
    // 的 `invalid-uid` 路径继续判定(保住既有 401 语义)。
    //
    // 上界对齐 `parseCommercialUid`(userMedia.ts):commercial 的 uid 合同是
    // `<= Number.MAX_SAFE_INTEGER`(2^53 - 1,16-17 位)—— supervisor /
    // resolver / container proxy 全部沿用这个合同。所以这里也只在该合同内才
    // 触发 ensure;超过(理论 19 位 abuse 输入)跳过 ensure,继续让
    // `_resolveMediaDirs.parseCommercialUid` 把它判 invalid-uid → 401。否则
    // ensure 内部 `makeV3EnsureRunning` 会拒绝并抛 ContainerUnreadyError("invalid_uid"),
    // 把原本的 401 翻成 503,语义错位。
    //
    // 底层与 WS bridge / `/api/media-signed` / commercial router file proxy 共享
    // 同一 `sharedEnsureRunning`(per-uid singleflight),同时刻 reload 的 burst
    // 拉只触发一次 provision。
    const ensure = this.deps.commercial?.ensureContainerReady
    if (ensure && /^c:[1-9][0-9]{0,18}$/.test(userId)) {
      const uid = BigInt(userId.slice(2))
      if (uid <= BigInt(Number.MAX_SAFE_INTEGER)) {
        try {
          const r = await ensure(uid)
          if (!r.ok) {
            res.setHeader('Retry-After', String(r.retryAfterSec))
            this.sendError(res, 503, `container not ready: ${r.reason}`)
            req.destroy()
            return
          }
        } catch (err) {
          this.log.warn('handleUpload: ensureContainerReady threw', { userId }, err)
          res.setHeader('Retry-After', '5')
          this.sendError(res, 503, 'container not ready')
          req.destroy()
          return
        }
      }
      // uid > MAX_SAFE_INTEGER:跳过 ensure,让 _resolveMediaDirs 路径维持 invalid-uid 401。
    }
    const locationResult = await this._resolveMediaDirs(userId)
    let remoteUpload: {
      hostUuid: string
      remoteUploadsDir: string
    } | null = null
    let uploadsDir: string
    let isPerUser = false
    if (locationResult.kind === 'fail') {
      if (locationResult.reason === 'remote-host' && this.deps.commercial?.pushRemoteHostUpload) {
        // Stage locally; we push to remote after we have the final bytes + digest.
        // Use master's own paths.uploadsDir for the .tmp- staging file — it's
        // already mode 0755 root:root and the orphan sweep cleans .tmp-* there.
        remoteUpload = {
          hostUuid: locationResult.hostUuid,
          remoteUploadsDir: locationResult.uploads,
        }
        uploadsDir = paths.uploadsDir
        isPerUser = false
      } else {
        this._sendMediaResolveError(res, locationResult, 'upload')
        req.destroy()
        return
      }
    } else {
      uploadsDir = locationResult.uploads
      isPerUser = locationResult.kind === 'ok'
    }

    // ── 3b. Resolve uploadsDir realpath after ensuring it exists ──
    // Don't depend on startup sequence; create-then-realpath here.
    let baseReal: string
    try {
      mkdirSync(uploadsDir, { recursive: true })
      baseReal = realpathSync(uploadsDir)
    } catch (err) {
      this.log.error('handleUpload: uploadsDir setup failed', { uploadsDir }, err)
      this.sendError(res, 500, 'storage unavailable')
      req.destroy()
      return
    }

    // ── 4. Open .tmp fd-first + streaming write + sha256 ──
    //
    // TOCTOU hardening (v1.0.155):
    //   1. openSync(O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0o600) — atomic create,
    //      fail-closed if last component is a symlink or already exists.
    //   2. realpathSync(/proc/self/fd/<n>) === tmpPath — parent-symlink race
    //      defense (mirrors openFileHardened on the read path). If parent dir
    //      was rename-swapped to a symlink in the window between baseReal
    //      resolve and openSync, our fd lives outside the upload root and we
    //      fail closed.
    //   3. createWriteStream(..., { fd, autoClose: false }) — we own fd
    //      lifetime via the outer try/finally; ws.destroy() does NOT close it.
    //   4. fchmod/fchown on the fd (not path) — immune to attacker rename
    //      between TOCTOU validate and chmod.
    //   5. Post-link verify (fd realpath + dev/ino fstat compare) — guarantees
    //      finalPath is the inode we just created, not an attacker-planted
    //      collision.
    //
    // Architecture (Codex B1 review fix v2):
    //   • Single state-machine variable `settled` resolves the await Promise
    //     exactly once. Every termination path calls `finish(ok)`.
    //   • We DO NOT listen for `req.close` — it fires on both normal completion
    //     and abnormal disconnect, and tends to fire BEFORE `ws.finish`. Using
    //     it for cleanup mis-deletes successful uploads. Instead we rely on
    //     `ws.finish` / `ws.error` / `req.error` / `req.aborted` only.
    //   • `cleanupTmp()` is the single place that destroys ws (with an Error
    //     to ensure ws.error fires) and unlinks the .tmp dirent. Idempotent
    //     via `cleaned` flag. fd is closed by the outer try/finally
    //     (`closeTmpFd`), not by cleanupTmp — keeps fd lifetime in one place.
    const tmpName = `.tmp-${randomBytes(16).toString('hex')}`
    const tmpPath = join(baseReal, tmpName)

    let tmpFd: number | null = null
    const closeTmpFd = (): void => {
      if (tmpFd === null) return
      try { closeSync(tmpFd) } catch {}
      tmpFd = null
    }

    try {
      try {
        tmpFd = openSync(
          tmpPath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
          0o600,
        )
      } catch (err) {
        this.log.error('handleUpload: tmp open failed', { tmpPath }, err)
        this.sendError(res, 500, 'storage open failed')
        req.destroy()
        return
      }
      // Verify the fd actually points to our intended path (parent-symlink
      // race defense). If divergent, the file was created somewhere outside
      // our upload root via a swapped parent symlink — best-effort unlink
      // the bogus dirent via its REAL path (not tmpPath, which now points
      // somewhere else entirely) and fail closed. Disk-leak DoS in the
      // worst case if the unlink races again; not a security boundary
      // violation. Documented in docs/audit-file-toctou.md.
      let tmpFdReal: string
      try {
        tmpFdReal = realpathSync(`/proc/self/fd/${tmpFd}`)
      } catch (err) {
        this.log.error('handleUpload: tmp fd realpath failed', { tmpPath }, err)
        try { unlinkSync(tmpPath) } catch {}
        this.sendError(res, 500, 'storage verify failed')
        req.destroy()
        return
      }
      if (tmpFdReal !== tmpPath) {
        this.log.warn('handleUpload: tmp fd diverged from intended path', {
          tmpPath,
          tmpFdReal,
        })
        try { unlinkSync(tmpFdReal) } catch {}
        this.sendError(res, 500, 'storage path diverged')
        req.destroy()
        return
      }

      const ws = createWriteStream(null as unknown as string, { fd: tmpFd, autoClose: false })
      const hash = createHash('sha256')
      let received = 0
      let cleaned = false
      let settled = false
      let resolveWrite: (ok: boolean) => void = () => {}
      const writeDone = new Promise<boolean>((resolveP) => {
        resolveWrite = resolveP
      })
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        resolveWrite(ok)
      }

      const cleanupTmp = (cause?: Error) => {
        if (cleaned) return
        cleaned = true
        try { ws.destroy(cause ?? new Error('upload cleanup')) } catch {}
        unlink(tmpPath, () => {})
      }

      req.on('aborted', () => {
        cleanupTmp(new Error('client aborted'))
        finish(false)
      })
      req.on('error', (err) => {
        this.log.warn('handleUpload: req error', undefined, err)
        cleanupTmp(err)
        finish(false)
      })
      ws.on('error', (err) => {
        // Triggered either by upstream cleanupTmp() destroying us, or by a real
        // disk write failure. Either way, we're done.
        this.log.warn('handleUpload: write stream error', undefined, err)
        cleanupTmp(err)
        if (!res.headersSent) {
          this.sendError(res, 500, 'write failed')
        }
        finish(false)
      })
      ws.on('finish', () => {
        // Only "happy path" terminator. Note: ws emits 'finish' AFTER the file
        // is fully flushed, so it's safe to fchmod/link in the await-then block.
        finish(true)
      })

      let exceededLimit = false
      req.on('data', (chunk: Buffer) => {
        if (exceededLimit) return
        received += chunk.length
        if (received > MAX_UPLOAD_SINGLE) {
          exceededLimit = true
          if (!res.headersSent) {
            this.sendError(res, 413, `file exceeds ${MAX_UPLOAD_SINGLE / 1024 / 1024}MB`)
          }
          // Order matters: unpipe BEFORE destroying req, so any in-flight data
          // doesn't trigger a write on the destroyed ws (and the corresponding
          // ws.error path which is already handled by cleanupTmp).
          try { req.unpipe(ws) } catch {}
          cleanupTmp(new Error('upload exceeded MAX_UPLOAD_SINGLE'))
          try { req.destroy() } catch {}
          finish(false)
          return
        }
        hash.update(chunk)
      })

      // Pipe data into the write stream. ws.finish / ws.error / req.error /
      // req.aborted / size-limit overflow each call finish() exactly once.
      req.pipe(ws)
      const writeOk = await writeDone

      if (!writeOk || cleaned || exceededLimit) {
        // Some error path already responded (413, 500, or req-aborted with no
        // headers). If somehow none has, send a generic abort.
        cleanupTmp()
        if (!res.headersSent && !res.writableEnded) {
          this.sendError(res, 400, 'upload aborted')
        }
        return
      }

      // ── 5. Compute final name + per-user prep + atomic publish ──
      const digest = hash.digest('hex')
      const ext = uploadExtForMime(ctype)
      const finalName = `${digest}.${ext}`
      const finalPath = join(baseReal, finalName)

      // 5-remote. Remote-host placement: bytes are still on master's local tmp;
      // ship them to the remote node-agent /files which writes into the user's
      // docker volume on that host. node-agent end does chown(1000:1000)+chmod
      // 0644 via owner_uid/owner_gid/mode query params (equivalent to the local
      // self-host branch below). On success we drop the local staging file.
      //
      // Path-based readFile here is safe: our tmpFd was verified to point at
      // tmpPath above, and remote write is to a root-owned destination that
      // re-validates with node-agent's own AllowedRoots. Worst case if attacker
      // races a parent swap right now: readFile fails or returns attacker
      // content (signed by digest we already computed — would diverge → push
      // succeeds but client sees mismatched bytes, no privilege escalation).
      //
      // Dedup is intentionally not optimized here (no preflight stat) — the
      // remote node-agent's PUT is tmp+fsync+rename, so re-pushing the same
      // digest is safe and the bandwidth cost is bounded by MAX_UPLOAD_SINGLE.
      if (remoteUpload) {
        let content: Buffer
        try {
          content = await readFile(tmpPath)
        } catch (err) {
          this.log.error('handleUpload: read local tmp for remote push failed', {
            tmpPath,
            userId,
          }, err)
          try { unlinkSync(tmpPath) } catch {}
          this.sendError(res, 500, 'storage read failed')
          return
        }
        const remotePath = `${remoteUpload.remoteUploadsDir}/${finalName}`
        try {
          await this.deps.commercial!.pushRemoteHostUpload!({
            hostUuid: remoteUpload.hostUuid,
            remotePath,
            content,
          })
        } catch (err) {
          this.log.error('handleUpload: push to remote host failed', {
            hostUuid: remoteUpload.hostUuid,
            remotePath,
            userId,
          }, err)
          try { unlinkSync(tmpPath) } catch {}
          // 502 — upstream (node-agent) failure, distinct from master's own
          // storage failure (500). Frontend retry on this is reasonable.
          this.sendError(res, 502, 'remote storage push failed')
          return
        }
        try { unlinkSync(tmpPath) } catch {}
        this.sendJson(res, 200, {
          url: `/api/media/${finalName}`,
          digest,
          size: received,
          mimeType: ctype,
        })
        return
      }

      // 5a. fd-based mode/owner prep — TOCTOU-safe.
      //
      //   • fchmod 0o644 unconditionally: tmp was opened 0o600; published
      //     files need world-read (served via /api/media stream, but also
      //     read by per-user docker container's agent uid). Behavior delta
      //     vs old path-based code: personal mode previously inherited
      //     createWriteStream default 0o666 - umask (~0o644 with default
      //     umask 0o022); now explicit. Same end-state in 99% of cases.
      //   • fchown to agent uid (1000:1000) only for per-user docker volumes.
      //     Personal mode: same uid as master, chown would be no-op + risk
      //     EPERM on non-root local dev → skip.
      //
      // Routed through `_uploadFsOps.*` for failure-injection in unit tests
      // (see `__setUploadFsOpsForTests`). Failure here only affects our
      // private tmp fd (still pre-link, single dirent), so cleanup unlinks
      // the tmp and the finally closes the fd; no concurrent publisher's
      // file can be touched.
      try {
        _uploadFsOps.fchmodSync(tmpFd, 0o644)
        if (isPerUser) {
          _uploadFsOps.fchownSync(tmpFd, 1000, 1000)
        }
      } catch (err) {
        this.log.error('handleUpload: pre-publish fchmod/fchown failed', {
          tmpPath,
          isPerUser,
          userId,
        }, err)
        try { unlinkSync(tmpPath) } catch {}
        this.sendError(res, 500, 'storage prep failed')
        return
      }

      // 5b. Atomic publish via no-overwrite hardlink. linkSync is atomic +
      // fail-closed on EEXIST (race-free dedup signal). We verify post-link
      // that finalPath actually points to OUR tmp inode (not an attacker-
      // planted collision via parent-symlink swap on finalPath's side).
      let eexistDedup = false
      try {
        _uploadFsOps.linkSync(tmpPath, finalPath)
      } catch (err) {
        const code = (err as { code?: string })?.code
        if (code !== 'EEXIST') {
          this.log.error('handleUpload: link failed', undefined, err)
          try { unlinkSync(tmpPath) } catch {}
          this.sendError(res, 500, 'storage write failed')
          return
        }
        // dedup hit: 既有 finalPath 是先前同 digest 上传 publish 出来的,owner 已
        // 是 agent uid(per-user 模式)或 master uid(personal 模式)。语义正确。
        eexistDedup = true
      }

      // 5c. Post-link verify: parent-symlink defense on finalPath's side,
      // applied to BOTH the just-linked and EEXIST-dedup cases.
      //
      //   (i)   openSync(finalPath, O_RDONLY|O_NOFOLLOW) — last-component
      //         symlink defense (matches openFileHardened).
      //   (ii)  realpathSync(/proc/self/fd/<finalFd>) === finalPath — parent-
      //         symlink race defense (parent swapped between our linkSync
      //         and the open here, or between a prior publish and now).
      //   (iii) fstat(tmpFd).dev/ino === fstat(finalFd).dev/ino — additional
      //         proof for **new** publishes that the link landed on OUR
      //         bytes. Skipped for dedup — by definition dedup means the
      //         inode at finalPath is from a prior request, not our tmpFd.
      //
      // Why dedup also needs (i)+(ii) (Codex 2026-05-16 review fix): without
      // them an attacker could parent-swap finalPath's dir to a controlled
      // location with a pre-placed `<digest>.<ext>` → our linkSync sees
      // EEXIST → we return 200 without ever validating the inode lives under
      // the legitimate upload root. Read-path openFileHardened would later
      // 404 the bogus URL, but we'd have lied to the client about success.
      //
      // Cleanup of finalPath on verify failure:
      //   • new-link path: we just created this inode at finalPath → safe to
      //     best-effort unlinkSync (residual race documented).
      //   • dedup path: we don't own the inode (could be prior legitimate
      //     publish OR attacker plant in attacker-controlled location). Do
      //     NOT unlink — leave the artifact alone, fail closed.
      let finalFd: number | null = null
      try {
        try {
          finalFd = openSync(
            finalPath,
            fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
          )
        } catch (err) {
          this.log.error('handleUpload: post-link open failed', { finalPath, eexistDedup }, err)
          if (!eexistDedup) {
            try { unlinkSync(finalPath) } catch {}
          }
          try { unlinkSync(tmpPath) } catch {}
          this.sendError(res, 500, 'storage publish verify failed')
          return
        }
        let finalReal: string
        try {
          finalReal = realpathSync(`/proc/self/fd/${finalFd}`)
        } catch (err) {
          this.log.error('handleUpload: post-link realpath failed', { finalPath, eexistDedup }, err)
          if (!eexistDedup) {
            try { unlinkSync(finalPath) } catch {}
          }
          try { unlinkSync(tmpPath) } catch {}
          this.sendError(res, 500, 'storage publish verify failed')
          return
        }
        if (finalReal !== finalPath) {
          this.log.error('handleUpload: post-link parent swap detected', {
            finalPath,
            finalReal,
            eexistDedup,
          })
          if (!eexistDedup) {
            try { unlinkSync(finalPath) } catch {}
          }
          try { unlinkSync(tmpPath) } catch {}
          this.sendError(res, 500, 'storage publish diverged')
          return
        }
        if (!eexistDedup) {
          const tmpStat = fstatSync(tmpFd)
          const finalStat = fstatSync(finalFd)
          if (tmpStat.dev !== finalStat.dev || tmpStat.ino !== finalStat.ino) {
            this.log.error('handleUpload: post-link inode mismatch', {
              finalPath,
              tmpDev: tmpStat.dev,
              tmpIno: tmpStat.ino,
              finalDev: finalStat.dev,
              finalIno: finalStat.ino,
            })
            try { unlinkSync(finalPath) } catch {}
            try { unlinkSync(tmpPath) } catch {}
            this.sendError(res, 500, 'storage publish diverged')
            return
          }
        }
      } finally {
        if (finalFd !== null) {
          try { closeSync(finalFd) } catch {}
        }
      }

      // Drop tmp dirent. The inode is kept alive by finalPath's hardlink (new
      // publish) or by the prior publisher's dirent (dedup). Our tmpFd stays
      // open until the outer finally; that's fine — unlinked-but-open is
      // standard Unix semantics.
      try { unlinkSync(tmpPath) } catch {}

      this.sendJson(res, 200, {
        url: `/api/media/${finalName}`,
        digest,
        size: received,
        mimeType: ctype,
      })
    } finally {
      closeTmpFd()
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
        headers: {
          'Content-Type': 'application/json',
          ...(providerKey === 'claude' ? { 'User-Agent': CLAUDE_OAUTH_USER_AGENT } : {}),
        },
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
        // plan v3 §11(日志脱敏): 不入 log 原 body —— OAuth provider 错误响应
        // 可能含完整 access/refresh token 残片(provider 故障时)、内部 grant
        // 配置或客户的 email/account id。body 仅消费一次以释放 connection,
        // 不输入 logger;只 log status code + bodyLen(用于排查"空 body"等
        // 边界 case)。需要详细 body 时 boss 用 curl 重放 OAuth flow 现场抓。
        const _body = await tokenRes.text().catch(() => '')
        this.log.error('oauth token exchange failed', {
          provider: providerKey,
          status: tokenRes.status,
          bodyLen: _body.length,
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

        // v3 commercial: callback path = boss just OAuth'd via the UI →
        // force-write both master and container auth.json so per-user
        // containers can immediately use the shared chatgpt subscription.
        // No expectedPreviousRefreshToken: this is an explicit user action,
        // overwriting any prior file is intended.
        if (providerKey === 'codex') {
          const dirs = getCodexAuthDirs()
          await syncCodexAuthFiles({
            oauth: { accessToken: oauthData.accessToken, refreshToken: oauthData.refreshToken },
            masterDir: dirs.masterDir,
            containerDir: dirs.containerDir,
            containerUid: dirs.containerUid,
            log: this.log,
          }).catch((err) =>
            this.log.warn('codex auth sync after OAuth callback failed', undefined, err),
          )
        }
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

  /**
   * v3 commercial: regenerate master + container auth.json on gateway boot
   * if config has a codexOAuth token. Idempotent — same JSON written to
   * stable paths via atomic rename. Fire-and-forget; never throws.
   */
  private async _selfHealCodexAuthOnBoot(): Promise<void> {
    try {
      const codexOAuth = this.deps.config.auth.codexOAuth
      if (!codexOAuth?.accessToken || !codexOAuth.refreshToken) return
      const dirs = getCodexAuthDirs()
      await syncCodexAuthFiles({
        oauth: { accessToken: codexOAuth.accessToken, refreshToken: codexOAuth.refreshToken },
        masterDir: dirs.masterDir,
        containerDir: dirs.containerDir,
        containerUid: dirs.containerUid,
        log: this.log,
      })
    } catch (err) {
      this.log.warn('codex auth self-heal on boot failed', undefined, err)
    }
  }

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
    // Refresh threshold: 15 min before expiry (was 5 min). v3 plan A9 — wider
    // window so per-user containers reading the bind-mounted container
    // auth.json see the new access_token before the old one expires
    // mid-turn. Combined with the 10-min periodic timer this gives 5–15 min
    // of lead time.
    const REFRESH_LEAD_MS = 15 * 60_000
    const claudeOAuth = this.deps.config.auth.claudeOAuth
    if (claudeOAuth?.refreshToken && (force || Date.now() >= claudeOAuth.expiresAt - REFRESH_LEAD_MS)) {
      await this._refreshToken('claude', claudeOAuth)
    }
    const codexOAuth = this.deps.config.auth.codexOAuth
    if (codexOAuth?.refreshToken && (force || Date.now() >= codexOAuth.expiresAt - REFRESH_LEAD_MS)) {
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
        headers: {
          'Content-Type': 'application/json',
          ...(providerKey === 'claude' ? { 'User-Agent': CLAUDE_OAUTH_USER_AGENT } : {}),
        },
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

        // v3 commercial: refresh path → write master with ownership check
        // (only overwrite if master file's refresh_token is still the one
        // we just consumed = oauth.refreshToken before swap), then write
        // container variant. Single-actor invariant: in v3 commercial the
        // gateway is a single systemd unit — _refreshPromise dedups inside
        // this process. See risk #3 in plan v3 for multi-gateway caveats.
        if (providerKey === 'codex') {
          const dirs = getCodexAuthDirs()
          await syncCodexAuthFiles({
            oauth: { accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken },
            masterDir: dirs.masterDir,
            containerDir: dirs.containerDir,
            containerUid: dirs.containerUid,
            log: this.log,
            expectedPreviousRefreshToken: oauth.refreshToken,
          }).catch((err) =>
            this.log.warn('codex auth sync after token refresh failed', undefined, err),
          )
        }
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
    // 没回传)。仅当 commercial supervisor 显式注入 OPENCLAUDE_TRUST_BRIDGE_IP=<本机 bridge
    // 网关 .1>(self host=172.30.0.1,远端 host 由 v3supervisor.gatewayIpFromV3Cidr 按
    // host.bridge_cidr 算)时生效;个人版 / 任何未配置该 env 的场景下
    // process.env.OPENCLAUDE_TRUST_BRIDGE_IP 为空,旁路恒为 false,checkHttpAuth 行为完全不变。
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
    // V3 S12e CG6 — connection-level trace stash. Read X-Connection-Trace-Id
    // upgrade header(由 master 在 mTLS WS dial 时写入,CG4),失败 fallback
    // newTraceId() + warn(不含 raw value 防 log injection)。Stash 到 ws 上
    // 供 CG7 后续 dispatchInbound stamp 4 类 outbound 使用,以及 ws.connect /
    // disconnect log 关联。
    const connectionTraceId = _parseConnectionTraceIdFromUpgrade(req.headers, this.log)
    ;(ws as any)._connectionTraceId = connectionTraceId
    wsConnectionsTotal.inc()
    this.log.info('ws.connect', { connectionTraceId })
    ws.once('close', () => this.log.debug('ws.disconnect', { connectionTraceId }))

    // Keepalive pong tracking
    ;(ws as any)._isAlive = true
    ws.on('pong', () => {
      ;(ws as any)._isAlive = true
    })

    this.wsClients.add(ws)
    ws.once('close', () => this.wsClients.delete(ws))
    // Phase 4 — ws close 时清 pending bind 队列(WeakMap recentHelloPeers 自动 GC)
    ws.once('close', () => {
      for (const [key, entry] of this._pendingRepoBinds) {
        if (entry.ws === ws) {
          clearTimeout(entry.timer)
          this._pendingRepoBinds.delete(key)
        }
      }
    })
    ws.on('message', async (raw) => {
      try {
      let frame: InboundFrame
      try {
        frame = JSON.parse(raw.toString()) as InboundFrame
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'invalid json' }))
        return
      }
      // Client-side application-level ping. Echo a pong (preserving the
      // optional id) so the client's watchdog can distinguish a live socket
      // from one that's still readyState=1 but frozen by an iOS Safari
      // backgrounded-tab.  Old clients that don't carry `id` get a plain
      // `{type:'pong', ts}` and silently ignore it; new clients require
      // matching id to clear their pending probe.
      if ((frame as any).type === 'ping') {
        try {
          const pingId = (frame as any).id
          ws.send(JSON.stringify({
            type: 'pong',
            ...(pingId !== undefined ? { id: pingId } : {}),
            ts: Date.now(),
          }))
        } catch {}
        return
      }

      // Hello frame: client identifies its sessions so we can auto-resume.
      // We register the WS into clientsByPeer only for peers that have an
      // active session in the session manager (validated server-side).
      if ((frame as any).type === 'inbound.hello') {
        const hello = frame as any
        // Phase 0.3: peers may carry `lastFrameSeq` — the highest frameSeq
        // this tab successfully processed before the disconnect. 0 = never
        // received one (first connect / localStorage wiped / legacy client).
        const peers: Array<{ peerId: string; agentId: string; inFlight?: boolean; lastFrameSeq?: number }> = hello.peers || []
        // Phase 4 — 把这些 peerId 记下来,bind 帧用 5s grace window 校验
        const peerIdSet = new Set<string>()
        for (const p of peers) {
          if (typeof p?.peerId === 'string') peerIdSet.add(p.peerId)
        }
        this._recentHelloPeers.set(ws, { peerIds: peerIdSet, recordedAt: Date.now() })
        // Auto-resume: check if any peer has a resumable session that is NOT already active
        this.autoResumeFromHello(peers, ws).catch((err) =>
          this.log.error('auto-resume failed', undefined, err),
        )
        // 检查 pending bind 队列:有匹配 sessionId 的就 dequeue 处理
        this._flushPendingRepoBinds(ws, peerIdSet)
        return
      }

      // Phase 4 — GitHub session repo bind/unbind 控制帧
      if ((frame as any).type === 'inbound.control.session_repo_bind') {
        // v1.0.95 诊断 instrument:确认容器 gateway 真收到了 master forward 来的 bind 帧
        this.log.info('repo_bind_received', {
          sessionId: (frame as any).sessionId,
          selectionVersion: (frame as any).selectionVersion,
          userId: this.getWsUserId(ws),
        })
        await this._handleSessionRepoBind(ws, frame as any)
        return
      }
      if ((frame as any).type === 'inbound.control.session_repo_unbind') {
        await this._handleSessionRepoUnbind(ws, frame as any)
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
        outboundRingSizeBytes.value = this._outboundRing.totalBytes()
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

  /**
   * Phase 4 — 校验 sessionId 在该 ws 的注册集合或最近 hello peers(grace window)。
   * 三种 outcome:
   *   - 'authorized':立即处理
   *   - 'queued':入 pending,等 hello/message 注册
   *   - 'rejected':硬拒(sessionId 不合法)
   */
  private _checkRepoBindSession(ws: WebSocket, sessionId: string): 'authorized' | 'queued' {
    const userId = this.getWsUserId(ws)
    // grace window:hello 后 5s 内,任何 bind 帧引用其 peerIds 视作 authorized。
    // 帮 race:bind 在 hello 之后但 message 注册之前到达。
    const recent = this._recentHelloPeers.get(ws)
    if (recent && Date.now() - recent.recordedAt <= Gateway.REPO_BIND_HELLO_GRACE_MS) {
      if (recent.peerIds.has(sessionId)) return 'authorized'
    }
    // 直查 clientsByPeer:Codex Phase 4.7 #1 — makePeerKey 是 `userId:channel:peerId`
    // (3 parts),不是 4 parts。直接构造预期 key 避免格式漂移 bug。
    // sessionId 已通过 caller 的 SAFE_GIT_REF / SESSION_ID_RE 校验,sanitizePeerId
    // 后等于自身;仍走 sanitize 与 dispatch 路径(L3459-3460)的 makePeerKey 保持一致。
    const sanitizedSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
    const expectedKey = Gateway.makePeerKey(userId, 'webchat', sanitizedSid)
    const set = this.clientsByPeer.get(expectedKey)
    if (set?.has(ws)) return 'authorized'
    return 'queued'
  }

  /** Phase 4 — bind 帧处理 */
  private async _handleSessionRepoBind(
    ws: WebSocket,
    frame: SessionRepoBindFrame,
  ): Promise<void> {
    // 基础 schema 校验(master bridge 已做严格校验,这里兜底)。
    // Codex Phase 5 review P1:owner/repo/branch typeof + selectionVersion safe-int 必须显式
    // 校验,否则 manager 里 regex.test(undefined) 会把 'undefined' 字符串通过,
    // version 被 NaN/Infinity/小数/负数 污染会进路径和 pending key。
    const isSafePositiveInt =
      typeof frame.selectionVersion === 'number' &&
      Number.isSafeInteger(frame.selectionVersion) &&
      frame.selectionVersion > 0
    const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
    if (
      !isNonEmptyStr(frame.sessionId) ||
      !/^[A-Za-z0-9_-]+$/.test(frame.sessionId) ||
      !isSafePositiveInt ||
      !isNonEmptyStr(frame.accessToken) ||
      !isNonEmptyStr(frame.owner) ||
      !isNonEmptyStr(frame.repo) ||
      !isNonEmptyStr(frame.branch)
    ) {
      this._sendStatusFrame(ws, {
        type: 'outbound.control.session_repo_status',
        sessionId: String(frame?.sessionId ?? ''),
        selectionVersion: isSafePositiveInt ? frame.selectionVersion : 0,
        status: 'failed',
        errorCode: 'INVALID_BIND_FRAME',
        errorMessage: 'bind frame schema invalid',
      })
      return
    }
    const auth = this._checkRepoBindSession(ws, frame.sessionId)
    // v1.0.95 诊断 instrument:确认 auth 走了哪条路径(authorized / queued)
    this.log.info('repo_bind_auth_decision', {
      sessionId: frame.sessionId,
      selectionVersion: frame.selectionVersion,
      auth,
    })
    if (auth === 'queued') {
      // 入 pending 5s 队列
      const key = `${frame.sessionId}|${frame.selectionVersion}`
      // 同 key 已在 pending → 覆盖(用最新 frame)
      const old = this._pendingRepoBinds.get(key)
      if (old) clearTimeout(old.timer)
      const timer = setTimeout(() => {
        this._pendingRepoBinds.delete(key)
        // v1.0.95 诊断 instrument:5s grace 没等到 hello 注册 → 走 fail 路径
        this.log.warn('repo_bind_pending_timeout', {
          sessionId: frame.sessionId,
          selectionVersion: frame.selectionVersion,
        })
        this._sendStatusFrame(ws, {
          type: 'outbound.control.session_repo_status',
          sessionId: frame.sessionId,
          selectionVersion: frame.selectionVersion,
          status: 'failed',
          errorCode: 'SESSION_NOT_REGISTERED',
          errorMessage: 'session not registered with this WS within grace window',
        })
      }, Gateway.REPO_BIND_PENDING_TIMEOUT_MS)
      this._pendingRepoBinds.set(key, { ws, frame, timer })
      return
    }
    // authorized → 立即处理
    await this._repoWorkspace.bind(frame, this._buildStatusCallback(ws, frame.sessionId))
  }

  /**
   * Phase 5:bind status 回调统一 wrapper。两个路径共用(立即处理 / pending flush)。
   * 顺序:先 forward 给 ws → 再读 _repoWorkspace 当前 snapshot 触发 recycle。
   * 单进程下 status callback 是 _repoWorkspace 短锁内 commit 后才调,
   * getRepoSnapshot 此时已是最新值,recycle 决策按最新 snapshot 走。
   */
  private _buildStatusCallback(
    ws: WebSocket,
    sessionId: string,
  ): (frame: SessionRepoStatusOut) => void {
    return (statusFrame) => {
      this._sendStatusFrame(ws, statusFrame)
      const snap = this._repoWorkspace.getRepoSnapshot(sessionId)
      this.sessions
        .recyclePeerForRepoChange(sessionId, snap)
        .catch((err) =>
          this.log.warn('recycle_for_repo_change_failed', {
            sessionId,
            err: err instanceof Error ? err.message : String(err),
          }),
        )
    }
  }

  /**
   * Phase 4 — unbind 帧处理(Phase 5 加版本化)。
   *
   * 顺序(关键):
   *   1. _repoWorkspace.unbind(sessionId, version)  短锁内 state.delete
   *      → 之后 getRepoSnapshot 返 null
   *   2. recyclePeerForRepoUnbind(sessionId)        进 session.lock,shutdown runner
   *      → 排队的 submit 拿到 lock 时读 null snapshot,addDir 回 agentBaseDir
   *
   * 没有 selectionVersion 的 unbind 帧:rejected(理论不该发生,前端必带版本号;
   * 没版本的话 workspaceMgr 的 tombstone-too-old 保护就失效)。
   */
  private async _handleSessionRepoUnbind(
    ws: WebSocket,
    frame: { sessionId: string; selectionVersion?: number },
  ): Promise<void> {
    if (typeof frame?.sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(frame.sessionId)) return
    if (
      typeof frame.selectionVersion !== 'number' ||
      !Number.isSafeInteger(frame.selectionVersion) ||
      frame.selectionVersion <= 0
    ) {
      this.log.warn('repo_unbind_invalid_version', {
        sessionId: frame.sessionId,
        selectionVersion: frame.selectionVersion,
      })
      return
    }
    // unbind 不要求 ws 注册校验:用户主动清空,任何路径来都允许。
    // Codex Phase 5 review P0:unbind 返 boolean,只在真删 state 时 recycle。
    // stale tombstone(workspace 已被新 version 替换)被 manager ignore 时 caller
    // 必须不 kill runner — 否则旧 v_x runner 被错杀,新 v_y 还在 cloning,下次
    // spawn 读 ready snapshot 走 v_y workspaceDir 而非 v_x。
    const deleted = await this._repoWorkspace.unbind(frame.sessionId, frame.selectionVersion)
    if (!deleted) {
      this.log.info('repo_unbind_skipped_no_recycle', {
        sessionId: frame.sessionId,
        selectionVersion: frame.selectionVersion,
      })
      return
    }
    await this.sessions.recyclePeerForRepoUnbind(frame.sessionId).catch((err) =>
      this.log.warn('recycle_for_repo_unbind_failed', {
        sessionId: frame.sessionId,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    // 不发 status 帧 — DELETE 已经在 master DB 写 cleared
  }

  /** Phase 4 — hello 到达后,看 pending 队列里有没有匹配的 bind 可以处理 */
  private _flushPendingRepoBinds(ws: WebSocket, peerIds: Set<string>): void {
    if (this._pendingRepoBinds.size === 0) return
    for (const [key, entry] of this._pendingRepoBinds) {
      if (entry.ws !== ws) continue
      if (!peerIds.has(entry.frame.sessionId)) continue
      clearTimeout(entry.timer)
      this._pendingRepoBinds.delete(key)
      // async 处理(不阻塞 hello 转发后续)
      // 用同一个 _buildStatusCallback wrapper:既 forward 给 ws,也触发 recycle。
      this._repoWorkspace
        .bind(entry.frame, this._buildStatusCallback(ws, entry.frame.sessionId))
        .catch((err) =>
          this.log.warn('flush_pending_bind_failed', {
            err: err instanceof Error ? err.message : String(err),
          }),
        )
    }
  }

  /** Phase 4 — send outbound.control.session_repo_status to a single ws,容错 closed/error。 */
  private _sendStatusFrame(ws: WebSocket, frame: SessionRepoStatusOut): void {
    try {
      if (ws.readyState !== ws.OPEN) {
        // v1.0.95 诊断 instrument:这是最可能的 silent swallow 点 — 容器侧
        // emit 了 status 但 ws 已闪断,master 永远收不到。Codex NIT:统一字段。
        this.log.warn('repo_status_send_swallowed_ws_closed', {
          sessionId: frame.sessionId,
          selectionVersion: frame.selectionVersion,
          status: frame.status,
          readyState: ws.readyState,
        })
        return
      }
      ws.send(JSON.stringify(frame))
      // v1.0.95 诊断 instrument:status 帧成功推到 ws.send;若 master log 看到这个
      // 但没看到 repo_status_forwarded,根因就在 mTLS tunnel / master bridge 解析侧。
      this.log.info('repo_status_sent', {
        sessionId: frame.sessionId,
        selectionVersion: frame.selectionVersion,
        status: frame.status,
        readyState: ws.readyState,
      })
    } catch (err) {
      this.log.warn('send_repo_status_failed', {
        sessionId: frame.sessionId,
        selectionVersion: frame.selectionVersion,
        status: frame.status,
        err: err instanceof Error ? err.message : String(err),
      })
    }
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
    // Route through the stamped session-frame helper so the settlement is
    // recorded in the outbound ring buffer keyed by sessionKey. A reconnecting
    // tab that missed the live broadcast (e.g. iOS Safari suspended its WS)
    // can then receive the settled frame via ring replay and update the
    // inline permission card from "Waiting" to "Allowed/Denied".
    this._sendStampedSessionFrame(payload.sessionKey, peerKey, {
      type: 'outbound.permission_settled',
      ...payload,
    })
  }

  /** Send a session-scoped wire frame to all WS clients at a peerKey, stamping
   *  it with `frameSeq` + `ts` and storing it in `_outboundRing` so a later
   *  `autoResumeFromHello` reconnect can replay it. WS-only equivalent of
   *  `deliver()` for non-message frames (permission_request / permission_settled).
   *  Adapter dispatch is not applicable — these frames are interactive-only.
   *
   *  When `sessionKey` is empty (legacy fallback path with no server-side
   *  pending entry to look up), we skip ring storage and only broadcast — the
   *  same `else` branch deliver() uses for frames without a sessionKey. */
  private _sendStampedSessionFrame(
    sessionKey: string,
    peerKey: string,
    wireFrame: Record<string, unknown>,
  ): void {
    // V3 S12e CG7 — strip private routing fields before WS broadcast / ring
    // store. Mirrors what `deliver()` does, so `_inheritOutboundRouting(out)`
    // callers(e.g. permFrame builder)can safely include private stamps like
    // `_userId` without leaking on wire. Audit pair with `_stripPrivateRoutingFields`
    // in deliver() — both paths converge through the same known-fields helper.
    const { wire } = _stripPrivateRoutingFields(wireFrame)
    const now = Date.now()
    let data: string
    if (sessionKey) {
      const frameSeq = this._outboundRing.nextSeq(sessionKey)
      data = JSON.stringify({ ...wire, ts: now, frameSeq })
      const evicted = this._outboundRing.store(sessionKey, frameSeq, now, data)
      this._recordRingEvictions(evicted)
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

    for (const peer of peers) {
      const { peerId, agentId } = peer
      // turn-alive-heartbeat (Plan 1, follow-up):destructure all hello-peer
      // fields from the loop iter directly. Previous code did
      // `peers.find(p => p.peerId === peerId)` to re-read `lastFrameSeq` /
      // `inFlight`, but a single hello can legally carry the same peerId
      // against multiple agentIds — that find would match the wrong record
      // and the synthetic-isFinal / replay judgment would silently read the
      // wrong tuple. Reading directly from the loop item is correct by
      // construction.
      const peerLastFrameSeq = peer.lastFrameSeq
      const peerInFlight = peer.inFlight
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
      const clientLastSeq = typeof peerLastFrameSeq === 'number' ? peerLastFrameSeq : 0
      if (clientLastSeq >= 0) {
        const replay = this._outboundRing.peekReplay(sessionKey, clientLastSeq)
        // Read-path pruning may have evicted age-aged frames — record those
        // in metrics regardless of hit/miss outcome, otherwise the `age`
        // cause is severely under-counted for idle sessions whose ring is
        // only ever pruned on resume.
        this._recordRingEvictions(replay.evicted)
        if (replay.ok) {
          // Only count as "hit" when the ring actually rescued frames.
          // `ok` with empty sent means the client was already caught up
          // (fromSeq===currentLast) — the ring did nothing useful, and
          // counting it would inflate hit-rate against ordinary fresh
          // hellos and skew the replay-effectiveness signal.
          if (replay.sent.length > 0) {
            outboundRingReplayHitTotal.inc()
            for (const f of replay.sent) {
              try { ws.send(f.data) } catch { break }
            }
            this.log.info('resume replay served', {
              sessionKey, from: clientLastSeq, to: replay.to, sent: replay.sent.length,
            })
          }
        } else {
          outboundRingReplayMissTotal.inc({ reason: replay.reason })
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

      // Plan 2 (compact-progress-frame) — 在 ring replay 之后,如果 runner 仍在跑
      // 且 session.currentTurnStatus !== null,补发一帧 outbound.turn_status 给本次
      // 重连的 ws。覆盖 "压缩进行中客户端断网 + ring 已冲掉原 compact_start 帧"
      // 这种 ring-replay 兜不住的边角:
      //   - 正常短暂断网:ring 仍持有 compact_start,replay 就够了 → cache 这帧
      //     会被前端识别成幂等(已在 compacting,再来一帧仍 compacting,无副作用)
      //   - 长 compact + 长断网 + ring 满:replay 拿不回 compact_start,这里兜底
      //   - runner 已停:不发(turn 已结束,前端会收到 ring 里的 isFinal 或者
      //     紧跟着的 turn-interrupted isFinal,自行清空 UI 状态)
      // 单 ws send(只给本次 hello 的 client 看,不是所有 peerKey),与下方
      // synthetic isFinal 同模式 —— 不走 deliver(),避免把同一帧再 ring + 广播。
      if (session && session.runner.isRunning && session.currentTurnStatus !== null) {
        try {
          const turnStatusFrame = JSON.stringify({
            type: 'outbound.turn_status',
            sessionKey,
            channel: 'webchat',
            peer: { id: peerId, kind: 'dm' },
            status: session.currentTurnStatus,
            ts: Date.now(),
          })
          ws.send(turnStatusFrame)
          this.log.info('auto-resume rebroadcast turn_status', {
            sessionKey, status: session.currentTurnStatus,
          })
        } catch {}
      }

      // Push a synthetic isFinal to the reconnected client for sessions that the client
      // reports as in-flight (had _sendingInFlight=true) but whose subprocess is not
      // currently running. This clears the client's stuck _sendingInFlight state from
      // the interrupted turn. Without this, the client shows a permanent typing indicator
      // and the resumed subprocess sits idle — neither side moves first.
      //
      // turn-alive-heartbeat (Plan 1) — 判据走 `_shouldPushTurnInterruptedFinal`
      // 纯函数 helper,根治"phantom-turn retry / auth-refresh restart / effort+
      // model swap shutdown 等 turn 内部 subprocess respawn 窗口被误判为 turn 已
      // 结束"的 bug。判据细节 + 真值源对比见 helper 注释。`peerInFlight` 取自
      // 当前 hello-peer iter 项(顶部 destructure),不再用 find(peerId) — 那条
      // 同型债已在循环入口修掉。
      //
      // 当前 scope 限于 `submit()` 内的 subprocess respawn 窗口。dispatchInbound
      // 预处理(mkdir / writeFile / parseDocument 等异步阶段,getOrCreate 后、
      // submit 前)是另一类同症状窗口,留作 Plan 1 follow-up 单独评估
      // (涉及 idempotency / rate-limit 失败路径要不要 counter-- 的语义)。
      if (
        session &&
        _shouldPushTurnInterruptedFinal(
          peerInFlight,
          session.runner.isRunning,
          session._activeTurnCount,
        )
      ) {
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
            meta: { interrupted: 'service_restart' } as any,
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

    const masterHistoricalMessages = Array.isArray((frame as any)._masterHistoricalMessages)
      ? ((frame as any)._masterHistoricalMessages as unknown[])
      : undefined

    // ── V3 S12e CG7 — mint per-turn trace id ──
    // Placed AFTER duplicate idempotency return(dup doesn't open a new turn → no
    // turnTraceId concept)but BEFORE rate-limit so that the rate-limit early-
    // return outbound also carries this turn's trace id. The helper also returns
    // a parsed `clientTraceId`(observation-only echo)but CG7 scope does not yet
    // wire it into any log/frame — left for follow-up CG.
    const { traceId: turnTraceId } = _buildTurnTraceContext(
      (frame as any).clientTraceId,
      this.log,
    )

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
        traceId: turnTraceId,
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
    const cfg = await this._getAgentsConfig()
    if (frame.agentId) {
      const ag = cfg.agents.find((a) => a.id === frame.agentId) ?? { id: frame.agentId }
      agent = ag
      // Include agentId in sessionKey so different agents get isolated subprocesses
      sessionKey = `agent:${frame.agentId}:${frame.channel}:${frame.peer.kind}:${frame.peer.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
    } else {
      const routed = this.router.route(frame)
      sessionKey = routed.sessionKey
      agent = routed.agent
    }

    // ── plan v3 §B/§B1: model→agent fail-closed routing ──
    // 把 inferAgentForModel 接到生产 message 链路。在 agent 已确定 + safeModel 已审过
    // 之后做家族匹配判定:
    //   - gpt-* 模型 + 显式非 codex agent / 默认 agent + gpt-* → 路由到固定 id 'codex'
    //   - claude-* / deepseek-* 模型 + 当前仍在 codex agent(用户刚从 GPT 切到
    //     非 GPT 模型)→ 路由回非 codex agent,让 CCB/Anthropic-compatible
    //     proxy 承接 Claude/DeepSeek
    //   - 找不到 codex agent / 不是 codex-native → fail closed(error='no_codex_agent')
    //   - gpt-* + 显式非 codex agent → fail closed(error='mismatch')
    // 失败 → 立刻向 user 回 error 帧并 return,不进 sessionManager。这样未授权用户
    // 即便绕过 modelPicker 直接 POST,也不会暴露 codex agent 的存在 / 配置状态
    // (canUseModel 在 ws bridge 层已先于此路径拦截,这是 belt-and-suspenders)。
    const _frameModelRaw = (frame as any).model
    const safeModelForRouting: string | undefined =
      typeof _frameModelRaw === 'string' && ALLOWED_INBOUND_MODELS.has(_frameModelRaw)
        ? _frameModelRaw
        : undefined
    if (safeModelForRouting) {
      // 用 router/explicit 已解析出的 agent.id,而不是 frame.agentId ?? cfg.default。
      // 否则如果 router 通过 routes 规则选了一个非 default 的 claude agent,这里会把它
      // 错误地 "降级" 回 cfg.default,造成路由回归(Codex review v2 finding 2)。
      const decision = inferAgentForModel({
        model: safeModelForRouting,
        requestedAgentId: agent.id,
        defaultAgentId: cfg.default,
        agents: cfg.agents,
      })
      if ('error' in decision) {
        const _errUserId: string =
          typeof (frame as any)._userId === 'string' ? (frame as any)._userId : 'default'
        const errFrame = {
          type: 'outbound.message' as const,
          sessionKey,
          channel: frame.channel,
          peer: frame.peer,
          blocks: [
            {
              kind: 'text' as const,
              text: `[error] model routing rejected (${decision.error})`,
            },
          ],
          isFinal: true,
          traceId: turnTraceId,
          _userId: _errUserId,
        }
        // 不要泄漏 decision.reason 内文(可能含 agent provider 等内部线索),
        // 仅给前端 error code,内部细节走 log。
        this.log.warn('inferAgentForModel rejected', {
          model: safeModelForRouting,
          requestedAgentId: agent.id,
          error: decision.error,
          reason: decision.reason,
        })
        this.deliver(errFrame, adapter)
        return
      }
      if (decision.agentId !== agent.id) {
        const overrideAgent = cfg.agents.find((a) => a.id === decision.agentId)
        if (overrideAgent) {
          agent = overrideAgent
          // 模型路由换了 agent → 强制 per-agent 隔离 sessionKey,避免 codex 与
          // 其他 agent 的 subprocess 污染同一 SessionManager 槽。
          sessionKey = `agent:${agent.id}:${frame.channel}:${frame.peer.kind}:${frame.peer.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
        } else {
          // inferAgentForModel 已校验 codex agent 存在,这里不应到达;防御性 log。
          this.log.error('inferAgentForModel returned unknown agentId', {
            decisionAgentId: decision.agentId,
          })
        }
      }
    }

    // ── plan v3 §B4 review v3 finding 1: defense-in-depth ──
    // Gateway runs inside the per-user container with no commercial DB access,
    // so it can't run model authz directly — that's the bridge's job. But
    // bridge's AGENT_AUTHZ_IMPLIED_MODEL allowlist only covers the canonical
    // id='codex'. A user who edits `agents.yaml` to add a second agent with
    // `provider: 'codex-native'` under a custom id and sends
    // `{agentId: '<custom>'}` (no `model` field) would bypass:
    //   - bridge: no frame.model + custom id not in allowlist → no authz check
    //   - gateway: safeModelForRouting=undefined → inferAgentForModel skipped
    //   - sessionManager: provider==='codex-native' → spawns CodexRunner
    // Close the loop here: any codex-native agent execution MUST carry an
    // explicit ALLOWED_INBOUND_MODELS gpt-* model so the bridge's frame.model
    // authz path runs. Frontend always sends `model` with codex selection,
    // so legit flows are unaffected. Reject is fail-closed (error frame +
    // return, never enters sessionManager).
    if (agent.provider === 'codex-native' && !safeModelForRouting) {
      const _errUserId: string =
        typeof (frame as any)._userId === 'string' ? (frame as any)._userId : 'default'
      const errFrame = {
        type: 'outbound.message' as const,
        sessionKey,
        channel: frame.channel,
        peer: frame.peer,
        blocks: [
          {
            kind: 'text' as const,
            text: '[error] codex-native agent requires explicit model field',
          },
        ],
        isFinal: true,
        traceId: turnTraceId,
        _userId: _errUserId,
      }
      this.log.warn('codex-native agent invoked without explicit model — rejected', {
        agentId: agent.id,
      })
      this.deliver(errFrame, adapter)
      return
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

    // Defensive sanitize for InboundMessage.model (2026-04-26 v1.0.4):
    //   - 合法 model id(ALLOWED_INBOUND_MODELS) → 透传给 sessionManager.submit,
    //     在那里比对 runner.model 决定是否 setModel + shutdown(下次 submit 自动 spawn 新模型)
    //   - 缺省 / 非法 → undefined,sessionManager 不动 runner 当前 model
    //   allowlist 抽到文件顶部 export 便于 unit test + 后续加模型集中改一处。
    // 已在 inferAgentForModel 路由前算过(safeModelForRouting),此处复用避免重复。
    const safeModel: string | undefined = safeModelForRouting

    const _frameConversationMode = (frame as any).conversationMode
    const safeConversationMode: 'default' | 'plan' | undefined =
      _frameConversationMode === 'default' || _frameConversationMode === 'plan'
        ? _frameConversationMode
        : undefined

    // PR2 v1.0.66 — 提取 server-owned requestId(master 强制写入)。
    // 容器侧不验证、不生成、也不回退:不带 → undefined,sessionManager 透传给
    // CodexAppServerRunner queue entry,emitResult 时若不带 requestId 则不发
    // codex_billing 帧,master 端没 inflight 行也无所谓(不进入真扣费链路)。
    // 类型 cast 用 (frame as any),与下方 _frameEffort / _frameModelRaw 同模式 ——
    // typebox runtime 不在 ws 帧入口跑(JSON cast),用 typeof 防御。
    const _frameRequestId = (frame as any).requestId
    const safeRequestId: string | undefined =
      typeof _frameRequestId === 'string' && _frameRequestId.length > 0
        ? _frameRequestId
        : undefined

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
      // V3 S12e CG7 — turn-level trace id. Stamped on the main `out` so every
      // streamed block / final frame derived from `out` carries it; derived
      // frames(error / permission_request / codex_billing)copy it via
      // `_inheritOutboundRouting(out)`.
      traceId: turnTraceId,
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
    const effectiveConversationMode = resolveCodexConversationMode({
      requestedMode: safeConversationMode,
      agent,
      model: safeModel,
      text,
      attachmentCount: media.length,
    })

    // Server-side upload validation. Constants live at module level
    // (UPLOAD_MIME_PREFIXES / MAX_UPLOAD_SINGLE / MAX_UPLOAD_TOTAL) so they
    // stay in sync with handleUpload (POST /api/uploads).
    const MAX_FILES_PER_FRAME = 5
    // text-kind attachments 在前端 buildMessageText() 阶段就拼进 content.text,
    // 绕过了下面基于 m.base64 的 per-file 校验。给 content.text 整体上限兜底,
    // 防止 (a) 绕前端构造巨 text 帧 (b) 大 text 附件 + 大正文叠加超 300 MB 契约。
    const textByteLen = Buffer.byteLength(text, 'utf8')
    if (textByteLen > MAX_UPLOAD_TOTAL) {
      const errMsg = `消息文本超过 ${MAX_UPLOAD_TOTAL / 1024 / 1024}MB 限制 (${(textByteLen / 1024 / 1024).toFixed(1)}MB)`
      this.log.warn('upload rejected: text too large', { reason: errMsg, textByteLen, sessionKey })
      this.deliver(
        {
          type: 'outbound.message',
          sessionKey: sessionKey!,
          channel: frame.channel,
          peer: frame.peer,
          blocks: [{ kind: 'text', text: `⚠️ 上传失败: ${errMsg}` }],
          isFinal: true,
          traceId: turnTraceId,
        },
        adapter,
      )
      return
    }
    const rejectFrame = (reason: string, ctx?: Record<string, unknown>) => {
      this.log.warn('upload rejected', { reason, sessionKey, ...ctx })
      this.deliver(
        {
          type: 'outbound.message',
          sessionKey: sessionKey!,
          channel: frame.channel,
          peer: frame.peer,
          blocks: [{ kind: 'text', text: `⚠️ 上传失败: ${reason}` }],
          isFinal: true,
          traceId: turnTraceId,
        },
        adapter,
      )
    }
    if (media.length > MAX_FILES_PER_FRAME) {
      rejectFrame(`附件数量超过 ${MAX_FILES_PER_FRAME} 个限制 (${media.length})`)
      return
    }
    let totalMediaSize = 0
    // First pass — validate base64 (legacy) entries the same way as before so
    // old web bundles still get correct 4xx-style WS error frames.
    for (const m of media) {
      if (!m.base64) continue
      const rawLen = m.base64.length
      const byteLen = Math.ceil(rawLen * 0.75) // base64 → bytes approx
      if (byteLen > MAX_UPLOAD_SINGLE) {
        rejectFrame(
          `附件超过 ${MAX_UPLOAD_SINGLE / 1024 / 1024}MB 限制 (${(byteLen / 1024 / 1024).toFixed(1)}MB)`,
          { byteLen },
        )
        return
      }
      totalMediaSize += byteLen
      if (totalMediaSize > MAX_UPLOAD_TOTAL) {
        rejectFrame(`总附件超过 ${MAX_UPLOAD_TOTAL / 1024 / 1024}MB 限制`, { totalMediaSize })
        return
      }
      const mime = m.mimeType || ''
      if (mime && !isUploadMimeAllowed(mime)) {
        rejectFrame(`不支持的文件类型: ${mime}`, { mime })
        return
      }
    }

    type SavedMedia = {
      kind: string
      path: string
      name: string
      mimeType: string
      sizeHint: string
    }
    const savedMedia: SavedMedia[] = []

    // Resolve uploadsDir realpath once, after ensuring it exists. Any url-only
    // resolution must land inside this canonical path (symlink escape guard).
    let baseReal: string | null = null
    try {
      await mkdir(paths.uploadsDir, { recursive: true })
      baseReal = realpathSync(paths.uploadsDir)
    } catch (err) {
      this.log.error('dispatchInbound: uploadsDir setup failed', undefined, err)
      rejectFrame('存储目录不可用')
      return
    }

    for (const m of media) {
      // ── New url-only path (Plan B) ──
      if (!m.base64 && m.url) {
        const match = m.url.match(/^\/api\/media\/(.+)$/)
        if (!match) { rejectFrame(`非法媒体引用: ${m.url}`); return }
        let filename: string
        try {
          filename = decodeURIComponent(match[1])
        } catch {
          rejectFrame('媒体引用编码错误')
          return
        }
        if (filename.includes('..') || filename.startsWith('/') || filename.startsWith('\\')) {
          rejectFrame('非法媒体路径')
          return
        }
        const candidate = resolve(baseReal, filename)
        if (!candidate.startsWith(baseReal + '/') && candidate !== baseReal) {
          rejectFrame('媒体路径越界')
          return
        }
        let realPath: string
        try {
          realPath = realpathSync(candidate)
        } catch {
          rejectFrame('媒体不存在或不可读')
          return
        }
        if (!realPath.startsWith(baseReal + '/')) {
          rejectFrame('媒体路径越界')
          return
        }
        let stat: ReturnType<typeof statSync>
        try {
          stat = statSync(realPath)
        } catch {
          rejectFrame('媒体不可读')
          return
        }
        // Codex B1 review fix: ensure it's a regular file. uploadsDir could
        // theoretically contain directories, fifos, sockets, or device nodes
        // (e.g. if an admin extracted a tarball there). Same guard the GET
        // /api/media path applies via fstatSync().isFile().
        if (!stat.isFile()) {
          rejectFrame('媒体类型非文件')
          return
        }
        // Aggregate against MAX_UPLOAD_TOTAL — same budget the legacy base64
        // path uses, so a malicious frame referencing many already-uploaded
        // /api/media URLs can't bypass the per-frame ceiling.
        totalMediaSize += stat.size
        if (totalMediaSize > MAX_UPLOAD_TOTAL) {
          rejectFrame(`总附件超过 ${MAX_UPLOAD_TOTAL / 1024 / 1024}MB 限制`, { totalMediaSize })
          return
        }
        const mimeType = m.mimeType || mimeFor(realPath) || 'application/octet-stream'
        savedMedia.push({
          kind: m.kind,
          path: realPath,
          name: m.filename ?? basename(realPath),
          mimeType,
          sizeHint: `${(stat.size / 1024).toFixed(1)}KB`,
        })
        continue
      }
      // ── Legacy base64 path (compat window for old web bundles) ──
      let base64 = m.base64 ?? ''
      if (!base64) continue
      const prefixMatch = base64.match(/^data:([^;]+);base64,(.*)$/)
      const mimeType = prefixMatch ? prefixMatch[1] : (m.mimeType ?? 'application/octet-stream')
      if (prefixMatch) base64 = prefixMatch[2]
      const ext = uploadExtForMime(mimeType)
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
      const fpath = join(baseReal, fname)
      try {
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
      const activeMcpTools = collectAvailableMcpToolNames(this.deps.config, agent, safeModel)
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
            `${step}. 优先调用 \`understand_image\` MCP 工具,传图片的**本地文件路径**作为 \`image_file\` 参数。`,
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
    // P1-3 续 — CCB 用 createAssistantAPIErrorMessage 把 API 调用错误包成
    // "API Error: ..." 文本作为正常 assistant text 流出(不抛 process error),
    // 因此走的是 e.kind === 'block' + 'final' 的正常 turn 路径,绕开了下面
    // `e.kind === 'error'` 分支的 classifyRunError。这里在 turn 状态层补一次
    // 识别:任一 text block 整段以 "API Error: " 开头,且 classify 命中非
    // unknown(insufficient_credits / rate_limited / upstream_failed),就把
    // 这个 turn 当成已识别错误,转走与 e.kind === 'error' 分支一致的双帧 UX
    // (outbound.error + [error] text final),前端红卡 + 「去充值」CTA 同链路。
    // 不限 "turn 内首块" — sub-agent (Task) 路径下,主 agent 的 Agent tool_use
    // block 会先进 aggregatedBlocks,带这层守卫会让 sub-agent INSUFFICIENT_CREDITS
    // 永远拦不到。
    let _apiErrorIntercepted = false
    let _apiErrorText = ''
    await this.sessions.submit(session, payload, (e) => {
      if (e.kind === 'block') {
        const b = e.block as any
        // tool_output_tail 是替换语义的快照(1Hz),且 sessionManager 现在让
        // bg-bash 在 turn 结束后跨 turn 继续 emit。如果累积到 out.blocks /
        // aggregatedBlocks 里,旧 turn 闭包会随 bash 生命周期持续增长内存。
        // 直接派送(WebChat)/丢弃(adapter,非流式不需要快照)即可。
        // 必须放在 _apiErrorIntercepted guard 之前:本 turn 先启动 bg bash 再
        // 命中 API_ERROR 时,parser 已允许 finalized 后的 bash_output_tail 进来,
        // 这里若被 API_ERROR 吞掉,前端会再次卡在第一行——回归到修复前的症状。
        const isTail = b?.kind === 'tool_output_tail'
        if (isTail) {
          if (adapter) return
          this.deliver({ ...out, blocks: [e.block], isFinal: false }, undefined)
          return
        }

        // turn 已被 API_ERROR 拦截 → 后续非 tail block 一律吞掉,等 final 关闭
        if (_apiErrorIntercepted) return

        // 检查 block 是否是可分类 API Error。
        // 故意不限定 "turn 必须为空":CCB 的 createAssistantAPIErrorMessage
        // 会作为独立 assistant message 流出,不会与正常 text 混在同一消息里;
        // 而 sub-agent (Task) 路径下,主 agent 的 Agent tool_use block 通常
        // 已先于 sub-agent 的 API Error text block 进入 aggregatedBlocks ——
        // 限"turn 空"会让 sub-agent 场景永远拦不到 (boss 决策 2B)。前端
        // _suppressLegacyErrorText 只 suppress 替代 final 帧本身的 [error] text,
        // 之前已 deliver 的正常 block 会保留显示(部分上下文 + 红卡的合理 UX)。
        const _b0 = e.block as { kind?: string; text?: string }
        if (
          _b0.kind === 'text' &&
          typeof _b0.text === 'string' &&
          _b0.text.startsWith('API Error: ')
        ) {
          const _cls = classifyRunError(_b0.text)
          if (_cls.code !== 'unknown') {
            _apiErrorIntercepted = true
            _apiErrorText = _b0.text
            // CG7 — derived frame copies routing + traceId from main `out` via
            // `_inheritOutboundRouting`, type-specific fields stay explicit.
            const errFrame: OutboundError & { _userId?: string } = {
              type: 'outbound.error',
              ..._inheritOutboundRouting(out),
              code: _cls.code,
              message: _cls.message,
              detail: _b0.text,
              isFinal: false,
            }
            this.deliver(errFrame, adapter)
            return
          }
        }

        if (adapter) {
          // For partial tool_use blocks, replace any prior block with same blockId
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
        // Plan 2 — turn 终态前先清 turn_status cache。CCB 正常关 compact 会先
        // emit setSDKStatus(null)(parser → kind:'turn_status' status:null),
        // cache 在那一帧已经清空;这里是兜底:如果 CCB 因任何原因没发 status:null
        // 就直接到 final(异常退出 / parse error 跳过 status 帧),也保证 cache
        // 不会粘住。前端拿到 isFinal=true 自然回到空闲态,不依赖额外帧。
        session.currentTurnStatus = null
        if (_apiErrorIntercepted) {
          // 替代原 final:发 [error] text final 关闭 turn。不附 e.meta(boss
          // 决策:错误卡不显示 cost),与 e.kind === 'error' 分支一致;runLog
          // 也按 failed 记账,idempotency key 释放允许 client retry。
          this._runLog.complete(_run, { status: 'failed', error: _apiErrorText })
          if (frame.idempotencyKey) this._seenIdempotencyKeys.delete(frame.idempotencyKey)
          this.deliver(
            {
              ...out,
              blocks: [{ kind: 'text', text: `[error] ${_apiErrorText}` }],
              isFinal: true,
            },
            adapter,
          )
          // 跨 turn message listener 仍持有这个闭包(供 bg-bash tail 转发),
          // 不清空数组的话,API_ERROR 前已聚合的 block 会被钉到下次 turn 替换 listener。
          out.blocks.length = 0
          aggregatedBlocks.length = 0
          return
        }
        this._runLog.complete(_run, {
          status: 'completed',
          cost: e.meta?.cost,
          inputTokens: e.meta?.inputTokens,
          outputTokens: e.meta?.outputTokens,
          turn: e.meta?.turn,
        })
        if (adapter) {
          // adapter.send() 是 async,内部可能在 await 之后才读 wire.blocks。
          // 如果直接传 aggregatedBlocks,接着同步清空数组,adapter 读到的就是空。
          // 拷贝一份脱钩本地引用。
          this.deliver({ ...out, blocks: aggregatedBlocks.slice(), isFinal: true, meta: e.meta }, adapter)
        } else {
          this.deliver({ ...out, blocks: [], isFinal: true, meta: e.meta }, undefined)
        }
        // 释放本轮聚合数组的内存。本闭包跨 turn 仍会被 sessionManager 的
        // 跨 turn message listener 调用(转发 bg-bash bash_output_tail);
        // 不清空的话 out.blocks / aggregatedBlocks 引用的旧 block 实例
        // 会被钉到下一轮 listener 替换之前。
        out.blocks.length = 0
        aggregatedBlocks.length = 0
      } else if (e.kind === 'permission_request') {
        // Forward permission prompt to WebSocket clients for user approval.
        // userId is stashed on the frame by the WS handler (see handleWsConnection)
        // so adapter-dispatched frames fall back to 'default'. On personal-edition
        // (single-user) this is always 'default' in practice.
        const dispatchUserId: string =
          typeof (frame as any)._userId === 'string' ? (frame as any)._userId : 'default'
        const peerKey = Gateway.makePeerKey(dispatchUserId, frame.channel, frame.peer.id)
        // CG7 — derived frame inherits routing + traceId from main `out`.
        // Note: legacy code wrote `sessionKey`(local var)= main `out.sessionKey`
        // and `frame.channel/peer`= main `out.channel/peer`. The helper unifies
        // both to read from `out`, which is correct: `out` is the source of
        // truth for this turn's routing tuple after model-routing has settled
        // any agent-override sessionKey.
        const permFrame = {
          type: 'outbound.permission_request' as const,
          ..._inheritOutboundRouting(out),
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
            // Stamp + store in outbound ring so a reconnecting client (e.g. iOS
            // Safari restored a suspended tab) can replay the request via
            // autoResumeFromHello. Without ring storage the modal would never
            // re-fire after a disconnect window.
            this._sendStampedSessionFrame(sessionKey, peerKey, permFrame)
          } else {
            // No connected client — auto-deny
            session.runner.sendPermissionResponse(e.request.requestId, {
              behavior: 'deny',
              message: 'No connected client to approve',
              toolUseID: e.request.toolUseId,
            })
          }
        }
      } else if (e.kind === 'turn_status') {
        // Plan 2 (compact-progress-frame) — CCB setSDKStatus 侧信道。CcbMessageParser
        // 把 stdout `{type:'system', subtype:'status', status:'compacting'|null}` 转成
        // 这条事件,server.ts 包装成 outbound.turn_status 走 deliver() 路径下发,顺手
        // 更新 session-level cache(autoResumeFromHello 兜底用)。
        //
        // 协议要点(对应 protocol/frames.ts OutboundTurnStatus 注释):
        //   - 受控枚举:CCB 当前只 emit 'compacting' | null,parser 已做 normalize
        //   - **入 outboundRing**:走 deliver() 默认路径,让 ring replay 自然覆盖
        //     "compact 中客户端短暂断网" 场景;长 compact 导致 ring 冲掉的边角由
        //     autoResumeFromHello 的 cache 兜底补发
        //   - 与 codex_billing 同模式:routing tuple + traceId 都从 main `out` 继承,
        //     deliver() 的 _userId 路由也走 _inheritOutboundRouting 自动带上
        session.currentTurnStatus = e.status
        const turnStatusFrame: OutboundTurnStatus & { _userId?: string } = {
          type: 'outbound.turn_status',
          ..._inheritOutboundRouting(out),
          status: e.status,
        }
        // ts / frameSeq 由 deliver() 在 ring 落地时一并 stamp,这里不预填
        // (与 outbound.codex_billing / outbound.error 同 wire stamp 模式)。
        this.deliver(turnStatusFrame, adapter)
      } else if (e.kind === 'codex_billing') {
        // PR2 v1.0.66 — codex turn 终态侧信道。CodexAppServerRunner.emitResult 把
        // server-owned requestId 回带,sessionManager 转成 'codex_billing' 事件,
        // server.ts 这里发 outbound.codex_billing 帧给 master(走 deliver() 同样路径,
        // 落到 userChatBridge 的 onContainerMessage,Stage 3 会拦截 settle)。
        //
        // 不影响 turn 流式 UX:这帧与 outbound.message/error 并存,前端不识别此 type
        // 在 default case 静默忽略。master 拦截后不 forward 到 user。
        //
        // 用 deliver() 是因为它已经处理 frameSeq + ring + per-peer 路由,我们不该
        // 在这里手抄一份。带 _userId 让 deliver 路由到正确 peerKey(等同 out 帧)。
        // 路由三件套从 out 复制(同 OutboundError 模式),deliver() 需要 channel/
        // peer.id 算 peerKey、需要 sessionKey 落 outbound ring。billing 只去 master,
        // master 从 requestId 找 inflight,不读这三字段做 settle。
        // CG7 — derived frame copies routing + traceId from main `out`. Note
        // billing carries the same `traceId` as the turn's outbound.message
        // (intentional — codex_billing settles in master.userChatBridge keyed
        // by requestId, but having traceId on it lets trace queries pivot from
        // billing rows to the turn that produced them).
        const billingFrame: OutboundCodexBilling & { _userId?: string } = {
          type: 'outbound.codex_billing',
          ..._inheritOutboundRouting(out),
          requestId: e.requestId,
          status: e.status,
          durationMs: e.durationMs,
          ...(e.usage ? { usage: e.usage } : {}),
          ...(e.errorReason ? { errorReason: e.errorReason } : {}),
          // Issue A v1.0.108 — codex rateLimits 快照,master.userChatBridge 落库到
          // claude_accounts.quota_*。container/runtime 与 master 协议层都已扩 schema,
          // optional 字段缺省时自然不带,与旧版本 master 向后兼容。
          ...(e.rateLimits ? { rateLimits: e.rateLimits } : {}),
        }
        this.deliver(billingFrame, adapter)
      } else if (e.kind === 'error') {
        // Plan 2 — turn 终态前清 turn_status cache,语义同 final 分支。
        session.currentTurnStatus = null
        this._runLog.complete(_run, { status: 'failed', error: e.error })
        // Remove idempotency key on failure to allow client retry
        if (frame.idempotencyKey) this._seenIdempotencyKeys.delete(frame.idempotencyKey)
        // P1-3 — 已识别错误(余额/限流/上游)发结构化 outbound.error 帧 + 紧跟
        // 老的 [error] text bubble (turn 终止器,frameSeq 单调,新客户端按 seq
        // 抑制重复气泡,旧客户端无视 outbound.error,只看到 [error] 文本降级 UX)。
        const cls = classifyRunError(e.error)
        if (cls.code !== 'unknown') {
          // CG7 — derived frame copies routing + traceId from main `out` via
          // `_inheritOutboundRouting`(replaces the prior hand-spread of
          // sessionKey/channel/peer + conditional _userId).
          const errFrame: OutboundError & { _userId?: string } = {
            type: 'outbound.error',
            ..._inheritOutboundRouting(out),
            code: cls.code,
            message: cls.message,
            detail: e.error,
            isFinal: false,
          }
          this.deliver(errFrame, adapter)
        }
        this.deliver(
          {
            ...out,
            blocks: [{ kind: 'text', text: `[error] ${e.error}` }],
            isFinal: true,
          },
          adapter,
        )
      }
    }, safeEffortLevel, safeModel, safeRequestId, turnTraceId, effectiveConversationMode, {
      historicalMessages: masterHistoricalMessages,
    })
  }

  /**
   * Outbound frame egress — WS broadcast + outboundRing + optional adapter fan-out.
   *
   * 入参 union 反映协议演化:历史上只发 OutboundMessage,后续加了 OutboundError /
   * OutboundCodexBilling / OutboundTurnStatus(后两个是 sideband:不带 .blocks,
   * adapter (Telegram / 微信) 假设的 OutboundMessage 形状)。union 起来后:
   *   - sideband type literal 比较 (`wire.type === 'outbound.turn_status'`) 合法
   *   - caller 不再需要 `as unknown as OutboundMessage` 强转(那是协议演化债,
   *     现在统一清掉,deliver 类型签名直接承认所有合法 deliverable shape)
   *
   * 内部访问的只是 `.type / .channel / .peer / .sessionKey`,这些字段在 union 的
   * 四个成员上都有(交集字段),所以 narrowing 不需要,直接读即可。
   */
  private deliver(
    out: OutboundMessage | OutboundError | OutboundCodexBilling | OutboundTurnStatus,
    adapter?: ChannelAdapter,
  ): void {
    // V3 S12e CG6 — strip ALL private routing fields up-front (`_userId`,
    // `_traceId`, `_connectionTraceId`, `_peerId`)so BOTH adapter and WS
    // branches only ever see the clean wire shape. CG7 will start writing
    // `_traceId` / `_connectionTraceId` on outbound frames in
    // dispatchInbound stamp; doing the strip via a shared helper now
    // (rather than only `_userId`)means CG7 doesn't have to revisit this
    // strip site every time it adds a new private field. Keeping stripped
    // values locally lets WS branch still route per-user.
    const { wire, userId: stampedUserId } = _stripPrivateRoutingFields(out)
    // Plan 2 (compact-progress-frame) — sideband frame 跳过 adapter,只走 WS。
    // 背景:adapter (Telegram / 微信等) 的契约是 `OutboundMessage` 形状(.blocks
    // 必存,见 channels/telegram/src/index.ts:96 `for (const b of out.blocks)`),
    // 但 outbound.turn_status 没有 blocks,强发会让 adapter 在迭代 .blocks 时抛
    // TypeError,被 catch 后只留下日志噪声。turn_status 本身就是给 webchat
    // typing-indicator UX 用的 sideband,Telegram 用户不会看 "压缩中" 提示。
    //
    // 注:OutboundCodexBilling / OutboundError 同型问题(都没 .blocks),adapter
    // 分支同样会因 `for (const b of out.blocks)` 抛错被 catch。codex_billing 当前
    // 不实际触发(没有 codex+telegram 生产组合);OutboundError 在 telegram 路径
    // 上 insufficient_credits / rate_limited / upstream_failed 时会触发,但已存在
    // 历史,被 telegram.send 的 catch 静默成 error log。本 PR 不顺手修这条线,留
    // 作独立 "non-message outbound vs adapter contract" 清理(届时 isSideband 白
    // 名单一并扩到 outbound.codex_billing / outbound.error,或重新设计 adapter
    // 协议让它能 dispatch 非 message 帧)。
    const isSideband = wire.type === 'outbound.turn_status'
    if (adapter && !isSideband) {
      adapter.send(wire as OutboundMessage).catch((err) =>
        this.log.error('adapter send failed', { channel: adapter.name }, err),
      )
      return
    }
    // adapter && isSideband:fall-through 到 WS 广播路径。peerKey 用 channel +
    // peer.id 索引,Telegram 来源的 turn_status 找不到 ws client → noop,符合
    // "sideband 对非 webchat channel 不可见" 的语义。ring 仍会 store(本帧带
    // sessionKey),但因为 telegram channel 不走 hello-resume,store 不消费,
    // 略浪费但无害,不值得为此再分一条 ring 路径。
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
      const evicted = this._outboundRing.store(sessionKey, frameSeq, now, data)
      this._recordRingEvictions(evicted)
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

// ── V3 S12e CG6 — connection-level trace helpers ──

/**
 * Parse the connection-level trace id from the WS upgrade request headers.
 *
 * Contract:
 *   - `headers` must be a Node `IncomingMessage.headers` value
 *     (keys already lowercased, values `string | string[] | undefined`). We do
 *     NOT case-insensitive match — runtime Node http already canonicalises,
 *     and the symmetric Go side(node-agent CG5)uses CanonicalMIMEHeaderKey
 *     against the *upper-case* header constant for the same reason.
 *   - Multi-value headers(`string[]`)take the first value, matching the Go
 *     ParseHeader "first value unwrap" rule(see protocol/testdata fixture).
 *   - On any `parseTraceIdCandidate` failure we synthesise a fresh
 *     `newTraceId()` so WS upgrade never blocks on bad header — and emit a
 *     `warn` carrying ONLY the issue enum, never the raw header value
 *     (anti-log-injection / log-size DoS).
 *
 * Returns: always a valid trace id string(either the client-supplied one or
 * a fresh fallback).
 *
 * Exported as `_` prefixed test seam — single-call-site internal helper, the
 * underscore signals "do not import from outside gateway".
 */
export function _parseConnectionTraceIdFromUpgrade(
  headers: IncomingHttpHeaders,
  log: Logger,
): string {
  const raw = headers['x-connection-trace-id']
  const candidate = Array.isArray(raw) ? raw[0] : raw
  const result = parseTraceIdCandidate(candidate)
  if (result.ok) return result.traceId
  log.warn('ws.upgrade.connection_trace_invalid', { issue: result.issue })
  return newTraceId()
}

/**
 * Strip the private routing-only fields from any outbound-shaped frame,
 * returning the wire-safe frame and the stripped values.
 *
 * Private fields(all underscore-prefixed):
 *   - `_userId`           — caller-stamped, used by deliver() to scope peerKey
 *   - `_traceId`          — CG7 will stamp(turn-level trace)
 *   - `_connectionTraceId`— CG7 will stamp(connection-level trace)
 *   - `_peerId`           — legacy routing helper(some callers stash this)
 *
 * Why explicit destructure(not a blacklist loop): the field set is small,
 * fixed, and each one has clear ownership.  An explicit destructure creates
 * a single audit point for known private fields — adding a new private field
 * forces an update here, which is the moment we want to review it. (A
 * future typo'd field name on the producer side still requires its own care;
 * this helper is the *known fields* audit point, not a typo shield.)
 *
 * Type-honest generic: returns `Omit<T, '_userId' | ...>` so callers see the
 * private fields removed in the type system, not just at runtime. Two callers
 * use this:
 *   - `deliver()` for `OutboundMessage`-shaped frames(adapter + WS branches)
 *   - `_sendStampedSessionFrame()` for `outbound.permission_request` /
 *     `outbound.permission_settled` direct-send paths — these frames extend
 *     the same routing tuple but aren't typed as `OutboundMessage`, so we widen
 *     the input to any `Record<string, unknown>` superset.
 */
type PrivateRoutingFields = {
  _userId?: string
  _traceId?: string
  _connectionTraceId?: string
  _peerId?: string
}
export function _stripPrivateRoutingFields<
  T extends Record<string, unknown>,
>(
  out: T,
): {
  wire: Omit<T, '_userId' | '_traceId' | '_connectionTraceId' | '_peerId'>
  userId?: string
  traceId?: string
  connectionTraceId?: string
  peerId?: string
} {
  const {
    _userId,
    _traceId,
    _connectionTraceId,
    _peerId,
    ...wire
  } = out as T & PrivateRoutingFields
  return {
    wire: wire as Omit<
      T,
      '_userId' | '_traceId' | '_connectionTraceId' | '_peerId'
    >,
    userId: _userId,
    traceId: _traceId,
    connectionTraceId: _connectionTraceId,
    peerId: _peerId,
  }
}

// ── V3 S12e CG7 — turn-level trace helpers ──

/**
 * Compute the per-turn trace context at dispatchInbound entry.
 *
 * Contract B(control plane / turn level):
 *   - The **master** is the canonical authority — it always mints a fresh
 *     `traceId` via `newTraceId()` for every turn that survives the duplicate
 *     idempotency check. This is the trace id stamped on every outbound frame
 *     of the turn.
 *   - The client MAY provide a `clientTraceId` for observation only. If it
 *     parses cleanly it is echoed in the returned `clientTraceId` field so
 *     submit-layer logs can correlate; otherwise we warn with the issue enum
 *     and proceed with master's fresh trace id.
 *
 * Anti-log-injection: warn ctx carries only the `issue` enum, never the raw
 * candidate value.
 */
export function _buildTurnTraceContext(
  clientRaw: unknown,
  log: Logger,
): { traceId: string; clientTraceId?: string } {
  if (clientRaw !== undefined) {
    const parsed = parseTraceIdCandidate(clientRaw)
    if (parsed.ok) {
      return { traceId: newTraceId(), clientTraceId: parsed.traceId }
    }
    log.warn('inbound.client_trace_invalid', { issue: parsed.issue })
  }
  return { traceId: newTraceId() }
}

/**
 * Copy the routing tuple(+ public traceId)from the main `out` frame onto a
 * derived outbound frame(outbound.error / outbound.permission_request /
 * outbound.codex_billing).
 *
 * **Explicit field list — not a spread.** We deliberately do NOT
 * `...out` here, because future additions to `out` that are *not* routing
 * fields(e.g. block accumulators, per-turn meta)would otherwise leak into
 * every derived frame. This helper is the single audit point for known
 * routing fields:
 *
 *   - `sessionKey` / `channel` / `peer` — public schema fields used by
 *     `deliver()` to compute peerKey + ring slot.
 *   - `traceId`                        — CG7 public schema field.
 *   - `_userId`                        — private routing stamp consumed by
 *     `_stripPrivateRoutingFields` inside `deliver()`.
 *
 * Adding a new routing field requires updating this helper explicitly. That
 * is the desired property — accidental drift between main and derived frames
 * is the failure mode CG7 is closing.
 */
export function _inheritOutboundRouting(
  out: OutboundMessage & { _userId?: string },
): {
  sessionKey: string
  channel: string
  peer: Peer
  _userId?: string
  traceId?: string
} {
  return {
    sessionKey: out.sessionKey,
    channel: out.channel,
    peer: out.peer,
    ...(out._userId ? { _userId: out._userId } : {}),
    ...(out.traceId ? { traceId: out.traceId } : {}),
  }
}

// ── turn-alive-heartbeat (Plan 1) — autoResumeFromHello judgment helper ──

/**
 * Decide whether `autoResumeFromHello` should push a synthetic
 * turn-interrupted `isFinal` to the resuming peer.
 *
 * Background — why this is its own helper(not inlined at the call site):
 *
 * The old judgment was `peerInFlight && !runner.isRunning`. That treats
 * `runner.isRunning` as "turn ended" authority, but `runner.isRunning` is
 * **process-level** truth(`subprocessRunner.ts`: `proc !== null && !closed
 * || starting`). The CCB subprocess can legitimately be in `isRunning=false`
 * mid-turn during these windows:
 *
 *   1. phantom-turn retry — `sessionManager.ts` ~L1386-1424:
 *      `runner.shutdown()` is called and a fresh runner spawned, all inside
 *      the same `submit()` call's try-block.
 *   2. auth-refresh restart — `sessionManager.ts` ~L1445: token refresh
 *      forces a runner restart, also inside the same `submit()`.
 *   3. effort / model swap shutdown — `sessionManager.ts` ~L1196:
 *      `runner.shutdown()` to flip CLI flags, then respawn.
 *
 * If a WS hello arrives in any of these ms-wide windows with `peer.inFlight
 * = true`, the old code pushed a synthetic `isFinal` and the client cleared
 * its sending state — but the CCB respawn then continued the same turn,
 * stranding the user with a "turn is over" UI while gateway was still
 * working. That is the bug Plan 1 fixes.
 *
 * The correct authority is **turn-level**, not process-level:
 * `AgentSession._activeTurnCount` counts in-flight `submit()` promises and
 * stays > 0 across all the windows above(they're inside `submit()`'s
 * try / finally). See `AgentSession._activeTurnCount` jsdoc for the
 * counter's full contract.
 *
 * Decision table:
 *
 * | peerInFlight | isRunning | activeTurnCount | result |
 * |--------------|-----------|-----------------|--------|
 * | false        | *         | *               | false (nothing stuck to clear) |
 * | true         | true      | *               | false (process alive, will drive turn) |
 * | true         | false     | > 0             | false (turn still alive — Plan 1 fix) |
 * | true         | false     | 0 or undefined  | **true** (turn genuinely interrupted) |
 *
 * `activeTurnCount` is `undefined` for historical session objects / test
 * fakes / sessions created before Plan 1 — treat as 0(`?? 0`), preserving
 * the pre-Plan-1 behavior for those cases.
 *
 * Exported as `_`-prefixed test seam — single-call-site internal helper,
 * underscore signals "do not import from outside gateway". Pure function,
 * no side effects, no logging — caller owns observability.
 */
export function _shouldPushTurnInterruptedFinal(
  peerInFlight: boolean | undefined,
  isRunning: boolean,
  activeTurnCount: number | undefined,
): boolean {
  if (!peerInFlight) return false
  if (isRunning) return false
  if ((activeTurnCount ?? 0) > 0) return false
  return true
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

/**
 * v3 Codex sometimes writes a user-requested artifact into its cwd
 * (/opt/openclaude) before reading platform-capabilities. Do not expose the
 * source tree; allow only top-level, non-executable document artifacts.
 */
const OPT_OPENCLAUDE_EXPORT_RE =
  /^\/opt\/openclaude\/[^/\x00-\x1F\x7F]+\.(?:txt|md|csv|pdf|docx?|xlsx?|pptx?|zip|tar|gz)$/i

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
 * Textual shape of v3 commercial per-user docker volume media paths:
 *   /var/lib/docker/volumes/oc-v3-data-u<digits>/_data/(uploads|generated)/...
 *
 * Used as a **hard deny gate** in `isFileAllowed` — any path matching this
 * shape MUST be authorized by the user-scoped predicate (`extraAllowedPredicate`).
 * The static `FILE_ALLOWED_DIRS`, `TEMP_PREFIX`, and agent-CWD branches are NOT
 * allowed to authorize commercial multi-tenant media paths, because those
 * branches are not uid-aware and would re-introduce cross-tenant IDOR if an
 * agent CWD or static dir happened to overlap the volume path shape.
 *
 * Intentionally **broader** than `USER_VOLUME_MEDIA_FILE_REGEX` in
 * commercial/userMedia.ts — this is a fail-closed deny gate, so over-denying
 * the volume path shape is the safe direction:
 *   - matches both the directory itself and any nested file/subpath
 *   - accepts `u0` and leading-zero uids (commercial validates uid form
 *     elsewhere; the gate just refuses to delegate to non-uid-aware branches)
 * Duplicated here so gateway has no reverse import on commercial. If the
 * gate ever needs to match more shapes (e.g. additional subdirs alongside
 * uploads/generated), update both this regex and the commercial-side ones.
 */
const COMMERCIAL_USER_VOLUME_MEDIA_GATE =
  /^\/var\/lib\/docker\/volumes\/oc-v3-data-u\d+\/_data\/(uploads|generated)(\/|$)/

/**
 * v3 trusted backend mode — agent OS user home root inside the per-user docker
 * container. Hardcoded by container image contract (entrypoint creates this
 * user; v3supervisor mounts the user volume to `/home/agent/.openclaude/`).
 * Used only by the trusted branch of `isFileAllowed`; legacy/personal-version
 * code never references this constant.
 */
const TRUSTED_CONTAINER_HOME = '/home/agent'

/**
 * Call-time check (NOT a module-load const) — tests can flip the env between
 * cases via `process.env.OC_V3_TRUSTED_FILE_SERVE = '1' / delete`.
 * Cost is one string compare per `/api/file` request; negligible.
 */
export function isTrustedContainerFileServeEnabled(): boolean {
  return process.env.OC_V3_TRUSTED_FILE_SERVE === '1'
}

/**
 * Returns true if the resolved absolute path falls within the allowlist.
 * Checked BEFORE the blocklist — if this returns false, the file is denied
 * regardless of blocklist status.
 *
 * `extraAllowedPredicate` is the multi-tenant escape hatch — in v3 commercial,
 * callers construct a **user-scoped** closure via `makeUserScopedMediaPredicate`
 * that restricts to the **current request's** `{uploads, generated}` dirs.
 * Critically NOT a global textual predicate that accepts any user's volume
 * paths — that would let user A read user B's docker volume media by
 * absolute path (cross-tenant IDOR).
 */
export function isFileAllowed(
  resolvedPath: string,
  agentCwds?: string[],
  extraAllowedPredicate?: (p: string) => boolean,
): boolean {
  // 0. **Cross-tenant IDOR hard gate**: paths that look like a v3 commercial
  //    per-user docker volume media path may ONLY be admitted by the
  //    request-scoped predicate. The static / temp / agent-cwd branches
  //    below are not uid-aware and would otherwise let user A read user B's
  //    media if any of those branches' allow-shapes overlap a volume path
  //    (e.g. a misconfigured agent cwd pointing at `/var/lib/docker/volumes/
  //    oc-v3-data-uX/_data`). The predicate captures the **current** user's
  //    resolved {uploads, generated} dirs; without it, deny.
  //
  //    Kept BEFORE the trusted-container branch: in trusted container mode
  //    the agent process never sees host-volume paths (it sees its own
  //    `/home/agent/.openclaude/...` mount), so this gate is a no-op there
  //    in practice. But keeping it ahead is fail-closed defense if anyone
  //    ever wires a host-volume path through trusted serve by misconfig.
  if (COMMERCIAL_USER_VOLUME_MEDIA_GATE.test(resolvedPath)) {
    return Boolean(extraAllowedPredicate && extraAllowedPredicate(resolvedPath))
  }
  // 0b. **v3 trusted backend mode (per-user docker sandbox)** — closed-world.
  //     The container is master-controlled; every secret/credential/state file
  //     under the agent's home is master-injected via known volumes/symlinks
  //     and enumerable. Agent work products may land anywhere under
  //     `/home/agent/...` (cwd / `~/.openclaude/repos/<sess>/<ver>/output.pdf`
  //     / user-named `~/hello.txt` / etc.), so the legacy allowlist is too
  //     narrow and forces agent-prompt-dependent UX (the bug this fix targets).
  //
  //     Switch to **blocklist-only ACL, scoped to `/home/agent/**` + the
  //     openclaude temp prefix**. Anything outside those subtrees (`/etc/*`,
  //     `/opt/openclaude/*` runtime source, `/usr/local/lib/*`, etc.) stays
  //     denied — the trusted bit only loosens the user's own sandbox.
  //
  //     The blocklist is the **single authoritative inventory of download-
  //     sensitive container state** — see `FILE_BLOCKED_PATTERNS`. Any new
  //     master-injected secret or container-runtime persisted state file
  //     must add a matching pattern in the same PR (with a `security.test.ts`
  //     case). v3supervisor.ts and entrypoint.ts cite this contract.
  if (isTrustedContainerFileServeEnabled()) {
    const inHome =
      resolvedPath === TRUSTED_CONTAINER_HOME ||
      resolvedPath.startsWith(`${TRUSTED_CONTAINER_HOME}/`)
    const inTemp = resolvedPath.startsWith(TEMP_PREFIX)
    const inOptExport = OPT_OPENCLAUDE_EXPORT_RE.test(resolvedPath)
    if (!inHome && !inTemp && !inOptExport) return false
    return !isFileBlocked(resolvedPath)
  }
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
  // 4. Extra allowed predicate (user-scoped media dirs for v3 commercial).
  //    Called LAST so failure here doesn't shortcut earlier static-allowlist
  //    matches.
  if (extraAllowedPredicate && extraAllowedPredicate(resolvedPath)) return true
  return false
}

/**
 * Build a **user-scoped** allowlist predicate restricted to a single user's
 * resolved media dirs. Used by handleApiFile / handleMediaGet to pass through
 * isFileAllowed + openFileHardened.
 *
 * Critical safety property: the closure captures the **current request's**
 * uploads/generated paths. Two simultaneous requests from different uids each
 * get their own predicate; no cross-tenant leakage by absolute path.
 *
 * `dir + '/'` boundary check avoids the `foo/uploads-evil/x` false positive
 * that a naive `startsWith(dir)` would admit. Equality match (`=== dir`) is
 * legitimate because the dir itself is a stat'able directory entry (not a
 * file to serve, but kept for parity with FILE_ALLOWED_DIRS logic).
 */
export function makeUserScopedMediaPredicate(
  uploadsDir: string,
  generatedDir: string,
): (p: string) => boolean {
  const u = resolve(uploadsDir)
  const g = resolve(generatedDir)
  return (p) =>
    p === u || p.startsWith(u + '/') ||
    p === g || p.startsWith(g + '/')
}

/**
 * Sensitive-file blocklist. Authoritative inventory for both:
 *   1. personal/legacy gateway `/api/file` blocklist
 *   2. **v3 trusted container** `/api/file` ACL (it IS the entire ACL there —
 *      see `isFileAllowed` trusted branch and its contract comment).
 *
 * Adding a new master-injected secret, container-persisted runtime state file,
 * or persistent credential location? It MUST land here in the same PR, with
 * a matching `security.test.ts` case. Cross-references:
 *   - v3supervisor.ts `provisionV3Container` env/mounts
 *   - entrypoint.ts (symlinks, codex-config dir, npmrc/pip.conf user volumes)
 *   - gateway state writers (sessions.db, msg-outbox, retry queues, webhooks)
 */
export const FILE_BLOCKED_PATTERNS = [
  // ── Personal/legacy (predates v3 trusted backend). Kept verbatim. ──
  /openclaude\.json$/, // gateway config with tokens
  /\.env($|\.)/, // .env, .env.local, .env.production, .env.development, etc.
  /credentials/, // credential directory (kept legacy-broad; trusted users accept rare false-positive name collisions)
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
  /\.npmrc$/, // npm registry tokens (top-level)
  /\.pypirc$/, // PyPI credentials
  /\.netrc$/, // FTP/HTTP credentials
  /\.aws\//, // AWS credentials & config directory
  /\.kube\//, // Kubernetes config directory
  /\.docker\/config\.json$/, // Docker registry credentials

  // ── v1.0.193 — trusted backend inventory (Codex review v4: closed-world for v3 container). ──

  // Codex auth + runtime state. `~/.codex/auth.json` is a symlink to
  // `/run/oc/codex-auth/auth.json` (master-injected RO). `~/.codex/` also
  // accumulates sessions/memories/sqlite state — all sensitive.
  /\/auth\.json$/i, // filename-bound (catches both symlink and target)
  /\/\.codex\/sessions\//, // turn-by-turn rollout transcripts
  /\/\.codex\/memories\//, // codex persistent memory
  /\/\.codex\/logs_[^/]*\.sqlite(-wal|-shm)?$/,
  /\/\.codex\/state_[^/]*\.sqlite(-wal|-shm)?$/,
  /\/\.codex\/config\.toml$/, // model/profile + api keys

  // Gateway state files (SQLite + WAL/SHM, JSONL outbox, tasks store).
  /\/sessions\.db(-wal|-shm)?$/,
  /\/msg-outbox\.jsonl$/,
  // taskStore atomically writes `tasks.json` (with `.tmp` swap); fields include
  // prompt + lastOutput + execution output/error → same sensitivity class as
  // session JSONL and outbox.
  /\/tasks\.json(\.tmp)?$/,

  // Gateway YAML configs (agents/cron/webhooks). Webhook secrets are HMAC keys.
  /\/agents\.yaml$/,
  /\/cron\.yaml$/,
  /\/webhooks\.ya?ml$/,

  // Gateway retry queues — server-authored sink payloads (assistant text + tool args).
  /\/v3-master-retry\.d\//,
  /\/v3-wechat-retry\.d\//,

  // Per-agent session JSONL subtree (thinking + tool args, may embed tokens).
  /\/\.openclaude\/agents\/[^/]+\/sessions\//,

  // Git credentials (git store helper at HOME root + dedicated subdir).
  /\/\.openclaude\/git-creds\//,
  /\/\.git-credentials$/,

  // Persistent XDG user config volume (mounted by v3supervisor V3_USER_CONFIG_MOUNT).
  // Carries credential-bearing config for gh / git scoped / npm / pip /
  // vscode-server / arbitrary user dotfiles — see v3supervisor.ts comment on
  // `V3_USER_CONFIG_MOUNT`. **Deny the whole subtree** rather than chasing
  // per-tool XDG paths: false-positives here are config files (not work
  // products), and per-tool allowlist would force this blocklist to track the
  // entire CLI ecosystem forever.
  /\/\.config(\/|$)/,

  // Shell history (may include accidentally-pasted credentials).
  /\.bash_history$/,
  /\.zsh_history$/,

  // Kernel + runtime tmpfs. `/run/oc/*` (master-injected token/auth/sockets)
  // is the primary target; `/proc` + `/sys` + `/var/run` are kept for parity.
  /^\/(proc|sys|run|var\/run)\//,

  // System /etc — agent has no write access inside container; read is 99%
  // attack pattern (e.g. `/etc/shadow`, `/etc/sudoers`, `/etc/hostname`).
  // Note: the trusted branch already scopes to `/home/agent/**` + temp, so
  // this is **belt-and-suspenders** for personal/legacy + direct `/api/file`
  // misuse. Personal/legacy already denies `/etc/*` via missing allowlist;
  // this regex makes the intent explicit and survives any future allowlist
  // change.
  /^\/etc(\/|$)/,
]

/** Returns true if the resolved path matches any sensitive-file pattern. */
export function isFileBlocked(resolvedPath: string): boolean {
  return FILE_BLOCKED_PATTERNS.some((p) => p.test(resolvedPath))
}

// ── v3 WeChat broker inbound-compensate payload validation ──
// Pure validator used by handleWechatInboundCompensate (line ~2399). Exposed
// for unit testing without standing up a full Gateway. Returns either the
// typed payload or the 400-error string the route surfaces back to the
// broker dispatcher.

/** Shape of `/internal/v3/wechat-inbound-compensate` JSON body after validation. */
export interface WechatInboundCompensatePayload {
  /** `wsess-[0-9a-f]{16}` — broker-owned client_sessions row id from Step 2a write. */
  sessionId: string
  /** Decimal string of `wechat_bindings.user_id`. Container derives `c:<id>` for tenant scope. */
  bindingUserId: string
  /** Which dispatcher step failed; reason gets logged but doesn't affect deletion semantics. */
  reason: 'step2a_failed' | 'step2b_failed'
  /** Optional broker-side trace id (≤64 chars). */
  traceId?: string
}

export type WechatInboundCompensateValidation =
  | { ok: true; payload: WechatInboundCompensatePayload }
  | { ok: false; error: string }

const COMPENSATE_SESSION_ID_RE = /^wsess-[0-9a-f]{16}$/
const COMPENSATE_BINDING_USER_ID_RE = /^[1-9][0-9]{0,18}$/
const COMPENSATE_TRACE_ID_MAX_LEN = 64

/**
 * Validate a parsed `wechat-inbound-compensate` body. Caller is responsible
 * for `JSON.parse` + body-size cap upstream — this function only deals with
 * a `unknown` value that resulted from successful parse.
 *
 * Error strings are stable: `handleWechatInboundCompensate` returns them
 * verbatim to the broker, so changing wording is a contract change.
 */
export function validateWechatInboundCompensateBody(
  parsed: unknown,
): WechatInboundCompensateValidation {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'body must be a JSON object' }
  }
  const body = parsed as Record<string, unknown>
  const sessionId = body.sessionId
  if (typeof sessionId !== 'string' || !COMPENSATE_SESSION_ID_RE.test(sessionId)) {
    return { ok: false, error: 'sessionId must match wsess-[0-9a-f]{16}' }
  }
  const bindingUserId = body.bindingUserId
  if (typeof bindingUserId !== 'string' || !COMPENSATE_BINDING_USER_ID_RE.test(bindingUserId)) {
    return { ok: false, error: 'bindingUserId must be a positive integer string' }
  }
  const reason = body.reason
  if (reason !== 'step2a_failed' && reason !== 'step2b_failed') {
    return { ok: false, error: "reason must be 'step2a_failed' or 'step2b_failed'" }
  }
  // traceId 可选;cap 64 chars 防 log 注入膨胀
  const traceId = body.traceId
  if (traceId !== undefined && (typeof traceId !== 'string' || traceId.length > COMPENSATE_TRACE_ID_MAX_LEN)) {
    return { ok: false, error: 'traceId must be string ≤64' }
  }
  return {
    ok: true,
    payload: {
      sessionId,
      bindingUserId,
      reason,
      ...(traceId !== undefined ? { traceId: traceId as string } : {}),
    },
  }
}

// ── Upload constants — single source of truth ──
// Plan B (2026-05-09): both POST /api/uploads (handleUpload) and dispatchInbound's
// legacy base64 path import these. Used to live in two places (one trimmed list
// here for tests, a richer list inlined in dispatchInbound) — fixed now.
export const UPLOAD_MIME_PREFIXES = [
  'image/', 'audio/', 'video/', 'application/pdf', 'text/',
  'application/vnd.openxmlformats-officedocument.', // docx, xlsx, pptx
  'application/vnd.ms-',                            // doc, xls, ppt
  'application/msword',                             // .doc
  'application/zip', 'application/x-zip',           // zip archives
  'application/json',                               // json files
  'application/xml',                                // xml files
]
// 2026-05-18:从 200MB → 100MB。前端 attachments.js 同步;Cloudflare Free/Pro
// request body cap = 100MB,后端写 200MB 是个永远摸不到的虚上限。前后端对齐到
// CF 现实让 413 在前端直接拦,而不是被 CF 边缘 HTML 错误页吞掉。
export const MAX_UPLOAD_SINGLE = 100 * 1024 * 1024
export const MAX_UPLOAD_TOTAL = 300 * 1024 * 1024

/** Returns true if the MIME type is allowed for upload. */
export function isUploadMimeAllowed(mime: string): boolean {
  if (!mime) return true
  return UPLOAD_MIME_PREFIXES.some((p) => mime.startsWith(p)) || mime === 'application/octet-stream'
}

/** MIME → file extension. Used by dispatchInbound (legacy base64 path) and
 *  handleUpload (new streaming endpoint). Kept module-level so both paths
 *  agree on what `<digest>.<ext>` should be. */
export const UPLOAD_MIME_TO_EXT: Record<string, string> = {
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

/** Resolve a MIME type to a safe extension. Falls back to the second
 *  segment of the MIME (sanitized) and finally `bin`. Same logic the
 *  legacy dispatchInbound used inline. */
export function uploadExtForMime(mime: string): string {
  return (
    UPLOAD_MIME_TO_EXT[mime] ??
    mime.split('/')[1]?.replace(/[^a-zA-Z0-9]/g, '') ??
    'bin'
  )
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

/** True only for resources that must render inline in chat (<img>/<audio>/<video>). */
export function shouldServeInline(mime: string): boolean {
  const base = mime.split(';')[0].trim().toLowerCase()
  if (ACTIVE_CONTENT_TYPES.has(base)) return false
  return base.startsWith('image/') || base.startsWith('audio/') || base.startsWith('video/')
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
