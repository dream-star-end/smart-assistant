import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  persistSendToAgentIntent,
  recoverInterruptedSendToAgentIntents,
} from '../sendToAgentIntentStore.js'

test('leftover send_to_agent intents become one terminal notice and are removed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-sta-intents-'))
  const env = { OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR: dir } as NodeJS.ProcessEnv
  try {
    await persistSendToAgentIntent({
      v: 1,
      jobId: 'dlgjob-one',
      originSessionKey: 'agent:main:webchat:dm:sess-1',
      userId: '3',
      agentId: 'research-assistant',
      goal: 'research',
      createdAt: 1,
    }, env)
    const delivered: string[] = []
    const summary = await recoverInterruptedSendToAgentIntents(async (intent) => {
      delivered.push(intent.jobId)
      return true
    }, env)
    assert.deepEqual(summary, { recovered: 1, retained: 0, malformed: 0 })
    assert.deepEqual(delivered, ['dlgjob-one'])
    assert.deepEqual(await readdir(dir), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('failed terminal notice remains durable for the next boot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-sta-intents-'))
  const env = { OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR: dir } as NodeJS.ProcessEnv
  try {
    await persistSendToAgentIntent({
      v: 1,
      jobId: 'dlgjob-two',
      originSessionKey: 'agent:main:webchat:dm:sess-2',
      agentId: 'coding-assistant',
      goal: 'build',
      createdAt: 2,
    }, env)
    await writeFile(join(dir, 'dlgjob-bad.json'), '{broken')
    const summary = await recoverInterruptedSendToAgentIntents(async () => false, env)
    assert.deepEqual(summary, { recovered: 0, retained: 1, malformed: 1 })
    assert.deepEqual(await readdir(dir), ['dlgjob-two.json'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
