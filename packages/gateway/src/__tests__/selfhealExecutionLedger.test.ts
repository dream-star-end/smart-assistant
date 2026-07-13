import * as assert from 'node:assert/strict'
/**
 * Tests for the self-heal execution glue helpers (slice ② / block B2a).
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/selfhealExecutionLedger.test.ts
 */
import { describe, it } from 'node:test'
import type { SessionStreamEvent } from '../claudeMessageParser.js'
import {
  SELFHEAL_AGENT_ID,
  buildRepairPrompt,
  createRepairTurnSink,
  selfhealSessionKey,
  withRepairLock,
} from '../selfheal/executionLedger.js'

describe('selfhealSessionKey', () => {
  it('is deterministic for a repair id', () => {
    assert.equal(selfhealSessionKey('r-123'), 'selfheal:r-123')
    assert.equal(selfhealSessionKey('r-123'), selfhealSessionKey('r-123'))
  })
})

describe('buildRepairPrompt', () => {
  // Block C: the prompt now carries the clone workdir + the oc-selfheal CLI
  // contract (context/verify/cutover/report) — assertions updated accordingly.
  it('interpolates only the repair id and the root-controlled clone path', () => {
    const prompt = buildRepairPrompt('r-abc', '/home/ocheal/selfheal/r-abc')
    assert.ok(prompt.includes('r-abc'))
    assert.ok(prompt.includes('/home/ocheal/selfheal/r-abc'))
    assert.ok(prompt.includes('v5-incident-repair'))
    assert.ok(prompt.includes('oc-selfheal context'))
    assert.ok(prompt.includes('oc-selfheal verify'))
    assert.ok(prompt.includes('oc-selfheal cutover'))
    assert.ok(prompt.includes('oc-selfheal report'))
  })
  it('runs under the codex-v5ops agent', () => {
    assert.equal(SELFHEAL_AGENT_ID, 'codex-v5ops')
  })
})

describe('withRepairLock — per-repair keyed mutex (design §A2 fence)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('serializes critical sections on the SAME repairId', async () => {
    const order: string[] = []
    const first = withRepairLock('lock-1', async () => {
      order.push('a-start')
      await sleep(30)
      order.push('a-end')
    })
    const second = withRepairLock('lock-1', async () => {
      order.push('b-start')
      order.push('b-end')
    })
    await Promise.all([first, second])
    assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end'])
  })

  it('does NOT serialize different repairIds against each other', async () => {
    const order: string[] = []
    let releaseA: () => void = () => {}
    const gateA = new Promise<void>((r) => {
      releaseA = r
    })
    const a = withRepairLock('lock-2a', async () => {
      order.push('a-start')
      await gateA
      order.push('a-end')
    })
    const b = withRepairLock('lock-2b', async () => {
      order.push('b')
    })
    await b // b completes while a is still parked on its gate
    assert.deepEqual(order, ['a-start', 'b'])
    releaseA()
    await a
  })

  it('a throwing critical section releases the lock (no wedge)', async () => {
    await assert.rejects(
      withRepairLock('lock-3', async () => {
        throw new Error('boom')
      }),
      /boom/,
    )
    let ran = false
    await withRepairLock('lock-3', async () => {
      ran = true
    })
    assert.equal(ran, true)
  })

  it('returns the critical section result', async () => {
    assert.equal(await withRepairLock('lock-4', async () => 42), 42)
  })
})

describe('createRepairTurnSink', () => {
  it('accumulates assistant text and captures the first error', () => {
    const sink = createRepairTurnSink()
    sink.onEvent({ kind: 'block', block: { kind: 'text', text: 'hello ' } } as SessionStreamEvent)
    sink.onEvent({ kind: 'block', block: { kind: 'text', text: 'world' } } as SessionStreamEvent)
    sink.onEvent({ kind: 'error', error: 'boom-1' } as SessionStreamEvent)
    sink.onEvent({ kind: 'error', error: 'boom-2' } as SessionStreamEvent)
    assert.equal(sink.getOutput(), 'hello world')
    assert.equal(sink.getError(), 'boom-1')
  })

  it('treats an authoritative final isError result as a failed repair turn', () => {
    const sink = createRepairTurnSink()
    sink.onEvent({ kind: 'final', meta: { isError: true } } as SessionStreamEvent)
    assert.equal(sink.getError(), 'repair turn returned is_error=true')
  })
})
