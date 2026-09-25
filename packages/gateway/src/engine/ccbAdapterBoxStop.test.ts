import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { CcbAdapter } from './ccbAdapter.js'
import type { SubprocessRunner } from '../subprocessRunner.js'

class FakeRunner extends EventEmitter {
  model = 'box-api-claude-opus-5-5'
  sessionId = 'ccb-native-session'
  interrupts = 0
  setConsultTurn(): void {}
  async submit(): Promise<void> {}
  interrupt(): boolean { this.interrupts++; return true }
}

test('browser Stop notifies internal Box route once before interrupting local CCB', async () => {
  const vars = ['ANTHROPIC_BASE_URL', 'OPENCLAUDE_V3_MASTER_BASE_URL',
    'OPENCLAUDE_V3_CONTAINER_TOKEN'] as const
  const saved = Object.fromEntries(vars.map((key) => [key, process.env[key]]))
  const oldFetch = globalThis.fetch
  process.env.ANTHROPIC_BASE_URL = 'http://172.31.0.1:18892'
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = 'http://172.31.0.1:18892'
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'oc-v3.1.synthetic'
  const runner = new FakeRunner()
  const sequence: string[] = []
  let delivered!: () => void
  const sent = new Promise<void>((resolve) => { delivered = resolve })
  globalThis.fetch = (async (url, init) => {
    sequence.push('box-stop')
    assert.equal(String(url), 'http://172.31.0.1:18892/internal/box/stop')
    assert.deepEqual(JSON.parse(String(init?.body)), {
      session_id: runner.sessionId, oc_turn_key: 'a'.repeat(64),
    })
    delivered()
    return new Response(JSON.stringify({ status: 'stopped' }), { status: 200 })
  }) as typeof fetch
  try {
    const adapter = new CcbAdapter({} as never, runner as unknown as SubprocessRunner)
    const turn = adapter.submitTurn({ input: 'synthetic', turnKey: 'a'.repeat(64),
      onEvent: () => {}, sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map() })
    await turn.submitted
    assert.equal(adapter.interrupt('user'), true)
    await sent
    assert.equal(adapter.interrupt('user'), true)
    assert.equal(runner.interrupts, 2)
    assert.deepEqual(sequence, ['box-stop'])
    turn.end()
  } finally {
    globalThis.fetch = oldFetch
    for (const key of vars) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
})

test('automatic adapter interrupt does not claim explicit user Stop', async () => {
  const oldFetch = globalThis.fetch
  const runner = new FakeRunner()
  let sent = 0
  globalThis.fetch = (async () => { sent++; throw new Error('must not notify') }) as typeof fetch
  try {
    const adapter = new CcbAdapter({} as never, runner as unknown as SubprocessRunner)
    const turn = adapter.submitTurn({ input: 'synthetic', turnKey: 'b'.repeat(64),
      onEvent: () => {}, sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map() })
    await turn.submitted
    assert.equal(adapter.interrupt(), true)
    assert.equal(sent, 0)
    turn.end()
  } finally { globalThis.fetch = oldFetch }
})
