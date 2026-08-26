/**
 * CCB adapter routing for local-agent task_notification bookends.
 * Run: npx tsx --test packages/gateway/src/__tests__/ccbAdapterTaskNotification.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { CcbAdapter } from '../engine/ccbAdapter.js'
import type { EngineEvent } from '../engine/engineEvents.js'
import type { TurnParams } from '../engine/engineAdapter.js'
import type { SubprocessRunner } from '../subprocessRunner.js'
import type { EngineCreateOpts } from '../engine/registry.js'

class FakeCcbRunner extends EventEmitter {
  lastActivityAt = Date.now()
  submitted: Array<{ input: unknown; requestId?: string }> = []

  async submit(
    input: string | Array<{ type: string; [key: string]: unknown }>,
    requestId?: string,
  ): Promise<void> {
    this.submitted.push({ input, requestId })
  }

  sendPermissionResponse(): boolean {
    return true
  }

  msg(m: Record<string, unknown>): void {
    this.emit('message', m)
  }
}

function makeAdapter(): { adapter: CcbAdapter; runner: FakeCcbRunner } {
  const runner = new FakeCcbRunner()
  const adapter = new CcbAdapter(
    {} as EngineCreateOpts,
    runner as unknown as SubprocessRunner,
  )
  return { adapter, runner }
}

function beginTurn(adapter: CcbAdapter, events: EngineEvent[], overrides: Partial<TurnParams> = {}) {
  const sessionTotals = { totalCostUSD: 0, turns: 0, _lastCcbCumulativeCost: 0 }
  return adapter.submitTurn({
    input: 'hello',
    onEvent: (e) => events.push(e),
    sessionTotals,
    toolUseIdToName: new Map(),
    ...overrides,
  })
}

function taskNote(over: Record<string, unknown> = {}) {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: 'agt-1',
    status: 'completed',
    output_file: '/tmp/output/agt-1',
    summary: 'Agent done',
    ...over,
  }
}

function resultRow() {
  return {
    type: 'result',
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    stop_reason: 'end_turn',
    num_turns: 1,
    is_error: false,
  }
}

describe('CcbAdapter task_notification routing', () => {
  test('active turn: emits independent event, no transcript block', () => {
    const { adapter, runner } = makeAdapter()
    const events: EngineEvent[] = []
    const orphan: unknown[] = []
    adapter.on('task_notification', (p) => orphan.push(p))
    beginTurn(adapter, events)
    runner.msg(taskNote())
    const notes = events.filter((e) => e.kind === 'task_notification')
    assert.equal(notes.length, 1)
    if (notes[0]!.kind === 'task_notification') {
      assert.equal(notes[0].taskId, 'agt-1')
      assert.equal(notes[0].outputFile, '/tmp/output/agt-1')
    }
    assert.equal(events.filter((e) => e.kind === 'block').length, 0)
    assert.equal(orphan.length, 1)
  })

  test('after finalize: same task_notification still reaches onEvent', () => {
    const { adapter, runner } = makeAdapter()
    const events: EngineEvent[] = []
    const run = beginTurn(adapter, events)
    runner.msg(resultRow())
    run.end()
    const before = events.filter((e) => e.kind === 'task_notification').length
    runner.msg(taskNote({ task_id: 'agt-late' }))
    const notes = events.filter((e) => e.kind === 'task_notification')
    assert.equal(notes.length, before + 1)
    const last = notes.at(-1)
    assert.equal(last?.kind, 'task_notification')
    if (last?.kind === 'task_notification') {
      assert.equal(last.taskId, 'agt-late')
    }
    assert.equal(
      events.filter((e) => e.kind === 'block' && (e.block as { kind?: string }).kind !== 'text').length,
      0,
    )
  })

  test('no route turn: adapter-level emit still fires', () => {
    const { adapter, runner } = makeAdapter()
    const orphan: Array<{ taskId: string }> = []
    adapter.on('task_notification', (p) => orphan.push(p))
    runner.msg(taskNote({ task_id: 'agt-orphan' }))
    assert.equal(orphan.length, 1)
    assert.equal(orphan[0]!.taskId, 'agt-orphan')
  })
})


describe('CcbAdapter task_notification_delivered routing', () => {
  test('active turn and no-route-turn both emit the ack sideband', () => {
    const { adapter, runner } = makeAdapter()
    const events: EngineEvent[] = []
    const orphan: Array<{ taskId: string }> = []
    adapter.on('task_notification_delivered', (p) => orphan.push(p))
    beginTurn(adapter, events)
    runner.msg({
      type: 'system',
      subtype: 'task_notification_delivered',
      task_id: 'agt-ack',
      delivered_by: 'ccb-mid-turn',
    })
    const notes = events.filter((e) => e.kind === 'task_notification_delivered')
    assert.equal(notes.length, 1)
    if (notes[0]!.kind === 'task_notification_delivered') {
      assert.equal(notes[0].taskId, 'agt-ack')
    }
    assert.equal(orphan.length, 1)
    assert.equal(orphan[0]!.taskId, 'agt-ack')
  })
})
