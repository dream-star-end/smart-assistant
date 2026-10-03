/**
 * OCV5-319: an idle compact turn that ends without a summary must leave
 * settlement evidence. CCB reports a refused summary request (Box egress
 * BOX_PARAMETER_UNMAPPED on the thinking-disabled compact fallback) as an
 * ordinary turn end; before this fix the op had no runnerKilledAt and pinned
 * the session on IDLE_HISTORY_PENDING ("消息未开始处理") until an operator reset.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { utimesSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { BOX_NATIVE_CONTEXT_MODEL, BOX_NATIVE_CONTEXT_OWNER } from '@openclaude/protocol'
import {
  IDLE_STOPPED_GRACE_MS,
  readIdleCandidate,
  readIdleOp,
  readPendingIdle,
  runtimeIncarnationStartMs,
  startIdleOp,
  withIncarnationShutdown,
  writeIdleCandidate,
  writeIdleNative,
  writeIdleOp,
  type IdleOp,
} from '../boxIdleCompact.js'
import type { IdleProofResponse } from '../engine/boxIdleProofClient.js'
import { SessionManager } from '../sessionManager.js'

const finish = (SessionManager.prototype as unknown as {
  finishIdleUnderLock: (this: object, session: object, source: { sessionId: string; turnKey: string },
    recoveryDir?: string) => Promise<void>
}).finishIdleUnderLock

const revision = 'ab'.repeat(32)
const sourceTurn = 'cd'.repeat(32)
const sessionId = 'native-319'
const terminal: IdleProofResponse = {
  status: 'terminal', sessionId, turnKey: sourceTurn, requestId: 'r', revision,
  compactRequired: true, capsuleSha256: 'ee'.repeat(32),
}

async function proofServer(route: (turnKey: string) => { code?: number; body: unknown }) {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const turnKey = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { oc_turn_key: string }).oc_turn_key
      const reply = route(turnKey)
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
    async close() {
      keys.forEach((key, i) => { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i] })
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** The idle turn "completes" with an empty summary, like CCB after a refused request. */
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
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'idle-319-'))
  dirs.push(dir)
  return dir
}
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }) })

function op(extra: Partial<IdleOp> = {}): IdleOp {
  return { v: 1, sessionKey: 'pure', sourceSessionId: sessionId, sourceTurnKey: sourceTurn,
    revision, idleTurnKey: 'ff'.repeat(32), frozenTail: [], attachments: [], ...extra }
}

describe('OCV5-319 idle turn without a summary', () => {
  test('a normal turn end with no summary shuts the runner down and records it', async () => {
    const dir = await tempDir()
    const key = 'no-summary'
    const counters = { submits: 0, shutdowns: 0 }
    const server = await proofServer((turnKey) => turnKey === sourceTurn
      ? { body: terminal } : { code: 404, body: { error: 'NOT_FOUND' } })
    try {
      writeIdleCandidate(dir, { v: 1, sessionKey: key, sessionId, turnKey: sourceTurn })
      const session = fakeSession(key, counters)
      const before = Date.now()
      await finish.call({}, session, { sessionId, turnKey: sourceTurn }, dir)
      assert.equal(counters.submits, 1, 'the idle turn was dispatched once')
      assert.equal(counters.shutdowns, 1, 'its runner was shut down')
      const recorded = readIdleOp(dir, key, revision)
      assert.ok((recorded?.runnerKilledAt ?? 0) >= before, 'shutdown evidence recorded')
      assert.equal(recorded?.disposition, undefined, 'inside the grace window nothing settles yet')
      assert.ok(readPendingIdle(dir, key))

      // Past the grace window, egress not_found settles it: the next message is not blocked.
      writeIdleOp(dir, { ...recorded!, runnerKilledAt: Date.now() - IDLE_STOPPED_GRACE_MS - 1 })
      await finish.call({}, session, { sessionId, turnKey: sourceTurn }, dir)
      assert.equal(readIdleOp(dir, key, revision)?.abandonReason, 'idle_turn_never_sent')
      assert.equal(readPendingIdle(dir, key), undefined)
      assert.equal(readIdleCandidate(dir, key), undefined)
      assert.equal(counters.submits, 1, 'never re-dispatched')
    } finally { await server.close() }
  })

  test('a failed shutdown records no evidence (stays blocked, no clock-only settlement)', async () => {
    const dir = await tempDir()
    const key = 'no-summary-stuck'
    const counters = { submits: 0, shutdowns: 0 }
    const server = await proofServer((turnKey) => turnKey === sourceTurn
      ? { body: terminal } : { code: 404, body: { error: 'NOT_FOUND' } })
    try {
      writeIdleCandidate(dir, { v: 1, sessionKey: key, sessionId, turnKey: sourceTurn })
      await finish.call({}, fakeSession(key, counters, async () => { throw new Error('busy') }),
        { sessionId, turnKey: sourceTurn }, dir)
      assert.equal(counters.shutdowns, 1)
      assert.equal(readIdleOp(dir, key, revision)?.runnerKilledAt, undefined)
    } finally { await server.close() }
  })
})

