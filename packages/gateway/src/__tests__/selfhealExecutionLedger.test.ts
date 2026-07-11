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
} from '../selfheal/executionLedger.js'

describe('selfhealSessionKey', () => {
  it('is deterministic for a repair id', () => {
    assert.equal(selfhealSessionKey('r-123'), 'selfheal:r-123')
    assert.equal(selfhealSessionKey('r-123'), selfhealSessionKey('r-123'))
  })
})

describe('buildRepairPrompt', () => {
  it('interpolates only the repair id (no free text surface)', () => {
    const prompt = buildRepairPrompt('r-abc')
    assert.ok(prompt.includes('r-abc'))
    assert.ok(prompt.includes('v5-incident-repair'))
  })
  it('runs under the codex-v5ops agent', () => {
    assert.equal(SELFHEAL_AGENT_ID, 'codex-v5ops')
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
})
