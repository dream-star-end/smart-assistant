import test from 'node:test'
import assert from 'node:assert/strict'
import { notifyBoxUserStop } from './boxUserStopClient.js'

const identity = { sessionId: 'ccb-native-session', turnKey: 'a'.repeat(64) }
const env = { ANTHROPIC_BASE_URL: 'http://172.31.0.1:18892',
  OPENCLAUDE_V3_MASTER_BASE_URL: 'http://172.31.0.1:18892',
  OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.1.synthetic' }

test('explicit Box Stop uses only pinned internal endpoint and turn identity', async () => {
  let calls = 0
  const result = await notifyBoxUserStop(identity, { env,
    fetchImpl: async (url, init) => {
      calls++
      assert.equal(String(url), 'http://172.31.0.1:18892/internal/box/stop')
      assert.equal(init?.method, 'POST')
      assert.equal(init?.redirect, 'error')
      assert.equal((init?.headers as Record<string, string>).authorization,
        'Bearer oc-v3.1.synthetic')
      assert.deepEqual(JSON.parse(String(init?.body)), {
        session_id: identity.sessionId, oc_turn_key: identity.turnKey,
      })
      return new Response(JSON.stringify({ status: 'stopped' }), { status: 200 })
    } })
  assert.equal(result, 'stopped')
  assert.equal(calls, 1)
})

test('untrusted route or missing turn identity cannot receive container token', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; throw new Error('must not send') }
  assert.equal(await notifyBoxUserStop(identity, { env: { ...env,
    ANTHROPIC_BASE_URL: 'https://outside.invalid' }, fetchImpl }), 'skipped')
  assert.equal(await notifyBoxUserStop({ ...identity, turnKey: 'bad' },
    { env, fetchImpl }), 'skipped')
  assert.equal(await notifyBoxUserStop(identity, { env: { ...env,
    OPENCLAUDE_V3_CONTAINER_TOKEN: '' }, fetchImpl }), 'skipped')
  assert.equal(calls, 0)
})
