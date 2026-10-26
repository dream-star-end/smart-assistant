/**
 * SubprocessRunner spawn configuration: CCB / official Claude Code child env builders (remote target, service tier, trace, usage attribution, model authority and upstream headers, vision MCP, host provider), Box-native harness projection, advisor catalog lock, CLI argument builders, crash stderr tails.
 *
 * Moved verbatim out of subprocessRunner.ts — FINDINGS §8 (cc2), OCV5-478. subprocessRunner.ts
 * imports these back and re-exports its former exports, so its import surface is unchanged.
 */
import {
  BOX_API_MODELS,
  OPENAI_FAST_SERVICE_TIER,
  TRACE_ID_HEADER,
  isBoxApiModel,
  parseTraceIdCandidate,
} from '@openclaude/protocol'
import type { IdentityCompatRuntimeContext } from '@openclaude/storage'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { McpServerConfig, OpenClaudeConfig } from '@openclaude/storage'
import { resolveHostStaticProviderEnv } from './hostStaticProviders.js'
import type { ServiceTier, StaticProviderKeys } from '@openclaude/protocol'
import {
  AUTHORITY_HEADER,
  LOCAL_CATALOG_HEADER,
  ModelCatalogUnavailableError,
  TURN_LEASE_HEADER,
  getModelCatalogClient,
} from './modelCatalogClient.js'
import type { ExecutionTarget } from './remoteTarget.js'
import type { RepoSnapshot } from './sessionRepoWorkspace.js'
import { CCB_ADVISOR_PROFILE_VERSION, type AdvisorConsultExecution } from './advisorMode.js'

/** The engine=ccb official-cc lane puts per-turn headers in the spawn env and
 * respawns when they change. Cursor Sand and the box-resident CLI never read
 * that env: Sand uses its loopback relay, the box uses the box's own login. */
export function _officialCcProxyLane(args: {
  harness: 'ccb' | 'official-cc'
  authorityEngine: 'ccb' | 'cursor' | undefined
  boxResidentCc: boolean
}): boolean {
  return args.harness === 'official-cc' && args.authorityEngine !== 'cursor' && !args.boxResidentCc
}

/**
 * 构造容器侧 OC_REMOTE_* env。
 *
 * 宿主侧 mux 路径:`/run/ccb-ssh/u<uid>/h<hid>/{ctl.sock,known_hosts}`
 * 容器侧挂载:supervisor 把 host `/run/ccb-ssh/u<uid>` bind ro 到容器 `/run/ccb-ssh`
 * 所以容器内可见路径:`/run/ccb-ssh/h<hid>/{ctl.sock,known_hosts}`
 *
 * 这里直接按 hostId 重新拼容器侧绝对路径,不复用 hostMeta.controlPath —— 后者
 * 是宿主路径,容器里不存在。
 */
export function buildRemoteTargetEnv(target: ExecutionTarget | undefined): Record<string, string> {
  if (!target || target.kind !== 'remote') {
    // 确保切回 local 时 CCB 看到的是空串 —— 不留 inherit 下来的旧值
    return {
      OC_REMOTE_TARGET: '',
      OC_REMOTE_HOST_ID: '',
      OC_REMOTE_CTL_SOCK: '',
      OC_REMOTE_KNOWN_HOSTS: '',
      OC_REMOTE_USER: '',
      OC_REMOTE_HOST: '',
      OC_REMOTE_PORT: '',
      OC_REMOTE_WORKDIR: '',
    }
  }
  const { hostId, hostMeta } = target
  const containerBase = `/run/ccb-ssh/h${hostId}`
  return {
    OC_REMOTE_TARGET: 'ssh',
    OC_REMOTE_HOST_ID: hostId,
    OC_REMOTE_CTL_SOCK: `${containerBase}/ctl.sock`,
    OC_REMOTE_KNOWN_HOSTS: `${containerBase}/known_hosts`,
    OC_REMOTE_USER: hostMeta.username,
    OC_REMOTE_HOST: hostMeta.host,
    OC_REMOTE_PORT: String(hostMeta.port),
    OC_REMOTE_WORKDIR: hostMeta.remoteWorkdir,
  }
}

/**
 * OCV5-434 GPT Fast for OpenCode Go /responses models: CCB merges CLAUDE_CODE_EXTRA_BODY into
 * every request body, the proxy keeps `service_tier: "priority"` for the Fast models only.
 * Standard → empty string (NOT key omission): the spawn env starts from process.env, so an
 * inherited value must be cleared; CCB ignores an empty CLAUDE_CODE_EXTRA_BODY.
 */
export function _buildCcbServiceTierEnv(tier: ServiceTier | null): {
  CLAUDE_CODE_EXTRA_BODY: string
} {
  return {
    CLAUDE_CODE_EXTRA_BODY:
      tier === 'fast' ? JSON.stringify({ service_tier: OPENAI_FAST_SERVICE_TIER }) : '',
  }
}

/**
 * V3 S12e CG8 — contract C 段(best-effort)spawn-time trace env.
 *
 * 返回单 key 的 env overlay,固定 spread 到 backend.spawn({env}) 后段,**always
 * 覆盖**任何上游进程 env 上可能继承下来的 OPENCLAUDE_TRACE_ID(故采空串而非
 * key-omission)。
 *
 * 设计要点:
 *   - **空串而非省略**:env 块以 `...process.env` 起,如果省 key,gateway 自身
 *     process.env 里若意外有 `OPENCLAUDE_TRACE_ID` 会被 CCB 继承,语义错位。
 *     固定写 `''` 等同显式"本 spawn 无 trace stash"。
 *   - **单 key 形状**:与 `buildRemoteTargetEnv` 平行,放在同一处方便审计。
 *   - **首次 spawn / 重启 spawn 都用此 helper**:opts.traceId 是 sessionManager
 *     在 lock 内 mutate 的最新值,任何 re-spawn 通过 `this.opts.traceId` 读到当前
 *     trace。
 *
 * 见 docs/V3_S12e_PLAN_2026-05-11.md §492-497(contract C 段)。
 */
export function _buildCcbSpawnTraceEnv(traceId: string | undefined): {
  OPENCLAUDE_TRACE_ID: string
} {
  return { OPENCLAUDE_TRACE_ID: traceId ?? '' }
}

/**
 * delegate 子会话计费归因标(usage_records 落库维度,与 UX 无关)。
 *
 * handleDelegateTask 在创建 delegate 子会话时构造并经 sessionManager.getOrCreate
 * → createEngine opts 传入;**只有 delegate 会话设置**,普通 webchat/cron/webhook
 * 会话恒 undefined(→ CLAUDE_CODE_EXTRA_METADATA='',CCB 视为未设置,请求
 * metadata 字节与旧版完全一致 —— 非团队普通聊天零影响的硬约束)。
 */
export interface UsageAttributionTag {
  mode: 'delegate'
  /** 父**客户端**会话 id(web-*)。映射链:handleDelegateTask 的
   *  progressTarget.peerId(父是 webchat)→ delegateParent.repoSessionId(嵌套
   *  delegate,== 根 webchat 会话 id)→ 容器内部 parentSessionKey(父会话不在
   *  内存的兜底,master 侧原样落库并注明为内部键)。 */
  parentSessionId?: string
  /** 委派目标 agent id(hidden-reviewer 同样打标)。 */
  delegateAgentId: string
  /** Leader logical turn that owns this delegate's spend. */
  parentTurnKey?: string
}

/**
 * delegate 计费归因 → CCB `CLAUDE_CODE_EXTRA_METADATA` env。
 *
 * CCB getAPIMetadata()(claude-code-best/src/services/api/claude.ts,按函数名找 ——
 * 行号会随上游跟进漂移,2026-07-26 升 v2.8.4 时已从 485 漂到 497)把
 * 该 env 解析为 JSON object 后 spread 进 `metadata.user_id` JSON(device_id /
 * account_uuid / session_id 在 spread 之后写入,`oc_` 前缀键永不冲突),随每次
 * LLM 请求直达 master anthropicProxy 计费点(extractUsageAttribution 提取,
 * settle 落 usage_records.mode/parent_session_id/delegate_agent_id,转发上游前
 * 剥除)。
 *
 * 设计要点(与 _buildCcbSpawnTraceEnv 同构):
 *   - **空串而非省略**:env 块以 `...process.env` 起,省 key 会让 gateway 自身
 *     process.env 里意外存在的 CLAUDE_CODE_EXTRA_METADATA 泄进 CCB;CCB 对空串
 *     按未设置处理(`if (extraStr)` falsy)。
 *   - **值长度截断**:metadata.user_id 有 512 字节 zod 预算(proxy/shared.ts),
 *     基础键 ~200 字节;parentSessionId ≤128 / delegateAgentId ≤64 兜底防超预算
 *     把 delegate 请求整条 400 掉(正常值远短于此:web-* ~21 字符,agent id 常
 *     ≤32 字符)。
 *   - **codex/grok 引擎不消费此 env**:engine-reported 委派改走 master 签发的
 *     32-hex requestId + request_finalize_journal(见 handleDelegateTask admit),
 *     adapter 据此 emit billing,codexFinalizer 按 attribution 写 mode=delegate。
 *     本 env 仍只服务 CCB/GLM anthropicProxy 路径。
 */
