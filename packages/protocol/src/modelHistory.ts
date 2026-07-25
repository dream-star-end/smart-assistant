/**
 * Model-context history helpers.
 *
 * These limits describe the physical execution window of the selected model;
 * they are not browser-history limits. The browser timeline remains exact and
 * independently pageable.
 */
import {
  formatMessageReplyPrompt,
  normalizeMessageReplyQuote,
} from './messageReply.js'

/** Codex app-server 0.144 reports this executable window for the deployed
 * native runner. A null catalog value means "runner-owned", not infinite. */
export const CODEX_NATIVE_HISTORY_CONTEXT_WINDOW_TOKENS = 258_400

export const MODEL_HISTORY_EXACT_SUFFIX_MARKER =
  '[Earlier bytes of this exact message exceed the current model context window; exact suffix follows.]\n'

/** Browser-visible semantic records that must survive a provider/runner
 * switch. Deliberately excludes private runtime envelopes and thinking: those
 * are useful UI/audit process, but are not authoritative facts the next model
 * needs in order to continue the task. */
export type ModelHistorySemanticRole =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'plan'
  | 'goal'
  | 'agent-group'
  | 'error'

const MODEL_HISTORY_SEMANTIC_ROLES = new Set<ModelHistorySemanticRole>([
  'user',
  'assistant',
  'tool',
  'plan',
  'goal',
  'agent-group',
  'error',
])

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

