/**
 * Safe per-engine route overrides (codex / antigravity / zcode / grok)
 *
 * Moved verbatim out of server.ts (FINDINGS §7.6, OCV5-484); server.ts re-exports
 * these names, so importers are unchanged.
 */
import { join } from 'node:path'
import { V3_CODEX_RELAY_PREFIX } from './v3CodexRelay.js'
import { V5_GROK_RELAY_PREFIX } from './v5GrokRelay.js'
import { V5_ZCODE_RELAY_PREFIX } from './v5ZcodeRelay.js'
import { V5_ANTIGRAVITY_RELAY_PREFIX } from './v5AntigravityRelay.js'
import type { AntigravityRouteOverride } from './engine/antigravityAdapter.js'
import { resolveEngine } from './engine/registry.js'
import type { CodexProviderConfigOverride } from './engine/codexShared.js'

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
  /** master 签名的执行权威(有则 engine 判定只认它,见 registry.resolveEngine)。 */
  authority?: {
    canonicalModel: string
    engine: 'ccb' | 'codex' | 'grok' | 'cursor' | 'zcode' | 'antigravity'
  }
}): CodexProviderConfigOverride | null {
  if (!args.rawRoute || typeof args.rawRoute !== 'object' || Array.isArray(args.rawRoute)) {
    return null
  }
  // 单点收口:与 sessionManager.getOrCreate 的 engine 判定同构。resolveEngine
  // 对非法 runnerKind fail-closed 抛错 —— 那种配置在 getOrCreate 会同样炸,这里
  // 只需不带 override。
  let engineId: string
  try {
    engineId = resolveEngine(args.model, args.agent as never, args.authority)
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

/** Validate the master-owned Antigravity route (OCV5-415): the opaque relay
 * token plus the openid/userinfo-only Google token the CLI needs for its
 * startup eligibility check. CLOUD_CODE_URL keeps the path, so the route
 * baseUrl is used verbatim. */
export function _buildSafeAntigravityRouteOverride(args: {
  agent: { id: string; provider?: string; runnerKind?: string }
  model?: string
  rawRoute: unknown
  officialRelayPort: number
  authority?: {
    canonicalModel: string
    engine: 'ccb' | 'codex' | 'grok' | 'cursor' | 'zcode' | 'antigravity'
  }
}): AntigravityRouteOverride | null {
  if (!args.rawRoute || typeof args.rawRoute !== 'object' || Array.isArray(args.rawRoute))
    return null
  let engineId: string
  try {
    engineId = resolveEngine(args.model, args.agent as never, args.authority)
  } catch {
    return null
  }
  if (engineId !== 'antigravity') return null
  const route = args.rawRoute as Record<string, unknown>
  const keys = Object.keys(route).sort().join(',')
  if (
    keys !== 'accessToken,accessTokenExpiresAt,baseUrl,routeToken' &&
    keys !== 'accessToken,accessTokenExpiresAt,baseUrl,idToken,routeToken'
  )
    return null
  if (typeof route.routeToken !== 'string' || !/^[0-9a-f]{64}$/.test(route.routeToken)) return null
  if (typeof route.baseUrl !== 'string' || route.baseUrl.length > 512) return null
  if (
    typeof route.accessToken !== 'string' ||
    !/^[A-Za-z0-9._~+/=-]{20,4096}$/.test(route.accessToken)
  )
    return null
  if (
    typeof route.accessTokenExpiresAt !== 'string' ||
    !Number.isFinite(Date.parse(route.accessTokenExpiresAt))
  )
    return null
  if (
    route.idToken !== undefined &&
    (typeof route.idToken !== 'string' || !/^[A-Za-z0-9._-]{20,8192}$/.test(route.idToken))
  )
    return null
  if (
    !Number.isInteger(args.officialRelayPort) ||
    args.officialRelayPort <= 0 ||
    args.officialRelayPort > 65535
  )
    return null
  try {
    const parsed = new URL(route.baseUrl)
    const expectedPath = `${V5_ANTIGRAVITY_RELAY_PREFIX}/route/${route.routeToken}`
    if (
      parsed.protocol !== 'http:' ||
      parsed.hostname !== '127.0.0.1' ||
      Number(parsed.port || '80') !== args.officialRelayPort ||
      parsed.pathname !== expectedPath ||
      parsed.search ||
      parsed.hash
    )
      return null
  } catch {
    return null
  }
  return {
    baseUrl: route.baseUrl,
    routeToken: route.routeToken,
    accessToken: route.accessToken,
    accessTokenExpiresAt: route.accessTokenExpiresAt,
    ...(typeof route.idToken === 'string' ? { idToken: route.idToken } : {}),
  }
}

/** Validate the master-owned opaque route consumed by the ZCode adapter.
 * Anthropic SDK appends /v1 itself, so the minted baseUrl must NOT include /v1.
 */
export function _buildSafeZcodeRouteOverride(args: {
  agent: { id: string; provider?: string; runnerKind?: string }
  model?: string
  rawRoute: unknown
  officialRelayPort: number
  authority?: {
    canonicalModel: string
    engine: 'ccb' | 'codex' | 'grok' | 'cursor' | 'zcode' | 'antigravity'
  }
}): { baseUrl: string; routeToken: string } | null {
  if (!args.rawRoute || typeof args.rawRoute !== 'object' || Array.isArray(args.rawRoute))
    return null
  let engineId: string
  try {
    engineId = resolveEngine(args.model, args.agent as never, args.authority)
  } catch {
    return null
  }
  if (engineId !== 'zcode') return null
  const route = args.rawRoute as Record<string, unknown>
  if (Object.keys(route).sort().join(',') !== 'baseUrl,routeToken') return null
  if (typeof route.routeToken !== 'string' || !/^[0-9a-f]{64}$/.test(route.routeToken)) return null
  if (typeof route.baseUrl !== 'string' || route.baseUrl.length > 512) return null
  if (
    !Number.isInteger(args.officialRelayPort) ||
    args.officialRelayPort <= 0 ||
    args.officialRelayPort > 65535
  )
    return null
  try {
    const parsed = new URL(route.baseUrl)
    const expectedPath = `${V5_ZCODE_RELAY_PREFIX}/route/${route.routeToken}`
    if (
      parsed.protocol !== 'http:' ||
      parsed.hostname !== '127.0.0.1' ||
      Number(parsed.port || '80') !== args.officialRelayPort ||
      parsed.pathname !== expectedPath ||
      parsed.search ||
      parsed.hash
    )
      return null
  } catch {
    return null
  }
  return { baseUrl: route.baseUrl, routeToken: route.routeToken }
}

/** Validate the master-owned opaque route consumed by the Grok adapter. */
export function _buildSafeGrokRouteOverride(args: {
  agent: { id: string; provider?: string; runnerKind?: string }
  model?: string
  rawRoute: unknown
  officialRelayPort: number
  authority?: {
    canonicalModel: string
    engine: 'ccb' | 'codex' | 'grok' | 'cursor' | 'zcode' | 'antigravity'
  }
}): { baseUrl: string; routeToken: string } | null {
  if (!args.rawRoute || typeof args.rawRoute !== 'object' || Array.isArray(args.rawRoute))
    return null
  let engineId: string
  try {
    engineId = resolveEngine(args.model, args.agent as never, args.authority)
  } catch {
    return null
  }
  if (engineId !== 'grok') return null
  const route = args.rawRoute as Record<string, unknown>
  if (Object.keys(route).sort().join(',') !== 'baseUrl,routeToken') return null
  if (typeof route.routeToken !== 'string' || !/^[0-9a-f]{64}$/.test(route.routeToken)) return null
  if (typeof route.baseUrl !== 'string' || route.baseUrl.length > 512) return null
  if (
    !Number.isInteger(args.officialRelayPort) ||
    args.officialRelayPort <= 0 ||
    args.officialRelayPort > 65535
  )
    return null
  try {
    const parsed = new URL(route.baseUrl)
    const expectedPath = `${V5_GROK_RELAY_PREFIX}/route/${route.routeToken}/v1`
    if (
      parsed.protocol !== 'http:' ||
      parsed.hostname !== '127.0.0.1' ||
      Number(parsed.port || '80') !== args.officialRelayPort ||
      parsed.pathname !== expectedPath ||
      parsed.search ||
      parsed.hash
    )
      return null
  } catch {
    return null
  }
  return { baseUrl: route.baseUrl, routeToken: route.routeToken }
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

export const CODEX_API_RELAY_ROUTE_KEYS = new Set([
  'baseUrl',
  'modelProvider',
  'providerName',
  'wireApi',
  'preferredAuthMethod',
  'disableResponseStorage',
])

/** official 上游 https://chatgpt.com/backend-api/codex 在容器 loopback relay 的
 *  base path(= master internalCodexRelay 的 codexRelayBasePathForUpstream 拼法:
 *  CODEX_RELAY_PREFIX + 上游 base path)。gateway 与 commercial 不互相 import,
 *  两侧各自持有常量 —— parity 由 commercial 侧单测锁定。 */
export const CODEX_OFFICIAL_RELAY_BASE_PATH = `${V3_CODEX_RELAY_PREFIX}/backend-api/codex`

export const CODEX_ROUTE_PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export const CODEX_ROUTE_BASE_URL_MAX = 512

export const CODEX_ROUTE_PROVIDER_NAME_MAX = 128
