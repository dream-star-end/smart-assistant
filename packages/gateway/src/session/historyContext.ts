/**
 * Pure historical context gap detection, replay prompt rendering,
 * native model handoff payload, and rolling checkpoint payload builders.
 */
import {
  modelHistoryRoleLabel,
  modelHistorySemanticRole,
  modelHistorySemanticText,
  projectModelHistoryForReplay,
  type ModelHistorySemanticRole,
} from '@openclaude/protocol'
import type { AgentSession } from '../sessionTypes.js'
import type { ChatHistoryMessage, TurnUserInput } from './types.js'

export function normForCompare(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

const SERVER_NOTICE_ASSISTANT_ID_PREFIXES = [
  'm-recovery-giveup-',
  'visible-fallback:',
  'tape-degraded:',
] as const

function isServerNoticeAssistantId(id: string): boolean {
  return SERVER_NOTICE_ASSISTANT_ID_PREFIXES.some((prefix) => id.startsWith(prefix))
}

/** Index of the latest assistant row an engine turn produced (server notices skipped). */
function latestEngineAssistantIndex(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const raw = messages[i]
    if (!raw || typeof raw !== 'object') continue
    const msg = raw as ChatHistoryMessage
    if (msg.system === true || msg.role !== 'assistant') continue
    const id = typeof msg.id === 'string' ? msg.id : ''
    if (id && isServerNoticeAssistantId(id)) continue
    return i
  }
  return -1
}

function latestAssistantMessageId(messages: unknown[]): string | null {
  const index = latestEngineAssistantIndex(messages)
  if (index < 0) return null
  const id = (messages[index] as { id?: unknown }).id
  return typeof id === 'string' && id ? id : null
}

function ownAgentAssistantPrefix(peerId: string, agentId: string): string {
  return `srv-${peerId}-${agentId}-t`
}

export function shouldTreatMasterHistoryAsProviderGap(opts: {
  messages: unknown[]
  peerId: string
  agentId: string
}): boolean {
  const latestAssistantId = latestAssistantMessageId(opts.messages)
  if (!latestAssistantId) return false
  return !latestAssistantId.startsWith(ownAgentAssistantPrefix(opts.peerId, opts.agentId))
}

/**
 * Master rows the native session of this agent has not seen: everything after
 * this agent's latest own engine answer.
 */
export function providerGapMessagesAfterOwnTurn(opts: {
  messages: unknown[]
  peerId: string
  agentId: string
}): unknown[] | null {
  const prefix = ownAgentAssistantPrefix(opts.peerId, opts.agentId)
  for (let i = opts.messages.length - 1; i >= 0; i--) {
    const raw = opts.messages[i]
    if (!raw || typeof raw !== 'object') continue
    const msg = raw as ChatHistoryMessage
    if (msg.system === true || msg.role !== 'assistant') continue
    if (typeof msg.id !== 'string' || !msg.id.startsWith(prefix)) continue
    const tail = opts.messages.slice(i + 1)
    return latestEngineAssistantIndex(tail) >= 0 ? tail : null
  }
  return null
}

export function historicalContextInjectionKey(opts: {
  messages: unknown[] | null | undefined
  peerId: string
  agentId: string
  hasProviderResumeId?: boolean
}): string | null {
  const messages = Array.isArray(opts.messages) ? opts.messages : []
  if (messages.length === 0) return opts.hasProviderResumeId ? null : 'local:no-provider-resume'
  const latestAssistantId = latestAssistantMessageId(messages)
  if (
    latestAssistantId &&
    shouldTreatMasterHistoryAsProviderGap({
      messages,
      peerId: opts.peerId,
      agentId: opts.agentId,
    })
  ) {
    return `master:${latestAssistantId}`
  }
  return opts.hasProviderResumeId ? null : `master:${latestAssistantId ?? 'no-assistant'}`
}

function isTrailingCurrentUserRow(raw: unknown, currentNorm: string): boolean {
  if (!raw || typeof raw !== 'object') return true
  const msg = raw as ChatHistoryMessage
  if (msg.system === true) return true
  const role = modelHistorySemanticRole(msg)
  if (!role) return true
  const text = modelHistorySemanticText(msg).trim()
  if (!text) return true
  const lastNorm = normForCompare(text)
  return (
    role === 'user' &&
    (msg.status === 'sending' ||
      msg.status === 'queued' ||
      Boolean(currentNorm && (lastNorm === currentNorm || currentNorm.startsWith(lastNorm))))
  )
}

function trimTrailingCurrentUserMessages(messages: unknown[], currentUserText: string): unknown[] {
  const currentNorm = normForCompare(currentUserText)
  let end = messages.length
  while (end > 0 && isTrailingCurrentUserRow(messages[end - 1], currentNorm)) {
    end -= 1
  }
  return messages.slice(0, end)
}

export type HistoricalJsonPromptRenderer = (
  messages: Array<{ role: string; text: string }>,
  currentUserText: string,
) => string

function fitRowsToPromptByteBudget(
  rows: Array<{ role: ModelHistorySemanticRole; text: string }>,
  maxPromptBytes: number,
  promptUserText: string,
  renderJsonPrompt: HistoricalJsonPromptRenderer,
): string | null {
  const render = (selectedRows: Array<{ role: ModelHistorySemanticRole; text: string }>): string =>
    renderJsonPrompt(
      selectedRows.map((message) => ({
        role: modelHistoryRoleLabel(message.role),
        text: message.text,
      })),
      promptUserText,
    )
  let selected: Array<{ role: ModelHistorySemanticRole; text: string }> = []
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const candidate = [rows[index]!, ...selected]
    if (Buffer.byteLength(render(candidate), 'utf8') > maxPromptBytes) break
    selected = candidate
  }
  return selected.length > 0 ? render(selected) : null
}

