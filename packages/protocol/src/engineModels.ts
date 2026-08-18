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
 * 顺序有产品语义:第一项同时是 codex seed / 团队模式队长默认型号。
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

export const CONTEXT_TIER_FAMILIES = [
  {
    family: 'gpt-5.6-sol',
    familyLabel: 'GPT-5.6-Sol',
    standardId: 'gpt-5.6-sol',
    longId: 'gpt-5.6-sol-1m',
  },
  {
    family: 'gpt-5.6-terra',
    familyLabel: 'GPT-5.6-Terra',
    standardId: 'gpt-5.6-terra',
    longId: 'gpt-5.6-terra-1m',
  },
  {
    family: 'gpt-5.6-luna',
    familyLabel: 'GPT-5.6-Luna',
    standardId: 'gpt-5.6-luna',
    longId: 'gpt-5.6-luna-1m',
  },
  {
    family: 'kimi-k3',
    familyLabel: 'Kimi K3',
    standardId: 'k3-256k',
    longId: 'kimi-k3',
  },
] as const

export type ContextTierFamily = (typeof CONTEXT_TIER_FAMILIES)[number]
export type ContextTierFamilyId = ContextTierFamily['family']

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
  | 'fable-5'
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
    displayName: 'Cursor Grok 4.6 Low',
    upstreamModel: 'cursor-grok-4.6-low',
    family: 'grok-4.6',
    familyLabel: 'Cursor Grok 4.6',
    effort: 'low',
    fast: false,
  },
  {
    id: 'cursor-grok-4.6-low-fast',
    displayName: 'Cursor Grok 4.6 Low Fast',
    upstreamModel: 'cursor-grok-4.6-low-fast',
    family: 'grok-4.6',
    familyLabel: 'Cursor Grok 4.6',
    effort: 'low',
    fast: true,
  },
  {
    id: 'cursor-grok-4.6-medium',
    displayName: 'Cursor Grok 4.6 Medium',
    upstreamModel: 'cursor-grok-4.6-medium',
    family: 'grok-4.6',
    familyLabel: 'Cursor Grok 4.6',
    effort: 'medium',
    fast: false,
  },
  {
    id: 'cursor-grok-4.6-medium-fast',
    displayName: 'Cursor Grok 4.6 Medium Fast',
    upstreamModel: 'cursor-grok-4.6-medium-fast',
    family: 'grok-4.6',
    familyLabel: 'Cursor Grok 4.6',
    effort: 'medium',
    fast: true,
  },
  {
    id: 'cursor-grok-4.6-high',
    displayName: 'Cursor Grok 4.6 High',
    upstreamModel: 'cursor-grok-4.6-high',
    family: 'grok-4.6',
    familyLabel: 'Cursor Grok 4.6',
    effort: 'high',
    fast: false,
  },
  {
    id: 'cursor-grok-4.6-high-fast',
    displayName: 'Cursor Grok 4.6 High Fast',
    upstreamModel: 'cursor-grok-4.6-high-fast',
    family: 'grok-4.6',
    familyLabel: 'Cursor Grok 4.6',
    effort: 'high',
    fast: true,
  },
  {
    id: 'cursor-grok-4.6-xhigh',
    displayName: 'Cursor Grok 4.6 Extra High',
    upstreamModel: 'cursor-grok-4.6-xhigh',
    family: 'grok-4.6',
    familyLabel: 'Cursor Grok 4.6',
    effort: 'xhigh',
    fast: false,
  },
  {
    id: 'cursor-grok-4.6-xhigh-fast',
    displayName: 'Cursor Grok 4.6 Extra High Fast',
    upstreamModel: 'cursor-grok-4.6-xhigh-fast',
    family: 'grok-4.6',
    familyLabel: 'Cursor Grok 4.6',
    effort: 'xhigh',
    fast: true,
  },
  {
    id: 'cursor-composer-2.5',
    displayName: 'Cursor Composer 2.5',
    upstreamModel: 'composer-2.5',
    family: 'composer-2.5',
    familyLabel: 'Cursor Composer 2.5',
    effort: null,
    fast: false,
  },
  {
    id: 'cursor-composer-2.5-fast',
    displayName: 'Cursor Composer 2.5 Fast',
    upstreamModel: 'composer-2.5-fast',
    family: 'composer-2.5',
    familyLabel: 'Cursor Composer 2.5',
    effort: null,
    fast: true,
  },
  {
    id: 'cursor-opus-5-low',
    displayName: 'Cursor Opus 5 Low',
    upstreamModel: 'claude-opus-5-thinking-low',
    family: 'opus-5',
    familyLabel: 'Cursor Opus 5',
    effort: 'low',
    fast: false,
  },
  {
    id: 'cursor-opus-5-low-fast',
    displayName: 'Cursor Opus 5 Low Fast',
    upstreamModel: 'claude-opus-5-thinking-low-fast',
    family: 'opus-5',
    familyLabel: 'Cursor Opus 5',
    effort: 'low',
    fast: true,
  },
  {
    id: 'cursor-opus-5-medium',
    displayName: 'Cursor Opus 5 Medium',
    upstreamModel: 'claude-opus-5-thinking-medium',
    family: 'opus-5',
    familyLabel: 'Cursor Opus 5',
    effort: 'medium',
    fast: false,
  },
  {
    id: 'cursor-opus-5-medium-fast',
    displayName: 'Cursor Opus 5 Medium Fast',
    upstreamModel: 'claude-opus-5-thinking-medium-fast',
    family: 'opus-5',
    familyLabel: 'Cursor Opus 5',
    effort: 'medium',
    fast: true,
  },
  {
    id: 'cursor-opus-5-high',
    displayName: 'Cursor Opus 5 High',
    upstreamModel: 'claude-opus-5-thinking-high',
    family: 'opus-5',
    familyLabel: 'Cursor Opus 5',
    effort: 'high',
    fast: false,
  },
  {
    id: 'cursor-opus-5-high-fast',
    displayName: 'Cursor Opus 5 High Fast',
    upstreamModel: 'claude-opus-5-thinking-high-fast',
    family: 'opus-5',
    familyLabel: 'Cursor Opus 5',
    effort: 'high',
    fast: true,
  },
  {
    id: 'cursor-opus-5-xhigh',
    displayName: 'Cursor Opus 5 Extra High',
    upstreamModel: 'claude-opus-5-thinking-xhigh',
    family: 'opus-5',
    familyLabel: 'Cursor Opus 5',
    effort: 'xhigh',
    fast: false,
  },
  {
    id: 'cursor-opus-5-xhigh-fast',
    displayName: 'Cursor Opus 5 Extra High Fast',
    upstreamModel: 'claude-opus-5-thinking-xhigh-fast',
    family: 'opus-5',
    familyLabel: 'Cursor Opus 5',
    effort: 'xhigh',
    fast: true,
  },
  {
    id: 'cursor-opus-5-max',
    displayName: 'Cursor Opus 5 Max',
    upstreamModel: 'claude-opus-5-thinking-max',
    family: 'opus-5',
    familyLabel: 'Cursor Opus 5',
    effort: 'max',
    fast: false,
  },
  {
    id: 'cursor-opus-5-max-fast',
    displayName: 'Cursor Opus 5 Max Fast',
    upstreamModel: 'claude-opus-5-thinking-max-fast',
    family: 'opus-5',
    familyLabel: 'Cursor Opus 5',
    effort: 'max',
    fast: true,
  },
  {
    id: 'cursor-fable-5-low',
    displayName: 'Cursor Fable 5 Low (Non-ZDR)',
    upstreamModel: 'claude-fable-5-thinking-low',
    family: 'fable-5',
    familyLabel: 'Cursor Fable 5',
    effort: 'low',
    fast: false,
  },
  {
    id: 'cursor-fable-5-medium',
    displayName: 'Cursor Fable 5 Medium (Non-ZDR)',
    upstreamModel: 'claude-fable-5-thinking-medium',
    family: 'fable-5',
    familyLabel: 'Cursor Fable 5',
    effort: 'medium',
    fast: false,
  },
  {
    id: 'cursor-fable-5-high',
    displayName: 'Cursor Fable 5 High (Non-ZDR)',
    upstreamModel: 'claude-fable-5-thinking-high',
    family: 'fable-5',
    familyLabel: 'Cursor Fable 5',
    effort: 'high',
    fast: false,
  },
  {
    id: 'cursor-fable-5-xhigh',
    displayName: 'Cursor Fable 5 Extra High (Non-ZDR)',
    upstreamModel: 'claude-fable-5-thinking-xhigh',
    family: 'fable-5',
    familyLabel: 'Cursor Fable 5',
    effort: 'xhigh',
    fast: false,
  },
  {
    id: 'cursor-fable-5-max',
    displayName: 'Cursor Fable 5 Max (Non-ZDR)',
    upstreamModel: 'claude-fable-5-thinking-max',
    family: 'fable-5',
    familyLabel: 'Cursor Fable 5',
    effort: 'max',
    fast: false,
  },
  {
    id: 'cursor-grok-4.5-high',
    displayName: 'Cursor Grok 4.5 High',
    upstreamModel: 'cursor-grok-4.5-high',
    family: 'grok-4.5',
    familyLabel: 'Cursor Grok 4.5',
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
