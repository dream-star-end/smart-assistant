// 静态 key 文本 provider 注册表 —— 平台持有静态 API key、按 model id 路由到第三方
// Anthropic 兼容上游(不占 OAuth 账号池)的 provider 的单一权威声明。
//
// 当前成员：DeepSeek、MiniMax、火山方舟 Ark(glm-5.2 主力 + glm-5.1 兼容存量)。
//
// 设计边界(只放 commercial + gateway 都消费的"路由元数据"纯数据/纯函数)：
//   - **不**含 commercial 语义(key 的 config 字段名 / 503 错误码 / metric label) —— 那些在
//     commercial 的 STATIC_PROVIDER_META。
//   - **不**含 CCB 概念(contextWindow / 能力 flag) —— CCB 因包边界(claude-code-best 非
//     workspace 成员、零内部依赖)有自己的本地镜像表 claude-code-best/src/utils/model/staticKeyModels.ts。
//     两表一致性由仓库根 static-key-providers.snapshot.json + 两侧测试守护漂移。
//   - **不**改写转发的 body.model —— 全 provider 都原样透传 caller 的 model 字段；canonicalize 仅
//     用于 pricing 查价。
//
// DeepSeek 的 4 个 id 面**故意不同**(历史不规则，本次只忠实保留)：
//   route 匹配=大小写敏感前缀家族 / inbound 白名单=2 个精确字面量 / capability=2 个精确字面量(在 CCB) /
//   pricing canonicalize=不特判(原样)。因此每个关注点是独立字段，不可统一。

export type StaticProviderId = 'deepseek' | 'minimax' | 'ark'

/**
 * 静态 provider key 解析表:provider id → 该 provider 的静态 key。
 * production 由 commercial wiring 从 config 注入;各装配点可只注入自己支持的子集
 * (如 external API-key proxy 只放 deepseek)。OAuth route 不消费。
 */
export type StaticProviderKeys = Partial<Record<StaticProviderId, string | undefined>>

export interface StaticKeyProviderSpec {
  readonly id: StaticProviderId
  /** 上游 Anthropic 兼容 /v1/messages endpoint */
  readonly upstreamEndpoint: string
  /**
   * commercial master proxy 路由 gate。命中 → 切到本 provider 静态 key 上游。
   *   - deepseek: **大小写敏感** `modelId.startsWith('deepseek-')`(与 shared.ts 现状逐字节一致)
   *   - minimax:  `modelId.toLowerCase() === 'minimax-m3'`
   *   - ark:      `modelId.toLowerCase() === 'glm-5.1' || === 'glm-5.2'`(火山,5.2 主力 + 5.1 兼容)
   */
  matchesRoute(modelId: string): boolean
  /**
   * gateway inbound/WS frame 准入白名单字面量(精确字符串)。**与 matchesRoute 面故意不同**：
   * deepseek 只放 2 个已声明变体，不放过未来未声明的 `deepseek-*`。
   */
  readonly inboundModelIds: readonly string[]
  /**
   * pricing 查价归一。命中本 provider 且需归一 → 返回 canonical id；不命中或不需归一 → null。
   *   - deepseek: 恒 null(原样透传，与 pricing.ts 现状一致 —— deepseek 不特判)
   *   - minimax:  'MiniMax-M3'
   *   - ark:      'glm-5.1' / 'glm-5.2'(各自原样)
   */
  canonicalizeForPricing(modelId: string): string | null
  /** 转发前要 strip 的请求头(永含 'anthropic-beta'，第三方兼容层不识别 Anthropic 私有 beta) */
  readonly stripHeaders: readonly string[]
  /** 转发前要 strip 的 body 字段(CCB 对 unknown firstParty model 默认会带、兼容层会拒的字段) */
  readonly stripBodyFields: readonly string[]
  /** master raw-request input token 上限(估算值，JSON.length/4)。undefined = 不设 cap(如 deepseek)。 */
  readonly maxInputTokens?: number
}

const DEEPSEEK: StaticKeyProviderSpec = {
  id: 'deepseek',
  upstreamEndpoint: 'https://api.deepseek.com/anthropic/v1/messages',
  matchesRoute(modelId) {
    // 大小写敏感前缀家族 —— 不要改成 toLowerCase，否则扩大准入面(Codex plan review)。
    return modelId.startsWith('deepseek-')
  },
  inboundModelIds: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  canonicalizeForPricing() {
    return null
  },
  stripHeaders: ['anthropic-beta'],
  stripBodyFields: [],
  maxInputTokens: undefined,
}