export function _buildCcbUsageAttributionEnv(
  tag: UsageAttributionTag | undefined,
  turnKey?: string,
): { CLAUDE_CODE_EXTRA_METADATA: string } {
  if (!tag && !turnKey) return { CLAUDE_CODE_EXTRA_METADATA: '' }
  const extra: Record<string, string> = {}
  if (tag) {
    extra.oc_mode = tag.mode
    extra.oc_delegate_agent_id = tag.delegateAgentId.slice(0, 64)
    if (tag.parentSessionId) {
      extra.oc_parent_session_id = tag.parentSessionId.slice(0, 128)
    }
    if (tag.parentTurnKey && /^[0-9a-f]{64}$/.test(tag.parentTurnKey)) {
      extra.oc_parent_turn_key = tag.parentTurnKey
    }
  }
  if (turnKey && /^[0-9a-f]{64}$/.test(turnKey)) {
    extra.oc_turn_key = turnKey
  }
  return { CLAUDE_CODE_EXTRA_METADATA: JSON.stringify(extra) }
}

/**
 * The model CCB uses for its hidden secondary calls — notably WebFetch's
 * applyPromptToMarkdown (queryHaiku → getSmallFastModel), plus a few hook /
 * search helpers. Upstream CCB defaults this to Haiku via ANTHROPIC_SMALL_FAST_MODEL.
 *
 * On v5 both prior behaviours were broken:
 *   - No pin → CCB fell back to `claude-haiku-4-5`, an OAuth-pool Claude request.
 *     The v5 pool has ~1 active Claude account, so WebFetch's secondary call
 *     failed with ACCOUNT_POOL_UNAVAILABLE / HTTP 402.
 *   - Pinning to the *main* static model → a plain thinking-disabled extraction
 *     ran on a heavyweight thinking model (glm-5.2 / deepseek-v4-pro). Ark rejects
 *     that request shape with upstream 400, surfaced to the agent as gateway 502.
 * Real session `webmr1zp65b2x07pe` (glm-5.2) hit both: WebFetch → 502 (upstream 400)
 * and → 402.
 *
 * Root fix: decouple the utility model from the main model and pin it to ONE
 * dedicated cheap static-key model. OpenCode Go-backed deepseek-v4-flash is the right choice: cheap,
 * 1M context, strong Chinese, no thinking-format quirks, and it never touches the
 * OAuth account pool. The commercial master's static-provider registry dispatches by model
 * name, so this routes correctly for any proxy-routed session
 * regardless of its main model.
 *
 * The caller gates this: it is applied only when the container routes through the
 * commercial proxy, NOT when host OAuth points CCB directly at api.anthropic.com
 * (where deepseek-v4-flash is not a valid model and Haiku must stay the default).
 * Ops can override the pinned model via OPENCLAUDE_SECONDARY_MODEL.
 */
export const DEFAULT_SECONDARY_UTILITY_MODEL = 'deepseek-v4-flash'

/** Fallback when the parent CCB model is not a catalog-routable CCB slug
 *  (grok-build / cursor-* / claude-haiku / official Claude aliases). Selfhost
 *  catalog has no haiku; CCB Agent `model: "haiku"` otherwise 403s at the
 *  anthropic proxy. Official CCB honors CLAUDE_CODE_SUBAGENT_MODEL above the
 *  tool-specified alias (claude-code-best/src/utils/model/agent.ts).
 *
 *  Must be a member of the platform aux set: egress `modelAuthorityGate` only
 *  admits `{turn lease canonical model} ∪ PLATFORM_AUX_MODEL_IDS` for a turn,
 *  and that set is `[DEFAULT_SECONDARY_UTILITY_MODEL, DEFAULT_CCB_SUBAGENT_MODEL]`
 *  (commercial/billing/modelCatalog.ts imports both constants). Pinning a model
 *  outside the set (glm-5.3-zai before it was added on 2026-09-03) made every
 *  sub-agent under a cursor-* parent 403 `MODEL_AUTHORITY_INVALID`.
 *
 *  2026-09-03: sub-tasks default to grok-build (platform delegate_task) with
 *  glm-5.3-zai as the fallback; CCB Agent sub-agents cannot reach grok (no
 *  Anthropic-compatible grok backend), so they pin the fallback directly. */
// 2026-10-20: the Z.AI route is unavailable; sub-agents pin the platform default instead
// (it is also the secondary utility model, so the aux set dedupes to one id).
export const DEFAULT_CCB_SUBAGENT_MODEL = 'deepseek-v4-flash'

export function isCcbRoutableSubagentModel(model: string | undefined): boolean {
  if (typeof model !== 'string') return false
  const trimmed = model.trim()
  if (!trimmed || !/^[A-Za-z0-9._-]{1,64}$/.test(trimmed)) return false
  if (/^claude-/i.test(trimmed)) return false
  if (/^(haiku|sonnet|opus)(\b|$)/i.test(trimmed)) return false
  if (/^grok/i.test(trimmed) || /^cursor-/i.test(trimmed) || /^gpt-/i.test(trimmed)) return false
  return true
}

/** Sub-agent model for a CCB turn. Parent model when it is catalog-routable
 *  (same turn lease → always admitted); otherwise the ops override, else
 *  DEFAULT_CCB_SUBAGENT_MODEL — a member of the cross-turn aux set the egress
 *  gate accepts. An ops override must also be inside PLATFORM_AUX_MODEL_IDS or
 *  the sub-agent 403s. */
export function resolveCcbSubagentModel(sessionModel?: string): string {
  if (isCcbRoutableSubagentModel(sessionModel)) return sessionModel!.trim()
  const override = process.env.OPENCLAUDE_CCB_SUBAGENT_MODEL?.trim()
  if (isCcbRoutableSubagentModel(override)) return override!
  return DEFAULT_CCB_SUBAGENT_MODEL
}

export function resolveSecondaryUtilityModel(): string {
  return process.env.OPENCLAUDE_SECONDARY_MODEL?.trim() || DEFAULT_SECONDARY_UTILITY_MODEL
}

export function _buildSecondaryUtilityModelEnv(): Record<string, string> {
  return { ANTHROPIC_SMALL_FAST_MODEL: resolveSecondaryUtilityModel() }
}

export const CCB_SUBAGENT_MODEL_ENV = 'CLAUDE_CODE_SUBAGENT_MODEL'

/** Pin CCB built-in Agent/Task default away from unroutable haiku. Omitted on
 *  oauth-direct (real Anthropic, where Haiku is valid). The oauth-direct
 *  branch must still delete the inherited process env at final spawn compose
 *  — returning {} here does not clear `process.env`. */
export function _buildCcbSubagentModelEnv(input: {
  sessionModel?: string
  routing: 'host-static' | 'oauth-direct' | 'settings-default'
}): Record<string, string> {
  if (input.routing === 'oauth-direct') return {}
  return { [CCB_SUBAGENT_MODEL_ENV]: resolveCcbSubagentModel(input.sessionModel) }
}

const CCB_TRANSPORT_INTERNAL_KEYS = [
  'OPENCLAUDE_CCB_HTTPS_PROXY',
  'OPENCLAUDE_CCB_NO_PROXY',
  'OPENCLAUDE_CCB_TZ',
] as const

function assertCredentialFreeHttpProxy(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('OPENCLAUDE_CCB_HTTPS_PROXY must be a valid URL')
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    !parsed.hostname ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('OPENCLAUDE_CCB_HTTPS_PROXY must be a credential-free http(s) origin')
  }
  return parsed.toString().replace(/\/$/, '')
}

/**
 * Build the inherited CCB environment while keeping platform-only transport
 * controls out of the child. When enabled, the same HTTPS proxy is written in
 * both cases, legacy HTTP/ALL proxy variables are removed, and the current
 * internal ANTHROPIC_BASE_URL host must be explicitly present in NO_PROXY.
 */
export function buildCcbSpawnProcessEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source }
  for (const key of CCB_TRANSPORT_INTERNAL_KEYS) delete env[key]

  const proxyRaw = source.OPENCLAUDE_CCB_HTTPS_PROXY?.trim()
  const noProxyRaw = source.OPENCLAUDE_CCB_NO_PROXY?.trim()
  if (proxyRaw) {
    const proxy = assertCredentialFreeHttpProxy(proxyRaw)
    if (!noProxyRaw) {
      throw new Error('OPENCLAUDE_CCB_NO_PROXY is required with OPENCLAUDE_CCB_HTTPS_PROXY')
    }
    const noProxyHosts = new Set(
      noProxyRaw
        .split(',')
        .map((part) => part.trim().replace(/^\[|\]$/g, ''))
        .filter(Boolean),
    )
    const anthropicBase = source.ANTHROPIC_BASE_URL?.trim()
    if (anthropicBase) {
      let internalHost: string
      try {
        internalHost = new URL(anthropicBase).hostname
      } catch {
        throw new Error('ANTHROPIC_BASE_URL must be valid when CCB HTTPS proxying is enabled')
      }
      if (!noProxyHosts.has(internalHost)) {
        throw new Error('OPENCLAUDE_CCB_NO_PROXY must include the ANTHROPIC_BASE_URL host')
      }
    }
    // biome-ignore lint/performance/noDelete: moved verbatim from subprocessRunner.ts (OCV5-478)
    delete env.HTTP_PROXY
    // biome-ignore lint/performance/noDelete: moved verbatim from subprocessRunner.ts (OCV5-478)
    delete env.http_proxy
    // biome-ignore lint/performance/noDelete: moved verbatim from subprocessRunner.ts (OCV5-478)
    delete env.ALL_PROXY
    // biome-ignore lint/performance/noDelete: moved verbatim from subprocessRunner.ts (OCV5-478)
    delete env.all_proxy
    env.HTTPS_PROXY = proxy
    env.https_proxy = proxy
    env.NO_PROXY = noProxyRaw
    env.no_proxy = noProxyRaw
  }

  const timezone = source.OPENCLAUDE_CCB_TZ?.trim()
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
    } catch {
      throw new Error('OPENCLAUDE_CCB_TZ must be a valid IANA timezone')
    }
    env.TZ = timezone
  }
  return env
}

/**
 * Final CCB spawn env: inherit process env, overlay provider routing, then
 * oauth-direct explicitly deletes CLAUDE_CODE_SUBAGENT_MODEL so a leftover
 * host pin cannot override Anthropic Haiku.
 */
