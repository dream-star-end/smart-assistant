// 静态 key 文本 provider 注册表 —— 平台持有静态 API key、按 model id 路由到第三方
// Anthropic 兼容上游(不占 OAuth 账号池)的 provider 的单一权威声明。
//
// 当前成员：DeepSeek、MiniMax、火山方舟 Ark(glm-5.2 主力 + glm-5.1 兼容存量)、
// OpenCode Go(Zen 网关 Go 档,qwen3.7-max/plus,2026-07-05)、Ark Agent Plan Kimi
// (kimi-k2.7-code,与 minimax 同订阅同 key,2026-07-06)。
//
// 设计边界(只放 commercial + gateway 都消费的"路由元数据"纯数据/纯函数)：
//   - **不**含 commercial 语义(key 的 config 字段名 / 503 错误码 / metric label) —— 那些在
//     commercial 的 STATIC_PROVIDER_META。
//   - **不**含 CCB 概念(contextWindow / 能力 flag) —— CCB 因包边界(claude-code-best 非
//     workspace 成员、零内部依赖)有自己的本地镜像表 claude-code-best/src/utils/model/staticKeyModels.ts。
//     两表一致性由仓库根 static-key-providers.snapshot.json + 两侧测试守护漂移。
//   - catalog authority 路径由其 upstream_model_id 决定转发 model；仅 legacy/no-catalog 路径
//     可通过 spec.upstreamModelForRequest 做精确 alias 改写。canonicalize 只用于 pricing 查价。
//
// DeepSeek 的 4 个 id 面**故意不同**(历史不规则，本次只忠实保留)：
//   route 匹配=大小写敏感前缀家族 / inbound 白名单=2 个精确字面量 / capability=2 个精确字面量(在 CCB) /
//   pricing canonicalize=不特判(原样)。因此每个关注点是独立字段，不可统一。

