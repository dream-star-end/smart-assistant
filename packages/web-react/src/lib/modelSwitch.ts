import { cursorModelById } from '@openclaude/protocol'
import type { PublicModel } from './types'

export type ModelSwitchCompactionReason = {
  visionDowngrade: boolean
  contextDowngrade: boolean
}

export function modelSwitchCompactionReason(
  models: readonly PublicModel[],
  sourceModelId: string | undefined,
  targetModelId: string,
  hasConversationContent: boolean,
): ModelSwitchCompactionReason | null {
  if (!hasConversationContent || !sourceModelId || sourceModelId === targetModelId) return null
  const source = models.find((model) => model.id === sourceModelId)
  const target = models.find((model) => model.id === targetModelId)
  if (!source || !target) return null
  const visionDowngrade = source.supports_vision === true && target.supports_vision === false
  const sourceWindow = typeof source.context_window === 'number' ? source.context_window : null
  const targetWindow = typeof target.context_window === 'number' ? target.context_window : null
  const explicitLongToStandardVariant =
    sourceModelId.endsWith('-1m') && sourceModelId.slice(0, -3) === targetModelId
  const contextDowngrade =
    explicitLongToStandardVariant ||
    (sourceWindow !== null && targetWindow !== null && sourceWindow > targetWindow)
  return visionDowngrade || contextDowngrade ? { visionDowngrade, contextDowngrade } : null
}

/**
 * Opus / Fable(Cursor 引擎的 Anthropic 家族)只允许在**新会话**里启用:已有会话若正在
 * 用其他模型,切过去意味着首轮要把全部历史一次性喂给新模型——初始上下文过大,且无法
 * 命中提示缓存,费用与等待都明显变差。产品决策:此时不切换,弹窗说明并给「新建会话」
 * 快捷入口(新会话以目标模型起手)。Opus ↔ Fable 互切、以及空会话不受此限。
 */
const FRESH_SESSION_ONLY_FAMILY = /^(opus|fable)(-|$)/

export function isFreshSessionOnlyModel(modelId: string | null | undefined): boolean {
  const def = cursorModelById(modelId)
  return def !== undefined && FRESH_SESSION_ONLY_FAMILY.test(def.family)
}

export function freshSessionRequiredForSwitch(
  sourceModelId: string | undefined,
  targetModelId: string,
  hasConversationContent: boolean,
): boolean {
  if (!hasConversationContent || !sourceModelId || sourceModelId === targetModelId) return false
  return !isFreshSessionOnlyModel(sourceModelId) && isFreshSessionOnlyModel(targetModelId)
}

export type FreshSessionSwitchNotice = {
  title: string
  paragraphs: string[]
  confirmText: string
  cancelText: string
}

export function freshSessionSwitchNotice(
  targetModelId: string,
  fallbackLabel?: string,
): FreshSessionSwitchNotice {
  const label =
    cursorModelById(targetModelId)?.familyLabel ?? fallbackLabel?.trim() ?? targetModelId
  return {
    title: `「${label}」仅支持在新会话中使用`,
    paragraphs: [
      `当前会话使用的不是 Opus / Fable 模型,已有的对话上下文无法直接交给 ${label}:首轮要一次性加载全部历史,初始上下文过大,且无法命中提示缓存,费用与等待时间都会明显增加。`,
      `请新建会话后使用 ${label}。当前会话保持原模型,历史内容与积分余额不受影响。`,
    ],
    confirmText: '新建会话',
    cancelText: '留在当前会话',
  }
}
