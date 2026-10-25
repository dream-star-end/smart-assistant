import { isMiniMaxM3Model } from './minimax.js'

const MODEL_EXECUTION_DESCRIPTOR_ENV = 'OC_MODEL_EXECUTION_DESCRIPTOR'

export interface AuthorityModelCapabilities {
  canonicalModel: string
  contextWindow: number | null
  capabilityZero: boolean
  supportsThinking: boolean
  supportsVision: boolean
  supportedEfforts: string[]
  contextOwner?: 'box-native-v1'
}

/**
 * Gateway 在每个 turn 开始前写入的已验签执行描述符。只对 exact canonical model 生效；
 * CCB 的 secondary utility model 仍按自己的模型语义处理，不能误套主模型 descriptor。
 * 非空但畸形必须抛错，避免悄悄退回 baked 表。
 */
export function getAuthorityModelCapabilities(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): AuthorityModelCapabilities | undefined {
  const raw = env[MODEL_EXECUTION_DESCRIPTOR_ENV]
  if (!raw) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('OC_MODEL_EXECUTION_DESCRIPTOR is not valid JSON')
  }
  const d = value as Partial<AuthorityModelCapabilities> | null
  if (
    !d ||
    typeof d !== 'object' ||
    typeof d.canonicalModel !== 'string' ||
    !(d.contextWindow === null ||
      (typeof d.contextWindow === 'number' && Number.isInteger(d.contextWindow) && d.contextWindow > 0)) ||
    typeof d.capabilityZero !== 'boolean' ||
    typeof d.supportsThinking !== 'boolean' ||
    typeof d.supportsVision !== 'boolean' ||
    !Array.isArray(d.supportedEfforts) ||
    !d.supportedEfforts.every((effort) => typeof effort === 'string')
  ) {
    throw new Error('OC_MODEL_EXECUTION_DESCRIPTOR has invalid shape')
  }
  const contextOwner = (d as { contextOwner?: unknown }).contextOwner
  if (contextOwner !== undefined && contextOwner !== 'box-native-v1') {
    throw new Error('OC_MODEL_EXECUTION_DESCRIPTOR has invalid shape')
  }
  if (d.canonicalModel.trim().toLowerCase() !== model.trim().toLowerCase()) return undefined
  const parsed = d as AuthorityModelCapabilities
  if (contextOwner === 'box-native-v1') parsed.contextOwner = 'box-native-v1'
  return parsed
}

// CCB 侧「静态 key 文本 provider」本地镜像表。
//
// CANONICAL 路由元数据源 = packages/protocol/src/staticKeyProviders.ts(commercial+gateway 共享)。
// CCB(claude-code-best)非 monorepo workspace 成员、零内部依赖、被 Dockerfile 单独 COPY 进 runtime
// 镜像,**无法 import @openclaude/protocol**,故本地镜像所需子集。两表一致性由仓库根
// static-key-providers.snapshot.json + 两侧测试(protocol / CCB)断言守护漂移。
//
// CCB 只需两件事:
//   1) 哪些静态模型「firstParty 能力基本全关」—— 这些模型 effort/betas/context-management/
//      structured-output/adaptive-thinking 不生成(与 master proxy 的 strip 呼应:CCB 不生成是根治,
//      master strip 是兜底)。**例外:glm-5.1/glm-5.2 与 MiniMax-M3 都支持 thinking**(见
//      isCapabilityZeroStaticModel 注释)。
//      **deepseek 不在此集**:deepseek-v4-flash/pro 仍保留 effort='max'(走默认路径,见 effort.ts),
//      betas/thinking 也走默认路径,本次一字不动。
//   2) 静态模型的 context window(auto-compact 上限)。DeepSeek V4 Flash / Pro 官方窗口均为 1M。

/** 火山方舟 Ark Coding Plan 模型。glm-5.3/5.2 为 1M，glm-5.1 为兼容存量 200K。
 *  精确匹配,大小写不敏感；disabled-thinking 的型号差异由 master proxy 处理。 */
export function isArkGlmModel(model: string): boolean {
  const m = model.trim().toLowerCase()
  return m === 'glm-5.1' || m === 'glm-5.2'
}

