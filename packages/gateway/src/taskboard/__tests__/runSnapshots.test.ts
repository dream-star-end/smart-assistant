import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentSession } from '../../sessionManager.js'
import type { TicketRun } from '../domain.js'
import { projectTaskboardRunSnapshots, taskboardPreview } from '../runSnapshots.js'

const run = { id: 'run-a', ticketId: 'ticket-a', stageId: 'stage', agentId: 'main', sessionKey: 'exact-session-a', status: 'running' } as TicketRun
const live = (over: Partial<AgentSession> = {}) => ({ sessionKey: run.sessionKey, agentId: 'main', channel: 'taskboard', model: 'stale-session-hint', runner: { model: 'actual-live' }, ...over }) as AgentSession

test('actual models use one exact batch, preserve multiple historical models and prefer actual runner', async () => {
  const seen: readonly string[][] = []
  const snapshots = await projectTaskboardRunSnapshots([run, { ...run, id: 'run-b', sessionKey: 'exact-session-b', status: 'succeeded' }], () => live(), async (keys) => {
    ;(seen as string[][]).push([...keys])
    return { 'exact-session-a': ['actual-history', 'actual-live'], 'exact-session-b': ['historical-b'] }
  })
  assert.deepEqual(seen, [['exact-session-a', 'exact-session-b']])
  assert.deepEqual(snapshots['run-a']!.actualModels, ['actual-history', 'actual-live'])
  assert.deepEqual(snapshots['run-b']!.actualModels, ['historical-b'])
  assert.equal(snapshots['run-b']!.preview, undefined)
})

test('no guessed model and no live preview from another session/channel/agent', async () => {
  for (const foreign of [live({ sessionKey: 'other' }), live({ channel: 'delegate' }), live({ agentId: 'other' })]) {
    const out = await projectTaskboardRunSnapshots([run], () => foreign, async () => ({}))
    assert.deepEqual(out['run-a']!.actualModels, [])
    assert.equal(out['run-a']!.preview, undefined)
  }
  const out = await projectTaskboardRunSnapshots([run], () => undefined, async () => ({}))
  assert.deepEqual(out['run-a']!.actualModels, [])
  await assert.rejects(projectTaskboardRunSnapshots(Array.from({ length: 201 }, () => run), () => undefined), RangeError)
})

test('preview reads at most the last 80 blocks, remains below 4KiB and excludes tool arguments', () => {
  const transcript: unknown[] = [{ kind: 'text', text: 'OUTSIDE_FIXED_WINDOW' }]
  for (let i = 0; i < 90; i += 1) {
    transcript.push({ kind: 'text', text: `进度${i}：` + '长文本'.repeat(1000) })
    transcript.push({ kind: 'tool_use', toolName: `tool_${i}`, inputJson: { token: 'SECRET_ARGUMENT' }, inputPreview: 'SECRET_ARGUMENT', summary: 'SECRET_ARGUMENT' })
  }
  const preview = taskboardPreview(live({ _durableDelegateTranscript: transcript, _taskboardLastActivityAt: 1234 }))
  const wire = JSON.stringify(preview)
  assert.ok(Buffer.byteLength(wire, 'utf8') <= 4096)
  assert.doesNotMatch(wire, /SECRET_ARGUMENT|OUTSIDE_FIXED_WINDOW|\ufffd/)
  assert.match(preview.text, /进度89/)
  assert.equal(preview.lastActivityAt, 1234)
  assert.deepEqual(preview.toolNames, Array.from({ length: 8 }, (_, i) => `tool_${i + 82}`))
})


test('preview wire limit includes escaping, code and emoji', () => {
  for (const text of ['\n'.repeat(5000), String.raw`{"path":"C:\work\task"}`.repeat(1000), '🧑‍💻'.repeat(5000)]) {
    const preview = taskboardPreview(live({ _durableDelegateTranscript: [{ kind: 'text', text }] }))
    assert.ok(Buffer.byteLength(JSON.stringify(preview), 'utf8') <= 4096)
    assert.doesNotMatch(preview.text, /\ufffd/)
  }
})

test('live exact model and preview remain available during a usage database error', async () => {
  const result = await projectTaskboardRunSnapshots([run], () => live({ _durableDelegateTranscript: [{ kind: 'text', text: 'still running' }] }), async () => { throw new Error('usage temporarily unavailable') })
  assert.deepEqual(result['run-a']!.actualModels, ['actual-live'])
  assert.equal(result['run-a']!.preview?.text, 'still running')
})
