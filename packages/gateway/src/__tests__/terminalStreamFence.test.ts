/**
 * Run: npx tsx --test packages/gateway/src/__tests__/terminalStreamFence.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { OutboundRingBuffer } from '../outboundRing.js'
import {
  rebindOutboundClientMessageId,
  resolveDelegateProgressBinding,
} from '../terminalStreamFence.js'

describe('resolveDelegateProgressBinding', () => {
  it('跟 running / dispatch 合法 cmid', () => {
    assert.deepEqual(
      resolveDelegateProgressBinding({ candidate: 'parent-cmid-running', isFenced: () => false }),
      { clientMessageId: 'parent-cmid-running' },
    )
  })

  it('fenced → leftover（省略 cmid）', () => {
    assert.deepEqual(
      resolveDelegateProgressBinding({
        candidate: 'old-cmid',
        isFenced: (cmid) => cmid === 'old-cmid',
      }),
      {},
    )
  })

  it('非法 cm:user:large leftover', () => {
    assert.deepEqual(
      resolveDelegateProgressBinding({ candidate: 'cm:user:large', isFenced: () => false }),
      {},
    )
  })
})

describe('rebindOutboundClientMessageId', () => {
  it('未 fence 则保留原 cmid', () => {
    assert.equal(
      rebindOutboundClientMessageId({
        clientMessageId: 'live-cmid',
        sessionKey: 's1',
        isFenced: () => false,
        openTurnClientMessageId: 'retry-cmid',
      }),
      'live-cmid',
    )
  })

  it('fenced 且有 open turn → 跟 retry cmid', () => {
    assert.equal(
      rebindOutboundClientMessageId({
        clientMessageId: 'old-cmid',
        sessionKey: 's1',
        isFenced: (_sk, cmid) => cmid === 'old-cmid',
        openTurnClientMessageId: 'retry-cmid',
      }),
      'retry-cmid',
    )
  })

  it('fenced 且无 open → leftover undefined', () => {
    assert.equal(
      rebindOutboundClientMessageId({
        clientMessageId: 'old-cmid',
        sessionKey: 's1',
        isFenced: () => true,
      }),
      undefined,
    )
  })

  it('无 cmid 但有 open turn → 贴上当前轮', () => {
    assert.equal(
      rebindOutboundClientMessageId({
        sessionKey: 's1',
        isFenced: () => false,
        openTurnClientMessageId: 'retry-cmid',
      }),
      'retry-cmid',
    )
  })
})

describe('endActiveTurn fences even after marker moved', () => {
  it('marker 已迁走仍 fence 旧 cmid', () => {
    const r = new OutboundRingBuffer()
    r.beginActiveTurn('s1', 'm-user-1')
    r.beginActiveTurn('s1', 'm-user-retry')
    const evicted = r.endActiveTurn('s1', 'm-user-1')
    assert.deepEqual(evicted, { entries: 0, age: 0, bytes: 0 })
    assert.equal(r.activeTurnClientMessageId('s1'), 'm-user-retry')
    assert.equal(r.isTurnFenced('s1', 'm-user-1'), true)
    assert.equal(r.isTurnFenced('s1', 'm-user-retry'), false)
  })

  it('匹配 marker 的 end 也 fence', () => {
    const r = new OutboundRingBuffer()
    r.beginActiveTurn('s1', 'm-user-1')
    r.endActiveTurn('s1', 'm-user-1')
    assert.equal(r.isTurnFenced('s1', 'm-user-1'), true)
    assert.equal(r.activeTurnClientMessageId('s1'), undefined)
  })

  it('clear() 清 fence', () => {
    const r = new OutboundRingBuffer()
    r.beginActiveTurn('s1', 'm-user-1')
    r.endActiveTurn('s1', 'm-user-1')
    r.clear('s1')
    assert.equal(r.isTurnFenced('s1', 'm-user-1'), false)
  })
})