export type StaticProviderId =
  | 'deepseek'
  | 'minimax'
  | 'ark'
  | 'opencodego'
  | 'kimi'
  | 'ark-k3'
  | 'moonshot'
  | 'bailian'

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
   * 上游鉴权头风格。缺省(undefined)= bearer → `Authorization: Bearer <key>`(deepseek/minimax/ark
   * 三家现状,逐字节不变)。'x-api-key' → `x-api-key: <key>`(Anthropic 原生风格)。
   * opencodego 必须 'x-api-key':其 /messages 实测(2026-07-05)只认 x-api-key,
   * Authorization Bearer 返回 401 "Missing API key"。upstream.ts makeStaticKeyUpstream 按本字段注入。
   */
  readonly authScheme?: 'bearer' | 'x-api-key'
  /**
   * 上游不支持 `thinking:{type:'disabled'}` 时置 true:master 转发前若 body.thinking.type
   * === 'disabled' 则**删掉整个 thinking 字段**(退回上游默认=照常思考),而非透传吃 400。
   * 用于恒思考模型(kimi-k2.7-code,火山实测 disabled → 400 "does not support disabling
   * thinking",2026-07-06)。语义注意:用户"关思考"对这类模型退化为"照常思考"(模型能力使然)。
   * 未声明(undefined)= 透传不动(glm 支持 disabled/qwen disabled 生效/minimax 容忍)。
   */
  readonly stripDisabledThinking?: boolean
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
  /**
   * legacy/no-catalog 路径的精确上游 model 改写。catalog hint 存在时不调用，仍以
   * upstream_model_id 为最高权威。未声明 = 原样透传 caller 的 model。
   */
  upstreamModelForRequest?(modelId: string): string
  /** 转发前要 strip 的请求头(永含 'anthropic-beta'，第三方兼容层不识别 Anthropic 私有 beta) */
  readonly stripHeaders: readonly string[]
  /** 转发前要 strip 的 body 字段(CCB 对 unknown firstParty model 默认会带、兼容层会拒的字段) */
  readonly stripBodyFields: readonly string[]
  /** master raw-request input token 上限(估算值，JSON.length/4)。undefined = 不设 cap(如 deepseek)。 */
  readonly maxInputTokens?: number
  /**
   * 该 provider 的上游模型是否**原生支持图像识别(vision)**。
   *   - true  → master proxy **不 strip** image/document content block(模型直接识图);
   *             且 understand_image 视觉工具**不对它启用**(它不需要工具)。
   *   - false/undefined → 纯文本模型,master strip 图,understand_image 工具兜底。
   * 当前:minimax(MiniMax-M3,2026-06-17 实测其 Anthropic 端点接受 image block 并准确识图)=true;
   *       deepseek / ark(glm-5.1/glm-5.2,纯文本)=false。
   */
  readonly supportsVision?: boolean
  /**
   * master proxy 对 `output_config` 的清洗白名单(思考深度 effort 档位)。
   *   - undefined → 不特殊处理(由 stripBodyFields 决定整体 strip 还是放行)。
   *   - 非空数组 → **只保留 `output_config.effort`**,且仅当其值 ∈ 本数组;否则(非法值/缺失/
   *     非 string)删掉整个 output_config。其余子字段(task_budget/format/...)一律删。
   * 这是该 provider"上游允许的思考档位"的**单一权威源**:proxy 纯消费,前端选择器 / CCB 默认值
   * 与之对齐(三处职责不同但档位语义同源)。用于火山 ark glm:火山端点实测合法值 low/medium/high/max,
   * 但 glm-5.2 产品上只暴露高/最高 = ['high','max'],故收窄到这两档(boss 2026-06-17)。
   * **配套硬约束**:声明本字段的 provider 不能再把 'output_config' 放进 stripBodyFields
   * (否则被整体 strip,effort 透不过去)。
   */
  readonly allowedOutputConfigEfforts?: readonly string[]
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
  // 2026-07-07:识图/文本上游从火山方舟 Agent Plan 切回 MiniMax 官方(回退 06-30 迁移)。
  // 原因:火山 Ark 托管的 minimax-m3 对**大图识图直接挂死**(实测 895KB→125s 超时,1024px→65s
  // 超时),而 MiniMax 官方 Anthropic 端点同一张图 4.9s 且描述准确(input_tokens=1284 真识图)。
  // 官方 /anthropic/v1/messages 本就 Anthropic 兼容(2026-06-17 实测接受 image block),格式无需转换;
  // key 改回 MINIMAX_TOKEN_PLAN_KEY(见 staticProviderMeta)。api.minimaxi.com 新加坡端点必须直连。
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
  // MiniMax-M3 原生多模态(2026-06-17 直连验证其 Anthropic 端点接受 base64 image block 并准确识图)。
  // → master 不 strip 它的图;它也作为 understand_image 工具给纯文本模型识图的 backend。
  supportsVision: true,
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
  // 故必须放行。
  // **output_config 不整体 strip**:火山 ark 支持 `output_config.effort`(思考深度,boss 2026-06-17
  // 实测端点合法值 low/medium/high/max,glm-5.2 上线高/最高两档=high/max)。改由 outputConfigEffortOnly
  // 让 master 只保留合法 effort、删掉 CCB 其他 firstParty-only 子字段(task_budget/format 等火山不识别)。
  // 其余 2 个 firstParty-only body 字段仍整体 strip(Ark 不识别/可能拒)。
  stripBodyFields: ['context_management', 'service_tier'],
  // 火山端点合法档位 low/medium/high/max,但 glm-5.2 产品只暴露高/最高;收窄到这两档,
  // 任何其他值(含 low/medium/minimal/xhigh)在 master 兜底剥成"无 effort"(火山默认思考)。
  allowedOutputConfigEfforts: ['high', 'max'],
  // **glm-5.2 上下文窗口 1M**(火山规格,boss 2026-06-17 确认);glm-5.1 200k(已退场)。
  // maxInputTokens 是 provider 级单值 input guard(估算 JSON.length/4),取 glm-5.2 的 1M:
  //   - glm-5.2 长上下文(200k~1M)不再被 master 误拒 413;
  //   - glm-5.1(退场)guard 随之放宽到 1M,存量 glm-5.1 超 200k 的罕见请求由火山端点兜底拒(400)。
  // 注:CCB auto-compact 上限是 **per-model 精确**的(staticKeyModels STATIC_MODEL_CONTEXT_WINDOW:
  //     5.2=1M / 5.1=200k),防 glm-5.1 存量会话按 1M 不压缩而超窗。
  maxInputTokens: 1_000_000,
}

