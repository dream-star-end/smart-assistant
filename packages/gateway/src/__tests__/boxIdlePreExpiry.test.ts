/**
 * OCV5-755 phase 2: Box idle compaction runs shortly before the 1h prompt
 * cache expires instead of right after every turn, and CCB compacts at a 400k
 * working window while the model keeps its 1M window.
 *
 * Run:
 *   npx tsx --test packages/gateway/src/__tests__/boxIdlePreExpiry.test.ts
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, mock, test } from 'node:test'
import { BOX_NATIVE_CONTEXT_MODEL, BOX_NATIVE_CONTEXT_OWNER } from '@openclaude/protocol'

const HOME = mkdtempSync(join(tmpdir(), 'ocv5-755-idle-home-'))
process.env.OPENCLAUDE_HOME = HOME
delete process.env.OC_BOX_IDLE_PRE_EXPIRY_MS
delete process.env.OC_BOX_IDLE_COMPACT_ALWAYS
delete process.env.OC_BOX_AUTO_COMPACT_WINDOW

const budget = await import('../boxContextBudget.js')
const idle = await import('../boxIdleCompact.js')
const { SessionManager } = await import('../sessionManager.js')
const { scheduleIdleDrain } = await import('../sessionLifecycle.js')

const finish = (SessionManager.prototype as unknown as {
  finishIdleUnderLock: (
    this: object,
    session: object,
    source: { sessionId: string; turnKey: string },
    recoveryDir?: string,
    mode?: 'after_turn' | 'pre_expiry',
  ) => Promise<'deferred' | void>
}).finishIdleUnderLock

const revision = 'ab'.repeat(32)
const sourceTurn = 'cd'.repeat(32)
const sessionId = 'native-session'

let server: Server
before(async () => {
  server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ slots: [], promptPolicy: { schemaVersion: 1, profile: null } }))
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { oc_turn_key?: string }
      res.setHeader('content-type', 'application/json')
      if (body.oc_turn_key === sourceTurn) {
        res.end(JSON.stringify({
          status: 'terminal', sessionId, turnKey: sourceTurn, requestId: 'biz',
          revision, compactRequired: true, capsuleSha256: 'ee'.repeat(32),
        }))
        return
      }
      res.end(JSON.stringify({ status: 'pending', reason: 'unsettled' }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  const base = `http://127.0.0.1:${address.port}/`
  process.env.ANTHROPIC_BASE_URL = base
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = base
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'oc-v3.test-token'
  process.env.OC_BOX_IDLE_PROOF_WAIT_MS = '0'
})
after(() => server.close())

let n = 0
function boxSession(dir: string) {
  n += 1
  const sessionKey = `pre-expiry-${n}`
  const idleTurn = createHash('sha256').update(`${sessionKey}:${revision}`).digest('hex')
  const seen = { submits: 0, minInputTokens: undefined as number | undefined }
  const session = {
    sessionKey,
    model: BOX_NATIVE_CONTEXT_MODEL,
    _boxContextOwner: BOX_NATIVE_CONTEXT_OWNER,
    runner: Object.assign(new EventEmitter(), {
      submitTurn: () => ({
        submitted: Promise.resolve(),
        end: () => {},
        summary: (async () => {
          seen.submits += 1
          const native = idle.readIdleNative(dir, sessionId, revision)
          seen.minInputTokens = native?.minInputTokens
          // CCB measured a short outer history: settle without a summary.
          if (native) idle.writeIdleNative(dir, { ...native, applied: true })
          return {}
        })(),
      }),
    }),
  }
  return { session, sessionKey, idleTurn, seen }
}

test('after a turn the idle op is deferred: no op, no idle turn, candidate cleared', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocv5-755-defer-'))
  const { session, sessionKey, seen } = boxSession(dir)
  idle.writeIdleCandidate(dir, { v: 1, sessionKey, sessionId, turnKey: sourceTurn })
  const outcome = await finish.call({}, session, { sessionId, turnKey: sourceTurn }, dir)
  assert.equal(outcome, 'deferred')
  assert.equal(seen.submits, 0)
  assert.equal(idle.readIdleOp(dir, sessionKey, revision), undefined)
  assert.equal(idle.readIdleCandidate(dir, sessionKey), undefined)
  assert.equal(idle.readPendingIdle(dir, sessionKey), undefined)
})

test('pre-OCV5-755 timing (pre-expiry off): the idle turn runs right after the turn', async () => {
  process.env.OC_BOX_IDLE_PRE_EXPIRY_MS = 'off'
  try {
    const dir = mkdtempSync(join(tmpdir(), 'ocv5-755-legacy-'))
    const { session, sessionKey, seen } = boxSession(dir)
    idle.writeIdleCandidate(dir, { v: 1, sessionKey, sessionId, turnKey: sourceTurn })
    const outcome = await finish.call({}, session, { sessionId, turnKey: sourceTurn }, dir)
    assert.equal(outcome, undefined)
    assert.equal(seen.submits, 1)
    assert.equal(seen.minInputTokens, undefined, 'after-turn ops keep the near-limit fit')
  } finally {
    delete process.env.OC_BOX_IDLE_PRE_EXPIRY_MS
  }
})

test('pre-expiry mode dispatches and tells CCB to compact from the 167k floor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocv5-755-pre-'))
  const { session, sessionKey, seen } = boxSession(dir)
  idle.writeIdleCandidate(dir, { v: 1, sessionKey, sessionId, turnKey: sourceTurn })
  await finish.call({}, session, { sessionId, turnKey: sourceTurn }, dir, 'pre_expiry')
  assert.equal(seen.submits, 1)
  assert.equal(seen.minInputTokens, budget.BOX_IDLE_PRE_EXPIRY_MIN_TOKENS)
  assert.equal(idle.readIdleOp(dir, sessionKey, revision)?.disposition, 'short')
  assert.equal(idle.readIdleCandidate(dir, sessionKey), undefined)
})

// ── lifecycle: deferral arms a timer; a newer turn cancels it ──

function lifecycleHost(session: { sessionKey: string }) {
  const calls: string[] = []
  const host = {
    sessions: new Map([[session.sessionKey, session]]),
    async finishIdleUnderLock(_s: unknown, _source: unknown, _dir?: string, mode = 'after_turn') {
      calls.push(mode)
      idle.clearIdleCandidate(HOME, session.sessionKey)
      return mode === 'after_turn' ? 'deferred' : undefined
    },
    scheduleIdleDrain(s: unknown) { scheduleIdleDrain.call(host as never, s as never) },
  }
  return { host, calls }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
}

test('a deferred op compacts at the pre-expiry delay, under the session lock', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const session: Record<string, unknown> = { sessionKey: `life-${++n}`, lock: Promise.resolve(), runner: { nativeSessionId: sessionId } }
    const { host, calls } = lifecycleHost(session as { sessionKey: string })
    idle.writeIdleCandidate(HOME, { v: 1, sessionKey: session.sessionKey as string, sessionId, turnKey: sourceTurn })
    scheduleIdleDrain.call(host as never, session as never)
    await flush()
    assert.deepEqual(calls, ['after_turn'])
    assert.ok(session._idlePreExpiryTimer, 'deferral arms the timer')
    mock.timers.tick(budget.BOX_IDLE_PRE_EXPIRY_MS_DEFAULT - 1)
    await flush()
    assert.deepEqual(calls, ['after_turn'])
    mock.timers.tick(1)
    await flush()
    assert.deepEqual(calls, ['after_turn', 'pre_expiry'])
    assert.equal(session._idlePreExpiryActive, false)
    assert.equal(session._idleInternalTurns, 0)
  } finally {
    mock.timers.reset()
  }
})

test('a user turn before the delay cancels the pre-expiry compaction', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const session: Record<string, unknown> = { sessionKey: `life-${++n}`, lock: Promise.resolve(), runner: { nativeSessionId: sessionId } }
    const { host, calls } = lifecycleHost(session as { sessionKey: string })
    idle.writeIdleCandidate(HOME, { v: 1, sessionKey: session.sessionKey as string, sessionId, turnKey: sourceTurn })
    scheduleIdleDrain.call(host as never, session as never)
    await flush()
    budget.cancelIdlePreExpiry(session)
    mock.timers.tick(budget.BOX_IDLE_PRE_EXPIRY_MS_DEFAULT)
    await flush()
    assert.deepEqual(calls, ['after_turn'])
  } finally {
    mock.timers.reset()
  }
})

test('audit r1: a pre-expiry attempt whose proof is not ready leaves no candidate behind', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const key = `life-${++n}`
    const session: Record<string, unknown> = { sessionKey: key, lock: Promise.resolve(), runner: { nativeSessionId: sessionId } }
    const calls: string[] = []
    const host = {
      sessions: new Map([[key, session]]),
      async finishIdleUnderLock(_s: unknown, _src: unknown, _d?: string, mode = 'after_turn') {
        calls.push(mode)
        if (mode === 'after_turn') { idle.clearIdleCandidate(HOME, key); return 'deferred' }
        return undefined // proof pending: returned without an op, candidate untouched
      },
      scheduleIdleDrain(s: unknown) { calls.push('drain'); void s },
    }
    idle.writeIdleCandidate(HOME, { v: 1, sessionKey: key, sessionId, turnKey: sourceTurn })
    scheduleIdleDrain.call(host as never, session as never)
    await flush()
    mock.timers.tick(budget.BOX_IDLE_PRE_EXPIRY_MS_DEFAULT)
    await flush()
    assert.deepEqual(calls, ['after_turn', 'pre_expiry'])
    assert.equal(idle.readIdleCandidate(HOME, key), undefined, 'next user turn is not blocked')
    assert.equal(session._idlePreExpiryTimer, undefined, 'no second timer')
  } finally {
    mock.timers.reset()
  }
})

test('audit r1: a replaced native session skips the stale pre-expiry compaction', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const session: Record<string, unknown> = { sessionKey: `life-${++n}`, lock: Promise.resolve(), runner: { nativeSessionId: sessionId } }
    const { host, calls } = lifecycleHost(session as { sessionKey: string })
    idle.writeIdleCandidate(HOME, { v: 1, sessionKey: session.sessionKey as string, sessionId, turnKey: sourceTurn })
    scheduleIdleDrain.call(host as never, session as never)
    await flush()
    ;(session.runner as { nativeSessionId?: string }).nativeSessionId = undefined
    mock.timers.tick(budget.BOX_IDLE_PRE_EXPIRY_MS_DEFAULT)
    await flush()
    assert.deepEqual(calls, ['after_turn'])
  } finally {
    mock.timers.reset()
  }
})

test('submit cancels the armed timer and shows compacting while one runs', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../sessionSubmit.ts', import.meta.url), 'utf8')
  const lockAt = src.indexOf('session.lock = new Promise<void>((r) => (release = r))')
  const cancelAt = src.indexOf('cancelIdlePreExpiry(session)', lockAt)
  const awaitAt = src.indexOf('\n    await prev\n', lockAt)
  assert.ok(lockAt > 0 && cancelAt > lockAt && cancelAt < awaitAt)
  assert.match(src.slice(cancelAt, awaitAt), /onEvent\(\{ kind: 'turn_status', status: 'compacting' \}\)/)
  assert.match(src.slice(awaitAt, awaitAt + 200), /onEvent\(\{ kind: 'turn_status', status: null \}\)/)
})

// ── knobs ──

test('autocompact window: 400k for Box Claude only; flag file can switch it off', () => {
  const home = mkdtempSync(join(tmpdir(), 'ocv5-755-knob-'))
  assert.equal(budget.boxAutoCompactWindowEnv('box-claude-opus-5-5', home, {}), '400000')
  assert.equal(budget.boxAutoCompactWindowEnv('claude-opus-5-5-remote', home, {}), '')
  assert.equal(budget.boxAutoCompactWindowEnv('deepseek-v4-flash', home, {}), '')
  assert.equal(budget.boxAutoCompactWindowEnv('box-claude-opus-5-5', home, { OC_BOX_AUTO_COMPACT_WINDOW: '600000' }), '600000')
  mkdirSync(join(home, 'runtime-flags'))
  writeFileSync(join(home, 'runtime-flags', 'box-autocompact-window'), 'off\n')
  assert.equal(budget.boxAutoCompactWindowEnv('box-claude-opus-5-5', home, {}), '')
  writeFileSync(join(home, 'runtime-flags', 'box-autocompact-window'), '5')
  assert.equal(budget.boxAutoCompactWindowEnv('box-claude-opus-5-5', home, {}), '400000', 'out of range keeps the default')
})

test('pre-expiry delay: 50 min default, off restores the old timing', () => {
  const home = mkdtempSync(join(tmpdir(), 'ocv5-755-delay-'))
  assert.equal(budget.boxIdlePreExpiryMs(home, {}), 50 * 60_000)
  assert.equal(budget.boxIdlePreExpiryMs(home, { OC_BOX_IDLE_PRE_EXPIRY_MS: 'off' }), 0)
  assert.equal(budget.boxIdlePreExpiryMs(home, { OC_BOX_IDLE_PRE_EXPIRY_MS: String(70 * 60_000) }), 50 * 60_000)
})

test('the real CCB spawn env carries the window exactly once', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../subprocessRunner.ts', import.meta.url), 'utf8')
  assert.equal(
    src.split('CLAUDE_CODE_AUTO_COMPACT_WINDOW: boxAutoCompactWindowEnv(this.opts.model, storagePaths.home),').length - 1,
    1,
  )
})
