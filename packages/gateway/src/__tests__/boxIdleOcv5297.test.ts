/**
 * OCV5-297 idle state machine: dispatch gate, authoritative abandonment,
 * bounded proof errors, operator reset marker, op rotation and the idle turn
 * timeout. No wall-clock-only settlement anywhere.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, utimesSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { BOX_NATIVE_CONTEXT_MODEL, BOX_NATIVE_CONTEXT_OWNER } from '@openclaude/protocol'
import {
  IDLE_STOPPED_GRACE_MS,
  abandonAllIdle,
  idleAbandonReason,
  idleNativePath,
  idleOpSettled,
  idleResetPath,
  pruneIdleOps,
  readIdleCandidate,
  readIdleOp,
  readIdleReset,
  readPendingIdle,
  requestIdleReset,
  sourceNeedsIdleOp,
  startIdleOp,
  writeIdleCandidate,
  writeIdleNative,
  writeIdleOp,
  type IdleOp,
} from '../boxIdleCompact.js'
import { IdleTurnTimeoutError, runBoxIdleTurn } from '../boxIdleTurn.js'
import { fetchBoxIdleProof, type IdleProofResponse } from '../engine/boxIdleProofClient.js'
import { SessionManager } from '../sessionManager.js'

const finish = (SessionManager.prototype as unknown as {
  finishIdleUnderLock: (this: object, session: object, source: { sessionId: string; turnKey: string },
    recoveryDir?: string) => Promise<void>
}).finishIdleUnderLock

const revision = 'ab'.repeat(32)
const sourceTurn = 'cd'.repeat(32)
const sessionId = 'native-297'
const terminal = (compactRequired: boolean): IdleProofResponse => ({
  status: 'terminal', sessionId, turnKey: sourceTurn, requestId: 'r', revision,
  compactRequired, capsuleSha256: 'ee'.repeat(32),
})

function op(extra: Partial<IdleOp> = {}): IdleOp {
  return { v: 1, sessionKey: 'k', sourceSessionId: sessionId, sourceTurnKey: sourceTurn,
    revision, idleTurnKey: 'ff'.repeat(32), frozenTail: [], attachments: [], ...extra }
}

/** Local proof endpoint; `route(turnKey)` decides the reply for each call. */
async function proofServer(route: (turnKey: string) => { code?: number; body: unknown }) {
  const calls: string[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const turnKey = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { oc_turn_key: string }).oc_turn_key
      calls.push(turnKey)
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
    calls,
    async close() {
      keys.forEach((key, i) => { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i] })
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function fakeSession(sessionKey: string, onSubmit: () => void = () => {}) {
  return {
    sessionKey, model: BOX_NATIVE_CONTEXT_MODEL, _boxContextOwner: BOX_NATIVE_CONTEXT_OWNER,
    runner: Object.assign(new EventEmitter(), {
      submitTurn: () => { onSubmit(); return { submitted: Promise.resolve(), end: () => {}, summary: Promise.resolve({}) } },
    }),
  }
}

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'idle-297-'))
  dirs.push(dir)
  return dir
}
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }) })

describe('dispatch gate and authoritative abandonment (pure)', () => {
  test('a new idle op only when the leaf needs it, a ready set, or ALWAYS', () => {
    assert.equal(sourceNeedsIdleOp(terminal(false), false), false)
    assert.equal(sourceNeedsIdleOp(terminal(true), false), true)
    assert.equal(sourceNeedsIdleOp(terminal(false), true), true)
    assert.equal(sourceNeedsIdleOp({ status: 'terminal_set', sessionId, turnKey: sourceTurn, revision,
      requestIds: ['a', 'b'] }, false), true)
    assert.equal(sourceNeedsIdleOp({ status: 'pending', reason: 'x' }, true), false)
  })

  test('only egress failure or a stopped turn unseen past the grace window abandon', () => {
    const now = 1_000_000
    assert.equal(idleAbandonReason(op(), { status: 'failed', sessionId, turnKey: 'ff'.repeat(32), requestIds: ['x'] }, now),
      'idle_turn_failed')
    assert.equal(idleAbandonReason(op(), { status: 'not_found' }, now), undefined, 'no stop evidence')
    assert.equal(idleAbandonReason(op({ runnerKilledAt: now - IDLE_STOPPED_GRACE_MS + 1 }), { status: 'not_found' }, now),
      undefined, 'inside grace')
    assert.equal(idleAbandonReason(op({ runnerKilledAt: now - IDLE_STOPPED_GRACE_MS }), { status: 'not_found' }, now),
      'idle_turn_never_sent')
    assert.equal(idleAbandonReason(op({ runnerKilledAt: 0 }), { status: 'pending', reason: 'unsettled' }, now),
      undefined, 'an egress row exists: wait for it')
    assert.equal(idleAbandonReason(op({ summaryText: 's' }), { status: 'failed', sessionId, turnKey: 'x', requestIds: ['x'] }, now),
      undefined, 'a prepared summary is never abandoned')
    assert.equal(idleOpSettled(op({ disposition: 'abandoned' })), true)
  })
})

