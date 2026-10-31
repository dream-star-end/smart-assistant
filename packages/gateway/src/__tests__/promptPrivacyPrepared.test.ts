import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import type { PromptPrivacyPolicy } from '@openclaude/protocol'
import { prepareRunnerPromptPrivacy } from '../promptPrivacyRuntime.js'

test('reinjection captures exactly the policy admitted to the runner without a second consent read', async () => {
  let reads = 0
  const off: PromptPrivacyPolicy = { schemaVersion: 1, profile: null }
  const server = createServer((_req, res) => {
    reads++
    res.end(JSON.stringify({ slots: [], promptPolicy: off }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const previousUrl = process.env.OPENCLAUDE_V3_MASTER_BASE_URL
  const previousToken = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'synthetic-fixture-only'
  let admitted: PromptPrivacyPolicy | undefined
  let captured: PromptPrivacyPolicy | undefined
  const runner = {
    setPromptPrivacy(policy: PromptPrivacyPolicy) { admitted = policy },
    async shutdown() {},
  }
  try {
    await prepareRunnerPromptPrivacy(runner, 's1', {
      assertCurrent() {},
      onPrepared(policy) {
        assert.equal(policy, admitted)
        captured = policy
      },
    })
    assert.equal(reads, 1)
    assert.equal(captured, admitted)
    assert.deepEqual(captured, off)
    let callbacks = 0
    await assert.rejects(prepareRunnerPromptPrivacy(runner, 's1', {
      assertCurrent() { throw new Error('stale-session') },
      onPrepared() { callbacks++ },
    }), /stale-session/)
    assert.equal(callbacks, 0)
    assert.equal(reads, 1)
  } finally {
    if (previousUrl === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_V3_MASTER_BASE_URL')
    else process.env.OPENCLAUDE_V3_MASTER_BASE_URL = previousUrl
    if (previousToken === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_V3_CONTAINER_TOKEN')
    else process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = previousToken
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
