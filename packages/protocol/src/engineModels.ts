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
 * Codex engine 模型号 + 模型自身默认思考深度的单一权威。
 * 顺序有产品语义:第一项同时是 codex seed / 团队模式队长默认型号。
 */
export const CODEX_ENGINE_MODELS = [
  { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', defaultReasoningEffort: 'xhigh' },
  { id: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', defaultReasoningEffort: 'xhigh' },
  { id: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', defaultReasoningEffort: 'medium' },
] as const satisfies readonly {
  id: string
  displayName: string
  defaultReasoningEffort: PlatformReasoningEffort
}[]

/** codex engine 承接的模型 id 全集(精确字面量,与 registry MODEL_ENGINE_MAP 同源)。 */
export const CODEX_ENGINE_MODEL_IDS = CODEX_ENGINE_MODELS.map((m) => m.id)

export type CodexEngineModelId = (typeof CODEX_ENGINE_MODELS)[number]['id']

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
 */
export const CURSOR_ENGINE_MODELS = [
  { id: 'cursor-auto', displayName: 'Cursor Auto', upstreamModel: null },
  { id: 'cursor-grok-4.6-high', displayName: 'Cursor Grok 4.6 High', upstreamModel: 'cursor-grok-4.6-high' },
  { id: 'cursor-composer-2.5-fast', displayName: 'Cursor Composer 2.5 Fast', upstreamModel: 'composer-2.5-fast' },
  { id: 'cursor-opus-5-high', displayName: 'Cursor Opus 5 High', upstreamModel: 'claude-opus-5-thinking-high' },
  { id: 'cursor-fable-5-high', displayName: 'Cursor Fable 5 High (Non-ZDR)', upstreamModel: 'claude-fable-5-thinking-high' },
  { id: 'cursor-grok-4.5-high', displayName: 'Cursor Grok 4.5 High', upstreamModel: 'cursor-grok-4.5-high' },
] as const
export const CURSOR_ENGINE_MODEL_IDS = CURSOR_ENGINE_MODELS.map((m) => m.id)
export type CursorEngineModelId = (typeof CURSOR_ENGINE_MODELS)[number]['id']
export const DEFAULT_CURSOR_ENGINE_MODEL: CursorEngineModelId = CURSOR_ENGINE_MODELS[0].id

export function isCursorEngineModel(modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' &&
    (CURSOR_ENGINE_MODEL_IDS as readonly string[]).includes(modelId)
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
