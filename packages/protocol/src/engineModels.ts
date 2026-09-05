// codex engine 模型归属 —— master(commercial bridge)与容器 gateway 共用的单一权威。
//
// 背景(P0 计费旁路封堵,2026-07-02):
//   - 容器侧 gateway `engine/registry.ts` 的 resolveEngine 按 model 判定底座
//     (codex vs ccb),其 MODEL_ENGINE_MAP 由本表派生;
//   - master 侧 commercial `ws/userChatBridge.ts` 需要在 forward 前做同构判定
//     (codex turn → preCheck / inflight journal / server-owned requestId 注入),
//     判定不同构 = codex turn 绕过计费(免费 codex)或 CCB turn 误走 codex 计费。
//   两处如果各自硬编码 gpt 集合,漂移是必然的 —— 收口在 protocol(双方共同依赖、
//   零依赖 leaf),新增 codex 系模型只改本表一处。
//
// 设计边界:只回答「哪些 model id 由 codex engine 承接」。模型准入(白名单 /
// 授权可见性)与 engine 构造(registry fail-closed)仍在各自消费方收口。

import { findRouteProviderForModel } from './staticKeyProviders.js'

/**
 * v5 对外承诺的统一思考深度枚举。
 *
 * Codex 0.144 的 Sol/Terra 还声明了 `ultra`,但该档会触发 Codex 原生自动委派；
 * v5 的委派权威是 OpenClaude `delegate_task`(含计费/并发/进度),因此平台不暴露
 * `ultra`。Luna 本身也不支持该档。
 */
export const PLATFORM_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const
export type PlatformReasoningEffort = (typeof PLATFORM_REASONING_EFFORTS)[number]

/**
 * agent manifest `model` 字段的特殊值:「不锁模型」。
 *
 * 语义(全链路投影,各消费方见下):
 *   - 会话帧带 model(用户在模型选择器任选)→ 用帧的,与其它 agent 无差别;
 *   - 帧不带 model → 跳过该档,落平台默认链(config 默认 → 平台兜底),与 main 同形。
 * 消费方:
 *   - commercial `marketplace/agentManifest.ts`:validator 放行该字面量(不要求 ∈ 公开模型集);
 *   - commercial `ws/agentModelAuthority.ts`:master 计费权威把 auto 归一为平台默认模型
 *     (与容器侧兜底同构,不产生计费旁路面);
 *   - gateway `resolveExecutionModel` / `decideLocalExecution`:候选阶梯跳过 auto;
 *   - 前端/队长展示:auto → 「任意模型(跟随会话)」。
 */
export const AGENT_MODEL_AUTO = 'auto'

/**
 * Codex engine 模型号 + 模型自身默认思考深度的单一权威。
 * 顺序有产品语义:第一项同时是 codex seed / 团队模式队长默认型号(仍为 Sol;
 * GPT-6-Astra 在选择器里置顶靠 model_pricing.sort_order,不靠本表顺序)。
 *
 * GPT-6-Astra(2026-09-05,Codex 0.153.3 内嵌目录 slug `gpt-6-astra`,
 * minimal_client_version 0.153.0,`visibility: hide` 但 supported_in_api)。定价 = Sol
 * 标准档 ×2(迁移 0263),1M 孪生沿用 0238 的 1.5× 长上下文契约。
 */
