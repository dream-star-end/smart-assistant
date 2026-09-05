/**
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/delegateArgs.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  SELF_DELEGATE_ERROR,
  normalizeDelegateAgentId,
  normalizeDelegateModel,
  rejectSelfDelegate,
  rewriteSelfDelegateErrorForMcp,
} from '../delegateArgs.js'

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

describe('rejectSelfDelegate', () => {
  it('caller===target 拒绝并提示 --allow-self', () => {
    const r = rejectSelfDelegate({ callerAgentId: 'main', targetAgentId: 'main' })
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.match(r.error, /不能把任务委派给自己/)
      assert.match(r.error, /--allow-self/)
    }
  })

  it('allowSelf 覆盖', () => {
    assert.equal(
      rejectSelfDelegate({ callerAgentId: 'main', targetAgentId: 'main', allowSelf: true }).ok,
      true,
    )
  })

  it('其他成员放行', () => {
    assert.equal(
      rejectSelfDelegate({ callerAgentId: 'main', targetAgentId: 'coding-assistant' }).ok,
      true,
    )
  })
})

describe('rewriteSelfDelegateErrorForMcp', () => {
  it('把 CLI 口径的 --allow-self 提示改写为 MCP 参数 allowSelf', () => {
    const out = rewriteSelfDelegateErrorForMcp(`委派失败: ${SELF_DELEGATE_ERROR}`)
    assert.doesNotMatch(out, /--allow-self/)
    assert.match(out, /allowSelf: true/)
    assert.match(out, /coding-assistant/)
  })
  it('其它文本原样返回', () => {
    assert.equal(rewriteSelfDelegateErrorForMcp('foo'), 'foo')
  })
})