describe('proof client never throws and reports why it skipped', () => {
  test('network error, timeout, skipped reasons, failed parse', async () => {
    const env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/', OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:9/',
      OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.t' }
    assert.deepEqual(await fetchBoxIdleProof({ sessionId, turnKey: sourceTurn },
      { env, fetchImpl: async () => { throw new TypeError('fetch failed') } }), { status: 'pending', reason: 'network' })
    assert.deepEqual(await fetchBoxIdleProof({ sessionId, turnKey: sourceTurn },
      { env, fetchImpl: async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }) } }),
    { status: 'pending', reason: 'timeout' })
    assert.deepEqual(await fetchBoxIdleProof({ sessionId, turnKey: sourceTurn }, { env: {} }),
      { status: 'skipped', reason: 'not_configured' })
    assert.deepEqual(await fetchBoxIdleProof({ sessionId: 'bad/id', turnKey: sourceTurn }, { env }),
      { status: 'skipped', reason: 'identity_invalid' })
    const reply = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 })
    assert.deepEqual(await fetchBoxIdleProof({ sessionId, turnKey: sourceTurn },
      { env, fetchImpl: reply({ status: 'failed', sessionId, turnKey: sourceTurn, requestIds: ['a', 'b'] }) }),
    { status: 'failed', sessionId, turnKey: sourceTurn, requestIds: ['a', 'b'] })
    assert.equal((await fetchBoxIdleProof({ sessionId, turnKey: sourceTurn },
      { env, fetchImpl: reply({ status: 'failed', sessionId, turnKey: sourceTurn, requestIds: ['b', 'a'] }) })).status,
    'pending', 'unsorted ids are malformed')
  })
})