/** 超算互联网 Token Plan GLM。平台 canonical 小写,上游字面量 GLM-5.3 / GLM-5.3-Flash。 */
export function isScnetGlmModel(model: string): boolean {
  const m = model.trim().toLowerCase()
  return m === 'glm-5.3' || m === 'glm-5.3-flash'
}

/** 智谱国际版 Z.AI Coding Plan 的平台 alias。与火山 Ark 的 glm-5.3 是同一品牌型号、
 * 不同上游/凭据，必须保持独立 canonical id。 */
export function isZaiGlm53Model(model: string): boolean {
  return model.trim().toLowerCase() === 'glm-5.3-zai'
}

/** OCV5-425 OpenCode Go `/messages` models, catalog id → upstream id. Mirrors protocol
 *  OPENCODE_GO_MESSAGES_MODELS (equality pinned by staticKeyModels.test.ts). */
export const OPENCODE_GO_MESSAGES_MODEL_IDS: readonly string[] = [
  'deepseek-v4-pro-go',
  'claude-haiku-5-5-go',
  'kimi-k3-go',
  'minimax-m2.7-go',
  'minimax-m3-go',
  'space-bunny-go',
  'qwen3.8-max-go',
  'qwen3.8-flash-go',
  'qwen3.7-plus-go',
]

/** OCV5-425 phase 2 OpenCode Go chat-completions models (proxy bridge). Mirrors protocol
 *  OPENCODE_GO_CHAT_MODELS (equality pinned by staticKeyModels.test.ts). */
export const OPENCODE_GO_CHAT_MODEL_IDS: readonly string[] = [
  'glm-5.3-go',
  'glm-5.2-go',
  'glm-5.3-flash-go',
  'kimi-k2.7-code-go',
  'kimi-k2.6-go',
  'mimo-v2.6-pro-go',
  'mimo-v2.5-pro-go',
  'mimo-v2.6-flash-go',
  'mimo-v2.5-go',
  'hy4-preview-go',
  'hy3-go',
  'longcat-2.0-go',
  'longcat-2.5-preview-free-go',
  'step-5-preview-free-go',
]

/** OCV5-425 phase 3 OpenCode Go Responses models (proxy bridge). Mirrors protocol
 *  OPENCODE_GO_RESPONSES_MODELS (equality pinned by staticKeyModels.test.ts). */
export const OPENCODE_GO_RESPONSES_MODEL_IDS: readonly string[] = [
  'opencode-grok-4.7',
  'opencode-grok-4.6',
  'opencode-gpt-6-luna',
  'opencode-gpt-5.6-luna',
  'muse-spark-1.3-go',
  'muse-spark-1.2-go',
]

/** OpenCode Go 当前模型 + 历史 transport 集。DeepSeek 使用独立平台 alias，避免覆盖 direct
 *  provider；Qwen3.7 保留历史 plumbing 但由 DB catalog 下线。 */
export function isOpencodeGoModel(model: string): boolean {
  const m = model.trim().toLowerCase()
  return (
    m === 'deepseek-v4-flash-opencode-go' ||
    m === 'qwen3.7-max' ||
    m === 'qwen3.7-plus' ||
    m === 'gemini-4-argon-contributor' ||
    OPENCODE_GO_MESSAGES_MODEL_IDS.includes(m) ||
    OPENCODE_GO_CHAT_MODEL_IDS.includes(m) ||
    OPENCODE_GO_RESPONSES_MODEL_IDS.includes(m)
  )
}

/** Claude Haiku via OpenCode Go rejects `thinking:{enabled,budget}` (400, OCV5-425 probe);
 *  it thinks through `output_config.effort` instead. */
export function isOpencodeGoNoThinkingModel(model: string): boolean {
  const m = model.trim().toLowerCase()
  // The chat bridge does not take Anthropic thinking (reasoning runs upstream, effort maps to
  // reasoning_effort), so CCB sends none.
  return (
    m === 'claude-haiku-5-5-go' ||
    OPENCODE_GO_CHAT_MODEL_IDS.includes(m) ||
    OPENCODE_GO_RESPONSES_MODEL_IDS.includes(m)
  )
}

