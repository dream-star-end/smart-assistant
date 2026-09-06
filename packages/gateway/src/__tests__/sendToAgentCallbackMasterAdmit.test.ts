/**
 * send_to_agent completion callback must be admitted by master when a master
 * is configured (billing parity with cron-origin-inject).
 *
 * Regression: 2026-09-05 selfhost — parent turns spawned by the callback ran
 * through the container-local dispatchInbound path with no requestId, so the
 * Cursor adapter never emitted billing; turn_dispatches / usage_records had no
 * row and the chat footer showed no credits for `dlgcb-*` turns.
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, describe, it } from 'node:test'

import { CRON_ORIGIN_INJECT_PATH } from '@openclaude/protocol'

import { Gateway } from '../server.js'

const PARENT_KEY = 'agent:main:webchat:dm:webtestparent0001'
const ENV_KEYS = ['OPENCLAUDE_V3_MASTER_BASE_URL', 'OPENCLAUDE_V3_CONTAINER_TOKEN'] as const
const savedEnv: Record<string, string | undefined> = {}

type Seen = { path: string; auth: string | undefined; body: any }

let server: Server
let seen: Seen[] = []
let nextStatus = 200

before(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      seen.push({ path: req.url ?? '', auth: req.headers.authorization, body: JSON.parse(raw) })
      res.statusCode = nextStatus
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: nextStatus === 200 }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = `http://127.0.0.1:${port}`
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'test-container-token'
})

after(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

function makeGateway(): any {
  const gw = Object.create(Gateway.prototype) as any
  gw._shuttingDown = false
  gw._runtimeRecycleDrainUntil = 0
  gw.log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  gw.sessions = { getByKey: () => undefined }
  // Any local-path entry is a regression: the master branch must return first.
  gw._acquireSyntheticTurnBarrier = async () => {
    throw new Error('local synthetic-turn path must not run when master is configured')
  }
  gw.trySendToAgentCallbackDispatch = async () => {
    throw new Error('local dispatchInbound path must not run when master is configured')
  }
  gw.dispatchInbound = async () => {
    throw new Error('dispatchInbound must not be called directly')
  }
  return gw
}

describe('injectSendToAgentCallback → master admission', () => {
  it('POSTs the callback turn to master cron-origin-inject and maps 200 → injected', async () => {
    seen = []
    nextStatus = 200
    const gw = makeGateway()
    const r = await gw.injectSendToAgentCallback({
      parentSessionKey: PARENT_KEY,
      jobId: 'dlgjob-abc-1',
      agentId: 'research-assistant',
      goal: '查一下',
      output: '结论正文',
      clientMessageId: 'dlgcb-dlgjob-abc-1-1',
      once: true,
    })
    assert.deepEqual(r, { kind: 'injected' })
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.path, CRON_ORIGIN_INJECT_PATH)
    assert.equal(seen[0]!.auth, 'Bearer test-container-token')
    assert.equal(seen[0]!.body.sessionId, 'webtestparent0001')
    assert.equal(seen[0]!.body.agentId, 'main')
    assert.equal(seen[0]!.body.clientMessageId, 'dlgcb-dlgjob-abc-1-1')
    assert.match(seen[0]!.body.text, /research-assistant/)
    assert.match(seen[0]!.body.text, /结论正文/)
    // Master body schema is .strict(): no extra keys allowed.
    assert.deepEqual(Object.keys(seen[0]!.body).sort(), ['agentId', 'clientMessageId', 'sessionId', 'text'])
  })

  it('maps 409 (another turn open) to ORIGIN_SESSION_BUSY so the notifier parks the job', async () => {
    seen = []
    nextStatus = 409
    const gw = makeGateway()
    const r = await gw.injectSendToAgentCallback({
      parentSessionKey: PARENT_KEY,
      jobId: 'dlgjob-busy',
      agentId: 'x',
      goal: 'g',
      output: 'o',
      once: true,
    })
    assert.deepEqual(r, { kind: 'retryable_failure', code: 'ORIGIN_SESSION_BUSY' })
  })

  it('maps 404 (session gone) to fallback', async () => {
    seen = []
    nextStatus = 404
    const gw = makeGateway()
    const r = await gw.injectSendToAgentCallback({
      parentSessionKey: PARENT_KEY,
      jobId: 'dlgjob-gone',
      agentId: 'x',
      goal: 'g',
      output: 'o',
      once: true,
    })
    assert.deepEqual(r, { kind: 'fallback' })
  })

  it('maps 5xx to a retryable failure carrying the HTTP code', async () => {
    seen = []
    nextStatus = 503
    const gw = makeGateway()
    const r = await gw.injectSendToAgentCallback({
      parentSessionKey: PARENT_KEY,
      jobId: 'dlgjob-503',
      agentId: 'x',
      goal: 'g',
      output: 'o',
      once: true,
    })
    assert.deepEqual(r, { kind: 'retryable_failure', code: 'HTTP_503' })
  })

  it('keeps the callback text under the master 32k body limit even with a huge goal', async () => {
    seen = []
    nextStatus = 200
    const gw = makeGateway()
    await gw.injectSendToAgentCallback({
      parentSessionKey: PARENT_KEY,
      jobId: 'dlgjob-big',
      agentId: 'x',
      goal: 'g'.repeat(100_000),
      output: 'o'.repeat(100_000),
      once: true,
    })
    assert.equal(seen.length, 1)
    assert.ok(seen[0]!.body.text.length <= 32_000, `text ${seen[0]!.body.text.length} > 32000`)
  })

  it('non-webchat parent is fallback without contacting master', async () => {
    seen = []
    const gw = makeGateway()
    const r = await gw.injectSendToAgentCallback({
      parentSessionKey: 'agent:main:delegate:main:1:nested',
      jobId: 'dlgjob-nested',
      agentId: 'x',
      goal: 'g',
      output: 'o',
      once: true,
    })
    assert.deepEqual(r, { kind: 'fallback' })
    assert.equal(seen.length, 0)
  })
})