export function finalizeCcbSpawnEnv(input: {
  source?: NodeJS.ProcessEnv
  providerEnv: Record<string, string>
  routing: 'host-static' | 'oauth-direct' | 'settings-default'
}): NodeJS.ProcessEnv {
  const source = input.source ?? process.env
  const env: NodeJS.ProcessEnv = {
    ...buildCcbSpawnProcessEnv(source),
    ...input.providerEnv,
  }
  if (input.routing === 'oauth-direct') {
    delete env[CCB_SUBAGENT_MODEL_ENV]
  }
  // Desktop Host injects oc-lah.* + 18791. Keep that pin even if oauth-direct
  // tries to clear inherited ANTHROPIC_* (zero change when token is not oc-lah).
  const lah = source.ANTHROPIC_AUTH_TOKEN
  if (typeof lah === 'string' && /^oc-lah\.[0-9a-f]{64}$/i.test(lah)) {
    env.ANTHROPIC_AUTH_TOKEN = lah
    if (source.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = source.ANTHROPIC_BASE_URL
    // biome-ignore lint/performance/noDelete: moved verbatim from subprocessRunner.ts (OCV5-478)
    delete env.ANTHROPIC_API_KEY
  }
  return env
}

// ─────────────────────────────────────────────────────────────────────────────
// 模型权威批次 · §4 —— CCB 上游 `/v1/messages` 的 per-turn 凭据 header 注入
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 为什么走 `ANTHROPIC_CUSTOM_HEADERS` env + stdin `update_environment_variables`,
 * 而不是改 CCB 源码给它一个「每请求 header」钩子:
 *
 *   1. **CCB 零改动是本方案前提**(descriptor 消费端/签发端都在我们这侧,CCB 只是执行体);
 *   2. CCB 的 Anthropic client **每请求新建**(services/api/client.ts `getAnthropicClient`
 *      无 memo,`withRetry(getClient, …)` 每次重试都重新构造),`defaultHeaders` 里
 *      spread `getCustomHeaders()` —— 该函数**现读** `process.env.ANTHROPIC_CUSTOM_HEADERS`
 *      (换行分隔的 `Name: Value`,支持多 header;`Authorization` 在其后写入,不可被顶掉)。
 *      ⇒ turn 内的 SDK 重试、工具循环、compact 的每一次上游请求都会重新读到当前 env,
 *      **turn lease 的「一次签发、turn 内复用」语义天然成立,无需每请求重签**;
 *   3. CCB stdin 有一等控制消息 `update_environment_variables`(entrypoints/sdk/controlSchemas
 *      + cli/structuredIO 直接写 `process.env`),与 user message 走**同一条管道、按行顺序处理**
 *      ⇒ 「本 turn 的 env 先于本 turn 的第一个 /v1/messages 生效」由管道顺序保证,无竞态。
 *
 * **清位铁律**:每个 turn 都必须重写这个 env(哪怕本 turn 没有凭据 → 写空串)。上一 turn 的
 * envelope 残留到下一 turn = 用 turnId 已被消费的旧票去打上游 → egress 拒 → 用户可见故障;
 * 更是安全面(跨 turn 复用票据)。空串 = CCB 视作未设置(`if (!customHeadersEnv) return {}`),
 * 与本文件既有的 `_buildCcbSpawnTraceEnv` / `_buildCcbUsageAttributionEnv` 的「空串而非省略 key」
 * 约定一致。
 */

/** `OC_MODEL_AUTHORITY=1`(supervisor 在 flag 开启时注入容器;与 modelAuthority.ts 同名 env)。 */
const REQUIRE_AUTHORITY_ENV = 'OC_MODEL_AUTHORITY'

export const MODEL_EXECUTION_DESCRIPTOR_ENV = 'OC_MODEL_EXECUTION_DESCRIPTOR'

export const BOX_NATIVE_CONTEXT_OWNER = 'box-native-v1' as const

/** One listed Box model, kept for fixtures and proofs. Checks use isBoxApiModel. */
export const BOX_NATIVE_CONTEXT_MODEL = BOX_API_MODELS[0].id

export interface CcbExecutionDescriptor {
  readonly canonicalModel: string
  readonly contextWindow: number | null
  readonly capabilityZero: boolean
  readonly supportsThinking: boolean
  readonly supportsVision: boolean
  readonly supportedEfforts: readonly string[]
  readonly contextOwner?: typeof BOX_NATIVE_CONTEXT_OWNER
}

export function shouldRecycleForVisionCapability(
  spawned: CcbExecutionDescriptor | undefined,
  next: CcbExecutionDescriptor | undefined,
): boolean {
  return spawned?.supportsVision !== next?.supportsVision
}

/**
 * 一个 bridge turn 的已验签凭据束(master 铸,inbound 帧携带,gateway 验签后经
 * `TurnExecutionDescriptor` 原样带到这里)。短 authority 只用于启动 turn；CCB 上游请求
 * 仅投影长 lease。本地路径 turn 无此物(见 `resolveTurnRuntime`)。
 */
export interface TurnModelAuthority {
  /** 完整签名 authority envelope(base64url；仅作已消费的入站启动凭据保留)。 */
  readonly authorityEnvelope: string
  /** turn lease envelope(base64url;TTL = 最大 turn 窗口 + grace)。 */
  readonly leaseEnvelope: string
  /** 已验签的 CCB 执行语义；与两张 envelope 同一份 descriptor。 */
  readonly executionDescriptor: CcbExecutionDescriptor
}

/** 本 turn 要挂到每个上游请求上的 header 集合(三者互斥使用见 resolveTurnUpstreamHeaders)。 */
export interface TurnUpstreamHeaders {
  /** `x-oc-model-authority` */
  authority?: string
  /** `x-oc-turn-lease` */
  lease?: string
  /** `x-oc-local-catalog` */
  localCatalog?: string
}

/** header 值非法(含 CR/LF/控制字符/非 ASCII)→ **拒发 turn**,绝不把可注入的值写进 env。 */
export class AuthorityHeaderRejected extends Error {
  constructor(
    readonly header: string,
    message: string,
  ) {
    super(message)
    this.name = 'AuthorityHeaderRejected'
  }
}

/**
 * header 值合法性:只允许可见 ASCII(`\x21`-`\x7E`),即 base64url / JWT 风格 token 的全集。
 *
 * 这不是「洁癖」:`ANTHROPIC_CUSTOM_HEADERS` 是**按 `\n` 切行**解析的,值里一个 `\n` 就能凭空
 * 造出第二个 header(经典 header 注入);空格/控制字符也没有任何合法用途。envelope 本就是
 * base64url(protocol 侧编码保证),所以严格白名单不会误伤,却把注入面压到 0。
 */
function assertHeaderValueSafe(header: string, value: string): void {
  if (value === '' || /[^\x21-\x7e]/.test(value)) {
    throw new AuthorityHeaderRejected(
      header,
      `refusing to inject ${header}: value must be non-empty visible ASCII (no CR/LF/space)`,
    )
  }
}

/**
 * `TurnUpstreamHeaders` → `ANTHROPIC_CUSTOM_HEADERS` 的多行 `Name: Value` 串。
 *
 * 无凭据(undefined / 全空)→ **空串**(清位,见上方铁律)。
 *
 * `traceId`(OCV5-570,方案 §7.3):本 turn 的 canonical traceId,作 `x-openclaude-trace-id` 随 CCB 每个
 * 发往 egress 的请求带上(egress 第 0 步绑定,§7.4)。调用方只在 CCB 上游就是 egress 时传
 * (见 _ccbUpstreamIsEgress)—— 直连外部 provider 的 lane 不带,内部关联信息不出站。不合法的值丢弃
 * (不拒 turn:trace 是观测,不是凭据)。
 */
export function _buildAnthropicCustomHeadersEnv(
  headers: TurnUpstreamHeaders | undefined,
  traceId?: string,
): {
  ANTHROPIC_CUSTOM_HEADERS: string
} {
  const lines: string[] = []
  const push = (name: string, value: string | undefined): void => {
    if (value === undefined) return
    assertHeaderValueSafe(name, value)
    lines.push(`${name}: ${value}`)
  }
  push(AUTHORITY_HEADER, headers?.authority)
  push(TURN_LEASE_HEADER, headers?.lease)
  push(LOCAL_CATALOG_HEADER, headers?.localCatalog)
  const trace = parseTraceIdCandidate(traceId)
  if (traceId !== undefined && trace.ok) push(TRACE_ID_HEADER, trace.traceId)
  return { ANTHROPIC_CUSTOM_HEADERS: lines.join('\n') }
}

/**
 * Whether a spawned CCB talks to egress: its `ANTHROPIC_BASE_URL` is the gateway's own egress base
 * (the same value the gateway's Box clients use). Direct provider lanes (host-static, oauth-direct)
 * and anything else get no internal trace header.
 */
export function _ccbUpstreamIsEgress(
  spawnEnv: NodeJS.ProcessEnv | Record<string, string | undefined>,
  gatewayEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  const norm = (v: string | undefined) => (v ?? '').trim().replace(/\/+$/, '')
  const egress = norm(gatewayEnv.ANTHROPIC_BASE_URL)
  return egress !== '' && norm(spawnEnv.ANTHROPIC_BASE_URL) === egress
}

/** CCB stdin 控制消息(schema:`{ type, variables: Record<string,string> }`)。 */
export function _buildUpdateEnvStdinLine(vars: Record<string, string>): string {
  return `${JSON.stringify({ type: 'update_environment_variables', variables: vars })}\n`
}

/**
 * 本 turn 的上游凭据(单一收口 —— 所有 CCB submit 都经此,任何调用方都不可能漏清位)。
 *
 *   - bridge turn(有 descriptor)      → 默认只挂长命 lease。egress 在同 turn 有效
 *     lease 下仍接受已过期的短 authority(OCV5-242),所以已验签 Box 主 turn
 *     (expectedEngine=ccb、执行模型与 descriptor 是 BOX_API_MODELS 里的同一个模型、
 *     contextOwner=box-native-v1)保留原始 authority+lease 双头。其它模型、缺 cap、
 *     cursor、local 仍只投影原有那一张,不重签。
 *   - 本地路径 turn(cron/synthetic/delegate)且 flag 开 → 现取 `x-oc-local-catalog` token
 *     (**每 turn 现取**:它携带 epoch,缓存下来会在安全变更后带旧 epoch 撞 fence);
 *     取不到(master 不可达 / epoch 验不出)→ 抛 → **拒新 turn**(方案 §3:无 baked 回落);
 *   - flag 未开 / 个人版 / 非托管容器   → undefined → 写空串(egress 侧 gate 未装配,零行为变化)。
 */
function boxNativeDualHeaderTurn(
  authority: TurnModelAuthority,
  model: string | undefined,
  expectedEngine: 'ccb' | 'cursor',
): boolean {
  return (
    expectedEngine === 'ccb' &&
    isBoxApiModel(model) &&
    authority.executionDescriptor.canonicalModel === model &&
    authority.executionDescriptor.contextOwner === BOX_NATIVE_CONTEXT_OWNER
  )
}

/** Renewal replaces the lease on the current turn bundle. Non-Box bundles stay lease-only. */
export function renewTurnHeaderBundle(
  current: TurnUpstreamHeaders | undefined,
  leaseEnvelope: string,
): TurnUpstreamHeaders {
  if (current?.authority !== undefined) {
    return { authority: current.authority, lease: leaseEnvelope }
  }
  return { lease: leaseEnvelope }
}

export async function resolveTurnRuntime(
  authority: TurnModelAuthority | undefined,
  model: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  expectedEngine: 'ccb' | 'cursor' = 'ccb',
): Promise<{ headers?: TurnUpstreamHeaders; descriptor?: CcbExecutionDescriptor }> {
  if (authority) {
    const headers: TurnUpstreamHeaders = boxNativeDualHeaderTurn(authority, model, expectedEngine)
      ? { authority: authority.authorityEnvelope, lease: authority.leaseEnvelope }
      : { lease: authority.leaseEnvelope }
    return { headers, descriptor: authority.executionDescriptor }
  }
  if (env[REQUIRE_AUTHORITY_ENV] !== '1') return {}
  const client = getModelCatalogClient()
  // flag 已开却没装配 catalog = 半开拓扑。此时写空串会让本地 turn 不带任何票据
  // 进入 egress；宁可本地拒绝，也不能把“非托管”当成授权旁路。
  if (!client.configured) {
    throw new ModelCatalogUnavailableError(
      'authority flag enabled but catalog client is not configured',
    )
  }
  if (!model) throw new ModelCatalogUnavailableError('local CCB turn has no canonical model')
  const view = await client.getView()
  const row = view.resolve(view.canonicalize(model))
  if (!row || row.engine !== expectedEngine) {
    throw new ModelCatalogUnavailableError(
      `local ${expectedEngine} model missing from current projection`,
    )
  }
  return {
    headers: { localCatalog: await client.getToken() },
    descriptor: {
      canonicalModel: row.modelId,
      contextWindow: row.contextWindow,
      capabilityZero: row.capabilityZero,
      supportsThinking: row.supportsThinking,
      supportsVision: row.supportsVision,
      supportedEfforts: [...row.supportedEfforts],
      ...(row.contextOwner ? { contextOwner: row.contextOwner } : {}),
    },
  }
}

export class AdvisorExecutionLockError extends Error {
  readonly code = 'ADVISOR_EXECUTION_LOCK_MISMATCH' as const
  constructor(message: string) {
    super(message)
    this.name = 'AdvisorExecutionLockError'
  }
}

export async function assertCcbAdvisorCatalogLock(input: {
  lock: AdvisorConsultExecution | undefined
  model: string | undefined
  env?: NodeJS.ProcessEnv
}): Promise<{ modelId: string; providerId: string; engine: 'ccb' }> {
  const lock = input.lock
  if (!lock || lock.engine !== 'ccb' || lock.profileVersion !== CCB_ADVISOR_PROFILE_VERSION) {
    throw new AdvisorExecutionLockError('ccb advisor requires a frozen model/provider/profile lock')
  }
  const client = getModelCatalogClient()
  if (!client.configured) {
    throw new AdvisorExecutionLockError('ccb advisor catalog ticket unavailable')
  }
  const view = await client.getView()
  const canonical = view.canonicalize(input.model || lock.modelId)
  const row = view.resolve(canonical)
  if (!row || row.engine !== 'ccb' || row.available === false) {
    throw new AdvisorExecutionLockError('ccb advisor model missing from current catalog projection')
  }
  const providerId = (row.providerId ?? '').trim()
  if (row.modelId !== lock.modelId || providerId !== lock.providerId) {
    throw new AdvisorExecutionLockError(
      'ccb advisor catalog ticket does not match frozen model/provider',
    )
  }
  return { modelId: row.modelId, providerId, engine: 'ccb' }
}

export interface HostSpawnProviderEnvInput {
  /** 已解析的执行模型(sessionManager.executionModel;可能 undefined=沿用 CCB 默认)。 */
  model: string | undefined
  /** agent.provider ?? config.provider(claude-subscription 触发 OAuth direct-Anthropic)。 */
  effectiveProvider: string | undefined
  /** host claude OAuth access token(仅 claude-subscription 且有 token 时 direct-Anthropic)。 */
  claudeOAuthAccessToken?: string
  /** 测试注入平台静态 key 表;省略(undefined)→ 用 hostStaticProviders 模块级 seam。 */
  hostStaticKeys?: StaticProviderKeys | null
  /** 测试注入 env;省略 → process.env(容器判定 / NO_PROXY 追加)。 */
  env?: NodeJS.ProcessEnv
}

export interface HostSpawnProviderEnv {
  /** 注入 spawn 的 provider 路由 env(合并进 providerEnv)。 */
  env: Record<string, string>
  /**
   * 实际选中的出站路由(单一权威,决定 spawn 行为):
   *   - 'host-static'      : 平台静态 provider 直连(BASE_URL+平台 key);
   *   - 'oauth-direct'     : claude OAuth 直连 api.anthropic.com(清空 BASE_URL/AUTH_TOKEN);
   *   - 'settings-default' : 不注入 provider auth,靠 settings.json / 容器 proxy env。
   */
  routing: 'host-static' | 'oauth-direct' | 'settings-default'
  /** routing==='host-static' 时命中的 provider id(日志用)。 */
  providerId?: string
}

/**
 * host CCB spawn 的 **provider 路由 env 决策**(单一收口)。
 *
 * 出站路由优先级(**host 静态直连高于 agent 的 provider 配置**):
 *   1. host 静态 provider 命中(resolveHostStaticProviderEnv 非 null:仅 host 非容器 + commercial
 *      seam 已注入 + 模型属静态 provider)→ **静态路由优先**,claude-subscription / settings.json
 *      分支整体让位。这与 resolveSyntheticTurnModel 的 `isHostRoutableStaticModel` 自检**严格对称**:
 *      helper 判"可降级到静态模型" ⟺ spawn 一定按静态路由起进程。否则会出现"自检说 deepseek 可路由、
 *      但 agent=claude-subscription 时 spawn 走 OAuth direct-Anthropic 把 deepseek 发去 api.anthropic.com
 *      必挂"的对称性缺陷(Codex MAJOR 2026-07-07)。
 *   2. 否则 claude-subscription + 有 OAuth token → direct-Anthropic(清空 BASE_URL/AUTH_TOKEN)。
 *   3. 否则 settings.json / 容器 proxy env 掌权。
 *
 * secondary utility model(CCB 隐藏 WebFetch/hook/search 调用的 ANTHROPIC_SMALL_FAST_MODEL):
 *   - host-static:必须**同 provider 可路由**(否则 deepseek-v4-flash 会被打到本 provider 端点如
 *     ark 被拒 —— Codex MINOR)。protocol spec 无专门 small/utility 字段 → 保守用主执行模型兜底
 *     (它就是路由依据,一定同 provider);
 *   - oauth-direct:不注入(留 CCB 的 Anthropic-native Haiku 默认,deepseek 不可路由到 api.anthropic.com);
 *   - settings-default:注入 deepseek-v4-flash(容器经 internal proxy 按模型名可达),行为不变。
 *
 * key 缺失时 resolveHostStaticProviderEnv **throw**(fail-closed)→ 由本函数原样冒泡,调用方 spawn 前
 * 清理 starting/binding 并 rethrow。
 */
export function buildHostSpawnProviderEnv(input: HostSpawnProviderEnvInput): HostSpawnProviderEnv {
  const providerEnv: Record<string, string> = {}
  const hostStatic = resolveHostStaticProviderEnv(input.model, {
    keys: input.hostStaticKeys,
    env: input.env,
  })
  if (hostStatic) {
    // 静态路由优先:provider 分支整体让位。
    Object.assign(providerEnv, hostStatic.env)
    // secondary 同 provider 可路由,用主执行模型兜底(不跨 provider 打错)。
    if (input.model) providerEnv.ANTHROPIC_SMALL_FAST_MODEL = input.model
    Object.assign(
      providerEnv,
      _buildCcbSubagentModelEnv({
        sessionModel: input.model,
        routing: 'host-static',
      }),
    )
    return { env: providerEnv, routing: 'host-static', providerId: hostStatic.providerId }
  }
  if (input.effectiveProvider === 'claude-subscription') {
    // Claude subscription: 让 host 掌握 provider 路由(CCB 从 settings.json strip provider vars)。
    providerEnv.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    if (input.claudeOAuthAccessToken) {
      providerEnv.CLAUDE_CODE_OAUTH_TOKEN = input.claudeOAuthAccessToken
      // direct-Anthropic:清空继承的 BASE_URL/AUTH_TOKEN,防 settings.json 把 OAuth 流量重定向到
      // 兼容端点窃取。防御纵深(MANAGED_BY_HOST 已 strip settings 来源,这里再防 shell env 泄漏)。
      providerEnv.ANTHROPIC_BASE_URL = ''
      providerEnv.ANTHROPIC_AUTH_TOKEN = ''
      providerEnv.ANTHROPIC_MODEL = ''
      // direct-Anthropic 路径不 pin deepseek-v4-flash(不可路由到 api.anthropic.com),留 Haiku 默认。
      return { env: providerEnv, routing: 'oauth-direct' }
    }
    // 无 host OAuth:容器 boot 时已注入 ANTHROPIC_* 指向 internal proxy,不动;仍走 secondary pin。
  }
  // settings.json / 容器 proxy env 掌权;secondary 走全局 deepseek-v4-flash(容器可达)。
  Object.assign(providerEnv, _buildSecondaryUtilityModelEnv())
  Object.assign(
    providerEnv,
    _buildCcbSubagentModelEnv({
      sessionModel: input.model,
      routing: 'settings-default',
    }),
  )
  return { env: providerEnv, routing: 'settings-default' }
}

// ───────────────────────────────────────────────
// SubprocessRunner
//
// 给单个 sessionKey 长驻一个 CCB 子进程。
// CCB 命令行:
//   <runtime> <ccb-entry> -p \
//     --input-format=stream-json \
//     --output-format=stream-json \
//     --include-partial-messages \
//     [--resume <sessionId>] \
//     [--system-prompt-file <persona>] \
//     [--add-dir <cwd>] \
//     [--permission-mode <mode>]
//
// 我们写入 stdin 一行 JSON(SDK user message),从 stdout 读流式 JSONL(SDK 消息流)。
// CCB 自己处理 auth(订阅 OAuth / API key)、工具循环、压缩、CLAUDE.md。
// ───────────────────────────────────────────────

export interface SubprocessRunnerOpts {
  /** Actual chat peer; sessionId below may be a delegated repository parent. */
  peerId?: string
  sessionKey: string
  agentId: string
  /** Phase 5 重命名(原 `cwd`):agent 的项目基础目录 = 没绑定 GitHub repo 时
   *  CCB 的 --add-dir / Docker workspaceHostDir。绑了 ready repo 时,本字段
   *  会被 effectiveAddDir(由 getRepoSnapshot 返的 workspaceDir)覆盖。 */
  agentBaseDir: string
  config: OpenClaudeConfig
  identityCompat?: IdentityCompatRuntimeContext
  persona?: string // 注入 system prompt 的文件
  model?: string
  /** Platform-owned per-adapter provider route. Never populated from user or
   * catalog text. Applied after the normal provider policy so a specialized
   * engine can bind CCB to a capability-scoped loopback relay. */
  providerEnvOverride?: Record<string, string>
  /** Engine expected in the signed/local catalog descriptor when CCB is used
   * as another engine's local tool loop. Defaults to ccb. */
  authorityEngine?: 'ccb' | 'cursor'
  /** Platform-selected Cursor account-pool binding. It is minted by the
   * root-owned oc-cursor selector, never from user/catalog input. The binding
   * stays fixed for one EngineAdapter session so Sand/native transport changes
   * are invisible to the user and cannot silently discard native history. */
  cursorCredentialSelection?: {
    slot: number
    keyName: string
    sandEnabled: boolean
    poolGeneration: string
    accountId: string
    keyFingerprint: string
    /** 0257 — `session` slots carry a Cursor account session token (Sand-only). */
    credentialKind: 'api_key' | 'session'
    machineId: string | null
    /** OCV5-378: an interactive Box session (box-claude-*) whose Box comes from the master; minted by the
     * gateway (masterBoxCredentialSelection), names no key or account, carries no credential. */
    masterBox?: true
  }
  /** Agent-loop implementation. Omitted follows `resolveCcbHarness` (CCB
   * unless `OC_CCB_OFFICIAL_CC=1`). Official-cc is either Cursor Sand
   * loopback (`authorityEngine=cursor`) or the engine=ccb Anthropic proxy. */
  harness?: 'ccb' | 'official-cc'
  /** Official Claude Code runs inside the selected account's Grok Bot box. */
  boxResidentCc?: boolean
  /** Writes the 0600 exec control file on first spawn. */
  prepareBoxCc?: () => Promise<string>
  permissionMode?: string
  resumeSessionId?: string // 续上之前的 CCB session
  /** Engine-agnostic durable-artifact ladder: given the native id the engine
   *  just declared stale, return a prior id for the SAME engine whose transcript
   *  still exists on disk (or undefined). Consumed by engines that self-heal a
   *  stale resume inside their own turn loop (codex thread/resume). */
  resolveResumeFallback?: (staleId: string) => string | undefined
  // Per-agent overrides
  agentProvider?: string // 覆盖 config.provider
  agentMcpServers?: McpServerConfig[] // agent 专属 MCP servers
  agentToolsets?: string[] // resolved toolsets for this agent (filters MCP servers)
  delegationDepth?: number // current delegation recursion depth (0 = top-level)
  /** delegate 子会话计费归因(→ CLAUDE_CODE_EXTRA_METADATA env,见
   *  _buildCcbUsageAttributionEnv)。仅 delegate 会话由 handleDelegateTask 设置。 */
  usageAttribution?: UsageAttributionTag
  // Optional CCB effort level passed via env (CLAUDE_CODE_EFFORT_LEVEL).
  // When undefined, no env var is set and CCB falls back to its model-default
  // effort (typically "high" on Opus 4.7 per Anthropic API). Only set values
  // CCB recognises in EFFORT_LEVELS — currently 'low'|'medium'|'high'|'xhigh'|'max'.
  // Source-of-truth lives in claude-code-best/src/utils/effort.ts.
  effortLevel?: string
  /**
   * 执行目标。undefined / { kind:'local' } → CCB 所有工具在本地容器里执行(默认)。
   * { kind:'remote', ... } → 下次 spawn 时注入 OC_REMOTE_* env,CCB RemoteExecutor
   * 启用 ssh ControlMaster 分支。env 只在 spawn 时读,调用 setExecutionTarget()
   * 后需要 shutdown() 让下次 submit 触发重启才能生效 —— 与 setEffortLevel 同构。
   */
  executionTarget?: ExecutionTarget
  /** Phase 5:peerId / sessionId(用于 getRepoSnapshot 查询当前 repo 状态)。
   *  理论上 sessionKey 已经能推出 sessionId,但为避免重复解析串错,显式传。
   *  null/undefined → 不查 repo snapshot(Codex / 旧调用兼容)。 */
  sessionId?: string
  /** Bound taskboard / chat project id for MCP skill overlay. */
  projectId?: string
  /** Unique run-context authority. Engines must not invent runId/projectId. */
  runContext?: import('./runContextPersist.js').RunContextDescriptor
  frozenProjectContext?: import('@openclaude/storage').FrozenProjectContext | null
  /** Phase 5:读 SessionRepoWorkspaceManager 的 RepoSnapshot(单进程下即权威 state)。
   *  在 start() 内调用一次,用于:
   *    1) 决定 effective addDir(ready 时切到 workspaceDir,其它情况 fall-back agentBaseDir)
   *    2) 写 _boundRepoBinding(只有 ready 状态才记)
   *  undefined 或返 null → 等同于"未绑定",addDir = agentBaseDir。 */
  getRepoSnapshot?: (sessionId: string) => RepoSnapshot | null
  /** V3 S12e CG8 — contract C(best-effort)turn trace stash for env injection.
   *  当 spawn 发生时通过 `OPENCLAUDE_TRACE_ID` env 注入,CCB 子进程内部如何使用是
   *  CCB 仓事,gateway 端不验证(S12e 不算贯通硬门)。
   *
   *  生命周期与 `effortLevel` / `model` / `executionTarget` 同构:
   *    - 缓存在 opts 上,**只在 spawn 时被读**;长驻进程内 setTraceId() 不影响当前
   *      子进程,需触发 shutdown() / 等下次 submit() 自动 respawn 才生效。
   *    - 后续 turn 的 traceId 物理上无法 refresh 到已 spawn 的 env(env 在 fork
   *      时确定);完整 per-turn CCB trace 接收要走 stdin JSON-RPC 扩展,留 S11c。
   *
   *  通过 `setTraceId()` 在 sessionManager.submit() 的 lock 内 mutate;无 side
   *  effect(不主动 restart),与现有 setEffortLevel/setModel 同步。 */
  traceId?: string
  /**
   * Workload tag threaded to CCB's `--workload <tag>` flag, which CCB writes
   * into `x-anthropic-billing-header` as `cc_workload=<tag>`. Anthropic uses
   * it to route e.g. cron-initiated traffic to a lower-QoS pool, keeping
   * automated background calls from competing with interactive user calls
   * for rate-limit headroom.
   *
   * Runner creation-time attribute — fixed for the life of the subprocess.
   * Don't try to mutate per-turn: CCB consumes the value through
   * `runWithWorkload(cmd.workload ?? options.workload, ...)` in print.ts and
   * `options.workload` is set once at process startup.
   *
   * CCB sanitizer accepts lowercase `[a-z0-9_-]{0,32}` only — callers should
   * pass values matching that shape (currently only `'cron'`).
   */
  workload?: string
  /**
   * Skill-training run id. Set ONLY when this session is a SkillOpt training run;
   * forwarded to the mcp-memory subprocess as `OPENCLAUDE_SKILL_TRAIN_RUN_ID`, which
   * gates the draft-only `skill_propose` tool and binds its writes to this run.
   * Spawn-time attribute (read once when the mcp env is built), like delegationDepth.
   */
  skillTrainRunId?: string
  /** Skill-eval 会话标记(禁 skill 写入,mcp env OPENCLAUDE_SKILL_EVAL_MODE=1)。 */
  skillEvalMode?: boolean
  /** Skill-eval 'without' arm:隐藏该技能(prompt SKILLS 摘要 + mcp skill_* 双侧)。 */
  skillEvalExclude?: string
  /** Skill-eval 'draft' arm:以草稿目录替换该技能。 */
  skillEvalDraft?: { name: string; dir: string }
  /** V5 Auto-Dream one-shot isolation profile (CCB only). */
  hermeticNoTools?: boolean
  /**
   * Frozen CCB advisor execution. Required when hermeticNoTools && agentId==='advisor';
   * last catalog ticket at spawn/submit must match model+provider+profile.
   */
  advisorExecutionLock?: AdvisorConsultExecution
  /** CCB --json-schema contract. Currently used only by the hermetic Auto-Dream turn. */
  structuredOutputSchema?: Readonly<Record<string, unknown>>
}

// CCB 输出的 SDK message 类型(简化):兼容 stream-json 输出
export interface SdkMessage {
  type: string
  subtype?: string
  session_id?: string
  message?: {
    role?: string
    content?: Array<{
      type: string
      text?: string
      name?: string
      input?: unknown
      tool_use_id?: string
      is_error?: boolean
    }>
    stop_reason?: string
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  result?: string
  stop_reason?: string | null
  terminal_reason?: string
  total_cost_usd?: number
  duration_ms?: number
  is_error?: boolean
  structured_output?: unknown
}

/** Permission response from the user (sent back to CCB as control_response) */
export type PermissionResponse =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; toolUseID?: string }
  | { behavior: 'deny'; message: string; toolUseID?: string }

/**
 * CCB builtin tools the platform strips from every non-hermetic session.
 *
 * `SendMessage` only writes `~/.claude/teams/<team>/inboxes/<agent>.json`.
 * OpenClaude never consumes that mailbox (OCV5-45). `--disallowedTools`
 * lands in CCB `alwaysDenyRules.cliArg`, so `filterToolsByDenyRules`
 * removes it from the model-visible pool and permission step 1a still
 * denies it under bypassPermissions. In-process Agent/Task/teammates
 * inherit the same permission context / filtered pool.
 */
export const CCB_PLATFORM_DISALLOWED_TOOLS = ['SendMessage'] as const

/** Official Claude Code has its own cron scheduler. OpenClaude's gateway cron
 * is the only scheduling authority, so the initial official-CC lane removes
 * both the black-hole team mailbox and the duplicate scheduler surface. */
export const OFFICIAL_CC_PLATFORM_DISALLOWED_TOOLS = [
  'SendMessage',
  'CronList',
  'CronCreate',
  'CronDelete',
  'ScheduleWakeup',
] as const

const OFFICIAL_CC_CURSOR_SAND_LOOPBACK_RE = /^http:\/\/127\.0\.0\.1:\d+\/route\/[0-9a-f]{64}$/

/** The stock CLI is allowed only behind the capability-scoped Cursor Sand
 * loopback relay. Keep this pure seam exported so the fail-closed binding is
 * regression-testable without spawning a real CLI. */
export function isOfficialClaudeCursorSandLoopbackEnv(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    OFFICIAL_CC_CURSOR_SAND_LOOPBACK_RE.test(env.ANTHROPIC_BASE_URL ?? '') &&
    env.ANTHROPIC_AUTH_TOKEN === 'cursor-sand-loopback'
  )
}

