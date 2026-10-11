/**
 * OCV5-377 (commercial uid 4, 10-11): the Box model answered an idle summary
 * turn with a tool call. After the CCB runner was killed, that Box CLI stayed
 * parked on the handoff; the open run kept the source proof pending
 * (other_chain) and the summary proof pending (unsettled), so every next
 * message of the session was refused with IDLE_HISTORY_PENDING until an
 * operator reset. Once the runner is proven dead, the gateway now asks egress
 * to stop that idle turn's run; its proof reads failed and the op settles.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { BOX_NATIVE_CONTEXT_MODEL, BOX_NATIVE_CONTEXT_OWNER } from '@openclaude/protocol'
import { readIdleCandidate, readIdleOp, readPendingIdle, writeIdleCandidate, writeIdleOp,
  type IdleOp } from '../boxIdleCompact.js'
import { SessionManager } from '../sessionManager.js'

const finish = (SessionManager.prototype as unknown as {
  finishIdleUnderLock: (this: object, session: object, source: { sessionId: string; turnKey: string },
    recoveryDir?: string) => Promise<void>
}).finishIdleUnderLock

const revision = 'ab'.repeat(32)
const sourceTurn = 'cd'.repeat(32)
const sessionId = 'native-377'

/** Egress: the idle turn's run is parked until /internal/box/stop names it. */
async function egress(idleTurn: () => string) {
  const calls: Array<{ path: string; turnKey: string }> = []
  let stopped = false
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { oc_turn_key: string; session_id: string }
      const path = (req.url ?? '').split('?')[0]!
      calls.push({ path, turnKey: body.oc_turn_key })
      let reply: { code?: number; body: unknown }
      if (path === '/internal/box/stop') {
        if (body.oc_turn_key === idleTurn() && body.session_id === sessionId) stopped = true
        reply = stopped ? { body: { status: 'stopped' } } : { code: 409, body: { error: 'BOX_CANCEL_RUN_UNKNOWN' } }
      } else if (body.oc_turn_key === sourceTurn) {
        reply = stopped
          ? { body: { status: 'terminal', sessionId, turnKey: sourceTurn, requestId: 'r', revision,
            compactRequired: true, capsuleSha256: 'ee'.repeat(32) } }
          : { body: { status: 'pending', reason: 'other_chain' } }
      } else if (body.oc_turn_key === idleTurn()) {
        reply = stopped
          ? { body: { status: 'failed', sessionId, turnKey: idleTurn(), requestIds: ['idle-handoff'] } }
          : { body: { status: 'pending', reason: 'unsettled' } }
      } else reply = { code: 404, body: { error: 'NOT_FOUND' } }
      res.statusCode = reply.code ?? 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(reply.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  const keys = ['ANTHROPIC_BASE_URL', 'OPENCLAUDE_V3_MASTER_BASE_URL', 'OPENCLAUDE_V3_CONTAINER_TOKEN',
    'OC_BOX_IDLE_PROOF_WAIT_MS'] as const
  const before = keys.map((key) => process.env[key])
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${address.port}/`
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = process.env.ANTHROPIC_BASE_URL
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'oc-v3.test-token'
  process.env.OC_BOX_IDLE_PROOF_WAIT_MS = '0'
  return {
    calls,
    stops: () => calls.filter((call) => call.path === '/internal/box/stop'),
    async close() {
      keys.forEach((key, i) => { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i] })
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function fakeSession(sessionKey: string, counters: { submits: number; shutdowns: number },
  shutdown: () => Promise<void> = async () => {}) {
  return {
    sessionKey, model: BOX_NATIVE_CONTEXT_MODEL, _boxContextOwner: BOX_NATIVE_CONTEXT_OWNER,
    runner: Object.assign(new EventEmitter(), {
      submitTurn: () => {
        counters.submits++
        return { submitted: Promise.resolve(), end: () => {}, summary: Promise.resolve({}) }
      },
      shutdown: () => { counters.shutdowns++; return shutdown() },
    }),
  }
}

const dirs: string[] = []
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }) })
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'idle-377-'))
  dirs.push(dir)
  return dir
}

describe('OCV5-377 an idle summary turn parked on a tool call', () => {
  test('a stuck op whose runner was killed stops the parked run and settles; the session is free', async () => {
    const dir = await tempDir()
    const key = 'parked'
    const idleTurn = 'ff'.repeat(32)
    const server = await egress(() => idleTurn)
    try {
      writeIdleCandidate(dir, { v: 1, sessionKey: key, sessionId, turnKey: sourceTurn })
      const stuck: IdleOp = { v: 1, sessionKey: key, sourceSessionId: sessionId, sourceTurnKey: sourceTurn,
        revision, idleTurnKey: idleTurn, frozenTail: [], attachments: [], runnerKilledAt: Date.now() - 1_000 }
      writeIdleOp(dir, stuck)
      const counters = { submits: 0, shutdowns: 0 }
      await finish.call({}, fakeSession(key, counters), { sessionId, turnKey: sourceTurn }, dir)
      assert.deepEqual(server.stops(), [{ path: '/internal/box/stop', turnKey: idleTurn }],
        'exactly the idle turn of this session is stopped, once')
      assert.equal(readIdleOp(dir, key, revision)?.abandonReason, 'idle_turn_failed')
      assert.equal(readPendingIdle(dir, key), undefined)
      assert.equal(readIdleCandidate(dir, key), undefined, 'the next message is not refused')
      assert.equal(counters.submits, 0, 'nothing is sent to a model')
    } finally { await server.close() }
  })

  test('without proof the runner is dead, nothing is stopped and the op stays pending', async () => {
    const dir = await tempDir()
    const key = 'alive'
    const idleTurn = 'ee'.repeat(32)
    const server = await egress(() => idleTurn)
    try {
      writeIdleCandidate(dir, { v: 1, sessionKey: key, sessionId, turnKey: sourceTurn })
      writeIdleOp(dir, { v: 1, sessionKey: key, sourceSessionId: sessionId, sourceTurnKey: sourceTurn,
        revision, idleTurnKey: idleTurn, frozenTail: [], attachments: [] })
      await finish.call({}, fakeSession(key, { submits: 0, shutdowns: 0 }), { sessionId, turnKey: sourceTurn }, dir)
      assert.deepEqual(server.stops(), [])
      assert.ok(readPendingIdle(dir, key))
      assert.ok(readIdleCandidate(dir, key))
    } finally { await server.close() }
  })
})
