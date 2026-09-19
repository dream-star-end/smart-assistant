/**
 * Advisor consult-turn binding via real CcbAdapter.submitTurn.
 * Kept out of cronExecutionHeartbeat.test.ts so the incident-pinned
 * 12-leaf check-v5-cron-submit-boundary allowlist stays exact.
 *
 * Run: node --import tsx --test packages/gateway/src/__tests__/ccbAdvisorTurnBinding.test.ts
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { CcbAdapter } from '../engine/ccbAdapter.js'

class HangRunner extends EventEmitter {
  lastActivityAt = Date.now()
  isRunning = true
  pendingToolCalls = 0
  consultTurnBinding:
    | { turnKey: string; turnIndex: number; configVersion: string }
    | undefined

  setConsultTurn(
    binding: { turnKey: string; turnIndex: number; configVersion: string } | undefined,
  ): void {
    this.consultTurnBinding = binding
  }

  async start() {
    this.isRunning = true
  }
  interrupt() {
    this.emit('message', {
      type: 'result',
      total_cost_usd: 0,
      usage: {},
      is_error: false,
      stop_reason: 'end_turn',
    })
    return true
  }
  async shutdown() {}
  clearSessionId() {}
  async waitForOutputDrain() {}
  async submit() {
    // Return immediately so submitTurn can record/clear the binding.
  }
}

describe('CcbAdapter consult-turn binding', () => {
  it('records consult binding then clears it on an ordinary submitTurn', async () => {
    const runner = new HangRunner()
    const adapter = new CcbAdapter({} as any, runner as any)
    try {
      await adapter.submitTurn({
        input: 'consult',
        turnKey: 'tk-consult',
        consultTurn: { turnIndex: 4, configVersion: 'cv-1' },
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      }).submitted
      assert.deepEqual(runner.consultTurnBinding, {
        turnKey: 'tk-consult',
        turnIndex: 4,
        configVersion: 'cv-1',
      })
      await adapter.submitTurn({
        input: 'plain',
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      }).submitted
      assert.equal(runner.consultTurnBinding, undefined)
    } finally {
      try {
        runner.interrupt()
      } catch {
        // drain
      }
      await adapter.shutdown().catch(() => {})
    }
  })
})
