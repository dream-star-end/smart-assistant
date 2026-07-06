import { createHash, randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import {
  constants as fsConstants,
  chmodSync,
  chownSync,
  closeSync,
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
  type AgentGroupStatus,
  type ReviewVerdict,
  REVIEW_VERDICT_PASS,
  REVIEW_VERDICT_NEEDS_FIX,
  newTraceId,
  parseTraceIdCandidate,
  STATIC_KEY_INBOUND_MODEL_IDS,
} from '@openclaude/protocol'
import { classifyDelegateOutputError, classifyRunError } from './errorClassify.js'
import {
  parseSkillEvalsJson,
  serializeSkillEvals,
  type SkillEvalsFile,
  type AgentDef,
  type AgentsConfig,
  MemoryStore,
  type OpenClaudeConfig,
  SkillStore,
  SkillDraftStore,
  TaskStore,
  buildAgentSkillStore,
  buildUserSkillStore,
  validateSkillAgentScope,
  paths,
  readAgentsConfig,
  readConfig,
  searchSessions,
  syncMarketplaceHub,
  writeAgentsConfig,
  writeConfig,
  getUsageSummary,
  queryEvents,
  listClientSessions,
  getClientSession,
  getClientSessionPartial,
  upsertClientSession,
  appendServerAuthoredMessage,
  deleteClientSession,
  renameClientSession,
  listUnclaimedSessions,
  claimSession,
  probeSessionsDb,
} from '@openclaude/storage'
import {
  filterUserVisibleAgentsForManagement,
  filterUserVisibleByAgentField,
  filterUserVisibleRoutesForManagement,
  isHiddenSystemAgentId,
  userVisibleDefaultAgentId,
} from './agentVisibility.js'
import { listCollaboratorAgents } from './collaboratorAgents.js'
import type { SessionStreamEvent } from './ccbMessageParser.js'
import { type SkillTrainRun, SkillTrainJobStore } from './skillTrainJobs.js'
import {
  type SkillEvalRun,
  SkillEvalJobStore,
  armsForMode,
} from './skillEvalJobs.js'
import {
  type GraderArmInput,
  type SkillEvalCaseResult,
  addUsage,
  buildEvalCasePrompt,
  buildGraderPrompt,
  computeBenchmark,
  emptyUsage,
  gradesToAssertions,
  parseGraderJson,
} from './skillEval.js'
import {
  SKILL_TRAIN_DEFAULT_MODEL,
  SKILL_TRAIN_EFFORT,
  buildSkillTrainPrompt,
  normalizeSkillTrainArgs,
} from './skillTrain.js'
import { type WebSocket, WebSocketServer } from 'ws'
import { checkToken, verifyPassword, signJwt, verifyJwt, type JwtPayload } from './auth.js'
import { CronScheduler, isUserInitiatedCronJob } from './cron.js'
import { sendV3WechatProactive, readV3WechatProactiveConfig } from './v3WechatProactive.js'
import { parseDocument } from './documentParser.js'
import {
  makeDelegateProgressBlock,
  makeDelegateBlockPassthrough,
  resolveDelegateProgressRouting,
  toNestedDelegateProgressLine,
  type DelegateProgressBlock,
  type DelegateProgressRouting,
} from './delegateProgress.js'
import {
  getDelegateTimeoutReason,
  resolveDelegateTimeoutConfig,
} from './delegateTimeout.js'
import { eventBus, createEvent } from './eventBus.js'
import { startEventPersistence } from './eventPersist.js'
import { serveFileFdWithRange } from './httpRange.js'
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
import { matchBridgeApiAllowlist } from './bridgeApiAllowlist.js'
import { handleOpenAIRequest } from './openaiCompat.js'
import { DEFAULT_RING_CONFIG, OutboundRingBuffer, type EvictionStats } from './outboundRing.js'
import { Router } from './router.js'
import { RunLog } from './runLog.js'
import {
  SessionRepoWorkspaceManager,
  type SessionRepoBindFrame,
  type SessionRepoStatusOut,
} from './sessionRepoWorkspace.js'
import { SessionManager, parseVerificationVerdict } from './sessionManager.js'
import { WebhookRouter } from './webhooks.js'
import { inferAgentForModel } from './inferAgentForModel.js'
import {
  capMarketplaceToolsets,
  mergeOnDemandToolsets,
  resolveDelegateToolsets,
} from './toolsetIntent.js'
import { resolveOpenClaudeVisionEntry } from './subprocessRunner.js'
import {
  handleV3CodexRelayLocal,
  readV3CodexRelayConfig,
  V3_CODEX_RELAY_PREFIX,
} from './v3CodexRelay.js'
import {
  handleV3MarketplaceRelayLocal,
  readV3MarketplaceRelayConfig,
  V3_MARKETPLACE_LOCAL_RELAY_PREFIX,
} from './v3MarketplaceRelay.js'
import { startToolFailureReporter } from './v3ToolFailureReporter.js'
import { resolveEngine } from './engine/registry.js'
import type { CodexProviderConfigOverride } from './engine/codexShared.js'
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

const V3_WECHAT_OUTBOUND_ADAPTER_ID = 'v3-wechat-outbound'
const WECHAT_FINAL_EMPTY_TEXT =
  '✅ 任务已完成，但这轮没有生成可直接发送到微信的文本结果。请打开实时过程链接查看详细过程。'

function teamMemberCapabilityHint(agent: AgentDef): string {
  let hint = ''
  try {
    const personaPath = agent.persona || paths.agentClaudeMd(agent.id)
    if (existsSync(personaPath)) {
      hint = readFileSync(personaPath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith('#')) ?? ''
    }
  } catch {}
  if (!hint && typeof agent.greeting === 'string') hint = agent.greeting
  hint = hint.replace(/\s+/g, ' ').trim()
  return hint ? ` — 能力: ${hint.slice(0, 100)}` : ''
}

/**
 * 协议级允许的 InboundMessage.model 值(2026-04-26 v1.0.4 加)。
 *
 * 不查 deps.pricing(GatewayDeps 没 pricing;商用版 admin 启用列表是 host 概念,
 * 容器 gateway 拿不到)。新增模型时这里同步更新。安全意义:防止用户 prefs 残留
 * 已下线模型 / 恶意 frame 注入字符串让 CCB --model 拿到非法值导致 spawn 失败 →
 * session 卡死。运行时校验在 server.ts:WS handler 里;export 出来便于 unit test
 * 与未来抽 helper。
 *
 * 当前 commercial 暴露集合:
 *   - gpt-5.5 — codex agent 走 codex JSON-RPC(v5 从 picker dropGptForV5Channel,但入站仍受)
 *   - deepseek-v4-flash / deepseek-v4-pro — anthropicProxy 在 master 侧 isDeepseekModel
 *     命中后切换上游(DEEPSEEK_UPSTREAM_ENDPOINT + DEEPSEEK_API_KEY),
 *     在 claude-subscription agent 上跑就够,不需要切 agent
 *   - MiniMax-M3 — master 侧切到 MiniMax Token Plan Anthropic 兼容端点,
 *     同样跑 claude-subscription/non-codex agent,不进 codex-native
 *   - glm-5.1 / glm-5.2 — master 侧切到火山方舟 Ark Coding Plan Anthropic 兼容端点,
 *     同 non-codex,glm-5.2 是**平台全局默认模型**
 *
 * **Claude 官方模型(claude-opus-4-7 / claude-sonnet-4-6 / claude-haiku-4-5)已全面下线**
 * (v3 + v5 均不支持),不在白名单;stale prefs / 构造帧带 Claude 模型会被拒,而不是路由到
 * 已下线的 Anthropic 上游。
 *
 * 静态 key 文本 provider 的字面量(deepseek-v4-flash/pro, MiniMax-M3, glm-5.1/5.2)从
 * @openclaude/protocol 注册表 STATIC_KEY_INBOUND_MODEL_IDS 注入,新增 provider 零改本处。
 */
export const ALLOWED_INBOUND_MODELS = new Set<string>([
  'gpt-5.5',
  ...STATIC_KEY_INBOUND_MODEL_IDS,
])

/** 平台执行模型兜底:v3/v5 两渠道都合法的静态 key 平台默认。 */
export const EXECUTION_MODEL_FALLBACK = 'glm-5.2'

/**
 * 把 agent/config 级模型收敛到平台真实支持的集合。
 *
 * ALLOWED_INBOUND_MODELS 只拦**入站帧**;但 agent.model(marketplace manifest / seed /
 * delegate 委派)会**绕过入站校验**,在 SessionManager.getOrCreate 里直接作为 CCB `--model`
 * spawn。已下线模型(如某个 stale 已安装 agent 里残留的 claude-*)会让 CCB 用不可路由的
 * --model 启动 → spawn 失败 / session 卡死。runner 创建是唯一收口点,这里把任何不在白名单的
 * 模型降级到平台默认(glm-5.2),使"Claude 官方模型下线"在 agent 级路径上也真正生效。
 */
export function resolveExecutionModel(
  preferred: string | undefined | null,
  fallback: string | undefined | null,
): string {
  for (const m of [preferred, fallback]) {
    if (typeof m === 'string' && ALLOWED_INBOUND_MODELS.has(m)) return m
  }
  return EXECUTION_MODEL_FALLBACK
}

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
    // bypassToolset=true:vision 是内置平台工具,豁免 toolset 过滤(与 subprocessRunner 注入侧一致;
    // gating 已由 shouldEnableOpenClaudeVision 控制)。否则有 toolset 的 agent 的 prompt hint 不提
    // understand_image,与实际注入不一致。
    addTools(OPENCLAUDE_VISION_MCP_ID, OPENCLAUDE_VISION_TOOLS, true)
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

// ─── Codex per-turn route override(v5 feat/v5-codex-oauth-egress A1/A2)─────
//
// master bridge 在 codex turn 的 inbound 帧上注入私有字段 `__oc_codex_route`
// (client 提供的同名字段在 bridge 侧已强制剥离,见 userChatBridge sanitize)。
// 容器 gateway 在 dispatchInbound 把它解析成 CodexProviderConfigOverride,经
// sessionManager.submit(opts.codexRoute) → runner.setCodexRoute 在下一次 spawn
// 拼成 codex CLI 的 `-c model_providers.*` 覆盖。
//
// v5 语义(与 v3 的关键差异,不得照搬 v3):
//   - official_oauth 不再是"空哨兵/直连官方"。v5 红线 = 数据面必须经
//     容器 loopback relay → master egress(账号绑定代理,fail-closed)转发,
//     所以 `{ kind: 'official_oauth' }` 在这里被固定拼成 loopback relay
//     override(base_url 指向本 gateway 的 /internal/v3/codex-relay 非 route
//     路径 + requires_openai_auth=true,codex CLI 继续用 auth.json 的 ChatGPT
//     token 发 Authorization —— 发给的是 loopback relay,不是 chatgpt.com)。
//   - api_relay override 校验保留(v5 DB 无启用行,不会触发;字段 allowlist
//     从 v3 的"取已知字段"收紧为"未知字段即拒",并加长度上限)。
//   - 门控用 resolveEngine(model, agent) === 'codex' 单点收口,而非 v3 的
//     agent.provider 判断 —— v5 任何 agent 都能以 gpt-5.5 骑 codex 底座。

/** official_oauth relay override 的 codex provider id(TOML key,只允许
 *  [A-Za-z0-9_-])。 */
export const CODEX_OFFICIAL_RELAY_PROVIDER_ID = 'oc_chatgpt_official'

/** official 上游 https://chatgpt.com/backend-api/codex 在容器 loopback relay 的
 *  base path(= master internalCodexRelay 的 codexRelayBasePathForUpstream 拼法:
 *  CODEX_RELAY_PREFIX + 上游 base path)。gateway 与 commercial 不互相 import,
 *  两侧各自持有常量 —— parity 由 commercial 侧单测锁定。 */
export const CODEX_OFFICIAL_RELAY_BASE_PATH = `${V3_CODEX_RELAY_PREFIX}/backend-api/codex`

const CODEX_ROUTE_PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const CODEX_ROUTE_BASE_URL_MAX = 512
const CODEX_ROUTE_PROVIDER_NAME_MAX = 128
const CODEX_API_RELAY_ROUTE_KEYS = new Set([
  'baseUrl',
  'modelProvider',
  'providerName',
  'wireApi',
  'preferredAuthMethod',
  'disableResponseStorage',
])

/**
 * Parse the master-owned Codex per-turn route override from an inbound frame.
 * 这是安全面:override 直接变成 codex CLI 的 base_url,任何放松都可能把平台
 * codex 流量引到任意上游。写严 —— 非 loopback / 未知字段 / 超长一律拒(→ null,
 * 即"本 turn 不带 override",codex 走 env 默认;v5 部署 env 无 OC_CODEX_* 六键,
 * 等价 fail-closed 到官方默认 provider,且容器无任何上游凭证)。
 */
export function _buildSafeCodexRouteOverride(args: {
  agent: { id: string; provider?: string; runnerKind?: string }
  model?: string
  rawRoute: unknown
  /** 本 gateway 的监听端口(config.gateway.port)——official override 的 loopback
   *  base_url 指回本进程的 /internal/v3/codex-relay handler。 */
  officialRelayPort: number
}): CodexProviderConfigOverride | null {
  if (!args.rawRoute || typeof args.rawRoute !== 'object' || Array.isArray(args.rawRoute)) {
    return null
  }
  // 单点收口:与 sessionManager.getOrCreate 的 engine 判定同构。resolveEngine
  // 对非法 runnerKind fail-closed 抛错 —— 那种配置在 getOrCreate 会同样炸,这里
  // 只需不带 override。
  let engineId: string
  try {
    engineId = resolveEngine(args.model, args.agent as never)
  } catch {
    return null
  }
  if (engineId !== 'codex') return null

  const r = args.rawRoute as Record<string, unknown>
  if (r.kind === 'official_oauth') {
    // Exact-shape marker only。带多余字段的 `{ kind: 'official_oauth', ... }`
    // 不得被重新解释(与 v3 同款防御,防 client 形状混淆)。
    if (Object.keys(r).length !== 1) return null
    const port = args.officialRelayPort
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
    return {
      modelProvider: CODEX_OFFICIAL_RELAY_PROVIDER_ID,
      baseUrl: `http://127.0.0.1:${port}${CODEX_OFFICIAL_RELAY_BASE_PATH}`,
      providerName: 'OpenAI (OpenClaude relay)',
      wireApi: 'responses',
      // auth.json(per-container chatgptAuthTokens)继续供 token;codex CLI 对
      // requires_openai_auth=true 的自定义 provider 会把 ChatGPT access token
      // 放进 Authorization 发到上面的 loopback base_url。
      preferredAuthMethod: 'chatgpt',
      disableResponseStorage: true,
      requiresOpenaiAuth: true,
    }
  }

  // api_relay 形状:未知字段即拒(严于 v3)。
  for (const key of Object.keys(r)) {
    if (!CODEX_API_RELAY_ROUTE_KEYS.has(key)) return null
  }
  if (typeof r.baseUrl !== 'string' || r.baseUrl.length > CODEX_ROUTE_BASE_URL_MAX) return null
  let routeBaseUrlOk = false
  try {
    const parsedRouteBase = new URL(r.baseUrl)
    routeBaseUrlOk =
      parsedRouteBase.protocol === 'http:' &&
      parsedRouteBase.hostname === '127.0.0.1' &&
      parsedRouteBase.pathname.startsWith(`${V3_CODEX_RELAY_PREFIX}/route/`)
  } catch {
    routeBaseUrlOk = false
  }
  if (!routeBaseUrlOk) return null
  if (typeof r.modelProvider !== 'string' || !CODEX_ROUTE_PROVIDER_ID_RE.test(r.modelProvider)) {
    return null
  }
  if (
    r.providerName !== undefined &&
    r.providerName !== null &&
    (typeof r.providerName !== 'string' || r.providerName.length > CODEX_ROUTE_PROVIDER_NAME_MAX)
  ) {
    return null
  }
  return {
    baseUrl: r.baseUrl,
    modelProvider: r.modelProvider,
    providerName: typeof r.providerName === 'string' ? r.providerName : null,
    wireApi: r.wireApi === 'responses' || r.wireApi === 'chat' ? r.wireApi : null,
    preferredAuthMethod:
      r.preferredAuthMethod === 'apikey' || r.preferredAuthMethod === 'chatgpt'
        ? r.preferredAuthMethod
        : null,
    disableResponseStorage:
      typeof r.disableResponseStorage === 'boolean' ? r.disableResponseStorage : null,
  }
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
   * v5 灰度运行时状态(commercial 自算,gateway 仅在 /healthz 只读透传)。
   * 结构内联(gateway 对 commercial 零编译期依赖),与 commercial 的
   * CommercialRuntimeStatus 保持一致。
   */
  runtimeStatus?: {
    channel: string
    controlPlaneEnabled: boolean
    autoMigrate: boolean
    agentRuntime: string
    containerRuntime: string
    schedulers: string[]
  }
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
      accountId?: string
      senderId: string
      text: string
      messageId?: string
      itemTypes?: string
      rawPayload?: unknown
      imageAttachments?: unknown[]
      mediaAttachments?: unknown[]
      idempotencyKey: string
      receivedAt: number
      channel?: 'wechat'
      agentId?: string
    }): Promise<unknown>
    cleanupBinding?(bindingUserId: string): Promise<unknown>
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
  /**
   * v5/spa 专用:React 主站服务 packages/web-react/dist,但超管后台仍是 legacy
   * packages/web/public/admin.html + modules/vendor。只对白名单 admin 资产 fallback,
   * 不把整个 legacy web 重新暴露给 v5。
   */
  legacyWebRoot?: string
  /**
   * 静态托管语义模式(单一权威在 cli launcher 按 runtime channel 选定,与 webRoot 同源决定):
   *   - 'vanilla'(默认,v3/personal): 服务 packages/web/public,沿用 ?v=hash cache-bust
   *     约定 → 资产 `public, max-age=3600`、sw.js 不缓存。**未设即 vanilla,v3 行为零变化**。
   *   - 'spa'(v5 Aurora): 服务 packages/web-react/dist 这类 bundler 产物 →
   *     `/assets/` 下内容哈希资产长缓存 immutable,其余(含 index.html)走 ETag 重校验。
   * 仅影响 Cache-Control 头的计算;ETag/304、路径白名单、SPA 回退逻辑两模式共用。
   */
  staticMode?: 'vanilla' | 'spa'
  channelFactories?: Array<(deps: { config: OpenClaudeConfig }) => ChannelAdapter>
  /** V3 2H: 商业化模块挂载点(undefined = 未启用)。由 cli launcher 在 COMMERCIAL_ENABLED=1 时注入。 */
  commercial?: CommercialHook
}

type WechatStartOutcome = {
  accepted?: boolean
  started: boolean
  completed?: boolean
  traceId?: string
  sessionKey?: string
  peerId?: string
  agentId?: string
}

function wechatPeerIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined
  return /^agent:[^:]+:webchat:dm:(wsess-[0-9a-f]{16})$/.exec(sessionKey)?.[1]
}

const DELEGATE_MEMORY_PRESSURE_DEFAULT_RATIO = 0.85
const DELEGATE_MEMORY_CURRENT_FILES = [
  '/sys/fs/cgroup/memory.current',
  '/sys/fs/cgroup/memory/memory.usage_in_bytes',
]
const DELEGATE_MEMORY_MAX_FILES = [
  '/sys/fs/cgroup/memory.max',
  '/sys/fs/cgroup/memory/memory.limit_in_bytes',
]

function parseDelegateMemoryPressureRatio(): number {
  const raw = Number(process.env.OPENCLAUDE_DELEGATE_MEMORY_PRESSURE_RATIO)
  return Number.isFinite(raw) && raw > 0 && raw < 1
    ? raw
    : DELEGATE_MEMORY_PRESSURE_DEFAULT_RATIO
}

function readFirstCgroupByteValue(files: readonly string[]): number | null {
  for (const file of files) {
    try {
      const text = readFileSync(file, 'utf8').trim()
      if (!text || text === 'max') continue
      const n = Number(text)
      if (Number.isFinite(n) && n > 0) return n
    } catch {}
  }
  return null
}

function readDelegateMemoryPressure(): { current: number; max: number; ratio: number } | null {
  const current = readFirstCgroupByteValue(DELEGATE_MEMORY_CURRENT_FILES)
  const max = readFirstCgroupByteValue(DELEGATE_MEMORY_MAX_FILES)
  if (!current || !max) return null
  // Docker/cgroup v1 sometimes reports a huge sentinel for "unlimited".
  if (max > Number.MAX_SAFE_INTEGER / 4) return null
  return { current, max, ratio: current / max }
}

// ── delegate 资源闸有界排队 ──────────────────────────────────────────────────
/** 资源闸(并发上限/内存水位)命中时的最长排队等待,超时按原闸形状(429/503)拒绝。
 *  客户端余量:mcp-memory postJsonToGateway 超时 2h,delegate idle/hard 计时在
 *  排队放行**之后**才起表,90s 等待不挤占执行预算。 */
const DELEGATE_QUEUE_WAIT_DEFAULT_MS = 90_000
/** 排队复查间隔(每 2-3s 复查一次两道闸)。 */
const DELEGATE_QUEUE_POLL_DEFAULT_MS = 2_500
/** 同时排队者上限:内存高压期每个等待者都挂着一条 HTTP 请求,不设上限会把
 *  "排队"本身堆成第二波雪崩;超出直接按原闸形状立即拒。 */
export const DELEGATE_QUEUE_MAX_WAITERS = 8

