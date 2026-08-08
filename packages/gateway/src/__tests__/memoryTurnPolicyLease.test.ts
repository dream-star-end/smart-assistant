import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { startMemoryTurnPolicyLease } from '../memoryTurnPolicyLease.js'

test('续租失败只中断一次，stop 后无晚到续租并完成清理', async () => {
  let tick: (() => void) | undefined
  let writes = 0
  let failures = 0
  let clears = 0
  let interrupts = 0
  const logicalTurnAbort = new AbortController()
  const lease = await startMemoryTurnPolicyLease({
    sessionKey: 's1',
    decision: { allowed: true, reason: 'explicit_continuity' },
    logicalTurnAbort,
    interrupt: () => { interrupts++ },
    onRefreshFailure: () => { failures++ },
    deps: {
      write: async () => {
        writes++
        if (writes > 1) throw new Error('disk full')
      },
      clear: async () => { clears++ },
      setInterval: ((fn: () => void) => {
        tick = fn
        return { unref() {} } as unknown as NodeJS.Timeout
      }) as typeof globalThis.setInterval,
      clearInterval: (() => {}) as typeof globalThis.clearInterval,
    },
  })
  assert.equal(writes, 1, 'initial policy must be written before the turn')
  tick!()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(failures, 1)
  assert.equal(interrupts, 1)
  assert.equal(logicalTurnAbort.signal.aborted, true)
  assert.match(String(logicalTurnAbort.signal.reason), /memory turn policy refresh failed/)
  await lease.stop()
  tick!()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(writes, 3, 'stop must prevent late renewals apart from its final deny write')
  assert.equal(clears, 1)
})