const OPENCODE_GO: StaticKeyProviderSpec = {
  id: 'opencodego',
  // OpenCode Zen「Go 计划」网关(https://opencode.ai/docs/go/)—— 订阅制静态 key(Go 订阅
  // $10/月,配额 5h/$12、周/$30、月/$60,官方允许 opencode 客户端之外直接 API 调用)。
  // 2026-07-05 接入 v5 缺口的两个 Qwen 旗舰。Go 档还有 kimi/mimo 家族,但其 Anthropic 兼容层
  // 实测整族 400 "Upstream request failed"(同模型走 OpenAI /chat/completions 正常 → 网关
  // 转换层问题),等 opencode 修好后追加 inboundModelIds + 定价行即可,不需要新机制。
  // 实测(2026-07-05,qwen3.7-max/plus 直连探针):非流式/SSE 流式/tool_use/tool_result 回环/
  // system+cache_control/stop_sequences 全通;usage 含 cache_read/cache_creation 字段。
  upstreamEndpoint: 'https://opencode.ai/zen/go/v1/messages',
  // /messages 只认 x-api-key(Bearer→401 Missing API key,2026-07-05 实测;其 /models 反而
  // 认 Bearer —— 端点风格不一致是 opencode 侧现状,以 /messages 为准)。
  authScheme: 'x-api-key',
  matchesRoute(modelId) {
    const m = modelId.toLowerCase()
    return m === 'qwen3.7-max' || m === 'qwen3.7-plus'
  },
  inboundModelIds: ['qwen3.7-max', 'qwen3.7-plus'],
  canonicalizeForPricing(modelId) {
    const m = modelId.toLowerCase()
    return m === 'qwen3.7-max' ? 'qwen3.7-max' : m === 'qwen3.7-plus' ? 'qwen3.7-plus' : null
  },
  stripHeaders: ['anthropic-beta'],
  // **保留 thinking**:qwen3.7 是思考模型,实测(2026-07-05)网关接受 thinking:{type:enabled,
  // budget_tokens},且 {type:disabled} 真的关掉思考(返回直答,output_tokens=1)。
  // 三个 firstParty-only 字段今日实测网关容忍,但第三方兼容层的容忍面不作承诺,按 minimax
  // 先例仍 strip(CCB 侧 capabilityZero 不生成是根治,这里是兜底)。
  stripBodyFields: ['output_config', 'context_management', 'service_tier'],
  // qwen3.7-max/plus 官方规格均 1M 窗口(max input 991.8k / max output 65.5k)。
  // max_tokens 超限网关自钳制(实测 100k 照收不 400),无需输出 cap 机制。
  maxInputTokens: 1_000_000,
  // 实测 image block → 400 InvalidParameter "Unexpected item type in content" → 纯文本接入,
  // master strip 图,understand_image 工具兜底(mcpVisionServer/promptSlots 已同步登记)。
  supportsVision: false,
}

const ARK_PLAN_KIMI: StaticKeyProviderSpec = {
  id: 'kimi',
  // 火山方舟 Agent Plan 托管的 Kimi K2.7 Code(2026-07-06 接入)—— 与 minimax(MiniMax-M3)
  // 同 lane 同 key(/api/plan + ARK_AGENT_PLAN_KEY,订阅制),但**独立 spec**:supportsVision 是
  // provider 级语义(M3 多模态=true / kimi 纯文本=false),且 kimi 不支持关闭思考(见
  // stripDisabledThinking),不能与 M3 合并声明。spec=路由组而非端点唯一(ark glm 双型号同构先例)。
  // 实测(2026-07-06,kl-mirror 直连探针):非流式/SSE 流式/tool_use/tool_result 回环(**含 thinking
  // 块回放**,CCB 多轮硬依赖)/system+cache_control 全通;usage 含 cache_read_input_tokens。
  // kimi-k2.6 同样可用(未接,需要时加 inboundModelIds + 定价行);kimi-k2.7(非 code)不在
  // Agent Plan(404 UnsupportedModel)。
  upstreamEndpoint: 'https://ark.cn-beijing.volces.com/api/plan/v1/messages',
  matchesRoute(modelId) {
    return modelId.toLowerCase() === 'kimi-k2.7-code'
  },
  inboundModelIds: ['kimi-k2.7-code'],
  canonicalizeForPricing(modelId) {
    return modelId.toLowerCase() === 'kimi-k2.7-code' ? 'kimi-k2.7-code' : null
  },
  stripHeaders: ['anthropic-beta'],
  // **保留 thinking**:kimi-k2.7-code 恒思考,实测接受 thinking:{type:enabled,budget_tokens};
  // 但 {type:disabled} → 火山 400 "The current model does not support disabling thinking" →
  // stripDisabledThinking 在 master 侧删参兜底(退回默认=照常思考)。
  stripBodyFields: ['output_config', 'context_management', 'service_tier'],
  stripDisabledThinking: true,
  // kimi-k2.7-code 官方规格 256K 窗口;max output 上游硬顶 32768(实测 100k → 400
  // "expected a value <= 32768";CCB 未知静态模型默认 max_tokens=32000 < 顶,安全。
  // **已知限制**:容器若设 CLAUDE_CODE_MAX_OUTPUT_TOKENS > 32768 会被上游拒)。
  maxInputTokens: 256_000,
  // 实测 image block → 400 InvalidParameter → 纯文本接入,master strip 图,
  // understand_image 工具兜底(mcpVisionServer/promptSlots 已同步登记)。
  supportsVision: false,
}

