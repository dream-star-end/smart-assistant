import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { assembleIdleArtifact } from '../../../../packages/gateway/src/boxIdleCompact.ts'
import {
  applyIdleTranscript,
  findIdleNativeFile,
  projectIdleArtifact,
  resumeIdleSummary,
  selectIdlePreserve,
  writeIdleNativeFile,
  type IdleNativeFile,
} from './idleRecover.ts'

const sessionId = 'ccb-session'
const opId = 'ab'.repeat(32)

function seed(home: string, file: IdleNativeFile): void {
  writeIdleNativeFile(join(home, 'idle-native', encodeURIComponent(sessionId), `${file.revision}.json`), file)
}

const image = {
  type: 'user' as const,
  uuid: 'img-1',
  parentUuid: 'tool-1',
  message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aaaa' } }] },
}
const tool = {
  type: 'assistant' as const,
  uuid: 'tool-1',
  parentUuid: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } }] },
}
const attachment = {
  type: 'attachment' as const,
  uuid: 'att-1',
  attachment: { type: 'file', filename: 'a.ts' },
}

test('preserved tail keeps role, image, tool use, and attachments', () => {
  const preserved = selectIdlePreserve([tool, image, attachment, {
    type: 'user', uuid: 'cmd', message: { role: 'user', content: '/compact preserve' },
  }] as never)
  assert.equal(preserved.tail.length, 2)
  assert.equal(preserved.tail[0]?.message.type, 'assistant')
  assert.deepEqual((preserved.tail[1]?.message as { message: unknown }).message, image.message)
  assert.equal(preserved.attachments.length, 1)
  assert.equal(preserved.attachments[0]?.message.type, 'attachment')
  const native = projectIdleArtifact({
    opId, summaryText: 'kept goal', tail: preserved.tail, attachments: preserved.attachments,
  })
  const gateway = assembleIdleArtifact({
    opId, summaryText: 'kept goal',
    tail: preserved.tail.map((item) => ({
      uuid: item.uuid, parentUuid: item.parentUuid, message: item.message as never,
    })),
    attachments: preserved.attachments.map((item) => ({ uuid: item.uuid, message: item.message as never })),
  })
  assert.equal(native.digest, gateway.digest)
  assert.equal(JSON.stringify(native.messages).includes('image/png'), true)
  assert.equal(JSON.stringify(native.messages).includes('"role":"assistant"'), true)
  assert.equal(JSON.stringify(gateway.messages).includes('"type":"user","text"'), false)
})

test('three crash cuts keep one summary and the same tail', async () => {
  const home = await mkdtemp(join(tmpdir(), 'idle-recover-'))
  after(async () => { await rm(home, { recursive: true, force: true }) })
  const base: IdleNativeFile = {
    v: 1, opId, revision: 'rev-1', sessionId, modelCalls: 0,
    frozenTail: [], attachments: [],
  }
  seed(home, base)
  const messages = [
    { type: 'user', uuid: 'tail-1', message: { role: 'user', content: 'kept tail'.padEnd(170_000 * 4, 'x') } },
    { type: 'user', uuid: 'cmd', message: { role: 'user', content: '/compact preserve' } },
  ] as never
  let calls = 0
  const first = resumeIdleSummary({
    sessionId, home, messages,
    summarize: async () => { calls += 1; throw new Error('killed after accept') },
  })
  await assert.rejects(first, /killed after accept/)
  assert.equal(calls, 1)
  await assert.rejects(resumeIdleSummary({
    sessionId, home, messages,
    summarize: async () => { calls += 1; return 'again' },
  }), /IDLE_HISTORY_PENDING/)
  assert.equal(calls, 1)
  seed(home, { ...base, modelStarted: true, summaryText: 'kept goal', modelCalls: 1,
    frozenTail: [{ uuid: 'tool-1', parentUuid: null, message: tool as never }],
    attachments: [{ uuid: 'att-1', message: attachment as never }] })
  const rebuilt = await resumeIdleSummary({
    sessionId, home, messages,
    summarize: async () => { calls += 1; return 'should-not-run' },
  })
  assert.equal(calls, 1)
  assert.equal(rebuilt?.file.summaryText, 'kept goal')
  assert.equal(rebuilt?.file.frozenTail[0]?.message.type, 'assistant')
  const artifact = projectIdleArtifact({
    opId, summaryText: 'kept goal', tail: rebuilt!.file.frozenTail, attachments: rebuilt!.file.attachments,
  })
  const stored: Array<Record<string, unknown>> = []
  await applyIdleTranscript({
    sessionId, artifact, messages: artifact.messages as never,
    record: async (rows) => { stored.push(...rows as never) },
    flush: async () => {},
    load: async () => ({ messages: stored as never }),
  })
  await assert.rejects(applyIdleTranscript({
    sessionId, artifact, messages: artifact.messages as never,
    record: async () => {}, flush: async () => {},
    load: async () => ({ messages: artifact.messages.map((item) => ({ ...item, message: { role: 'user', content: 'rewritten' } })) as never }),
  }), /IDLE_ARTIFACT_MISSING/)
  await assert.rejects(applyIdleTranscript({
    sessionId, artifact, messages: artifact.messages as never,
    record: async () => {}, flush: async () => {},
    load: async () => ({ messages: [] }),
  }), /IDLE_ARTIFACT_MISSING/)
  assert.equal(calls, 1)
})

test('a second idle in the same session is not hidden by the finished file', () => {
  const home = join(tmpdir(), `idle-twice-${process.pid}`)
  const first: IdleNativeFile = {
    v: 1, opId, revision: 'rev-1', sessionId, modelCalls: 1, summaryText: 'one',
    frozenTail: [], attachments: [],
  }
  const second: IdleNativeFile = { ...first, opId: 'cd'.repeat(32), revision: 'rev-2', summaryText: undefined }
  seed(home, { ...first, applied: true })
  seed(home, second)
  assert.equal(findIdleNativeFile(sessionId, home)?.endsWith('rev-2.json'), true)
  seed(home, { ...first, applied: false, revision: 'rev-3', opId: 'ee'.repeat(32) })
  assert.throws(() => findIdleNativeFile(sessionId, home), /IDLE_HISTORY_PENDING/)
})
