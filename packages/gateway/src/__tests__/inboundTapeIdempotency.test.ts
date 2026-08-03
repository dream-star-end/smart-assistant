import * as assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

process.env.OPENCLAUDE_HOME = mkdtempSync(join(tmpdir(), 'oc-inbound-tape-'))
const { Gateway } = await import('../server.js')

test('durable duplicate inbound skips a second model submission after memory dedup is lost', async () => {
  const gateway = Object.create(Gateway.prototype) as any
  let submitCount = 0
  const session = {
    agentId: 'codex',
    model: 'gpt-5.6-sol',
    _activeTurnId: 'internal-turn',
    runner: {},
  }
  gateway.rateLimiter = { check: () => true }
  gateway._seenIdempotencyKeys = new Map()
  gateway._sessionDeliveryChains = new Map()
  gateway._tapePoisoned = new Set()
  gateway.clientsByPeer = new Map()
  gateway.lastActiveChannel = new Map()
  gateway._redisSessionBus = { invalidateSessionList: () => {} }
  gateway._getAgentsConfig = async () => ({
    agents: [
      {
        id: 'codex',
        provider: 'codex-native',
        runnerKind: 'app-server',
        model: 'gpt-5.6-sol',
      },
    ],
  })
  gateway.deps = {
    config: {
      models: [{ id: 'gpt-5.6-sol' }],
      defaults: { model: 'gpt-5.6-sol' },
    },
  }
  gateway.sessions = {
    getByKey: () => session,
    getOrCreate: async () => session,
    submit: async (_session: unknown, _payload: unknown, onEvent: (event: unknown) => void) => {
      submitCount++
      onEvent({
        kind: 'final',
        meta: {
          cost: 0,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalCost: 0,
          turn: submitCount,
          isError: false,
          usageStatus: 'observed',
          costStatus: 'unavailable',
        },
      })
    },
  }
  gateway._runLog = { start: () => ({}), complete: () => {} }
  gateway._sendStampedSessionFrame = () => {}
  gateway.deliver = () => {}
  gateway.log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }

  const frame = {
    type: 'inbound.message',
    idempotencyKey: 'durable-turn-key',
    channel: 'webchat',
    peer: { id: 'web-idempotency', kind: 'dm' },
    agentId: 'codex',
    content: { text: 'run once' },
    clientMessage: {
      id: 'user-once',
      role: 'user',
      text: 'run once',
      ts: Date.now(),
      status: 'sent',
    },
    ts: Date.now(),
  }

  await gateway.dispatchInbound({ ...frame })
  assert.equal(submitCount, 1)

  // Simulate a process restart / expiry of the five-minute in-memory map.
  gateway._seenIdempotencyKeys.clear()
  await gateway.dispatchInbound({ ...frame })
  assert.equal(submitCount, 1)
})
