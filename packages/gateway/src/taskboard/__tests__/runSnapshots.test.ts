import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentSession } from '../../sessionManager.js'
import type { TicketRun } from '../domain.js'
import { projectTaskboardRunSnapshots, taskboardPreview } from '../runSnapshots.js'

const run = {
  id: 'run-a',
  ticketId: 'ticket-a',
  stageId: 'stage',
  agentId: 'main',
  sessionKey: 'exact-session-a',
  status: 'running',
} as TicketRun
const live = (over: Partial<AgentSession> = {}) =>
  ({
    sessionKey: run.sessionKey,
    agentId: 'main',
    channel: 'taskboard',
    model: 'stale-session-hint',
    runner: { model: 'actual-live' },
    ...over,
  }) as AgentSession

test('actual models use one exact batch, preserve multiple historical models and prefer actual runner', async () => {
  const seen: readonly string[][] = []
  const snapshots = await projectTaskboardRunSnapshots(
    [run, { ...run, id: 'run-b', sessionKey: 'exact-session-b', status: 'succeeded' }],
    () => live(),
    async (keys) => {
      ;(seen as string[][]).push([...keys])
      return {
        'exact-session-a': ['actual-history', 'actual-live'],
        'exact-session-b': ['historical-b'],
      }
    },
  )
  assert.deepEqual(seen, [['exact-session-a', 'exact-session-b']])
  assert.deepEqual(snapshots['run-a']!.actualModels, ['actual-history', 'actual-live'])
  assert.deepEqual(snapshots['run-b']!.actualModels, ['historical-b'])
  assert.equal(snapshots['run-b']!.preview, undefined)
})

test('no guessed model and no live preview from another session/channel/agent', async () => {
  for (const foreign of [
    live({ sessionKey: 'other' }),
    live({ channel: 'delegate' }),
    live({ agentId: 'other' }),
  ]) {
    const out = await projectTaskboardRunSnapshots(
      [run],
      () => foreign,
      async () => ({}),
    )
    assert.deepEqual(out['run-a']!.actualModels, [])
    assert.equal(out['run-a']!.preview, undefined)
  }
  const out = await projectTaskboardRunSnapshots(
    [run],
    () => undefined,
    async () => ({}),
  )
  assert.deepEqual(out['run-a']!.actualModels, [])
  await assert.rejects(
    projectTaskboardRunSnapshots(
      Array.from({ length: 201 }, () => run),
      () => undefined,
    ),
    RangeError,
  )
})

test('preview reads at most the last 80 blocks, remains below 4KiB and excludes tool arguments', () => {
  const transcript: unknown[] = [{ kind: 'text', text: 'OUTSIDE_FIXED_WINDOW' }]
  for (let i = 0; i < 90; i += 1) {
    transcript.push({ kind: 'text', text: `进度${i}：${'长文本'.repeat(1000)}` })
    transcript.push({
      kind: 'tool_use',
      toolName: `tool_${i}`,
      inputJson: { token: 'SECRET_ARGUMENT' },
      inputPreview: 'SECRET_ARGUMENT',
      summary: 'SECRET_ARGUMENT',
    })
  }
  const preview = taskboardPreview(
    live({ _durableDelegateTranscript: transcript, _taskboardLastActivityAt: 1234 }),
  )
  const wire = JSON.stringify(preview)
  assert.ok(Buffer.byteLength(wire, 'utf8') <= 4096)
  assert.doesNotMatch(wire, /SECRET_ARGUMENT|OUTSIDE_FIXED_WINDOW|\ufffd/)
  assert.match(preview.text, /进度89/)
  assert.equal(preview.lastActivityAt, 1234)
  assert.deepEqual(
    preview.toolNames,
    Array.from({ length: 8 }, (_, i) => `tool_${i + 82}`),
  )
})