/** Master/container flag: engine=ccb models spawn stock Claude Code instead of
 * claude-code-best. Cursor Sand keeps its own `OC_CURSOR_SAND_OFFICIAL_CC`. */
export function ccbOfficialCcEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OC_CCB_OFFICIAL_CC === '1'
}

/** Explicit `opts.harness` wins; otherwise `OC_CCB_OFFICIAL_CC=1` selects the
 * stock CLI. Default remains CCB. */
/** OCV5-383: only CCB (not official Claude Code, not the Box-resident CLI)
 *  understands the static-first extra-prompt layout. */
export function usesStaticFirstPromptLayout(
  harness: ReturnType<typeof resolveCcbHarness>,
  boxResidentCc: boolean | undefined,
): boolean {
  return harness === 'ccb' && !boxResidentCc
}

export function resolveCcbHarness(
  optsHarness: 'ccb' | 'official-cc' | undefined,
  env: NodeJS.ProcessEnv = process.env,
): 'ccb' | 'official-cc' {
  if (optsHarness === 'ccb' || optsHarness === 'official-cc') return optsHarness
  return ccbOfficialCcEnabled(env) ? 'official-cc' : 'ccb'
}

export class BoxNativeHarnessError extends Error {
  constructor(readonly code: 'BOX_NATIVE_CONTEXT_MISMATCH' | 'BOX_NATIVE_HARNESS_LOCKED') {
    super(code)
    this.name = 'BoxNativeHarnessError'
  }
}

