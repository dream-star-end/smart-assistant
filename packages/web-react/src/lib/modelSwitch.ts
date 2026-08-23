import type { PublicModel } from './types'

export type ModelSwitchCompactionReason = {
  visionDowngrade: boolean
  contextDowngrade: boolean
}

/** Minimal message shape the switch dialog inspects. */
export type ModelSwitchMessage = {
  role?: string
  text?: string
  _modelText?: string
  output?: string | null
  preview?: string
  _media?: ReadonlyArray<{ kind?: string; mimeType?: string }>
  _retryMedia?: ReadonlyArray<{ kind?: string; mimeType?: string }>
  _imageEdit?: unknown
  _genPlaceholder?: unknown
}

export type ModelSwitchSessionSnapshot = {
  hasContent: boolean
  hasVisual: boolean
  estimatedTokens: number
}

const SKIP_ROLES = new Set(['thinking', 'runtime-event'])
const CHARS_PER_TOKEN = 4
const VISUAL_TOKEN_ESTIMATE = 1024

function isVisualMedia(media: { kind?: string; mimeType?: string } | undefined): boolean {
  if (!media) return false
  if (media.kind === 'image' || media.kind === 'video') return true
  const mime = media.mimeType ?? ''
  return mime.startsWith('image/') || mime.startsWith('video/')
}

function messageHasVisual(message: ModelSwitchMessage): boolean {
  if (message._imageEdit || message._genPlaceholder) return true
  for (const media of message._media ?? []) {
    if (isVisualMedia(media)) return true
  }
  for (const media of message._retryMedia ?? []) {
    if (isVisualMedia(media)) return true
  }
  return false
}

function messageTextChars(message: ModelSwitchMessage): number {
  let chars = 0
  if (typeof message._modelText === 'string' && message._modelText) chars += message._modelText.length
  else if (typeof message.text === 'string') chars += message.text.length
  if (typeof message.output === 'string') chars += message.output.length
  if (typeof message.preview === 'string') chars += message.preview.length
  return chars
}

export function inspectModelSwitchSession(
  messages: readonly ModelSwitchMessage[],
  messageCount = 0,
): ModelSwitchSessionSnapshot {
  const hasContent = messageCount > 0 || messages.some((message) =>
    message.role === 'user' ||
    message.role === 'assistant' ||
    message.role === 'tool' ||
    message.role === 'agent-group')
  let chars = 0
  let visualCount = 0
  let hasVisual = false
  for (const message of messages) {
    if (message.role && SKIP_ROLES.has(message.role)) continue
    if (messageHasVisual(message)) {
      hasVisual = true
      visualCount += 1
    }
    chars += messageTextChars(message)
  }
  return {
    hasContent,
    hasVisual,
    estimatedTokens: Math.ceil(chars / CHARS_PER_TOKEN) + visualCount * VISUAL_TOKEN_ESTIMATE,
  }
}

export function modelSwitchCompactionReason(
  models: readonly PublicModel[],
  sourceModelId: string | undefined,
  targetModelId: string,
  session: ModelSwitchSessionSnapshot,
): ModelSwitchCompactionReason | null {
  if (!session.hasContent || !sourceModelId || sourceModelId === targetModelId) return null
  const source = models.find((model) => model.id === sourceModelId)
  const target = models.find((model) => model.id === targetModelId)
  if (!source || !target) return null
  const visionDowngrade = session.hasVisual && target.supports_vision === false
  const targetWindow = typeof target.context_window === 'number' ? target.context_window : null
  const contextDowngrade =
    targetWindow !== null && session.estimatedTokens > targetWindow
  return visionDowngrade || contextDowngrade ? { visionDowngrade, contextDowngrade } : null
}