describe('finishIdleUnderLock (OCV5-297)', () => {
  test('compactRequired=false clears the candidate without creating an op or a CCB turn', async () => {
    const dir = await tempDir()
    let submits = 0
    const server = await proofServer(() => ({ body: terminal(false) }))
    try {
      writeIdleCandidate(dir, { v: 1, sessionKey: 'gate', sessionId, turnKey: sourceTurn })
      await finish.call({}, fakeSession('gate', () => { submits++ }), { sessionId, turnKey: sourceTurn }, dir)
      assert.equal(submits, 0)
      assert.equal(readIdleCandidate(dir, 'gate'), undefined)
      assert.equal(readIdleOp(dir, 'gate', revision), undefined)
    } finally { await server.close() }
  })

  test('skipped releases a bare candidate but keeps a started op blocked', async () => {
    const dir = await tempDir()
    const keys = ['ANTHROPIC_BASE_URL', 'OPENCLAUDE_V3_MASTER_BASE_URL'] as const
    const before = keys.map((key) => process.env[key])
    keys.forEach((key) => { delete process.env[key] })
    try {
      writeIdleCandidate(dir, { v: 1, sessionKey: 'skip-bare', sessionId, turnKey: sourceTurn })
      await finish.call({}, fakeSession('skip-bare'), { sessionId, turnKey: sourceTurn }, dir)
      assert.equal(readIdleCandidate(dir, 'skip-bare'), undefined, 'nothing was dispatched: release')

      startIdleOp({ dir, sessionKey: 'skip-op', sourceSessionId: sessionId, sourceTurnKey: sourceTurn,
        revision, idleTurnKey: 'ff'.repeat(32), frozenTail: [], attachments: [] })
      writeIdleCandidate(dir, { v: 1, sessionKey: 'skip-op', sessionId, turnKey: sourceTurn })
      await finish.call({}, fakeSession('skip-op'), { sessionId, turnKey: sourceTurn }, dir)
      assert.ok(readPendingIdle(dir, 'skip-op'), 'an op may have a request in flight: stay blocked')
      assert.ok(readIdleCandidate(dir, 'skip-op'))
    } finally {
      keys.forEach((key, i) => { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i] })
    }
  })

  test('a failed source turn clears the candidate; a failed idle turn abandons the op', async () => {
    const dir = await tempDir()
    const key = 'failed-idle'
    const idleTurn = createHash('sha256').update(`${key}:${revision}`).digest('hex')
    let submits = 0
    const server = await proofServer((turnKey) => turnKey === sourceTurn
      ? { body: terminal(true) }
      : { body: { status: 'failed', sessionId, turnKey, requestIds: ['x'] } })
    try {
      startIdleOp({ dir, sessionKey: key, sourceSessionId: sessionId, sourceTurnKey: sourceTurn,
        revision, idleTurnKey: idleTurn, frozenTail: [], attachments: [] })
      writeIdleNative(dir, { v: 1, opId: idleTurn, revision, sessionId, modelCalls: 1, modelStarted: true,
        frozenTail: [], attachments: [] })
      writeIdleCandidate(dir, { v: 1, sessionKey: key, sessionId, turnKey: sourceTurn })
      await finish.call({}, fakeSession(key, () => { submits++ }), { sessionId, turnKey: sourceTurn }, dir)
      assert.equal(submits, 0, 'never re-dispatched')
      assert.equal(readIdleOp(dir, key, revision)?.disposition, 'abandoned')
      assert.equal(readIdleOp(dir, key, revision)?.abandonReason, 'idle_turn_failed')
      assert.equal(readPendingIdle(dir, key), undefined)
      assert.equal(readIdleCandidate(dir, key), undefined)
    } finally { await server.close() }

    const dir2 = await tempDir()
    const server2 = await proofServer(() => ({ body: { status: 'failed', sessionId, turnKey: sourceTurn, requestIds: ['s'] } }))
    try {
      writeIdleCandidate(dir2, { v: 1, sessionKey: 'src-failed', sessionId, turnKey: sourceTurn })
      await finish.call({}, fakeSession('src-failed'), { sessionId, turnKey: sourceTurn }, dir2)
      assert.equal(readIdleCandidate(dir2, 'src-failed'), undefined)
    } finally { await server2.close() }
  })

  test('an op settles as never_sent only after a confirmed runner shutdown and the grace window', async () => {
    const dir = await tempDir()
    const key = 'inherited'
    const idleTurn = createHash('sha256').update(`${key}:${revision}`).digest('hex')
    let submits = 0
    const server = await proofServer((turnKey) => turnKey === sourceTurn
      ? { body: terminal(true) } : { code: 404, body: { error: 'NOT_FOUND' } })
    try {
      startIdleOp({ dir, sessionKey: key, sourceSessionId: sessionId, sourceTurnKey: sourceTurn,
        revision, idleTurnKey: idleTurn, frozenTail: [], attachments: [] })
      writeIdleNative(dir, { v: 1, opId: idleTurn, revision, sessionId, modelCalls: 0, modelStarted: true,
        frozenTail: [], attachments: [] })
      writeIdleCandidate(dir, { v: 1, sessionKey: key, sessionId, turnKey: sourceTurn })
      const session = fakeSession(key, () => { submits++ })
      await finish.call({}, session, { sessionId, turnKey: sourceTurn }, dir)
      const first = readIdleOp(dir, key, revision)
      assert.equal(first?.runnerKilledAt, undefined, 'no shutdown evidence: no clock, no settlement')
      assert.equal(first?.disposition, undefined)
      writeIdleOp(dir, { ...first!, runnerKilledAt: Date.now() - 1000 })
      await finish.call({}, session, { sessionId, turnKey: sourceTurn }, dir)
      assert.equal(readIdleOp(dir, key, revision)?.disposition, undefined, 'inside grace')
      writeIdleOp(dir, { ...first!, runnerKilledAt: Date.now() - IDLE_STOPPED_GRACE_MS - 1 })
      await finish.call({}, session, { sessionId, turnKey: sourceTurn }, dir)
      assert.equal(readIdleOp(dir, key, revision)?.abandonReason, 'idle_turn_never_sent')
      assert.equal(submits, 0)
    } finally { await server.close() }
  })
})

