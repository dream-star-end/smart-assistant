import {
  readClientTimelinePage,
  type ClientTimelineCursor,
} from '@openclaude/storage'
import { query } from '../db/queries.js'
import { SNAPSHOT_MAX_MESSAGES } from './snapshotSanitizer.js'

export class TutorialTimelineError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'SESSION_OPEN_TURN' | 'TOO_LARGE' | 'BAD_SESSION',
    message: string,
  ) {
    super(message)
    this.name = 'TutorialTimelineError'
  }
}

export const TUTORIAL_SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/
export const TUTORIAL_TIMELINE_PAGE_SIZE = 100
export const TUTORIAL_ACTIVE_AUTHOR_CAP = 20

export type TutorialTimelineMessage = Record<string, unknown>

export type TutorialTimelinePage = {
  messages: TutorialTimelineMessage[]
  nextCursor: unknown
  hasMore: boolean
}

export type TutorialTimelineReader = {
  readClientTimelinePage(
    sessionId: string,
    userId: string,
    cursor: unknown,
    limit: number,
  ): Promise<TutorialTimelinePage | null>
}

export type TutorialOpenTurnChecker = (
  sessionId: string,
  authorUserId: string,
) => Promise<boolean>

let readerOverride: TutorialTimelineReader | null = null
let openTurnCheckerOverride: TutorialOpenTurnChecker | null = null

export function setTutorialTimelineReaderForTest(reader: TutorialTimelineReader | null): void {
  readerOverride = reader
}

export function setTutorialOpenTurnCheckerForTest(
  checker: TutorialOpenTurnChecker | null,
): void {
  openTurnCheckerOverride = checker
}

const defaultReader: TutorialTimelineReader = {
  async readClientTimelinePage(sessionId, userId, cursor, limit) {
    const page = await readClientTimelinePage(
      sessionId,
      userId,
      (cursor ?? null) as ClientTimelineCursor | null,
      limit,
    )
    if (!page) return null
    return {
      messages: page.messages as TutorialTimelineMessage[],
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    }
  },
}

const defaultOpenTurnChecker: TutorialOpenTurnChecker = async (sessionId, authorUserId) => {
  const result = await query<{ open: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM turn_dispatches
        WHERE user_id = $1::bigint
          AND session_id = $2
          AND status IN ('admitted', 'accepted', 'rejecting')
     ) AS open`,
    [authorUserId, sessionId],
  )
  return result.rows[0]?.open === true
}

export function parseTutorialSessionId(value: unknown): string {
  if (typeof value !== 'string' || !TUTORIAL_SESSION_ID_RE.test(value)) {
    throw new TutorialTimelineError('BAD_SESSION', 'sourceSessionId 格式无效')
  }
  return value
}

export function messageHasOpenTurn(message: TutorialTimelineMessage): boolean {
  return (
    message._turnTapeProcess === true ||
    message._streaming === true ||
    message._streamingAssistant === true ||
    message._open === true
  )
}

export async function exportOwnedSessionTimeline(args: {
  sessionId: string
  authorUserId: string
  reader?: TutorialTimelineReader
  openTurnChecker?: TutorialOpenTurnChecker
}): Promise<TutorialTimelineMessage[]> {
  const reader = args.reader ?? readerOverride ?? defaultReader
  const openTurnChecker =
    args.openTurnChecker ?? openTurnCheckerOverride ?? defaultOpenTurnChecker
  if (!/^[1-9]\d*$/.test(args.authorUserId)) {
    throw new TutorialTimelineError('BAD_SESSION', 'author user id 格式无效')
  }
  if (await openTurnChecker(args.sessionId, args.authorUserId)) {
    throw new TutorialTimelineError('SESSION_OPEN_TURN', '会话仍有未结束的回合，无法发布快照')
  }
  // client_sessions.user_id 的生产租户键是 `c:<numeric uid>`，不是 JWT 的裸 uid。
  const sessionOwnerKey = `c:${args.authorUserId}`
  const pages: TutorialTimelineMessage[][] = []
  let cursor: unknown = null
  for (;;) {
    const page = await reader.readClientTimelinePage(
      args.sessionId,
      sessionOwnerKey,
      cursor,
      TUTORIAL_TIMELINE_PAGE_SIZE,
    )
    if (!page) throw new TutorialTimelineError('NOT_FOUND', '会话不存在或无权导出')
    if (page.messages.some(messageHasOpenTurn)) {
      throw new TutorialTimelineError('SESSION_OPEN_TURN', '会话仍有未结束的回合，无法发布快照')
    }
    pages.push(page.messages)
    if (!page.hasMore || page.nextCursor == null) break
    cursor = page.nextCursor
    if (pages.reduce((sum, chunk) => sum + chunk.length, 0) > 10_000) {
      throw new TutorialTimelineError('TOO_LARGE', '会话时间线过长，无法发布快照')
    }
  }
  return pages.reverse().flat()
}

function allowlistFromBrowserMessages(browserMessages: unknown): Set<string> | null {
  if (!Array.isArray(browserMessages)) return null
  const ids = new Set<string>()
  for (const row of browserMessages) {
    if (!row || typeof row !== 'object' || typeof (row as { id?: unknown }).id !== 'string') continue
    ids.add((row as { id: string }).id)
  }
  return ids
}

export function projectDurableMessagesForSnapshot(
  durable: TutorialTimelineMessage[],
  browserMessages?: unknown,
): Array<Record<string, unknown>> {
  const allow = allowlistFromBrowserMessages(browserMessages)
  const projected: Array<Record<string, unknown>> = []
  const richFieldsByRole: Record<string, readonly string[]> = {
    tool: [
      'toolName',
      'inputPreview',
      'inputJson',
      'output',
      'outputJson',
      'error',
      '_completed',
    ],
    plan: ['explanation', 'steps'],
    goal: ['goalStatus', 'tokenBudget', 'tokensUsed', 'timeUsedSeconds'],
    'agent-group': [
      'startTime',
      'childBlocks',
      '_duration',
      '_resultPreview',
      '_isError',
      '_delegateStatus',
    ],
  }
  for (const message of durable) {
    const id = typeof message.id === 'string' ? message.id : ''
    if (!id) continue
    if (allow && !allow.has(id)) continue
    const role = typeof message.role === 'string' ? message.role : ''
    const text =
      typeof message.text === 'string'
        ? message.text
        : typeof message.content === 'string'
          ? message.content
          : ''
    const ts = typeof message.ts === 'number' && Number.isFinite(message.ts) ? message.ts : 0
    const row: Record<string, unknown> = { id, role, text, ts }
    for (const key of richFieldsByRole[role] ?? []) {
      if (message[key] !== undefined) row[key] = message[key]
    }
    projected.push(row)
  }
  if (projected.length > SNAPSHOT_MAX_MESSAGES) {
    throw new TutorialTimelineError(
      'TOO_LARGE',
      `会话包含超过 ${SNAPSHOT_MAX_MESSAGES} 条可公开消息，无法生成完整快照`,
    )
  }
  return projected
}