export const CODEX_ENGINE_MODELS = [
  { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', defaultReasoningEffort: 'xhigh', longContext: false },
  { id: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', defaultReasoningEffort: 'xhigh', longContext: false },
  { id: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', defaultReasoningEffort: 'medium', longContext: false },
  {
    id: 'gpt-5.6-sol-1m',
    displayName: 'GPT-5.6-Sol',
    defaultReasoningEffort: 'xhigh',
    cliModel: 'gpt-5.6-sol',
    longContext: true,
  },
  {
    id: 'gpt-5.6-terra-1m',
    displayName: 'GPT-5.6-Terra',
    defaultReasoningEffort: 'xhigh',
    cliModel: 'gpt-5.6-terra',
    longContext: true,
  },
  {
    id: 'gpt-5.6-luna-1m',
    displayName: 'GPT-5.6-Luna',
    defaultReasoningEffort: 'medium',
    cliModel: 'gpt-5.6-luna',
    longContext: true,
  },
  { id: 'gpt-6-astra', displayName: 'GPT-6-Astra', defaultReasoningEffort: 'xhigh', longContext: false },
  {
    id: 'gpt-6-astra-1m',
    displayName: 'GPT-6-Astra',
    defaultReasoningEffort: 'xhigh',
    cliModel: 'gpt-6-astra',
    longContext: true,
  },
] as const satisfies readonly {
  id: string
  displayName: string
  defaultReasoningEffort: PlatformReasoningEffort
  cliModel?: string
  longContext?: boolean
}[]

/** codex engine 承接的模型 id 全集(精确字面量,与 registry MODEL_ENGINE_MAP 同源)。 */
export const CODEX_ENGINE_MODEL_IDS = CODEX_ENGINE_MODELS.map((m) => m.id)

export type CodexEngineModelId = (typeof CODEX_ENGINE_MODELS)[number]['id']
export type CodexEngineModel = (typeof CODEX_ENGINE_MODELS)[number]

/**
 * 标准/1M 上下文成对家族。`collapsedByDefault` 是选择器的展示语义:为 true 的家族默认
 * 收进「更多 GPT 模型」折叠组(2026-09-05 产品决定:GPT-5.6 Terra/Luna 折叠,给 GPT-6-Astra
 * 与 Sol 腾位;当前选中模型落在折叠组时该组自动展开)。不影响准入、计费与路由。
 */
export const CONTEXT_TIER_FAMILIES = [
  {
    family: 'gpt-6-astra',
    familyLabel: 'GPT-6-Astra',
    standardId: 'gpt-6-astra',
    longId: 'gpt-6-astra-1m',
    collapsedByDefault: false,
  },
  {
    family: 'gpt-5.6-sol',
    familyLabel: 'GPT-5.6-Sol',
    standardId: 'gpt-5.6-sol',
    longId: 'gpt-5.6-sol-1m',
    collapsedByDefault: false,
  },
  {
    family: 'gpt-5.6-terra',
    familyLabel: 'GPT-5.6-Terra',
    standardId: 'gpt-5.6-terra',
    longId: 'gpt-5.6-terra-1m',
    collapsedByDefault: true,
  },
  {
    family: 'gpt-5.6-luna',
    familyLabel: 'GPT-5.6-Luna',
    standardId: 'gpt-5.6-luna',
    longId: 'gpt-5.6-luna-1m',
    collapsedByDefault: true,
  },
  {
    family: 'kimi-k3',
    familyLabel: 'Kimi K3',
    standardId: 'k3-256k',
    longId: 'kimi-k3',
    collapsedByDefault: false,
  },
] as const

export type ContextTierFamily = (typeof CONTEXT_TIER_FAMILIES)[number]
export type ContextTierFamilyId = ContextTierFamily['family']

/** 选择器折叠组标题(单一权威,前端与测试共用)。 */
export const COLLAPSED_CONTEXT_FAMILY_GROUP_LABEL = '更多 GPT 模型'

export function contextFamilyCollapsedByDefault(family: ContextTierFamilyId): boolean {
  return CONTEXT_TIER_FAMILIES.some((row) => row.family === family && row.collapsedByDefault)
}

export function contextFamilyByModelId(
  modelId: string | null | undefined,
): ContextTierFamily | undefined {
  if (typeof modelId !== 'string') return undefined
  return CONTEXT_TIER_FAMILIES.find(
    (family) => family.standardId === modelId || family.longId === modelId,
  )
}

export function contextFamilyDefaultLong(_family: ContextTierFamilyId): boolean {
  return false
}

export function isCodexLongContextModel(modelId: string | null | undefined): boolean {
  if (typeof modelId !== 'string') return false
  return CODEX_ENGINE_MODELS.some((model) => model.id === modelId && model.longContext === true)
}

/** Canonical OpenClaude id → model name Codex CLI / app-server accepts. */
export function codexTransportModelId(modelId: string | undefined): string | undefined {
  if (!modelId) return modelId
  const row = CODEX_ENGINE_MODELS.find((model) => model.id === modelId)
  if (row && 'cliModel' in row && typeof row.cliModel === 'string' && row.cliModel) {
    return row.cliModel
  }
  return modelId
}

/** xAI 官方 Grok CLI 的编码产品型号。 */
export const GROK_ENGINE_MODELS = [
  { id: 'grok-build', displayName: 'Grok Build', upstreamModel: 'grok-4.6' },
] as const

export const GROK_ENGINE_MODEL_IDS = GROK_ENGINE_MODELS.map((m) => m.id)
export type GrokEngineModelId = (typeof GROK_ENGINE_MODELS)[number]['id']
export const DEFAULT_GROK_ENGINE_MODEL: GrokEngineModelId = GROK_ENGINE_MODELS[0].id

export function isGrokEngineModel(modelId: string | null | undefined): boolean {
  return (
    typeof modelId === 'string' &&
    (GROK_ENGINE_MODEL_IDS as readonly string[]).includes(modelId)
  )
}

/**
 * Experimental community ZCode CLI engine (bundled `zcode.cjs` 0.16.3 from
 * official desktop AppImage 3.8.1). Not an official standalone CLI product.
 * `id` is the hidden canary. Public `glm-5.3-zai` stays a catalog row and is
 * only mapped here for CLI transport after an audited engine switch.
 * `upstreamModel` is the provider/model string 0.16.3 accepts via config
 * `model.main` (no `--model` flag). User-supplied upstream ids are rejected.
 */
export const ZCODE_CLI_UPSTREAM_MODEL = 'zai-coding-plan/glm-5.3'
export const ZCODE_ENGINE_MODELS = [
  {
    id: 'zcode-experimental',
    displayName: 'ZCode Experimental',
    upstreamModel: ZCODE_CLI_UPSTREAM_MODEL,
    experimental: true,
    communityCliVersion: '0.16.3',
  },
] as const

export const ZCODE_ENGINE_MODEL_IDS = ZCODE_ENGINE_MODELS.map((m) => m.id)
export type ZcodeEngineModelId = (typeof ZCODE_ENGINE_MODELS)[number]['id']
export const DEFAULT_ZCODE_ENGINE_MODEL: ZcodeEngineModelId = ZCODE_ENGINE_MODELS[0].id
/** Canonical ids that may be mapped to the pinned CLI upstream. Public
 * `glm-5.3-zai` is intentionally absent from ZCODE_ENGINE_MODEL_IDS so the
 * pre-cutover catalog engine (ccb) still wins. */
export const ZCODE_TRANSPORT_CANONICAL_IDS = [
  'zcode-experimental',
  'glm-5.3-zai',
] as const
/** Headless permission mode locked from live 0.16.3 help: build/plan ask; edit
 * has no command execution; yolo is the only unattended all-tools mode. */
export const ZCODE_HOSTED_PERMISSION_MODE = 'yolo' as const

export function isZcodeEngineModel(modelId: string | null | undefined): boolean {
  return (
    typeof modelId === 'string' &&
    (ZCODE_ENGINE_MODEL_IDS as readonly string[]).includes(modelId)
  )
}

export function zcodeTransportModelId(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined
  if ((ZCODE_TRANSPORT_CANONICAL_IDS as readonly string[]).includes(modelId)) {
    return ZCODE_CLI_UPSTREAM_MODEL
  }
  return undefined
}

/**
 * Pinned official Cursor Agent CLI model allowlist.
 *
 * `id` is the OpenClaude-facing canonical model. `upstreamModel` is either the
 * exact value reported by the pinned CLI's `--list-models`, or null for Auto
 * (where the adapter deliberately omits `--model`). User input is never used
 * as a CLI argument.
 *
 * Effort and Fast are encoded in the canonical id (Cursor CLI has no separate
 * `--effort` flag we control). The picker groups by `family` and remaps to a
 * catalog row; `modelReasoningPolicy` stays empty so inbound.message.effort
 * is not sent for Cursor turns.
 */
export type CursorEngineFamilyId =
  | 'auto'
  | 'grok-4.6'
  | 'composer-2.5'
  | 'opus-5'
  | 'opus-4.8'
  | 'fable-5'
  | 'fable-5.1'
  | 'sonnet-5'
  | 'gemini-3.8-flash'
  | 'grok-4.5'

export const CURSOR_ENGINE_MODELS = [
  {
    id: 'cursor-auto',
    displayName: 'Cursor Auto',
    upstreamModel: null,
    family: 'auto',
    familyLabel: 'Cursor Auto',
    effort: null,
    fast: false,
  },
  {
    id: 'cursor-grok-4.6-low',
    displayName: 'Grok 4.6 Low',
    upstreamModel: 'cursor-grok-4.6-low',
    family: 'grok-4.6',
    familyLabel: 'Grok 4.6',
    effort: 'low',
    fast: false,
  },
  {
    id: 'cursor-grok-4.6-low-fast',
    displayName: 'Grok 4.6 Low Fast',
    upstreamModel: 'cursor-grok-4.6-low-fast',
    family: 'grok-4.6',
    familyLabel: 'Grok 4.6',
    effort: 'low',
    fast: true,
  },
  {
    id: 'cursor-grok-4.6-medium',
    displayName: 'Grok 4.6 Medium',
    upstreamModel: 'cursor-grok-4.6-medium',
    family: 'grok-4.6',
    familyLabel: 'Grok 4.6',
    effort: 'medium',
    fast: false,
  },
  {
    id: 'cursor-grok-4.6-medium-fast',
    displayName: 'Grok 4.6 Medium Fast',
    upstreamModel: 'cursor-grok-4.6-medium-fast',
    family: 'grok-4.6',
    familyLabel: 'Grok 4.6',
    effort: 'medium',
    fast: true,
  },
  {
    id: 'cursor-grok-4.6-high',
    displayName: 'Grok 4.6 High',
    upstreamModel: 'cursor-grok-4.6-high',
    family: 'grok-4.6',
    familyLabel: 'Grok 4.6',
    effort: 'high',
    fast: false,
  },
  {
    id: 'cursor-grok-4.6-high-fast',
    displayName: 'Grok 4.6 High Fast',
    upstreamModel: 'cursor-grok-4.6-high-fast',
    family: 'grok-4.6',
    familyLabel: 'Grok 4.6',
    effort: 'high',
    fast: true,
  },
  {
    id: 'cursor-grok-4.6-xhigh',
    displayName: 'Grok 4.6 Extra High',
    upstreamModel: 'cursor-grok-4.6-xhigh',
    family: 'grok-4.6',
    familyLabel: 'Grok 4.6',
    effort: 'xhigh',
    fast: false,
  },
  {
    id: 'cursor-grok-4.6-xhigh-fast',
    displayName: 'Grok 4.6 Extra High Fast',
    upstreamModel: 'cursor-grok-4.6-xhigh-fast',
    family: 'grok-4.6',
    familyLabel: 'Grok 4.6',
    effort: 'xhigh',
    fast: true,
  },
  {
    id: 'cursor-composer-2.5',
    displayName: 'Composer 2.5',
    upstreamModel: 'composer-2.5',
    family: 'composer-2.5',
    familyLabel: 'Composer 2.5',
    effort: null,
    fast: false,
  },
  {
    id: 'cursor-composer-2.5-fast',
    displayName: 'Composer 2.5 Fast',
    upstreamModel: 'composer-2.5-fast',
    family: 'composer-2.5',
    familyLabel: 'Composer 2.5',
    effort: null,
    fast: true,
  },

  {
    id: 'cursor-opus-4.8-low',
    displayName: 'Opus 4.8 Low',
    upstreamModel: 'claude-opus-4-8-thinking-low',
    family: 'opus-4.8',
    familyLabel: 'Opus 4.8',
    effort: 'low',
    fast: false,
  },
  {
    id: 'cursor-opus-4.8-low-fast',
    displayName: 'Opus 4.8 Low Fast',
    upstreamModel: 'claude-opus-4-8-thinking-low-fast',
    family: 'opus-4.8',
    familyLabel: 'Opus 4.8',
    effort: 'low',
    fast: true,
  },
  {
    id: 'cursor-opus-4.8-medium',
    displayName: 'Opus 4.8 Medium',
    upstreamModel: 'claude-opus-4-8-thinking-medium',
    family: 'opus-4.8',
    familyLabel: 'Opus 4.8',
    effort: 'medium',
    fast: false,
  },
  {
    id: 'cursor-opus-4.8-medium-fast',
    displayName: 'Opus 4.8 Medium Fast',
    upstreamModel: 'claude-opus-4-8-thinking-medium-fast',
    family: 'opus-4.8',
    familyLabel: 'Opus 4.8',
    effort: 'medium',
    fast: true,
  },
  {
    id: 'cursor-opus-4.8-high',
    displayName: 'Opus 4.8 High',
    upstreamModel: 'claude-opus-4-8-thinking-high',
    family: 'opus-4.8',
    familyLabel: 'Opus 4.8',
    effort: 'high',
    fast: false,
  },
  {
    id: 'cursor-opus-4.8-high-fast',
    displayName: 'Opus 4.8 High Fast',
    upstreamModel: 'claude-opus-4-8-thinking-high-fast',
    family: 'opus-4.8',
    familyLabel: 'Opus 4.8',
    effort: 'high',
    fast: true,
  },
  {
    id: 'cursor-opus-4.8-xhigh',
    displayName: 'Opus 4.8 Extra High',
    upstreamModel: 'claude-opus-4-8-thinking-xhigh',
    family: 'opus-4.8',
    familyLabel: 'Opus 4.8',
    effort: 'xhigh',
    fast: false,
  },
  {
    id: 'cursor-opus-4.8-xhigh-fast',
    displayName: 'Opus 4.8 Extra High Fast',
    upstreamModel: 'claude-opus-4-8-thinking-xhigh-fast',
    family: 'opus-4.8',
    familyLabel: 'Opus 4.8',
    effort: 'xhigh',
    fast: true,
  },
  {
    id: 'cursor-opus-4.8-max',
    displayName: 'Opus 4.8 Max',
    upstreamModel: 'claude-opus-4-8-thinking-max',
    family: 'opus-4.8',
    familyLabel: 'Opus 4.8',
    effort: 'max',
    fast: false,
  },
  {
    id: 'cursor-opus-4.8-max-fast',
    displayName: 'Opus 4.8 Max Fast',
    upstreamModel: 'claude-opus-4-8-thinking-max-fast',
    family: 'opus-4.8',
    familyLabel: 'Opus 4.8',
    effort: 'max',
    fast: true,
  },
  {
    id: 'cursor-opus-5-low',
    displayName: 'Opus 5 Low',
    upstreamModel: 'claude-opus-5-thinking-low',
    family: 'opus-5',
    familyLabel: 'Opus 5',
    effort: 'low',
    fast: false,
  },
  {
    id: 'cursor-opus-5-low-fast',
    displayName: 'Opus 5 Low Fast',
    upstreamModel: 'claude-opus-5-thinking-low-fast',
    family: 'opus-5',
    familyLabel: 'Opus 5',
    effort: 'low',
    fast: true,
  },
  {
    id: 'cursor-opus-5-medium',
    displayName: 'Opus 5 Medium',
    upstreamModel: 'claude-opus-5-thinking-medium',
    family: 'opus-5',
    familyLabel: 'Opus 5',
    effort: 'medium',
    fast: false,
  },
  {
    id: 'cursor-opus-5-medium-fast',
    displayName: 'Opus 5 Medium Fast',
    upstreamModel: 'claude-opus-5-thinking-medium-fast',
    family: 'opus-5',
    familyLabel: 'Opus 5',
    effort: 'medium',
    fast: true,
  },
  {
    id: 'cursor-opus-5-high',
    displayName: 'Opus 5 High',
    upstreamModel: 'claude-opus-5-thinking-high',
    family: 'opus-5',
    familyLabel: 'Opus 5',
    effort: 'high',
    fast: false,
  },
  {
    id: 'cursor-opus-5-high-fast',
    displayName: 'Opus 5 High Fast',
    upstreamModel: 'claude-opus-5-thinking-high-fast',
    family: 'opus-5',
    familyLabel: 'Opus 5',
    effort: 'high',
    fast: true,
  },
  {
    id: 'cursor-opus-5-xhigh',
    displayName: 'Opus 5 Extra High',
    upstreamModel: 'claude-opus-5-thinking-xhigh',
    family: 'opus-5',
    familyLabel: 'Opus 5',
    effort: 'xhigh',
    fast: false,
  },
  {
    id: 'cursor-opus-5-xhigh-fast',
    displayName: 'Opus 5 Extra High Fast',
    upstreamModel: 'claude-opus-5-thinking-xhigh-fast',
    family: 'opus-5',
    familyLabel: 'Opus 5',
    effort: 'xhigh',
    fast: true,
  },
  {
    id: 'cursor-opus-5-max',
    displayName: 'Opus 5 Max',
    upstreamModel: 'claude-opus-5-thinking-max',
    family: 'opus-5',
    familyLabel: 'Opus 5',
    effort: 'max',
    fast: false,
  },
  {
    id: 'cursor-opus-5-max-fast',
    displayName: 'Opus 5 Max Fast',
    upstreamModel: 'claude-opus-5-thinking-max-fast',
    family: 'opus-5',
    familyLabel: 'Opus 5',
    effort: 'max',
    fast: true,
  },
  {
    id: 'cursor-opus-4.8-low',
    displayName: 'Opus 4.8 Low',
    upstreamModel: 'claude-opus-4-8-thinking-low',
    family: 'opus-4.8',
    familyLabel: 'Opus 4.8',
    effort: 'low',
    fast: false,
  },
  {
    id: 'cursor-opus-4.8-low-fast',
    displayName: 'Opus 4.8 Low Fast',
    upstreamModel: 'claude-opus-4-8-thinking-low-fast',
    family: 'opus-4.8',
    familyLabel: 'Opus 4.8',
    effort: 'low',
    fast: true,
  },
  {
    id: 'cursor-opus-4.8-medium',
    displayName: 'Opus 4.8 Medium',
    upstreamModel: 'claude-opus-4-8-thinking-medium',
    family: 'opus-4.8',
    familyLabel: 'Opus 4.8',
    effort: 'medium',
    fast: false,
  },
  {
    id: 'cursor-opus-4.8-medium-fast',
    displayName: 'Opus 4.8 Medium Fast',
    upstreamModel: 'claude-opus-4-8-thinking-medium-fast',
    family: 'opus-4.8',
    familyLabel: 'Opus 4.8',
    effort: 'medium',
    fast: true,
  },
  {
    id: 'cursor-opus-4.8-high',
    displayName: 'Opus 4.8 High',
    upstreamModel: 'claude-opus-4-8-thinking-high',
    family: 'opus-4.8',
    familyLabel: 'Opus 4.8',
    effort: 'high',
    fast: false,
  },
  {
    id: 'cursor-opus-4.8-high-fast',
    displayName: 'Opus 4.8 High Fast',
    upstreamModel: 'claude-opus-4-8-thinking-high-fast',
    family: 'opus-4.8',
    familyLabel: 'Opus 4.8',
    effort: 'high',
    fast: true,
  },
  {
    id: 'cursor-opus-4.8-xhigh',
    displayName: 'Opus 4.8 Extra High',
    upstreamModel: 'claude-opus-4-8-thinking-xhigh',
    family: 'opus-4.8',
    familyLabel: 'Opus 4.8',
    effort: 'xhigh',
    fast: false,
  },
  {
    id: 'cursor-opus-4.8-xhigh-fast',
    displayName: 'Opus 4.8 Extra High Fast',
    upstreamModel: 'claude-opus-4-8-thinking-xhigh-fast',
    family: 'opus-4.8',
    familyLabel: 'Opus 4.8',
    effort: 'xhigh',
    fast: true,
  },
  {
    id: 'cursor-opus-4.8-max',
    displayName: 'Opus 4.8 Max',
    upstreamModel: 'claude-opus-4-8-thinking-max',
    family: 'opus-4.8',
    familyLabel: 'Opus 4.8',
    effort: 'max',
    fast: false,
  },
  {
    id: 'cursor-opus-4.8-max-fast',
    displayName: 'Opus 4.8 Max Fast',
    upstreamModel: 'claude-opus-4-8-thinking-max-fast',
    family: 'opus-4.8',
    familyLabel: 'Opus 4.8',
    effort: 'max',
    fast: true,
  },
  {
    id: 'cursor-fable-5-low',
    displayName: 'Fable 5 Low (Non-ZDR)',
    upstreamModel: 'claude-fable-5-thinking-low',
    family: 'fable-5',
    familyLabel: 'Fable 5',
    effort: 'low',
    fast: false,
  },
  {
    id: 'cursor-fable-5-medium',
    displayName: 'Fable 5 Medium (Non-ZDR)',
    upstreamModel: 'claude-fable-5-thinking-medium',
    family: 'fable-5',
    familyLabel: 'Fable 5',
    effort: 'medium',
    fast: false,
  },
  {
    id: 'cursor-fable-5-high',
    displayName: 'Fable 5 High (Non-ZDR)',
    upstreamModel: 'claude-fable-5-thinking-high',
    family: 'fable-5',
    familyLabel: 'Fable 5',
    effort: 'high',
    fast: false,
  },
  {
    id: 'cursor-fable-5-xhigh',
    displayName: 'Fable 5 Extra High (Non-ZDR)',
    upstreamModel: 'claude-fable-5-thinking-xhigh',
    family: 'fable-5',
    familyLabel: 'Fable 5',
    effort: 'xhigh',
    fast: false,
  },
  {
    id: 'cursor-fable-5-max',
    displayName: 'Fable 5 Max (Non-ZDR)',
    upstreamModel: 'claude-fable-5-thinking-max',
    family: 'fable-5',
    familyLabel: 'Fable 5',
    effort: 'max',
    fast: false,
  },
  {
    id: 'cursor-fable-5.1-low',
    displayName: 'Fable 5.1 Low (Non-ZDR)',
    upstreamModel: 'claude-fable-5-1-thinking-low',
    family: 'fable-5.1',
    familyLabel: 'Fable 5.1',
    effort: 'low',
    fast: false,
  },
  {
    id: 'cursor-fable-5.1-medium',
    displayName: 'Fable 5.1 Medium (Non-ZDR)',
    upstreamModel: 'claude-fable-5-1-thinking-medium',
    family: 'fable-5.1',
    familyLabel: 'Fable 5.1',
    effort: 'medium',
    fast: false,
  },
  {
    id: 'cursor-fable-5.1-high',
    displayName: 'Fable 5.1 High (Non-ZDR)',
    upstreamModel: 'claude-fable-5-1-thinking-high',
    family: 'fable-5.1',
    familyLabel: 'Fable 5.1',
    effort: 'high',
    fast: false,
  },
  {
    id: 'cursor-fable-5.1-xhigh',
    displayName: 'Fable 5.1 Extra High (Non-ZDR)',
    upstreamModel: 'claude-fable-5-1-thinking-xhigh',
    family: 'fable-5.1',
    familyLabel: 'Fable 5.1',
    effort: 'xhigh',
    fast: false,
  },
  {
    id: 'cursor-fable-5.1-max',
    displayName: 'Fable 5.1 Max (Non-ZDR)',
    upstreamModel: 'claude-fable-5-1-thinking-max',
    family: 'fable-5.1',
    familyLabel: 'Fable 5.1',
    effort: 'max',
    fast: false,
  },
  // Sonnet 5: pinned CLI `--list-models` (2026-09-05) thinking variants
  // claude-sonnet-5-thinking-{low,medium,high,xhigh,max}; no Fast variant, so
  // none are catalogued (Claude-family policy: thinking upstreams only).
  {
    id: 'cursor-sonnet-5-low',
    displayName: 'Sonnet 5 Low',
    upstreamModel: 'claude-sonnet-5-thinking-low',
    family: 'sonnet-5',
    familyLabel: 'Sonnet 5',
    effort: 'low',
    fast: false,
  },
  {
    id: 'cursor-sonnet-5-medium',
    displayName: 'Sonnet 5 Medium',
    upstreamModel: 'claude-sonnet-5-thinking-medium',
    family: 'sonnet-5',
    familyLabel: 'Sonnet 5',
    effort: 'medium',
    fast: false,
  },
  {
    id: 'cursor-sonnet-5-high',
    displayName: 'Sonnet 5 High',
    upstreamModel: 'claude-sonnet-5-thinking-high',
    family: 'sonnet-5',
    familyLabel: 'Sonnet 5',
    effort: 'high',
    fast: false,
  },
  {
    id: 'cursor-sonnet-5-xhigh',
    displayName: 'Sonnet 5 Extra High',
    upstreamModel: 'claude-sonnet-5-thinking-xhigh',
    family: 'sonnet-5',
    familyLabel: 'Sonnet 5',
    effort: 'xhigh',
    fast: false,
  },
  {
    id: 'cursor-sonnet-5-max',
    displayName: 'Sonnet 5 Max',
    upstreamModel: 'claude-sonnet-5-thinking-max',
    family: 'sonnet-5',
    familyLabel: 'Sonnet 5',
    effort: 'max',
    fast: false,
  },
  // Gemini 3.8 Flash: pinned CLI `--list-models` (2026-09-04) exposes exactly
  // gemini-3.8-flash-{low,medium,high}; no Fast, xhigh or max variants exist,
  // so none are catalogued.
  {
    id: 'cursor-gemini-3.8-flash-low',
    displayName: 'Gemini 3.8 Flash Low',
    upstreamModel: 'gemini-3.8-flash-low',
    family: 'gemini-3.8-flash',
    familyLabel: 'Gemini 3.8 Flash',
    effort: 'low',
    fast: false,
  },
  {
    id: 'cursor-gemini-3.8-flash-medium',
    displayName: 'Gemini 3.8 Flash Medium',
    upstreamModel: 'gemini-3.8-flash-medium',
    family: 'gemini-3.8-flash',
    familyLabel: 'Gemini 3.8 Flash',
    effort: 'medium',
    fast: false,
  },
  {
    id: 'cursor-gemini-3.8-flash-high',
    displayName: 'Gemini 3.8 Flash High',
    upstreamModel: 'gemini-3.8-flash-high',
    family: 'gemini-3.8-flash',
    familyLabel: 'Gemini 3.8 Flash',
    effort: 'high',
    fast: false,
  },
  {
    id: 'cursor-grok-4.5-high',
    displayName: 'Grok 4.5 High',
    upstreamModel: 'cursor-grok-4.5-high',
    family: 'grok-4.5',
    familyLabel: 'Grok 4.5',
    effort: 'high',
    fast: false,
  },
] as const

export const CURSOR_ENGINE_MODEL_IDS = CURSOR_ENGINE_MODELS.map((m) => m.id)
export type CursorEngineModelId = (typeof CURSOR_ENGINE_MODELS)[number]['id']
export type CursorEngineModel = (typeof CURSOR_ENGINE_MODELS)[number]
export const DEFAULT_CURSOR_ENGINE_MODEL: CursorEngineModelId = CURSOR_ENGINE_MODELS[0].id

export function isCursorEngineModel(modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' &&
    (CURSOR_ENGINE_MODEL_IDS as readonly string[]).includes(modelId)
}

export function cursorModelById(modelId: string | null | undefined): CursorEngineModel | undefined {
  if (typeof modelId !== 'string') return undefined
  return CURSOR_ENGINE_MODELS.find((model) => model.id === modelId)
}

export type CursorCredentialModelFamily = 'cursor_models' | 'other_models'

/** Cursor's account pool has separate quota eligibility for built-in Cursor
 * Models versus Other Models. Accept canonical platform ids or the pinned
 * CLI upstream ids so wrapper learning and gateway credential refresh consume
 * one classification contract. */
export function cursorCredentialModelFamily(
  modelId: string | null | undefined,
): CursorCredentialModelFamily {
  const raw = typeof modelId === 'string' ? modelId.trim() : ''
  const known = cursorModelById(raw)
  const upstream = known ? known.upstreamModel ?? 'auto' : raw
  if (!upstream || upstream === 'auto') return 'cursor_models'
  return /^(?:cursor-grok-4\.[56]|composer-2\.5)(?:-|$)/.test(upstream)
    ? 'cursor_models'
    : 'other_models'
}

export function cursorFamilyDefaultEffort(
  family: CursorEngineFamilyId,
): PlatformReasoningEffort | null {
  if (family === 'auto' || family === 'composer-2.5') return null
  return 'high'
}

export function cursorFamilyDefaultFast(_family: CursorEngineFamilyId): boolean {
  return false
}

export function cursorFamilySupportsFast(family: CursorEngineFamilyId): boolean {
  return CURSOR_ENGINE_MODELS.some((model) => model.family === family && model.fast)
}

export function cursorFamilyEfforts(
  family: CursorEngineFamilyId,
): readonly PlatformReasoningEffort[] {
  const present = new Set(
    CURSOR_ENGINE_MODELS.filter((model) => model.family === family && model.effort !== null).map(
      (model) => model.effort,
    ),
  )
  return PLATFORM_REASONING_EFFORTS.filter((effort) => present.has(effort))
}

export function findCursorEngineModel(
  family: CursorEngineFamilyId,
  effort: PlatformReasoningEffort | null,
  fast: boolean,
): CursorEngineModel | undefined {
  return CURSOR_ENGINE_MODELS.find(
    (model) => model.family === family && model.effort === effort && model.fast === fast,
  )
}

// ── Cursor Opus/Fable turn-level context tier ────────────────────────────────
// Upstream Cursor Opus 5 / Opus 4.8 / Fable 5 / Fable 5.1 SKUs run a 1M
// context window. The platform exposes two execution tiers per turn without
// minting new canonical ids: the tier only narrows the signed
// executionDescriptor.contextWindow the master hands to the CCB harness
// (auto-compact threshold), so switching tiers never recycles the CCB process
// or changes the Cursor Sand resume id. Catalog context_window for these rows
// must be the mechanism ceiling (1,000,000); `300k` is the product default
// because compaction at ~267k keeps per-turn input cost bounded.
export const CURSOR_CONTEXT_TIERS = ['300k', '1m'] as const
export type CursorContextTier = (typeof CURSOR_CONTEXT_TIERS)[number]
export const DEFAULT_CURSOR_CONTEXT_TIER: CursorContextTier = '300k'
export const CURSOR_CONTEXT_TIER_WINDOW: Readonly<Record<CursorContextTier, number>> = {
  '300k': 300_000,
  '1m': 1_000_000,
}
export const CURSOR_CONTEXT_TIER_FAMILIES: readonly CursorEngineFamilyId[] = [
  'opus-5',
  'opus-4.8',
  'fable-5',
  'fable-5.1',
  'sonnet-5',
]

export function isCursorContextTier(value: unknown): value is CursorContextTier {
  return typeof value === 'string' &&
    (CURSOR_CONTEXT_TIERS as readonly string[]).includes(value)
}

export function cursorFamilySupportsContextTier(family: CursorEngineFamilyId): boolean {
  return CURSOR_CONTEXT_TIER_FAMILIES.includes(family)
}

/** True when the canonical id belongs to a Cursor family that offers the
 * 300k/1M tier choice. Any other model ignores `contextTier` entirely. */
export function cursorModelSupportsContextTier(modelId: string | null | undefined): boolean {
  const model = cursorModelById(modelId)
  return model !== undefined && cursorFamilySupportsContextTier(model.family)
}

/**
 * Pure projection shared by every consumer that narrows an execution window by
 * tier. `contextWindow` is the catalog mechanism ceiling (null = no window
 * semantics → passthrough). Non-tier models or unknown tiers return the input
 * unchanged; the tier can only narrow (min), never widen past the ceiling.
 */
export function projectContextWindowForCursorTier(
  modelId: string | null | undefined,
  contextWindow: number | null,
  tier: CursorContextTier | null | undefined,
): number | null {
  if (contextWindow === null) return contextWindow
  if (!cursorModelSupportsContextTier(modelId)) return contextWindow
  const effective = tier ?? DEFAULT_CURSOR_CONTEXT_TIER
  return Math.min(contextWindow, CURSOR_CONTEXT_TIER_WINDOW[effective])
}

/** codex seed agent(id='codex')的固定模型 —— entrypoint desiredCodexAgent 同值。 */
export const DEFAULT_CODEX_ENGINE_MODEL: CodexEngineModelId = CODEX_ENGINE_MODELS[0].id
export const DEFAULT_CODEX_ENGINE_MODEL_DISPLAY_NAME: string =
  CODEX_ENGINE_MODELS[0].displayName

export interface ModelReasoningPolicy {
  /** 该模型在 v5 可接受/展示的思考档位；空数组 = 本模型不支持该功能。 */
  supported: readonly PlatformReasoningEffort[]
  /** 仅 Codex 型号有值；用户未覆盖时 runner 必须沿用这个模型自身默认。 */
  codexModelDefault: PlatformReasoningEffort | null
}

/**
 * model → 思考能力的单一权威。
 *
 * - Codex:型号目录给出的默认值 + v5 平台公共五档；
 * - 静态 provider:沿用其 allowedOutputConfigEfforts / stripBodyFields 声明；
 * - 其它可透传模型:统一五档。
 *
 * API、admin 校验、gateway 与前端都必须消费本函数或其 API 投影,不得另抄清单。
 *
 * Cursor 思考档编码在 canonical model id 里(见 CURSOR_ENGINE_MODELS.effort/fast),
 * 不走 inbound.message.effort,故 supported 保持空数组。
 */
export function modelReasoningPolicy(modelId: string): ModelReasoningPolicy {
  const codex = CODEX_ENGINE_MODELS.find((m) => m.id === modelId)
  if (codex) {
    return {
      supported: PLATFORM_REASONING_EFFORTS,
      codexModelDefault: codex.defaultReasoningEffort,
    }
  }

  if (isGrokEngineModel(modelId)) {
    return {
      supported: ['low', 'medium', 'high'],
      codexModelDefault: null,
    }
  }

  if (isCursorEngineModel(modelId)) {
    return { supported: [], codexModelDefault: null }
  }

  if (isZcodeEngineModel(modelId)) {
    return { supported: [], codexModelDefault: null }
  }

  const provider = findRouteProviderForModel(modelId)
  if (provider?.allowedOutputConfigEfforts) {
    const platformSet = new Set<string>(PLATFORM_REASONING_EFFORTS)
    return {
      supported: provider.allowedOutputConfigEfforts.filter(
        (effort): effort is PlatformReasoningEffort => platformSet.has(effort),
      ),
      codexModelDefault: null,
    }
  }
  if (provider?.stripBodyFields.includes('output_config')) {
    return { supported: [], codexModelDefault: null }
  }
  return { supported: PLATFORM_REASONING_EFFORTS, codexModelDefault: null }
}

/**
 * 该 model id 是否由 codex engine 承接(精确匹配,大小写敏感 —— 与
 * resolveEngine 的 MODEL_ENGINE_MAP key 查找逐字节一致)。
 * 注意:**不是** `gpt-` 前缀判定 —— 前缀在 resolveExecutionModel 白名单收敛后
 * 与精确集等价,但前缀判定会把「白名单外的 gpt-xxx(实际被收敛到平台默认、
 * 落 CCB)」误分类成 codex,破坏 master/容器判定同构。
 */
export function isCodexEngineModel(modelId: string | null | undefined): boolean {
  return (
    typeof modelId === 'string' &&
    (CODEX_ENGINE_MODEL_IDS as readonly string[]).includes(modelId)
  )
}
