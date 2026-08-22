/**
 * CCB native compact is a slash command. print.ts / processUserInput only
 * treat `typeof input === "string"` prompts that start with `/` as slash
 * commands. OpenClaude previously wrapped every string in a text block, so
 * `/compact` became a normal user turn (Kimi wrote a visible summary) and
 * prepareModelSwitch fail-closed with NATIVE_COMPACTION_UNAVAILABLE.
 */
export const CCB_NATIVE_COMPACTION_PREFIX =
  'This session is being continued from a previous conversation'

export function flattenCcbUserText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const rec = block as { type?: unknown; text?: unknown }
    if (rec.type === 'text' && typeof rec.text === 'string') parts.push(rec.text)
  }
  if (parts.length === 0) return undefined
  return parts.join('\n')
}

export function extractCcbNativeCompactionSummary(msg: {
  isSynthetic?: unknown
  isReplay?: unknown
  compact_summary?: unknown
  message?: { content?: unknown }
  sawCompactBoundary?: boolean
}): string | undefined {
  if (msg.isReplay === true) return undefined
  const contentText = flattenCcbUserText(msg.message?.content)?.trim()
  const nativeCarrier = msg.isSynthetic === true || msg.sawCompactBoundary === true
  if (
    nativeCarrier &&
    contentText &&
    contentText.startsWith(CCB_NATIVE_COMPACTION_PREFIX)
  ) {
    return contentText
  }
  if (typeof msg.compact_summary !== 'string') return undefined
  const summary = msg.compact_summary.trim()
  if (!summary) return undefined
  if (!msg.sawCompactBoundary && !summary.startsWith(CCB_NATIVE_COMPACTION_PREFIX)) {
    return undefined
  }
  return summary.startsWith(CCB_NATIVE_COMPACTION_PREFIX)
    ? summary
    : `${CCB_NATIVE_COMPACTION_PREFIX}\n\n${summary}`
}

/**
 * Keep slash-command prompts as strings so CCB print/SDK executes `/compact`.
 * Multimodal / non-slash strings stay as Anthropic content blocks.
 */
export function ccbStdinUserContent(
  userTextOrBlocks: string | Array<{ type: string; [key: string]: unknown }>,
): string | Array<{ type: string; [key: string]: unknown }> {
  if (typeof userTextOrBlocks !== 'string') return userTextOrBlocks
  if (userTextOrBlocks.startsWith('/')) return userTextOrBlocks
  return [{ type: 'text', text: userTextOrBlocks }]
}

export function isCcbSlashCommandPrompt(payload: unknown): boolean {
  return typeof payload === 'string' && payload.startsWith('/')
}
