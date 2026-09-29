import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { assembleIdleArtifact } from '../../../../packages/gateway/src/boxIdleCompact.ts'
import {
  applyIdleTranscript,
  projectIdleArtifact,
  resumeIdleSummary,
  writeIdleNativeFile,
  type IdleNativeFile,
} from './idleRecover.ts'

const sessionId = 'ccb-session'
const opId = 'ab'.repeat(32)

function seed(home: string, file: IdleNativeFile): void {
  writeIdleNativeFile(join(home, 'idle-native', encodeURIComponent(sessionId), `${file.revision}.json`), file)
}

test('gateway and native projections are the same artifact', () => {
  const tail = [{ uuid: 'tail-1', parentUuid: null, text: 'kept tail' }]
  const attachments = [{ uuid: 'att-1', text: 'hook-once' }]
  const native = projectIdleArtifact({ opId, summaryText: 'kept goal', tail, attachments })
  const gateway = assembleIdleArtifact({ opId, summaryText: 'kept goal', tail, attachments })
  assert.equal(native.digest, gateway.digest)
  assert.deepEqual(native.messages, gateway.messages)
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
    { type: 'user', uuid: 'tail-1', message: { role: 'user', content: 'kept tail' } },
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
    frozenTail: [{ uuid: 'tail-1', parentUuid: null, text: 'kept tail' }] })
  const rebuilt = await resumeIdleSummary({
    sessionId, home, messages,
    summarize: async () => { calls += 1; return 'should-not-run' },
  })
  assert.equal(calls, 1)
  assert.equal(rebuilt?.file.summaryText, 'kept goal')
  assert.equal(rebuilt?.file.frozenTail[0]?.text, 'kept tail')
  const artifact = projectIdleArtifact({
    opId, summaryText: 'kept goal', tail: rebuilt!.file.frozenTail, attachments: [],
  })
  const stored: Array<{ uuid: string; text?: string }> = []
  await applyIdleTranscript({
    sessionId, artifact, messages: artifact.messages.map((item) => ({
      type: item.type, uuid: item.uuid,
      message: { role: 'user', content: typeof item.text === 'string' ? item.text : 'Conversation compacted' },
    })) as never,
    record: async (rows) => { stored.push(...rows as never) },
    flush: async () => {},
    load: async () => ({ messages: stored as never }),
  })
  await assert.rejects(applyIdleTranscript({
    sessionId, artifact, messages: [],
    record: async () => {}, flush: async () => {},
    load: async () => ({ messages: [] }),
  }), /IDLE_ARTIFACT_MISSING/)
  assert.equal(calls, 1)
})
