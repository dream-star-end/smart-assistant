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

test('durable tool, plan, goal and agent-group public structures are projected intact', () => {
  const projected = projectDurableMessagesForSnapshot([
    {
      id: 'tool', role: 'tool', text: 'Bash', ts: 1, toolName: 'Bash',
      inputJson: { command: 'pwd' }, output: 'ok', _completed: true,
      _turnKey: 'private',
    },
    {
      id: 'plan', role: 'plan', text: '计划', ts: 2,
      steps: [{ step: '运行测试', status: 'completed' }], explanation: '按顺序执行',
    },
    {
      id: 'goal', role: 'goal', text: '交付', ts: 3,
      goalStatus: 'complete', tokenBudget: 1000,
    },
    {
      id: 'group', role: 'agent-group', text: '队员完成', ts: 4,
      childBlocks: [{ kind: 'text', text: '结果' }], _delegateStatus: 'ok',
    },
  ])
  assert.equal(projected[0]?.toolName, 'Bash')
  assert.deepEqual(projected[1]?.steps, [{ step: '运行测试', status: 'completed' }])
  assert.equal(projected[2]?.goalStatus, 'complete')
  assert.deepEqual(projected[3]?.childBlocks, [{ kind: 'text', text: '结果' }])
  assert.equal(projected[0]?._turnKey, undefined)
})
