import { buildHistoricalContextPrompt } from './sessionManager.js'

export type HistoricalTurnInput = string | Array<{ type: string; [key: string]: unknown }>

/** Preserve multimodal blocks exactly. History is semantic text, never another engine's tool protocol. */
export function buildHistoricalContextPayload(
  messages: unknown[],
  input: HistoricalTurnInput,
  maxPromptBytes?: number,
): HistoricalTurnInput | null {
  if (typeof input === 'string') {
    return buildHistoricalContextPrompt(messages, input, undefined, maxPromptBytes)
  }
  const currentText = input.filter((block) => block.type === 'text')
    .map((block) => typeof block.text === 'string' ? block.text : '').join('\n')
  // The original input remains present. Reserve its bytes before selecting a history suffix;
  // this also prevents a history block from pushing attachments past a transport's limit.
  const remaining = maxPromptBytes === undefined ? undefined
    : maxPromptBytes - Buffer.byteLength(JSON.stringify(input), 'utf8') - 32
  if (remaining !== undefined && remaining <= 0) return null
  const history = buildHistoricalContextPrompt(messages, currentText, undefined, remaining, false)
  return history ? [{ type: 'text', text: history }, ...input] : null
}
