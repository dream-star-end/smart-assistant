/**
 * Cursor ask_user: persist the question on the session tape, wait up to
 * waitMs (0 when omitted, for legacy clients; explicit values clamped to
 * 55s, under the 60s MCP tools/call wall) for an in-turn answer, then
 * degrade to detached. After release, the user's choice arrives as a later
 * ordinary user message. Nothing holds a process open past waitMs.
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

export function buildDetachedAskUserAnsweredResult(args: {
  requestId: string
  answers?: Record<string, string>
  answerText?: string
}): {
  status: 'answered'
  requestId: string
  answers?: Record<string, string>
  message: string
} {
  const answerBlock = (args.answerText && args.answerText.trim().length > 0)
    ? args.answerText.trim()
    : ''
  return {
    status: 'answered',
    requestId: args.requestId,
    ...(args.answers ? { answers: args.answers } : {}),
    message: [
      'The user already answered these questions in this turn.',
      'Continue based on their answer below.',
      'Do not call ask_user again for the same questions.',
      'Do not wait for a new user message — the answer is this tool result.',
      answerBlock,
    ].filter((line) => line.length > 0).join('\n'),
  }
}

export function buildDetachedAskUserSkippedResult(requestId: string): {
  status: 'skipped'
  requestId: string
  message: string
} {
  return {
    status: 'skipped',
    requestId,
    message: [
      'The user skipped these questions.',
      'Continue this turn with the information you already have.',
      'Do not call ask_user again for the same questions.',
      'Do not wait for a new user message.',
    ].join(' '),
  }
}

export type DetachedAskUserPermissionCard = {
  requestId: string
  questions: Array<Record<string, unknown>>
  sessionKey: string
  expiresAt: number
  ts?: number
  channel?: string
  peer?: { id: string; kind: 'dm' | 'group' }
}

/** Wire payload for the container → master v1 sidecar POST (not a billed turn tape). */
export function buildDetachedAskUserSinkPayload(args: {
  requestId: string
  questions: Array<Record<string, unknown>>
  sessionKey: string
  agentId: string
  sessionId: string
  channel: string
  peer: { id: string; kind: 'dm' | 'group' }
  expiresAt: number
  ts?: number
  turnIndex?: number
}): {
  sessionId: string
  agentId: string
  turnIndex: number
  status: 'completed'
  text: ''
  createdAt: number
  permissionCards: DetachedAskUserPermissionCard[]
} {
  const ts = args.ts ?? Date.now()
  return {
    sessionId: args.sessionId,
    agentId: args.agentId,
    turnIndex: args.turnIndex ?? 0,
    status: 'completed',
    text: '',
    createdAt: ts,
    permissionCards: [
      {
        requestId: args.requestId,
        questions: args.questions,
        sessionKey: args.sessionKey,
        expiresAt: args.expiresAt,
        ts,
        channel: args.channel,
        peer: args.peer,
      },
    ],
  }
}

export type DetachedAskUserPermissionPatch = {
  requestId: string
  behavior: 'allow' | 'deny'
  settledReason: 'remote' | 'already_settled' | 'disconnect' | 'timeout' | 'crashed'
  answers?: Record<string, string>
}

export type DetachedAskUserAnswerMessage = {
  id: string
  text: string
  ts?: number
}

/** Wire payload to patch a card resolved (+ optional user-answer row) via the same v1 sidecar. */
export function buildDetachedAskUserResolvedSinkPayload(args: {
  requestId: string
  agentId: string
  sessionId: string
  sessionKey: string
  behavior: 'allow' | 'deny'
  settledReason: 'remote' | 'already_settled' | 'disconnect' | 'timeout' | 'crashed'
  answers?: Record<string, string>
  userAnswer?: DetachedAskUserAnswerMessage
  ts?: number
  turnIndex?: number
}): {
  sessionId: string
  agentId: string
  turnIndex: number
  status: 'completed'
  text: ''
  createdAt: number
  permissionPatches: DetachedAskUserPermissionPatch[]
  userAnswerMessages?: DetachedAskUserAnswerMessage[]
} {
  const ts = args.ts ?? Date.now()
  return {
    sessionId: args.sessionId,
    agentId: args.agentId,
    turnIndex: args.turnIndex ?? 0,
    status: 'completed',
    text: '',
    createdAt: ts,
    permissionPatches: [
      {
        requestId: args.requestId,
        behavior: args.behavior,
        settledReason: args.settledReason,
        ...(args.answers ? { answers: args.answers } : {}),
      },
    ],
    ...(args.userAnswer ? { userAnswerMessages: [args.userAnswer] } : {}),
  }
}

export function agentIdFromAskUserSessionKey(sessionKey: string): string {
  const agentId = sessionKey.split(':')[1]
  return agentId && agentId.length > 0 ? agentId : 'main'
}

export function buildDetachedAskUserAnswerMessageId(requestId: string): string {
  return `ask-ans-${requestId.replace(/[^A-Za-z0-9_-]/g, '').slice(-24)}`
}

export function findDetachedAskUserCardInMessages(
  messages: unknown,
  requestId: string,
): Record<string, unknown> | undefined {
  if (!Array.isArray(messages)) return undefined
  return messages.find((m: unknown) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return false
    const row = m as Record<string, unknown>
    if (row.role !== 'permission') return false
    return row.requestId === requestId || row.id === requestId
  }) as Record<string, unknown> | undefined
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