const ARK_PLAN_KIMI_K3: StaticKeyProviderSpec = {
  id: 'ark-k3',
  // 火山方舟 Agent Plan 新增 Kimi K3(2026-07-22)。与上面的 kimi-k2.7-code 共用
  // /api/plan + ARK_AGENT_PLAN_KEY，但能力不同：K3 是 1M、多模态，且支持关闭 thinking；
  // 所以必须是独立机制 spec，不能扩进 id='kimi' 的 256K/纯文本/恒思考语义。
  // 平台 alias 故意叫 kimi-k3-ark，避免覆盖仍有普通用户使用的 Moonshot 官方 kimi-k3。
  upstreamEndpoint: 'https://ark.cn-beijing.volces.com/api/plan/v1/messages',
  matchesRoute(modelId) {
    return modelId.toLowerCase() === 'kimi-k3-ark'
  },
  inboundModelIds: ['kimi-k3-ark'],
  canonicalizeForPricing(modelId) {
    return modelId.toLowerCase() === 'kimi-k3-ark' ? 'kimi-k3-ark' : null
  },
  upstreamModelForRequest(modelId) {
    return modelId.toLowerCase() === 'kimi-k3-ark' ? 'kimi-k3' : modelId
  },
  stripHeaders: ['anthropic-beta'],
  // 2026-07-22 直连实测：thinking enabled/disabled、SSE、auto tool loop、vision 均可用；
  // output_config.effort 虽接受但未证明改变行为，故不暴露档位并继续整体 strip。
  stripBodyFields: ['output_config', 'context_management', 'service_tier'],
  maxInputTokens: 1_048_576,
  supportsVision: true,
}

const MOONSHOT_CODING: StaticKeyProviderSpec = {
  id: 'moonshot',
  // Moonshot(月之暗面)官方「Kimi For Coding」订阅套餐的 Anthropic 兼容端点(2026-07-17 接入,
  // boss 的 Allegretto 档订阅)。**与现有 id='kimi'(火山方舟 Agent Plan 托管 kimi-k2.7-code)
  // 是两家上游**:端点/key/能力面全不同,不能合并——'kimi' 是方舟转售,本 spec 是厂商官方。
  // 模型 kimi-k3(2026-07-16 发布旗舰,1M 窗口):官方文档声明恒推理(reasoning_effort 仅 max 档)、
  // 多模态(image/video in)、tool calling。
  // 实测(2026-07-17,部署机直连探针):非流式全通;thinking 默认返回带 signature 的 thinking block;
  // **{type:'disabled'} 真生效**(纯直答无思考块,与 k2.7 的 400 不同,故不需要 stripDisabledThinking);
  // image block 接受(supportsVision=true);max_tokens=100k 不拒(无 k2.7 那种 32768 输出硬顶)。
  upstreamEndpoint: 'https://api.kimi.com/coding/v1/messages',
  // 实测 x-api-key 鉴权可用(Anthropic 原生风格,官方 Claude Code 接入文档同款)。
  authScheme: 'x-api-key',
  matchesRoute(modelId) {
    return modelId.toLowerCase() === 'kimi-k3'
  },
  inboundModelIds: ['kimi-k3'],
  canonicalizeForPricing(modelId) {
    return modelId.toLowerCase() === 'kimi-k3' ? 'kimi-k3' : null
  },
  stripHeaders: ['anthropic-beta'],
  // **保留 thinking**:kimi-k3 默认思考,实测接受 thinking:{type:enabled,budget_tokens} 且
  // disabled 语义正确(见上)。effort 档位官方仅 max 一档 → 不暴露档位选择,output_config 整体
  // strip(CCB capabilityZero 不生成是根治,这里兜底;与 minimax/opencodego/kimi 同款)。
  stripBodyFields: ['output_config', 'context_management', 'service_tier'],
  // kimi-k3 官方规格 1,048,576(1M)窗口,计费不按长度分段。
  // 注意平台产品层另有按角色的窗口分档(admin 1M / 其他 500k),那是 commercial
  // modelRolePolicy 的投影语义,不属于本机制注册表 —— 这里只声明机制上限。
  maxInputTokens: 1_048_576,
  // 官方多模态 + 实测 image block 接受 → 原生识图,master 不 strip 图,
  // understand_image 工具不对它注入。
  supportsVision: true,
}

