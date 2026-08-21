/**
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/delegateArgs.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeDelegateAgentId, normalizeDelegateModel } from '../delegateArgs.js'

describe('normalizeDelegateModel', () => {
  it('缺省 / 空白 → 不指定', () => {
    assert.deepEqual(normalizeDelegateModel(undefined), { ok: true })
    assert.deepEqual(normalizeDelegateModel(''), { ok: true })
    assert.deepEqual(normalizeDelegateModel('  '), { ok: true })
  })

  it('合法 catalog 型号(含点)透传', () => {
    const r = normalizeDelegateModel(' cursor-grok-4.6-high-fast ')
    assert.deepEqual(r, { ok: true, model: 'cursor-grok-4.6-high-fast' })
  })

  it('非法字符拒绝', () => {
    const r = normalizeDelegateModel('cursor grok')
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /model 无效/)
  })
})

describe('normalizeDelegateAgentId', () => {
  it('成员 id 透传', () => {
    assert.deepEqual(normalizeDelegateAgentId('coding-assistant'), {
      ok: true,
      agentId: 'coding-assistant',
    })
  })

  it('把型号当 agentId → 指向 model 参数', () => {
    const r = normalizeDelegateAgentId('cursor-grok-4.6-high-fast')
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.match(r.error, /agentId 只能是平台成员/)
      assert.match(r.error, /model=/)
    }
  })
})
