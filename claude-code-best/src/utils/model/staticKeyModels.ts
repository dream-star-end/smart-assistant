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
//      master strip 是兜底)。**例外:glm-5.1 与 MiniMax-M3 都支持 thinking**(2026-06-16 起;见
//      isCapabilityZeroStaticModel 注释)。
//      **deepseek 不在此集**:deepseek-v4-flash/pro 仍保留 effort='max'(走默认路径,见 effort.ts),
//      betas/thinking 也走默认路径,本次一字不动。
//   2) 静态模型的 context window(auto-compact 上限)。deepseek 无特判 → 落 MODEL_CONTEXT_WINDOW_DEFAULT。

/** glm-5.1(火山方舟 Ark Coding Plan,coder 默认模型;2026-06-16 起平台默认改为 MiniMax-M3)。精确匹配,大小写不敏感。 */
export function isArkGlmModel(model: string): boolean {
  return model.trim().toLowerCase() === 'glm-5.1'
}

/**
 * 「firstParty 能力基本全关」静态模型集 = MiniMax-M3 + glm-5.1(**不含 deepseek**)。
 * 命中 → effort/betas/context-management/structured-output/adaptive-thinking 全部不生成。
 *
 * **例外:thinking**。glm-5.1 与 MiniMax-M3 虽在本集合(上述能力仍关)，但都是 thinking 模型 ——
 * `thinking.ts` 的 modelSupportsThinking 对 glm-5.1(isArkGlmModel)/MiniMax-M3(isMiniMaxM3Model)
 * 先判→true，单独放行 thinking(2026-06-16 直连验证 MiniMax 端点接受 thinking 参数)。
 * 所以"是否在本集合"不直接等于"是否支持 thinking"。
 */
export function isCapabilityZeroStaticModel(model: string): boolean {
  return isMiniMaxM3Model(model) || isArkGlmModel(model)
}

/**
 * 静态模型 context window 显式特判表(deepseek 不在内 —— 它无特判,落 MODEL_CONTEXT_WINDOW_DEFAULT)。
 * ark=200_000 恰等于当前默认,仍显式列出以防默认值将来变动。
 */
export const STATIC_MODEL_CONTEXT_WINDOW: ReadonlyArray<{
  matches: (model: string) => boolean
  contextWindow: number
}> = [
  { matches: isMiniMaxM3Model, contextWindow: 512_000 },
  { matches: isArkGlmModel, contextWindow: 200_000 },
]

/** 命中静态模型 context 特判表 → 返回其 contextWindow;否则 undefined(由 caller 落默认)。 */
export function getStaticModelContextWindow(model: string): number | undefined {
  return STATIC_MODEL_CONTEXT_WINDOW.find((e) => e.matches(model))?.contextWindow
}
