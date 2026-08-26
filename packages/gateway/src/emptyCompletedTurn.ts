/**
 * OCV5-1: completed 轮没有任何 plated 正文时，落一条中性说明。
 * 不改 executed_error（避免红卡）；interrupted / SERVICE_RESTART / USER_CANCELLED
 * 已有自己的表面，不得注入。
 */

export const EMPTY_COMPLETED_TURN_NOTICE = '本轮未能产出可见回复，已结束，可重试或继续'

const SKIP_ERROR_CODES = new Set(['SERVICE_RESTART', 'USER_CANCELLED'])

export function isPlatedAssistantBlock(
  block: { kind?: unknown; text?: unknown } | null | undefined,
): boolean {
  return block?.kind === 'text' && typeof block.text === 'string' && block.text.trim().length > 0
}

export function hasPlatedAssistantOutput(args: {
  blocks?: ReadonlyArray<{ kind?: unknown; text?: unknown }> | null
  extraText?: string | null
}): boolean {
  if (typeof args.extraText === 'string' && args.extraText.trim().length > 0) return true
  const blocks = args.blocks
  if (!blocks) return false
  return blocks.some(isPlatedAssistantBlock)
}

export function shouldAnnounceEmptyCompletedTurn(args: {
  status?: string | null
  errorCode?: string | null
  assistantText?: string | null
}): boolean {
  if (args.status !== 'completed') return false
  if (typeof args.errorCode === 'string' && SKIP_ERROR_CODES.has(args.errorCode)) return false
  return !String(args.assistantText ?? '').trim()
}

export function emptyCompletedTurnAssistantText(args: {
  status?: string | null
  errorCode?: string | null
  assistantText?: string | null
}): string {
  const text = String(args.assistantText ?? '')
  return shouldAnnounceEmptyCompletedTurn({ ...args, assistantText: text })
    ? EMPTY_COMPLETED_TURN_NOTICE
    : text
}