/** 只识别 OpenCode Go 的历史 Qwen 子集。 */
export function isOpencodeQwenModel(model: string): boolean {
  const m = model.trim().toLowerCase()
  return m === 'qwen3.7-max' || m === 'qwen3.7-plus'
}

/** 火山方舟 Agent Plan 托管的 Kimi 模型:kimi-k2.7-code(2026-07-06)。精确匹配,大小写/空白
 *  不敏感,与 protocol kimi.matchesRoute 同口径。注意:恒思考模型,thinking 支持 enabled+budget
 *  但**不支持 disabled**(火山 400,master 侧 spec.stripDisabledThinking 删参兜底)。 */
export function isArkPlanKimiModel(model: string): boolean {
  return model.trim().toLowerCase() === 'kimi-k2.7-code'
}

/** 火山方舟 Agent Plan 托管的 Kimi K3 平台 alias:kimi-k3-ark(2026-07-22)。与 K2.7
 * 共 endpoint/key，但为 1M、多模态且 thinking disabled 可用，故保持独立精确匹配。 */
export function isArkPlanKimiK3Model(model: string): boolean {
  return model.trim().toLowerCase() === 'kimi-k3-ark'
}

/** Moonshot 官方 Kimi For Coding 接入的模型:kimi-k3 / k3-256k / k3.1-pro。精确匹配,大小写/空白
 *  不敏感,与 protocol moonshot.matchesRoute 同口径。与 isArkPlanKimiModel(火山转售 k2.7)
 *  是两家上游。旧 K3 支持 disabled；K3.1 Pro 为 thinking-only，由 proxy 精确删 disabled。 */
export function isMoonshotKimiK3Model(model: string): boolean {
  const m = model.trim().toLowerCase()
  return m === 'kimi-k3' || m === 'k3-256k' || m === 'k3.1-pro'
}

/** 阿里云百炼 Token Plan 正式 Qwen3.8 Max。精确匹配，避免 preview/未来家族型号
 * 在未登记能力与计费前被静默放行。 */
export function isBailianQwen38MaxModel(model: string): boolean {
  return model.trim().toLowerCase() === 'qwen3.8-max'
}

/**
 * 「firstParty 能力基本全关」静态模型集 = MiniMax-M3 + glm-5.1/glm-5.2 + qwen3.7-max/plus
 * (**不含 deepseek**)。命中 → effort/betas/context-management/structured-output/adaptive-thinking
 * 全部不生成。
 *
 * **例外:thinking**。glm-5.1/glm-5.2、MiniMax-M3 与 qwen3.7-max/plus 虽在本集合(上述能力仍关),
 * 但都是 thinking 模型 —— `thinking.ts` 的 modelSupportsThinking 对 isArkGlmModel/isMiniMaxM3Model/
 * isOpencodeQwenModel 先判→true,单独放行 thinking(各端点实测接受 thinking 参数;qwen 2026-07-05
 * 实测 enabled/disabled 语义均正确)。所以"是否在本集合"不直接等于"是否支持 thinking"。
 */
export function isCapabilityZeroStaticModel(model: string): boolean {
  const authority = getAuthorityModelCapabilities(model)
  if (authority) return authority.capabilityZero
  return (
    isMiniMaxM3Model(model) ||
    isArkGlmModel(model) ||
    isZaiGlm53Model(model) ||
    isScnetGlmModel(model) ||
    isOpencodeGoModel(model) ||
    isArkPlanKimiModel(model) ||
    isArkPlanKimiK3Model(model) ||
    isMoonshotKimiK3Model(model) ||
    isBailianQwen38MaxModel(model)
  )
}

/**
 * 静态模型 context window 显式特判表。
 * **per-model**:glm-5.2=1M(火山规格,boss 2026-06-17 确认)、glm-5.1=200k(退场,沿用旧规格)。
 * auto-compact 上限必须 per-model:glm-5.1 存量会话若按 1M 不压缩会超 200k 窗 → 火山拒。
 * 顺序敏感:glm-5.2 条目必须在 glm-5.1 之前(find 短路);二者大小写/空白不敏感,与 isArkGlmModel 一致口径。
 */
