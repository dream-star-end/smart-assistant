import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { assessZeroOutputWaiver } from '../billing/turnWaiverPolicy.js'

const diagnostic = { role: 'assistant', text: '任务暂时中断', _isError: true,
  _errorCode: 'MODEL_AUTHORITY_EXPIRED', _errorDetail: '任务暂时中断' }
const zero = () => ({ complete: true, hasSettledOutput: false,
  engineBillings: [] as unknown[], settledRequests: new Set<string>(), records: [diagnostic] as Record<string, unknown>[] })

describe('long task waiver requires authoritative zero output', () => {
  test('complete diagnostic-only tape is eligible; incomplete transport is deferred', () => {
    assert.equal(assessZeroOutputWaiver(zero()).disposition, 'eligible')
    assert.deepEqual(assessZeroOutputWaiver({ ...zero(), complete: false }),
      { disposition: 'deferred', reason: 'tape_not_complete' })
  })
  test('real answer on the terminal error segment is still output', () => {
    assert.equal(assessZeroOutputWaiver({ ...zero(), records: [{
      role: 'assistant', text: '已完成前半部分', _errorCode: 'MODEL_AUTHORITY_EXPIRED',
    }] }).disposition, 'denied')
  })
  test('thinking and completed empty-output steps are output', () => {
    for (const record of [
      { role: 'thinking', text: '已有过程' },
      { role: 'tool', _completed: true, text: '', blockId: 't1' },
      { role: 'agent-group', _completed: true, text: '完成审查' },
      { role: 'plan', text: '实施步骤' },
    ]) assert.equal(assessZeroOutputWaiver({ ...zero(), records: [record] }).disposition, 'denied')
  })
  test('unproven effects cannot become a zero-output waiver', () => {
    for (const record of [
      { role: 'tool', _completed: false, text: '' },
      { role: 'runtime-event', _runtimeEvent: { type: 'tool_use', id: 'pending' } },
    ]) assert.equal(assessZeroOutputWaiver({ ...zero(), records: [record] }).disposition, 'denied')
  })
  test('positive settled usage denies even if old adapter discarded the answer', () => {
    assert.equal(assessZeroOutputWaiver({ ...zero(), hasSettledOutput: true }).disposition, 'denied')
    assert.equal(assessZeroOutputWaiver({ ...zero(), records: [{ ...diagnostic,
      usage: { outputTokens: 12 },
    }] }).disposition, 'denied')
  })
  test('pending canonical engine usage denies before billing job execution (r1 regression)', () => {
    for (const status of ['success', 'error']) {
      for (const usage of [{ output_tokens: 100 }, { output_tokens: 0, reasoning_output_tokens: 2 }]) {
        assert.equal(assessZeroOutputWaiver({ ...zero(),
          engineBillings: [{ requestId: 'late-charge', status, usage }],
        }).disposition, 'denied')
      }
    }
  })
  test('unknown canonical engine usage defers until that exact request settled', () => {
    const engineBillings = [{ requestId: 'pending' }]
    assert.deepEqual(assessZeroOutputWaiver({ ...zero(), engineBillings }),
      { disposition: 'deferred', reason: 'settlement_not_complete' })
    assert.equal(assessZeroOutputWaiver({ ...zero(), engineBillings,
      settledRequests: new Set(['pending']),
    }).disposition, 'eligible')
    assert.equal(assessZeroOutputWaiver({ ...zero(), engineBillings,
      settledRequests: new Set(['other-user-request']),
    }).disposition, 'deferred')
  })
  test('explicit zero output engine usage still needs complete tape and no real work', () => {
    const engineBillings = [{ requestId: 'zero', usage: { input_tokens: 50, output_tokens: 0 } }]
    assert.equal(assessZeroOutputWaiver({ ...zero(), engineBillings }).disposition, 'eligible')
    assert.equal(assessZeroOutputWaiver({ ...zero(), engineBillings, complete: false }).disposition, 'deferred')
    assert.equal(assessZeroOutputWaiver({ ...zero(), engineBillings,
      records: [{ role: 'tool', _completed: true }],
    }).disposition, 'denied')
  })
})