/** Project the signed profile into the env descriptor. Does not read body or env. */
export function projectCcbExecutionDescriptor(input: {
  canonicalModel: string
  contextWindow: number | null
  supportsVision: boolean
  supportedEfforts: readonly string[]
  capabilityProfile: Readonly<Record<string, unknown>>
}): CcbExecutionDescriptor {
  const raw = input.capabilityProfile.ccb
  const ccb = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  if (ccb.contextOwner !== undefined && ccb.contextOwner !== BOX_NATIVE_CONTEXT_OWNER) {
    throw new BoxNativeHarnessError('BOX_NATIVE_CONTEXT_MISMATCH')
  }
  if (ccb.contextOwner === BOX_NATIVE_CONTEXT_OWNER && !isBoxApiModel(input.canonicalModel)) {
    throw new BoxNativeHarnessError('BOX_NATIVE_CONTEXT_MISMATCH')
  }
  return {
    canonicalModel: input.canonicalModel,
    contextWindow: input.contextWindow,
    capabilityZero: ccb.capabilityZero === true,
    supportsThinking: ccb.supportsThinking === true,
    supportsVision: input.supportsVision,
    supportedEfforts: [...input.supportedEfforts],
    ...(ccb.contextOwner === BOX_NATIVE_CONTEXT_OWNER
      ? { contextOwner: BOX_NATIVE_CONTEXT_OWNER }
      : {}),
  }
}

