import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ORIGIN_INJECT_INITIAL_DELAY_MS,
  ORIGIN_INJECT_MAX_DELAY_MS,
  ORIGIN_INJECT_RETRY_BUDGET,
  runBoundedOriginInjectBackoff,
} from '../originInjectBackoff.js'

describe('runBoundedOriginInjectBackoff', () => {
  it('returns injected without sleeping', async () => {
    const delays: number[] = []
    const result = await runBoundedOriginInjectBackoff({
      sleep: async (ms) => {
        delays.push(ms)
      },
      tryOnce: async () => ({ kind: 'injected' }),
    })
    assert.equal(result.kind, 'injected')
    assert.deepEqual(delays, [])
  })

  it('stops immediately on fallback from tryOnce', async () => {
    let calls = 0
    const result = await runBoundedOriginInjectBackoff({
      sleep: async () => {},
      tryOnce: async () => {
        calls += 1
        return { kind: 'fallback' }
      },
    })
    assert.equal(result.kind, 'fallback')
    assert.equal(calls, 1)
  })

  it('aborts mid-retry when shouldAbort flips (ack won the race)', async () => {
    let calls = 0
    let delivered = false
    const result = await runBoundedOriginInjectBackoff({
      sleep: async () => {},
      shouldAbort: () => delivered,
      tryOnce: async () => {
        calls += 1
        delivered = true
        return { kind: 'retryable_failure', code: 'ORIGIN_SESSION_BUSY' }
      },
    })
    assert.equal(result.kind, 'fallback')
    assert.equal(calls, 1)
  })

  it('uses 12-attempt 500ms-to-5s schedule', async () => {
    const delays: number[] = []
    await runBoundedOriginInjectBackoff({
      sleep: async (ms) => {
        delays.push(ms)
      },
      tryOnce: async () => ({ kind: 'retryable_failure', code: 'NO_TRANSPORT' }),
    })
    assert.equal(delays.length, ORIGIN_INJECT_RETRY_BUDGET)
    assert.equal(delays[0], ORIGIN_INJECT_INITIAL_DELAY_MS)
    assert.equal(delays.at(-1), ORIGIN_INJECT_MAX_DELAY_MS)
    for (let i = 1; i < delays.length; i += 1) {
      assert.ok(delays[i]! >= delays[i - 1]!)
      assert.ok(delays[i]! <= ORIGIN_INJECT_MAX_DELAY_MS)
    }
  })
})