const MINIMAX: StaticKeyProviderSpec = {
  id: 'minimax',
  upstreamEndpoint: 'https://api.minimaxi.com/anthropic/v1/messages',
  matchesRoute(modelId) {
    return modelId.toLowerCase() === 'minimax-m3'
  },
  inboundModelIds: ['MiniMax-M3'],
  canonicalizeForPricing(modelId) {
    return modelId.toLowerCase() === 'minimax-m3' ? 'MiniMax-M3' : null
  },
  stripHeaders: ['anthropic-beta'],
  // **保留 thinking**(2026-06-16):MiniMax-M3 是思考模型,直连验证其 Anthropic 兼容端点接受
  // thinking:{type:enabled,budget_tokens} 并返回带 signature 的 thinking block(同 ark/glm-5.1)。
  // CCB modelSupportsThinking(MiniMax-M3)=true 会发 thinking,故不能 strip。其余 firstParty-only 字段仍 strip。
  stripBodyFields: ['output_config', 'context_management', 'service_tier'],
  maxInputTokens: 512_000,
}

const ARK: StaticKeyProviderSpec = {
  id: 'ark',
  // 火山方舟 Coding Plan 的 Anthropic 兼容 base URL = https://ark.cn-beijing.volces.com/api/coding；
  // 本注册表持有完整 /v1/messages endpoint(同 MiniMax 模式补齐 path)。
  // **2026-06-17 起主力模型 glm-5.2**(火山已支持;coder + 队长/平台默认全切 glm-5.2)。
  // glm-5.1 **仍路由**(向后兼容存量会话/prefs),但已从 picker 撤下(定价 visibility=hidden)。
  upstreamEndpoint: 'https://ark.cn-beijing.volces.com/api/coding/v1/messages',
  matchesRoute(modelId) {
    const m = modelId.toLowerCase()
    return m === 'glm-5.1' || m === 'glm-5.2'
  },
  inboundModelIds: ['glm-5.2', 'glm-5.1'],
  canonicalizeForPricing(modelId) {
    const m = modelId.toLowerCase()
    return m === 'glm-5.1' ? 'glm-5.1' : m === 'glm-5.2' ? 'glm-5.2' : null
  },
  stripHeaders: ['anthropic-beta'],
  // **与 MiniMax 不同:不 strip `thinking`**。glm-5.1/glm-5.2 都是 thinking 模型，火山 Ark Anthropic
  // 兼容层实测支持 `thinking:{type:enabled,budget_tokens}` / `{type:disabled}`(glm-5.1 2026-06-15 直连验证;
  // glm-5.2 同通道同协议)。CCB 对 glm-5.1/glm-5.2 modelSupportsThinking=true，会按用户设置发 thinking，
  // 故必须放行。其余 3 个 firstParty-only 字段仍 strip(Ark 不识别/可能拒)。
  stripBodyFields: ['output_config', 'context_management', 'service_tier'],
  // **glm-5.2 上下文窗口 1M**(火山规格,boss 2026-06-17 确认);glm-5.1 200k(已退场)。
  // maxInputTokens 是 provider 级单值 input guard(估算 JSON.length/4),取 glm-5.2 的 1M:
  //   - glm-5.2 长上下文(200k~1M)不再被 master 误拒 413;
  //   - glm-5.1(退场)guard 随之放宽到 1M,存量 glm-5.1 超 200k 的罕见请求由火山端点兜底拒(400)。
  // 注:CCB auto-compact 上限是 **per-model 精确**的(staticKeyModels STATIC_MODEL_CONTEXT_WINDOW:
  //     5.2=1M / 5.1=200k),防 glm-5.1 存量会话按 1M 不压缩而超窗。
  maxInputTokens: 1_000_000,
}

export const STATIC_KEY_PROVIDERS: readonly StaticKeyProviderSpec[] = [DEEPSEEK, MINIMAX, ARK]

const BY_ID: Record<StaticProviderId, StaticKeyProviderSpec> = {
  deepseek: DEEPSEEK,
  minimax: MINIMAX,
  ark: ARK,
}

/** commercial proxy 路由判定：返回命中的 provider(用 matchesRoute)，否则 undefined(走 OAuth)。 */
export function findRouteProviderForModel(modelId: string): StaticKeyProviderSpec | undefined {
  return STATIC_KEY_PROVIDERS.find((p) => p.matchesRoute(modelId))
}

export function getStaticProvider(id: StaticProviderId): StaticKeyProviderSpec {
  return BY_ID[id]
}

/** gateway inbound 白名单：所有静态 provider 的精确字面量(deepseek 2 项 + MiniMax-M3 + glm-5.1 + glm-5.2)。 */
export const STATIC_KEY_INBOUND_MODEL_IDS: readonly string[] = STATIC_KEY_PROVIDERS.flatMap(
  (p) => [...p.inboundModelIds],
)