export const STATIC_MODEL_CONTEXT_WINDOW: ReadonlyArray<{
  matches: (model: string) => boolean
  contextWindow: number
}> = [
  { matches: isMiniMaxM3Model, contextWindow: 512_000 },
  // DeepSeek 只放行已接入的两个精确 canonical id；未来 deepseek-* 仍落默认值。
  {
    matches: (m) => {
      const model = m.trim().toLowerCase()
      return model === 'deepseek-v4-flash' || model === 'deepseek-v4-pro'
    },
    contextWindow: 1_000_000,
  },
  {
    matches: (m) => {
      const model = m.trim().toLowerCase()
      return model === 'glm-5.2'
    },
    contextWindow: 1_000_000,
  },
  { matches: (m) => m.trim().toLowerCase() === 'glm-5.1', contextWindow: 200_000 },
  { matches: isScnetGlmModel, contextWindow: 1_000_000 },
  { matches: isZaiGlm53Model, contextWindow: 1_000_000 },
  // OCV5-425: catalog windows (https://models.dev opencode-go), capped below the next OpenCode
  // Go price tier so one per-token price is exact (Haiku 100K; MiniMax M3 / Qwen3.7 Plus 200K).
  // Must stay before the 1M OpenCode Go default below.
  ...Object.entries({
    'claude-haiku-5-5-go': 100_000,
    'minimax-m3-go': 200_000,
    'qwen3.7-plus-go': 200_000,
    'minimax-m2.7-go': 204_800,
    'qwen3.8-max-go': 262_144,
    'kimi-k3-go': 1_048_576,
    'space-bunny-go': 1_048_576,
    'kimi-k2.7-code-go': 262_144,
    'kimi-k2.6-go': 262_144,
    'hy3-go': 192_000,
    'hy4-preview-go': 1_024_000,
    'mimo-v2.6-pro-go': 1_048_576,
    'mimo-v2.5-pro-go': 1_048_576,
    'mimo-v2.6-flash-go': 1_048_576,
    'opencode-grok-4.7': 200_000,
    'opencode-grok-4.6': 200_000,
    'opencode-gpt-6-luna': 272_000,
    'opencode-gpt-5.6-luna': 272_000,
    'muse-spark-1.3-go': 1_048_576,
    'muse-spark-1.2-go': 1_048_576,
  }).map(([id, contextWindow]) => ({
    matches: (m: string) => m.trim().toLowerCase() === id,
    contextWindow,
  })),
  // DeepSeek alias 与历史 qwen3.7 均为 1M；direct DeepSeek 由上面的精确表独立处理。
  { matches: isOpencodeGoModel, contextWindow: 1_000_000 },
  // kimi-k2.7-code 官方规格 256K(火山 Agent Plan 托管,max output 上游硬顶 32768)。
  { matches: isArkPlanKimiModel, contextWindow: 256_000 },
  // kimi-k3-ark 火山 Agent Plan K3，机制窗口 1,048,576。
  { matches: isArkPlanKimiK3Model, contextWindow: 1_048_576 },
  // 精确的 256k 型号必须放在 Moonshot K3 family 条目之前。
  { matches: (m) => m.trim().toLowerCase() === 'k3-256k', contextWindow: 262_144 },
  // kimi-k3 官方规格 1M=1,048,576(Moonshot 官方 Kimi For Coding)。这是**机制窗口**兜底值
  // (无 descriptor 的回落路径);角色分档(admin 1M/其他 500k)由 authority descriptor 下发,
  // getAuthorityModelCapabilities 先判已覆盖。
  { matches: isMoonshotKimiK3Model, contextWindow: 1_048_576 },
  // 百炼 qwen3.8-max 官方 Claude Code / OpenCode 配置给出的精确上下文窗口。
  { matches: isBailianQwen38MaxModel, contextWindow: 983_616 },
]

/** 命中静态模型 context 特判表 → 返回其 contextWindow;否则 undefined(由 caller 落默认)。 */
export function getStaticModelContextWindow(model: string): number | undefined {
  const authority = getAuthorityModelCapabilities(model)
  if (authority) return authority.contextWindow ?? undefined
  return STATIC_MODEL_CONTEXT_WINDOW.find((e) => e.matches(model))?.contextWindow
}