function truncateHistoryBody(body: string, maxHistoryChars: number | undefined): string {
  if (
    typeof maxHistoryChars !== 'number' ||
    !Number.isSafeInteger(maxHistoryChars) ||
    maxHistoryChars <= 0 ||
    body.length <= maxHistoryChars
  ) {
    return body
  }
  let start = body.length - maxHistoryChars
  const first = body.charCodeAt(start)
  if (first >= 0xdc00 && first <= 0xdfff && start > 0) start -= 1
  return `[Earlier history remains stored and can be retrieved when needed.]\n${body.slice(start)}`
}

export function buildHistoricalContextPromptWithRenderer(
  messages: unknown[],
  currentUserText: string,
  renderJsonPrompt: HistoricalJsonPromptRenderer,
  maxHistoryChars?: number,
  maxPromptBytes?: number,
  includeCurrentUserText = true,
): string | null {
  const promptUserText = includeCurrentUserText ? currentUserText : ''
  const trimmed = trimTrailingCurrentUserMessages(messages, currentUserText)
  const rows = projectModelHistoryForReplay(trimmed, { recentFullTurns: 2 }).map((item) => ({
    role: item.role,
    text: item.text,
  }))
  if (rows.length === 0) return null
  if (
    typeof maxPromptBytes === 'number' &&
    Number.isSafeInteger(maxPromptBytes) &&
    maxPromptBytes > 0
  ) {
    return fitRowsToPromptByteBudget(rows, maxPromptBytes, promptUserText, renderJsonPrompt)
  }
  const rawBody = rows
    .map((message) => `${modelHistoryRoleLabel(message.role)}: ${message.text}`)
    .join('\n\n')
  const body = truncateHistoryBody(rawBody, maxHistoryChars)
  return [
    '<openclaude_previous_context>',
    'The current OpenClaude session was previously served by a different runner/provider or cannot be natively resumed. Use this transcript as prior conversation context. Do not restate it unless needed.',
    body,
    '</openclaude_previous_context>',
    '',
    '<current_user_message>',
    promptUserText,
    '</current_user_message>',
  ].join('\n')
}

function buildNativeModelHandoffContext(summaryText: string, mediaPathHints = ''): string {
  const sections = [
    '<openclaude_native_model_handoff>',
    'The previous source model compacted this populated session for the selected target model. Treat the following native handoff as prior conversation context. Do not restate it unless needed.',
    summaryText,
  ]
  if (mediaPathHints.trim()) {
    sections.push('', mediaPathHints.trimEnd())
  }
  sections.push('</openclaude_native_model_handoff>')
  return sections.join('\n')
}

export function buildNativeModelHandoffPrompt(
  summaryText: string,
  currentUserText: string,
  mediaPathHints = '',
): string {
  return [
    buildNativeModelHandoffContext(summaryText, mediaPathHints),
    '',
    '<current_user_message>',
    currentUserText,
    '</current_user_message>',
  ].join('\n')
}

export function buildNativeModelHandoffPayload(
  summaryText: string,
  currentUserInput: TurnUserInput,
  mediaPathHints = '',
): TurnUserInput {
  if (typeof currentUserInput === 'string') {
    return buildNativeModelHandoffPrompt(summaryText, currentUserInput, mediaPathHints)
  }
  return [
    { type: 'text', text: buildNativeModelHandoffContext(summaryText, mediaPathHints) },
    ...currentUserInput,
  ]
}

/** OCV5-840: Wrap a Rolling Checkpoint Reset summary for one-shot next-turn injection. */
export function buildRollingCheckpointPayload(
  summaryText: string,
  currentUserInput: TurnUserInput,
): TurnUserInput {
  const ctx = [
    '<openclaude_rolling_checkpoint>',
    'Earlier session context was compacted into this bounded checkpoint summary. Use it as prior conversation context and continue from here without replaying earlier verbose outputs.',
    summaryText.trim(),
    '</openclaude_rolling_checkpoint>',
  ].join('\n')
  if (typeof currentUserInput === 'string') {
    return [ctx, '', '<current_user_message>', currentUserInput, '</current_user_message>'].join('\n')
  }
  return [{ type: 'text', text: ctx }, ...currentUserInput]
}

export function shouldAttemptHistoricalContextInjection(opts: {
  alreadyInjected?: boolean
  lastInjectedKey?: string | null
  injectionKey?: string | null
  channel?: string
  userTextOrBlocks: unknown
  hasProviderResumeId?: boolean
}): boolean {
  if (opts.channel !== 'webchat') return false
  if (typeof opts.userTextOrBlocks !== 'string' && !Array.isArray(opts.userTextOrBlocks)) return false
  if (opts.injectionKey) return opts.lastInjectedKey !== opts.injectionKey
  return !opts.alreadyInjected && !opts.hasProviderResumeId
}

export function shouldEmitContextRebuilt(opts: {
  historyMode: 'native-resume' | 'stateless-replay'
  reason?: AgentSession['_contextRebuildNotice']
  alreadyNotified?: boolean
}): boolean {
  if (opts.alreadyNotified) return false
  return opts.historyMode === 'native-resume' || opts.reason !== undefined
}
