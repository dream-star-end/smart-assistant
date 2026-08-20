import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import {
  TUTORIAL_ACTIVE_AUTHOR_CAP,
  exportOwnedSessionTimeline,
  parseTutorialSessionId,
  projectDurableMessagesForSnapshot,
  setTutorialOpenTurnCheckerForTest,
  setTutorialTimelineReaderForTest,
  TutorialTimelineError,
} from '../tutorials/tutorialTimeline.js'

afterEach(() => {
  setTutorialTimelineReaderForTest(null)
  setTutorialOpenTurnCheckerForTest(null)
})

test('sourceSessionId format is strict', () => {
  assert.equal(TUTORIAL_ACTIVE_AUTHOR_CAP, 20)
  assert.equal(parseTutorialSessionId('sess-ok-01'), 'sess-ok-01')
  assert.throws(() => parseTutorialSessionId('short'), (error: unknown) => {
    return error instanceof TutorialTimelineError && error.code === 'BAD_SESSION'
  })
  assert.throws(() => parseTutorialSessionId('bad id!!'), (error: unknown) => {
    return error instanceof TutorialTimelineError && error.code === 'BAD_SESSION'
  })
})

test('timeline export pages until hasMore=false and 404s other owners', async () => {
  setTutorialOpenTurnCheckerForTest(async () => false)
  setTutorialTimelineReaderForTest({
    async readClientTimelinePage(sessionId, userId, cursor) {
      if (sessionId !== 'sess-ok-01' || userId !== 'c:42') return null
      if (!cursor) {
        return {
          messages: [{ id: 'm2', role: 'assistant', text: '后页较新', ts: 2 }],
          nextCursor: { version: 1, timelineGeneration: 1, beforeOrderSeq: 2 },
          hasMore: true,
        }
      }
      return {
        messages: [{ id: 'm1', role: 'user', text: '先页较旧', ts: 1 }],
        nextCursor: null,
        hasMore: false,
      }
    },
  })
  const rows = await exportOwnedSessionTimeline({ sessionId: 'sess-ok-01', authorUserId: '42' })
  assert.deepEqual(
    rows.map((row) => row.id),
    ['m1', 'm2'],
  )
  await assert.rejects(
    () => exportOwnedSessionTimeline({ sessionId: 'sess-ok-01', authorUserId: '99' }),
    (error: unknown) => error instanceof TutorialTimelineError && error.code === 'NOT_FOUND',
  )
})

test('open turn sessions are refused; browser messages can only drop durable ids', async () => {
  setTutorialOpenTurnCheckerForTest(async () => false)
  setTutorialTimelineReaderForTest({
    async readClientTimelinePage() {
      return {
        messages: [
          { id: 'm1', role: 'user', text: '请分析', ts: 1 },
          { id: 'm2', role: 'assistant', text: '进行中', ts: 2, _turnTapeProcess: true },
        ],
        nextCursor: null,
        hasMore: false,
      }
    },
  })
  await assert.rejects(
    () => exportOwnedSessionTimeline({ sessionId: 'sess-open01', authorUserId: '1' }),
    (error: unknown) => error instanceof TutorialTimelineError && error.code === 'SESSION_OPEN_TURN',
  )

  const projected = projectDurableMessagesForSnapshot(
    [
      { id: 'keep', role: 'user', text: '权威正文', ts: 1 },
      { id: 'drop', role: 'assistant', text: '可忽略', ts: 2 },
    ],
    [
      { id: 'keep', role: 'user', text: '客户端伪造', ts: 9 },
      { id: 'ghost', role: 'user', text: '不存在', ts: 3 },
    ],
  )
  assert.deepEqual(projected, [{ id: 'keep', role: 'user', text: '权威正文', ts: 1 }])
})

test('numeric auth uid maps to c: tenant key and PG open dispatch blocks export first', async () => {
  const seen: string[] = []
  setTutorialOpenTurnCheckerForTest(async (sessionId, authorUserId) => {
    seen.push(`open:${sessionId}:${authorUserId}`)
    return true
  })
  setTutorialTimelineReaderForTest({
    async readClientTimelinePage(_sessionId, userId) {
      seen.push(`read:${userId}`)
      return { messages: [], nextCursor: null, hasMore: false }
    },
  })
  await assert.rejects(
    () => exportOwnedSessionTimeline({ sessionId: 'sess-open01', authorUserId: '3' }),
    (error: unknown) =>
      error instanceof TutorialTimelineError && error.code === 'SESSION_OPEN_TURN',
  )
  assert.deepEqual(seen, ['open:sess-open01:3'])
})