const BAILIAN_TOKEN_PLAN: StaticKeyProviderSpec = {
  id: 'bailian',
  // 阿里云百炼 Token Plan 的 Anthropic Messages 端点。qwen3.8-max 是 2026-08-04
  // 发布的正式型号（不是 qwen3.8-max-preview）；平台 canonical id 与上游 literal 相同。
  // 官方 Claude Code / Anthropic API 文档声明 983,616 上下文、131,072 最大输出，支持
  // vision、thinking enabled+budget/disabled、tool use/result 与 prompt cache。
  upstreamEndpoint: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages',
  // Token Plan Anthropic 端点使用原生 x-api-key；key 只留 commercial master/egress，
  // 不注入用户容器。
  authScheme: 'x-api-key',
  matchesRoute(modelId) {
    return modelId.toLowerCase() === 'qwen3.8-max'
  },
  inboundModelIds: ['qwen3.8-max'],
  canonicalizeForPricing(modelId) {
    return modelId.toLowerCase() === 'qwen3.8-max' ? 'qwen3.8-max' : null
  },
  stripHeaders: ['anthropic-beta'],
  // thinking 是标准支持能力，必须保留。output_config.effort 的 Anthropic 文档只为
  // glm/deepseek 声明，不对 Qwen 暴露；CCB 侧 capability-zero 不生成，proxy 再兜底 strip。
  stripBodyFields: ['output_config', 'context_management', 'service_tier'],
  maxInputTokens: 983_616,
  supportsVision: true,
}

export const STATIC_KEY_PROVIDERS: readonly StaticKeyProviderSpec[] = [
  DEEPSEEK,
  MINIMAX,
  ARK,
  OPENCODE_GO,
  ARK_PLAN_KIMI,
  ARK_PLAN_KIMI_K3,
  MOONSHOT_CODING,
  BAILIAN_TOKEN_PLAN,
]

const BY_ID: Record<StaticProviderId, StaticKeyProviderSpec> = {
  deepseek: DEEPSEEK,
  minimax: MINIMAX,
  ark: ARK,
  opencodego: OPENCODE_GO,
  kimi: ARK_PLAN_KIMI,
  'ark-k3': ARK_PLAN_KIMI_K3,
  moonshot: MOONSHOT_CODING,
  bailian: BAILIAN_TOKEN_PLAN,
}

/** commercial proxy 路由判定：返回命中的 provider(用 matchesRoute)，否则 undefined(走 OAuth)。 */
export function findRouteProviderForModel(modelId: string): StaticKeyProviderSpec | undefined {
  return STATIC_KEY_PROVIDERS.find((p) => p.matchesRoute(modelId))
}

export function getStaticProvider(id: StaticProviderId): StaticKeyProviderSpec {
  return BY_ID[id]
}

/** gateway inbound 白名单：所有静态 provider 的精确字面量(deepseek 2 项 + MiniMax-M3 + glm-5.1 + glm-5.2 + qwen3.7-max/plus + kimi-k2.7-code)。 */
export const STATIC_KEY_INBOUND_MODEL_IDS: readonly string[] = STATIC_KEY_PROVIDERS.flatMap(
  (p) => [...p.inboundModelIds],
)
