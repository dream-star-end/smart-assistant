import { getAuthorityModelCapabilities } from './staticKeyModels.js'

export const BOX_NATIVE_CONTEXT_OWNER = 'box-native-v1'
export const BOX_NATIVE_CONTEXT_MODEL = 'box-api-claude-opus-5-5'

type ChainMessage = {
  type?: string
  role?: string
  isMeta?: boolean
  content?: unknown
  message?: { role?: string; content?: unknown }
}

function messageContent(message: ChainMessage): unknown {
  if (message.message && typeof message.message === 'object' && 'content' in message.message) {
    return message.message.content
  }
  return message.content
}

function messageRole(message: ChainMessage): 'assistant' | 'user' | 'other' {
  const role = message.type === 'assistant' || message.type === 'user'
    ? message.type
    : message.role === 'assistant' || message.role === 'user'
      ? message.role
      : message.message?.role === 'assistant' || message.message?.role === 'user'
        ? message.message.role
        : 'other'
  return role === 'assistant' || role === 'user' ? role : 'other'
}

function contentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return []
  return content.filter((block): block is Record<string, unknown> =>
    block !== null && typeof block === 'object' && !Array.isArray(block))
}

function isMetaUser(message: ChainMessage): boolean {
  return message.isMeta === true
}

/**
 * Latest assistant still owns its tool batch: it emitted tool_use, and no
 * later message is a new business user prompt. A meta continuation (the
 * resume path's own interrupted-turn prompt) is not a new business input.
 * An ordinary user after a completed tool pair stays fresh. Depth is not
 * consulted. Stdin cannot set isMeta; only the CLI resume lifecycle does.
 */
export function isLiveToolChainContinuation(messages: readonly unknown[] | undefined): boolean {
  if (!messages || messages.length === 0) return false
  let lastAssistant = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message && typeof message === 'object' && messageRole(message as ChainMessage) === 'assistant') {
      lastAssistant = index
      break
    }
  }
  if (lastAssistant < 0) return false
  const toolIds = contentBlocks(messageContent(messages[lastAssistant] as ChainMessage))
    .filter(block => block.type === 'tool_use' && typeof block.id === 'string')
    .map(block => block.id as string)
  if (toolIds.length === 0) return false
  for (let index = lastAssistant + 1; index < messages.length; index++) {
    const message = messages[index]
    if (!message || typeof message !== 'object') continue
    const chainMessage = message as ChainMessage
    const role = messageRole(chainMessage)
    if (role === 'assistant') return false
    if (role !== 'user') continue
    if (isMetaUser(chainMessage)) continue
    const blocks = contentBlocks(messageContent(chainMessage))
    const hasToolResult = blocks.some(block => block.type === 'tool_result')
    const content = messageContent(chainMessage)
    const hasText = typeof content === 'string'
      ? content.trim().length > 0
      : blocks.some(block => block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0)
    if (hasText && !hasToolResult) return false
  }
  return true
}

/**
 * The signed descriptor says the Box inner CLI owns model context for this
 * main-loop turn. Aux, idle/compact, and any other query source do not inherit.
 * A missing or non-matching descriptor keeps the caller's original policy.
 * Ownership applies only to the live tool continuation, not a fresh user turn.
 */
export function boxNativeRemoteContextOwnsHistory(input: {
  model: string | undefined
  querySource: string | undefined
  messages?: readonly unknown[]
}): boolean {
  const source = input.querySource ?? ''
  if (
    source === 'compact' ||
    source === 'session_memory' ||
    source.startsWith('agent:') ||
    source.includes('idle')
  ) {
    return false
  }
  if (source !== 'sdk' && !source.startsWith('repl_main_thread')) return false
  if (!input.model || input.model.trim().toLowerCase() !== BOX_NATIVE_CONTEXT_MODEL) {
    return false
  }
  const authority = getAuthorityModelCapabilities(input.model)
  if (!authority || authority.canonicalModel !== BOX_NATIVE_CONTEXT_MODEL) return false
  if (authority.contextOwner !== BOX_NATIVE_CONTEXT_OWNER) return false
  return isLiveToolChainContinuation(input.messages)
}