test('preview wire limit includes escaping, code and emoji', () => {
  for (const text of [
    '\n'.repeat(5000),
    String.raw`{"path":"C:\work\task"}`.repeat(1000),
    '🧑‍💻'.repeat(5000),
  ]) {
    const preview = taskboardPreview(live({ _durableDelegateTranscript: [{ kind: 'text', text }] }))
    assert.ok(Buffer.byteLength(JSON.stringify(preview), 'utf8') <= 4096)
    assert.doesNotMatch(preview.text, /\ufffd/)
  }
})

test('live exact model and preview remain available during a usage database error', async () => {
  const result = await projectTaskboardRunSnapshots(
    [run],
    () => live({ _durableDelegateTranscript: [{ kind: 'text', text: 'still running' }] }),
    async () => {
      throw new Error('usage temporarily unavailable')
    },
  )
  assert.deepEqual(result['run-a']!.actualModels, ['actual-live'])
  assert.equal(result['run-a']!.preview?.text, 'still running')
})

test('a large latest update retains its progress heading inside the wire budget', () => {
  for (const tail of [
    '长进展'.repeat(5000),
    '\n'.repeat(5000),
    String.raw`{"step":"C:\work"}`.repeat(1000),
    'A🧑‍💻👨‍👩‍👧‍👦b'.repeat(1000),
  ]) {
    const preview = taskboardPreview(
      live({ _durableDelegateTranscript: [{ kind: 'text', text: `最新进度：${tail}` }] }),
    )
    assert.ok(preview.text.startsWith('最新进度：'))
    assert.ok(Buffer.byteLength(JSON.stringify(preview), 'utf8') <= 4096)
    assert.doesNotMatch(preview.text, /\ufffd/)
  }
})

test('a verified identity alias preserves exact root ownership and live feedback without rebinding', async () => {
  const legacy = { ...run, agentId: 'legacy-helper' }
  const profile = {
    profileId: 'fixture',
    legacyAgentId: 'legacy-helper',
    canonicalAgentId: 'canonical-helper',
    localPersonaPath: 'agents/fixture/persona.md',
    localSkillStorageId: 'fixture',
  }
  const assets = (value = profile) =>
    ({ profile: value }) as NonNullable<NonNullable<AgentSession['_identityCompat']>['assets']>
  const root = live({
    agentId: 'canonical-helper',
    _identityCompat: { assets: assets() },
    _durableDelegateTranscript: [{ kind: 'text', text: '兼容助手实际进度' }],
  })
  const accepted = await projectTaskboardRunSnapshots(
    [legacy],
    () => root,
    async () => ({}),
  )
  assert.deepEqual(accepted[run.id]!.actualModels, ['actual-live'])
  assert.equal(accepted[run.id]!.preview?.text, '兼容助手实际进度')
  assert.equal(legacy.agentId, 'legacy-helper')
  assert.equal(legacy.sessionKey, run.sessionKey)
  for (const foreign of [
    { ...root, _identityCompat: undefined },
    { ...root, _identityCompat: { assets: assets({ ...profile, legacyAgentId: 'other' }) } },
    { ...root, _identityCompat: { assets: assets({ ...profile, canonicalAgentId: 'other' }) } },
    { ...root, sessionKey: 'other' },
    { ...root, channel: 'delegate' },
  ]) {
    const rejected = await projectTaskboardRunSnapshots(
      [legacy],
      () => foreign as AgentSession,
      async () => ({}),
    )
    assert.deepEqual(rejected[run.id]!.actualModels, [])
    assert.equal(rejected[run.id]!.preview, undefined)
  }
})

test('a coalesced stream preserves both its heading and newly arriving tail', () => {
  for (const suffix of ['第一批最新尾部', '第二批最新尾部']) {
    const text = `执行进度：${'🧑‍💻长文本\n"'.repeat(5000)}${suffix}`
    const preview = taskboardPreview(live({ _durableDelegateTranscript: [{ kind: 'text', text }] }))
    assert.ok(preview.text.startsWith('执行进度：'))
    assert.ok(preview.text.endsWith(suffix))
    assert.ok(Buffer.byteLength(JSON.stringify(preview), 'utf8') <= 4096)
    assert.doesNotMatch(preview.text, /\ufffd/)
  }
})
