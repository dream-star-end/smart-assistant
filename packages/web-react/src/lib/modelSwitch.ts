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
  const contextDowngrade =
    sourceWindow !== null && targetWindow !== null && sourceWindow > targetWindow
  return visionDowngrade || contextDowngrade ? { visionDowngrade, contextDowngrade } : null
}
