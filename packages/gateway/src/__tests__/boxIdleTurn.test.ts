import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { runBoxIdleTurn } from '../boxIdleTurn.js'
import { CcbAdapter } from '../engine/ccbAdapter.js'
import type { EngineTurnRun, TurnParams } from '../engine/engineAdapter.js'
import type { EngineCreateOpts } from '../engine/registry.js'
import type { SubprocessRunner } from '../subprocessRunner.js'

class Transport extends EventEmitter {
  model = 'box-api-claude-opus-5-5'
  sessionId = 'idle-lifecycle-native'
  submits = 0
  action: () => Promise<void> = async () => {}
  setConsultTurn(): void {}
  submit(): Promise<void> { this.submits++; return this.action() }
  result(): void {
    this.emit('message', { type: 'result', is_error: false, stop_reason: 'end_turn',
      total_cost_usd: 0, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } })
  }
  crash(): void { this.emit('exit', { code: null, signal: 'SIGKILL', crashed: true }) }
}

function setup() {
  const transport = new Transport()
  const adapter = new CcbAdapter({ harness: 'ccb' } as EngineCreateOpts, transport as unknown as SubprocessRunner)
  const runs: EngineTurnRun[] = []
  const original = adapter.submitTurn.bind(adapter)
  adapter.submitTurn = (params) => { const run = original(params); runs.push(run); return run }
  const listeners = { exit: adapter.listenerCount('exit'), error: adapter.listenerCount('error') }
  const clean = () => {
    assert.equal(adapter.listenerCount('exit'), listeners.exit)
    assert.equal(adapter.listenerCount('error'), listeners.error)
  }
  const start = () => runBoxIdleTurn(adapter, {
    input: '/compact', turnKey: 'ab'.repeat(32), onEvent: () => {},
    sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map(),
  } satisfies TurnParams)
  return { transport, adapter, runs, clean, start }
}

for (const mode of ['submit-reject', 'sync-throw', 'sync-error', 'sync-exit', 'drained-exit', 'error', 'null-summary'] as const) {
  test(`idle lifecycle rejects ${mode} without a model retry or listener leak`, { timeout: 2000 }, async () => {
    const { transport, runs, clean, start } = setup()
    if (mode === 'submit-reject') transport.action = () => Promise.reject(new Error('spawn rejected'))
    if (mode === 'sync-throw') transport.action = () => { throw new Error('submit threw') }
    if (mode === 'sync-error') transport.action = async () => { transport.emit('error', new Error('sync error')) }
    if (mode === 'sync-exit') transport.action = async () => { transport.crash() }
    const outcome = start()
    const rejected = assert.rejects(outcome, /spawn rejected|submit threw|sync error|IDLE_TURN_EXIT|transport error|IDLE_TURN_NO_RESULT/)
    if (mode === 'drained-exit') { await runs[0]!.submitted; transport.crash() }
    if (mode === 'error') { await runs[0]!.submitted; transport.emit('error', new Error('transport error')) }
    if (mode === 'null-summary') { await runs[0]!.submitted; runs[0]!.end() }
    await rejected
    assert.equal(transport.submits, 1)
    if (mode !== 'sync-throw') assert.equal(runs[0]!.finalized, true)
    clean()
  })
}

for (const synchronous of [false, true]) {
  test(`a real result wins over the following drained exit (synchronous=${synchronous})`, async () => {
    const { transport, clean, start } = setup()
    if (synchronous) transport.action = async () => { transport.result(); transport.crash() }
    const outcome = start()
    if (!synchronous) { transport.result(); transport.crash() }
    assert.ok(await outcome)
    clean()
  })
}

test('expected clean replacement continues, but unexpected code zero exits fail', async () => {
  const { transport, runs, clean, start } = setup()
  transport.action = async () => { transport.emit('exit', { code: 0, signal: null, crashed: false }) }
  const normal = start()
  await runs[0]!.submitted
  assert.equal(runs[0]!.finalized, false)
  transport.result()
  assert.ok(await normal)
  clean()
  transport.action = async () => { transport.emit('exit', { code: 0, signal: null, crashed: true }) }
  await assert.rejects(start(), /IDLE_TURN_EXIT/)
  clean()
})

test('late rejected submitted and an old end cannot terminate the successor', async () => {
  const { transport, runs, clean, start } = setup()
  let rejectOld!: (error: Error) => void
  transport.action = () => new Promise<void>((_, reject) => { rejectOld = reject })
  const first = start()
  transport.result()
  assert.ok(await first)
  clean()
  transport.action = async () => {}
  const second = start()
  await runs[1]!.submitted
  rejectOld(new Error('late rejected submit'))
  runs[0]!.end()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(runs[1]!.finalized, false)
  transport.result()
  assert.ok(await second)
  assert.equal(transport.submits, 2)
  clean()
})
