import { isCursorContextTier } from '@openclaude/protocol'
import { ModelSwitchCostError, type ModelSwitchCostService } from '../billing/modelSwitchCost.js'

/** The trusted image feature is a separate fixed-price request, not a chat switch. */
export async function checkModelSwitchFrame(
  service: ModelSwitchCostService | undefined,
  uid: string,
  frame: Record<string, unknown>,
  input: {
    sessionId: string
    requestId: string | null
    targetModel: string | null
    text: string
    temporaryImageFeature: boolean
  },
): Promise<{ code: string; message: string } | null> {
  if (!service || input.temporaryImageFeature) return null
  if (!input.targetModel)
    return { code: 'UNRESOLVED_AGENT_MODEL', message: '模型尚未确定，请刷新后重试' }
  if (!input.requestId)
    return { code: 'MODEL_SWITCH_REQUEST_ID_REQUIRED', message: '请刷新页面后重试，以确认本轮费用' }
  try {
    const content =
      frame.content && typeof frame.content === 'object'
        ? (frame.content as Record<string, unknown>)
        : {}
    await service.assertAuthorized(
      uid,
      {
        sessionId: input.sessionId,
        requestId: input.requestId,
        targetModel: input.targetModel,
        agentId: typeof frame.agentId === 'string' ? frame.agentId : 'main',
        teamMode: frame.teamMode === true,
        text: input.text,
        ...(isCursorContextTier(frame.contextTier) ? { contextTier: frame.contextTier } : {}),
        ...(frame.serviceTier === 'fast' ? { serviceTier: 'fast' as const } : {}),
        mediaCount: Array.isArray(content.media) ? content.media.length : 0,
      },
      typeof frame.modelSwitchConsent === 'string' ? frame.modelSwitchConsent : undefined,
    )
    return null
  } catch (error) {
    return {
      code: error instanceof ModelSwitchCostError ? error.code : 'MODEL_SWITCH_UNAVAILABLE',
      message: error instanceof ModelSwitchCostError ? error.message : '费用确认暂不可用，请重试',
    }
  }
}

export function promptQueueDispositionForCode(code: string): 'retryable' | 'user_action_required' {
  return /^(?:MODEL_SWITCH_|ERR_INSUFFICIENT_CREDITS|INSUFFICIENT_CREDITS|MODEL_NOT_AVAILABLE|UNAUTHORIZED_MODEL|UNRESOLVED_AGENT_MODEL|AGENT_NOT_FOUND|INVALID_|ERR_FRAME_TOO_BIG)/.test(
    code,
  )
    ? 'user_action_required'
    : 'retryable'
}

/** OCV5-391: what a refused scheduler replay does with its recovery job. A refusal the user has
 * to act on (retired or unauthorized model, credits, agent, invalid input) never succeeds by
 * waiting, so the job stops; anything else waits for the next attempt. */
export function _recoveryRefusalAction(code: string): 'pause' | 'requeue' {
  return promptQueueDispositionForCode(code) === 'user_action_required' ? 'pause' : 'requeue'
}

export function shouldRejectCodexTurnForG7(
  hasActiveTurn: boolean,
  isPromptQueueDispatch: boolean,
): boolean {
  return hasActiveTurn && !isPromptQueueDispatch
}