function textContent(message: UnknownRecord): string {
  if (typeof message.text === 'string') return message.text
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content
    .map((part) => {
      const record = asRecord(part)
      return record && typeof record.text === 'string' ? record.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

function serialized(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value) ?? ''
}

function appendSection(parts: string[], label: string, value: unknown): void {
  const body = serialized(value)
  if (!body.trim()) return
  const section = label ? `${label}: ${body}` : body
  if (!parts.includes(section)) parts.push(section)
}

function childBlockSemanticText(value: unknown): string {
  const block = asRecord(value)
  if (!block || typeof block.kind !== 'string' || block.kind === 'thinking') return ''
  const parts: string[] = []
  switch (block.kind) {
    case 'text':
      appendSection(parts, '', block.text)
      break
    case 'tool_use':
      appendSection(parts, 'Tool', block.toolName)
      appendSection(parts, 'Input', block.inputJson ?? block.inputPreview)
      break
    case 'tool_result':
      appendSection(
        parts,
        block.isError === true ? 'Tool error' : 'Tool result',
        block.output ?? block.outputJson ?? block.preview,
      )
      break
    case 'tool_output_tail':
      appendSection(parts, block.truncatedHead === true ? 'Exact tool output tail' : 'Tool output', block.tail)
      break
    case 'plan':
      appendSection(parts, 'Plan', block.text)
      appendSection(parts, 'Plan explanation', block.explanation)
      appendSection(parts, 'Plan steps', block.steps)
      break
    case 'goal':
      appendSection(parts, 'Goal', block.objective)
      appendSection(parts, 'Goal status', block.status)
      break
    case 'delegate_progress':
      appendSection(parts, 'Delegate', block.agentId)
      appendSection(parts, 'Delegate goal', block.goal)
      appendSection(parts, 'Delegate progress', block.text)
      appendSection(parts, '', childBlockSemanticText(block.block))
      break
    case 'error':
      appendSection(parts, 'Error', block.error)
      break
    default:
      break
  }
  return parts.join('\n')
}

/** Normalize a persisted browser-visible record into a model-continuity role. */
export function modelHistorySemanticRole(value: unknown): ModelHistorySemanticRole | null {
  const message = asRecord(value)
  const role = message?.role
  return typeof role === 'string' && MODEL_HISTORY_SEMANTIC_ROLES.has(role as ModelHistorySemanticRole)
    ? role as ModelHistorySemanticRole
    : null
}

/**
 * Serialize the complete semantic facts of one browser-visible record.
 *
 * This is intentionally not a UI projection or a summary. Tool input/output,
 * structured plans/goals and delegate child results are copied exactly into a
 * deterministic textual envelope so a CCB↔Codex switch does not make the new
 * runner redo completed work. The later model-window selector may retain an
 * explicitly labelled exact suffix solely when the physical provider context
 * cannot hold the whole transcript; browser history remains untouched.
 */
export function modelHistorySemanticText(value: unknown): string {
  const message = asRecord(value)
  const role = modelHistorySemanticRole(message)
  if (!message || !role || message.system === true) return ''
  const parts: string[] = []
  const body = textContent(message)
  switch (role) {
    case 'user':
      appendSection(
        parts,
        '',
        formatMessageReplyPrompt(
          typeof message._modelText === 'string' ? message._modelText : body,
          normalizeMessageReplyQuote(message._replyTo),
        ),
      )
      break
    case 'assistant':
      appendSection(parts, '', body)
      break
    case 'tool':
      appendSection(parts, 'Tool', message.toolName)
      appendSection(parts, 'Input', message.inputJson ?? message.toolInput ?? message.inputPreview)
      {
        const output = message.output ?? message.outputJson ?? message.bashTail
        // Materialized tool rows commonly carry the exact same bytes in both
        // `text` and `output`. Labels make the final sections unequal, so the
        // generic section de-duper cannot catch this. Compare the raw bodies
        // before labelling to avoid doubling giant Bash output in sidecars and
        // in the finite model window.
        if (body !== serialized(output)) appendSection(parts, 'Summary', body)
        appendSection(parts, 'Output', output)
      }
      appendSection(parts, 'Error', message.error)
      break
    case 'plan':
      appendSection(parts, 'Plan', body)
      appendSection(parts, 'Explanation', message.explanation)
      appendSection(parts, 'Steps', message.steps)
      break
    case 'goal':
      appendSection(parts, 'Goal', message.objective ?? body)
      appendSection(parts, 'Status', message.status ?? message.goalStatus)
      appendSection(parts, 'Token budget', message.tokenBudget)
      appendSection(parts, 'Tokens used', message.tokensUsed)
      break
    case 'agent-group':
      appendSection(parts, 'Delegation', body)
      appendSection(parts, 'Agent', message._delegateAgentId ?? message.agentId)
      appendSection(parts, 'Goal', message._delegateGoal)
      appendSection(parts, 'Status', message._delegateStatus ?? message.status)
      appendSection(parts, 'Result', message._resultPreview)
      if (Array.isArray(message.childBlocks)) {
        for (const child of message.childBlocks) {
          appendSection(parts, '', childBlockSemanticText(child))
        }
      }
      break
    case 'error':
      appendSection(parts, 'Error', body || message.error)
      appendSection(parts, 'Detail', message._errorDetail)
      break
  }
  return parts.join('\n')
}

export function modelHistoryRoleLabel(role: ModelHistorySemanticRole): string {
  switch (role) {
    case 'user': return 'User'
    case 'assistant': return 'Assistant'
    case 'tool': return 'Tool record'
    case 'plan': return 'Plan update'
    case 'goal': return 'Goal update'
    case 'agent-group': return 'Delegate record'
    case 'error': return 'Agent error'
  }
}

/** Approximate provider tokens without coupling the platform to one tokenizer.
 * ASCII prose is charged at four characters/token; every non-ASCII code point
 * is charged as one token so Chinese history is not overfilled. */
export function estimateModelHistoryTokens(text: string): number {
  let ascii = 0
  let nonAscii = 0
  for (const char of text) {
    if (char.codePointAt(0)! <= 0x7f) ascii += 1
    else nonAscii += 1
  }
  return Math.ceil(ascii / 4) + nonAscii
}

/** Resolve the executable context window used for model-history transport. */
export function resolveModelHistoryContextWindow(
  declaredContextWindow: number | null | undefined,
  engine?: string,
): number | null {
  if (
    typeof declaredContextWindow === 'number' &&
    Number.isSafeInteger(declaredContextWindow) &&
    declaredContextWindow > 0
  ) return declaredContextWindow
  return declaredContextWindow === null && engine === 'codex'
    ? CODEX_NATIVE_HISTORY_CONTEXT_WINDOW_TOKENS
    : null
}

/** Tokens available to prior conversation after bytes and runner-specific
 * headroom already known at this layer. The final proxy composition boundary
 * still enforces the signed request window. */
export function availableModelHistoryTokens(
  contextWindow: number,
  currentUserText: string,
  additionalReservedTokens = 256,
): number {
  return Math.max(
    0,
    contextWindow - estimateModelHistoryTokens(currentUserText) -
      Math.max(0, Math.floor(additionalReservedTokens)),
  )
}

/**
 * CCB reconstructs provider-switch history as a new user message. On that
 * first request there is no previous API usage row, so its proactive compact
 * check can only estimate the reconstructed message itself; the system/tool
 * envelope is added later. Keep the same 20k summary-output + 13k compact
 * buffer that the runners need, plus the existing 256-token transport
 * allowance. A rebuilt Codex thread also needs this headroom: otherwise its
 * first compact request can itself exceed the window.
 */
export function modelHistoryReservedTokens(engine?: string): number {
  return engine === 'ccb' || engine === 'codex' ? 33_256 : 256
}

/** Return a Unicode-safe exact suffix that fits the approximate token budget. */
export function exactModelHistoryTextSuffix(text: string, maxTokens: number): string {
  let quarterTokens = 0
  const maxQuarterTokens = Math.max(0, Math.floor(maxTokens)) * 4
  let start = text.length
  while (start > 0) {
    let charStart = start - 1
    const last = text.charCodeAt(charStart)
    if (last >= 0xdc00 && last <= 0xdfff && charStart > 0) {
      const first = text.charCodeAt(charStart - 1)
      if (first >= 0xd800 && first <= 0xdbff) charStart -= 1
    }
    const codePoint = text.codePointAt(charStart)!
    const units = codePoint <= 0x7f ? 1 : 4
    if (quarterTokens + units > maxQuarterTokens) break
    quarterTokens += units
    start = charStart
  }
  return text.slice(start)
}