/**
 * A new runner with a valid signed Box context owner explicitly selects the
 * CCB fork. An already-spawned official process is not swapped. Missing the
 * token leaves the caller harness, including OC_CCB_OFFICIAL_CC, unchanged.
 */
export function applyBoxNativeHarness(input: {
  model: string | undefined
  descriptor: CcbExecutionDescriptor | undefined
  harness: 'ccb' | 'official-cc' | undefined
  spawned: boolean
}): 'ccb' | 'official-cc' | undefined {
  if (input.descriptor?.contextOwner !== BOX_NATIVE_CONTEXT_OWNER) return input.harness
  if (!isBoxApiModel(input.model) || input.descriptor.canonicalModel !== input.model) {
    throw new BoxNativeHarnessError('BOX_NATIVE_CONTEXT_MISMATCH')
  }
  if (input.spawned && resolveCcbHarness(input.harness) !== 'ccb') {
    throw new BoxNativeHarnessError('BOX_NATIVE_HARNESS_LOCKED')
  }
  return 'ccb'
}

/** Fail-closed spawn gates for official-cc. Cursor still requires the Sand
 * loopback override; engine=ccb uses the same Anthropic proxy as CCB.
 * Hermetic advisor and remote-ssh stay on CCB. */
export function assertOfficialCcSpawnPreconditions(opts: {
  authorityEngine?: 'ccb' | 'cursor'
  providerEnvOverride?: Record<string, string>
  hermeticNoTools?: boolean
  executionTarget?: { kind?: string } | null
}): void {
  if (opts.hermeticNoTools || opts.executionTarget?.kind === 'remote') {
    throw new Error('OFFICIAL_CC_REQUIRES_LOCAL_NON_HERMETIC')
  }
  if (opts.authorityEngine === 'cursor' && !opts.providerEnvOverride) {
    throw new Error('OFFICIAL_CC_REQUIRES_LOCAL_CURSOR_SAND_LOOPBACK')
  }
}

/** Spawn-time env for official-cc on the engine=ccb proxy lane. Stock CLI has
 * no `update_environment_variables`; headers must be present at process start. */
export function buildOfficialCcProxySpawnEnv(input: {
  headers: TurnUpstreamHeaders | undefined
  usageAttribution?: UsageAttributionTag
  turnKey?: string
  executionDescriptorEnv: string
}): Record<string, string> {
  return {
    ..._buildAnthropicCustomHeadersEnv(input.headers),
    ..._buildCcbUsageAttributionEnv(input.usageAttribution, input.turnKey),
    [MODEL_EXECUTION_DESCRIPTOR_ENV]: input.executionDescriptorEnv,
    CLAUDE_CODE_MAX_RETRIES: '0',
  }
}

export function officialCcProxySpawnFingerprint(vars: Record<string, string>): string {
  return JSON.stringify(vars)
}

/**
 * Inputs for `buildCcbCliArgs`. Everything that influences the subprocess's
 * CLI argv lives here so the argv construction is a pure function — trivially
 * unit-testable, no side effects, no file I/O.
 */
export interface CcbCliArgsInput {
  /** e.g. 'bun' or 'node' (maps to `run` vs `--experimental-strip-types`) */
  runtime: string
  /** Entry file path, e.g. src/entrypoints/cli.tsx */
  entry: string
  model?: string
  permissionMode?: string
  extraPromptFile?: string
  mcpConfigFile?: string
  addDir?: string
  resumeSessionId?: string | null
  /**
   * 屏蔽 CCB 的 Project / Local CLAUDE.md 自动扫描,只读 User memory
   * (= `${CLAUDE_CONFIG_DIR}/CLAUDE.md`,在 v3 商业版容器里就是平台基线 ro mount)。
   *
   * 商业版 v3 用户容器镜像里 `/opt/openclaude/` 仓库副本含 `CLAUDE.md`、
   * `claude-code-best/CLAUDE.md` 等内部文件,默认情况下 CCB 项目内存父链扫描会
   * 把它们注入系统提示 → 个人版 dev 流程 / 反编译声明等敏感信息泄露给商业版用户。
   * 启用此项后,CCB 启动时传 `--setting-sources user`,Project + Local 全跳过,
   * 仅保留平台显式 mount 的 baseline CLAUDE.md(走 User memory 通道)。
   *
   * 个人版 / dev 实例不应启用 —— boss 自己使用时仍要 Project memory(本仓 CLAUDE.md)。
   */
  restrictedMemorySources?: boolean
  /**
   * Workload tag → CCB `--workload <tag>` → `cc_workload=<tag>` in the
   * attribution header. CCB sanitizer rejects anything outside
   * `[a-z0-9_-]{0,32}`, so pass only lowercase short tags
   * (currently only `'cron'`).
   */
  workload?: string
  /** V5 Auto-Dream one-shot: no ambient prompt, filesystem context, tools, MCPs or resume. */
  hermeticNoTools?: boolean
  /** Explicit bare-mode settings containing only the env-backed apiKeyHelper. */
  settingsFile?: string
  /** Static structured-output contract passed to CCB --json-schema. */
  structuredOutputSchema?: Readonly<Record<string, unknown>>
}

/**
 * Build the argv array that we pass to the CCB subprocess.
 *
 * IMPORTANT invariant: `--permission-prompt-tool stdio` is always present,
 * regardless of `permissionMode`. CCB's permissions.ts step 1e keeps
 * `requiresUserInteraction()` tools (AskUserQuestion, ExitPlanMode, …)
 * bypass-immune — they still return `behavior:'ask'` even in
 * bypassPermissions mode. Without a permission-prompt-tool, that ask falls
 * through `getCanUseToolFn`'s fallback branch in CCB's print.ts and
 * toolExecution.ts then treats the unresolved ask as a deny, surfacing the
 * tool's raw ask-message (e.g. "Answer questions?") as the tool error.
 *
 * Non-interactive tools are unaffected — step 2a's bypass-allow in
 * permissions.ts fires before any ask result is ever produced for them.
 */