function parseDelegateQueueWaitMs(): number {
  const raw = Number(process.env.OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : DELEGATE_QUEUE_WAIT_DEFAULT_MS
}

// ── P2 债C — hidden reviewer 硬编排 review pass 参数/文案 ──────────────────
/** gateway 硬编排 review pass 的隐藏审查员 agent id(权威 = protocol
 *  HIDDEN_SYSTEM_AGENT_IDS,此处引用其唯一成员的字面量;isHiddenSystemAgentId 恒真)。 */
const HIDDEN_REVIEWER_AGENT_ID = 'hidden-reviewer'
/** NEEDS_FIX → continuation → 再审 的迭代封顶(预算封顶,env 可配)。到顶强制放行 +
 *  披露"仍有未决意见"。默认 2;非法/缺省回退默认。硬护栏另见 MAX_HIDDEN_DELEGATIONS_PER_TURN。 */
export const TEAM_REVIEW_MAX_ROUNDS_DEFAULT = 2
function resolveTeamReviewMaxRounds(): number {
  const raw = Number(process.env.OPENCLAUDE_TEAM_REVIEW_MAX_ROUNDS)
  if (!Number.isFinite(raw)) return TEAM_REVIEW_MAX_ROUNDS_DEFAULT
  // 下限 1(至少审一次)、上限对齐硬护栏(不让 env 把轮数抬过熔断)。
  const n = Math.floor(raw)
  return Math.min(Math.max(n, 1), MAX_HIDDEN_DELEGATIONS_PER_TURN)
}
/** 审查委派的 context:喂给隐藏审查员的用户原始需求 + 队长待提交草稿。 */
function buildTeamReviewContext(userTask: string, leaderDraft: string): string {
  const task = userTask.trim().slice(0, 8000)
  const draft = leaderDraft.trim().slice(0, 16000)
  return [
    '【审查任务】队长(全能助手)在团队协作后准备把下面的草稿作为最终答复提交给用户。',
    '请独立审查该草稿:找事实错误、遗漏、过度承诺、执行风险、以及与用户需求的偏离。',
    '',
    '## 用户原始需求',
    task || '(未提供)',
    '',
    '## 队长待提交草稿',
    draft || '(队长本轮没有产出文本草稿)',
    '',
    '审查完成后,按你的 persona 要求在最后单独一行输出结构化裁决:`VERDICT: PASS` 或 `VERDICT: NEEDS_FIX`。',
  ].join('\n')
}
/** NEEDS_FIX 后喂回队长的 system continuation:带上审查意见,要求队长修订或据理反驳后重新给出最终答复。 */
function buildTeamReviewContinuation(reviewOutput: string): string {
  const review = reviewOutput.trim().slice(0, 16000)
  return [
    '【系统 · 质量审查反馈】隐藏审查员对你上面的草稿给出了 NEEDS_FIX 裁决,审查意见如下:',
    '',
    review || '(审查员未给出具体意见文本)',
    '',
    '请据此修订你给用户的最终答复:接受并修复真实问题,或对你判定为误报/非问题/范围外的意见给出简明理由。',
    '然后直接输出修订后的最终答复(面向用户,不要复述本审查过程)。系统会在你完成后再次自动审查。',
  ].join('\n')
}

/** 资源闸拦截原因 —— 两道闸共用一个判定/拒绝收口,避免两套并行机制。 */
type DelegateGateBlock =
  | { kind: 'concurrency' }
  | { kind: 'memory'; pct: number; limitPct: number }

/** P2 债C — `_runDelegateTask` 的结构化入参(HTTP 壳从请求 body 组装;gateway 硬编排
 *  review pass 直接构造)。把委派执行核心与 HTTP req/res 解耦,让编排能内部直调同一路径
 *  拿到结构化结果(verdict/output),不必伪造 req/res。 */
interface RunDelegateInput {
  targetAgentId: string
  goal: string
  context?: string
  sourceAgent?: string
  toolsets?: unknown
  /** 父会话 sessionKey(容器内部键):委派归因 + 进度回传 + per-parent 分桶的解析源。 */
  parentSessionKey?: string
  streamProgress?: boolean
  depth: number
  /** gateway 硬编排触发的隐藏审查员委派。影响:runLog isReview / 资源闸走保留槽 + 免
   *  per-parent 桶 / 完成后解析结构化 verdict / 不置位"本 turn 有非隐藏委派"跟踪。 */
  isReview?: boolean
}
/** `_runDelegateTask` 结果。rejected=闸/校验拒(HTTP 壳映射 4xx/429/503);error=session
 *  创建等意外(映射 500);completed=真正执行完(ok/output/error/timedOut,review 还带 verdict)。 */
type DelegateTaskResult =
  | { kind: 'rejected'; httpStatus: number; message: string }
  | { kind: 'error'; message: string }
  | {
      kind: 'completed'
      ok: boolean
      output: string
      error?: string
      timedOut: boolean
      runId: string
      verdict?: ReviewVerdict
    }

// ── hidden 系统 agent 串行委派熔断 ──────────────────────────────────────────
/** 同一父 turn 内对 hidden 系统 agent(隐藏审查员)的委派次数硬上限。
 *
 *  P2 债C 后语义变更:审查触发权威已从 prompt 软约束**收归 gateway 硬编排**
 *  (dispatchInbound teamMode-main-webchat 的 review pass),队长 preamble 不再自觉
 *  调用 hidden-reviewer。本熔断因此从"拦队长 prompt 级串行重试"变为**硬编排重试的
 *  后备保险**:硬编排自身把迭代封顶在 OPENCLAUDE_TEAM_REVIEW_MAX_ROUNDS(默认 2)轮,
 *  本上限(3)是更外层的绝对护栏——即便编排逻辑有 bug 或未来放宽轮数,单 turn 对审查员
 *  的委派也不会失控(每轮 review 都是全新 delegate session 全额计费)。delegation depth
 *  只管嵌套、MAX_CONCURRENT_DELEGATIONS 只管并行,都拦不住串行重试,这里是第三条腿。 */
export const MAX_HIDDEN_DELEGATIONS_PER_TURN = 3

/** hidden 委派计数器。计数键 = **父会话 sessionKey**,依据:
 *  delegate 请求(mcp-memory handleDelegateTaskToAgent)只携带 parentSessionKey
 *  (取自 OPENCLAUDE_SESSION_KEY env)和 x-delegation-depth 头,请求里拿不到任何
 *  turn 级标识,因此退而按父会话维度计数,turn 边界由 dispatchInbound 在同一
 *  sessionKey 收到下一条用户消息时调用 resetForParent 划定。子 delegate 会话的
 *  sessionKey 自带时间戳(一次性,不能当计数键),但它作为"父"再委派时天然就是
 *  turn 粒度,其计数在该 delegate 请求收尾时清理。TTL 惰性清扫兜底 cron/task 等
 *  永远等不到下一条用户消息的父会话 —— 既防 Map 泄漏,也防"额度永久锁死"。 */
export class HiddenDelegateGuard {
  private counts = new Map<string, { count: number; touchedAt: number }>()

  constructor(
    private readonly limit = MAX_HIDDEN_DELEGATIONS_PER_TURN,
    /** 远大于 delegate hard timeout 上限(2h)和现实单 turn 时长,只兜内存/锁死。 */
    private readonly staleMs = 12 * 60 * 60_000,
  ) {}

  /** 为一次 hidden 委派占额度:未达上限 → 计数 +1 放行;已达上限 → 拒绝。 */
  tryAcquire(parentKey: string, now = Date.now()): boolean {
    this.prune(now)
    const entry = this.counts.get(parentKey)
    if (!entry) {
      this.counts.set(parentKey, { count: 1, touchedAt: now })
      return true
    }
    if (entry.count >= this.limit) return false
    entry.count++
    entry.touchedAt = now
    return true
  }

  /** 父会话开启新用户 turn / 父 delegate 会话收尾时清零。 */
  resetForParent(parentKey: string): void {
    this.counts.delete(parentKey)
  }

  private prune(now: number): void {
    for (const [key, entry] of this.counts) {
      if (now - entry.touchedAt > this.staleMs) this.counts.delete(key)
    }
  }
}

/**
 * delegate 计费归因 — 解析"父**客户端**会话 id"(usage_records.parent_session_id
 * 的落库值)。优先级(能拿到 web-* 就绝不落内部键):
 *
 *   1. `progressPeerId`:父会话在内存且是 webchat → 其 peerId 即客户端会话 id
 *      (web-*,userChatBridge sessionKey 模板 `agent:<aid>:webchat:dm:<id>` 的
 *      第 4 段来源)。
 *   2. `parentRepoSessionId`:嵌套 delegate(父是 delegate 会话)→ 其
 *      repoSessionId 在创建时继承自根 webchat 会话的 peerId,仍是 web-*。
 *   3. parentSessionKey 形如 webchat 键 → 直接截取第 4 段(父会话不在内存 ——
 *      如 gateway 重启后 —— 的兜底,不依赖 session map)。
 *   4. 原样返回 parentSessionKey(容器内部会话键,如 cron/webhook 父或更老格式;
 *      master 侧原样落库,映射链依赖本注释)。
 *   5. 都拿不到 → undefined(usage_records.parent_session_id 落 NULL,行上仍有
 *      mode='delegate' + delegate_agent_id 可归因到"某次委派")。
 *
 * 纯函数,便于单测;调用点唯一(handleDelegateTask)。
 */
export function resolveDelegateParentClientSessionId(args: {
  progressPeerId?: string
  parentRepoSessionId?: string
  parentSessionKey?: unknown
}): string | undefined {
  if (args.progressPeerId) return args.progressPeerId
  if (args.parentRepoSessionId) return args.parentRepoSessionId
  const key = args.parentSessionKey
  if (typeof key !== 'string' || !key) return undefined
  const webchat = /^agent:[^:]+:webchat:dm:(.+)$/.exec(key)
  return webchat?.[1] ?? key
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
  // SkillOpt training: async run registry (state machine + per-skill/global concurrency
  // cap). Drafts staged via skill_propose; merge promotes them to the authoritative lib.
  private skillTrainJobs = new SkillTrainJobStore({ maxConcurrent: 2 })
  private skillEvalJobs = new SkillEvalJobStore({ maxConcurrent: 1 })
  private skillDrafts = new SkillDraftStore()
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
  private _seenIdempotencyKeys = new Map<string, {
    ts: number
    wechat?: {
      sessionKey: string
      peerId: string
      agentId: string
      started: boolean
      completed?: boolean
      traceId?: string
      startPromise?: Promise<WechatStartOutcome>
    }
  }>() // key → timestamp + optional WeChat retry metadata
  private static readonly IDEMPOTENCY_MAX_KEYS = 1000
  private static readonly IDEMPOTENCY_TTL_MS = 5 * 60_000 // 5 minutes
  // WeChat turns now ACK Step 1 as soon as the runner starts and can keep
  // executing for hours. Keep only WeChat retry metadata long enough for
  // late Step1 retries to dedupe instead of dispatching a second copy.
  private static readonly WECHAT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000 // 24 hours

  /**
   * Check whether an idempotency key has already been processed (read-only).
   * Returns true if the key is a duplicate (i.e. should be skipped).
   */
  private _isIdempotencyDuplicate(key: string): boolean {
    return this._getIdempotencyEntry(key) !== null
  }

  private _getIdempotencyEntry(key: string): {
    ts: number
    wechat?: {
      sessionKey: string
      peerId: string
      agentId: string
      started: boolean
      completed?: boolean
      traceId?: string
      startPromise?: Promise<WechatStartOutcome>
    }
  } | null {
    if (!key) return null
    const now = Date.now()

    // Evict expired entries periodically
    if (this._seenIdempotencyKeys.size > 100) {
      for (const [k, entry] of this._seenIdempotencyKeys) {
        if (now - entry.ts > Gateway._idempotencyTtlMs(entry)) {
          this._seenIdempotencyKeys.delete(k)
        }
      }
    }

    const entry = this._seenIdempotencyKeys.get(key)
    if (!entry) return null
    if (now - entry.ts >= Gateway._idempotencyTtlMs(entry)) {
      this._seenIdempotencyKeys.delete(key)
      return null
    }
    return entry
  }

  private static _idempotencyTtlMs(entry: {
    wechat?: unknown
  }): number {
    return entry.wechat ? Gateway.WECHAT_IDEMPOTENCY_TTL_MS : Gateway.IDEMPOTENCY_TTL_MS
  }

  /** Record an idempotency key as processed. */
  private _markIdempotencyKey(
    key: string,
    wechat?: {
      sessionKey: string
      peerId: string
      agentId: string
      started: boolean
      completed?: boolean
      traceId?: string
      startPromise?: Promise<WechatStartOutcome>
    },
  ): void {
    if (key) this._seenIdempotencyKeys.set(key, { ts: Date.now(), ...(wechat ? { wechat } : {}) })
  }

  private _updateWechatIdempotency(
    key: string,
    patch: Partial<{
      started: boolean
      completed: boolean
      traceId: string
      sessionKey: string
      peerId: string
      agentId: string
    }>,
  ): void {
    const entry = this._getIdempotencyEntry(key)
    if (!entry?.wechat) return
    entry.ts = Date.now()
    entry.wechat = { ...entry.wechat, ...patch }
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

  // ── User-facing projection of the agents config (single authority) ──
  // 枚举/展示消费面(agent 管理 GET、/v1/models、技能作用域等)统一走这里:
  // agents/routes 剔除隐藏系统 agent、default 收敛到用户可见值。判定/授权/执行面
  // 不走此视图(继续用 isHiddenSystemAgentId predicate 看全量)。
  // 投影结果按底层缓存对象**身份**复用:_getAgentsConfig 只在 YAML mtime 变化时
  // 换新对象,故身份不变即可复用投影;换新(或错误路径每次 fresh read)即重算,
  // 无陈旧风险,也不改动底层缓存对象。
  private _agentsConfigUserViewSource: AgentsConfig | null = null
  private _agentsConfigUserViewCache: AgentsConfig | null = null

  private async _getAgentsConfigUserView(): Promise<AgentsConfig> {
    const cfg = await this._getAgentsConfig()
    if (this._agentsConfigUserViewCache && this._agentsConfigUserViewSource === cfg) {
      return this._agentsConfigUserViewCache
    }
    const view: AgentsConfig = {
      ...cfg,
      agents: filterUserVisibleAgentsForManagement(cfg.agents),
      routes: filterUserVisibleRoutesForManagement(cfg.routes),
      default: userVisibleDefaultAgentId(cfg.default),
    }
    this._agentsConfigUserViewSource = cfg
    this._agentsConfigUserViewCache = view
    return view
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
    // Reconcile skill-training runs persisted across a gateway restart (active → failed).
    void this.skillTrainJobs.loadAll(Date.now())
    void this.skillEvalJobs.loadAll(Date.now())
    // P3:技能每日自动回归(严格 opt-in:仅 evals.json 里 autoRegression=true 的技能;
    // 开启入口在管理中心且强制确认每日消耗 —— 平台绝不静默烧用户积分)。
    this._startSkillAutoRegression()
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
    const wechatProactiveCfg = readV3WechatProactiveConfig()
    this.cron = new CronScheduler(config, this.sessions, async (text, job) => {
      const agentId = job.agent
      // ── 根治:主动微信投递(定时任务/提醒推送到微信)──
      // 对所有用户发起的提醒/定时任务(remind-/ccb-/未来入口),排除系统 heartbeat/reflection
      // (见 isUserInitiatedCronJob —— 反向排除系统,避免白名单漏掉 remind- 这类入口)。
      // master 权威解析收件人(senderId = binding.loginUserId)+ 偏好 + context_token;
      // 据结果决定:微信接管→不重复 web;绑定但会话过期→回退 web 并标注;其它→正常 web。
      // 刻意不读 lastActiveChannel(其纯内存、重启即失、微信条目永不恢复)。
      let deliverText = text
      if (wechatProactiveCfg && isUserInitiatedCronJob(job)) {
        const result = await sendV3WechatProactive({
          config: wechatProactiveCfg,
          text,
          // 分钟粒度稳定幂等键:同一 fire(同分钟)被重跑→同 outboundId→outbox UNIQUE 去重,
          // 避免崩溃/重试窗口重复发微信(cron 调度本身也是分钟粒度去重)。
          outboundId: `${job.id}.wxproactive.${Math.floor(Date.now() / 60000)}`,
        }).catch(() => ({ kind: 'fallback', marked: false }) as const)
        if (result.kind === 'delivered') return
        if (result.marked) {
          deliverText = `⚠️ 微信因会话过期/未激活未送达(发条微信即可恢复推送)\n\n${text}`
        }
      }
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
        blocks: [{ kind: 'text' as const, text: `${icon} ${job.label || job.id}\n\n${deliverText}` }],
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

    // Commercial container telemetry: failed tool calls → master agent_audit.
    startToolFailureReporter()

    // Start rate limiter cleanup
    this.rateLimiter.startCleanup()

    // EventBus: bridge CCB CronCreate/CronDelete to gateway CronScheduler
    eventBus.on('task.created', (ev) => {
      if (!this.cron || ev.source !== 'cron-bridge') return
      if (isHiddenSystemAgentId(ev.agentId)) {
        this.log.warn('eventBus task.created hidden system agent rejected', {
          taskId: ev.taskId,
          agentId: ev.agentId,
        })
        return
      }
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
      if (isHiddenSystemAgentId(agentId)) {
        this.log.warn('webhook hidden system agent rejected', { agentId, webhookId })
        return
      }
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
    // microphone=(self): 允许同源页面用 getUserMedia 录音(语音输入 /ws/voice-transcribe）。
    // 之前 microphone=() 对所有源(含自身)禁用 → 浏览器报 "Permissions policy violation:
    // microphone is not allowed" → 语音输入彻底不可用。用户仍需显式授予麦克风权限,无安全损失。
    res.setHeader('Permissions-Policy', [
      'camera=()', 'microphone=(self)', 'geolocation=()',
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


    // v3 commercial Codex local relay(M1a 复活)。Codex CLI uses Authorization
    // for its upstream token, so the container gateway must translate it into a
    // private header and authenticate to master with OPENCLAUDE_V3_CONTAINER_TOKEN.
    // The handler is loopback-only; other bridge containers cannot use it.
    if (url.pathname === V3_CODEX_RELAY_PREFIX || url.pathname.startsWith(`${V3_CODEX_RELAY_PREFIX}/`)) {
      const relayCfg = readV3CodexRelayConfig(process.env)
      if (!relayCfg) {
        this.sendJson(res, 404, { error: { code: 'CODEX_RELAY_NOT_CONFIGURED', message: 'codex relay not configured' } })
        return
      }
      handleV3CodexRelayLocal(req, res, relayCfg).catch((err) => {
        this.log.error('v3 codex local relay crashed', undefined, err)
        if (!res.headersSent) {
          try { this.sendJson(res, 500, { error: { code: 'INTERNAL', message: 'codex relay crashed' } }) } catch {}
        } else {
          try { res.end() } catch {}
        }
      })
      return
    }

    // v3/v5 commercial marketplace relay. Codex subprocesses cannot see
    // OPENCLAUDE_* env, so oc-market falls back to this loopback-only path.
    if (url.pathname === V3_MARKETPLACE_LOCAL_RELAY_PREFIX || url.pathname.startsWith(`${V3_MARKETPLACE_LOCAL_RELAY_PREFIX}/`)) {
      const relayCfg = readV3MarketplaceRelayConfig(process.env)
      if (!relayCfg) {
        this.sendJson(res, 404, { error: { code: 'MARKETPLACE_RELAY_NOT_CONFIGURED', message: 'marketplace relay not configured' } })
        return
      }
      handleV3MarketplaceRelayLocal(req, res, relayCfg).catch((err) => {
        this.log.error('v3 marketplace local relay crashed', undefined, err)
        if (!res.headersSent) {
          try { this.sendJson(res, 500, { error: { code: 'INTERNAL', message: 'marketplace relay crashed' } }) } catch {}
        } else {
          try { res.end() } catch {}
        }
      })
      return
    }

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
      // /v1/models 枚举面走用户可见投影(隐藏系统 agent 不列);/v1/chat/completions
      // 目标解析/拒绝仍用全量 agentsConfig + predicate(判定面)。
      this._getAgentsConfigUserView()
        .then((agentsConfigUserView) =>
          handleOpenAIRequest(req, res, url, {
            config: this.deps.config,
            agentsConfig: this.deps.agentsConfig,
            agentsConfigUserView,
            sessions: this.sessions,
            runLog: this._runLog,
            readBody: (r) => this.readBody(r),
            sendJson: (r, c, b) => this.sendJson(r, c, b),
            sendError: (r, c, m) => this.sendError(r, c, m),
          }),
        )
        .then((handled) => {
          if (!handled) this.sendError(res, 404, 'unknown v1 endpoint')
        })
        .catch((err) => this.sendInternalError(res, err))
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

    // v3 WeChat `/stop` bridge. Master broker resolves the current wsess and
    // POSTs here so the container can interrupt the in-process runner. Same
    // HMAC gate as `/wechat-inbound`; the endpoint is intentionally internal
    // and never exposed to browser/client traffic.
    if (url.pathname === '/internal/v3/wechat-stop' && req.method === 'POST') {
      if (!this.checkInboundBypass(req, url)) {
        this.sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      this.handleWechatStop(req, res).catch((err) => {
        this.log.error('wechat-stop handler crashed', undefined, err)
        if (!res.headersSent) {
          try { this.sendJson(res, 500, { error: 'internal' }) } catch {}
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
      // v5 灰度可观测 — channel 标签 + commercial 运行时状态(控制面静默 / 运行时隔离 /
      // 灰度归属的只读断言面)。无标签默认 "v3";commercial 未注入 runtimeStatus 时省略。
      body.channel = process.env.OC_RUNTIME_CHANNEL?.trim() || 'v3'
      const instanceId = process.env.OC_INSTANCE_ID?.trim()
      if (instanceId) body.instance = instanceId
      if (c?.runtimeStatus) body.runtime = c.runtimeStatus
      if (c) {
        // master 形态深度探活:sessions.db open 失败 = 会话 list/save/落库全崩,
        // ok 必须翻 false 让监控(断言 .ok==true)与 deploy smoke 抓到 —— 2026-07-06
        // 存量库 schema 事故中进程活着但全站 500 两小时无告警的盲区收口。
        // 保持 HTTP 200:深度不健康 ≠ 完全不可服务(聊天引擎/静态资源仍在跑),
        // 不给上游 LB 摘流量的信号,只翻 ok 供告警面消费。
        // 容器内 gateway(c 为空)不探活:HOST probe 消费 capabilities 语义,不动。
        void probeSessionsDb()
          .then((p) => {
            body.deps = p.ok
              ? { sessionsDb: 'ok' }
              : { sessionsDb: 'error', sessionsDbError: p.error }
            if (!p.ok) body.ok = false
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(body))
          })
          .catch(() => {
            // probeSessionsDb 从不 reject;兜底防 healthz 挂起
            body.ok = false
            body.deps = { sessionsDb: 'error', sessionsDbError: 'probe rejected' }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(body))
          })
        return
      }
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
          // 排除内部委派会话：它们不是用户聊天会话，不能经此 API 泄露（Codex 审）。
          // key 形如 agent:<id>:delegate:...（第 3 段区分）。
          const kind = s.sessionKey.split(':')[2] || ''
          if (kind === 'delegate') return false
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
    // 持久化「用户发送的消息」到 master(跨设备/换浏览器可见)。前端发消息后调用,带自己的
    // 客户端消息 id —— getSession 回带同 id,前端合并天然去重(不与本地乐观 user 重复)。
    // 直写(appendServerAuthoredMessage,绕乐观并发,scoped by userId),只构造 role:'user',
    // 客户端无法注入 role/usage/_source/billing。会话行须先存在(前端 ensureServerSession 已建)。
    const userMsgMatch = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]{8,50})\/user-message$/)
    if (userMsgMatch && req.method === 'POST') {
      const sessId = userMsgMatch[1]
      const userId = this.getUserId(req)
      ;(async () => {
        let body: string
        try {
          body = await this.readBody(req, 256 * 1024)
        } catch {
          this.sendJson(res, 400, { error: 'invalid body' })
          return
        }
        let data: { id?: unknown; text?: unknown; ts?: unknown; media?: unknown }
        try {
          data = JSON.parse(body)
        } catch {
          this.sendJson(res, 400, { error: 'invalid JSON' })
          return
        }
        if (typeof data.id !== 'string' || !/^[\w:-]{1,80}$/.test(data.id) || typeof data.text !== 'string') {
          this.sendJson(res, 400, { error: 'id+text required' })
          return
        }
        const msg = {
          id: data.id,
          role: 'user' as const,
          text: data.text.slice(0, 200_000),
          ts: typeof data.ts === 'number' && Number.isFinite(data.ts) ? data.ts : Date.now(),
          ...(Array.isArray(data.media) ? { _media: data.media } : {}),
        }
        const r = await appendServerAuthoredMessage(sessId, userId, msg)
        if (r.applied) this.sendJson(res, 200, { ok: true })
        else if (r.reason === 'already_exists') this.sendJson(res, 200, { ok: true, idempotent: true })
        else if (r.reason === 'session_not_found') this.sendJson(res, 404, { error: 'session_not_found' })
        else if (r.reason === 'session_deleted') this.sendJson(res, 410, { error: 'session_deleted' })
        else this.sendJson(res, 409, { error: r.reason ?? 'conflict' })
      })().catch(() => this.sendJson(res, 500, { error: 'append failed' }))
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
      if (req.method === 'PATCH') {
        // 元数据专用更新(当前仅 title)。不走 PUT 的"整 blob 替换 + 乐观并发"语义:
        // rename 不携带 messages,骑 PUT 要么 409 要么把未随带的客户端消息 merge 掉。
        ;(async () => {
          let data: { title?: unknown }
          try {
            data = JSON.parse(await this.readBody(req, 16 * 1024))
          } catch {
            this.sendJson(res, 400, { error: 'invalid JSON' })
            return
          }
          const title = typeof data.title === 'string' ? data.title.trim() : ''
          if (!title || title.length > 120) {
            this.sendJson(res, 400, { error: 'title required (1-120 chars)' })
            return
          }
          const r = await renameClientSession(sessId, userId, title)
          if (!r.ok) this.sendJson(res, 404, { error: 'not found' })
          else this.sendJson(res, 200, { ok: true, updatedAt: r.updatedAt })
        })().catch(() => this.sendJson(res, 500, { error: 'patch failed' }))
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
      this.handleAgentsCollection(req, res).catch((err) => this.sendInternalError(res, err))
      return
    }
    const agentIdMatch = url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)$/)
    if (agentIdMatch) {
      this.handleAgentItem(req, res, agentIdMatch[1]).catch((err) =>
        this.sendInternalError(res, err),
      )
      return
    }
    const personaMatch = url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/persona$/)
    if (personaMatch) {
      this.handlePersona(req, res, personaMatch[1]).catch((err) =>
        this.sendInternalError(res, err),
      )
      return
    }
    const memoryMatch = url.pathname.match(
      /^\/api\/agents\/([a-zA-Z0-9_-]+)\/memory\/(memory|user)$/,
    )
    if (memoryMatch) {
      this.handleMemory(req, res, memoryMatch[1], memoryMatch[2] as 'memory' | 'user').catch(
        (err) => this.sendInternalError(res, err),
      )
      return
    }
    // User-level skill library (agentId-less; baseline + shared + aggregated legacy).
    if (url.pathname === '/api/skills') {
      this.handleUserSkillsList(req, res).catch((err) => this.sendInternalError(res, err))
      return
    }
    const userSkillFilesMatch = url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)\/files$/)
    if (userSkillFilesMatch) {
      this._handleUserSkillFiles(req, res, userSkillFilesMatch[1]).catch((err) =>
        this.sendInternalError(res, err),
      )
      return
    }
    const userSkillHistoryMatch = url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)\/history$/)
    if (userSkillHistoryMatch) {
      this._handleUserSkillHistory(req, res, userSkillHistoryMatch[1]).catch((err) =>
        this.sendInternalError(res, err),
      )
      return
    }
    const userSkillRestoreMatch = url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)\/restore$/)
    if (userSkillRestoreMatch) {
      this._handleUserSkillRestore(req, res, userSkillRestoreMatch[1]).catch((err) =>
        this.sendInternalError(res, err),
      )
      return
    }
    const userSkillItemMatch = url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)$/)
    if (userSkillItemMatch) {
      this.handleUserSkillItem(req, res, userSkillItemMatch[1]).catch((err) =>
        this.sendInternalError(res, err),
      )
      return
    }
    const skillsListMatch = url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/skills$/)
    if (skillsListMatch) {
      this.handleSkillsList(req, res, skillsListMatch[1]).catch((err) =>
        this.sendInternalError(res, err),
      )
      return
    }
    const skillViewMatch = url.pathname.match(
      /^\/api\/agents\/([a-zA-Z0-9_-]+)\/skills\/([a-z0-9-]+)$/,
    )
    if (skillViewMatch) {
      this.handleSkillItem(req, res, skillViewMatch[1], skillViewMatch[2]).catch((err) =>
        this.sendInternalError(res, err),
      )
      return
    }
    // ── Skill evals(用例 CRUD + 隔离双跑评测)──
    const skillEvalsFileMatch = url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)\/evals$/)
    if (skillEvalsFileMatch) {
      this._handleSkillEvalsFile(req, res, skillEvalsFileMatch[1]).catch((err) =>
        this.sendInternalError(res, err),
      )
      return
    }
    const skillEvalStartMatch = url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)\/eval-run$/)
    if (skillEvalStartMatch) {
      this._handleSkillEvalStart(req, res, skillEvalStartMatch[1]).catch((err) =>
        this.sendInternalError(res, err),
      )
      return
    }
    const skillEvalRunMatch = url.pathname.match(/^\/api\/skill-eval\/([a-zA-Z0-9_-]+)$/)
    if (skillEvalRunMatch) {
      this._handleSkillEvalRunStatus(req, res, skillEvalRunMatch[1]).catch((err) =>
        this.sendInternalError(res, err),
      )
      return
    }

    // ── SkillOpt skill-training (async; train → diff → confirm-merge) ──
    const skillTrainStartMatch = url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)\/train$/)
    if (skillTrainStartMatch) {
      this._handleSkillTrainStart(req, res, skillTrainStartMatch[1]).catch((err) =>
        this.sendInternalError(res, err),
      )
      return
    }
    const skillTrainDraftItemMatch = url.pathname.match(
      /^\/api\/skill-training\/([a-zA-Z0-9_-]+)\/drafts\/([a-z0-9-]+)$/,
    )
    if (skillTrainDraftItemMatch) {
      this._handleSkillTrainDraftItem(
        req,
        res,
        skillTrainDraftItemMatch[1],
        skillTrainDraftItemMatch[2],
      ).catch((err) => this.sendInternalError(res, err))
      return
    }
    const skillTrainCommentMatch = url.pathname.match(
      /^\/api\/skill-training\/([a-zA-Z0-9_-]+)\/drafts\/([a-z0-9-]+)\/comment$/,
    )
    if (skillTrainCommentMatch) {
      this._handleSkillTrainComment(
        req,
        res,
        skillTrainCommentMatch[1],
        skillTrainCommentMatch[2],
      ).catch((err) => this.sendInternalError(res, err))
      return
    }
    const skillTrainDraftsMatch = url.pathname.match(
      /^\/api\/skill-training\/([a-zA-Z0-9_-]+)\/drafts$/,
    )
    if (skillTrainDraftsMatch) {
      this._handleSkillTrainDrafts(req, res, skillTrainDraftsMatch[1]).catch((err) =>
        this.sendInternalError(res, err),
      )
      return
    }
    const skillTrainMergeMatch = url.pathname.match(
      /^\/api\/skill-training\/([a-zA-Z0-9_-]+)\/merge$/,
    )
    if (skillTrainMergeMatch) {
      this._handleSkillTrainMerge(req, res, skillTrainMergeMatch[1]).catch((err) =>
        this.sendInternalError(res, err),
      )
      return
    }
    const skillTrainRunMatch = url.pathname.match(/^\/api\/skill-training\/([a-zA-Z0-9_-]+)$/)
    if (skillTrainRunMatch) {
      this._handleSkillTrainRun(req, res, skillTrainRunMatch[1]).catch((err) =>
        this.sendInternalError(res, err),
      )
      return
    }
    // ── Inter-agent messaging ──
    const agentMsgMatch = url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/message$/)
    if (agentMsgMatch) {
      this.handleAgentMessage(req, res, agentMsgMatch[1]).catch((err) =>
        this.sendInternalError(res, err),
      )
      return
    }
    // ── Synchronous task delegation ──
    const delegateMatch = url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/delegate$/)
    if (delegateMatch) {
      this.handleDelegateTask(req, res, delegateMatch[1]).catch((err) =>
        this.sendInternalError(res, err),
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
      this.handleSearch(req, res, url).catch((err) => this.sendInternalError(res, err))
      return
    }
    // ── Cron/reminder REST API ──
    if (url.pathname === '/api/cron') {
      this.handleCronApi(req, res).catch((err) => this.sendInternalError(res, err))
      return
    }
    const cronItemMatch = url.pathname.match(/^\/api\/cron\/([a-zA-Z0-9_-]+)$/)
    if (cronItemMatch) {
      this.handleCronItem(req, res, cronItemMatch[1]).catch((err) =>
        this.sendInternalError(res, err),
      )
      return
    }
    // ── Tasks REST API ──
    if (url.pathname === '/api/tasks') {
      this._handleTasksApi(req, res).catch((err) => this.sendInternalError(res, err))
      return
    }
    const taskItemMatch = url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)$/)
    if (taskItemMatch) {
      this._handleTaskItem(req, res, taskItemMatch[1]).catch((err) =>
        this.sendInternalError(res, err),
      )
      return
    }
    if (url.pathname === '/api/tasks-executions' && req.method === 'GET') {
      this._taskStore
        .recentExecutions()
        .then((execs) => this.sendJson(res, 200, { executions: execs }))
        .catch((err) => this.sendInternalError(res, err))
      return
    }

    // ── Webhook REST API ──
    if (url.pathname === '/api/webhooks' && req.method === 'GET') {
      const list = filterUserVisibleByAgentField(this.webhookRouter?.list() ?? [])
      this.sendJson(res, 200, { webhooks: list })
      return
    }
    const webhookMatch = url.pathname.match(/^\/api\/webhooks\/([a-zA-Z0-9_-]+)$/)
    if (webhookMatch) {
      this._handleWebhook(req, res, webhookMatch[1]).catch((err) =>
        this.sendInternalError(res, err),
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
        this.sendInternalError(res, err),
      )
      return
    }

    // ── Claude.ai OAuth ──
    if (url.pathname === '/api/auth/claude/start') {
      this.handleOAuthStart(req, res).catch((err) => this.sendInternalError(res, err))
      return
    }
    if (url.pathname === '/api/auth/claude/callback') {
      this.handleOAuthCallback(req, res).catch((err) => this.sendInternalError(res, err))
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
      this.handleUpload(req, res).catch((err) => this.sendInternalError(res, err))
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
          this.sendInternalError(res, err)
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
          this.sendInternalError(res, err)
        } else {
          try { res.end() } catch { /* socket gone */ }
        }
      })
      return
    }

    // ── API / WS 404 守卫（仅 spa 模式）────────────────────────────────────
    // 走到这里说明请求未匹配上方任何 /api/* 或 /ws/* 路由(所有已匹配路由都已 return)。
    // spa 模式必须在 SPA fallback 之前对未匹配的 /api/*、/ws/* 显式返回 404 JSON:
    // 否则它们会落到下方 SPA fallback 拿到 index.html(200),新 React client 调错端点
    // 时会把 HTML 当 JSON 解析直接抛错、难定位。
    // 严格 gate 在 staticMode==='spa':vanilla(v3) 分支完全不进此守卫,行为字节级不变
    // (v3 零影响);且只拦"本就该 404 的兜底",不触碰任何已匹配路由。
    if (
      this.deps.staticMode === 'spa' &&
      (url.pathname.startsWith('/api/') ||
        url.pathname === '/ws' ||
        url.pathname.startsWith('/ws/'))
    ) {
      this.sendJson(res, 404, { error: 'not found' })
      return
    }

    // 静态 web UI (with in-memory cache)
    if (this.deps.webRoot) {
      const safePath = url.pathname === '/' ? '/index.html' : url.pathname
      // Cache-Control 按托管模式分流(规则单一权威 = staticCacheControl)。两模式共用下方的
      // ETag/304、路径白名单与 SPA 回退;仅本头不同 → vanilla 分支与历史完全一致(v3 零变化)。
      const cacheHeader = staticCacheControl(safePath, this.deps.staticMode)
      if (
        this.deps.staticMode === 'spa' &&
        this.deps.legacyWebRoot &&
        legacyAdminStaticPath(safePath)
      ) {
        const legacyFilePath = resolve(this.deps.legacyWebRoot, `.${safePath}`)
        if (legacyFilePath.startsWith(resolve(this.deps.legacyWebRoot))) {
          const cached = this._staticFileCache.get(legacyFilePath)
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
            const s = statSync(legacyFilePath)
            if (s.isFile()) {
              const content = readFileSync(legacyFilePath)
              const mime = mimeFor(legacyFilePath)
              const etag = `"${createHash('md5').update(content).digest('hex').slice(0, 16)}"`
              if (this._staticFileCache.size >= 200) {
                const firstKey = this._staticFileCache.keys().next().value
                if (firstKey !== undefined) this._staticFileCache.delete(firstKey)
              }
              this._staticFileCache.set(legacyFilePath, { content, mime, etag })
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
      }
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
   * bridge call for the explicit v3 bridge API allowlist. When true, the normal
   * checkHttpAuth() requirement is bypassed.
   *
   * All four conditions MUST hold:
   *  1. remote IP === OPENCLAUDE_TRUST_BRIDGE_IP (host in docker bridge)
   *  2. method + path match `BRIDGE_API_ALLOWLIST`
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
    const p = url.pathname
    if (!matchBridgeApiAllowlist(p, m)) return false
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
    const model = body.model
    if (model !== undefined && (typeof model !== 'string' || !ALLOWED_INBOUND_MODELS.has(model))) {
      this.sendJson(res, 400, { error: 'model unsupported for inbound dispatch' })
      return
    }
    const requestId = body.requestId
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[0-9a-f]{32}$/.test(requestId))) {
      this.sendJson(res, 400, { error: 'requestId must be 32 lowercase hex chars' })
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
      // WeChat-originated turns run on the normal webchat session key so the
      // realtime process link can attach to the same runner via WebSocket
      // hello/auto-resume. We still pass the v3-wechat-outbound adapter below;
      // that adapter is the only path that mirrors final text back to iLink.
      channel: 'webchat',
      peer: peerOut,
      ...(typeof agentId === 'string' ? { agentId } : {}),
      ...(typeof model === 'string' ? { model } : {}),
      ...(typeof requestId === 'string' ? { requestId } : {}),
      content: { text },
      ts,
    }
    // _userId 私有 stash,与 WS path(line 4163)同语义:dispatchInbound 内部读
    // (frame as any)._userId 决定 peerKey 命名空间和 client_sessions 归属。
    ;(frame as any)._userId = userId
    // The turn must run in the `webchat` session namespace so the realtime
    // link can attach to the same runner.  Only the rate-limit bucket remains
    // WeChat-scoped; lastActive must stay webchat/wsess so cron/webhook/
    // inter-agent pushes continue to reach the linked browser session.
    ;(frame as any)._rateLimitChannel = 'wechat'

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
    const safePeerId = peerId.replace(/[^a-zA-Z0-9_-]/g, '_')
    const resolvedAgentId = typeof agentId === 'string' ? agentId : 'main'
    const sessionKey = `agent:${resolvedAgentId}:webchat:dm:${safePeerId}`
    if (this._shuttingDown) {
      this.sendJson(res, 503, { error: 'gateway shutting down' })
      return
    }

    // Long WeChat tasks can run for hours. The master broker's Step 1 HTTP
    // deadline is intentionally short (seconds), so this endpoint must ACK
    // after validation instead of holding the request open until final.
    //
    // Idempotency is normally marked inside dispatchInbound. Because this path
    // ACKs before dispatch finishes, reserve the key synchronously here and
    // tell dispatchInbound not to treat that reservation as a duplicate.
    const duplicateEntry = this._getIdempotencyEntry(idempotencyKey)
    if (duplicateEntry) {
      let originalWechat = duplicateEntry.wechat
      if (!originalWechat) {
        this.sendJson(res, 409, { error: 'duplicate idempotencyKey owned by non-WeChat turn' })
        return
      }
      if (!originalWechat.started && !originalWechat.traceId && originalWechat.startPromise) {
        try {
          await originalWechat.startPromise
          originalWechat = this._getIdempotencyEntry(idempotencyKey)?.wechat ?? originalWechat
        } catch (err) {
          this._seenIdempotencyKeys.delete(idempotencyKey)
          this.log.error('wechat-inbound duplicate failed before original start', {
            userId,
            peerId,
            idempotencyKey,
            sessionKey: originalWechat.sessionKey,
          }, err as Error)
          this.sendJson(res, 500, { error: 'dispatch failed before start' })
          return
        }
      }
      const originalPeerId = wechatPeerIdFromSessionKey(originalWechat.sessionKey) ?? originalWechat.peerId
      this.sendJson(res, 200, {
        ok: true,
        deduplicated: true,
        accepted: originalWechat.started !== false,
        started: originalWechat.started,
        completed: originalWechat.completed === true,
        sessionKey: originalWechat.sessionKey,
        sessionId: originalPeerId,
        agentId: originalWechat.agentId,
        ...(originalWechat.traceId ? { traceId: originalWechat.traceId } : {}),
      })
      return
    }

    let startSettled = false
    let resolveStart!: (value: WechatStartOutcome) => void
    let rejectStart!: (err: unknown) => void
    const startPromise = new Promise<WechatStartOutcome>((resolve, reject) => {
      resolveStart = resolve
      rejectStart = reject
    })
    const settleStart = (value: WechatStartOutcome) => {
      if (startSettled) return
      startSettled = true
      resolveStart(value)
    }
    this._markIdempotencyKey(idempotencyKey, {
      sessionKey,
      peerId,
      agentId: resolvedAgentId,
      started: false,
      startPromise,
    })
    ;(frame as any)._idempotencyPreReserved = true

    ;(frame as any)._wechatDispatchStarted = (info?: { traceId?: string; sessionKey?: string; agentId?: string }) => {
      const routedPeerId = wechatPeerIdFromSessionKey(info?.sessionKey)
      this._updateWechatIdempotency(idempotencyKey, {
        started: true,
        ...(info?.traceId ? { traceId: info.traceId } : {}),
        ...(info?.sessionKey ? { sessionKey: info.sessionKey } : {}),
        ...(routedPeerId ? { peerId: routedPeerId } : {}),
        ...(info?.agentId ? { agentId: info.agentId } : {}),
      })
      settleStart({
        started: true,
        ...(info?.traceId ? { traceId: info.traceId } : {}),
        ...(info?.sessionKey ? { sessionKey: info.sessionKey } : {}),
        ...(routedPeerId ? { peerId: routedPeerId } : {}),
        ...(info?.agentId ? { agentId: info.agentId } : {}),
      })
    }
    const publishPostStartDispatchFailure = async (err: unknown) => {
      this._updateWechatIdempotency(idempotencyKey, { completed: true })
      const currentWechat = this._getIdempotencyEntry(idempotencyKey)?.wechat
      const errMessage = err instanceof Error ? err.message : String(err)
      const terminalPeer = {
        ...peerOut,
        id: currentWechat?.peerId ?? wechatPeerIdFromSessionKey(currentWechat?.sessionKey) ?? peerId,
      }
      const terminalOut = {
        type: 'outbound.message' as const,
        sessionKey: currentWechat?.sessionKey ?? sessionKey,
        channel: 'webchat' as const,
        peer: terminalPeer,
        agentId: currentWechat?.agentId ?? resolvedAgentId,
        blocks: [
          {
            kind: 'text' as const,
            text: `[error] 微信任务启动后失败：${errMessage.slice(0, 300) || 'unknown error'}`,
          },
        ],
        isFinal: true,
        ...(currentWechat?.traceId ? { traceId: currentWechat.traceId } : {}),
        _userId: userId,
      }
      this.log.error('wechat-inbound async dispatch failed', {
        userId,
        peerId,
        idempotencyKey,
        sessionKey: terminalOut.sessionKey,
      }, err as Error)
      this.deliver(terminalOut, undefined)
      try {
        await this._sendAdapterOutboundMessage(terminalOut, v3OutboundAdapter)
      } catch (sendErr) {
        this.log.error('wechat-inbound async failure terminal send failed', {
          userId,
          peerId,
          idempotencyKey,
          sessionKey: terminalOut.sessionKey,
        }, sendErr as Error)
      }
    }
    const dispatchPromise = this.dispatchInbound(frame as InboundFrame, v3OutboundAdapter)
      .then(() => {
        if (!startSettled) {
          settleStart({ accepted: false, started: false })
        }
      })
      .catch((err) => {
        if (!startSettled) {
          startSettled = true
          rejectStart(err)
          return
        }
        void publishPostStartDispatchFailure(err)
      })

    let startOutcome: WechatStartOutcome
    try {
      startOutcome = await startPromise
    } catch (err) {
      this._seenIdempotencyKeys.delete(idempotencyKey)
      this.log.error('wechat-inbound dispatch failed before start', {
        userId,
        peerId,
        idempotencyKey,
        sessionKey,
      }, err as Error)
      this.sendJson(res, 500, { error: 'dispatch failed before start' })
      return
    }
    void dispatchPromise

    this.sendJson(res, 200, {
      ok: true,
      accepted: startOutcome.accepted !== false,
      started: startOutcome.started,
      sessionKey: startOutcome.sessionKey ?? sessionKey,
      sessionId:
        startOutcome.peerId ?? wechatPeerIdFromSessionKey(startOutcome.sessionKey ?? sessionKey) ?? peerId,
      ...(startOutcome.agentId ? { agentId: startOutcome.agentId } : {}),
      ...(startOutcome.traceId ? { traceId: startOutcome.traceId } : {}),
    })
  }

  /**
   * v3 WeChat `/stop` bridge. Master resolves the current WeChat wsess and
   * calls this container-local endpoint; the actual runner is keyed as a
   * webchat session so the Web realtime link and WeChat interrupt hit the
   * same `agent:<id>:webchat:dm:<wsess>` SessionManager entry.
   */
  private async handleWechatStop(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const MAX_STOP_BODY = 16 * 1024
    let raw: string
    try {
      raw = await this.readBody(req, MAX_STOP_BODY)
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
    if (peerRaw.kind !== 'dm') {
      this.sendJson(res, 400, { error: 'peer.kind must be dm' })
      return
    }
    const peerId = peerRaw.id
    if (typeof peerId !== 'string' || !/^wsess-[0-9a-f]{16}$/.test(peerId)) {
      this.sendJson(res, 400, { error: 'peer.id must be wsess-[0-9a-f]{16}' })
      return
    }
    const agentId = body.agentId
    if (agentId !== undefined && (typeof agentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(agentId))) {
      this.sendJson(res, 400, { error: 'agentId charset/length invalid' })
      return
    }
    const interrupted = await this.handleStop({
      type: 'inbound.control.stop',
      channel: 'webchat',
      peer: { kind: 'dm', id: peerId },
      ...(typeof agentId === 'string' ? { agentId } : {}),
    })
    this.sendJson(res, 200, { ok: true, interrupted })
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
  /** 500 兜底收口:真实错误进日志(可排障),响应只回受控文案 —— 此前 39 处
   *  `sendError(res, 500, String(err))` 会把容器内部路径/栈回显给客户端。 */
  private sendInternalError(res: ServerResponse, err: unknown): void {
    // eslint-disable-next-line no-console
    console.error('[gateway] internal error:', err)
    this.sendJson(res, 500, { error: 'internal error' })
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
    // D1:支持 HTTP Range —— 有合法 Range → 206 局部,无/非法 → 200 全量并宣告
    // Accept-Ranges。Content-Length 由 serveFileFdWithRange 按 200/206 补齐,fd 由
    // 流 autoClose 接管(与改造前一致,无泄漏)。
    serveFileFdWithRange(
      res,
      fd,
      fileStat.size,
      {
        'Content-Type': fileContentType,
        'Cache-Control': 'private, max-age=3600',
        'Content-Disposition': `${fileDispositionMode}; filename="${encodeURIComponent(basename(realPath) || 'file')}"`,
      },
      { rangeHeader: req.headers.range, isHead: req.method === 'HEAD' },
    )
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
      'Cache-Control': 'private, max-age=3600',
    }
    mediaHeaders['Content-Disposition'] = `${shouldServeInline(mediaContentType) ? 'inline' : 'attachment'}; filename="${encodeURIComponent(basename(realPath) || 'file')}"`
    // D1:与 /api/file 同构 —— Range → 206,否则 200 全量 + Accept-Ranges。
    serveFileFdWithRange(res, fd, mediaStat.size, mediaHeaders, {
      rangeHeader: req.headers.range,
      isHead: req.method === 'HEAD',
    })
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
    if (req.method === 'GET') {
      // 枚举面:走用户可见投影(隐藏系统 agent 已剔除、default 已收敛)。
      const view = await this._getAgentsConfigUserView()
      this.sendJson(res, 200, {
        agents: view.agents,
        default: view.default,
        routes: view.routes,
      })
      return
    }
    if (req.method === 'POST') {
      // 建 agent 是 mutation 面:必须读/写全量 config(不能用投影视图,否则写回
      // agents.yaml 会把隐藏系统 agent 一并删掉)。保留 id 拒绝仍用 predicate 看全量。
      const cfg = await readAgentsConfig()
      const body = await this.readJsonBody<Partial<AgentDef>>(req)
      if (!body.id || !/^[a-zA-Z0-9_-]+$/.test(body.id)) {
        this.sendError(res, 400, 'invalid agent id (use only a-z 0-9 _ -)')
        return
      }
      if (isHiddenSystemAgentId(body.id)) {
        this.sendError(res, 403, 'agent id is reserved')
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
    if (isHiddenSystemAgentId(id)) return this.sendError(res, 404, 'agent not found')
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
    if (isHiddenSystemAgentId(id)) return this.sendError(res, 404, 'agent not found')
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
    if (isHiddenSystemAgentId(agentId)) return this.sendError(res, 404, 'agent not found')
    const store = new MemoryStore(agentId)
    await store.load()
    if (req.method === 'GET') {
      this.sendJson(res, 200, {
        text: store.read(target),
        charCount: store.charCount(target),
        limit: store.charLimit(target),
        target,
      })
      return
    }
    if (req.method === 'PUT') {
      const body = await this.readJsonBody<{ text?: string }>(req)
      const r = await store.overwrite(target, body.text ?? '')
      if (!r.ok) return this.sendError(res, 400, r.error ?? 'save failed')
      this.sendJson(res, 200, {
        ok: true,
        charCount: store.charCount(target),
        limit: store.charLimit(target),
      })
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
    if (isHiddenSystemAgentId(agentId)) return this.sendError(res, 404, 'agent not found')
    if (req.method !== 'GET') return this.sendError(res, 405, 'method not allowed')
    const store = buildAgentSkillStore(agentId)
    // User-facing surface: never enumerate platform baseline/seed skills.
    const list = await store.list({ includePlatform: false })
    this.sendJson(res, 200, { skills: list })
  }

  // GET/PUT/DELETE /api/agents/:id/skills/:name
  private async handleSkillItem(
    req: IncomingMessage,
    res: ServerResponse,
    agentId: string,
    skillName: string,
  ): Promise<void> {
    if (isHiddenSystemAgentId(agentId)) return this.sendError(res, 404, 'agent not found')
    const store = buildAgentSkillStore(agentId)
    if (req.method === 'GET') {
      // User-facing read: platform skills resolve to 404, never leak their body.
      const v = await store.view(skillName, undefined, { includePlatform: false })
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

  // GET /api/skills — user-level skill library list.
  // Aggregates shared + all agents' legacy + marketplace hub (NOT per-agent seed),
  // so a user sees one unified "my skills" library regardless of which agent is active.
  private async handleUserSkillsList(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') return this.sendError(res, 405, 'method not allowed')
    await this.syncMarketplaceHubForManagement()
    const store = buildUserSkillStore()
    // User-facing surface: never enumerate platform baseline/seed skills.
    const list = await store.list({ includePlatform: false })
    this.sendJson(res, 200, { skills: list })
  }

  private async syncMarketplaceHubForManagement(): Promise<void> {
    try {
      await syncMarketplaceHub({ timeoutMs: 4000 })
    } catch {
      /* fail-soft: management reads must still work if marketplace sync is unavailable */
    }
  }

  // PUT/DELETE /api/skills/:name/files — 技能目录内辅助文件的写/删(编辑器)。
  // 路径白名单 references/|assets/|evals/|scripts/,单文件≤64KB;evals.json 过 schema。
  private async _handleUserSkillFiles(
    req: IncomingMessage,
    res: ServerResponse,
    skillName: string,
  ): Promise<void> {
    const store = buildUserSkillStore()
    const skill = await store.view(skillName, undefined, { includePlatform: false })
    if (!skill || typeof skill === 'string') return this.sendError(res, 404, 'skill not found')
    if (skill.writable !== true) return this.sendError(res, 403, 'skill is read-only')
    const AUX_PREFIXES = ['references/', 'assets/', 'evals/', 'scripts/']
    if (req.method === 'PUT') {
      const body = await this.readJsonBody<{ path?: string; content?: string }>(req)
      const path = (body?.path ?? '').trim()
      const content = body?.content
      if (!path || typeof content !== 'string') return this.sendError(res, 400, 'path/content required')
      if (!AUX_PREFIXES.some((p) => path.startsWith(p)))
        return this.sendError(res, 400, `path 须位于 ${AUX_PREFIXES.join(' | ')} 之下`)
      if (Buffer.byteLength(content, 'utf8') > 64 * 1024)
        return this.sendError(res, 400, '单文件上限 64KB')
      if (path === 'evals/evals.json') {
        const parsed = parseSkillEvalsJson(content)
        if (!parsed.ok) {
          this.sendJson(res, 422, { error: 'invalid evals', errors: parsed.errors })
          return
        }
      }
      const r = await store.saveAuxFile(skillName, path, content)
      if (!r.ok) return this.sendError(res, 400, r.error ?? 'save failed')
      this.sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'DELETE') {
      const path = new URL(req.url ?? '/', 'http://x').searchParams.get('path') ?? ''
      if (!AUX_PREFIXES.some((p) => path.startsWith(p)))
        return this.sendError(res, 400, 'invalid path')
      const r = await store.deleteAuxFile(skillName, path)
      if (!r.ok) return this.sendError(res, 400, r.error ?? 'delete failed')
      this.sendJson(res, 200, { ok: true })
      return
    }
    this.sendError(res, 405, 'method not allowed')
  }

  // GET /api/skills/:name/history — 版本历史;POST /api/skills/:name/restore — 恢复。
  // 历史/恢复只覆盖 SKILL.md 正文(save() 快照机制),辅助文件不在快照范围。
  private async _handleUserSkillHistory(
    req: IncomingMessage,
    res: ServerResponse,
    skillName: string,
  ): Promise<void> {
    if (req.method !== 'GET') return this.sendError(res, 405, 'method not allowed')
    const store = buildUserSkillStore()
    const skill = await store.view(skillName, undefined, { includePlatform: false })
    if (!skill || typeof skill === 'string') return this.sendError(res, 404, 'skill not found')
    this.sendJson(res, 200, { history: await store.history(skillName), writable: skill.writable === true })
  }

  private async _handleUserSkillRestore(
    req: IncomingMessage,
    res: ServerResponse,
    skillName: string,
  ): Promise<void> {
    if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
    const store = buildUserSkillStore()
    const skill = await store.view(skillName, undefined, { includePlatform: false })
    if (!skill || typeof skill === 'string') return this.sendError(res, 404, 'skill not found')
    if (skill.writable !== true) return this.sendError(res, 403, 'skill is read-only')
    const body = await this.readJsonBody<{ version?: string }>(req)
    const version = (body?.version ?? '').trim()
    if (!version) return this.sendError(res, 400, 'version required')
    const r = await store.restore(skillName, version)
    if (!r.ok) return this.sendError(res, 400, r.error ?? 'restore failed')
    this.sendJson(res, 200, { ok: true })
  }

  private async validateSkillAgentScopeInput(input: unknown): Promise<string[] | { error: string }> {
    const parsed = validateSkillAgentScope(input)
    if (!parsed.ok || !parsed.agentIds) return { error: parsed.error ?? 'invalid agentIds' }
    // 枚举面:走用户可见投影 —— view.agents 已剔除隐藏系统 agent、view.default 已
    // 收敛,故 allowed 集合天然不含隐藏 id(无需再手工 !isHiddenSystemAgentId 过滤)。
    let cfg: AgentsConfig
    try {
      cfg = await this._getAgentsConfigUserView()
    } catch {
      cfg = { agents: [{ id: 'main' }], routes: [], default: 'main' }
    }
    const allowed = new Set<string>(
      ['main', cfg.default, ...(cfg.agents ?? []).map((a) => a.id)].filter(
        (id): id is string => typeof id === 'string',
      ),
    )
    const bad = parsed.agentIds.find((id) => !allowed.has(id))
    if (bad) return { error: `unknown agentId: ${bad}` }
    return parsed.agentIds
  }

  // GET/PUT/DELETE /api/skills/:name — user-level skill item. Writes/deletes go to
  // the shared library (delete also sweeps same-named legacy residue across agents).
  private async handleUserSkillItem(
    req: IncomingMessage,
    res: ServerResponse,
    skillName: string,
  ): Promise<void> {
    if (req.method === 'GET') {
      await this.syncMarketplaceHubForManagement()
      const store = buildUserSkillStore()
      // User-facing read: platform skills resolve to 404, never leak their body.
      // ?file=<rel> → 读取技能目录内单个文件(编辑器/整目录发布导入用)。
      const fileParam = new URL(req.url ?? '/', 'http://x').searchParams.get('file')
      if (fileParam) {
        // 目录穿越由 view() 的词法守卫兜底;此处仅挡明显非法与 history/。
        if (fileParam.includes('..') || fileParam.startsWith('/') || fileParam.startsWith('history/')) {
          return this.sendError(res, 400, 'invalid file path')
        }
        const content = await store.view(skillName, fileParam, { includePlatform: false })
        if (typeof content !== 'string') return this.sendError(res, 404, 'file not found')
        this.sendJson(res, 200, { path: fileParam, content })
        return
      }
      const v = await store.view(skillName, undefined, { includePlatform: false })
      if (!v || typeof v === 'string') return this.sendError(res, 404, 'skill not found')
      this.sendJson(res, 200, { skill: v })
      return
    }
    const store = buildUserSkillStore()
    if (req.method === 'PUT') {
      const body = await this.readJsonBody<{
        description?: string
        body?: string
        tags?: string[]
        agentIds?: unknown
      }>(req)
      const hasDescription = Object.prototype.hasOwnProperty.call(body, 'description')
      const hasBody = Object.prototype.hasOwnProperty.call(body, 'body')
      const hasTags = Object.prototype.hasOwnProperty.call(body, 'tags')
      const hasAgentIds = Object.prototype.hasOwnProperty.call(body, 'agentIds')
      let agentIds: string[] | undefined
      if (hasAgentIds) {
        const scope = await this.validateSkillAgentScopeInput(body.agentIds)
        if (!Array.isArray(scope)) return this.sendError(res, 400, scope.error)
        agentIds = scope
      }
      if (hasAgentIds && !hasDescription && !hasBody && !hasTags) {
        const r = await store.setAgentScope(skillName, agentIds as string[])
        if (!r.ok) return this.sendError(res, 400, r.error ?? 'save failed')
        this.sendJson(res, 200, { ok: true })
        return
      }
      const r = await store.save(
        { name: skillName, description: body.description ?? '', tags: body.tags },
        body.body ?? '',
        agentIds ? { agentIds } : undefined,
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

  // ── Skill evals(评测:用例文件 CRUD + 隔离双跑 run)──────────────────────
  //
  // 成本纪律:评测跑真模型、消耗用户积分 —— 启动只经显式 POST(前端有估算+确认
  // 对话框),run.usage 逐 turn 累计供前端实报;用例上限(≤5)即成本上限。

  /** GET: evals 文件 + 上次结果;PUT: 保存 evals(仅可写技能)。 */
  private async _handleSkillEvalsFile(
    req: IncomingMessage,
    res: ServerResponse,
    skillName: string,
  ): Promise<void> {
    const store = buildUserSkillStore()
    const skill = await store.view(skillName, undefined, { includePlatform: false })
    if (!skill || typeof skill === 'string') return this.sendError(res, 404, 'skill not found')
    if (req.method === 'GET') {
      const raw = await store.view(skillName, 'evals/evals.json', { includePlatform: false })
      let evals: SkillEvalsFile | null = null
      let parseErrors: string[] | undefined
      if (typeof raw === 'string') {
        const parsed = parseSkillEvalsJson(raw)
        if (parsed.ok) evals = parsed.file
        else parseErrors = parsed.errors
      }
      let lastRun: unknown = null
      const lastRaw = await store.view(skillName, 'evals/last-run.json', {
        includePlatform: false,
      })
      if (typeof lastRaw === 'string') {
        try {
          lastRun = JSON.parse(lastRaw)
        } catch {}
      }
      this.sendJson(res, 200, {
        evals,
        parseErrors,
        lastRun,
        writable: skill.writable === true,
      })
      return
    }
    if (req.method === 'PUT') {
      if (skill.writable !== true) return this.sendError(res, 403, 'skill is read-only')
      const body = await this.readBody(req)
      let parsedBody: { evals?: unknown }
      try {
        parsedBody = JSON.parse(body)
      } catch {
        return this.sendError(res, 400, 'invalid JSON')
      }
      const parsed = parseSkillEvalsJson(JSON.stringify(parsedBody.evals ?? null))
      if (!parsed.ok) {
        this.sendJson(res, 422, { error: 'invalid evals', errors: parsed.errors })
        return
      }
      const w = await store.saveAuxFile(skillName, 'evals/evals.json', serializeSkillEvals(parsed.file))
      if (!w.ok) return this.sendError(res, 400, w.error ?? 'failed to save evals')
      this.sendJson(res, 200, { ok: true, evals: parsed.file })
      return
    }
    this.sendError(res, 405, 'method not allowed')
  }

  /** POST /api/skills/:name/eval-run — 启动评测(202 → runId,进度轮询 status)。 */
  private async _handleSkillEvalStart(
    req: IncomingMessage,
    res: ServerResponse,
    skillName: string,
  ): Promise<void> {
    if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
    const userId = this.getUserId(req)
    const store = buildUserSkillStore()
    const skill = await store.view(skillName, undefined, { includePlatform: false })
    if (!skill || typeof skill === 'string') return this.sendError(res, 404, 'skill not found')

    const body = await this.readJsonBody<{ mode?: string; trainRunId?: string }>(req).catch(
      () => ({}) as { mode?: string; trainRunId?: string },
    )
    const mode = body?.mode === 'draft' ? ('draft' as const) : ('baseline' as const)

    // draft 模式:草稿必须存在且属于本用户的训练 run,用草稿携带的用例(如有)覆盖现版用例。
    let draftDir: string | undefined
    let draftEvalsJson: string | undefined
    let trainRunId: string | null = null
    if (mode === 'draft') {
      const trainRun = body?.trainRunId ? this.skillTrainJobs.get(body.trainRunId) : undefined
      if (!trainRun || trainRun.userId !== userId)
        return this.sendError(res, 404, 'training run not found')
      const draft = await this.skillDrafts.readDraft(trainRun.runId, skillName)
      if (!draft || draft.record.op === 'delete')
        return this.sendError(res, 400, 'no evaluable draft for this skill in the training run')
      trainRunId = trainRun.runId
      draftDir = join(paths.skillDraftRunDir(trainRun.runId), skillName)
      draftEvalsJson = draft.evalsJson
    }

    // 用例来源:草稿附带 > 技能自带。没有用例 → 明确 400(而不是空跑烧积分)。
    let evalsRaw =
      draftEvalsJson ??
      ((await store.view(skillName, 'evals/evals.json', { includePlatform: false })) as
        | string
        | null)
    if (typeof evalsRaw !== 'string') evalsRaw = null
    if (!evalsRaw)
      return this.sendError(res, 400, 'skill has no evals/evals.json — add eval cases first')
    const parsed = parseSkillEvalsJson(evalsRaw)
    if (!parsed.ok) {
      this.sendJson(res, 422, { error: 'invalid evals', errors: parsed.errors })
      return
    }

    const guard = this.skillEvalJobs.canStart(skillName)
    if (!guard.ok) return this.sendError(res, 409, guard.reason ?? 'cannot start eval')

    const run = await this.skillEvalJobs.create({
      runId: SkillEvalJobStore.newRunId(),
      skillName,
      userId,
      mode,
      trainRunId,
      model: SKILL_TRAIN_DEFAULT_MODEL,
      cases: parsed.file.cases,
      now: Date.now(),
    })
    void this._runSkillEval(run, { draftDir }).catch((err) => {
      void this.skillEvalJobs.finish(run, Date.now(), { error: String(err) })
    })
    this.sendJson(res, 202, { ok: true, runId: run.runId })
  }

  /** GET /api/skill-eval/:runId — run 状态(owner 校验,同训练 run 语义)。 */
  private async _handleSkillEvalRunStatus(
    req: IncomingMessage,
    res: ServerResponse,
    runId: string,
  ): Promise<void> {
    if (req.method !== 'GET') return this.sendError(res, 405, 'method not allowed')
    const run = this.skillEvalJobs.get(runId)
    if (!run) return this.sendError(res, 404, 'eval run not found')
    if (run.userId !== this.getUserId(req)) return this.sendError(res, 403, 'forbidden')
    this.sendJson(res, 200, { run })
  }

  /** 跑一个被测/评分 turn:一次性会话,收最终文本+用量,完了销毁会话释放资源。 */
  private async _skillEvalTurn(
    sessionKey: string,
    userId: string,
    prompt: string,
    model: string,
    opts: {
      skillEvalExclude?: string
      skillEvalDraft?: { name: string; dir: string }
    },
  ): Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number } }> {
    const agent = await this._trainingAgent()
    if (!agent) throw new Error('no agent available for eval')
    const session = await this.sessions.getOrCreate({
      sessionKey,
      agent,
      channel: 'skill-eval',
      peerId: sessionKey,
      userId,
      effortLevel: 'high',
      workload: 'skill-eval',
      skillEvalMode: true,
      skillEvalExclude: opts.skillEvalExclude,
      skillEvalDraft: opts.skillEvalDraft,
    })
    try {
      return await new Promise((resolvePromise, rejectPromise) => {
        // 文本块按 blockId 聚合(同 block 流式覆盖,不同 block 顺序拼接)。
        const texts = new Map<string, string>()
        const order: string[] = []
        this.sessions
          .submit(
            session,
            prompt,
            (e) => {
              if (e.kind === 'block' && e.block.kind === 'text' && typeof e.block.text === 'string') {
                // parser 发出的 text 是**增量片段**(内部才做累计),按 messageId 拼接。
                const id = e.block.messageId ?? 'b0'
                if (!texts.has(id)) order.push(id)
                texts.set(id, (texts.get(id) ?? '') + e.block.text)
              } else if (e.kind === 'final') {
                const text = order.map((id) => texts.get(id) ?? '').join('\n').trim()
                resolvePromise({ text, usage: e.meta })
              } else if (e.kind === 'error') {
                rejectPromise(new Error(e.error))
              }
            },
            'high',
            model,
          )
          .catch(rejectPromise)
      })
    } finally {
      // 评测会话一次性:立即销毁,释放子进程/pids;失败不影响结果。
      await this.sessions.destroySession(sessionKey).catch(() => {})
    }
  }

  /** 评测编排:逐 case 逐 arm 隔离跑 → 每 case 一个匿名 grader turn → benchmark。 */
  private async _runSkillEval(run: SkillEvalRun, opts: { draftDir?: string }): Promise<void> {
    run.status = 'running'
    await this.skillEvalJobs.touch(run, Date.now())
    const arms = armsForMode(run.mode)
    const preferences: Array<'draft' | 'current' | 'tie'> = []

    for (const c of run.cases) {
      const armOutputs: Array<{ arm: (typeof arms)[number]; result: SkillEvalCaseResult }> = []
      for (const arm of arms) {
        const sessionKey = `skilleval:${run.runId}:${c.id}:${arm}`
        const result: SkillEvalCaseResult = {
          caseId: c.id,
          arm,
          output: '',
          usage: emptyUsage(),
          assertions: [],
        }
        try {
          const { text, usage } = await this._skillEvalTurn(
            sessionKey,
            run.userId,
            buildEvalCasePrompt(c),
            run.model,
            {
              skillEvalExclude: arm === 'without' ? run.skillName : undefined,
              skillEvalDraft:
                arm === 'draft' && opts.draftDir
                  ? { name: run.skillName, dir: opts.draftDir }
                  : undefined,
            },
          )
          result.output = text.slice(0, 20_000)
          addUsage(result.usage, usage)
          addUsage(run.usage, usage)
        } catch (err) {
          result.error = String(err)
        }
        run.results.push(result)
        armOutputs.push({ arm, result })
        run.progress.done++
        await this.skillEvalJobs.touch(run, Date.now())
      }

      // grading(仅对无 error 的输出;全挂就跳过本 case)
      const gradable = armOutputs.filter((a) => !a.result.error)
      if (gradable.length === 0) continue
      run.status = 'grading'
      await this.skillEvalJobs.touch(run, Date.now())
      // 匿名化 + 随机顺序(盲测防位置偏好)。label→arm 映射只在本进程内存。
      const shuffled = [...gradable].sort(() => Math.random() - 0.5)
      const labels = ['A', 'B', 'C']
      const graderArms: GraderArmInput[] = shuffled.map((a, i) => ({
        label: labels[i],
        output: a.result.output,
      }))
      try {
        const { text: gradeText, usage: gradeUsage } = await this._skillEvalTurn(
          `skilleval:${run.runId}:grade:${c.id}`,
          run.userId,
          buildGraderPrompt(c, graderArms, {
            wantPreference: run.mode === 'draft' && gradable.length >= 2,
          }),
          run.model,
          {},
        )
        addUsage(run.usage, gradeUsage)
        const parsed = parseGraderJson(gradeText)
        if (!parsed) {
          for (const a of gradable) a.result.error = 'grader output unparseable'
        } else {
          shuffled.forEach((a, i) => {
            a.result.assertions = gradesToAssertions(c, parsed.grades[labels[i]])
          })
          if (parsed.preference && run.mode === 'draft') {
            const idx = parsed.preference === 'tie' ? -1 : labels.indexOf(parsed.preference)
            if (idx === -1) preferences.push('tie')
            else preferences.push(shuffled[idx]?.arm === 'draft' ? 'draft' : 'current')
          }
        }
      } catch (err) {
        for (const a of gradable) a.result.error = `grading failed: ${String(err)}`
      }
      run.status = 'running'
      await this.skillEvalJobs.touch(run, Date.now())
    }

    const benchmark = computeBenchmark(run.results, {
      draftMode: run.mode === 'draft',
      preferences,
    })
    await this.skillEvalJobs.finish(run, Date.now(), { benchmark })

    // 可写技能:落 evals/last-run.json 摘要(面板即开即见;draft 模式不写 —— 未合并)。
    if (run.mode === 'baseline') {
      const store = buildUserSkillStore()
      await store
        .saveAuxFile(
          run.skillName,
          'evals/last-run.json',
          `${JSON.stringify(
            {
              runId: run.runId,
              mode: run.mode,
              finishedAt: run.finishedAt,
              benchmark,
              usage: run.usage,
            },
            null,
            2,
          )}\n`,
        )
        .catch(() => {})
    }

  }

  // ── P3:技能每日自动回归(opt-in)────────────────────────────────────────
  private _skillRegressionTimer: ReturnType<typeof setInterval> | null = null

  private _startSkillAutoRegression(): void {
    // 检查间隔 1h(可 env 缩短供 e2e),真正执行按「距上次 ≥22h」判定 —— 每技能每日至多一轮。
    const checkMs = Number(process.env.OC_SKILL_REGRESSION_CHECK_MS) || 60 * 60 * 1000
    const minGapMs = Number(process.env.OC_SKILL_REGRESSION_MIN_GAP_MS) || 22 * 60 * 60 * 1000
    this._skillRegressionTimer = setInterval(() => {
      void this._skillAutoRegressionTick(minGapMs).catch((err) =>
        this.log.warn('skill auto-regression tick failed', {}, err),
      )
    }, checkMs)
    this._skillRegressionTimer.unref?.()
  }

  private async _skillAutoRegressionTick(minGapMs: number): Promise<void> {
    const stampPath = join(paths.skillEvalsDir, 'auto-regression.json')
    let stamps: Record<string, number> = {}
    try {
      stamps = JSON.parse(await readFile(stampPath, 'utf-8')) as Record<string, number>
    } catch {}
    const store = buildUserSkillStore()
    const skills = await store.list({ includePlatform: false }).catch(() => [])
    for (const sk of skills) {
      if (!sk?.name) continue
      const raw = await store.view(sk.name, 'evals/evals.json', { includePlatform: false })
      if (typeof raw !== 'string') continue
      const parsed = parseSkillEvalsJson(raw)
      if (!parsed.ok || parsed.file.autoRegression !== true) continue
      const last = stamps[sk.name] ?? 0
      if (Date.now() - last < minGapMs) continue
      if (!this.skillEvalJobs.canStart(sk.name).ok) continue

      // 记录上一次通过率(回归对比基线);本轮结果由 _runSkillEval 写回 last-run.json。
      let prevWith: number | null = null
      const prevRaw = await store.view(sk.name, 'evals/last-run.json', { includePlatform: false })
      if (typeof prevRaw === 'string') {
        try {
          const prev = JSON.parse(prevRaw) as { benchmark?: { passRate?: { with?: number } } }
          prevWith = prev.benchmark?.passRate?.with ?? null
        } catch {}
      }

      stamps[sk.name] = Date.now()
      await mkdir(paths.skillEvalsDir, { recursive: true }).catch(() => {})
      await writeFile(stampPath, JSON.stringify(stamps, null, 2)).catch(() => {})

      const run = await this.skillEvalJobs.create({
        runId: SkillEvalJobStore.newRunId(),
        skillName: sk.name,
        userId: 'default',
        mode: 'baseline',
        model: SKILL_TRAIN_DEFAULT_MODEL,
        cases: parsed.file.cases,
        now: Date.now(),
      })
      try {
        await this._runSkillEval(run, {})
      } catch (err) {
        await this.skillEvalJobs.finish(run, Date.now(), { error: String(err) })
      }

      const b = run.benchmark
      const withRate = b?.passRate?.with
      const failed = run.status === 'failed'
      const regressed =
        failed ||
        (b?.verdict ?? '').includes('反而更差') ||
        (prevWith !== null && withRate !== undefined && withRate < prevWith - 0.05)
      if (!regressed) continue

      // 推送提醒(不自动改技能、不自动开训练 —— 修复动作由用户在管理中心发起)。
      const pct = (x?: number | null) => (x == null ? '?' : `${Math.round(x * 100)}%`)
      const lines = [
        failed
          ? `自动回归运行失败:${run.error ?? '未知错误'}`
          : `断言通过率 ${pct(prevWith)} → ${pct(withRate)}${b?.verdict ? `(${b.verdict})` : ''}`,
        `本次回归消耗:输入 ${run.usage.inputTokens.toLocaleString()} / 输出 ${run.usage.outputTokens.toLocaleString()} tokens(${run.usage.turns} 轮,实际扣费以账单为准)`,
        '建议:打开 管理中心 → 技能 → 该技能 → 训练优化,让 AI 基于失败结果起草改进(草稿经你确认才会合并)。',
        '不再需要提醒可在 管理中心 → 技能 → 评测 里关闭「每日自动回归」。',
      ]
      await this.cron
        ?.deliverNotice(lines.join('\n'), {
          id: `skill-regression-${sk.name}`,
          schedule: '0 0 * * *',
          agent: 'main',
          prompt: '',
          deliver: 'webchat',
          enabled: true,
          label: `技能回归提醒:${sk.name}`,
        })
        .catch(() => {})
    }
  }

  // ── SkillOpt skill-training (async; train → diff → confirm-merge) ──

  /** The agent that runs training sessions (default 'main', else the first agent). */
  private async _trainingAgent() {
    const cfg = await this._getAgentsConfig()
    return cfg.agents.find((a) => a.id === 'main') ?? cfg.agents[0] ?? null
  }

  /**
   * Resolve a run-scoped request: the run must exist AND be owned by the caller.
   * Sends 404/403 and returns null on failure. Every run-scoped endpoint (status,
   * drafts, diff, comment, merge, discard) gates on this so a leaked runId cannot be
   * read or mutated across users.
   */
  private _ownedTrainRun(
    req: IncomingMessage,
    res: ServerResponse,
    runId: string,
  ): SkillTrainRun | null {
    const run = this.skillTrainJobs.get(runId)
    if (!run) {
      this.sendError(res, 404, 'training run not found')
      return null
    }
    if (run.userId !== this.getUserId(req)) {
      this.sendError(res, 403, 'forbidden')
      return null
    }
    return run
  }

  /**
   * Fold a training session's stream event into the run state. On the agent's `final`
   * event the terminal state is resolved from the ACTUAL staged-draft count (source of
   * truth), not the proposal-call count; other events flow through applyEvent.
   */
  private _onTrainEvent(runId: string, e: SessionStreamEvent): void {
    if (e.kind === 'final') {
      void this.skillTrainJobs.addUsage(runId, e.meta, Date.now())
      void this.skillDrafts
        .listDrafts(runId)
        .then(async (d) => {
          await this.skillTrainJobs.finalize(runId, d.length, Date.now())
          // 评测门(P1):产出草稿且用户启动时同意 autoEval → 自动对目标技能草稿跑
          // draft vs 现版评测。成本已在训练确认对话框中披露(autoEval 开关 + 估算)。
          if (d.length > 0) void this._maybeAutoEvalTrainRun(runId)
        })
        .catch(() => {})
      return
    }
    void this.skillTrainJobs.applyEvent(runId, e, Date.now())
  }

  /** 训练完成后的评测门:仅单技能训练 + autoEval + 有可用用例(草稿附带或技能自带)。 */
  private async _maybeAutoEvalTrainRun(trainRunId: string): Promise<void> {
    const tr = this.skillTrainJobs.get(trainRunId)
    if (!tr || !tr.autoEval || !tr.skillName) return
    const draft = await this.skillDrafts.readDraft(trainRunId, tr.skillName).catch(() => null)
    if (!draft || draft.record.op === 'delete') return
    const store = buildUserSkillStore()
    let evalsRaw =
      draft.evalsJson ??
      ((await store.view(tr.skillName, 'evals/evals.json', { includePlatform: false })) as
        | string
        | null)
    if (typeof evalsRaw !== 'string' || !evalsRaw) return // 无用例 → 不评(前端提示补用例)
    const parsed = parseSkillEvalsJson(evalsRaw)
    if (!parsed.ok) return
    const guard = this.skillEvalJobs.canStart(tr.skillName)
    if (!guard.ok) return
    const run = await this.skillEvalJobs.create({
      runId: SkillEvalJobStore.newRunId(),
      skillName: tr.skillName,
      userId: tr.userId,
      mode: 'draft',
      trainRunId,
      model: SKILL_TRAIN_DEFAULT_MODEL,
      cases: parsed.file.cases,
      now: Date.now(),
    })
    await this.skillTrainJobs.setEvalRunId(trainRunId, run.runId, Date.now())
    void this._runSkillEval(run, {
      draftDir: join(paths.skillDraftRunDir(trainRunId), tr.skillName),
    }).catch((err) => {
      void this.skillEvalJobs.finish(run, Date.now(), { error: String(err) })
    })
  }

  // POST /api/skills/:name/train — start an async DeepSeek training run for ONE
  // user-authored skill. Returns a runId immediately; progress via GET status.
  private async _handleSkillTrainStart(
    req: IncomingMessage,
    res: ServerResponse,
    skillName: string,
  ): Promise<void> {
    if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
    const userId = this.getUserId(req)

    // Authority: only train user-authored skills. Use the user-management view so a
    // platform baseline/seed name resolves to 404 (same as a nonexistent skill) instead
    // of 403 — otherwise the 403/404 split would be an existence oracle for the
    // (otherwise hidden) platform skill catalog.
    const userStore = buildUserSkillStore()
    const current = await userStore.view(skillName, undefined, { includePlatform: false })
    if (!current || typeof current === 'string') return this.sendError(res, 404, 'skill not found')

    const guard = this.skillTrainJobs.canStart(skillName)
    if (!guard.ok) return this.sendError(res, 409, guard.reason ?? 'cannot start training')

    const agent = await this._trainingAgent()
    if (!agent) return this.sendError(res, 500, 'no agent available for training')

    const body = await this.readJsonBody<{ focus?: string; autoEval?: boolean }>(req).catch(
      () => ({}) as { focus?: string; autoEval?: boolean },
    )
    const runId = SkillTrainJobStore.newRunId()
    const opts = normalizeSkillTrainArgs(
      { runId, targetSkill: skillName, focus: body?.focus },
      agent.id,
    )
    await this.skillTrainJobs.create({
      runId,
      skillName,
      agentId: agent.id,
      userId,
      model: SKILL_TRAIN_DEFAULT_MODEL,
      effort: SKILL_TRAIN_EFFORT,
      autoEval: body?.autoEval !== false,
      now: Date.now(),
    })

    // Background session bound to this run (skillTrainRunId exposes skill_propose).
    const session = await this.sessions.getOrCreate({
      sessionKey: `skilltrain:${runId}`,
      agent,
      channel: 'skill-train',
      peerId: runId,
      userId,
      effortLevel: SKILL_TRAIN_EFFORT,
      skillTrainRunId: runId,
    })
    // Fire-and-forget: fold stream events into the run state; don't block the HTTP reply.
    void this.sessions
      .submit(
        session,
        buildSkillTrainPrompt(opts),
        (e) => this._onTrainEvent(runId, e),
        SKILL_TRAIN_EFFORT,
        SKILL_TRAIN_DEFAULT_MODEL,
        runId,
      )
      .catch((err) => {
        void this.skillTrainJobs.setStatus(runId, 'failed', Date.now(), String(err))
      })
    this.sendJson(res, 202, { ok: true, runId })
  }

  // GET /api/skill-training/:runId — run status. DELETE — discard run + its drafts.
  private async _handleSkillTrainRun(
    req: IncomingMessage,
    res: ServerResponse,
    runId: string,
  ): Promise<void> {
    const run = this._ownedTrainRun(req, res, runId)
    if (!run) return
    if (req.method === 'GET') {
      this.sendJson(res, 200, { run })
      return
    }
    if (req.method === 'DELETE') {
      await this.skillDrafts.deleteRun(runId)
      await this.skillTrainJobs.setStatus(runId, 'discarded', Date.now())
      this.skillTrainJobs.forget(runId)
      this.sendJson(res, 200, { ok: true })
      return
    }
    this.sendError(res, 405, 'method not allowed')
  }

  // GET /api/skill-training/:runId/drafts — list staged draft summaries.
  private async _handleSkillTrainDrafts(
    req: IncomingMessage,
    res: ServerResponse,
    runId: string,
  ): Promise<void> {
    if (req.method !== 'GET') return this.sendError(res, 405, 'method not allowed')
    if (!this._ownedTrainRun(req, res, runId)) return
    const drafts = await this.skillDrafts.listDrafts(runId)
    this.sendJson(res, 200, { drafts })
  }

  // GET /api/skill-training/:runId/drafts/:name — draft + current authoritative
  // (the two diff sides). PUT — apply a manual user edit to the draft.
  private async _handleSkillTrainDraftItem(
    req: IncomingMessage,
    res: ServerResponse,
    runId: string,
    skillName: string,
  ): Promise<void> {
    if (!this._ownedTrainRun(req, res, runId)) return
    if (req.method === 'GET') {
      const draft = await this.skillDrafts.readDraft(runId, skillName)
      if (!draft) return this.sendError(res, 404, 'draft not found')
      const cur = await buildUserSkillStore().view(skillName, undefined, { includePlatform: false })
      const current =
        cur && typeof cur !== 'string'
          ? { body: cur.body, description: cur.description, version: cur.version }
          : null
      this.sendJson(res, 200, { draft, current })
      return
    }
    if (req.method === 'PUT') {
      const existing = await this.skillDrafts.readDraft(runId, skillName)
      if (!existing) return this.sendError(res, 404, 'draft not found')
      const body = await this.readJsonBody<{
        description?: string
        body?: string
        tags?: string[]
      }>(req)
      const r = await this.skillDrafts.writeDraft({
        runId,
        op: existing.record.op,
        meta: {
          name: skillName,
          description: body.description ?? existing.meta.description,
          tags: body.tags ?? existing.meta.tags,
        },
        body: body.body ?? existing.body,
        authoredBy: 'user',
      })
      if (!r.ok) return this.sendError(res, 400, r.error ?? 'save failed')
      this.sendJson(res, 200, { ok: true })
      return
    }
    this.sendError(res, 405, 'method not allowed')
  }

  // POST /api/skill-training/:runId/drafts/:name/comment — user comment → AI revises
  // the draft by continuing the SAME training session (async; status returns to running).
  private async _handleSkillTrainComment(
    req: IncomingMessage,
    res: ServerResponse,
    runId: string,
    skillName: string,
  ): Promise<void> {
    if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
    const run = this._ownedTrainRun(req, res, runId)
    if (!run) return
    const body = await this.readJsonBody<{ comment: string; lineRange?: string }>(req)
    const comment = (body?.comment ?? '').trim()
    if (!comment) return this.sendError(res, 400, 'comment required')
    const agent = await this._trainingAgent()
    if (!agent) return this.sendError(res, 500, 'no agent available')

    const where = body.lineRange ? ` (lines ${body.lineRange})` : ''
    const revisePrompt = [
      `The user reviewed your draft for skill "${skillName}"${where} and commented:`,
      '',
      comment,
      '',
      `Revise the draft accordingly: re-issue skill_propose (runId="${runId}") with the`,
      'improved content addressing the comment. Keep all prior good content; change only',
      'what the comment asks for.',
    ].join('\n')

    const session = await this.sessions.getOrCreate({
      sessionKey: `skilltrain:${runId}`,
      agent,
      channel: 'skill-train',
      peerId: runId,
      userId: run.userId,
      effortLevel: SKILL_TRAIN_EFFORT,
      skillTrainRunId: runId,
    })
    await this.skillTrainJobs.reopen(runId, Date.now())
    void this.sessions
      .submit(
        session,
        revisePrompt,
        (e) => this._onTrainEvent(runId, e),
        SKILL_TRAIN_EFFORT,
        SKILL_TRAIN_DEFAULT_MODEL,
        runId,
      )
      .catch((err) => {
        void this.skillTrainJobs.setStatus(runId, 'failed', Date.now(), String(err))
      })
    this.sendJson(res, 202, { ok: true, runId })
  }

  // POST /api/skill-training/:runId/merge — promote draft(s) into the AUTHORITATIVE
  // library (the only write to live skills). Body {name?} merges one, else all.
  private async _handleSkillTrainMerge(
    req: IncomingMessage,
    res: ServerResponse,
    runId: string,
  ): Promise<void> {
    if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
    const run = this._ownedTrainRun(req, res, runId)
    if (!run) return
    if (run.status !== 'diff_ready') {
      return this.sendError(res, 409, `run is not ready to merge (status: ${run.status})`)
    }
    const body = await this.readJsonBody<{ name?: string }>(req).catch(
      () => ({}) as { name?: string },
    )
    const all = await this.skillDrafts.listDrafts(runId)
    const targets = body?.name ? all.filter((d) => d.name === body.name) : all
    if (targets.length === 0) return this.sendError(res, 404, 'no drafts to merge')

    const store = buildUserSkillStore()
    const results: Array<{ name: string; ok: boolean; error?: string }> = []
    for (const t of targets) {
      const draft = await this.skillDrafts.readDraft(runId, t.name)
      if (!draft) {
        results.push({ name: t.name, ok: false, error: 'draft vanished' })
        continue
      }
      const r =
        draft.record.op === 'delete'
          ? await store.delete(t.name)
          : await store.save(
              { name: t.name, description: draft.meta.description, tags: draft.meta.tags },
              draft.body,
            )
      // 草稿携带的评测用例随合并落库(evals/evals.json)—— 训练闭环的验收基准。
      if (r.ok && draft.record.op !== 'delete' && draft.evalsJson) {
        await store.saveAuxFile(t.name, 'evals/evals.json', draft.evalsJson).catch(() => {})
      }
      results.push({ name: t.name, ok: r.ok, error: r.error })
      if (r.ok) await this.skillDrafts.deleteDraft(runId, t.name)
    }

    // All drafts consumed → close the run; otherwise leave it for a retry.
    const remaining = await this.skillDrafts.listDrafts(runId)
    if (remaining.length === 0) {
      await this.skillTrainJobs.setStatus(runId, 'merged', Date.now())
      this.skillTrainJobs.forget(runId)
    }
    this.sendJson(res, 200, { ok: results.every((r) => r.ok), results })
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
    if (isHiddenSystemAgentId(targetAgentId)) {
      return this.sendError(res, 404, `agent "${targetAgentId}" not found`)
    }

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
  /** P2 债C/3.5 — 硬编排 review 保留槽:非 review 委派最多用到
   *  (MAX_CONCURRENT_DELEGATIONS − 保留槽),给质量审查留位,消 cron/他会话把并发占满
   *  导致队长的 review delegate 拿不到槽而降级放行。review 委派本身可用满全局上限。 */
  private static DELEGATE_REVIEW_RESERVED_SLOTS = 1
  /** P2 债C/3.5 — 单父会话(队长)并行 fan-out 上限。非 review 委派按父分桶计数,
   *  超上限进排队;review 委派豁免此桶(有独立保留槽)。消"一个队长把 5 个全局槽占光"。
   *  env 可配(下限 1)。 */
  private static get MAX_CONCURRENT_DELEGATIONS_PER_PARENT(): number {
    const raw = Number(process.env.OPENCLAUDE_DELEGATE_MAX_PER_PARENT)
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3
  }
  private _activeDelegationsByParent = new Map<string, Set<string>>()
  /** P2 债C/3.5 — 每父会话**运行中**(已过闸、占槽)的非 review 委派计数,per-parent 并发
   *  分桶的权威。区别于 _activeDelegationsByParent(那是含排队中的 childSessionKey Set,
   *  供 Stop 级联);本 Map 只在 slot 预占/释放时同步增减,是"运行中"的精确计数。
   *  测试脚手架 Object.create(Gateway.prototype) 不跑字段初始化,使用处惰性 ??=
   *  (同 _delegateQueueWaiters)。 */
  private _runningDelegationsByParent: Map<string, number> | undefined
  /** P2 债C — 本 turn 发生过**非隐藏**委派的父(队长)webchat sessionKey 集合。
   *  硬编排 review pass 据此判定"本 turn 是否实际组队"→ 决定队长 final 放行前是否触发审查。
   *  turn 起始清零(与 _hiddenDelegateGuard.resetForParent 同点),_runDelegateTask 里对
   *  非隐藏 + webchat 父的委派置位。使用处惰性 ??=(同上)。 */
  private _turnDelegatedNonHiddenByParent: Set<string> | undefined
  /** hidden 审查员串行委派熔断(见 HiddenDelegateGuard 注释)。gateway 是容器内
   *  单进程,内存计数即权威。 */
  private _hiddenDelegateGuard = new HiddenDelegateGuard()
  /** 资源闸排队中的委派:childSessionKey → 中止等待回调。用户 Stop 级联
   *  (_interruptDelegationsForParent)对"还没 spawn、只在排队"的委派经此打断。
   *  测试脚手架 Object.create(Gateway.prototype) 不跑字段初始化,使用处惰性 ??=。 */
  private _delegateQueueWaiters: Map<string, () => void> | undefined
  /** 排队复查间隔;测试覆写加速,生产走 DELEGATE_QUEUE_POLL_DEFAULT_MS。 */
  private _delegateQueuePollMs: number | undefined

  /** 内存水位读取的实例挂钩:生产=模块级 readDelegateMemoryPressure(cgroup 文件),
   *  测试直接覆写本方法注入假读数。 */
  private _readDelegateMemoryPressure(): { current: number; max: number; ratio: number } | null {
    return readDelegateMemoryPressure()
  }

  /** 两道资源闸共用的判定。并发在前 —— 与历史行为的拒绝优先级一致
   *  (旧代码并发 429 判在内存 503 之前)。
   *
   *  P2 债C/3.5 — 分桶 + review 保留槽:
   *   - 全局:review 委派可用满 MAX;非 review 委派最多用到 MAX − 保留槽,给审查留位。
   *   - per-parent:非 review 委派按父分桶计数,单父超上限即 concurrency block(进排队);
   *     review 委派豁免此桶(它有独立保留槽,不受某父 fan-out 挤占)。
   *   缺 parentBucketKey(cron/webhook 父不在内存)→ 只受全局闸,不分桶(与既有行为一致)。 */
  private _checkDelegateResourceGate(opts?: {
    parentBucketKey?: string
    isReview?: boolean
  }): DelegateGateBlock | null {
    const isReview = opts?.isReview === true
    const globalCap = isReview
      ? Gateway.MAX_CONCURRENT_DELEGATIONS
      : Gateway.MAX_CONCURRENT_DELEGATIONS - Gateway.DELEGATE_REVIEW_RESERVED_SLOTS
    if (this._activeDelegations >= globalCap) {
      return { kind: 'concurrency' }
    }
    if (!isReview && opts?.parentBucketKey) {
      const running = (this._runningDelegationsByParent ??= new Map()).get(opts.parentBucketKey) ?? 0
      if (running >= Gateway.MAX_CONCURRENT_DELEGATIONS_PER_PARENT) {
        return { kind: 'concurrency' }
      }
    }
    const pressure = this._readDelegateMemoryPressure()
    const limit = parseDelegateMemoryPressureRatio()
    if (pressure && pressure.ratio >= limit) {
      return {
        kind: 'memory',
        pct: Math.round(pressure.ratio * 100),
        limitPct: Math.round(limit * 100),
      }
    }
    return null
  }

  /** 预占一个并发名额(判定+自增在同一同步段,单线程下原子,等待者间无超发);
   *  被闸拦截则返回原因、不占名额。P2 债C:非 review + 有父桶 → 同步 bump per-parent 运行计数。 */
  private _tryReserveDelegateSlot(opts?: {
    parentBucketKey?: string
    isReview?: boolean
  }): DelegateGateBlock | null {
    const blocked = this._checkDelegateResourceGate(opts)
    if (blocked) return blocked
    this._activeDelegations++
    if (opts && !opts.isReview && opts.parentBucketKey) {
      const m = (this._runningDelegationsByParent ??= new Map())
      m.set(opts.parentBucketKey, (m.get(opts.parentBucketKey) ?? 0) + 1)
    }
    return null
  }

  /** 释放一个已预占的并发名额(全局 + per-parent)。所有过闸后的路径必须经此释放,
   *  与 _tryReserveDelegateSlot 的增量口径严格对称(否则 per-parent 计数漂移锁死后续委派)。 */
  private _releaseDelegateSlot(opts?: {
    parentBucketKey?: string
    isReview?: boolean
  }): void {
    this._activeDelegations--
    if (opts && !opts.isReview && opts.parentBucketKey) {
      const m = (this._runningDelegationsByParent ??= new Map())
      const cur = m.get(opts.parentBucketKey) ?? 0
      if (cur <= 1) m.delete(opts.parentBucketKey)
      else m.set(opts.parentBucketKey, cur - 1)
    }
  }

  /**
   * delegate 资源闸有界排队:命中「并发 ≥ 上限」或「内存 ≥ 阈值」→ 轮询复查等待
   * 放行,而非立即 429/503(历史实况:并行 fanout 同秒双拒,队长收 503 后放弃委派
   * 自己兜底)。放行时已同步预占并发名额,调用方所有后续路径必须负责释放。
   *
   * 溯源:P5(f7453f4d)曾为旧重团队轨实现过"撞闸排队"(teamRunStore DB FIFO 队列),
   * 07-02 双轨清理(1ca107a8)删除旧 team_run 子系统时**连带**删除(非有意废弃)。
   * 本实现改为进程内等待收口:gateway 是容器内单进程,内存计数即权威,无需 DB 队列,
   * 且对所有 delegate(普通成员/hidden 审查员/嵌套)统一生效。
   *
   * 边界:
   * - 等待封顶 OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS(默认 90s)→ 'timeout';
   * - 排队人数封顶 DELEGATE_QUEUE_MAX_WAITERS(8,防雪崩)→ 'queue_full'(不等待);
   * - 用户 Stop 级联经 _delegateQueueWaiters 回调即时唤醒 → 'aborted';
   * - 无放行顺序保证(非 FIFO):等待者靠轮询抢占,依赖公平性的场景目前不存在。
   */
  private async _waitForDelegateCapacity(args: {
    sessionKey: string
    /** P2 债C/3.5 — per-parent 分桶键(队长会话 sessionKey);缺省 → 只走全局闸。 */
    parentBucketKey?: string
    /** P2 债C — review 委派:走保留槽、豁免 per-parent 桶。 */
    isReview?: boolean
    onQueued?: (blocked: DelegateGateBlock) => void
  }): Promise<
    | { status: 'ok' }
    | { status: 'queue_full'; blocked: DelegateGateBlock }
    | { status: 'timeout'; blocked: DelegateGateBlock; waitedMs: number }
    | { status: 'aborted'; waitedMs: number }
  > {
    const reserveOpts = { parentBucketKey: args.parentBucketKey, isReview: args.isReview }
    const first = this._tryReserveDelegateSlot(reserveOpts)
    if (!first) return { status: 'ok' }
    const waiters = (this._delegateQueueWaiters ??= new Map())
    if (waiters.size >= DELEGATE_QUEUE_MAX_WAITERS) {
      return { status: 'queue_full', blocked: first }
    }
    const waitBudgetMs = parseDelegateQueueWaitMs()
    const pollMs = Math.max(1, this._delegateQueuePollMs ?? DELEGATE_QUEUE_POLL_DEFAULT_MS)
    const startedAt = Date.now()
    let aborted = false
    let wake: (() => void) | null = null
    waiters.set(args.sessionKey, () => {
      aborted = true
      wake?.()
    })
    try {
      args.onQueued?.(first)
      let lastBlocked = first
      while (true) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wake = null
            resolve()
          }, pollMs)
          wake = () => {
            clearTimeout(timer)
            wake = null
            resolve()
          }
        })
        if (aborted || this._shuttingDown) {
          return { status: 'aborted', waitedMs: Date.now() - startedAt }
        }
        const blocked = this._tryReserveDelegateSlot(reserveOpts)
        if (!blocked) return { status: 'ok' }
        lastBlocked = blocked
        if (Date.now() - startedAt >= waitBudgetMs) {
          return { status: 'timeout', blocked: lastBlocked, waitedMs: Date.now() - startedAt }
        }
      }
    } finally {
      waiters.delete(args.sessionKey)
    }
  }

  /**
   * 解析委派进度路由:沿父链向上追溯到最近的 webchat 祖先会话(取代旧的「父非 webchat
   * 即 null」——那会让二级+嵌套委派的进度整段丢弃,一级卡长时间无进展)。
   *
   * 返回 `DelegateProgressRouting`:
   *   - `target` 与旧实现在**一级(直接 webchat 父)**场景下完全一致 → `.target` 即旧返回值;
   *   - `nested` / `firstLevelRunId` / `ancestorAgentPath` 供 handleDelegateTask 把嵌套进度以
   *     既有帧形态挂到用户可见的**一级**委派卡上(见 toNestedDelegateProgressLine)。
   *
   * 追溯纯逻辑在 resolveDelegateProgressRouting(delegateProgress.ts,可单测);本方法只做
   * SessionManager → 追溯所需最小会话视图的适配。断链/环/超深一律返回 null(丢弃,不抛错)。
   */
  private _resolveDelegateProgressTarget(args: {
    parentSessionKey?: unknown
    sourceAgent?: unknown
  }): DelegateProgressRouting | null {
    return resolveDelegateProgressRouting({
      parentSessionKey: args.parentSessionKey,
      sourceAgent: args.sourceAgent,
      maxDepth: 5,
      getSession: (key) => {
        const s = this.sessions.getByKey(key)
        if (!s) return undefined
        return {
          sessionKey: s.sessionKey,
          channel: s.channel,
          peerId: s.peerId,
          agentId: s.agentId,
          userId: s.userId,
          parentSessionKey: s.parentSessionKey,
          progressRunId: s.progressRunId,
        }
      },
    })
  }

  private _resolveDelegateParent(args: {
    parentSessionKey?: unknown
    sourceAgent?: unknown
  }): { sessionKey: string; repoSessionId?: string } | null {
    if (typeof args.parentSessionKey !== 'string' || !args.parentSessionKey) return null
    const parent = this.sessions.getByKey(args.parentSessionKey)
    if (!parent) return null
    if (parent.channel !== 'webchat' && parent.channel !== 'delegate') return null
    if (typeof args.sourceAgent === 'string' && args.sourceAgent && parent.agentId !== args.sourceAgent) {
      return null
    }
    return {
      sessionKey: parent.sessionKey,
      repoSessionId: parent.repoSessionId ?? parent.peerId,
    }
  }

  private _registerActiveDelegation(
    parentSessionKey: string | undefined,
    childSessionKey: string,
  ): (() => void) | null {
    if (!parentSessionKey) return null
    let set = this._activeDelegationsByParent.get(parentSessionKey)
    if (!set) {
      set = new Set<string>()
      this._activeDelegationsByParent.set(parentSessionKey, set)
    }
    set.add(childSessionKey)
    return () => {
      const current = this._activeDelegationsByParent.get(parentSessionKey)
      if (!current) return
      current.delete(childSessionKey)
      if (current.size === 0) this._activeDelegationsByParent.delete(parentSessionKey)
    }
  }

  private _interruptDelegationsForParent(
    parentSessionKey: string,
    visited = new Set<string>(),
  ): boolean {
    if (visited.has(parentSessionKey)) return false
    visited.add(parentSessionKey)
    const childSessionKeys = this._activeDelegationsByParent.get(parentSessionKey)
    if (!childSessionKeys || childSessionKeys.size === 0) return false

    let interrupted = false
    let attempted = 0
    for (const childSessionKey of [...childSessionKeys]) {
      attempted++
      const descendantInterrupted = this._interruptDelegationsForParent(childSessionKey, visited)
      // 还在资源闸排队等待的委派(尚未 spawn,session 不存在):唤醒并中止其等待,
      // 否则 Stop 级联对它不可达,要干等到排队超时。
      const abortQueuedWait = this._delegateQueueWaiters?.get(childSessionKey)
      if (abortQueuedWait) {
        abortQueuedWait()
        childSessionKeys.delete(childSessionKey)
        interrupted = true
        continue
      }
      if (!this.sessions.getByKey(childSessionKey)) {
        childSessionKeys.delete(childSessionKey)
        interrupted = descendantInterrupted || interrupted
        continue
      }
      interrupted = this.sessions.interrupt(childSessionKey) || descendantInterrupted || interrupted
    }
    if (childSessionKeys.size === 0) this._activeDelegationsByParent.delete(parentSessionKey)
    this.log.info('interrupt_delegations', {
      parentSessionKey,
      attempted,
      ok: interrupted,
    })
    return interrupted
  }

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
    const depthHeader = req.headers['x-delegation-depth']
    const depth = depthHeader ? Number.parseInt(String(depthHeader), 10) : 0

    // HTTP 入口:解析 body → 结构化 input → _runDelegateTask 核心 → 结果映射回 res。
    // 委派执行核心与 HTTP req/res 解耦(P2 债C),让 gateway 硬编排 review pass
    // (dispatchInbound)能内部直调同一委派路径拿到结构化结果(verdict/output),
    // 无需伪造 req/res。
    const result = await this._runDelegateTask({
      targetAgentId,
      goal,
      context: typeof context === 'string' ? context : undefined,
      sourceAgent: typeof sourceAgent === 'string' ? sourceAgent : undefined,
      toolsets,
      parentSessionKey:
        typeof parsed.parentSessionKey === 'string' ? parsed.parentSessionKey : undefined,
      streamProgress: parsed.streamProgress === true,
      depth,
    })
    if (result.kind === 'rejected') return this.sendError(res, result.httpStatus, result.message)
    if (result.kind === 'error') return this.sendError(res, 500, result.message)
    return this.sendJson(res, 200, {
      ok: result.ok,
      agentId: targetAgentId,
      output: result.output,
      error: result.error || undefined,
    })
  }

  /**
   * P2 债C — handleDelegateTask 的 HTTP-无关委派执行核心。
   *
   * 承接原 handleDelegateTask 的全部执行逻辑(深度/熔断/资源闸有界排队/session 创建/
   * submit/timeout/进度回传/团队卡缓冲),但以结构化 {@link RunDelegateInput} 入、
   * {@link DelegateTaskResult} 出,不碰 req/res。两个调用方:
   *   1. handleDelegateTask —— HTTP 委派端点(队长/成员经 delegate_task MCP 工具);
   *   2. dispatchInbound 的硬编排 review pass —— 队长 final 放行前直调,isReview:true。
   *
   * `isReview` 语义:走资源闸保留槽 + 免 per-parent 桶(审查不受某父 fan-out 挤占);
   * runLog 打 isReview;完成后从审查输出解析结构化 verdict 一并回带 + 落团队卡。
   */
  private async _runDelegateTask(input: RunDelegateInput): Promise<DelegateTaskResult> {
    const { targetAgentId, goal, context, sourceAgent, toolsets, depth } = input
    const isReview = input.isReview === true
    const parentSessionKey = input.parentSessionKey

    // Recursion guard: 深度闸必须先于资源闸(超深嵌套是硬错误,不进排队/不占等待名额)。
    if (depth >= 3) {
      return { kind: 'rejected', httpStatus: 400, message: 'delegation depth limit exceeded (max 3)' }
    }

    // Serial guard: hidden 系统 agent(隐藏审查员)同一父 turn 内委派次数硬上限。
    // 计数键优先取 parentSessionKey(delegate 请求里唯一的父上下文,turn 级标识
    // 拿不到 —— 依据见 HiddenDelegateGuard 注释);极端情况下 body 缺
    // parentSessionKey 时退化为按 sourceAgent 计数,由 TTL 清扫兜底回收。
    // 失败/超时的审查同样占额度:每次尝试都是全额计费的 delegate session。
    // 本闸同样先于资源闸排队:per-turn 额度等不出来,fail fast 不占等待名额;
    // 代价是"排队超时"的审查委派也已扣一次额度(保守偏置,与上一行语义一致)。
    if (isHiddenSystemAgentId(targetAgentId)) {
      const guardKey =
        typeof parentSessionKey === 'string' && parentSessionKey
          ? parentSessionKey
          : `delegate-src:${typeof sourceAgent === 'string' && sourceAgent ? sourceAgent : 'system'}`
      if (!this._hiddenDelegateGuard.tryAcquire(guardKey)) {
        this.log.warn('delegate_hidden_limit', {
          targetAgentId,
          guardKey,
          limit: MAX_HIDDEN_DELEGATIONS_PER_TURN,
        })
        return {
          kind: 'rejected',
          httpStatus: 429,
          message: `审查委派已达本轮上限(${MAX_HIDDEN_DELEGATIONS_PER_TURN}次),请基于已有审查结论收尾,不要再发起新的审查委派`,
        }
      }
    }

    // Find target agent
    const cfg = await this._getAgentsConfig()
    const targetAgent = cfg.agents.find((a) => a.id === targetAgentId)
    if (!targetAgent) return { kind: 'rejected', httpStatus: 404, message: `agent "${targetAgentId}" not found` }

    // Resolve the delegated member's toolsets the same way the normal message
    // path does: member baseline + on-demand grant (task intent on goal/context)
    // + the leader's explicit `toolsets` as an additive grant of DEFINED toolsets
    // only. This is never fatal — an unknown or non-intersecting request degrades
    // to the merged baseline instead of aborting the whole delegation (the old
    // empty-intersection hard-400 that surfaced as "delegate toolsets not allowed
    // for agent …"). Escalation to "all tools" stays impossible: a configured
    // baseline is only ever extended with toolsets defined in config.toolsets.
    // Security cap (RFC D2.7): the sub-agent's toolsets can never exceed the
    // CALLER's. sourceAgent is injected from OPENCLAUDE_AGENT_ID (trusted, not
    // tool-arg controlled), so a marketplace agent can't spoof a privileged caller.
    // An undefined caller toolset = the trusted platform default (main) → no cap.
    const callerAgent =
      typeof sourceAgent === 'string' ? cfg.agents.find((a) => a.id === sourceAgent) : undefined
    const callerToolsets = Array.isArray(callerAgent?.toolsets) ? callerAgent.toolsets : undefined
    const delegateIntentText = [goal, context].filter(Boolean).join('\n')
    const resolvedToolsets = resolveDelegateToolsets(
      targetAgent,
      this.deps.config,
      toolsets,
      delegateIntentText,
      callerToolsets,
    )
    const delegatedAgent =
      resolvedToolsets === undefined ? targetAgent : { ...targetAgent, toolsets: resolvedToolsets }

    const sessionKey = `agent:${targetAgentId}:delegate:${sourceAgent || 'system'}:${Date.now()}`
    this.log.info('delegate', {
      sourceAgent,
      targetAgentId,
      goalPreview: goal.slice(0, 60),
      depth,
    })

    const progressRouting = this._resolveDelegateProgressTarget({
      parentSessionKey,
      sourceAgent,
    })
    // 进度投递目标 = 最近的 webchat 祖先(一级时即直接 webchat 父,值与旧实现一致)。
    const progressTarget = progressRouting?.target ?? null
    // 嵌套(二级+):直接父是 delegate 会话 → 进度要挂到用户可见的一级委派卡,而非
    // 另开一张卡或(旧行为)整段丢弃。
    const nestedProgress = progressRouting?.nested === true
    const delegateParent = this._resolveDelegateParent({
      parentSessionKey,
      sourceAgent,
    })
    // delegate 计费归因:父**客户端**会话 id(web-*)优先,拿不到才落容器内部
    // parentSessionKey(解析链见 resolveDelegateParentClientSessionId JSDoc)。
    // 随 usageAttribution → runner CLAUDE_CODE_EXTRA_METADATA env → master 计费点
    // 落 usage_records.mode='delegate' / parent_session_id / delegate_agent_id,
    // hidden-reviewer 与嵌套 delegate 同路径打标。
    const parentClientSessionId = resolveDelegateParentClientSessionId({
      progressPeerId: progressTarget?.peerId,
      parentRepoSessionId: delegateParent?.repoSessionId,
      parentSessionKey,
    })

    const progressRunId = `dlg-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
    // 嵌套帧复用**一级**委派卡的 runId,把二级进度 append 回用户可见的那张卡;拿不到
    // 一级 runId(如一级未开进度)时退回本委派自身 runId → 独立进度卡兜底(仍可见,不丢)。
    const emitProgressRunId =
      nestedProgress && progressRouting?.firstLevelRunId
        ? progressRouting.firstLevelRunId
        : progressRunId
    // 层级前缀「一级名↳…↳本级名」,给嵌套文本行打标,让用户区分「子 agent 的子委派」。
    const nestLabel = nestedProgress
      ? [...(progressRouting?.ancestorAgentPath ?? []), targetAgentId].join('↳')
      : ''
    const emitProgress = (block: DelegateProgressBlock | null) => {
      if (!progressTarget || !block) return
      // 嵌套:把本委派的原始进度帧统一重写成「挂到一级卡上的带层级前缀非终态文本行」
      // (done/error 也降为 text,避免嵌套子委派的终态帧提前关掉一级卡)。返回 null → 丢弃。
      const outBlock = nestedProgress
        ? toNestedDelegateProgressLine(block, {
            runId: emitProgressRunId,
            agentId: targetAgentId,
            label: nestLabel,
          })
        : block
      if (!outBlock) return
      const out = {
        type: 'outbound.message' as const,
        sessionKey: progressTarget.sessionKey,
        channel: progressTarget.channel,
        peer: { id: progressTarget.peerId, kind: 'dm' as const },
        blocks: [outBlock as any],
        isFinal: false,
        _userId: progressTarget.userId,
      }
      this.deliver(out as OutboundMessage & { _userId?: string })
    }
    const streamProgress = progressTarget && input.streamProgress === true

    // P2 债C/3.5 — per-parent 分桶键 = 队长(父)会话 sessionKey(仅父在内存 webchat/delegate
    // 时非空;cron/webhook 父 null → 只受全局闸)。review 委派豁免分桶、走保留槽。slotOpts 是
    // 预占/释放的对称口径,过闸后所有释放路径必须用它(否则 per-parent 运行计数漂移锁死)。
    const parentBucketKey = delegateParent?.sessionKey
    const slotOpts = { parentBucketKey, isReview }

    // ── 资源闸有界排队(并发上限 + 内存水位共用 _waitForDelegateCapacity 收口)──
    // 父→子注册必须先于等待:排队期间用户 Stop 级联(_interruptDelegationsForParent)
    // 才能经 _delegateQueueWaiters 回调打断等待(此时子 session 尚不存在)。
    const unregisterDelegation = this._registerActiveDelegation(
      delegateParent?.sessionKey,
      sessionKey,
    )
    let queuedNoticeSent = false
    const gate = await this._waitForDelegateCapacity({
      sessionKey,
      parentBucketKey,
      isReview,
      onQueued: (blocked) => {
        this.log.info('delegate_queue_wait', {
          targetAgentId,
          reason: blocked.kind,
          waiters: this._delegateQueueWaiters?.size ?? 0,
          depth,
        })
        // 复用既有 delegate progress 通道:start 帧带 goal,前端把这张卡挂回队长的
        // delegate_task 工具卡;排队文案让用户看到"在排队"而不是无声卡住。
        if (streamProgress) {
          queuedNoticeSent = true
          emitProgress(
            makeDelegateProgressBlock({
              runId: progressRunId,
              agentId: targetAgentId,
              phase: 'start',
              text: `排队中:容器资源紧张(${blocked.kind === 'memory' ? '内存水位' : '并发已满'}),等待放行…`,
              goal,
            }),
          )
        }
      },
    })
    if (gate.status !== 'ok') {
      unregisterDelegation?.()
      const waitedS = gate.status === 'queue_full' ? 0 : Math.round(gate.waitedMs / 1000)
      let httpStatus: number
      let message: string
      if (gate.status === 'aborted') {
        httpStatus = 503
        message = `delegate 排队等待已被中断(用户停止,已等待 ${waitedS}s)`
      } else if (gate.blocked.kind === 'memory') {
        // 与排队机制引入前的内存闸同形:503 + "delegate resource pressure" 前缀。
        httpStatus = 503
        const base = `delegate resource pressure: memory ${gate.blocked.pct}% >= ${gate.blocked.limitPct}%`
        message =
          gate.status === 'timeout'
            ? `${base}; 已等待 ${waitedS}s 资源仍紧张,请稍后重试`
            : `${base}; please retry later(排队等待者已满 ${DELEGATE_QUEUE_MAX_WAITERS} 个)`
        this.log.warn('delegate_resource_pressure', {
          targetAgentId,
          outcome: gate.status,
          pct: gate.blocked.pct,
          limitPct: gate.blocked.limitPct,
          waitedMs: gate.status === 'timeout' ? gate.waitedMs : 0,
        })
      } else {
        // 与排队机制引入前的并发闸同形:429 + "too many concurrent delegations"。
        httpStatus = 429
        const base = `too many concurrent delegations (max ${Gateway.MAX_CONCURRENT_DELEGATIONS})`
        message =
          gate.status === 'timeout'
            ? `${base}; 已等待 ${waitedS}s 资源仍紧张,请稍后重试`
            : `${base}; 排队等待者已满(${DELEGATE_QUEUE_MAX_WAITERS} 个)`
        this.log.warn('delegate_queue_reject', {
          targetAgentId,
          outcome: gate.status,
          waitedMs: gate.status === 'timeout' ? gate.waitedMs : 0,
        })
      }
      // 已发过"排队中"进度卡 → 补终止帧收口卡片,不留悬挂的进行中状态。
      if (queuedNoticeSent) {
        emitProgress(
          makeDelegateProgressBlock({
            runId: progressRunId,
            agentId: targetAgentId,
            phase: 'error',
            isError: true,
            text: message,
            maxLen: 2_000,
          }),
        )
      }
      return { kind: 'rejected', httpStatus, message }
    }
    // 已过闸:并发名额已在 _tryReserveDelegateSlot 同步预占,此后所有路径必须释放
    // —— 正常路径走下方 finally,session 创建/开始帧投递抛错走本 catch。
    let session
    try {
      session = await this.sessions.getOrCreate({
        sessionKey,
        agent: delegatedAgent,
        channel: 'delegate',
        peerId: sourceAgent || 'system',
        repoSessionId: progressTarget?.peerId ?? delegateParent?.repoSessionId,
        // 物化直接父指针(已校验的父会话键),供本 delegate 的子委派沿父链向上追溯 webchat 祖先。
        parentSessionKey: delegateParent?.sessionKey,
        title: `[delegate] ${goal.slice(0, 40)}`,
        delegationDepth: depth + 1,
        usageAttribution: {
          mode: 'delegate',
          delegateAgentId: targetAgentId,
          ...(parentClientSessionId ? { parentSessionId: parentClientSessionId } : {}),
        },
      })
      // 回填本委派的进度卡 runId:子委派追溯到**一级**委派时复用它,把嵌套进度挂回同一张卡。
      session.progressRunId = progressRunId
      if (streamProgress) {
        emitProgress(
          makeDelegateProgressBlock({
            runId: progressRunId,
            agentId: targetAgentId,
            phase: 'start',
            text: `开始委派给 ${targetAgentId}: ${goal}`,
            // Correlation key: lets the frontend nest this run's live blocks into
            // the leader's delegate_task tool_use card (matched by agentId+goal)
            // instead of spawning a separate progress card.
            goal,
          }),
        )
      }
    } catch (err) {
      this._releaseDelegateSlot(slotOpts)
      unregisterDelegation?.()
      // 原为 throw → 路由 .catch → 500;现由 HTTP 壳把 {kind:'error'} 映射成 sendError(500),
      // 内部编排调用则据此走降级放行,语义等价、可结构化处理。
      return { kind: 'error', message: (err as Error)?.message ?? String(err) }
    }

    // P2 债C — 标记"本 turn 队长实际发生过非隐藏委派"(据此在队长 final 放行前触发硬编排
    // 审查)。审查员自身(isReview / hidden)不置位,避免"审查=组队"的自指。progressTarget
    // 是 webchat 父(与硬编排 orchestrateReview 判定同源),null 父(cron/嵌套)不置位。
    if (!isReview && !isHiddenSystemAgentId(targetAgentId) && progressTarget) {
      ;(this._turnDelegatedNonHiddenByParent ??= new Set()).add(progressTarget.sessionKey)
    }

    // Build prompt with context
    const prompt = context
      ? `[委派任务]\n\n目标: ${goal}\n\n上下文:\n${context}\n\n请完成上述任务并返回结果摘要。`
      : `[委派任务]\n\n目标: ${goal}\n\n请完成上述任务并返回结果摘要。`

    const _dlgRun = this._runLog.start({
      agentId: targetAgentId,
      sessionKey,
      taskType: 'delegate',
      ...(isReview ? { isReview: true } : {}),
    })
    let output = ''
    let error = ''
    let timedOut = false
    // P2 债C — review 委派结束时从审查输出解析出的结构化裁决(PASS/NEEDS_FIX);
    // 非 review / 解析不出 → undefined(编排据 undefined 走降级放行)。
    let verdict: ReviewVerdict | undefined
    const timeoutConfig = resolveDelegateTimeoutConfig()
    const startedAt = Date.now()
    let lastChildActivityAt = startedAt
    const markChildActivity = () => {
      lastChildActivityAt = Date.now()
    }
    let timeoutTimer: NodeJS.Timeout | null = null
    const clearTimeoutTimer = () => {
      if (timeoutTimer) clearInterval(timeoutTimer)
      timeoutTimer = null
    }
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setInterval(() => {
        const reason = getDelegateTimeoutReason(
          Date.now(),
          startedAt,
          lastChildActivityAt,
          timeoutConfig,
        )
        if (!reason) return
        clearTimeoutTimer()
        const err = new Error(reason.message)
        err.name = 'DelegateTimeoutError'
        reject(err)
      }, timeoutConfig.checkIntervalMs)
    })
    const submitPromise = this.sessions.submit(session, prompt, (e) => {
      const progressBlock = makeDelegateBlockPassthrough(e, progressRunId, targetAgentId)
      if (progressBlock || e.kind === 'block' || e.kind === 'error') markChildActivity()
      if (!timedOut) {
        if (e.kind === 'block' && e.block.kind === 'text') output += e.block.text
        if (e.kind === 'error') error = e.error
        if (streamProgress) emitProgress(progressBlock)
      }
    })
    try {
      await Promise.race([submitPromise, timeoutPromise])
      clearTimeoutTimer()
      if (!error) {
        const delegatedApiError = classifyDelegateOutputError(output)
        if (delegatedApiError) {
          error = `${delegatedApiError.message}\n\n${delegatedApiError.detail}`
        }
      }
      // P2 债C — review 委派干净完成(无 error)→ 从输出解析结构化 VERDICT 行。解析器
      // 认 PASS/FAIL/PARTIAL/NEEDS_FIX,passed=(verdict==='PASS')。审查员漏输出裁决行 →
      // parsed=null → verdict 保持 undefined → 编排判定"审查未完成"降级放行(fail-safe)。
      if (isReview && !error) {
        const parsedVerdict = parseVerificationVerdict(output)
        if (parsedVerdict) {
          verdict = parsedVerdict.passed ? REVIEW_VERDICT_PASS : REVIEW_VERDICT_NEEDS_FIX
        }
      }
      if (streamProgress) {
        emitProgress(
          makeDelegateProgressBlock({
            runId: progressRunId,
            agentId: targetAgentId,
            phase: error ? 'error' : 'done',
            isError: Boolean(error),
            text: error || output || '子 agent 已完成,无文本输出。',
            maxLen: error ? 2_000 : 4_000,
          }),
        )
      }
      this._runLog.complete(_dlgRun, {
        status: error ? 'failed' : 'completed',
        error: error || undefined,
        ...(verdict ? { verdict } : {}),
      })
    } catch (err: any) {
      error = error || err?.message || String(err)
      if (err?.name === 'DelegateTimeoutError') {
        timedOut = true
        clearTimeoutTimer()
        try {
          session.runner.interrupt()
        } catch {}
        void submitPromise.catch((lateErr) => {
          this.log.warn('delegate submit settled after timeout with error', {
            targetAgentId,
            sessionKey,
            error: lateErr?.message ?? String(lateErr),
          })
        })
      }
      if (streamProgress) {
        emitProgress(
          makeDelegateProgressBlock({
            runId: progressRunId,
            agentId: targetAgentId,
            phase: 'error',
            isError: true,
            text: error,
            maxLen: 2_000,
          }),
        )
      }
      this._runLog.complete(_dlgRun, { status: 'failed', error })
    } finally {
      clearTimeoutTimer()
      unregisterDelegation?.()
      this._releaseDelegateSlot(slotOpts)
      // 本次 delegate 的子会话(sessionKey 带时间戳,一次性)在生命周期内可能
      // 作为"父"再委派 hidden 审查员;它收尾后计数键永远不会复用,这里清理防泄漏。
      // 注意清的是子会话自己的键,不动 guardKey(父会话的额度要跨多次 delegate 累计)。
      this._hiddenDelegateGuard.resetForParent(sessionKey)
    }

    eventBus.emit('agent.completed', createEvent('agent.completed', targetAgentId, {
      sessionKey,
      output: output.trim(),
      error: error || undefined,
    }))

    // ── P2 债A — buffer this delegation as a server-authored team card ──
    //
    // Attach it to the LEADER (parent webchat) session so it drains into that
    // session's turn-end persist (persistServerAuthoredTurn). Only a **first-level**
    // delegation (direct webchat parent) durably persists a team card, matching
    // MASTER_SINK_PERSIST_CHANNELS. A nested/嵌套 delegation (`nestedProgress`) —
    // whose `progressTarget` now resolves to a webchat *ancestor* rather than null —
    // must NOT buffer its own durable card: its live progress已作为文本行挂到一级卡,
    // 用 progressRunId(≠ 一级 runId)另铸一张 server 行反而会折叠失败 → 冗余卡。故显式
    // 用 `!nestedProgress` 保持旧「嵌套 → client-only(无回归)」语义。非嵌套(一级)时
    // runId 复用本委派 progressRunId,server 行 `_delegateRunId` 折叠到同一张本地 `m-*`
    // agent-group 行(mergePreservingServerAuthored 里 local-wins)。resultSummary 在生成点
    // 截断(master 上限 2KB;前端本地 m-* 行仍保 200 字预览)。
    if (progressTarget && !nestedProgress) {
      const status: AgentGroupStatus = timedOut ? 'timeout' : error ? 'failed' : 'ok'
      const rawSummary = error ? error : output.trim()
      const resultSummary =
        rawSummary.length > 2000 ? `${rawSummary.slice(0, 2000)}…` : rawSummary
      this.sessions.bufferPendingAgentGroup(progressTarget.sessionKey, {
        runId: progressRunId,
        agentId: targetAgentId,
        goal,
        status,
        ...(resultSummary.length > 0 ? { resultSummary } : {}),
        completedAt: Date.now(),
        // P2 债C — 审查员委派行带上裁决,前端渲染「质量审查员 · PASS/未通过」。
        ...(verdict ? { verdict } : {}),
      })
    }

    return {
      kind: 'completed',
      ok: !error,
      output: output.trim(),
      error: error || undefined,
      timedOut,
      runId: progressRunId,
      verdict,
    }
  }

  /**
   * P2 债C — hidden reviewer 硬编排的审查状态机(纯编排,副作用以回调注入)。
   *
   * dispatchInbound 在 teamMode 队长(webchat)turn 完成、且本 turn 实际组队后调用。
   * 返回 { deliver, disclosure }:deliver=是否放行被扣住的队长 final(false 仅当
   * continuation 'errored' —— 终态错误帧已由队长 turn 自投递,无需再放行);disclosure=
   * 放行时附带的披露文案(降级/到顶时非空)。
   *
   * 红线(队长绝不卡死等 verdict):review 委派任何非"完成且解析出裁决"的结果
   * (闸拒/429/503/session 抛错/超时/无 VERDICT)一律降级放行 + 披露;continuation
   * 'other'(非常规终态)也收敛为放行,防挂起。副作用注入让本状态机可脱离
   * dispatchInbound 单测(mock runReview 返回 PASS/NEEDS_FIX/rejected + mock
   * submitContinuation 断言 PASS 放行 / NEEDS_FIX 续写 / 降级放行 / 迭代封顶)。
   */
  private async _runTeamReviewPass(args: {
    sessionKey: string
    maxRounds: number
    /** 跑一轮审查委派(isReview)。返回 DelegateTaskResult。 */
    runReview: () => Promise<DelegateTaskResult>
    /** NEEDS_FIX → 把审查意见喂回队长续写。返回续写终态:
     *  'held'(完成并再次扣住 final,继续下一轮)/ 'errored'(报错,终态帧已投递)/
     *  'other'(非常规终态,防御性收尾放行)。 */
    submitContinuation: (reviewOutput: string) => Promise<'held' | 'errored' | 'other'>
  }): Promise<{ deliver: boolean; disclosure?: string }> {
    const { sessionKey, maxRounds } = args
    let round = 0
    while (true) {
      round++
      const rev = await args.runReview()
      if (rev.kind !== 'completed' || rev.timedOut || rev.error || !rev.verdict) {
        const reason =
          rev.kind === 'rejected'
            ? `gate_${rev.httpStatus}`
            : rev.kind === 'error'
              ? 'error'
              : rev.timedOut
                ? 'timeout'
                : rev.error
                  ? 'delegate_error'
                  : 'no_verdict'
        this.log.info('team_review_degraded', { sessionKey, round, reason })
        return {
          deliver: true,
          disclosure: '（说明:本轮团队质量审查未能完成,已直接返回队长的结论。）',
        }
      }
      this.log.info('team_review', { sessionKey, round, verdict: rev.verdict })
      if (rev.verdict === REVIEW_VERDICT_PASS) return { deliver: true }
      // NEEDS_FIX
      if (round >= maxRounds) {
        return {
          deliver: true,
          disclosure: '（说明:质量审查仍有未决意见,已达审查迭代上限,返回队长当前结论。）',
        }
      }
      const cont = await args.submitContinuation(rev.output)
      if (cont === 'errored') return { deliver: false }
      if (cont === 'other') return { deliver: true } // 防御:非常规终态 → 收尾放行,防挂起
      // 'held' → 继续下一轮审查
    }
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
      if (isHiddenSystemAgentId(wh.agent)) {
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
      WechatAccountAlreadyBoundError,
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
        if (err instanceof WechatAccountAlreadyBoundError || err?.name === 'WechatAccountAlreadyBoundError') {
          this.sendJson(res, 409, {
            error: {
              code: 'WECHAT_ACCOUNT_ALREADY_BOUND',
              message: '该微信已绑定到其他账号，请先解绑或换一个微信',
            },
          })
          return
        }
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
      try {
        await this.deps.commercial?.wechatBroker?.cleanupBinding?.(userId)
      } catch (err: any) {
        this.log.warn(`[wechat] broker cleanup failed for user=${userId}`, undefined, err)
      }
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
        this.sendInternalError(res, err)
      }
      return
    }

    this.sendError(res, 404, 'wechat route not found')
  }

  private async _handleTasksApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') {
      const tasks = filterUserVisibleByAgentField(await this._taskStore.list())
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
      const taskAgent = typeof agent === 'string' && agent ? agent : 'main'
      if (isHiddenSystemAgentId(taskAgent)) return this.sendError(res, 404, 'agent not found')
      const task = await this._taskStore.create({
        id: id || `task-${Date.now().toString(36)}`,
        title,
        agent: taskAgent,
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
      if (isHiddenSystemAgentId(task.agent)) return this.sendError(res, 404, 'task not found')
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
      if (parsed.agent !== undefined && isHiddenSystemAgentId(parsed.agent)) {
        return this.sendError(res, 404, 'agent not found')
      }
      const existing = await this._taskStore.get(taskId)
      if (existing && isHiddenSystemAgentId(existing.agent)) {
        return this.sendError(res, 404, 'task not found')
      }
      const ok = await this._taskStore.update(taskId, parsed)
      if (ok) this._invalidateTaskCache()
      this.sendJson(res, ok ? 200 : 404, { ok })
      return
    }
    if (req.method === 'DELETE') {
      const task = await this._taskStore.get(taskId)
      if (task && isHiddenSystemAgentId(task.agent)) {
        return this.sendError(res, 404, 'task not found')
      }
      const ok = await this._taskStore.remove(taskId)
      if (ok) this._invalidateTaskCache()
      this.sendJson(res, ok ? 200 : 404, { ok })
      return
    }
    // POST → manually trigger the task (uses shared _triggerTask with RunLog)
    if (req.method === 'POST') {
      const task = await this._taskStore.get(taskId)
      if (!task) return this.sendError(res, 404, 'task not found')
      if (isHiddenSystemAgentId(task.agent)) return this.sendError(res, 404, 'task not found')
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
    if (isHiddenSystemAgentId(task.agent)) {
      this.log.warn('task hidden system agent rejected', { taskId, agent: task.agent })
      return
    }
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
      this.sendInternalError(res, err)
    }
  }

  // ── Cron/Reminder API handlers ──
  private async handleCronApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.cron) return this.sendError(res, 503, 'cron not initialized')
    if (req.method === 'GET') {
      const jobs = filterUserVisibleByAgentField(await this.cron.listJobsWithMeta())
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
      const cronAgent = typeof agent === 'string' && agent ? agent : 'main'
      if (isHiddenSystemAgentId(cronAgent)) return this.sendError(res, 404, 'agent not found')
      const id = `remind-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const job = {
        id,
        schedule,
        agent: cronAgent,
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
      const existing = (await this.cron.listJobsWithMeta()).find((job) => job.id === id)
      if (existing && isHiddenSystemAgentId(existing.agent)) {
        return this.sendError(res, 404, 'cron job not found')
      }
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
      if (parsed.agent !== undefined && isHiddenSystemAgentId(parsed.agent)) {
        return this.sendError(res, 404, 'agent not found')
      }
      const existing = (await this.cron.listJobsWithMeta()).find((job) => job.id === id)
      if (existing && isHiddenSystemAgentId(existing.agent)) {
        return this.sendError(res, 404, 'cron job not found')
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
        // 出站硬超时:token 端点挂起时回调请求无限卡(与 commercial refresh.ts 同款收口)。
        signal: AbortSignal.timeout(30_000),
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
        // 出站硬超时:refresh 挂起会卡住定时续期链路(与 commercial refresh.ts 同款收口)。
        signal: AbortSignal.timeout(30_000),
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
  }): Promise<boolean> {
    let sessionKey = frame.sessionKey
    const explicitStopAgentId = sessionKey?.split(':')[1] ?? frame.agentId
    if (explicitStopAgentId && isHiddenSystemAgentId(explicitStopAgentId)) {
      this.log.warn('interrupt hidden system agent rejected', { agentId: explicitStopAgentId })
      return false
    }
    if (!sessionKey) {
      if (frame.agentId) {
        sessionKey = `agent:${frame.agentId}:${frame.channel}:${frame.peer.kind}:${frame.peer.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
      } else {
        const safePeerId = frame.peer.id.replace(/[^a-zA-Z0-9_-]/g, '_')
        const suffix = `:${frame.channel}:${frame.peer.kind}:${safePeerId}`
        let interrupted = false
        for (const live of this.sessions.list()) {
          if (!live.sessionKey.endsWith(suffix)) continue
          const selfInterrupted = this.sessions.interrupt(live.sessionKey)
          const delegateInterrupted = this._interruptDelegationsForParent(live.sessionKey)
          interrupted = selfInterrupted || delegateInterrupted || interrupted
        }
        if (interrupted) {
          this.log.info('interrupt', { sessionKey: `*${suffix}`, ok: true })
          return true
        }
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
    const selfInterrupted = this.sessions.interrupt(sessionKey)
    const delegateInterrupted = this._interruptDelegationsForParent(sessionKey)
    const ok = selfInterrupted || delegateInterrupted
    this.log.info('interrupt', { sessionKey, ok })
    return ok
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
      if (isHiddenSystemAgentId(agentId)) {
        this.log.warn('auto-resume skipped hidden system agent session', { sessionKey })
        continue
      }
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
      if (isHiddenSystemAgentId(aid)) {
        this.log.warn('auto-resume hello skipped hidden system agent session', { agentId: aid })
        continue
      }
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
    const idempotencyPreReserved = (frame as any)._idempotencyPreReserved === true
    if (
      frame.idempotencyKey &&
      !idempotencyPreReserved &&
      this._isIdempotencyDuplicate(frame.idempotencyKey)
    ) {
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
    const rateLimitChannel: string =
      typeof (frame as any)._rateLimitChannel === 'string'
        ? (frame as any)._rateLimitChannel
        : frame.channel
    if (!this.rateLimiter.check(frame.peer.id, rateLimitChannel)) {
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
    if (frame.idempotencyKey && !idempotencyPreReserved) {
      this._markIdempotencyKey(frame.idempotencyKey)
    }

    // Pre-resolution marketplace sync: reconcile installed skills+agents into
    // hub/skills + agents.yaml BEFORE reading agents.yaml, so a freshly-installed
    // market agent is present at resolution time (not merely after a later spawn).
    // No-op outside a commercial container; bounded + fail-soft so it never blocks
    // the turn. The agents.yaml mtime change auto-invalidates _getAgentsConfig's cache.
    try {
      await syncMarketplaceHub({ timeoutMs: 4000 })
    } catch {
      /* fail-soft: sync must never block or fail the turn */
    }

    // Explicit agentId override (web UI per-session selection)
    let sessionKey: string
    let agent: AgentDef
    const cfg = await this._getAgentsConfig()
    if (frame.agentId && isHiddenSystemAgentId(frame.agentId)) {
      const hiddenAgentUserId: string =
        typeof (frame as any)._userId === 'string' ? (frame as any)._userId : 'default'
      const safePeerId = frame.peer.id.replace(/[^a-zA-Z0-9_-]/g, '_')
      this.deliver({
        type: 'outbound.message' as const,
        sessionKey: `agent:${frame.agentId}:${frame.channel}:${frame.peer.kind}:${safePeerId}`,
        channel: frame.channel,
        peer: frame.peer,
        blocks: [{ kind: 'text' as const, text: '[error] agent not found' }],
        isFinal: true,
        traceId: turnTraceId,
        _userId: hiddenAgentUserId,
      } as OutboundMessage, adapter)
      return
    }
    if (frame.agentId) {
      // Unknown agentId → demote to the default agent (全能助手), NEVER a personaless
      // {id} (which would run with no persona/toolsets/model). After the sync above a
      // genuinely-installed market agent is present; anything still unknown is treated
      // as not-installed and safely resolved to the least-privileged default.
      const ag =
        cfg.agents.find((a) => a.id === frame.agentId) ??
        cfg.agents.find((a) => a.id === cfg.default) ??
        cfg.agents.find((a) => a.id === 'main') ?? { id: 'main' }
      agent = ag
      // Include agentId in sessionKey so different agents get isolated subprocesses
      sessionKey = `agent:${frame.agentId}:${frame.channel}:${frame.peer.kind}:${frame.peer.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
    } else {
      const routed = this.router.route(frame)
      sessionKey = routed.sessionKey
      agent = routed.agent
    }
    if (isHiddenSystemAgentId(agent.id)) {
      const hiddenAgentUserId: string =
        typeof (frame as any)._userId === 'string' ? (frame as any)._userId : 'default'
      this.deliver({
        type: 'outbound.message' as const,
        sessionKey,
        channel: frame.channel,
        peer: frame.peer,
        blocks: [{ kind: 'text' as const, text: '[error] agent not found' }],
        isFinal: true,
        traceId: turnTraceId,
        _userId: hiddenAgentUserId,
      } as OutboundMessage, adapter)
      return
    }

    // ── model→agent 路由(M1a engine registry 语义)──
    // 把 inferAgentForModel 接到生产 message 链路。M1a 起底座选择不再由 agent 承载:
    //   - engine 由 sessionManager.getOrCreate 经 engine/registry 的 resolveEngine
    //     按 model 判定(gpt-5.5 → 'codex',其余 → 'ccb';codex-native pin 例外),
    //     **agent 不换** —— 任何 agent 都能以 gpt-5.5 跑 codex 底座,persona/skills/
    //     记忆随 agent 保持不变;
    //   - 本 helper 只回答"哪个 agent":requested agent 存在则用之,否则回落
    //     default(或首个)agent;完全无 agent 可用才 fail closed
    //     (error='no_compatible_agent',立刻回 error 帧并 return,不进 sessionManager)。
    // 模型准入由 ALLOWED_INBOUND_MODELS(入站帧)+ resolveExecutionModel
    // (agent.model 绕过口)收口;canUseModel 在 ws bridge 层已先于此路径拦截,
    // 这是 belt-and-suspenders。
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

    // Track last active channel for proactive push
    const activeUserId: string =
      typeof (frame as any)._userId === 'string' ? (frame as any)._userId : 'default'
    const lastActiveChannel: string =
      typeof (frame as any)._lastActiveChannel === 'string'
        ? (frame as any)._lastActiveChannel
        : frame.channel
    const lastActivePeerId: string =
      typeof (frame as any)._lastActivePeerId === 'string'
        ? (frame as any)._lastActivePeerId
        : frame.peer.id
    this.lastActiveChannel.set(agent.id, {
      channel: lastActiveChannel,
      peerId: lastActivePeerId,
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
    // 团队模式(v5 轻量组队):turn 级 flag,仅 main 队长生效。ws 帧无 typebox runtime
    // 校验(JSON cast),用 === true 防御(与 _frameRequestId 同模式)。
    const teamMode = (frame as any).teamMode === true

    // v5 codex route 消费链(A1):master bridge 注入的 `__oc_codex_route` →
    // 严格校验(_buildSafeCodexRouteOverride)→ submit opts.codexRoute →
    // runner.setCodexRoute(spawn 时拼 -c provider override,签名变化触发
    // codex app-server 重启的既有逻辑复用)。非 codex engine / 校验失败 → null,
    // submit 每 turn 都显式 set(null 即清除 stale route)。
    const safeCodexRoute = _buildSafeCodexRouteOverride({
      agent,
      model: safeModelForRouting,
      rawRoute: (frame as any).__oc_codex_route,
      officialRelayPort: this.deps.config.gateway.port,
    })

    const baseToolsets = agent.toolsets ?? this.deps.config.defaults.toolsets
    let effectiveToolsets = mergeOnDemandToolsets(
      baseToolsets,
      this.deps.config,
      frame.content.text ?? '',
    )
    // Marketplace agents are HARD-CAPPED to their declared manifest toolsets:
    // on-demand intent expansion must never grant a capability the manifest didn't
    // declare (RFC D2 — manifest toolsets are the total-reachable ceiling, not just
    // for delegation). Platform/user agents (no source marker) keep on-demand expand.
    effectiveToolsets = capMarketplaceToolsets(agent.source, agent.toolsets, effectiveToolsets)
    const effectiveAgent =
      effectiveToolsets === undefined ? agent : { ...agent, toolsets: effectiveToolsets }

    const session = await this.sessions.getOrCreate({
      sessionKey,
      agent: effectiveAgent,
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
      // M1a 跨 engine 切模型:入站 desired model 参与 getOrCreate 的 engine 判定
      // (resolveEngine 单一权威)。同 sessionKey 上 glm-5.2 ↔ gpt-5.5 切换在此
      // 触发 engine teardown + compact transcript preamble;同 engine 内的模型
      // 切换仍由 submit() 的 setModel + shutdown 处理。
      model: safeModel,
    })
    const wechatDispatchStarted = (frame as any)._wechatDispatchStarted
    if (typeof wechatDispatchStarted === 'function') {
      try {
        wechatDispatchStarted({
          traceId: turnTraceId,
          sessionKey,
          agentId: effectiveAgent.id,
        })
      } catch {}
      delete (frame as any)._wechatDispatchStarted
    }
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
    // Most adapters (Telegram / Feishu / legacy WeChat) can't take 30 small
    // messages per second, so they keep the historical "aggregate and send on
    // final" behavior.  The v3 WeChat broker is now deliberately different:
    // the WeChat/iLink reply surface is treated as non-streaming because it
    // empirically stalls around the 10th reply under one context_token.  For a
    // WeChat-originated turn we stream full process to the linked Web session
    // (normal webchat channel/ring) and send only the final/error text back
    // through the v3-wechat-outbound adapter.
    const aggregatedBlocks: typeof out.blocks = []
    const liveWechatAdapter = adapter?.id === V3_WECHAT_OUTBOUND_ADAPTER_ID
    let liveWechatSendQueue: Promise<void> = Promise.resolve()
    let liveWechatSeq = 0
    const liveOutboundBase =
      turnTraceId.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 80) ||
      `wechat${Date.now().toString(36)}`

    const addAggregatedBlock = (block: (typeof out.blocks)[number]) => {
      const blockWithId = block as any
      if (blockWithId.blockId) {
        const idx = aggregatedBlocks.findIndex((x: any) => x.blockId === blockWithId.blockId)
        if (idx >= 0) aggregatedBlocks[idx] = block
        else aggregatedBlocks.push(block)
      } else {
        aggregatedBlocks.push(block)
      }
    }

    const nextLiveWechatOutboundId = (kind: string): string => {
      const safeKind = kind.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'msg'
      return `${liveOutboundBase}.wxlive.${(++liveWechatSeq).toString(36)}.${safeKind}`
    }

    const enqueueLiveWechatMessage = (
      blocks: typeof out.blocks,
      isFinal: boolean,
      kind: string,
      meta?: any,
    ): boolean => {
      if (!adapter || blocks.length === 0) return false
      const msg = {
        ...out,
        blocks: blocks.slice(),
        isFinal,
        ...(meta !== undefined ? { meta } : {}),
        outboundId: nextLiveWechatOutboundId(kind),
      } as OutboundMessage & { outboundId: string }
      // `deliver(..., adapter)` is intentionally fire-and-forget.  Live WeChat
      // sends need stronger ordering: process₁ → process₂ → final must enqueue
      // at master in that order, otherwise the old "final then replay process"
      // symptom can still happen under HTTP/DB scheduling jitter.
      liveWechatSendQueue = liveWechatSendQueue.then(async () => {
        try {
          await this._sendAdapterOutboundMessage(msg, adapter)
        } catch (err) {
          this.log.error('adapter send failed', { channel: adapter.name }, err)
        }
      })
      return true
    }

    // ── Multimodal handling ──
    // Save all uploaded media to local disk and inject descriptive prompt hints
    // so the agent knows how to access them via MCP tools or Read.
    const text = frame.content.text ?? ''
    const media = frame.content.media ?? []

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
      const activeMcpTools = collectAvailableMcpToolNames(this.deps.config, effectiveAgent, safeModel)
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
    // 团队模式(v5 轻量组队):main 队长这一轮前置"组队引导"——列出可委派的已安装 agent
    // + 让它自主判断是否 delegate_task 组队(简单任务自己答)。turn 级,开关中途切立即生效;
    // 放在 media 拼接之后,确保带附件时引导也在。委派本身走内置 delegate_task,无需改工具。
    if (teamMode && agent.id === 'main') {
      const teamCfg = await this._getAgentsConfig()
      // 成员 = 市场安装集(source==='marketplace'),与 AgentPicker(master 市场安装权威)
      // 对齐、对存量容器的幽灵平台 seed 免疫。队长是 main 自己,故 includeMain:false。
      const members = listCollaboratorAgents(teamCfg, { selfId: 'main', includeMain: false })
      const memberLines =
        members.length > 0
          ? members
              .map((a) => {
                const model = a.model ? `${a.model}` : '默认模型'
                const provider = a.provider || '继承全局'
                return `- \`${a.id}\`${a.displayName ? `（${a.displayName}）` : ''} [${model}, ${provider}]${teamMemberCapabilityHint(a)}`
              })
              .join('\n')
          : '（当前没有其它已安装 agent —— 直接自己完成即可）'
      // P2 债C — preamble 只保留**协作**语义(拆解/委派/领域路由/综合)。审查已由 gateway
      // 硬编排接管(见 dispatchInbound 队长 final 放行前的 review pass):队长不再被 prompt
      // 要求"自觉调用 hidden-reviewer / 解读 verdict / 迭代到 PASS / 说明审查失败" —— 那套
      // 软约束整体删除,审查触发权威唯一 = gateway 代码,消"prompt 说要审查但模型不照做"的漂移。
      const teamPreamble = [
        '【团队模式已开启】把这次任务当作队长来处理：',
        `可委派的成员（已安装 agent）：\n${memberLines}`,
        '- 你是队长，也是完成用户任务的第一负责人；从任务拆解、是否委派到最终答复，都由你端到端负责。',
        '- 领域匹配优先于泛泛并行：用户任务明显属于某个已安装成员的领域时，优先把对应部分委派给该成员；多领域任务则拆给对应成员后由你综合。常见路由：代码/调试/测试/重构/代码库 → `coding-assistant`；科研/文献/论文/引用/学术分析 → `research-assistant`；文档/PPT/Excel/PDF/周报/公文/邮件/办公交付 → `office-assistant`。如果对应成员未安装，你可以自己完成或选择最接近的已安装成员。',
        '- 任务复杂、可拆解 → **首选**用 `delegate_task(goal, agentId, context)` 委派子任务给上面列出的已安装成员组队，拿到各成员结果后你综合成给用户的最终答案；任务简单则直接自己完成。',
        '- 委派**只走 `delegate_task`**：这是平台唯一的组队/委派通道（有实时进度回传、计费与资源约束）。平台已停用 codex 原生 `Agent`/子进程编排，不存在这样的工具，不要尝试启动；需要拆分的子任务一律用 `delegate_task`，不确定或不适合委派时就自己完成。',
        '',
        '用户任务：',
        '',
      ].join('\n')
      finalText = teamPreamble + finalText
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
    // 新用户 turn 开启 → 清零本会话对 hidden 审查员的串行委派计数。delegate 请求
    // 只带 parentSessionKey(没有 turn 级标识),所以"每 turn 上限"的 turn 边界由
    // 这里定义:同一 sessionKey 收到下一条入站用户消息即视为新 turn。
    this._hiddenDelegateGuard.resetForParent(sessionKey)
    // P2 债C — 新 turn 起始清零"本 turn 是否发生过非隐藏委派"跟踪(与上面的熔断重置同点)。
    ;(this._turnDelegatedNonHiddenByParent ??= new Set()).delete(sessionKey)
    // P2 债C — hidden reviewer 硬编排状态。orchestrateReview:仅 teamMode 队长(main)且
    // webchat(!adapter,team 是 webchat-only 功能)启用;此时队长 turn 的 final 被"扣住"
    // (finalHeld),由下方 review pass 决定放行/续写/降级。currentRun 让 continuation 每轮
    // 各记一条 runLog(callback 引用 currentRun 而非 _run)。turnErrored:error/apiError 分支
    // 已投递终态错误帧,编排不再介入。
    const orchestrateReview = teamMode && agent.id === 'main' && !adapter
    let currentRun = this._runLog.start({ agentId: session.agentId, sessionKey, taskType })
    let heldFinalMeta: Extract<SessionStreamEvent, { kind: 'final' }>['meta']
    let finalHeld = false
    let turnErrored = false
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
    // P2 债C — 提取为具名回调,供硬编排 review pass 的 continuation 复用同一份流式处理
    // (再次 submit 时 block 照常流给客户端、final 照常被 finalHeld 扣住)。非 team 路径
    // 语义与原内联回调逐字节一致。
    const onLeaderEvent = (e: SessionStreamEvent) => {
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
          if (liveWechatAdapter) {
            this.deliver({ ...out, blocks: [e.block], isFinal: false }, undefined)
            return
          }
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
            this.deliver(errFrame, liveWechatAdapter ? undefined : adapter)
            return
          }
        }

        if (liveWechatAdapter) {
          // WeChat itself only gets final/error text.  The linked Web session
          // receives the full detailed stream (thinking/tool/tool_result/text)
          // through the normal webchat path and outbound ring, so multi-hour
          // tasks remain observable without exercising iLink as an event log.
          if (b.kind === 'text') {
            addAggregatedBlock(e.block)
          }
          this.deliver({ ...out, blocks: [e.block], isFinal: false }, undefined)
        } else if (adapter) {
          addAggregatedBlock(e.block)
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
          // P2 债C — 已识别 API 错误 = 终态错误帧自投递,硬编排 review pass 不介入。
          turnErrored = true
          // 替代原 final:发 [error] text final 关闭 turn。不附 e.meta(boss
          // 决策:错误卡不显示 cost),与 e.kind === 'error' 分支一致;runLog
          // 也按 failed 记账,idempotency key 释放允许 client retry。
          this._runLog.complete(currentRun, { status: 'failed', error: _apiErrorText })
          if (frame.idempotencyKey && (frame as any)._idempotencyPreReserved) {
            this._updateWechatIdempotency(frame.idempotencyKey, { completed: true })
          }
          if (frame.idempotencyKey && !(frame as any)._idempotencyPreReserved) {
            this._seenIdempotencyKeys.delete(frame.idempotencyKey)
          }
          if (liveWechatAdapter) {
            const errBlocks = [{ kind: 'text', text: `[error] ${_apiErrorText}` } as any]
            this.deliver(
              {
                ...out,
                blocks: errBlocks,
                isFinal: true,
              },
              undefined,
            )
            enqueueLiveWechatMessage(
              errBlocks,
              true,
              'error',
            )
          } else {
            this.deliver(
              {
                ...out,
                blocks: [{ kind: 'text', text: `[error] ${_apiErrorText}` }],
                isFinal: true,
              },
              adapter,
            )
          }
          // 跨 turn message listener 仍持有这个闭包(供 bg-bash tail 转发),
          // 不清空数组的话,API_ERROR 前已聚合的 block 会被钉到下次 turn 替换 listener。
          out.blocks.length = 0
          aggregatedBlocks.length = 0
          return
        }
        this._runLog.complete(currentRun, {
          status: 'completed',
          cost: e.meta?.cost,
          inputTokens: e.meta?.inputTokens,
          outputTokens: e.meta?.outputTokens,
          turn: e.meta?.turn,
        })
        // ── P2 债C — 扣住队长 final ──
        // teamMode 队长(webchat)turn 完成 → 不在此立即投递终态 final,而是 hold 住,
        // 交给 submit 之后的硬编排 review pass 决定放行/续写/降级。runLog 已按本轮 completed
        // 记账;idempotency 完成标记推迟到真正放行(deliverHeldFinal)。out.blocks 不清空
        // (跨轮 continuation 仍复用本闭包流式;最终 deliverHeldFinal 清)。
        if (orchestrateReview) {
          heldFinalMeta = e.meta
          finalHeld = true
          return
        }
        if (frame.idempotencyKey && (frame as any)._idempotencyPreReserved) {
          this._updateWechatIdempotency(frame.idempotencyKey, { completed: true })
        }
        if (liveWechatAdapter) {
          // Web gets the normal stream above, then an empty final terminator.
          // WeChat gets exactly one final text message.  If the agent completed
          // with no assistant text (tools-only/interrupted edge), still send a
          // terminal marker so the user is not left with only the start link.
          this.deliver({ ...out, blocks: [], isFinal: true, meta: e.meta }, undefined)
          const wechatFinalBlocks =
            aggregatedBlocks.length > 0
              ? aggregatedBlocks.slice()
              : ([{ kind: 'text', text: WECHAT_FINAL_EMPTY_TEXT } as any] as typeof out.blocks)
          enqueueLiveWechatMessage(wechatFinalBlocks, true, 'final', e.meta)
        } else if (adapter) {
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
        if (adapter && !liveWechatAdapter) {
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
        // M1a 复活(原 PR2 v1.0.66)— codex turn 终态侧信道。CodexAdapter 在内核
        // result 帧上经 'billing' 通道 emit,sessionManager 包装成 'codex_billing'
        // 事件,server.ts 这里发 outbound.codex_billing 帧给 master(走 deliver()
        // 同样路径,落到 userChatBridge 的 onContainerMessage,master 拦截 settle,
        // 真扣费接线在 M2)。
        //
        // 不影响 turn 流式 UX:这帧与 outbound.message/error 并存,前端不识别此 type
        // 在 default case 静默忽略。master 拦截后不 forward 到 user。
        //
        // 用 deliver() 是因为它已经处理 frameSeq + ring + per-peer 路由。路由三件套
        // 从 out 复制(同 OutboundError 模式);billing 只去 master,master 从
        // requestId 找 inflight,不读这三字段做 settle。CG7 — traceId 随
        // _inheritOutboundRouting 从 main `out` 继承(billing 行可按 traceId 反查
        // 产生它的 turn)。
        //
        // M2 — engineSessionId 进 wire 帧:EngineBillingEvent.engineSessionId
        // (adapter 构造时经唯一 helper engineSessionId(sessionKey) 派生)是 master
        // settle 落 usage_records.session_id 的权威值;与 _reportTurnWaive 的
        // idle-timeout 免单上报同源同值(方案红线:settle=waive 同一
        // engineSessionId,否则 refund.refundSessionWindow 圈不到 codex 记录)。
        const billingFrame: OutboundCodexBilling & { _userId?: string } = {
          type: 'outbound.codex_billing',
          ..._inheritOutboundRouting(out),
          requestId: e.requestId,
          engineSessionId: e.engineSessionId,
          status: e.status,
          durationMs: e.durationMs,
          ...(e.usage ? { usage: e.usage } : {}),
          ...(e.errorReason ? { errorReason: e.errorReason } : {}),
          // Issue A v1.0.108 — codex rateLimits 快照,master.userChatBridge 落库到
          // claude_accounts.quota_*。optional 字段缺省时自然不带。
          ...(e.rateLimits ? { rateLimits: e.rateLimits } : {}),
        }
        this.deliver(billingFrame, adapter)
      } else if (e.kind === 'error') {
        // Plan 2 — turn 终态前清 turn_status cache,语义同 final 分支。
        session.currentTurnStatus = null
        // P2 债C — turn 报错 = 终态错误帧自投递,硬编排 review pass 不介入。
        turnErrored = true
        this._runLog.complete(currentRun, { status: 'failed', error: e.error })
        if (frame.idempotencyKey && (frame as any)._idempotencyPreReserved) {
          this._updateWechatIdempotency(frame.idempotencyKey, { completed: true })
        }
        // Remove idempotency key on normal Web failures to allow client retry.
        // WeChat early-ACK turns keep their metadata for the TTL so a lost
        // Step1 response can be deduplicated instead of re-dispatching.
        if (frame.idempotencyKey && !(frame as any)._idempotencyPreReserved) {
          this._seenIdempotencyKeys.delete(frame.idempotencyKey)
        }
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
          this.deliver(errFrame, liveWechatAdapter ? undefined : adapter)
        }
        if (liveWechatAdapter) {
          const errBlocks = [{ kind: 'text', text: `[error] ${e.error}` } as any]
          this.deliver(
            {
              ...out,
              blocks: errBlocks,
              isFinal: true,
            },
            undefined,
          )
          enqueueLiveWechatMessage(
            errBlocks,
            true,
            'error',
          )
        } else {
          this.deliver(
            {
              ...out,
              blocks: [{ kind: 'text', text: `[error] ${e.error}` }],
              isFinal: true,
            },
            adapter,
          )
        }
      }
    }
    const leaderSubmitOpts = {
      historicalMessages: masterHistoricalMessages,
      codexRoute: safeCodexRoute,
      ...(teamMode && agent.id === 'main'
        ? { collabAgentPolicy: 'team-mode-prefer-delegate' as const }
        : {}),
      ...(effectiveToolsets !== undefined ? { toolsets: effectiveToolsets } : {}),
    }
    await this.sessions.submit(
      session,
      payload,
      onLeaderEvent,
      safeEffortLevel,
      safeModel,
      safeRequestId,
      turnTraceId,
      safeConversationMode,
      leaderSubmitOpts,
    )

    // ── P2 债C — hidden reviewer 硬编排 review pass(仅 teamMode 队长 + webchat)──
    //
    // 队长 turn 已完成但 final 被扣住(finalHeld)。此处是审查触发的**唯一权威**:
    //   - 本 turn 没发生过非隐藏委派 → 无需审查,立即放行扣住的 final;
    //   - 发生过 → 由 gateway 代码触发 review delegate(内部直调 _runDelegateTask,
    //     isReview:true),解析 verdict:PASS 放行 / NEEDS_FIX 把审查意见以 system
    //     continuation 喂回队长续写并再审(封顶 resolveTeamReviewMaxRounds 轮)。
    //
    // 红线(降级全部放行,队长绝不卡死等 verdict):review 委派的任何非"完成且有裁决"
    // 结果(闸拒/排队超时/429/503/session 抛错/超时/解析不出 VERDICT),以及 continuation
    // 本身出错(turnErrored),一律放行队长 final + 卡片/文案披露"审查未完成"。重启中断
    // 由 submit reject 走 turnErrored 或 review rejected/error → 同样降级放行。
    if (orchestrateReview) {
      const deliverHeldFinal = (disclosure?: string) => {
        // 披露作为一条独立 assistant 文本 block 追加(preamble 已删"队长自述审查失败",
        // 改由 gateway 在此如实披露);无披露(PASS)则只发终态 final。
        if (disclosure) {
          const discBlock = { kind: 'text' as const, text: disclosure }
          out.blocks.push(discBlock as (typeof out.blocks)[number])
          this.deliver(
            { ...out, blocks: [discBlock as (typeof out.blocks)[number]], isFinal: false },
            undefined,
          )
        }
        this.deliver({ ...out, blocks: [], isFinal: true, meta: heldFinalMeta }, undefined)
        if (frame.idempotencyKey && (frame as any)._idempotencyPreReserved) {
          this._updateWechatIdempotency(frame.idempotencyKey, { completed: true })
        }
        out.blocks.length = 0
        aggregatedBlocks.length = 0
      }
      if (turnErrored) {
        // 队长 turn 报错:error/apiError 分支已投递终态错误帧,无草稿可审、无 final 待放行。
      } else if (!finalHeld) {
        // 防御:正常 completed turn 一定命中 final 分支扣住;未扣住说明是非常规终态,不介入。
      } else if (!(this._turnDelegatedNonHiddenByParent ??= new Set()).has(sessionKey)) {
        // 本 turn 队长没真正组队(自己答完)→ 无需审查,直接放行扣住的 final。
        deliverHeldFinal()
      } else {
        // 组队发生 → 跑审查状态机。副作用(跑审查 / 续写)以回调注入,便于单测断言
        // PASS 放行 / NEEDS_FIX 续写 / 降级放行 三路 + 迭代封顶,而不必驱动整条 dispatchInbound。
        const outcome = await this._runTeamReviewPass({
          sessionKey,
          maxRounds: resolveTeamReviewMaxRounds(),
          runReview: () =>
            this._runDelegateTask({
              targetAgentId: HIDDEN_REVIEWER_AGENT_ID,
              goal: '对队长准备提交给用户的最终答复草稿做独立质量审查,给出结构化裁决。',
              context: buildTeamReviewContext(text, (session.currentAssistantBuf ?? '').trim()),
              sourceAgent: 'main',
              parentSessionKey: sessionKey,
              streamProgress: true,
              depth: 0,
              isReview: true,
            }),
          submitContinuation: async (reviewOutput) => {
            // 审查意见喂回队长续写;复用 onLeaderEvent(block 继续流、final 再被扣住)。
            finalHeld = false
            currentRun = this._runLog.start({ agentId: session.agentId, sessionKey, taskType })
            await this.sessions.submit(
              session,
              buildTeamReviewContinuation(reviewOutput),
              onLeaderEvent,
              safeEffortLevel,
              safeModel,
              safeRequestId,
              turnTraceId,
              safeConversationMode,
              leaderSubmitOpts,
            )
            return turnErrored ? 'errored' : finalHeld ? 'held' : 'other'
          },
        })
        if (outcome.deliver) deliverHeldFinal(outcome.disclosure)
      }
    }
    if (liveWechatAdapter) {
      await liveWechatSendQueue
    }
  }

  private async _sendAdapterOutboundMessage(
    out: OutboundMessage,
    adapter: ChannelAdapter,
  ): Promise<void> {
    const { wire } = _stripPrivateRoutingFields(out as unknown as Record<string, unknown>)
    await adapter.send(wire as unknown as OutboundMessage)
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
// P1d:同时匹配 v3(oc-v3-data)与 v5(oc-v5-data)用户卷媒体路径。这是 fail-closed deny
// gate,over-match 是安全方向 —— 若 v5 路径不被本 gate 捕获,会落到非 uid-aware 的
// FILE_ALLOWED_DIRS/agent-CWD 分支 → v5 媒体跨租户 IDOR。匹配两 channel 前缀即堵死。
const COMMERCIAL_USER_VOLUME_MEDIA_GATE =
  /^\/var\/lib\/docker\/volumes\/oc-v[35]-data-u\d+\/_data\/(uploads|generated)(\/|$)/

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
  /USER\.md$/, // user identity / core memory (legacy per-agent)
  /(^|\/)user\.md$/, // user-level shared identity / core memory (~/.openclaude/user.md)
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

  // ScanSci PDF persistent state. PDFs under `papers/` are user work products
  // and remain allowed in v3 trusted mode; config/cookies/browser state are
  // credential-bearing runtime state and must never be served as files.
  /\/\.local\/share\/scansci-pdf\/config\.json$/,
  /\/\.local\/share\/scansci-pdf\/cache\/browser_state\.json$/,
  /\/\.local\/share\/scansci-pdf\/(?:cache\/)?[^/]*(cookie|cookies|token|secret|key)[^/]*\.(json|txt|db|sqlite)$/i,

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

/**
 * 静态 web UI 资产的 Cache-Control —— 缓存规则的单一权威(见 GatewayDeps.staticMode)。
 * `safePath` 已把 `/` 归一为 `/index.html`。抽为纯函数便于单测锁定、避免规则在测试里被
 * 重新实现而漂移。
 *   - 'spa'(v5 Aurora,bundler dist): 内容哈希资产 `/assets/*` → immutable 1 年;
 *     其余(含 index.html / public 透传文件)→ no-cache,借 ETag 廉价重校验。
 *   - 'vanilla'(默认,v3/personal,web/public): 沿用 ?v=hash cache-bust →
 *     普通资产 1 小时;sw.js 永不被边缘缓存(CF 默认 4h TTL 会把用户钉在陈旧 SW 上)。
 */
export function staticCacheControl(safePath: string, mode: 'vanilla' | 'spa' | undefined): string {
  if (mode === 'spa') {
    return safePath.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache'
  }
  return safePath === '/sw.js' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600'
}

const LEGACY_ADMIN_MODULE_PATHS = new Set([
  '/modules/admin.js',
  '/modules/api.js',
  '/modules/auth.js',
  '/modules/broadcast.js',
  '/modules/charts.js',
  '/modules/dom.js',
  '/modules/state.js',
])
const LEGACY_ADMIN_VENDOR_PATHS = new Set([
  '/vendor/chart.umd.min.js',
  '/vendor/qrcode.min.js',
])

/**
 * v5/spa 下允许从 legacy web/public 透传的超管后台静态资产。
 * 主站 React/Vite 资产仍只走 /assets/*；这里不要扩大到 style.css / index.html。
 */
export function legacyAdminStaticPath(safePath: string): boolean {
  return safePath === '/admin.html' ||
    safePath === '/icon.svg' ||
    LEGACY_ADMIN_MODULE_PATHS.has(safePath) ||
    LEGACY_ADMIN_VENDOR_PATHS.has(safePath)
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
    .replace(/\/api\/skills\/[a-z0-9-]+/, '/api/skills/:name')
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
