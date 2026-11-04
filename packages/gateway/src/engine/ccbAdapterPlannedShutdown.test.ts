// OCV5-733 (selfhost 2026-11-04 #de669e28): `docker restart` of the user
// container killed the CCB CLI mid Box first round. Egress kept the run as
// first_round_unknown (an ordinary disconnect is not a Stop), so the Box
// account seat stayed held ~21 min and the next message was refused with
// box_capacity_held. A planned process exit now settles unfinished Box turns
// through the same internal Stop route a browser Stop uses.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { CcbAdapter } from './ccbAdapter.js'
import { SessionManager } from '../sessionManager.js'
import type { SubprocessRunner } from '../subprocessRunner.js'

const STOP_URL = 'http://172.31.0.1:18892/internal/box/stop'

class FakeRunner extends EventEmitter {
  model = 'box-api-claude-opus-5-5'
  sessionId = 'ccb-native-session'
  sequence: string[] = []
  holdSubmit = false
  setConsultTurn(): void {}
  submit(): Promise<void> {
    return this.holdSubmit ? new Promise<void>(() => {}) : Promise.resolve()
  }
  interrupt(): boolean { this.sequence.push('interrupt'); return true }
  async shutdown(): Promise<void> { this.sequence.push('runner-shutdown') }
}

async function withBoxEnv(
  respond: (body: { session_id: string; oc_turn_key: string }) => Promise<Response>,
  run: (bodies: Array<{ session_id: string; oc_turn_key: string }>) => Promise<void>,
): Promise<void> {
  const vars = ['ANTHROPIC_BASE_URL', 'OPENCLAUDE_V3_MASTER_BASE_URL',
    'OPENCLAUDE_V3_CONTAINER_TOKEN'] as const
  const saved = Object.fromEntries(vars.map((key) => [key, process.env[key]]))
  const oldFetch = globalThis.fetch
  process.env.ANTHROPIC_BASE_URL = 'http://172.31.0.1:18892'
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = 'http://172.31.0.1:18892'
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'oc-v3.1.synthetic'
  const bodies: Array<{ session_id: string; oc_turn_key: string }> = []
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), STOP_URL)
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    return respond(body)
  }) as typeof fetch
  try { await run(bodies) } finally {
    globalThis.fetch = oldFetch
    for (const key of vars) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

const stopped = async () => new Response(JSON.stringify({ status: 'stopped' }), { status: 200 })

function startTurn(adapter: CcbAdapter, turnKey: string) {
  return adapter.submitTurn({ input: 'synthetic', turnKey, onEvent: () => {},
    sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map() })
}

test('OCV5-733 planned shutdown stops an unfinished Box turn once, before the CLI is killed', async () => {
  const runner = new FakeRunner()
  await withBoxEnv(async (body) => {
    runner.sequence.push(`box-stop:${body.oc_turn_key[0]}`)
    return stopped()
  }, async (bodies) => {
    const adapter = new CcbAdapter({} as never, runner as unknown as SubprocessRunner)
    const turn = startTurn(adapter, 'a'.repeat(64))
    await turn.submitted
    adapter.beginPlannedShutdown()
    await adapter.shutdown()
    assert.deepEqual(bodies, [{ session_id: runner.sessionId, oc_turn_key: 'a'.repeat(64) }])
    assert.deepEqual(runner.sequence, ['box-stop:a', 'runner-shutdown'])
    // the same turn is never stopped twice in this process
    adapter.beginPlannedShutdown()
    adapter.interrupt('user')
    assert.equal(bodies.length, 1)
    turn.end()
  })
})

test('OCV5-733 a finished Box turn is not stopped on planned shutdown', async () => {
  const local = new FakeRunner()
  await withBoxEnv(stopped, async (bodies) => {
    const adapter = new CcbAdapter({} as never, local as unknown as SubprocessRunner)
    const turn = startTurn(adapter, 'b'.repeat(64))
    await turn.submitted
    local.emit('message', { type: 'result', subtype: 'success', is_error: false, result: 'done' })
    await turn.summary
    adapter.beginPlannedShutdown()
    await adapter.shutdown()
    assert.deepEqual(bodies, [])
    assert.deepEqual(local.sequence, ['runner-shutdown'])
  })
})

test('OCV5-733 a non-Box model never calls the Box Stop route on planned shutdown', async () => {
  const local = new FakeRunner()
  local.model = 'claude-sonnet-5'
  await withBoxEnv(stopped, async (bodies) => {
    const adapter = new CcbAdapter({} as never, local as unknown as SubprocessRunner)
    const turn = startTurn(adapter, 'c'.repeat(64))
    await turn.submitted
    adapter.beginPlannedShutdown()
    await adapter.shutdown()
    assert.deepEqual(bodies, [])
    turn.end()
  })
})

test('OCV5-733 a hanging Box Stop does not hold shutdown past its bound', async () => {
  const local = new FakeRunner()
  await withBoxEnv(() => new Promise<Response>(() => {}), async (bodies) => {
    const adapter = new CcbAdapter({} as never, local as unknown as SubprocessRunner)
    const turn = startTurn(adapter, 'd'.repeat(64))
    await turn.submitted
    adapter.beginPlannedShutdown()
    const started = Date.now()
    await adapter.shutdown()
    const elapsed = Date.now() - started
    assert.equal(bodies.length, 1)
    assert.ok(elapsed >= 1_900 && elapsed < 3_500, `shutdown took ${elapsed}ms`)
    assert.deepEqual(local.sequence, ['runner-shutdown'])
    turn.end()
  })
})

test('OCV5-733 shutdown waits for every pending Box Stop, not only the last one', async () => {
  const local = new FakeRunner()
  let releaseFirst!: () => void
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve })
  await withBoxEnv(async (body) => {
    if (body.oc_turn_key[0] === 'e') {
      await firstHeld
      local.sequence.push('box-stop:e:done')
    } else {
      local.sequence.push('box-stop:f:done')
    }
    return stopped()
  }, async (bodies) => {
    const adapter = new CcbAdapter({} as never, local as unknown as SubprocessRunner)
    const first = startTurn(adapter, 'e'.repeat(64))
    await first.submitted
    // A second turn is routed but its submit has not landed: _activeTurn is
    // still the first turn, _routeTurn is the second.
    local.holdSubmit = true
    startTurn(adapter, 'f'.repeat(64))
    adapter.beginPlannedShutdown()
    setTimeout(releaseFirst, 300)
    await adapter.shutdown()
    assert.deepEqual(bodies.map((b) => b.oc_turn_key[0]).sort(), ['e', 'f'])
    assert.deepEqual(local.sequence,
      ['box-stop:f:done', 'box-stop:e:done', 'runner-shutdown'])
  })
})

test('OCV5-733 SessionManager starts planned shutdown on every runner that supports it', () => {
  const calls: string[] = []
  const sessions = new Map<string, unknown>([
    ['a', { sessionKey: 'a', runner: { beginPlannedShutdown: () => { calls.push('a') } } }],
    ['b', { sessionKey: 'b', runner: {} }],
    ['c', { sessionKey: 'c', runner: { beginPlannedShutdown: () => { throw new Error('boom') } } }],
    ['d', { sessionKey: 'd', runner: { beginPlannedShutdown: () => { calls.push('d') } } }],
  ])
  SessionManager.prototype.beginPlannedShutdown.call({ sessions } as unknown as SessionManager)
  assert.deepEqual(calls, ['a', 'd'])
})
