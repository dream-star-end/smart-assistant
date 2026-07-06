// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import type { Theme } from './theme.js'
import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getCanonicalName } from './model/model.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { getAPIProvider } from './model/providers.js'
import { getSettingsWithErrors } from './settings/settings.js'
import { resolveAntModel } from './model/antModels.js'
import { isArkGlmModel, isArkPlanKimiModel, isCapabilityZeroStaticModel, isOpencodeQwenModel } from './model/staticKeyModels.js'
import { isMiniMaxM3Model } from './model/minimax.js'

export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' }

/**
 * Build-time gate (feature) + runtime gate (GrowthBook). The build flag
 * controls code inclusion in external builds; the GB flag controls rollout.
 */
export function isUltrathinkEnabled(): boolean {
  if (!feature('ULTRATHINK')) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_turtle_carbon', true)
}

/**
 * Check if text contains the "ultrathink" keyword.
 */
export function hasUltrathinkKeyword(text: string): boolean {
  return /\bultrathink\b/i.test(text)
}

/**
 * Find positions of "ultrathink" keyword in text (for UI highlighting/notification)
 */
export function findThinkingTriggerPositions(text: string): Array<{
  word: string
  start: number
  end: number
}> {
  const positions: Array<{ word: string; start: number; end: number }> = []
  // Fresh /g literal each call — String.prototype.matchAll copies lastIndex
  // from the source regex, so a shared instance would leak state from
  // hasUltrathinkKeyword's .test() into this call on the next render.
  const matches = text.matchAll(/\bultrathink\b/gi)

  for (const match of matches) {
    if (match.index !== undefined) {
      positions.push({
        word: match[0],
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  return positions
}

const RAINBOW_COLORS: Array<keyof Theme> = [
  'rainbow_red',
  'rainbow_orange',
  'rainbow_yellow',
  'rainbow_green',
  'rainbow_blue',
  'rainbow_indigo',
  'rainbow_violet',
]

const RAINBOW_SHIMMER_COLORS: Array<keyof Theme> = [
  'rainbow_red_shimmer',
  'rainbow_orange_shimmer',
  'rainbow_yellow_shimmer',
  'rainbow_green_shimmer',
  'rainbow_blue_shimmer',
  'rainbow_indigo_shimmer',
  'rainbow_violet_shimmer',
]

export function getRainbowColor(
  charIndex: number,
  shimmer: boolean = false,
): keyof Theme {
  const colors = shimmer ? RAINBOW_SHIMMER_COLORS : RAINBOW_COLORS
  return colors[charIndex % colors.length]!
}

// TODO(inigo): add support for probing unknown models via API error detection
// Provider-aware thinking support detection (aligns with modelSupportsISP in betas.ts)
export function modelSupportsThinking(model: string): boolean {
  // glm-5.1(火山 Ark)是 thinking 模型 —— 它虽在 isCapabilityZeroStaticModel 集合里
  // (betas/effort/adaptive-thinking 仍全关)，但 thinking 是例外:火山 Ark Anthropic 兼容层
  // 实测支持 thinking:{type:enabled,budget_tokens}。故先判，让 CCB 默认发 enabled(claude.ts
  // 因 modelSupportsAdaptiveThinking=false 走 enabled+budget 分支，正是 Ark 接受的格式)。
  if (isArkGlmModel(model)) {
    return true
  }
  // MiniMax-M3 是思考模型 —— 它在 isCapabilityZeroStaticModel 集合里(betas/effort/adaptive-thinking
  // 仍全关),但 thinking 是例外:2026-06-16 直连验证 https://api.minimaxi.com/anthropic/v1/messages
  // 接受 thinking:{type:enabled,budget_tokens} 并返回带 signature 的 thinking block(同 glm-5.1 走
  // enabled+budget 分支)。故先判,放行 thinking。master 侧 minimax stripBodyFields 已去掉 'thinking'。
  if (isMiniMaxM3Model(model)) {
    return true
  }
  // qwen3.7-max/plus(OpenCode Go)是 thinking 模型 —— 同在 isCapabilityZeroStaticModel 集合
  // (betas/effort/adaptive-thinking 仍全关),thinking 例外放行:2026-07-05 直连验证
  // https://opencode.ai/zen/go/v1/messages 接受 thinking:{type:enabled,budget_tokens},且
  // {type:disabled} 真关思考(直答,output_tokens=1)。同走 enabled+budget 分支。
  if (isOpencodeQwenModel(model)) {
    return true
  }
  // kimi-k2.7-code(火山 Agent Plan)是**恒思考**模型 —— 在 isCapabilityZeroStaticModel 集合
  // (betas/effort/adaptive-thinking 全关),thinking 例外放行:2026-07-06 直连验证火山 plan 端点
  // 接受 thinking:{type:enabled,budget_tokens}(同走 enabled+budget 分支)。注意它不支持
  // disabled(火山 400),master 侧 spec.stripDisabledThinking 删参兜底。
  if (isArkPlanKimiModel(model)) {
    return true
  }
  if (isCapabilityZeroStaticModel(model)) {
    return false
  }
  const supported3P = get3PModelCapabilityOverride(model, 'thinking')
  if (supported3P !== undefined) {
    return supported3P
  }
  if (process.env.USER_TYPE === 'ant') {
    if (resolveAntModel(model.toLowerCase())) {
      return true
    }
  }
  // IMPORTANT: Do not change thinking support without notifying the model
  // launch DRI and research. This can greatly affect model quality and bashing.
  const canonical = getCanonicalName(model)
  const provider = getAPIProvider()
  // 1P and Foundry: all Claude 4+ models (including Haiku 4.5)
  if (provider === 'foundry' || provider === 'firstParty') {
    return !canonical.includes('claude-3-')
  }
  // 3P (Bedrock/Vertex): only Opus 4+ and Sonnet 4+
  return canonical.includes('sonnet-4') || canonical.includes('opus-4')
}

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports adaptive thinking.
export function modelSupportsAdaptiveThinking(model: string): boolean {
  if (isCapabilityZeroStaticModel(model)) {
    return false
  }
  const supported3P = get3PModelCapabilityOverride(model, 'adaptive_thinking')
  if (supported3P !== undefined) {
    return supported3P
  }
  const canonical = getCanonicalName(model)
  // Supported by a subset of Claude 4 models
  if (canonical.includes('opus-4-6') || canonical.includes('sonnet-4-6')) {
    return true
  }
  // Exclude any other known legacy models (allowlist above catches 4-6 variants first)
  if (
    canonical.includes('opus') ||
    canonical.includes('sonnet') ||
    canonical.includes('haiku')
  ) {
    return false
  }
  // IMPORTANT: Do not change adaptive thinking support without notifying the
  // model launch DRI and research. This can greatly affect model quality and
  // bashing.

  // Newer models (4.6+) are all trained on adaptive thinking and MUST have it
  // enabled for model testing. DO NOT default to false for first party, otherwise
  // we may silently degrade model quality.

  // Default to true for unknown model strings on 1P and Foundry (because Foundry
  // is a proxy). Do not default to true for other 3P as they have different formats
  // for their model strings.
  const provider = getAPIProvider()
  return provider === 'firstParty' || provider === 'foundry'
}

export function shouldEnableThinkingByDefault(): boolean {
  if (process.env.MAX_THINKING_TOKENS) {
    return parseInt(process.env.MAX_THINKING_TOKENS, 10) > 0
  }

  const { settings } = getSettingsWithErrors()
  if (settings.alwaysThinkingEnabled === false) {
    return false
  }

  // IMPORTANT: Do not change default thinking enabled value without notifying
  // the model launch DRI and research. This can greatly affect model quality and
  // bashing.

  // Enable thinking by default unless explicitly disabled.
  return true
}
