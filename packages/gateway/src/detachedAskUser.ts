/**
 * Detached Cursor ask_user: the MCP tool returns immediately, the question
 * lives on the session tape, and the user's choice arrives as a later
 * ordinary user message. Nothing holds a process open.
 */

export const DETACHED_ASK_USER_TTL_MS = 24 * 60 * 60_000
export const DETACHED_ASK_USER_REQUEST_PREFIX = 'ask-user:'

export type DetachedAskUserPending = {
  sessionKey: string
  toolName: string
  input: Record<string, unknown>
  peerKey: string
  userId: string
  channel: string
  peer: { id: string; kind: 'dm' | 'group' }
  expiresAt: number
  detachedAskUser: true
}

export function isDetachedAskUserRequestId(requestId: string): boolean {
  return requestId.startsWith(DETACHED_ASK_USER_REQUEST_PREFIX)
}

export function isDetachedAskUserPending(pending: { detachedAskUser?: boolean } | null | undefined): boolean {
  return pending?.detachedAskUser === true
}

export function formatAskUserAnswerMessage(
  input: Record<string, unknown>,
  answers: Record<string, string>,
): string {
  const questions = Array.isArray(input.questions) ? input.questions : []
  const lines = ['用户已回答提问：', '']
  for (const raw of questions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const question = (raw as { question?: unknown }).question
    if (typeof question !== 'string' || question.length === 0) continue
    const header = (raw as { header?: unknown }).header
    const chosen = typeof answers[question] === 'string' && answers[question].trim().length > 0
      ? answers[question]
      : '（未选择）'
    if (typeof header === 'string' && header.length > 0) {
      lines.push(`【${header}】${question}`)
    } else {
      lines.push(question)
    }
    lines.push(`选择：${chosen}`)
    lines.push('')
  }
  return lines.join('\n').trim()
}

export function buildDetachedAskUserPostedResult(requestId: string): {
  status: 'posted'
  requestId: string
  message: string
} {
  return {
    status: 'posted',
    requestId,
    message: [
      'Your questions have been shown to the user in the web UI.',
      'End your turn now. Do not wait, poll, or call ask_user again for the same questions.',
      "The user's answer will arrive as your next ordinary user message.",
    ].join(' '),
  }
}

export function buildDetachedAskUserPersistMessage(args: {
  requestId: string
  questions: Array<Record<string, unknown>>
  sessionKey: string
  userId: string
  channel: string
  peer: { id: string; kind: 'dm' | 'group' }
  expiresAt: number
  ts?: number
}): {
  id: string
  role: 'permission'
  text: string
  ts: number
  requestId: string
  toolName: string
  inputJson: { questions: Array<Record<string, unknown>> }
  inputPreview: string
  _resolved: false
  _detachedAskUser: true
  _askUserSessionKey: string
  _askUserExpiresAt: number
  _askUserUserId: string
  _askUserChannel: string
  _askUserPeer: { id: string; kind: 'dm' | 'group' }
  _source: 'server'
} {
  const input = { questions: args.questions }
  return {
    id: args.requestId,
    role: 'permission',
    text: 'AskUserQuestion',
    ts: args.ts ?? Date.now(),
    requestId: args.requestId,
    toolName: 'AskUserQuestion',
    inputJson: input,
    inputPreview: JSON.stringify(input).slice(0, 400),
    _resolved: false,
    _detachedAskUser: true,
    _askUserSessionKey: args.sessionKey,
    _askUserExpiresAt: args.expiresAt,
    _askUserUserId: args.userId,
    _askUserChannel: args.channel,
    _askUserPeer: args.peer,
    _source: 'server',
  }
}

export function pendingFromDetachedAskUserMessage(
  msg: Record<string, unknown>,
  fallbacks: {
    userId: string
    channel: string
    peer: { id: string; kind: 'dm' | 'group' }
    peerKey: string
  },
): DetachedAskUserPending | null {
  if (msg._detachedAskUser !== true && !isDetachedAskUserRequestId(String(msg.requestId ?? msg.id ?? ''))) {
    return null
  }
  if (msg._resolved === true) return null
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : typeof msg.id === 'string' ? msg.id : ''
  if (!isDetachedAskUserRequestId(requestId)) return null
  const expiresAt = typeof msg._askUserExpiresAt === 'number' ? msg._askUserExpiresAt : 0
  if (expiresAt > 0 && Date.now() >= expiresAt) return null
  const sessionKey = typeof msg._askUserSessionKey === 'string' ? msg._askUserSessionKey : ''
  if (!sessionKey) return null
  const inputJson = msg.inputJson
  const input =
    inputJson && typeof inputJson === 'object' && !Array.isArray(inputJson)
      ? (inputJson as Record<string, unknown>)
      : { questions: [] }
  const userId = typeof msg._askUserUserId === 'string' ? msg._askUserUserId : fallbacks.userId
  const channel = typeof msg._askUserChannel === 'string' ? msg._askUserChannel : fallbacks.channel
  const storedPeer = msg._askUserPeer
  const peer =
    storedPeer && typeof storedPeer === 'object' && !Array.isArray(storedPeer) &&
    typeof (storedPeer as { id?: unknown }).id === 'string'
      ? {
          id: (storedPeer as { id: string }).id,
          kind: (storedPeer as { kind?: unknown }).kind === 'group' ? ('group' as const) : ('dm' as const),
        }
      : fallbacks.peer
  return {
    sessionKey,
    toolName: typeof msg.toolName === 'string' ? msg.toolName : 'AskUserQuestion',
    input,
    peerKey: fallbacks.peerKey,
    userId,
    channel,
    peer,
    expiresAt: expiresAt > 0 ? expiresAt : Date.now() + DETACHED_ASK_USER_TTL_MS,
    detachedAskUser: true,
  }
}
