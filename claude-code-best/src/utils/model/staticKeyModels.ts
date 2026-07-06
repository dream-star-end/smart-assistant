import { isMiniMaxM3Model } from './minimax.js'

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
//   2) 静态模型的 context window(auto-compact 上限)。deepseek 无特判 → 落 MODEL_CONTEXT_WINDOW_DEFAULT。

/** 火山方舟 Ark Coding Plan 模型:**glm-5.2**(2026-06-17 起主力 = coder/队长/平台默认)+ glm-5.1
 *  (退 picker 但兼容存量)。两者同走火山 ark 端点,能力处理一致(capabilityZero / thinking / 200k 窗口)。
 *  精确匹配,大小写不敏感。 */
export function isArkGlmModel(model: string): boolean {
  const m = model.trim().toLowerCase()
  return m === 'glm-5.1' || m === 'glm-5.2'
}

/** OpenCode Go(Zen 网关 Go 档)接入的 Qwen 模型:qwen3.7-max + qwen3.7-plus(2026-07-05)。
 *  精确匹配,大小写/空白不敏感,与 protocol opencodego.matchesRoute 同口径。 */
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
  return (
    isMiniMaxM3Model(model) ||
    isArkGlmModel(model) ||
    isOpencodeQwenModel(model) ||
    isArkPlanKimiModel(model)
  )
}

/**
 * 静态模型 context window 显式特判表(deepseek 不在内 —— 它无特判,落 MODEL_CONTEXT_WINDOW_DEFAULT)。
 * **per-model**:glm-5.2=1M(火山规格,boss 2026-06-17 确认)、glm-5.1=200k(退场,沿用旧规格)。
 * auto-compact 上限必须 per-model:glm-5.1 存量会话若按 1M 不压缩会超 200k 窗 → 火山拒。
 * 顺序敏感:glm-5.2 条目必须在 glm-5.1 之前(find 短路);二者大小写/空白不敏感,与 isArkGlmModel 一致口径。
 */
export const STATIC_MODEL_CONTEXT_WINDOW: ReadonlyArray<{
  matches: (model: string) => boolean
  contextWindow: number
}> = [
  { matches: isMiniMaxM3Model, contextWindow: 512_000 },
  { matches: (m) => m.trim().toLowerCase() === 'glm-5.2', contextWindow: 1_000_000 },
  { matches: (m) => m.trim().toLowerCase() === 'glm-5.1', contextWindow: 200_000 },
  // qwen3.7-max/plus 官方规格均 1M(max input 991.8k);两型号同窗,家族函数一条即可。
  { matches: isOpencodeQwenModel, contextWindow: 1_000_000 },
  // kimi-k2.7-code 官方规格 256K(火山 Agent Plan 托管,max output 上游硬顶 32768)。
  { matches: isArkPlanKimiModel, contextWindow: 256_000 },
]

/** 命中静态模型 context 特判表 → 返回其 contextWindow;否则 undefined(由 caller 落默认)。 */
export function getStaticModelContextWindow(model: string): number | undefined {
  return STATIC_MODEL_CONTEXT_WINDOW.find((e) => e.matches(model))?.contextWindow
}
