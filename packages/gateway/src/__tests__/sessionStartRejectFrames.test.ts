/**
 * A turn whose session cannot be created must end with its own error card, not an unowned socket
 * error the browser drops (the chat then spun until its 4-minute timeout). Drives the real
 * dispatchInbound on `Object.create(Gateway.prototype)`, as hiddenDelegateLimit.test.ts does.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/sessionStartRejectFrames.test.ts
 */
import assert from 'node:assert/strict'
import { it } from 'node:test'

import { Gateway } from '../server.js'

const PEER = 'wsess-start-reject'
const KEY = `agent:main:webchat:dm:${PEER}`

function makeGateway(failure: Error): { gw: any; delivered: any[]; submitted: () => number } {
  const agent = { id: 'main', provider: 'anthropic', model: 'glm-5.2' }
  const delivered: any[] = []
  let submits = 0
  const gw = Object.create(Gateway.prototype) as any
  gw._shuttingDown = false
  gw.clientsByPeer = new Map()
  gw.lastActiveChannel = new Map()
  gw._seenIdempotencyKeys = new Map()
  gw.log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  gw.rateLimiter = { check: () => true }
  gw.router = { route: () => ({ sessionKey: KEY, agent }) }
  gw.deps = { config: { version: 1, provider: 'anthropic',
    gateway: { bind: '127.0.0.1', port: 18789, accessToken: 'test' },
    auth: { mode: 'subscription', claudeCodePath: '/tmp/ccb' },
    defaults: { model: 'glm-5.2', permissionMode: 'default' }, channels: { webchat: { enabled: true } } } }
  gw._getAgentsConfig = async () => ({ default: 'main', agents: [agent] })
  gw._isIdempotencyDuplicate = () => false
  gw._markIdempotencyKey = () => {}
  gw._runLog = { start: () => ({}), complete: () => {} }
  gw.sessions = {
    beginClientTurn: () => {},
    endClientTurn: () => {},
    getByKey: () => undefined,
    adoptPreStartStopOnAdmission: () => {},
    clearPreStartStop: () => {},
    getOrCreate: async () => { throw failure },
    submit: async () => { submits++ },
  }
  gw.deliver = (frame: unknown) => { delivered.push(frame) }
  return { gw, delivered, submitted: () => submits }
}

const frame = () => ({ type: 'inbound.message', channel: 'webchat', peer: { id: PEER, kind: 'dm' },
  clientMessageId: 'm-start-reject-1', idempotencyKey: 'web:m-start-reject-1:0',
  content: { text: '你好', media: [] }, _userId: '1' })

/** The chat socket's entry for a user's message. */
async function send(gw: any): Promise<void> {
  await gw._dispatchAdmittedClientTurn(frame())
}

it('a chat that needs a new session gets an error card and a final, and nothing runs', async () => {
  const { gw, delivered, submitted } = makeGateway(new Error('CC5_BACKEND_REQUIRES_NEW_SESSION'))
  await send(gw)
  assert.equal(submitted(), 0)
  assert.deepEqual(delivered.map((f) => f.type), ['outbound.error', 'outbound.message'])
  const [card, final] = delivered
  assert.equal(card.code, 'engine_error')
  assert.equal(card.sessionKey, KEY)
  assert.equal(card.peer.id, PEER)
  assert.match(card.message, /新开一个对话/)
  assert.equal(final.isFinal, true)
  assert.equal(final.blocks[0].text, '[error] CC5_BACKEND_REQUIRES_NEW_SESSION')
})

it('an unexpected failure shows only its public code, never internal detail', async () => {
  const { delivered, gw } = makeGateway(new Error('spawn /opt/openclaude/bin/codex EACCES at /home/box/x'))
  await send(gw)
  assert.equal(delivered[0].type, 'outbound.error')
  assert.match(delivered[0].message, /SESSION_START_FAILED/)
  assert.doesNotMatch(JSON.stringify(delivered), /\/opt\/openclaude|\/home\/box|EACCES/)
})

it('an internal caller (cron, delegate callback) still gets the throw it retries on, and no card', async () => {
  const { delivered, gw } = makeGateway(new Error('CC5_BACKEND_REQUIRES_NEW_SESSION'))
  await assert.rejects(gw.dispatchInbound(frame()), /CC5_BACKEND_REQUIRES_NEW_SESSION/)
  assert.deepEqual(delivered, [])
})
