/**
 * Phase 2.0 BASELINE — locks the CURRENT behavior of the continuation path and
 * the invariants the upcoming "permanent continuation stdout dispatcher"
 * refactor (P2.1–P2.3) must preserve. ZERO production code changes in P2.0.
 *
 * Two layers:
 *   A) parser-level raw-frame classification (createParser pattern)
 *   B) sessionManager continuation orchestration (fake-runner pattern)
 *
 * Frame shapes are source-verified against the official Claude Code source
 * (claude-code-best: coreSchemas.ts / sdkEventQueue.ts / print.ts). See
 * docs/continuation-dispatcher-design.md §8.
 *
 * INTENTIONAL KNOWN-BROKEN BASELINE: test "B2 #1 auto-background ... EVAPORATES"
 * encodes the BUG (auto-background continuation answer is dropped). P2.2 will
 * FLIP it. Do not "fix" it here — it is the regression target.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/continuationBaseline.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, mock } from 'node:test'
import type { SessionStreamEvent } from '../claudeMessageParser.js'

// Isolate OPENCLAUDE_HOME to a tmpdir BEFORE importing modules that capture
// paths.home (storage `HOME` is a module-load const). Otherwise SessionManager
// reads/writes the REAL prod resume-map.json under /root/.openclaude — these
// tests must never touch prod state on the daily-use box. Top-level await defers
// the rest of the module (incl. the FakeRunner subclass) until imports resolve;
// node:test runs each *.test.ts file in its own process, so the env set lands
// before any storage/paths module is first loaded in this process.
process.env.OPENCLAUDE_HOME = await mkdtemp(join(tmpdir(), 'oc-p2baseline-'))
// This file legitimately spins up many short-lived runner/session instances; the
// per-test process is isolated and exits promptly, so disable Node's MaxListeners
// heuristic for it (process-local; no prod impact, and no process.on('exit') is
// added by the gateway code under test — verified).
process.setMaxListeners(0)
const { CodexAppServerRunner } = await import('../codexAppServerRunner.js')
const { ClaudeMessageParser } = await import('../claudeMessageParser.js')
const {
  LIVENESS_IDLE_TIMEOUT_COMPACTING_MS,
  LIVENESS_IDLE_TIMEOUT_DEFAULT_MS,
  LIVENESS_IDLE_TIMEOUT_TOOL_MS,
  SessionManager,
  getLivenessIdleTimeoutMs,
} = await import('../sessionManager.js')

// ───────────────────────── source-verified frame builders ─────────────────
const SID = 'thread-test'
const taskStarted = (id = 'w1') => ({
  type: 'system',
  subtype: 'task_started',
  task_id: id,
  tool_use_id: `tu_${id}`,
  description: 'background workflow',
  uuid: `ustart-${id}`,
  session_id: SID,
})
const taskNotification = (status: 'completed' | 'failed' | 'stopped' = 'completed') => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: 'w1',
  tool_use_id: 'tu_w1',
  status,
  output_file: '',
  summary: 'subtask done',
  uuid: 'unotify',
  session_id: SID,
})
const sessionState = (state: 'idle' | 'running' | 'requires_action') => ({
  type: 'system',
  subtype: 'session_state_changed',
  state,
  uuid: `ustate-${state}`,
  session_id: SID,
})
// Non-phantom result: output_tokens:1 clears the all-zero-token phantom guard.
const result = (totalCostUsd = 0) => ({
  type: 'result',
  subtype: 'success',
  session_id: SID,
  total_cost_usd: totalCostUsd,
  duration_ms: 1,
  is_error: false,
  result: '',
  usage: { output_tokens: 1 },
})
const msgStart = (id: string) => ({
  type: 'stream_event',
  event: { type: 'message_start', message: { id } },
})
const textDelta = (text: string) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
})

// ───────────────────────── A) parser-level baselines ──────────────────────
function createParser() {
  const events: SessionStreamEvent[] = []
  const parser = new ClaudeMessageParser({
    toolUseIdToName: new Map<string, string>(),
    onEvent: (e) => events.push(e),
    onToolUse: undefined,
    onFinish: () => {},
    sessionTotals: { totalCostUSD: 0, turns: 0, _lastCcbCumulativeCost: 0 },
  })
  return { parser, events }
}

describe('P2.0 baseline — parser frame classification', () => {
  it('A1: task_started → workflow_progress{stage:started} (the #2 continuation trigger source)', () => {
    const { parser, events } = createParser()
    parser.parse(taskStarted() as any)
    assert.ok(
      events.some((e) => e.kind === 'workflow_progress' && (e as any).stage === 'started'),
      'task_started must surface a workflow_progress started event',
    )
  })

  it('A2: task_notification → NO event today (unrecognized; P2.3 will turn it into a watcher signal)', () => {
    const { parser, events } = createParser()
    parser.parse(taskNotification() as any)
    assert.equal(events.length, 0)
  })

  it('A3: session_state_changed(idle/running) → NO event today (P2.3 will make it the watch boundary signal)', () => {
    const { parser, events } = createParser()
    parser.parse(sessionState('idle') as any)
    parser.parse(sessionState('running') as any)
    assert.equal(events.length, 0)
  })

  it('A4: post-result drop — a continuation frame after result is silently dropped by the finalized guard', () => {
    const { parser, events } = createParser()
    parser.parse(result() as any)
    const after = events.length
    parser.parse(taskNotification() as any)
    parser.parse(textDelta('late continuation answer') as any)
    assert.equal(events.length, after, 'finalized parser must drop all post-result frames')
  })
})

// ───────────────────────── B) sessionManager orchestration ────────────────
// Fake runner: continuation re-arm is runner-type-agnostic (it keys only on the
// parser-derived workflow_progress event, not instanceof), so a CodexAppServer
// subclass faithfully drives the SubprocessRunner #1/#2 path. `scripts` is a
// queue of frame bursts emitted synchronously on each submit() — _runOneTurn
// installs the message listener (sessionManager.ts:1846) BEFORE calling
// runner.submit() (1852), so the burst always reaches an attached listener.
class FakeRunner extends CodexAppServerRunner {
  submissions: string[] = []
  interrupted = false
  shutdownCalled = false
  scripts: any[][] = []
  constructor() {
    super({ sessionKey: 'agent:codex:webchat:dm:web-test', agentId: 'codex', cwd: process.cwd() })
  }
  override interrupt(): boolean {
    this.interrupted = true
    return true
  }
  override async shutdown(): Promise<void> {
    this.shutdownCalled = true
  }
  override async submit(textOrBlocks: string | Array<{ type: string; text?: string }>) {
    this.submissions.push(
      typeof textOrBlocks === 'string' ? textOrBlocks : JSON.stringify(textOrBlocks),
    )
    this.lastActivityAt = Date.now()
    const burst = this.scripts.shift() ?? []
    for (const f of burst) this.emit('message', f)
  }
}

function makeTestSession(runner: FakeRunner): any {
  return {
    sessionKey: 'agent:codex:webchat:dm:web-test',
    agentId: 'codex',
    channel: 'webchat',
    peerId: 'web-test',
    userId: 'boss',
    title: 'test',
    startedAt: Date.now(),
    runner,
    runnerProviderTag: 'codex-native:app-server',
    ccbSessionId: null,
    lock: Promise.resolve(),
    lastUsedAt: Date.now(),
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    turns: 1,
    _lastCcbCumulativeCost: 0,
    toolUseIdToName: new Map(),
    _historicalContextInjected: true,
  }
}

// One shared manager: SessionManager state is keyed per-session (tests pass their
// own session object), and its resume-map disk writes are serialized on an
// internal promise chain. Sharing one instance avoids multiple managers racing
// on the single OPENCLAUDE_HOME resume-map path (benign tmpdir ENOENT spam).
const manager = new SessionManager({} as any)

const turnIdIndex = (id: string | undefined): number => {
  const m = /^srv-web-test-t(\d+)$/.exec(id ?? '')
  assert.ok(m, `turnId must match srv-web-test-tN, got ${id}`)
  return Number(m![1])
}

describe('P2.2 — webchat continuation watch (release lock + out-of-lock deliver/persist)', () => {
  it('B1: bg-task turn releases the lock + arms a watch; the continuation is delivered out-of-band with an advanced turnId (C/H/G)', async () => {
    const runner = new FakeRunner()
    const session = makeTestSession(runner)
    session.userId = undefined // skip the durable write (tested separately); assert delivery only
    const turnsBefore = session.turns
    const events: any[] = []
    const cont: Array<{ route: any; e: any }> = []
    manager.onContinuationEvent = (route, e) => cont.push({ route, e })

    // user turn launches a background task (task_started before result), then result.
    runner.scripts = [[taskStarted(), result()]]
    let userTurnId: string | undefined
    await manager.submit(session, 'do bg work', (e) => {
      events.push(e)
      if (e.kind === 'final') userTurnId = session._activeTurnId
    })
    // the user turn resolved (lock released) and a watch is armed.
    assert.equal(
      events.filter((e) => e.kind === 'final').length,
      1,
      'user turn final delivered via the submit onEvent',
    )
    assert.ok(session._continuationWatch, 'a continuation watch is armed (lock released)')

    // the continuation arrives LATER on the same runner — no new submit.
    runner.emit('message', msgStart('m-cont'))
    runner.emit('message', textDelta('synthesized continuation answer'))
    runner.emit('message', result())
    await new Promise((r) => setImmediate(r))

    // delivered OUT-OF-BAND via onContinuationEvent (NOT the submit onEvent).
    const contFinals = cont.filter((c) => c.e.kind === 'final')
    assert.equal(contFinals.length, 1, 'continuation final delivered via onContinuationEvent')
    assert.ok(
      cont.some(
        (c) =>
          c.e.kind === 'block' && (c.e.block as any)?.text === 'synthesized continuation answer',
      ),
      'continuation answer text delivered out-of-band',
    )
    // invariant C: continuation turnId == user turnId + 1 (lockstep, advanced).
    const contTurnId = contFinals[0].route.turnId
    assert.equal(
      turnIdIndex(contTurnId),
      turnIdIndex(userTurnId) + 1,
      'continuation turnId advances by exactly 1',
    )
    assert.equal(session.turns - turnsBefore, 2, 'each sub-turn advanced the turn counter')
    assert.equal(session._continuationWatch, null, 'watch ended after the terminal continuation')
  })

  it('B2: #1 auto-background — realistic task_notification-led continuation is now DELIVERED (P2.2 flip; was evaporate)', async () => {
    const runner = new FakeRunner()
    const session = makeTestSession(runner)
    session.userId = undefined
    const cont: Array<{ route: any; e: any }> = []
    manager.onContinuationEvent = (_route, e) => cont.push({ route: _route, e })

    // realistic #1: the user turn launches a backgrounded agent (task_started) then result.
    runner.scripts = [[taskStarted('agent-1'), result()]]
    await manager.submit(session, 'kick off auto-background subtask', () => {})
    assert.ok(session._continuationWatch, 'watch armed for the backgrounded task')

    // the backgrounded agent completes LATER → task_notification bookend (inert at the
    // parser), then the continuation turn (assistant → result) on the SAME runner.
    runner.emit('message', taskNotification('completed'))
    runner.emit('message', msgStart('m-cont'))
    runner.emit('message', textDelta('Here is the auto-background result summary.'))
    runner.emit('message', result())
    await new Promise((r) => setImmediate(r))

    assert.ok(
      cont.some((c) => c.e.kind === 'final'),
      'continuation final delivered (no longer evaporates)',
    )
    assert.ok(
      cont.some(
        (c) =>
          c.e.kind === 'block' &&
          (c.e.block as any)?.text === 'Here is the auto-background result summary.',
      ),
      'continuation answer delivered',
    )
    assert.equal(session._continuationWatch, null, 'watch ended after the continuation')
  })

  it('B3: invariant G — settle/lock-release exactly once per turn (two sequential turns both complete)', async () => {
    const runner = new FakeRunner()
    const session = makeTestSession(runner)
    const events: any[] = []

    runner.scripts = [[result()], [result()]]
    await manager.submit(session, 'first', (e) => events.push(e))
    // If the first turn leaked/double-released the lock, the second would hang or race.
    await manager.submit(session, 'second', (e) => events.push(e))

    assert.deepEqual(runner.submissions, ['first', 'second'])
    assert.equal(events.filter((e) => e.kind === 'final').length, 2)
    assert.equal(events.filter((e) => e.kind === 'error').length, 0)
  })

  it('B4a: watch supports multi-continuation — a continuation that launches another bg task re-arms the watch', async () => {
    const runner = new FakeRunner()
    const session = makeTestSession(runner)
    session.userId = undefined
    const cont: Array<{ route: any; e: any }> = []
    manager.onContinuationEvent = (route, e) => cont.push({ route, e })

    runner.scripts = [[taskStarted('t0'), result()]]
    await manager.submit(session, 'chain', () => {})
    assert.ok(session._continuationWatch, 'watch armed')

    // continuation 1: produces an answer AND launches another bg task → re-arm.
    runner.emit('message', msgStart('c1'))
    runner.emit('message', textDelta('answer 1'))
    runner.emit('message', taskStarted('t1'))
    runner.emit('message', result())
    assert.ok(
      session._continuationWatch,
      'watch re-armed after a continuation that launched another bg task',
    )

    // continuation 2: produces an answer, no further bg task → watch ends.
    runner.emit('message', msgStart('c2'))
    runner.emit('message', textDelta('answer 2'))
    runner.emit('message', result())
    await new Promise((r) => setImmediate(r))
    assert.equal(session._continuationWatch, null, 'watch ended after the terminal continuation')

    const contFinals = cont.filter((c) => c.e.kind === 'final')
    assert.equal(contFinals.length, 2, 'both continuation finals delivered')
    const ids = contFinals.map((c) => turnIdIndex(c.route.turnId))
    assert.equal(ids[1], ids[0] + 1, 'continuation turnIds advance by 1 per sub-turn')
  })

  it('B4b: watch ends on the idle backstop when no continuation arrives (no runner interrupt)', async () => {
    mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] })
    try {
      const runner = new FakeRunner()
      const session = makeTestSession(runner)
      session.userId = undefined
      runner.scripts = [[taskStarted(), result()]]
      await manager.submit(session, 'bg then silent', () => {})
      assert.ok(session._continuationWatch, 'watch armed')

      // no continuation arrives; advance past the watch backstop.
      mock.timers.tick(20 * 60_000 + 1)
      assert.equal(session._continuationWatch, null, 'watch ended on the idle backstop')
      assert.equal(runner.interrupted, false, 'backstop does NOT interrupt the persistent runner')
    } finally {
      mock.timers.reset()
    }
  })

  it('B5: invariant D — current liveness idle thresholds (the watch must NOT be killed by the 5-min default)', () => {
    assert.equal(getLivenessIdleTimeoutMs(undefined), LIVENESS_IDLE_TIMEOUT_DEFAULT_MS)
    assert.equal(getLivenessIdleTimeoutMs({}), LIVENESS_IDLE_TIMEOUT_DEFAULT_MS)
    assert.equal(getLivenessIdleTimeoutMs({ pendingToolCalls: 1 }), LIVENESS_IDLE_TIMEOUT_TOOL_MS)
    assert.equal(
      getLivenessIdleTimeoutMs({ isCompacting: true }),
      LIVENESS_IDLE_TIMEOUT_COMPACTING_MS,
    )
    assert.ok(LIVENESS_IDLE_TIMEOUT_DEFAULT_MS < 16 * 60_000)
  })

  it('B6: invariant E — auth error rolls back per-turn cost/turns snapshot and rejects (via _runOneTurn)', async () => {
    const runner = new FakeRunner()
    const session = makeTestSession(runner)
    session.turns = 5
    session.totalCostUSD = 1.23
    session._lastCcbCumulativeCost = 0.5
    const events: any[] = []

    // positive cost delta (0.75 - 0.5) so the rollback assertions are non-false-green.
    runner.scripts = [
      [msgStart('m-auth'), textDelta('Failed to authenticate: token expired'), result(0.75)],
    ]
    await assert.rejects(
      (manager as any)._runOneTurn(session, 'hi', (e: any) => events.push(e)),
      /AUTH_ERROR/,
    )
    assert.equal(session.turns, 5, 'turns rolled back to pre-turn snapshot')
    assert.equal(session.totalCostUSD, 1.23, 'cost rolled back (would be 1.48 if broken)')
    assert.equal(
      session._lastCcbCumulativeCost,
      0.5,
      'ccb cumulative rolled back (would be 0.75 if broken)',
    )
  })

  it('B7: a user submit during a watch QUEUES behind it (continuation delivered first, then the user turn runs)', async () => {
    const runner = new FakeRunner()
    const session = makeTestSession(runner)
    session.userId = undefined
    const cont: any[] = []
    manager.onContinuationEvent = (_route, e) => cont.push(e)

    runner.scripts = [[taskStarted(), result()], [result()]] // 2nd burst = the queued user turn
    await manager.submit(session, 'turn1 bg', () => {})
    assert.ok(session._continuationWatch, 'watch armed')

    // user submits again DURING the watch → must queue (await watch.done before taking the runner).
    const p2 = manager.submit(session, 'turn2 interrupt', () => {})
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(
      runner.submissions,
      ['turn1 bg'],
      'queued submit has NOT written stdin while the watch is active',
    )

    // continuation arrives + completes → watch ends → queued submit proceeds.
    runner.emit('message', msgStart('m-c'))
    runner.emit('message', textDelta('continuation done'))
    runner.emit('message', result())
    await p2

    assert.ok(
      cont.some((e) => e.kind === 'block' && (e.block as any)?.text === 'continuation done'),
      'continuation delivered before the queued user turn ran',
    )
    assert.deepEqual(
      runner.submissions,
      ['turn1 bg', 'turn2 interrupt'],
      'queued submit ran only AFTER the watch ended',
    )
  })

  it('B8: invariant E (per-context) — a continuation auth error rolls back ONLY its own context, not the user turn', async () => {
    const runner = new FakeRunner()
    const session = makeTestSession(runner)
    session.userId = undefined
    manager.onContinuationEvent = () => {}

    runner.scripts = [[taskStarted(), result()]]
    await manager.submit(session, 'bg', () => {})
    assert.ok(session._continuationWatch)
    const turnsAfterUser = session.turns
    const costAfterUser = session.totalCostUSD

    // the continuation hits an auth error → its own per-context snapshot is restored,
    // the watch ends, and the USER turn's accumulators are untouched.
    runner.emit('message', msgStart('m-auth'))
    runner.emit('message', textDelta('Failed to authenticate: continuation token expired'))
    runner.emit('message', result(0.9))
    await new Promise((r) => setImmediate(r))

    assert.equal(session._continuationWatch, null, 'watch ended on continuation auth error')
    assert.equal(
      session.turns,
      turnsAfterUser,
      'user-turn count NOT rolled back by a continuation auth error',
    )
    assert.equal(
      session.totalCostUSD,
      costAfterUser,
      'user-turn cost NOT corrupted by a continuation auth error',
    )
  })

  it('B9: durable no-drop floor — the continuation answer is persisted (durable outbox) with its srv-tN id', async () => {
    const runner = new FakeRunner()
    const session = makeTestSession(runner) // userId='boss' → durable write fires
    manager.onContinuationEvent = () => {}

    runner.scripts = [[taskStarted(), result()]]
    let userTurnId: string | undefined
    await manager.submit(session, 'bg', (e) => {
      if (e.kind === 'final') userTurnId = session._activeTurnId
    })
    assert.ok(session._continuationWatch)

    const text = `durable-floor continuation ${userTurnId}`
    runner.emit('message', msgStart('m-d'))
    runner.emit('message', textDelta(text))
    runner.emit('message', result())
    // the durable write is on the per-session serial chain — await it (settlement).
    await session._continuationWrite
    await new Promise((r) => setImmediate(r))

    // No client_session row exists in the tmp store, so appendServerAuthoredMessageDurable
    // queues to the durable outbox (replayed on restart) — that IS the no-drop floor.
    const outbox = await readFile(
      join(process.env.OPENCLAUDE_HOME ?? '', 'msg-outbox.jsonl'),
      'utf8',
    ).catch(() => '')
    const expectedId = `srv-web-test-t${turnIdIndex(userTurnId) + 1}`
    assert.ok(
      outbox.includes(expectedId) && outbox.includes(text),
      `continuation answer must be persisted to the durable outbox with id ${expectedId}`,
    )
  })

  it('B10: a phantom continuation (zero output, zero tokens) is rolled back — no turn/cost advance, watch ends', async () => {
    const runner = new FakeRunner()
    const session = makeTestSession(runner)
    session.userId = undefined
    manager.onContinuationEvent = () => {}

    runner.scripts = [[taskStarted(), result()]]
    await manager.submit(session, 'bg', () => {})
    assert.ok(session._continuationWatch)
    const turnsAfterUser = session.turns
    const costAfterUser = session.totalCostUSD

    // the continuation produces NOTHING: a clean all-zero result (claude returned
    // without invoking the model) → must be rolled back, not counted/delivered.
    runner.emit('message', {
      type: 'result',
      subtype: 'success',
      session_id: SID,
      total_cost_usd: 0,
      duration_ms: 1,
      is_error: false,
      result: '',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    })
    await new Promise((r) => setImmediate(r))

    assert.equal(session._continuationWatch, null, 'watch ended on the phantom continuation')
    assert.equal(session.turns, turnsAfterUser, 'phantom continuation rolled back the turn counter')
    assert.equal(session.totalCostUSD, costAfterUser, 'phantom continuation rolled back cost')
  })

  it('B11: a runner crash mid-continuation flushes the partial text durably (no-drop on the crash path)', async () => {
    const runner = new FakeRunner()
    const session = makeTestSession(runner) // userId='boss' → durable
    session.turns = 50 // distinct turn base so durable ids don't collide with B9 in the shared outbox
    manager.onContinuationEvent = () => {}

    runner.scripts = [[taskStarted(), result()]]
    let userTurnId: string | undefined
    await manager.submit(session, 'bg', (e) => {
      if (e.kind === 'final') userTurnId = session._activeTurnId
    })
    assert.ok(session._continuationWatch)

    // the continuation streams partial text, then the runner CRASHES before result.
    const partial = `partial continuation answer ${userTurnId}`
    runner.emit('message', msgStart('m-crash'))
    runner.emit('message', textDelta(partial))
    runner.emit('exit', { code: null, signal: 'SIGKILL', crashed: true })
    await session._continuationWrite
    await new Promise((r) => setImmediate(r))

    assert.equal(session._continuationWatch, null, 'watch ended on runner crash')
    const outbox = await readFile(
      join(process.env.OPENCLAUDE_HOME ?? '', 'msg-outbox.jsonl'),
      'utf8',
    ).catch(() => '')
    const expectedId = `srv-web-test-t${turnIdIndex(userTurnId) + 1}`
    assert.ok(
      outbox.includes(expectedId) && outbox.includes(partial),
      `partial continuation text must be flushed to the durable outbox with id ${expectedId} on crash`,
    )
  })
})

// ───────────────────────── P2.1 permanent stdout pump lifecycle ────────────
// Locks the refactor that replaced the per-turn off-old/on-new 'message' churn
// with a single install-once pump delegating to session._currentTurnHandler.
describe('P2.1 baseline — permanent stdout pump lifecycle', () => {
  it('installs the message pump ONCE and reuses it across turns (no per-turn listener leak)', async () => {
    const runner = new FakeRunner()
    const session = makeTestSession(runner)

    runner.scripts = [[result()], [result()]]
    await manager.submit(session, 'first', () => {})
    assert.equal(runner.listenerCount('message'), 1, 'pump installed on first turn')
    assert.ok(session._messagePump, 'pump stored on session')

    await manager.submit(session, 'second', () => {})
    // The pump is install-once (`if (!session._messagePump)`) — a second turn must
    // NOT add another 'message' listener (the old per-turn code off/on-ed each turn).
    assert.equal(runner.listenerCount('message'), 1, 'pump NOT re-added on the second turn')
    assert.ok(session._currentTurnHandler, 'current-turn handler set')
  })

  it('destroySession offs the permanent pump (no leak after teardown)', async () => {
    const runner = new FakeRunner()
    const session = makeTestSession(runner)

    runner.scripts = [[result()]]
    await manager.submit(session, 'go', () => {})
    assert.equal(runner.listenerCount('message'), 1)

    // destroySession looks the session up by key (makeTestSession bypasses
    // createSession), so register it first to exercise the cleanup path.
    ;(manager as any).sessions.set(session.sessionKey, session)
    await manager.destroySession(session.sessionKey)

    assert.equal(runner.listenerCount('message'), 0, 'pump removed on destroy')
    assert.equal(session._messagePump, null, 'pump ref cleared')
    assert.equal(session._currentTurnHandler, null, 'handler ref cleared')
  })
})