export function resolveClaudeCodeLaunch(
  config: OpenClaudeConfig,
  env: NodeJS.ProcessEnv = process.env,
): { binaryDir: string; entry: string; runtime: 'bun' | 'node' } {
  const pathRaw = env.OPENCLAUDE_CLAUDE_CODE_PATH?.trim() || config.auth.claudeCodePath
  const binaryDir = resolve(pathRaw)
  const entryRaw =
    env.OPENCLAUDE_CLAUDE_CODE_ENTRY?.trim() ||
    config.auth.claudeCodeEntry ||
    'src/entrypoints/cli.tsx'
  const entry = isAbsolute(entryRaw) ? entryRaw : resolve(binaryDir, entryRaw)
  const runtimeRaw =
    env.OPENCLAUDE_CLAUDE_CODE_RUNTIME?.trim() || config.auth.claudeCodeRuntime || 'bun'
  const runtime: 'bun' | 'node' = runtimeRaw === 'node' ? 'node' : 'bun'
  return { binaryDir, entry, runtime }
}

export function buildCcbCliArgs(input: CcbCliArgsInput): string[] {
  const {
    runtime,
    entry,
    model,
    permissionMode,
    extraPromptFile,
    mcpConfigFile,
    addDir,
    resumeSessionId,
    restrictedMemorySources,
    workload,
    hermeticNoTools,
    settingsFile,
    structuredOutputSchema,
  } = input
  const args: string[] = [
    ...(runtime === 'bun' ? ['run']
      : Number(process.versions.node.split('.')[0]) >= 22 ? ['--experimental-strip-types'] : []),
    entry,
    '-p',
    '--input-format=stream-json',
    '--output-format=stream-json',
    '--include-partial-messages',
    '--verbose',
  ]
  if (model) args.push('--model', model)
  if (!hermeticNoTools && permissionMode) {
    args.push('--permission-mode', permissionMode)
    // bypassPermissions 需要配合 --dangerously-skip-permissions 才真正放行所有工具
    if (permissionMode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions')
    }
  }
  // See function JSDoc: stdio prompting must be enabled in ALL modes so CCB
  // emits `can_use_tool` control_requests on stdout that the gateway bridges
  // to the web frontend. Required even under bypassPermissions for
  // interactive tools like AskUserQuestion.
  //
  // `--disallowedTools` is variadic (`<tools...>`). Place it immediately
  // before another `--flag` so Commander cannot swallow the trailing empty
  // prompt placeholder as a second tool name.
  if (!hermeticNoTools) {
    args.push('--disallowedTools', ...CCB_PLATFORM_DISALLOWED_TOOLS)
    args.push('--permission-prompt-tool', 'stdio')
  }
  if (hermeticNoTools) {
    args.push('--bare', '--tools', '', '--strict-mcp-config')
  }
  // Non-hermetic: platform efficiency PreToolUse hooks. Hermetic: apiKeyHelper-only
  // settings from Auto-Dream. Both go through the same --settings flag.
  if (settingsFile) args.push('--settings', settingsFile)
  // Single merged prompt file: persona + identity + platform + skills + memory
  // (Cannot pass --append-system-prompt-file twice; Commander takes last value only)
  if (!hermeticNoTools && extraPromptFile) args.push('--append-system-prompt-file', extraPromptFile)
  // Wire up MCP memory/skills/search server
  if (mcpConfigFile) args.push('--mcp-config', mcpConfigFile)
  if (!hermeticNoTools && addDir) args.push('--add-dir', addDir)
  if (!hermeticNoTools && resumeSessionId) args.push('--resume', resumeSessionId)
  // v3 商业版用户容器: 只允许 User memory(=平台 baseline ro mount), Project/Local 全跳过。
  // 见 CcbCliArgsInput.restrictedMemorySources 注释。
  if (!hermeticNoTools && restrictedMemorySources) args.push('--setting-sources', 'user')
  // CCB `--workload <tag>` is a hidden CLI flag intended for SDK daemon
  // callers that spawn CCB for background work (cron / scheduled tasks).
  // The tag is wrapped around every turn via runWithWorkload() in print.ts
  // and surfaces as `cc_workload=<tag>` in x-anthropic-billing-header,
  // letting Anthropic route the traffic at a lower QoS.
  if (workload) args.push('--workload', workload)
  if (structuredOutputSchema) {
    args.push('--json-schema', JSON.stringify(structuredOutputSchema))
  }
  // 必须给一个 prompt placeholder,CCB stream-json 会从 stdin 接管
  args.push('')
  return args
}

export interface OfficialClaudeCliArgsInput {
  model?: string
  permissionMode?: string
  extraPromptFile?: string
  mcpConfigFile?: string
  settingsFile?: string
  addDir?: string
  resumeSessionId?: string | null
  restrictedMemorySources?: boolean
}

/** Build argv for the stock `@anthropic-ai/claude-code` binary. Keep this
 * separate from buildCcbCliArgs: CCB-only flags (`--workload`, `--bare`,
 * `--json-schema`) and its trailing prompt placeholder must never leak into
 * the official CLI. `--add-dir` is last because official CC declares it as a
 * variadic option and would otherwise consume later tokens as directories. */
export function buildOfficialClaudeCliArgs(input: OfficialClaudeCliArgsInput): string[] {
  const args = [
    '-p',
    '--input-format=stream-json',
    '--output-format=stream-json',
    '--include-partial-messages',
    '--verbose',
  ]
  if (input.model) args.push('--model', input.model)
  if (input.permissionMode) {
    args.push('--permission-mode', input.permissionMode)
    if (input.permissionMode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions')
    }
  }
  args.push('--disallowedTools', ...OFFICIAL_CC_PLATFORM_DISALLOWED_TOOLS)
  args.push('--permission-prompt-tool', 'stdio')
  if (input.settingsFile) args.push('--settings', input.settingsFile)
  if (input.extraPromptFile) args.push('--append-system-prompt-file', input.extraPromptFile)
  if (input.mcpConfigFile) args.push('--mcp-config', input.mcpConfigFile)
  if (input.resumeSessionId) args.push('--resume', input.resumeSessionId)
  if (input.restrictedMemorySources) args.push('--setting-sources', 'user')
  if (input.addDir) args.push('--add-dir', input.addDir)
  return args
}

// Stderr is operational logging, not paid model output, so retain a bounded
// single-line guard for a wedged/corrupt child. Stdout is intentionally NOT
// capped: every valid stream-json line may contain model-authored text or a
// tool result and must reach the lossless turn tape byte-for-byte. The old
// shared 8 MiB cap killed CCB before parsing an oversized but valid JSON line,
// irreversibly discarding exactly the content this persistence path protects.
//
// Keep the existing env name for rolling operational compatibility; it now
// controls stderr only.
function readStderrBufCap(): number {
  const raw = Number(process.env.OPENCLAUDE_CCB_MAX_STDOUT_BUF_BYTES)
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.max(raw, 1 << 20), 256 << 20)
  }
  return 8 << 20
}

export const MAX_STDERR_BUF_BYTES = readStderrBufCap()

/** Logged stderr tail, cut only after redaction. */
const CRASH_STDERR_TAIL_CHARS = 2000

/** Raw stderr kept per process generation for the crash log. */
const CRASH_STDERR_RAW_CHARS = 8000

/**
 * Append to the raw tail without ever splitting a line: when the buffer is
 * trimmed, drop the cut line entirely so a credential's marker (`TOKEN=`) can
 * never be separated from its value before redaction runs.
 */
export function appendCrashStderrTail(tail: string, chunk: string): string {
  const next = tail + chunk
  if (next.length <= CRASH_STDERR_RAW_CHARS) return next
  const cut = next.slice(-CRASH_STDERR_RAW_CHARS)
  const nl = cut.indexOf('\n')
  return nl === -1 ? '' : cut.slice(nl + 1)
}

/**
 * A crash log carries the child's last stderr lines so a one-shot failure
 * (e.g. the hermetic Auto-Dream turn) can be diagnosed. stderr is operational
 * output, but scrub anything credential-shaped before it reaches the log.
 */
export function redactCrashStderrTail(raw: string): string {
  return (
    raw
      .replace(/\bbearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
      .replace(
        /(authorization|bearer|api[_-]?key|token|secret|password|cookie)(["'\s:=]+)[^\s"',;]+/gi,
        '$1$2[redacted]',
      )
      .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]+/g, '[redacted]')
      // Long opaque runs (keys, hex digests). `/` stays out so file paths survive.
      .replace(/\b[A-Za-z0-9+_-]{40,}={0,2}/g, '[redacted]')
      .slice(-CRASH_STDERR_TAIL_CHARS)
  )
}