describe('operator reset marker and op rotation', () => {
  test('reset marker path is encoded and must name the exact session', async () => {
    const dir = await tempDir()
    assert.throws(() => requestIdleReset(dir, '../escape'))
    assert.throws(() => requestIdleReset(dir, 'a/b'))
    const path = requestIdleReset(dir, 'agent:main:webchat:dm:x.y')
    assert.ok(path.startsWith(join(dir, 'idle-reset')))
    assert.equal(path, idleResetPath(dir, 'agent:main:webchat:dm:x.y'))
    const marker = readIdleReset(dir, 'agent:main:webchat:dm:x.y')
    assert.ok(marker && marker !== 'corrupt' && marker.sessionKey === 'agent:main:webchat:dm:x.y')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(idleResetPath(dir, 'other'), JSON.stringify({ v: 1, sessionKey: 'not-other', requestedAt: 1 }))
    assert.equal(readIdleReset(dir, 'other'), 'corrupt')
    assert.equal(readIdleReset(dir, 'none'), undefined)
  })

  test('abandonAllIdle settles unfinished ops and clears the candidate', async () => {
    const dir = await tempDir()
    startIdleOp({ dir, sessionKey: 'reset', sourceSessionId: sessionId, sourceTurnKey: sourceTurn,
      revision, idleTurnKey: 'ff'.repeat(32), frozenTail: [], attachments: [] })
    writeIdleCandidate(dir, { v: 1, sessionKey: 'reset', sessionId, turnKey: sourceTurn })
    assert.equal(abandonAllIdle(dir, 'reset'), 1)
    assert.equal(readPendingIdle(dir, 'reset'), undefined)
    assert.equal(readIdleOp(dir, 'reset', revision)?.abandonReason, 'operator_reset')
    assert.equal(readIdleCandidate(dir, 'reset'), undefined)
  })

  test('prune keeps the newest settled ops and never an unsettled one', async () => {
    const dir = await tempDir()
    const key = 'rotate'
    const base = Date.now() / 1000
    for (let i = 0; i < 8; i++) {
      const rev = i.toString(16).padStart(64, '0')
      const item: IdleOp = { ...op({ sessionKey: key, revision: rev }), ...(i === 0 ? {} : { disposition: 'short' as const }) }
      writeIdleOp(dir, item)
      writeIdleNative(dir, { v: 1, opId: item.idleTurnKey, revision: rev, sessionId, modelCalls: 0,
        frozenTail: [], attachments: [] })
      utimesSync(join(dir, 'idle-ops', key, `${rev}.json`), base + i, base + i)
    }
    const removed = pruneIdleOps(dir, key, 3)
    assert.equal(removed, 4)
    const left = readdirSync(join(dir, 'idle-ops', key)).sort()
    assert.equal(left.length, 4, 'three newest settled + the unsettled one')
    assert.ok(left.includes(`${'0'.repeat(64)}.json`), 'unsettled op kept')
    assert.ok(readPendingIdle(dir, key))
    assert.equal(existsSync(idleNativePath(dir, sessionId, (1).toString(16).padStart(64, '0'))), false)
    assert.equal(existsSync(idleNativePath(dir, sessionId, (7).toString(16).padStart(64, '0'))), true)
  })
})

describe('runBoxIdleTurn timeout', () => {
  function runnerThat(opts: { stopOnInterrupt: boolean }) {
    let summaryResolve: (value: unknown) => void = () => {}
    const events = { interrupts: 0, shutdowns: 0 }
    const runner = Object.assign(new EventEmitter(), {
      submitTurn: () => ({
        submitted: Promise.resolve(), finalized: false,
        end: () => summaryResolve(null),
        summary: new Promise((resolve) => { summaryResolve = resolve }),
      }),
      interrupt: () => { events.interrupts++; if (opts.stopOnInterrupt) summaryResolve(null); return true },
      shutdown: async () => { events.shutdowns++; summaryResolve(null) },
    })
    return { runner, events }
  }
  const params = { input: '/compact', turnKey: 'ab'.repeat(32), onEvent: () => {},
    sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map() }

  test('a hung idle turn is interrupted, then shut down, and never counts as a result', { timeout: 3000 }, async () => {
    const { runner, events } = runnerThat({ stopOnInterrupt: false })
    await assert.rejects(runBoxIdleTurn(runner as never, params as never, { timeoutMs: 30, killGraceMs: 20 }),
      (error: unknown) => error instanceof IdleTurnTimeoutError && error.killed === true)
    assert.deepEqual(events, { interrupts: 1, shutdowns: 1 })
    assert.equal(runner.listenerCount('exit'), 0)
    assert.equal(runner.listenerCount('error'), 0)
  })

  test('a turn that stops on interrupt is still shut down before the timeout is reported', { timeout: 3000 }, async () => {
    const { runner, events } = runnerThat({ stopOnInterrupt: true })
    await assert.rejects(runBoxIdleTurn(runner as never, params as never, { timeoutMs: 30, killGraceMs: 200 }),
      (error: unknown) => error instanceof IdleTurnTimeoutError && error.killed === true)
    assert.deepEqual(events, { interrupts: 1, shutdowns: 1 })
  })

  test('a failed shutdown is reported as not killed', { timeout: 3000 }, async () => {
    const { runner } = runnerThat({ stopOnInterrupt: false })
    runner.shutdown = async () => { throw new Error('shutdown failed') }
    await assert.rejects(runBoxIdleTurn(runner as never, params as never, { timeoutMs: 20, killGraceMs: 10 }),
      (error: unknown) => error instanceof IdleTurnTimeoutError && error.killed === false)
  })
})
