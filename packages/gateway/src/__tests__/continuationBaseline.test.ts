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
import { mkdtemp } from 'node:fs/promises'
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
// Many short-lived SessionManager instances in one file → bump the per-process
// listener cap to silence Node's benign MaxListeners heuristic (process-local).
process.setMaxListeners(50)
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

describe('P2.0 baseline — sessionManager continuation orchestration', () => {
  it('B1: #2 ultracode continuation — re-arm holds the lock, delivers both sub-turn finals, turnId↔meta.turn lockstep (C/H/G)', async () => {
    const runner = new FakeRunner()
    const session = makeTestSession(runner)
    const turnsBefore = session.turns
    const events: any[] = []
    const finalTurnIds: Array<string | undefined> = []
    const finalMetaTurns: Array<number | undefined> = []

    // sub-turn 1 only: task_started arms the continuation, then its result.
    runner.scripts = [[taskStarted(), result()]]
    let settled = false
    const p = manager
      .submit(session, 'do bg work', (e) => {
        events.push(e)
        if (e.kind === 'final') {
          finalTurnIds.push(session._activeTurnId)
          finalMetaTurns.push((e as any).meta?.turn)
        }
      })
      .then(() => {
        settled = true
      })

    // let submit reach runner.submit(), process sub-turn 1, and re-arm.
    await new Promise((r) => setImmediate(r))
    // invariant G: the submit lock stays HELD across the continuation (not settled).
    assert.equal(settled, false, 'submit lock stays held across the continuation re-arm')
    assert.equal(
      events.filter((e) => e.kind === 'final').length,
      1,
      'sub-turn 1 final already delivered',
    )

    // continuation result arrives proactively on the SAME runner (no new submit),
    // with no further task_started → terminal sub-turn → resolve + release.
    runner.emit('message', result())
    await p
    assert.equal(settled, true, 'turn settles only on the terminal (non-continuing) result')

    const finals = events.filter((e) => e.kind === 'final')
    // CURRENT behavior: pendingFinal is forwarded at sessionManager.ts:1516 on
    // every non-auth/non-phantom result BEFORE the re-arm branch (1715), so the
    // client receives one final PER sub-turn. P2.x may collapse this to one
    // terminal final — that diff lands here.
    assert.equal(finals.length, 2, 'one final per sub-turn delivered today')
    assert.equal(session.turns - turnsBefore, 2, 'each sub-turn increments the turn counter')
    // invariant C/H: every frame's turnId == the durable srv-<peer>-tN id for its
    // sub-turn (turnIdIndex === meta.turn), and advances by exactly one. Asserting
    // the ABSOLUTE turnId↔meta.turn equality (not just a relative +1) is what
    // guards against a refactor stamping the right delta but the wrong base.
    assert.equal(finalTurnIds.length, 2)
    assert.equal(
      turnIdIndex(finalTurnIds[0]),
      finalMetaTurns[0],
      'sub-turn 1 turnId == its meta.turn',
    )
    assert.equal(
      turnIdIndex(finalTurnIds[1]),
      finalMetaTurns[1],
      'sub-turn 2 turnId == its meta.turn',
    )
    assert.equal(
      finalMetaTurns[1],
      (finalMetaTurns[0] ?? Number.NaN) + 1,
      'continuation advances turn by exactly 1',
    )
  })

  it('B2: #1 auto-background task_notification — continuation answer EVAPORATES (KNOWN BUG; P2.2 flips this)', async () => {
    const runner = new FakeRunner()
    const session = makeTestSession(runner)
    const events: any[] = []

    // turn 1 has NO preceding task_started → expectsContinuation stays false → turn resolves.
    runner.scripts = [[result()]]
    await manager.submit(session, 'kick off auto-background subtask', (e) => events.push(e))

    const finalsAfterTurn1 = events.filter((e) => e.kind === 'final').length
    const turnsAfterTurn1 = session.turns
    const eventsLen = events.length
    assert.equal(finalsAfterTurn1, 1, 'turn 1 delivered its final')

    // The auto-background subtask completes LATER: task_notification (bookend)
    // then the continuation turn (init→assistant→result) arrives on the SAME
    // runner with no new submit(). The message listener is still attached
    // (detach never off()s 'message') but its parser is finalized → all dropped.
    runner.emit('message', taskNotification('completed'))
    runner.emit('message', msgStart('m-cont'))
    runner.emit('message', textDelta('Here is the synthesized auto-background answer.'))
    runner.emit('message', result())

    // BUG BASELINE: nothing new delivered, turn counter unchanged for the dropped continuation.
    assert.equal(events.length, eventsLen, 'continuation frames are dropped (no new events)')
    assert.equal(events.filter((e) => e.kind === 'final').length, 1, 'no second final delivered')
    assert.equal(session.turns, turnsAfterTurn1, 'dropped continuation does not advance turns')
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

  it('B4a: continuation chain is bounded by MAX_CONTINUATIONS (locks the cap behaviorally)', async () => {
    const runner = new FakeRunner()
    const session = makeTestSession(runner)
    const turnsBefore = session.turns
    const events: any[] = []

    // 17 task_started→result pairs: 1 initial + 16 continuations = MAX_CONTINUATIONS(16) exhausted,
    // then the chain resolves on the 17th even though it also armed a continuation.
    const burst: any[] = []
    for (let i = 0; i < 17; i++) burst.push(taskStarted(`w${i}`), result())
    runner.scripts = [burst]
    await manager.submit(session, 'runaway', (e) => events.push(e))

    assert.equal(
      events.filter((e) => e.kind === 'final').length,
      17,
      'exactly 17 sub-turns complete',
    )
    assert.equal(session.turns - turnsBefore, 17)
    assert.equal(runner.interrupted, false, 'bound is graceful — runner is not interrupted')

    // A continuation arriving after the bound is dropped by the finalized parser.
    const before = events.length
    runner.emit('message', result())
    assert.equal(events.length, before, 'post-bound frame dropped')
  })

  it('B4b: continuation 90s soft-cap resolves GRACEFULLY on silence (no interrupt) — P2.3 replaces silence with session_state_changed', async () => {
    mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] })
    try {
      const runner = new FakeRunner()
      const session = makeTestSession(runner)
      const events: any[] = []

      // arm a continuation then go silent — the 90s CONTINUATION_WAIT_MS soft cap should fire.
      runner.scripts = [[taskStarted(), result()]]
      let settled = false
      const p = manager
        .submit(session, 'bg then silent', (e) => events.push(e))
        .then(() => {
          settled = true
        })
      // flush microtasks so submit reaches runner.submit() and arms the soft-cap timer
      await new Promise((r) => setImmediate(r))
      // invariant: while waiting for the continuation, the turn is NOT yet settled
      // (a broken impl that resolved on the first result would fail here, not just
      // at the final-state assertions below).
      assert.equal(settled, false, 'submit stays open while waiting for the continuation')

      mock.timers.tick(90_001)
      await p
      assert.equal(settled, true, 'the soft cap settles the turn')
      assert.equal(
        runner.interrupted,
        false,
        'graceful soft-cap must NOT interrupt the persistent process',
      )
      assert.ok(
        events.some((e) => e.kind === 'final'),
        'a final is emitted when the soft cap resolves',
      )
    } finally {
      mock.timers.reset()
    }
  })

  it('B5: invariant D — current liveness idle thresholds (the dispatcher must NOT kill CONTINUATION_WATCH with the 5-min default)', () => {
    assert.equal(getLivenessIdleTimeoutMs(undefined), LIVENESS_IDLE_TIMEOUT_DEFAULT_MS)
    assert.equal(getLivenessIdleTimeoutMs({}), LIVENESS_IDLE_TIMEOUT_DEFAULT_MS)
    assert.equal(getLivenessIdleTimeoutMs({ pendingToolCalls: 1 }), LIVENESS_IDLE_TIMEOUT_TOOL_MS)
    assert.equal(
      getLivenessIdleTimeoutMs({ isCompacting: true }),
      LIVENESS_IDLE_TIMEOUT_COMPACTING_MS,
    )
    // 5-min default would interrupt a #1 auto-background wait (prod max 948s).
    assert.ok(LIVENESS_IDLE_TIMEOUT_DEFAULT_MS < 16 * 60_000)
  })

  it('B6: invariant E — auth error rolls back per-turn cost/turns snapshot and rejects (via _runOneTurn)', async () => {
    const runner = new FakeRunner()
    const session = makeTestSession(runner)
    session.turns = 5
    session.totalCostUSD = 1.23
    session._lastCcbCumulativeCost = 0.5
    const events: any[] = []

    // result total_cost_usd=0.75 with prior cumulative 0.5 → POSITIVE delta 0.25,
    // so in-flight the parser bumps totalCostUSD to 1.48 and _lastCcbCumulativeCost
    // to 0.75 BEFORE onFinish. Using a positive delta (not result(0), which clamps
    // to a zero delta) is what makes the rollback assertions non-false-green:
    // if rollback were broken they'd read 1.48 / 0.75, not 1.23 / 0.5.
    // assistantText matches AUTH_ERROR_PREFIX_RE (/^Failed to authenticate\b/).
    runner.scripts = [
      [msgStart('m-auth'), textDelta('Failed to authenticate: token expired'), result(0.75)],
    ]
    // runOneTurnWithRetry swallows+retries AUTH_ERROR, so assert the invariant on the
    // private per-turn engine where the rollback+reject is observable directly.
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
})
