import { posix } from 'node:path'

/**
 * How many successful Edit/Write/MultiEdit calls on one file, in one user
 * turn, before a single drift reminder. Retune here. There is no env
 * override, so a shell variable cannot change production or tests.
 * One reminder per file per turn. No second reminder at 2x.
 */
export const EDIT_DRIFT_REMIND_THRESHOLD = 10

const EDIT_DRIFT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

type FileCount = {
  count: number
  reminded: boolean
}

type ScopeState = {
  turnId: string
  files: Map<string, FileCount>
}

const scopes = new Map<string, ScopeState>()

export function resetEditDriftStateForTests(): void {
  scopes.clear()
}

/** Main thread uses agent id "main". Subagents pass their own agent id. */
export function editDriftScopeId(
  sessionId: string,
  agentId: string | undefined,
): string {
  const agent = agentId && agentId.length > 0 ? agentId : 'main'
  return `${sessionId}\0${agent}`
}

type TurnMessage = {
  type?: string
  uuid?: string
  isMeta?: boolean
  message?: {
    content?: unknown
  }
}

function isToolResultOnly(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false
  return content.every(block => {
    return (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'tool_result'
    )
  })
}

/**
 * Uuid of the latest user message that is real input. Tool-result messages
 * and isMeta injections stay inside the same turn.
 */
export function editDriftTurnIdFromMessages(
  messages: readonly TurnMessage[],
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg || msg.type !== 'user' || msg.isMeta) continue
    if (isToolResultOnly(msg.message?.content)) continue
    if (typeof msg.uuid === 'string' && msg.uuid.length > 0) return msg.uuid
  }
  return 'no-user-turn'
}

function normalizeEditDriftPath(filePath: string): string {
  let normalized = posix.normalize(filePath.trim().replaceAll('\\', '/'))
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}

function rawFilePath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  for (const key of ['file_path', 'path']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return null
}

function formatEditDriftReminder(filePath: string, count: number): string {
  return `<system-reminder>你已经第 ${count} 次修改 ${filePath}。停下来对照用户最初的目标：这样改是否仍在朝目标前进？是否在某个细节上原地打转？如果仍在正轨，继续；如果已经偏离或卡住，先交付当前版本，并说明还没解决的问题。</system-reminder>`
}

function scopeBucket(scopeId: string, turnId: string): ScopeState {
  const current = scopes.get(scopeId)
  if (current && current.turnId === turnId) return current
  const fresh: ScopeState = { turnId, files: new Map() }
  scopes.set(scopeId, fresh)
  return fresh
}

/** Reminder text when this call crosses the threshold, otherwise null. */
function observeEditDrift(input: {
  toolName: string
  filePath: string
  scopeId: string
  turnId: string
}): string | null {
  if (!EDIT_DRIFT_TOOLS.has(input.toolName)) return null
  const filePath = input.filePath.trim()
  if (!filePath) return null
  const scope = scopeBucket(input.scopeId, input.turnId)
  const prev = scope.files.get(filePath) ?? { count: 0, reminded: false }
  const count = prev.count + 1
  const shouldRemind = count >= EDIT_DRIFT_REMIND_THRESHOLD && !prev.reminded
  scope.files.set(filePath, {
    count,
    reminded: prev.reminded || shouldRemind,
  })
  if (!shouldRemind) return null
  return formatEditDriftReminder(filePath, count)
}

function appendReminder(content: unknown, reminder: string): unknown {
  if (typeof content === 'string') {
    return content.length > 0 ? `${content}\n${reminder}` : reminder
  }
  if (!Array.isArray(content)) return reminder
  const next = content.slice()
  const last: unknown = next[next.length - 1]
  if (
    typeof last === 'object' &&
    last !== null &&
    (last as { type?: unknown }).type === 'text' &&
    typeof (last as { text?: unknown }).text === 'string'
  ) {
    const text = (last as { text: string }).text
    next[next.length - 1] = {
      ...(last as Record<string, unknown>),
      text: text.length > 0 ? `${text}\n${reminder}` : reminder,
    }
    return next
  }
  next.push({ type: 'text', text: reminder })
  return next
}

/**
 * Count a successful file edit and, on the threshold, append one reminder
 * to the tool result the model will see. Returns the reminder, or null.
 */
export function applyEditDriftToToolResultBlock(
  block: { content?: unknown },
  input: {
    toolName: string
    input: unknown
    scopeId: string
    turnId: string
    normalizePath?: (filePath: string) => string
  },
): string | null {
  if (!EDIT_DRIFT_TOOLS.has(input.toolName)) return null
  const raw = rawFilePath(input.input)
  if (!raw) return null
  let filePath = raw
  try {
    const normalize = input.normalizePath ?? normalizeEditDriftPath
    filePath = normalizeEditDriftPath(normalize(raw))
  } catch {
    filePath = normalizeEditDriftPath(raw)
  }
  const reminder = observeEditDrift({
    toolName: input.toolName,
    filePath,
    scopeId: input.scopeId,
    turnId: input.turnId,
  })
  if (!reminder) return null
  block.content = appendReminder(block.content, reminder)
  return reminder
}
