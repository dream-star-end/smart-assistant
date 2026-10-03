import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  allowUnsafeAutomaticCheckpoint,
  assessTurnRecoveryTape,
  modelPlaneFailureAfterSettledTools,
} from '../turnErrorTaxonomy.js'

// OCV5-317 (#b6df9aee): Box Claude ran Read, Bash and Skill to completion, then
// the next model call failed. Bash has no gateway effect proof, so the master
// declined automatic recovery as checkpoint_unsafe and the user had to click
// 「从断点继续」 for a turn whose tools had all finished.
describe('OCV5-317 model-plane failure after settled tools', () => {
  const tool = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    role: 'tool', toolUseId: id, blockId: id, toolName: name, status: 'completed',
    completed: true, _completed: true, text: 'out', ...extra,
  })
  const live = [
    { role: 'runtime-event', status: 'completed' },
    tool('toolu_read', 'Read', { _toolEffect: { authority: 'gateway-v1', outcome: 'completed',
      safety: 'read_only', registryEntrySha256: 'a'.repeat(64) } }),
    tool('toolu_bash', 'Bash', { text: 'git log: "status": "pending" in a commit message' }),
    tool('toolu_skill', 'Skill'),
    { role: 'assistant', status: 'completed', text: 'API Error: 409', _errorCode: 'ENGINE_ERROR' },
  ]

  it('allows automatic checkpoint continuation for the live tape', () => {
    assert.equal(assessTurnRecoveryTape(live).checkpointSafe, false)
    for (const errorCode of ['ENGINE_ERROR', 'upstream_failed', 'UPSTREAM_TIMEOUT', 'network_error',
      'rate_limited', 'model_capacity']) {
      assert.equal(allowUnsafeAutomaticCheckpoint({
        status: 'completed', errorCode, leftoverBacked: false, records: live,
      }), true, errorCode)
      assert.equal(allowUnsafeAutomaticCheckpoint({
        status: 'interrupted', errorCode, leftoverBacked: false, records: live,
      }), true, errorCode)
    }
  })

  it('keeps any open tool, delegate or permission on the manual path', () => {
    const cases: unknown[][] = [
      [...live, tool('toolu_x', 'Bash', { _completed: false, status: 'executing' })],
      [...live, tool('toolu_x', 'Bash', { status: 'in_progress' })],
      [...live, { kind: 'tool_use', id: 'toolu_unanswered' }],
      [...live, { kind: 'tool_use' }],
      [...live, { role: 'agent-group', _completed: false }],
      [...live, { role: 'agent-group', _completed: true,
        childBlocks: [{ kind: 'tool_use', id: 'c1', _completed: false }] }],
      [...live, { role: 'permission', _resolved: false }],
      [...live, { role: 'runtime-event', status: 'pending' }],
      [...live, { role: 'tool', _completed: true }],
      [{ role: 'assistant', text: 'partial' }],
    ]
    for (const records of cases) {
      assert.equal(modelPlaneFailureAfterSettledTools('upstream_failed', records), false,
        JSON.stringify(records.at(-1)))
    }
  })

  it('does not widen runner loss, restart or non-model codes', () => {
    for (const errorCode of ['service_restart', 'runner_crashed', 'user_cancelled', 'liveness_timeout']) {
      assert.equal(modelPlaneFailureAfterSettledTools(errorCode, live), false, errorCode)
    }
    assert.equal(allowUnsafeAutomaticCheckpoint({
      status: 'interrupted', errorCode: 'service_restart', leftoverBacked: true, records: live,
    }), false)
  })
})
