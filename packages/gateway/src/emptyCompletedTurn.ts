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

/**
 * 模型完全没产出（token 全是 0，也没有工具、正文或结构化块）时，
 * 这轮不能记成 completed。斜杠命令、已跳过的 API、以及已经是错误的结果除外。
 */
export function shouldFailClosedEmptyModelTurn(args: {
  status?: string | null
  errorCode?: string | null
  assistantText?: string | null
  outputTokens?: number | null
  inputTokens?: number | null
  cacheReadTokens?: number | null
  cacheCreationTokens?: number | null
  toolCallCount?: number | null
  blockCount?: number | null
  structuredBlockCount?: number | null
  apiState?: 'skipped' | 'called' | 'unknown' | null
  isSlashCommand?: boolean
  isError?: boolean
}): boolean {
  if (args.isSlashCommand) return false
  if (args.apiState === 'skipped') return false
  if (args.isError) return false
  if (args.status && args.status !== 'completed') return false
  if (args.errorCode) return false
  if ((args.toolCallCount ?? 0) > 0) return false
  if ((args.blockCount ?? 0) > 0) return false
  if ((args.structuredBlockCount ?? 0) > 0) return false
  if (String(args.assistantText ?? '').trim()) return false
  const tokens =
    (args.outputTokens ?? 0) +
    (args.inputTokens ?? 0) +
    (args.cacheReadTokens ?? 0) +
    (args.cacheCreationTokens ?? 0)
  return tokens === 0
}
