import { isMiniMaxM3Model } from './minimax.js'

const MODEL_EXECUTION_DESCRIPTOR_ENV = 'OC_MODEL_EXECUTION_DESCRIPTOR'

export interface AuthorityModelCapabilities {
  canonicalModel: string
  contextWindow: number | null
  capabilityZero: boolean
  supportsThinking: boolean
  supportsVision: boolean
  supportedEfforts: string[]
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
  if (d.canonicalModel.trim().toLowerCase() !== model.trim().toLowerCase()) return undefined
  return d as AuthorityModelCapabilities
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
  return m === 'glm-5.1' || m === 'glm-5.2' || m === 'glm-5.3'
}

/** OpenCode Go 当前模型 + 历史 transport 集。DeepSeek 使用独立平台 alias，避免覆盖 direct
 *  provider；Qwen3.7 保留历史 plumbing 但由 DB catalog 下线。 */
export function isOpencodeGoModel(model: string): boolean {
  const m = model.trim().toLowerCase()
  return m === 'deepseek-v4-flash-opencode-go' || m === 'qwen3.7-max' || m === 'qwen3.7-plus'
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

/** Moonshot 官方 Kimi For Coding 接入的模型:kimi-k3(2026-07-17)。精确匹配,大小写/空白
 *  不敏感,与 protocol moonshot.matchesRoute 同口径。与 isArkPlanKimiModel(火山转售 k2.7)
 *  是两家上游。thinking 支持 enabled+budget 且 disabled 真生效(实测,同 qwen 语义)。 */
export function isMoonshotKimiK3Model(model: string): boolean {
  return model.trim().toLowerCase() === 'kimi-k3'
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
      return model === 'glm-5.2' || model === 'glm-5.3'
    },
    contextWindow: 1_000_000,
  },
  { matches: (m) => m.trim().toLowerCase() === 'glm-5.1', contextWindow: 200_000 },
  // DeepSeek alias 与历史 qwen3.7 均为 1M；direct DeepSeek 由上面的精确表独立处理。
  { matches: isOpencodeGoModel, contextWindow: 1_000_000 },
  // kimi-k2.7-code 官方规格 256K(火山 Agent Plan 托管,max output 上游硬顶 32768)。
  { matches: isArkPlanKimiModel, contextWindow: 256_000 },
  // kimi-k3-ark 火山 Agent Plan K3，机制窗口 1,048,576。
  { matches: isArkPlanKimiK3Model, contextWindow: 1_048_576 },
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
