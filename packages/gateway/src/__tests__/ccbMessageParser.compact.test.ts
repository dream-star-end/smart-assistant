/**
 * Native compact capture on CcbMessageParser.
 * Run: npx tsx --test packages/gateway/src/__tests__/ccbMessageParser.compact.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CcbMessageParser,
  type SessionStreamEvent,
} from '../ccbMessageParser.js'

function createParser(opts?: {
  onNativeCompactionSummary?: (summaryText: string) => void
  onIdleArtifactReceipt?: (receipt: { opId: string; digest: string }) => void
}) {
  const events: SessionStreamEvent[] = []
  const parser = new CcbMessageParser({
    toolUseIdToName: new Map(),
    onEvent: (e) => events.push(e),
    onNativeCompactionSummary: opts?.onNativeCompactionSummary,
    onIdleArtifactReceipt: opts?.onIdleArtifactReceipt,
    onFinish: () => {},
    sessionTotals: { totalCostUSD: 0, turns: 0, _lastCcbCumulativeCost: 0 },
  })
  return { parser, events }
}

const PREFIX = 'This session is being continued from a previous conversation that ran out of context.'

describe('CcbMessageParser compact capture', () => {
  it('hides the string synthetic continuation', () => {
    let summary = ''
    const { parser, events } = createParser({ onNativeCompactionSummary: (value) => { summary = value } })
    parser.parse({
      type: 'user',
      message: { role: 'user', content: `${PREFIX}\n\nSummary: native ccb` },
      isSynthetic: true,
      isReplay: false,
    } as any)
    assert.match(summary, /native ccb/)
    assert.equal(events.length, 0)
  })

  it('hides a text-block continuation after compact_boundary', () => {
    let summary = ''
    const { parser, events } = createParser({ onNativeCompactionSummary: (value) => { summary = value } })
    parser.parse({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 308000 },
    } as any)
    parser.parse({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: `${PREFIX}\n\nSummary: block ccb` }],
      },
      isSynthetic: false,
      isReplay: false,
    } as any)
    assert.match(summary, /block ccb/)
    assert.equal(events.length, 0)
  })

  it('does not treat a visible Chinese compact essay as native handoff', () => {
    let summary = ''
    const { parser } = createParser({ onNativeCompactionSummary: (value) => { summary = value } })
    parser.parse({
      type: 'user',
      message: { role: 'user', content: '**会话状态摘要（供压缩后延续）**' },
      isSynthetic: false,
      isReplay: false,
    } as any)
    assert.equal(summary, '')
  })

  it('uses result compact_summary only as a fallback', () => {
    let summary = ''
    const { parser } = createParser({ onNativeCompactionSummary: (value) => { summary = value } })
    parser.parse({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 1 },
    } as any)
    parser.parse({
      type: 'result',
      compact_summary: 'decisions and next steps',
      usage: {},
      total_cost_usd: 0,
    } as any)
    assert.match(summary, /decisions and next steps/)
  })

  it('passes an idle artifact receipt and ignores a bare applied flag', () => {
    let receipt: { opId: string; digest: string } | undefined
    const { parser } = createParser({ onIdleArtifactReceipt: (value) => { receipt = value } })
    parser.parse({
      type: 'system', subtype: 'compact_boundary', applied: true,
      compact_metadata: { trigger: 'manual' },
    } as any)
    assert.equal(receipt, undefined)
    const digest = 'ab'.repeat(32)
    parser.parse({
      type: 'system', subtype: 'compact_boundary',
      compact_metadata: { idle_op_id: digest, idle_receipt_digest: digest },
    } as any)
    assert.deepEqual(receipt, { opId: digest, digest })
  })
})
