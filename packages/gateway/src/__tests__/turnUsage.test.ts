/**
 * Unified turn-usage recorder: one emit per terminated turn, status mapping,
 * and no double-count when complete + crash both fire.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/turnUsage.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { TurnCompletedEvent } from '@openclaude/protocol'
import { eventBus } from '../eventBus.js'
import {
  createTurnUsageRecorder,
  emitTurnUsage,
  mapTurnTerminalStatus,
} from '../turnUsage.js'

function collectCompleted(): { events: TurnCompletedEvent[]; stop: () => void } {
  const events: TurnCompletedEvent[] = []
  const listener = (ev: TurnCompletedEvent) => {
    events.push(ev)
  }
  eventBus.on('turn.completed', listener)
  return {
    events,
    stop: () => {
      eventBus.off('turn.completed', listener)
    },
  }
}

const base = {
  agentId: 'main',
  sessionKey: 'agent:main:webchat:dm:usage-peer',
  turnIndex: 1,
  usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.01, model: 'test-model' },
  toolCalls: 3,
  durationMs: 1500,
}

describe('mapTurnTerminalStatus', () => {
  test('crashed persist → crashed', () => {
    assert.equal(mapTurnTerminalStatus({ persistStatus: 'crashed', errorCode: 'RUNNER_CRASHED' }), 'crashed')
  })
  test('user stop → stopped', () => {
    assert.equal(
      mapTurnTerminalStatus({ persistStatus: 'interrupted', errorCode: 'USER_CANCELLED' }),
      'stopped',
    )
  })
  test('idle timeout → timeout', () => {
    assert.equal(
      mapTurnTerminalStatus({ persistStatus: 'interrupted', errorCode: 'IDLE_TIMEOUT' }),
      'timeout',
    )
  })
  test('signal interrupt → aborted', () => {
    assert.equal(
      mapTurnTerminalStatus({ persistStatus: 'interrupted', errorCode: 'RUNNER_CRASHED' }),
      'aborted',
    )
  })
  test('successful result → completed', () => {
    assert.equal(mapTurnTerminalStatus({ hasResult: true, resultIsError: false }), 'completed')
  })
  test('engine error result → error', () => {
    assert.equal(mapTurnTerminalStatus({ hasResult: true, resultIsError: true }), 'error')
  })
  test('null summary → aborted', () => {
    assert.equal(mapTurnTerminalStatus({ hasResult: false }), 'aborted')
  })
})

describe('createTurnUsageRecorder', () => {
  test('first record emits turn.completed with terminalStatus', () => {
    const bag = collectCompleted()
    try {
      const rec = createTurnUsageRecorder()
      assert.equal(rec.recorded, false)
      assert.equal(rec.record({ ...base, terminalStatus: 'crashed' }), true)
      assert.equal(rec.recorded, true)
      assert.equal(bag.events.length, 1)
      assert.equal(bag.events[0]!.terminalStatus, 'crashed')
      assert.equal(bag.events[0]!.toolCalls, 3)
      assert.equal(bag.events[0]!.sessionKey, base.sessionKey)
    } finally {
      bag.stop()
    }
  })

  test('second record is a no-op (complete + crash must not double-count)', () => {
    const bag = collectCompleted()
    try {
      const rec = createTurnUsageRecorder()
      rec.record({ ...base, terminalStatus: 'completed' })
      assert.equal(rec.record({ ...base, terminalStatus: 'crashed', durationMs: 9999 }), false)
      assert.equal(bag.events.length, 1)
      assert.equal(bag.events[0]!.terminalStatus, 'completed')
      assert.equal(bag.events[0]!.durationMs, 1500)
    } finally {
      bag.stop()
    }
  })

  test('each termination status can be emitted', () => {
    const bag = collectCompleted()
    try {
      for (const status of ['completed', 'error', 'crashed', 'aborted', 'stopped', 'timeout'] as const) {
        emitTurnUsage({ ...base, turnIndex: base.turnIndex + 1, terminalStatus: status })
        assert.equal(bag.events.at(-1)!.terminalStatus, status)
      }
    } finally {
      bag.stop()
    }
  })
})