describe('OCV5-319 runtime incarnation as shutdown evidence', () => {
  test('incarnation start is readable on Linux and not in the future', () => {
    const start = runtimeIncarnationStartMs()
    assert.equal(typeof start, 'number')
    assert.ok(start! > Date.UTC(2020, 0, 1) && start! <= Date.now())
  })

  test('only an unfinished op written before the incarnation gets its start as runnerKilledAt', async () => {
    const dir = await tempDir()
    const pending = op()
    writeIdleOp(dir, pending)
    const path = join(dir, 'idle-ops', encodeURIComponent(pending.sessionKey), `${revision}.json`)
    const start = Date.now()
    utimesSync(path, new Date(start - 60_000), new Date(start - 60_000))
    assert.equal(withIncarnationShutdown(dir, pending, start).runnerKilledAt, start)
    utimesSync(path, new Date(start + 1_000), new Date(start + 1_000))
    assert.equal(withIncarnationShutdown(dir, pending, start).runnerKilledAt, undefined, 'written by this incarnation')
    assert.equal(withIncarnationShutdown(dir, pending, undefined).runnerKilledAt, undefined, 'no /proc: no evidence')
    const killed = op({ runnerKilledAt: 5 })
    assert.equal(withIncarnationShutdown(dir, killed, start).runnerKilledAt, 5, 'existing evidence wins')
    const settled = op({ disposition: 'short' })
    assert.equal(withIncarnationShutdown(dir, settled, start).runnerKilledAt, undefined)
  })

  test('the incident shape: an op stranded by a previous container settles on the next submit', async () => {
    const dir = await tempDir()
    const key = 'stranded'
    const idleTurn = createHash('sha256').update(`${key}:${revision}`).digest('hex')
    const counters = { submits: 0, shutdowns: 0 }
    // Egress lost both turns (slot switch): source and idle proofs are not_found.
    const server = await proofServer(() => ({ code: 404, body: { error: 'NOT_FOUND' } }))
    try {
      startIdleOp({ dir, sessionKey: key, sourceSessionId: sessionId, sourceTurnKey: sourceTurn,
        revision, idleTurnKey: idleTurn, frozenTail: [], attachments: [] })
      writeIdleNative(dir, { v: 1, opId: idleTurn, revision, sessionId, modelCalls: 0, modelStarted: true,
        frozenTail: [], attachments: [] })
      const path = join(dir, 'idle-ops', encodeURIComponent(key), `${revision}.json`)
      const old = new Date(Date.UTC(2001, 0, 1))
      utimesSync(path, old, old) // written long before this host/container started
      await finish.call({}, fakeSession(key, counters), { sessionId, turnKey: sourceTurn }, dir)
      const settled = readIdleOp(dir, key, revision)
      assert.equal(settled?.disposition, 'abandoned')
      assert.equal(settled?.abandonReason, 'idle_turn_never_sent')
      assert.equal(readPendingIdle(dir, key), undefined)
      assert.equal(counters.submits, 0, 'nothing dispatched')
    } finally { await server.close() }
  })
})
